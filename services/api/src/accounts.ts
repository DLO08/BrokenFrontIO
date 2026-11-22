import { randomBytes } from "node:crypto";

import type { Db } from "./db/pool";

export type User = {
  id: string;
  publicId: string;
  role: string | null;
  adfree: boolean;
  levelHidden: boolean;
  searchHidden: boolean;
  email: string | null;
};

const ROW = `id, public_id, role, adfree, level_hidden, search_hidden, email`;

type Row = {
  id: string;
  public_id: string;
  role: string | null;
  adfree: boolean;
  level_hidden: boolean;
  search_hidden: boolean;
  email: string | null;
};

function toUser(r: Row): User {
  return {
    id: r.id,
    publicId: r.public_id,
    role: r.role,
    adfree: r.adfree,
    levelHidden: r.level_hidden,
    searchHidden: r.search_hidden,
    email: r.email,
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

export type Identity = {
  provider: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  profile: Record<string, unknown>;
};

export async function identitiesFor(
  db: Db,
  userId: string,
): Promise<Identity[]> {
  const r = await db.query<{
    provider: string;
    subject: string;
    email: string | null;
    display_name: string | null;
    profile: Record<string, unknown>;
  }>(
    `SELECT provider, subject, email, display_name, profile
       FROM user_identities WHERE user_id = $1 ORDER BY provider`,
    [userId],
  );
  return r.rows.map((x) => ({
    provider: x.provider,
    subject: x.subject,
    email: x.email,
    displayName: x.display_name,
    profile: x.profile ?? {},
  }));
}

export async function findByEmail(db: Db, email: string): Promise<User | null> {
  const r = await db.query<Row>(
    `SELECT ${ROW} FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return r.rows.length > 0 ? toUser(r.rows[0]) : null;
}

export async function setEmail(db: Db, userId: string, email: string) {
  await db.query("UPDATE users SET email = $1 WHERE id = $2", [email, userId]);
}

export type LinkResult =
  | { ok: true; alreadyLinked: boolean }
  // This account already has an identity from that provider. We refuse
  // rather than replace: silently repointing a link would let somebody who
  // borrowed a signed-in session swap the account's Google account for
  // their own and keep it.
  | { ok: false; reason: "account_already_linked" }
  // Somebody else holds that provider identity.
  | { ok: false; reason: "linked_elsewhere"; otherUserId: string };

/**
 * Attaches a verified provider identity to an existing account.
 *
 * Idempotent when the pair is already linked, because the client treats a
 * re-link as success (see postSteamLinkRedeem in src/client/SteamLink.ts).
 */
export async function linkIdentity(
  db: Db,
  userId: string,
  provider: string,
  subject: string,
  profile: { email?: string; displayName?: string; raw?: unknown } = {},
): Promise<LinkResult> {
  return db.tx(async (t) => {
    const owner = await t.query<{ user_id: string }>(
      "SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2",
      [provider, subject],
    );
    if (owner.rows.length > 0) {
      return owner.rows[0].user_id === userId
        ? { ok: true as const, alreadyLinked: true }
        : {
            ok: false as const,
            reason: "linked_elsewhere" as const,
            otherUserId: owner.rows[0].user_id,
          };
    }

    const mine = await t.query(
      "SELECT 1 FROM user_identities WHERE user_id = $1 AND provider = $2",
      [userId, provider],
    );
    if ((mine.rowCount ?? 0) > 0) {
      return { ok: false as const, reason: "account_already_linked" as const };
    }

    await t.query(
      `INSERT INTO user_identities (user_id, provider, subject, email, display_name, profile)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        provider,
        subject,
        profile.email ?? null,
        profile.displayName ?? null,
        profile.raw ?? {},
      ],
    );
    return { ok: true as const, alreadyLinked: false };
  });
}
