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

| Pinned by                           | What it fixes                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/ApiSchemas.ts` | Request/response bodies. `UserMeResponseSchema` is ~200 lines and the client parses every response with it.                                                                                           |
| `src/server/ServerEnv.ts`           | The issuer (`http://localhost:8787` for audience `localhost`, else `https://api.<audience>`) and that the JWKS is at `<issuer>/.well-known/jwks.json`, fetched with `x-api-key` and **no redirects**. |
| `src/server/jwt.ts`                 | EdDSA/Ed25519 only, issuer and audience pinned, body parsed with `TokenPayloadSchema`.                                                                                                                |

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

Stage 2 adds `POST /auth/google`, `POST /auth/google/link`, `POST /auth/steam`,
`GET /auth/login/steam`, `GET /auth/steam/return`, `POST /auth/magic-link` and
`GET /auth/login/token`.

Refresh tokens are stored only as SHA-256 hashes, rotate on every use, and are
grouped into families so that replaying a spent token revokes the whole chain —
the standard answer to a stolen cookie, since the server cannot tell the thief
from the victim.

### Stage 2 — real sign-in (done)

Three ways into an account, plus linking. Every provider is optional: an
unconfigured one answers 501 rather than stopping the service from booting,
so they can be switched on one at a time as credentials arrive.

- **Google** — `POST /auth/google`, `POST /auth/google/link`. The client runs
  Google Identity Services itself and posts only the resulting ID token, so
  there is no client secret here and no redirect dance; verifying that token
  is the whole boundary. Needs `GOOGLE_CLIENT_ID`.
- **Steam** — `POST /auth/steam` for the desktop shell's session ticket, and
  `GET /auth/login/steam` → `GET /auth/steam/return` for the website's OpenID
  round trip. Needs `STEAM_API_KEY` (and `STEAM_APP_ID` for the ticket path).
- **Magic link** — `POST /auth/magic-link`, `GET /auth/login/token`. Needs
  `MAGIC_LINK_ORIGINS`, and `RESEND_API_KEY` to send for real.

`/users/@me` now reports what is linked (`user.google`, `user.steam`,
`user.email`) and promotes an account with any real identity from
`trustTier: "untrusted"` to `"trusted"`.

Four things here are security-critical rather than incidental, and each has a
test in `tests/api/ApiProviders.test.ts`:

| Trap                        | What goes wrong without it                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Google **audience** check   | An ID token minted for someone else's Google app is still validly signed by Google.                                                              |
| Google `email_verified`     | Register a Google account carrying a victim's address, claim their account by email.                                                             |
| Steam `claimed_id` ordering | It arrives in the user's own query string. Parse the SteamID before Steam confirms the signature and anyone signs in as anyone by editing a URL. |
| Redirect allowlist          | `redirectDomain` comes from the caller. Without it we email real login tokens pointing at attacker-controlled sites.                             |

Two smaller ones: Steam reports bad tickets as an `error` object inside an
HTTP **200**, so status alone would accept every invalid ticket; and
`POST /auth/magic-link` always answers 200 so it cannot be used to test
whether an address has an account.

### Stage 2b — the Steam link ticket flow

Deliberately split out: `/auth/steam/link`, `/auth/steam/link_ticket/:token`,
`/auth/steam/link/conflict` and `/auth/steam/link/discard` are not one more
sign-in path but a stateful negotiation — mint a ticket in the desktop shell,
confirm it on the web, and when the SteamID already belongs to another
account, offer to discard that account, with `steam_has_progress`,
`discard_blocked` (including the paid case), `discard_deferred` and
`offer_unavailable` all meaning different things to the UI. See
`src/client/SteamLink.ts` and `SteamLinkModal.ts` for the reason codes the
client already renders.

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

`services/api` declares `pg`. It is in `package-lock.json`, but not yet in
`node_modules` — the repo installs with `npm ci --ignore-scripts`, which only
reads the lockfile. Run the normal install once to pick it up:

```bash
npm run inst
```

Note that this machine runs Node 26 while the repo's `engines` asks for
`>=24.15.0 <25`, and `.npmrc` sets `engine-strict=true`, so npm refuses with
`EBADENGINE`. Either use Node 24, or pass `--engine-strict=false`. Until `pg`
is in `node_modules` the service will not boot, though it typechecks and all
its tests pass (they are written not to need a database).
