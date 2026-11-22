import { Router, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  findByEmail,
  findOrCreateByIdentity,
  linkIdentity,
  setEmail,
} from "../accounts";
import { verifyGoogleIdToken } from "../auth/providers/google";
import {
  consumeLoginToken,
  attachLoginTokenUser,
  mintLoginToken,
  resolveRedirectOrigin,
  sendLoginEmail,
} from "../auth/providers/magiclink";
import {
  authenticateSteamTicket,
  steamOpenIdRedirect,
  verifySteamOpenId,
} from "../auth/providers/steam";
import {
  issueAccessToken,
  mintRefreshToken,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../auth/tokens";
import {
  clearRefreshCookie,
  readCookie,
  REFRESH_COOKIE,
  requireUser,
  setRefreshCookie,
  type Ctx,
} from "../http/app";

/**
 * The device token a guest account is keyed to. The client keeps it in
 * localStorage; it is a bearer credential for that account, so it is minted
 * here rather than accepted from the caller -- otherwise anyone could claim
 * any guest account by guessing a string.
 */
const GuestBodySchema = z.object({
  deviceToken: z.string().min(16).max(128).optional(),
});
const IdTokenSchema = z.object({ idToken: z.string().min(1).max(8192) });
const TicketSchema = z.object({ ticket: z.string().min(1).max(8192) });
const MagicLinkSchema = z.object({
  email: z.email().max(320),
  redirectDomain: z.string().max(2048).optional(),
});

export function authRoutes(ctx: Ctx) {
  const r = Router();

  /** Signs `user` in on the website: refresh cookie plus an access token. */
  async function startWebSession(
    res: Response,
    user: { id: string; role: string | null },
    provider: string,
  ) {
    const token = await issueAccessToken(ctx.config, ctx.key, user, provider);
    const refresh = await mintRefreshToken(ctx.config, ctx.db, user.id);
    setRefreshCookie(ctx, res, refresh.token, refresh.expiresAt);
    return token;
  }

  // --- guest ----------------------------------------------------------
  r.post("/guest", async (req, res) => {
    const body = GuestBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    const deviceToken =
      body.data.deviceToken ?? randomBytes(24).toString("base64url");
    const user = await findOrCreateByIdentity(ctx.db, "guest", deviceToken);
    const token = await startWebSession(res, user, "guest");
    // deviceToken is echoed only when we minted it: a client that already has
    // one does not need it back, and not resending it keeps it out of logs.
    res.json({
      token,
      ...(body.data.deviceToken === undefined ? { deviceToken } : {}),
    });
  });

  // --- google ---------------------------------------------------------
  // The client runs Google Identity Services itself and posts us the
  // resulting ID token (googleIdTokenLogin in src/client/Auth.ts); on 200 it
  // reloads, expecting the refresh cookie to be set.
  r.post("/google", async (req, res) => {
    if (ctx.config.google === null) {
      res.status(501).json({ error: "google sign-in is not configured" });
      return;
    }
    const body = IdTokenSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    const verified = await verifyGoogleIdToken(
      body.data.idToken,
      ctx.config.google.clientId,
    );
    if (!verified.ok) {
      res.status(401).json({ error: verified.reason });
      return;
    }
    const { subject, email, name } = verified.identity;

    const existing = await findOrCreateIfKnown("google", subject);
    if (existing !== null) {
      res.json({ token: await startWebSession(res, existing, "google") });
      return;
    }

    // A different account already holds this address -- most likely the
    // player signed up by email and is now using Google for the first time.
    // Silently merging them would be a takeover primitive, so the client
    // gets the specific 409 it already renders ("an account with this email
    // exists -- sign in and link Google from settings").
    const byEmail = await findByEmail(ctx.db, email);
    if (byEmail !== null) {
      res.status(409).json({ reason: "email_exists" });
      return;
    }

    const user = await findOrCreateByIdentity(ctx.db, "google", subject, {
      email,
      displayName: name ?? undefined,
    });
    await setEmail(ctx.db, user.id, email);
    res.json({ token: await startWebSession(res, user, "google") });
  });

  r.post("/google/link", requireUser(ctx), async (req, res) => {
    if (ctx.config.google === null) {
      res.status(501).json({ error: "google sign-in is not configured" });
      return;
    }
    const body = IdTokenSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    const verified = await verifyGoogleIdToken(
      body.data.idToken,
      ctx.config.google.clientId,
    );
    if (!verified.ok) {
      res.status(401).json({ error: verified.reason });
      return;
    }
    const me = req.user!;
    const linked = await linkIdentity(
      ctx.db,
      me.id,
      "google",
      verified.identity.subject,
      {
        email: verified.identity.email,
        displayName: verified.identity.name ?? undefined,
      },
    );
    if (!linked.ok) {
      res.status(409).json({
        reason:
          linked.reason === "account_already_linked"
            ? "account_already_has_google"
            : "google_linked_elsewhere",
      });
      return;
    }
    if (me.email === null)
      await setEmail(ctx.db, me.id, verified.identity.email);
    res.status(200).json({ linked: true });
  });

  // --- steam ----------------------------------------------------------
  // Desktop shell: it holds a session ticket from the running Steam client.
  // It cannot use the refresh cookie (app://openfront is cross-site to the
  // API), so this returns the JWT directly and the shell re-exchanges a
  // fresh ticket when it expires -- hence the {jwt, expiresIn} shape rather
  // than {token}. See doSteamLogin in src/client/Auth.ts.
  r.post("/steam", async (req, res) => {
    if (ctx.config.steam === null) {
      res.status(501).json({ error: "steam sign-in is not configured" });
      return;
    }
    const body = TicketSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    const auth = await authenticateSteamTicket(
      body.data.ticket,
      ctx.config.steam,
    );
    if (!auth.ok) {
      // The client maps 401 to "ticket rejected" and 5xx to "Steam's fault",
      // and renders different, actionable messages for each.
      res.status(auth.reason === "rejected" ? 401 : 502).json({
        error: auth.reason,
      });
      return;
    }
    const user = await findOrCreateByIdentity(
      ctx.db,
      "steam",
      auth.identity.steamId,
      {
        displayName: auth.identity.personaName ?? undefined,
        raw: auth.identity,
      },
    );
    const jwt = await issueAccessToken(ctx.config, ctx.key, user, "steam");
    res.json({ jwt, expiresIn: ctx.config.accessTokenTtlSeconds });
  });

  // Website: bounce through Steam's OpenID provider and come back.
  r.get("/login/steam", (req, res) => {
    if (ctx.config.steam === null) {
      res.status(501).json({ error: "steam sign-in is not configured" });
      return;
    }
    const requested =
      typeof req.query.redirect_uri === "string"
        ? req.query.redirect_uri
        : undefined;
    const origin = resolveRedirectOrigin(requested, ctx.config.redirectOrigins);
    if (origin === null) {
      res.status(400).json({ error: "redirect_uri is not an allowed origin" });
      return;
    }
    const returnTo = new URL(`${ctx.config.issuer}/auth/steam/return`);
    returnTo.searchParams.set("redirect_uri", origin);
    res.redirect(steamOpenIdRedirect(returnTo.toString(), ctx.config.issuer));
  });

  r.get("/steam/return", async (req, res) => {
    if (ctx.config.steam === null) {
      res.status(501).json({ error: "steam sign-in is not configured" });
      return;
    }
    const origin =
      resolveRedirectOrigin(
        typeof req.query.redirect_uri === "string"
          ? req.query.redirect_uri
          : undefined,
        ctx.config.redirectOrigins,
      ) ?? ctx.config.redirectOrigins[0];

    const auth = await verifySteamOpenId(
      req.query as Record<string, string | string[] | undefined>,
      ctx.config.steam,
    );
    if (!auth.ok) {
      res.redirect(`${origin}/?steam_login=failed`);
      return;
    }
    const user = await findOrCreateByIdentity(
      ctx.db,
      "steam",
      auth.identity.steamId,
      {
        displayName: auth.identity.personaName ?? undefined,
        raw: auth.identity,
      },
    );
    await startWebSession(res, user, "steam");
    res.redirect(`${origin}/#link=steam`);
  });

  // --- magic link -----------------------------------------------------
  r.post("/magic-link", async (req, res) => {
    const body = MagicLinkSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    const origin = resolveRedirectOrigin(
      body.data.redirectDomain,
      ctx.config.redirectOrigins,
    );
    if (origin === null) {
      res
        .status(400)
        .json({ error: "redirectDomain is not an allowed origin" });
      return;
    }
    const link = await mintLoginToken(
      ctx.config,
      ctx.db,
      body.data.email,
      origin,
    );
    try {
      await sendLoginEmail(ctx.config, body.data.email, link.url);
    } catch (e) {
      console.error("[auth] magic link send failed", e);
      res.status(502).json({ error: "could not send the email" });
      return;
    }
    // Always 200 past this point, whether or not the address has an account:
    // answering differently would turn this into an account-existence oracle.
    res.status(200).json({ sent: true });
  });

  // The emailed link lands on the site, which calls this with the token.
  r.get("/login/token", async (req, res) => {
    const token = req.query["login-token"];
    if (typeof token !== "string" || token.length === 0) {
      res.status(400).json({ code: "invalid" });
      return;
    }
    const consumed = await consumeLoginToken(ctx.db, token);
    if (!consumed.ok) {
      res.status(400).json({ code: consumed.code });
      return;
    }
    // Receipt of the email proves the address, so it signs into whichever
    // account already holds it -- typically one created through Google with
    // the same address. Creating a fresh "email" account instead would split
    // the player in two and collide on the unique email index.
    const existingByEmail = await findByEmail(ctx.db, consumed.email);
    const user =
      existingByEmail ??
      (await findOrCreateByIdentity(
        ctx.db,
        "email",
        consumed.email.toLowerCase(),
        { email: consumed.email },
      ));
    if (existingByEmail !== null) {
      // Proving the address is also how an account that only had it as an
      // unverified attribute gains a usable email identity.
      await linkIdentity(
        ctx.db,
        user.id,
        "email",
        consumed.email.toLowerCase(),
        { email: consumed.email },
      );
    } else if (user.email === null) {
      await setEmail(ctx.db, user.id, consumed.email);
    }
    await attachLoginTokenUser(ctx.db, token, user.id);
    await startWebSession(res, user, "email");
    res.json({ status: "success", email: consumed.email });
  });

  // --- session --------------------------------------------------------
  /**
   * POST /auth/refresh -- exchange the refresh cookie for a new access token.
   * RefreshResponseSchema in @openfront/shared/ApiSchemas: `{ token }`.
   */
  r.post("/refresh", async (req, res) => {
    const presented = readCookie(req, REFRESH_COOKIE);
    if (presented === null) {
      res.status(401).json({ error: "no refresh token" });
      return;
    }
    const result = await rotateRefreshToken(ctx.config, ctx.db, presented);
    if (result.type !== "ok") {
      clearRefreshCookie(ctx, res);
      res.status(401).json({
        error:
          result.type === "reused"
            ? "refresh token reused"
            : "invalid refresh token",
      });
      return;
    }
    const token = await issueAccessToken(
      ctx.config,
      ctx.key,
      { id: result.userId, role: result.role },
      "refresh",
    );
    setRefreshCookie(ctx, res, result.refresh.token, result.refresh.expiresAt);
    res.json({ token });
  });

  /** POST /auth/logout -- end this session only. */
  r.post("/logout", async (req, res) => {
    const presented = readCookie(req, REFRESH_COOKIE);
    if (presented !== null) await revokeRefreshToken(ctx.db, presented);
    clearRefreshCookie(ctx, res);
    res.status(204).end();
  });

  /** POST /auth/revoke -- sign out everywhere. */
  r.post("/revoke", requireUser(ctx), async (req, res) => {
    await revokeAllForUser(ctx.db, req.user!.id);
    clearRefreshCookie(ctx, res);
    res.status(204).end();
  });

  /** The account holding `provider`/`subject`, or null -- never creates. */
  async function findOrCreateIfKnown(provider: string, subject: string) {
    const r2 = await ctx.db.query<{
      id: string;
      role: string | null;
    }>(
      `SELECT u.id, u.role FROM user_identities i
         JOIN users u ON u.id = i.user_id
        WHERE i.provider = $1 AND i.subject = $2`,
      [provider, subject],
    );
    return r2.rows.length > 0 ? r2.rows[0] : null;
  }

  return r;
}
