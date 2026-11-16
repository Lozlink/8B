import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { hashSync } from "bcryptjs";
import { setDbForTests } from "@/lib/server/db";
import type { Actor, Manager } from "@/lib/server/auth";
import { setTerminalGatewayForTests } from "@/lib/server/sessions";
import { FakeGateway } from "./fake-gateway";

// Server env the admin/queries modules read lazily (never contacts Square).
const TEST_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  SESSION_SECRET: "test-session-secret-test-session-secret",
  DEVICE_ENROL_CODE: "test-enrol-code-123456",
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_ACCESS_TOKEN: "test-token",
  SQUARE_LOCATION_ID: "LOC_TEST",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "test-key",
  SQUARE_WEBHOOK_URL: "https://example.test/api/square/webhook",
};
for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] ??= v;

const MIGRATIONS = resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(resolve(MIGRATIONS, f), "utf8");

export const INIT_SQL = read("20261116000000_init.sql");
export const REFERENCE_SQL = read("20261116000100_reference_data.sql");

export interface TestStaff {
  /** Plain staff member acting on the Counter iPad. */
  actor: Actor;
  /** Manager acting on the Counter iPad. */
  managerActor: Actor;
  manager: Manager;
}

export interface Harness {
  pg: PGlite;
  sql: postgres.Sql;
  gateway: FakeGateway;
  staff: TestStaff;
  /** Table id by name, e.g. "Table 2". */
  tableId(name: string): string;
  /** Wipes all data (bypassing the delete-blocking triggers) and re-seeds reference data + staff. */
  reset(): Promise<void>;
  /** Runs raw SQL on PGlite as the given role (null = superuser), then restores timer_app. */
  raw<T extends Record<string, unknown> = Record<string, unknown>>(role: string | null, text: string): Promise<T[]>;
  /** Expects the statement to fail; returns the Postgres error. */
  rawError(role: string | null, text: string): Promise<{ code?: string; message: string }>;
  close(): Promise<void>;
}

/** Seeded PINs (real bcrypt hashes, cost 4 to keep tests fast). */
export const STAFF_PIN = "1111";
export const MANAGER_PIN = "2222";
const STAFF_HASH = hashSync(STAFF_PIN, 4);
const MANAGER_HASH = hashSync(MANAGER_PIN, 4);

export async function bootHarness(): Promise<Harness> {
  const pg = await PGlite.create({ extensions: { btree_gist } });

  // What Supabase provides out of the box. There is deliberately no `realtime` schema.
  await pg.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create schema extensions;
    grant usage on schema public to anon, authenticated, service_role;
    grant all on all tables in schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `);
  await pg.exec(INIT_SQL);
  await pg.exec(REFERENCE_SQL);

  const server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
  await server.start();
  const conn = server.getServerConn();
  const port = Number(conn.slice(conn.lastIndexOf(":") + 1));

  const sql = postgres({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    max: 1,
    eager_types: true,
    prepare: false,
    onnotice: () => {},
    connect_timeout: 30,
  });
  // Run the service with the real least-privilege grants + RLS policies.
  await sql`set role timer_app`;
  setDbForTests(sql);

  const gateway = new FakeGateway();
  setTerminalGatewayForTests(gateway);

  const raw: Harness["raw"] = async (role, text) => {
    await pg.exec("reset role");
    try {
      if (role) await pg.exec(`set role ${role}`);
      const r = await pg.query(text);
      return r.rows as never;
    } finally {
      await pg.exec("reset role");
      await pg.exec("set role timer_app");
    }
  };

  const tableIds = new Map<string, string>();
  const h: Harness = {
    pg,
    sql,
    gateway,
    staff: undefined as unknown as TestStaff,
    tableId(name: string) {
      const id = tableIds.get(name);
      if (!id) throw new Error(`no such table ${name}`);
      return id;
    },
    async reset() {
      await pg.exec("reset role");
      try {
        // Replica mode skips the no-delete triggers; this is test setup only.
        await pg.exec(`
          set session_replication_role = replica;
          truncate public.audit_log, public.webhook_events, public.terminal_checkouts,
            public.session_intervals, public.sessions, public.login_attempts, public.devices,
            public.rate_cards, public.tables, public.settings, public.staff restart identity cascade;
          set session_replication_role = origin;
        `);
        await pg.exec(REFERENCE_SQL);
        await pg.exec(`update public.settings set terminal_device_id = 'DEVICE_TEST'`);
        const [s1, s2] = (
          await pg.query<{ id: string }>(
            `insert into public.staff (name, pin_hash, role) values
               ('Sam Staff', '${STAFF_HASH}', 'staff'), ('Mia Manager', '${MANAGER_HASH}', 'manager')
             returning id`,
          )
        ).rows;
        const dev = "00000000-0000-4000-8000-000000000001";
        h.staff = {
          actor: { staffId: s1.id, name: "Sam Staff", role: "staff", deviceId: dev, deviceLabel: "Counter" },
          managerActor: { staffId: s2.id, name: "Mia Manager", role: "manager", deviceId: dev, deviceLabel: "Counter" },
          manager: { id: s2.id, name: "Mia Manager" },
        };
        const t = await pg.query<{ id: string; name: string }>(`select id, name from public.tables`);
        tableIds.clear();
        for (const r of t.rows) tableIds.set(r.name, r.id);
      } finally {
        await pg.exec("reset role");
        await pg.exec("set role timer_app");
      }
      gateway.reset();
    },
  } as unknown as Harness;
  h.raw = raw;
  h.rawError = async (role, text) => {
    try {
      await raw(role, text);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { code: err.code, message: err.message ?? String(e) };
    }
    throw new Error(`expected statement to fail: ${text}`);
  };
  h.close = async () => {
    setDbForTests(undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
    await server.stop().catch(() => undefined);
    await pg.close().catch(() => undefined);
  };

  await h.reset();
  return h;
}
