-- Stage 1: identity. Everything the game server needs to accept a join --
-- signing keys, accounts, linked providers, refresh tokens -- plus the two
-- per-account preferences /users/@me already reports.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The Ed25519 keypair whose public half is served at
-- /.well-known/jwks.json. It lives in the database rather than in the
-- process so a restart does not invalidate every token in flight, and so
-- two API instances behind the tunnel agree on one key.
CREATE TABLE signing_keys (
  kid         TEXT PRIMARY KEY,
  private_jwk JSONB       NOT NULL,
  public_jwk  JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at  TIMESTAMPTZ
);

-- Exactly one key signs at a time; the rest stay readable so tokens signed
-- by a key we have just rotated away from still verify until they expire.
CREATE UNIQUE INDEX signing_keys_one_active
  ON signing_keys ((retired_at IS NULL))
  WHERE retired_at IS NULL;

-- `id` IS the persistentID: the JWT's `sub` is this UUID in base64url
-- (uuidToBase64url in @openfront/shared/Base64), and the game server maps a
-- socket to it at join.
CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short opaque handle used in public URLs and /public/player/:id.
  public_id     TEXT        NOT NULL UNIQUE,
  -- null for an ordinary player; "mod"/"admin"/"root"/"flagged"/"banned"
  -- are carried in the token and read by the game server.
  role          TEXT,
  adfree        BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Mirrors UserMeResponse.player.levelHidden / searchHidden.
  level_hidden  BOOLEAN     NOT NULL DEFAULT FALSE,
  search_hidden BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per linked sign-in method. A guest account has a single "guest"
-- identity whose subject is the device token, so the same browser comes back
-- to the same account; linking Google/Steam/email later just adds rows.
CREATE TABLE user_identities (
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT        NOT NULL,
  subject     TEXT        NOT NULL,
  email       TEXT,
  display_name TEXT,
  -- Whatever the provider returned, kept for debugging and for fields we do
  -- not model yet (avatars, Steam persona, ...).
  profile     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);

CREATE INDEX user_identities_user ON user_identities (user_id);

-- Refresh tokens are stored only as a SHA-256 hash: a database leak must not
-- hand out live sessions. Rotation is enforced by `rotated_at` -- presenting
-- a token that has already been exchanged is treated as theft and kills the
-- whole chain (see auth/tokens.ts).
CREATE TABLE refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  BYTEA       NOT NULL UNIQUE,
  -- Every token minted from one login shares a family; reuse revokes it all.
  family_id   UUID        NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  rotated_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

-- Dismissed notice keys (POST /users/@me/notices).
CREATE TABLE user_notices_seen (
  user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT        NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
