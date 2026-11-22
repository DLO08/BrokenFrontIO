import { z } from "zod";

/**
 * The API's environment.
 *
 * Two values here are not free choices -- the game server derives them
 * itself and will reject our tokens if they disagree (src/server/ServerEnv.ts,
 * src/server/jwt.ts):
 *
 *   issuer    ServerEnv.jwtIssuer() is "http://localhost:8787" when the
 *             audience is "localhost", and "https://api.<audience>"
 *             otherwise. It fetches <issuer>/.well-known/jwks.json.
 *   audience  ServerEnv.jwtAudience(), which the page also carries to the
 *             client as BOOTSTRAP_CONFIG.jwtAudience.
 *
 * So JWT_AUDIENCE is the single knob, and the issuer follows from it unless
 * explicitly overridden (useful behind a tunnel whose hostname isn't
 * api.<audience>).
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("127.0.0.1"),

  DATABASE_URL: z.string().min(1),

  JWT_AUDIENCE: z.string().min(1).default("localhost"),
  JWT_ISSUER: z.string().url().optional(),
  /** Short, because it is replayable until it expires. Matches docs/Auth.md. */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * Shared secret the game server sends as `x-api-key` on its server-to-server
   * calls. Required outside dev: without it, anyone who can reach the API
   * could read any player's /users/@me by public id.
   */
  API_KEY: z.string().min(1).optional(),

  /** Browser origin allowed to send credentialed requests. */
  CLIENT_ORIGIN: z.string().default("http://localhost:9000"),
  COOKIE_DOMAIN: z.string().optional(),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Config = {
  port: number;
  host: string;
  databaseUrl: string;
  audience: string;
  issuer: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  apiKey: string | null;
  clientOrigin: string;
  cookieDomain: string | null;
  /** Drives cookie `Secure` and whether a missing API_KEY is fatal. */
  isProduction: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid API environment:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === "production";

  const issuer =
    e.JWT_ISSUER ??
    (e.JWT_AUDIENCE === "localhost"
      ? `http://localhost:${e.PORT}`
      : `https://api.${e.JWT_AUDIENCE}`);

  if (isProduction && !e.API_KEY) {
    throw new Error(
      "API_KEY is required in production: it is the only thing separating " +
        "the game server's server-to-server calls from the public internet.",
    );
  }

  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    audience: e.JWT_AUDIENCE,
    issuer,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    apiKey: e.API_KEY ?? null,
    clientOrigin: e.CLIENT_ORIGIN,
    cookieDomain: e.COOKIE_DOMAIN ?? null,
    isProduction,
  };
}
