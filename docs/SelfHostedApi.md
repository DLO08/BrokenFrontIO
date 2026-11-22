# Self-hosted API

The account/shop/stats API that upstream OpenFront runs as a closed-source
Cloudflare Worker, rebuilt here so BrokenFront can host it itself. It lives in
`services/api` (an npm workspace, added via the `services/*` glob) and is meant
to run on the Kubuntu box behind the existing Cloudflare tunnel.

The client reaches it at `getApiBase()` (`src/client/ApiBase.ts`):
`http://localhost:8787` in dev, `https://api.<audience>` otherwise.

## The contract is already written

This service does not get to design its own API. Three things pin it down, and
getting any of them wrong means players cannot join a game:

| Pinned by | What it fixes |
| --- | --- |
| `packages/shared/src/ApiSchemas.ts` | Request/response bodies. `UserMeResponseSchema` is ~200 lines and the client parses every response with it. |
| `src/server/ServerEnv.ts` | The issuer (`http://localhost:8787` for audience `localhost`, else `https://api.<audience>`) and that the JWKS is at `<issuer>/.well-known/jwks.json`, fetched with `x-api-key` and **no redirects**. |
| `src/server/jwt.ts` | EdDSA/Ed25519 only, issuer and audience pinned, body parsed with `TokenPayloadSchema`. |

Two details are easy to get wrong:

- **`sub` is not the UUID.** It is the account UUID in base64url
  (`uuidToBase64url`, `packages/shared/src/Base64.ts`). The game server decodes
  it back and uses it as the persistentID.
- **Absent beats faked.** Most of `UserMeResponseSchema` is optional, and the
  client reads an absent field as "this deployment doesn't have that feature"
  and hides the UI. A zeroed `progress` renders as "level 1, 0 XP"; a malformed
  one can fail the whole parse and make the player look signed out. Leave
  unimplemented fields out.

`tests/api/ApiAuth.test.ts` locks all of this down without needing a database:
it mints a token and verifies it exactly the way the game server does.

## Running it

```bash
# once: Postgres 15+ on the box
createdb openfront
cp services/api/.env.example services/api/.env   # then fill in DATABASE_URL

npm run migrate -w @openfront/api   # also runs automatically on boot
npm start -w @openfront/api
```

`API_KEY` must match the game server's own `API_KEY`; the service refuses to
start in production without one, because it is the only thing in front of the
server-to-server routes.

## Status

### Stage 1 — identity (done)

Signing keys, JWKS, access/refresh tokens with rotation and reuse detection,
guest accounts, and the minimum valid `/users/@me`.

- `GET /health`
- `GET /.well-known/jwks.json`
- `POST /auth/guest`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/revoke`
- `GET /users/@me`, `POST /users/@me/notices`,
  `PUT /users/@me/{level,search}_visibility`

Refresh tokens are stored only as SHA-256 hashes, rotate on every use, and are
grouped into families so that replaying a spent token revokes the whole chain —
the standard answer to a stolen cookie, since the server cannot tell the thief
from the victim.

### Stage 2 — real sign-in

`POST /auth/google` + `/auth/google/link`, `/auth/steam` + `/auth/steam/link`
(including `link_ticket`, `link/conflict`, `link/discard`), `/auth/magic-link`.
Needs from you: a Google OAuth client ID/secret, a Steam Web API key, and an
email sender (Resend/Postmark/SMTP). Account linking and the conflict flow are
the bulk of the work, not the OAuth dance.

### Stage 3 — profile and progression

Usernames with discriminators and the 30-day rename cooldown
(`/users/@me/username`), `/users/@me/xp/*`, `/users/@me/prestige`,
`/public/progression/config`, `/users/@me/identity_token`,
`/users/@me/tribe_names`, `/users/@me/saved_games`, `/users/@me/messages/seen`.

### Stage 4 — social

Friends (`/friends/status`, `/friends/requests`, `/friends/:id`) and clans —
the largest single area, ~23 endpoints covering browse, cards, join requests,
donations, fund transfers, game history and the clan leaderboard
(`packages/shared/src/ClanApiSchemas.ts`).

### Stage 5 — competitive

`/ranked/join`, `/ranked/ffa/*`, `/users/@me/ffa_rating/*`,
`/users/@me/ffa_rank_position`, and the `trustTier` computation that gates
ranked. Needs a rating system (the schemas imply Elo plus an uncertainty term)
and matchmaking queues.

### Stage 6 — public stats

The read-only surface already documented in `docs/API.md`: `/public/games`,
`/public/game/:id`, `/public/player/:id`, `/public/clan/:tag`,
`/public/clans/leaderboard`, `/public/tribe/:id`. Requires the game server to
archive finished games into Postgres.

### Stage 7 — store, inventory and Stripe

Cosmetics catalog and ownership, `/users/@me/currency`, rewards claiming, then
Stripe checkout, the billing portal, webhooks and subscription state
(`UserSubscriptionSchema`, `pastDueSubscription`, tier conversions).

> **Note on Stage 7.** This is the one stage that carries obligations beyond
> code: a live Stripe account, tax handling, refunds and chargebacks, and the
> fact that a bug here moves real money. The webhook signature check and
> idempotency on replayed events are the parts to get right. Worth doing last,
> and worth keeping behind a flag so the rest of the API can ship without it.

## Dependency note

`services/api` declares `pg`, which is **not currently installed** — the repo
installs with `npm ci --ignore-scripts`, which cannot add a package. The
lockfile needs updating once:

```bash
npm install --package-lock-only   # updates package-lock.json only
npm run inst                      # then the normal install
```

Until that runs the service will not boot, though it typechecks and its tests
pass (`@types/pg` is already present transitively).
