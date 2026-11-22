-- Stage 2: the one-time tokens behind the emailed magic link.
--
-- The client's flow is: POST /auth/magic-link mints a token and emails
-- <redirect_origin>/?login-token=<token>; the recipient opens it and the page
-- calls GET /auth/login/token?login-token=..., which exchanges it for a
-- session. The client distinguishes "consumed", "expired" and "invalid"
-- (tempTokenLogin in src/client/Auth.ts), so a spent token has to stay on
-- file long enough to answer "consumed" rather than vanishing into "invalid".

CREATE TABLE login_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Hashed, like refresh tokens: this one is a bearer credential that
  -- arrives by email and may sit in an inbox for a long time.
  token_hash  BYTEA       NOT NULL UNIQUE,
  email       TEXT        NOT NULL,
  -- Where the emailed link pointed. Checked against the configured
  -- allowlist when minted, and kept so we can tell afterwards which site a
  -- token was issued for.
  redirect_origin TEXT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  -- Set on consumption, so a support question about "which account did this
  -- email sign into" has an answer.
  user_id     UUID        REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX login_tokens_email ON login_tokens (lower(email));
CREATE INDEX login_tokens_expiry ON login_tokens (expires_at);

-- An account's verified contact address, which is what a magic link signs
-- into and what makes "an account with this email already exists" (the 409
-- the Google sign-in path can return) answerable.
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE email IS NOT NULL;
