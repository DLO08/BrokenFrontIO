import { uuidToBase64url } from "@openfront/shared/Base64";
import { SignJWT } from "jose";
import { createHash, randomBytes } from "node:crypto";

import type { Config } from "../config";
import type { Db } from "../db/pool";
import type { SigningKey } from "./keys";

/**
 * Mints the short-lived JWT the client holds in memory and sends to the game
 * server, which verifies it against our JWKS and parses it with
 * TokenPayloadSchema (@openfront/shared/ApiSchemas). That schema is the
 * contract:
 *
 *   sub   base64url of the account UUID -- NOT the raw UUID. The game server
 *         decodes it back and uses it as the persistentID.
 *   iss   must equal ServerEnv.jwtIssuer()
 *   aud   must equal ServerEnv.jwtAudience()
 *   role  optional; absent for an ordinary player.
 */
export async function issueAccessToken(
  config: Config,
  key: SigningKey,
  user: { id: string; role: string | null },
  provider: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    ...(user.role === null ? {} : { role: user.role }),
    provider,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
    .setJti(crypto.randomUUID())
    .setSubject(uuidToBase64url(user.id))
    .setIssuedAt(now)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setExpirationTime(now + config.accessTokenTtlSeconds);
  return builder.sign(key.privateKey);
}

function hash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export type RefreshMint = { token: string; expiresAt: Date };

/** Starts a new refresh-token family (a fresh login). */
export async function mintRefreshToken(
  config: Config,
  db: Db,
  userId: string,
  familyId: string = crypto.randomUUID(),
): Promise<RefreshMint> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  );
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, hash(token), familyId, expiresAt],
  );
  return { token, expiresAt };
}

export type RotateResult =
  | { type: "ok"; userId: string; role: string | null; refresh: RefreshMint }
  | { type: "invalid" }
  | { type: "reused" };

/**
 * Exchanges a refresh token for the next one in its family.
 *
 * A token that has already been rotated is the classic stolen-cookie signal:
 * either the thief or the victim is replaying one. We cannot tell which, so
 * the whole family is revoked and both sides have to log in again -- the
 * standard OAuth refresh-rotation response, and the reason `family_id`
 * exists at all.
 */
export async function rotateRefreshToken(
  config: Config,
  db: Db,
  presented: string,
): Promise<RotateResult> {
  return db.tx(async (t) => {
    const found = await t.query<{
      id: string;
      user_id: string;
      family_id: string;
      expires_at: Date;
      rotated_at: Date | null;
      revoked_at: Date | null;
      role: string | null;
    }>(
      `SELECT r.id, r.user_id, r.family_id, r.expires_at, r.rotated_at,
              r.revoked_at, u.role
         FROM refresh_tokens r
         JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = $1
        FOR UPDATE OF r`,
      [hash(presented)],
    );
    if (found.rows.length === 0) return { type: "invalid" as const };
    const row = found.rows[0];

    if (row.rotated_at !== null) {
      await t.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id],
      );
      return { type: "reused" as const };
    }
    if (row.revoked_at !== null || row.expires_at.getTime() <= Date.now()) {
      return { type: "invalid" as const };
    }

    await t.query(
      "UPDATE refresh_tokens SET rotated_at = now() WHERE id = $1",
      [row.id],
    );
    const refresh = await mintRefreshToken(
      config,
      t,
      row.user_id,
      row.family_id,
    );
    return {
      type: "ok" as const,
      userId: row.user_id,
      role: row.role,
      refresh,
    };
  });
}

/** Logout: drops just this session, leaving the account's others alone. */
export async function revokeRefreshToken(db: Db, presented: string) {
  await db.query(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hash(presented)],
  );
}

/** "Sign out everywhere". */
export async function revokeAllForUser(db: Db, userId: string) {
  await db.query(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
}
