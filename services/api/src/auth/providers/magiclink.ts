import { createHash, randomBytes } from "node:crypto";

import type { Config } from "../../config";
import type { Db } from "../../db/pool";

/**
 * The emailed sign-in link.
 *
 * Two things here are security-critical rather than cosmetic:
 *
 *  - the redirect origin is chosen by the caller, so it is checked against an
 *    allowlist. Without that, anyone could ask us to email a login link
 *    pointing at a site they control -- sent from our domain, carrying a real
 *    token.
 *  - requesting a link never reveals whether the address has an account. The
 *    route answers 200 either way; otherwise this endpoint is an account
 *    enumeration oracle.
 */

export type MintedLink = { token: string; url: string; expiresAt: Date };

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Returns the allowed origin matching `requested`, or null. */
export function resolveRedirectOrigin(
  requested: string | undefined,
  allowed: readonly string[],
): string | null {
  if (allowed.length === 0) return null;
  if (requested === undefined) return allowed[0];
  let normalised: string;
  try {
    // Compare parsed origins, not strings: "https://x.example/" and
    // "https://x.example" are the same origin, while "https://x.example.evil"
    // is not -- which a startsWith check would have accepted.
    normalised = new URL(requested).origin;
  } catch {
    return null;
  }
  return allowed.find((o) => safeOrigin(o) === normalised) ?? null;
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export async function mintLoginToken(
  config: Config,
  db: Db,
  email: string,
  redirectOrigin: string,
): Promise<MintedLink> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + config.magicLink.ttlMinutes * 60 * 1000,
  );
  await db.query(
    `INSERT INTO login_tokens (token_hash, email, redirect_origin, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hashToken(token), email, redirectOrigin, expiresAt],
  );
  // The shape the client reads: it looks for ?login-token= on load and calls
  // GET /auth/login/token with it (src/client/Auth.ts, tempTokenLogin).
  const url = `${redirectOrigin}/?login-token=${encodeURIComponent(token)}`;
  return { token, url, expiresAt };
}

export type ConsumeResult =
  | { ok: true; email: string }
  // Exactly the three codes tempTokenLogin distinguishes; they drive
  // different messages, so collapsing them would lose information the UI
  // already knows how to use.
  | { ok: false; code: "consumed" | "expired" | "invalid" };

/**
 * Spends a token. The UPDATE ... WHERE consumed_at IS NULL is what makes
 * this single-use under concurrency: two simultaneous exchanges of the same
 * token both find the row, but only one update matches.
 */
export async function consumeLoginToken(
  db: Db,
  token: string,
): Promise<ConsumeResult> {
  const found = await db.query<{
    id: string;
    email: string;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT id, email, expires_at, consumed_at
       FROM login_tokens WHERE token_hash = $1`,
    [hashToken(token)],
  );
  if (found.rows.length === 0) return { ok: false, code: "invalid" };
  const row = found.rows[0];
  if (row.consumed_at !== null) return { ok: false, code: "consumed" };
  if (row.expires_at.getTime() <= Date.now()) {
    return { ok: false, code: "expired" };
  }

  const claimed = await db.query(
    `UPDATE login_tokens SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL`,
    [row.id],
  );
  if (claimed.rowCount === 0) return { ok: false, code: "consumed" };
  return { ok: true, email: row.email };
}

/** Records which account a spent token signed into. */
export async function attachLoginTokenUser(
  db: Db,
  token: string,
  userId: string,
) {
  await db.query("UPDATE login_tokens SET user_id = $1 WHERE token_hash = $2", [
    userId,
    hashToken(token),
  ]);
}

export async function sendLoginEmail(config: Config, to: string, url: string) {
  if (config.magicLink.transport === "log") {
    console.log(`[magic-link] ${to} -> ${url}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.magicLink.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.magicLink.from,
      to,
      subject: "Your BrokenFront sign-in link",
      text:
        `Open this link to sign in:\n\n${url}\n\n` +
        `It expires in ${config.magicLink.ttlMinutes} minutes and can only ` +
        `be used once. If you didn't ask for it, you can ignore this email.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`email send failed: ${res.status} ${await res.text()}`);
  }
}
