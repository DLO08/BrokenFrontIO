import pg from "pg";

export type Db = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

function wrap(runner: pg.Pool | pg.PoolClient, pool: pg.Pool | null): Db {
  return {
    query: (text, params) => runner.query(text, params as unknown[]),
    async tx(fn) {
      // Already inside one: Postgres has no real nested transactions and the
      // callers here never need savepoints, so reuse the open one.
      if (pool === null) return fn(wrap(runner, null));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client, null));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      if (pool !== null) await pool.end();
    },
  };
}

export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // The box runs one API process; this is headroom, not a target.
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  // An idle client erroring out (a Postgres restart, a dropped tunnel) emits
  // on the pool. Without a listener Node treats it as an unhandled 'error'
  // event and takes the process down.
  pool.on("error", (err) => {
    console.error("[db] idle client error", err);
  });
  return wrap(pool, pool);
}
