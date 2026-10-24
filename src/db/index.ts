import type { PGlite } from "@electric-sql/pglite";
import type postgres from "postgres";

/** Minimal database surface shared by Neon (postgres.js) in production and PGlite in tests/dev. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs multi-statement SQL without parameters (migrations). */
  exec(text: string): Promise<void>;
  tx<R>(fn: (db: Db) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

type Sql = postgres.Sql | postgres.TransactionSql;

function fromPostgres(sql: Sql, root: postgres.Sql | null): Db {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      // biome-ignore lint/suspicious/noExplicitAny: postgres.js parameter typing is too narrow here
      return (await sql.unsafe(text, params as any[])) as unknown as T[];
    },
    async exec(text) {
      await sql.unsafe(text);
    },
    async tx(fn) {
      if (!root) return fn(this);
      return (await root.begin((t) => fn(fromPostgres(t, null)))) as Awaited<ReturnType<typeof fn>>;
    },
    async close() {
      if (root) await root.end({ timeout: 5 });
    },
  };
}

type PgliteLike = Pick<PGlite, "query" | "exec" | "transaction" | "close">;
type PgliteTx = Pick<PGlite, "query" | "exec">;

function fromPglite(db: PgliteTx, root: PgliteLike | null): Db {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await db.query<T>(text, params)).rows;
    },
    async exec(text) {
      await db.exec(text);
    },
    async tx(fn) {
      if (!root) return fn(this);
      return root.transaction((t) => fn(fromPglite(t, null)));
    },
    async close() {
      if (root) await root.close();
    },
  };
}

export async function connectPostgres(url: string): Promise<Db> {
  const { default: postgresJs } = await import("postgres");
  const sql = postgresJs(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
  });
  return fromPostgres(sql, sql);
}

/** In-process Postgres. `dataDir` undefined = in-memory. */
export async function connectPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(dataDir);
  await db.waitReady;
  return fromPglite(db, db);
}
