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

  // --- sign-in providers. All optional: an unconfigured provider's routes
  // answer 501 rather than failing at boot, so a deployment can run with
  // only the ones it has credentials for.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),

  STEAM_API_KEY: z.string().min(1).optional(),
  STEAM_APP_ID: z.coerce.number().int().positive().optional(),

  /**
   * Origins the emailed magic link may point at. The client sends its own
   * `redirectDomain`, so without an allowlist anyone could have us mail a
   * link to a site they control -- the email would come from us, carrying a
   * real login token. Comma-separated.
   */
  MAGIC_LINK_ORIGINS: z.string().default("http://localhost:9000"),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  MAGIC_LINK_FROM: z.string().optional(),
  /** "resend" to send for real; "log" prints the link to stdout (dev). */
  MAGIC_LINK_TRANSPORT: z.enum(["resend", "log"]).default("log"),
  RESEND_API_KEY: z.string().min(1).optional(),
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
  /**
   * Origins we are willing to bounce a browser back to, or email a link to.
   * Shared by the magic link and the Steam web sign-in: both take a
   * destination from the caller, and both are an open redirect without this.
   */
  redirectOrigins: string[];
  google: { clientId: string } | null;
  steam: { apiKey: string; appId: number | null } | null;
  magicLink: {
    origins: string[];
    ttlMinutes: number;
    from: string;
    transport: "resend" | "log";
    resendApiKey: string | null;
  };
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

  const magicLinkOrigins = e.MAGIC_LINK_ORIGINS.split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter((o) => o.length > 0);

  if (e.MAGIC_LINK_TRANSPORT === "resend" && !e.RESEND_API_KEY) {
    throw new Error("MAGIC_LINK_TRANSPORT=resend needs RESEND_API_KEY");
  }
  if (isProduction && e.MAGIC_LINK_TRANSPORT === "log") {
    // The "transport" that prints login links to the log is a dev
    // convenience; in production it is a way to hand out sessions.
    throw new Error("MAGIC_LINK_TRANSPORT=log is not allowed in production");
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
    redirectOrigins: magicLinkOrigins,
    google: e.GOOGLE_CLIENT_ID ? { clientId: e.GOOGLE_CLIENT_ID } : null,
    steam: e.STEAM_API_KEY
      ? { apiKey: e.STEAM_API_KEY, appId: e.STEAM_APP_ID ?? null }
      : null,
    magicLink: {
      origins: magicLinkOrigins,
      ttlMinutes: e.MAGIC_LINK_TTL_MINUTES,
      from: e.MAGIC_LINK_FROM ?? "BrokenFront <no-reply@localhost>",
      transport: e.MAGIC_LINK_TRANSPORT,
      resendApiKey: e.RESEND_API_KEY ?? null,
    },
  };
}
