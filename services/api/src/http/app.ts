import { base64urlToUuid } from "@openfront/shared/Base64";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { jwtVerify } from "jose";

import { getUserById, type User } from "../accounts";
import { jwksBody, type SigningKey } from "../auth/keys";
import type { Config } from "../config";
import type { Db } from "../db/pool";
import { authRoutes } from "../routes/auth";
import { userRoutes } from "../routes/users";

export type Ctx = {
  config: Config;
  db: Db;
  key: SigningKey;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const REFRESH_COOKIE = "of_refresh";

/** Minimal cookie reader; the service needs exactly one cookie. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function setRefreshCookie(
  ctx: Ctx,
  res: Response,
  token: string,
  expiresAt: Date,
) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: ctx.config.isProduction,
    // The API is on api.<domain> while the page is on <domain>, so the
    // refresh cookie is cross-site and must be SameSite=None to be sent at
    // all. None requires Secure, which is why dev (http) falls back to Lax --
    // there the client and API are same-site enough for it to work.
    sameSite: ctx.config.isProduction ? "none" : "lax",
    ...(ctx.config.cookieDomain === null
      ? {}
      : { domain: ctx.config.cookieDomain }),
    expires: expiresAt,
    path: "/",
  });
}

export function clearRefreshCookie(ctx: Ctx, res: Response) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: ctx.config.isProduction,
    sameSite: ctx.config.isProduction ? "none" : "lax",
    ...(ctx.config.cookieDomain === null
      ? {}
      : { domain: ctx.config.cookieDomain }),
    path: "/",
  });
}

/**
 * Verifies the Bearer token and attaches the account.
 *
 * Deliberately verified locally with our own key rather than by fetching our
 * own JWKS: same keys, no round trip.
 */
export function requireUser(ctx: Ctx) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : null;
    if (token === null) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    try {
      const { payload } = await jwtVerify(token, ctx.key.publicKey, {
        algorithms: ["EdDSA"],
        issuer: ctx.config.issuer,
        audience: ctx.config.audience,
      });
      if (typeof payload.sub !== "string") {
        res.status(401).json({ error: "token has no subject" });
        return;
      }
      const user = await getUserById(ctx.db, base64urlToUuid(payload.sub));
      if (user === null) {
        res.status(401).json({ error: "unknown account" });
        return;
      }
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: "invalid token" });
    }
  };
}

/**
 * Guards the server-to-server surface. The game server sends `x-api-key` on
 * /users/@me and the JWKS fetch (src/server/ServerEnv.ts); browsers never do.
 * With no API_KEY configured (dev only -- config.ts makes it fatal in
 * production) this is a no-op.
 */
export function requireApiKey(ctx: Ctx) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (ctx.config.apiKey === null) {
      next();
      return;
    }
    if (req.headers["x-api-key"] !== ctx.config.apiKey) {
      res.status(403).json({ error: "bad api key" });
      return;
    }
    next();
  };
}

export function createApp(ctx: Ctx) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.use((req, res, next) => {
    // Credentialed CORS cannot use "*", so echo the one configured origin.
    if (req.headers.origin === ctx.config.clientOrigin) {
      res.setHeader("Access-Control-Allow-Origin", ctx.config.clientOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-api-key",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Public key material, and the game server refuses to follow a redirect
  // here, so it must answer directly on this exact path.
  app.get("/.well-known/jwks.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(jwksBody(ctx.key));
  });

  app.use("/auth", authRoutes(ctx));
  app.use("/users", userRoutes(ctx));

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] unhandled", err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
