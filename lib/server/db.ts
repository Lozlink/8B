import "server-only";
import postgres from "postgres";
import { env } from "./env";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Either the pool or a transaction — read helpers accept both. */
export type Db = postgres.Sql | postgres.TransactionSql;

declare global {
  var __timerSql: postgres.Sql | undefined;
}

/**
 * One pool per server instance. Connects as the least-privilege `timer_app` role through
 * Supabase's transaction pooler (Supavisor, port 6543), which needs two settings:
 *
 * - `prepare: false`: no prepared statements in transaction mode.
 * - `max_pipeline: 1`: Supavisor never answers pipelined queries in transaction mode. When more
 *   queries are in flight than there are connections (the daily summary runs 7 at once),
 *   postgres.js would send several down one connection, that connection would wedge, and every
 *   later query on this instance would queue behind it until Vercel killed the request at 300 s.
 *   With 1, extra queries wait for a free connection instead.
 *
 * `query_timeout` is the backstop if the pooler ever goes silent again: the query fails with
 * QUERY_TIMEOUT, the connection is replaced, and the next request works.
 */
export function db(): postgres.Sql {
  if (!globalThis.__timerSql) {
    globalThis.__timerSql = postgres(env().DATABASE_URL, {
      prepare: false,
      max: 5,
      max_pipeline: 1,
      query_timeout: 15,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }
  return globalThis.__timerSql;
}

/** For tests: inject a connection (e.g. PGlite via socket). */
export function setDbForTests(sql: postgres.Sql | undefined): void {
  globalThis.__timerSql = sql;
}

export function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().begin(fn) as Promise<T>;
}

/** Postgres error codes we translate into user-facing conflicts. */
export const PG = {
  UNIQUE: "23505",
  EXCLUSION: "23P01",
  CHECK: "23514",
  FOREIGN_KEY: "23503",
  INSUFFICIENT_PRIVILEGE: "42501",
  LOCK_NOT_AVAILABLE: "55P03",
} as const;

export function pgCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return undefined;
}

export function pgConstraint(e: unknown): string | undefined {
  if (e && typeof e === "object" && "constraint_name" in e) {
    const c = (e as { constraint_name: unknown }).constraint_name;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}
