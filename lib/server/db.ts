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
 * One pool per server instance. Supabase's transaction pooler (port 6543) doesn't support
 * prepared statements, hence `prepare: false`. Connects as the least-privilege `timer_app` role.
 */
export function db(): postgres.Sql {
  if (!globalThis.__timerSql) {
    globalThis.__timerSql = postgres(env().DATABASE_URL, {
      prepare: false,
      max: 5,
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
