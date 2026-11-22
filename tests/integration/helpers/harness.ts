import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { hashSync } from "bcryptjs";
import { setDbForTests } from "@/lib/server/db";
import type { Actor, Manager } from "@/lib/server/auth";
import { setCatalogGatewayForTests } from "@/lib/server/items";
import { setTerminalGatewayForTests } from "@/lib/server/sessions";
import { setPaymentsGatewayForTests } from "@/lib/server/payment-ref";
import { setPosGatewayForTests } from "@/lib/server/pos-cash";
import { setCashGatewayForTests } from "@/lib/server/square-cash";
import { setStockGatewayForTests } from "@/lib/server/stock";
import { FakeCatalog, FakeGateway, FakeStock } from "./fake-gateway";

// Server env the admin/queries modules read lazily (never contacts Square).
const TEST_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  SESSION_SECRET: "test-session-secret-test-session-secret",
  DEVICE_ENROL_CODE: "test-enrol-code-123456",
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_ACCESS_TOKEN: "test-token",
  SQUARE_LOCATION_ID: "LOC_TEST",
  SQUARE_APPLICATION_ID: "sq0idp-test-app",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "test-key",
  SQUARE_WEBHOOK_URL: "https://example.test/api/square/webhook",
};
for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] ??= v;

const MIGRATIONS = resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(resolve(MIGRATIONS, f), "utf8");

export const INIT_SQL = read("20261116000000_init.sql");
export const REFERENCE_SQL = read("20261116000100_reference_data.sql");
export const SESSION_ITEMS_SQL = read("20261117000000_session_items.sql");
export const SQUARE_CASH_SQL = read("20261118000000_square_cash.sql");
export const CHECKOUT_BROADCAST_SQL = read("20261118000100_checkout_broadcast.sql");
export const BILL_EXTRAS_SQL = read("20261119000000_bill_extras.sql");
export const STOCK_SQL = read("20261121000000_stock_and_barcodes.sql");
export const PRODUCT_IMAGES_SQL = read("20261121000100_product_images.sql");
export const NAMES_COSTS_CLOSE_SQL = read("20261123000000_names_costs_day_close.sql");

/** What Supabase provides out of the box. There is deliberately no `realtime` schema. */
export const PRELUDE_SQL = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema extensions;
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`;

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
  /** Stand-in for the Square catalogue. */
  catalog: FakeCatalog;
  /** Stand-in for Square's stock counts and inventory adjustments. */
  stock: FakeStock;
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

  await pg.exec(PRELUDE_SQL);
  await pg.exec(INIT_SQL);
  await pg.exec(REFERENCE_SQL);
  // Later migrations run against a database that already holds the reference data, as in production.
  await pg.exec(SESSION_ITEMS_SQL);
  await pg.exec(SQUARE_CASH_SQL);
  await pg.exec(CHECKOUT_BROADCAST_SQL);
  // One transaction, as the Supabase CLI runs a migration file (`set local` needs one).
  await pg.exec(`begin;\n${BILL_EXTRAS_SQL}\ncommit;`);
  await pg.exec(`begin;\n${STOCK_SQL}\ncommit;`);
  await pg.exec(`begin;\n${PRODUCT_IMAGES_SQL}\ncommit;`);
  await pg.exec(`begin;\n${NAMES_COSTS_CLOSE_SQL}\ncommit;`);

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
  setCashGatewayForTests(gateway);
  setPosGatewayForTests(gateway);
  // Refunds, receipt reprints and the payment id of a completed checkout.
  setPaymentsGatewayForTests(gateway);
  const catalog = new FakeCatalog();
  setCatalogGatewayForTests(catalog);
  const stock = new FakeStock(gateway);
  setStockGatewayForTests(stock);

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
    catalog,
    stock,
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
          truncate public.audit_log, public.webhook_events, public.refunds, public.stock_moves, public.square_cash_records, public.terminal_checkouts,
            public.session_items, public.session_intervals, public.sessions, public.products, public.discounts, public.login_attempts, public.devices,
            public.rate_cards, public.tables, public.settings, public.staff restart identity cascade;
          update public.catalog_state set synced_at = null, table_hire_variation_id = null, last_error = null,
            stock_synced_at = null, stock_error = null, tax_warning = null, stock_from = '2000-01-01';
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
      catalog.reset();
      stock.reset();
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
