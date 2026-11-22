# @openfront/api

The self-hosted account / stats / shop API. Design, the contract it has to
satisfy, and the staged roadmap live in [`docs/SelfHostedApi.md`](../../docs/SelfHostedApi.md).

```bash
cp .env.example .env            # fill in DATABASE_URL
npm run migrate -w @openfront/api
npm start -w @openfront/api     # http://127.0.0.1:8787
```

Layout:

| Path                 | What                                                        |
| -------------------- | ----------------------------------------------------------- |
| `src/config.ts`      | Environment, and the issuer/audience the game server pins   |
| `src/db/`            | Postgres pool, migration runner, `migrations/*.sql`         |
| `src/auth/keys.ts`   | Ed25519 signing key, stored in the DB, served as JWKS       |
| `src/auth/tokens.ts` | Access tokens, refresh rotation and reuse detection         |
| `src/accounts.ts`    | Accounts and linked provider identities                     |
| `src/http/app.ts`    | Express app, CORS, cookies, `requireUser` / `requireApiKey` |
| `src/routes/`        | Route modules mounted by `app.ts`                           |

Contract tests are in `tests/api/` and run with the repo's `node` Vitest
project; they do not need a database.
