import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config";
import { createDb, type Db } from "./pool";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export function migrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return (
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      // Numeric prefixes, so plain lexicographic order is the apply order as
      // long as they stay zero-padded. 001_init.sql, 002_....
      .sort()
  );
}

/**
 * Applies every migration that has not run yet, each in its own transaction
 * so a failure half-way leaves the applied ones committed and the failing one
 * untouched.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (
      await db.query<{ version: string }>(
        "SELECT version FROM schema_migrations",
      )
    ).rows.map((r) => r.version),
  );

  const pending = migrationFiles(dir).filter((f) => !applied.has(f));
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await db.tx(async (t) => {
      await t.query(sql);
      await t.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
        file,
      ]);
    });
    console.log(`[migrate] applied ${file}`);
  }
  if (pending.length === 0) console.log("[migrate] up to date");
  return pending;
}

// `npm run migrate -w @openfront/api`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  migrate(db)
    .then(() => db.close())
    .catch(async (e) => {
      console.error(e);
      await db.close();
      process.exit(1);
    });
}
