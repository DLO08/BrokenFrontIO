import { loadSigningKey } from "./auth/keys";
import { loadConfig } from "./config";
import { migrate } from "./db/migrate";
import { createDb } from "./db/pool";
import { createApp } from "./http/app";

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  // Migrating on boot keeps the single-box deploy to one unit: restart the
  // service and the schema is current. Safe to run concurrently -- each
  // migration is one transaction and the ledger row goes in with it.
  await migrate(db);

  const key = await loadSigningKey(db);
  const app = createApp({ config, db, key });

  const server = app.listen(config.port, config.host, () => {
    console.log(
      `[api] listening on http://${config.host}:${config.port}\n` +
        `      issuer   ${config.issuer}\n` +
        `      audience ${config.audience}\n` +
        `      jwks kid ${key.kid}` +
        (config.apiKey === null
          ? "\n      WARNING: no API_KEY set, server-to-server routes are open"
          : ""),
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[api] ${signal}, shutting down`);
      server.close(() => {
        void db.close().then(() => process.exit(0));
      });
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
