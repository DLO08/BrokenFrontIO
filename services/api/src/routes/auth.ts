import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { findOrCreateByIdentity } from "../accounts";
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

export function authRoutes(ctx: Ctx) {
  const r = Router();

  /**
   * POST /auth/guest -- sign in anonymously.
   *
   * With no deviceToken we mint one and return it; the client stores it and
   * sends it next time to land back on the same account.
   */
  r.post("/guest", async (req, res) => {
    const body = GuestBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    const deviceToken =
      body.data.deviceToken ?? randomBytes(24).toString("base64url");
    const user = await findOrCreateByIdentity(ctx.db, "guest", deviceToken);
    const token = await issueAccessToken(ctx.config, ctx.key, user, "guest");
    const refresh = await mintRefreshToken(ctx.config, ctx.db, user.id);
    setRefreshCookie(ctx, res, refresh.token, refresh.expiresAt);
    // deviceToken is echoed only when we minted it: a client that already has
    // one does not need it back, and not resending it keeps it out of logs.
    res.json({
      token,
      ...(body.data.deviceToken === undefined ? { deviceToken } : {}),
    });
  });

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

  return r;
}
