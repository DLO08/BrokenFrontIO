import { randomBytes } from "node:crypto";

import type { Db } from "./db/pool";

export type User = {
  id: string;
  publicId: string;
  role: string | null;
  adfree: boolean;
  levelHidden: boolean;
  searchHidden: boolean;
};

const ROW = `id, public_id, role, adfree, level_hidden, search_hidden`;

type Row = {
  id: string;
  public_id: string;
  role: string | null;
  adfree: boolean;
  level_hidden: boolean;
  search_hidden: boolean;
};

function toUser(r: Row): User {
  return {
    id: r.id,
    publicId: r.public_id,
    role: r.role,
    adfree: r.adfree,
    levelHidden: r.level_hidden,
    searchHidden: r.search_hidden,
  };
}

/**
 * Eight base64url characters, matching the shape of the public ids the
 * existing public API hands out (`HabCsQYR`). 48 bits of randomness: at the
 * scale this service will ever see, a collision is a retry, not a design
 * problem, which is what the unique index turns it into.
 */
function newPublicId(): string {
  return randomBytes(6).toString("base64url");
}

export async function getUserById(db: Db, id: string): Promise<User | null> {
  const r = await db.query<Row>(`SELECT ${ROW} FROM users WHERE id = $1`, [id]);
  return r.rows.length > 0 ? toUser(r.rows[0]) : null;
}

/**
 * Resolves a provider identity to an account, creating one the first time we
 * see it. `provider` is the token's `provider` claim -- "guest", "google",
 * "steam", "email".
 */
export async function findOrCreateByIdentity(
  db: Db,
  provider: string,
  subject: string,
  profile: { email?: string; displayName?: string; raw?: unknown } = {},
): Promise<User> {
  return db.tx(async (t) => {
    const existing = await t.query<Row>(
      `SELECT ${ROW.split(", ")
        .map((c) => `u.${c}`)
        .join(", ")}
         FROM user_identities i
         JOIN users u ON u.id = i.user_id
        WHERE i.provider = $1 AND i.subject = $2`,
      [provider, subject],
    );
    if (existing.rows.length > 0) {
      const user = toUser(existing.rows[0]);
      await t.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [
        user.id,
      ]);
      return user;
    }

    // Retry only the public id: anything else failing is a real error.
    for (let attempt = 0; ; attempt++) {
      try {
        const created = await t.query<Row>(
          `INSERT INTO users (public_id) VALUES ($1) RETURNING ${ROW}`,
          [newPublicId()],
        );
        const user = toUser(created.rows[0]);
        await t.query(
          `INSERT INTO user_identities (user_id, provider, subject, email, display_name, profile)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            user.id,
            provider,
            subject,
            profile.email ?? null,
            profile.displayName ?? null,
            profile.raw ?? {},
          ],
        );
        return user;
      } catch (e) {
        const code = (e as { code?: string }).code;
        // 23505 = unique_violation. On public_id, try again; on the identity
        // key, another request created the same account concurrently.
        if (code !== "23505" || attempt >= 4) throw e;
      }
    }
  });
}

export async function noticesSeen(db: Db, userId: string): Promise<string[]> {
  const r = await db.query<{ key: string }>(
    "SELECT key FROM user_notices_seen WHERE user_id = $1 ORDER BY key",
    [userId],
  );
  return r.rows.map((x) => x.key);
}
