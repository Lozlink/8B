import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { startSession } from "@/lib/server/sessions";
import { audit } from "@/lib/server/audit";
import { T0 } from "./helpers/util";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
});

const INSUFFICIENT_PRIVILEGE = "42501";

describe("1. migrations and reference data", () => {
  it("seeds 7 tables, the Standard rate card and default settings", async () => {
    const tables = await h.sql<{ name: string; sort_order: number }[]>`select name, sort_order from public.tables order by sort_order`;
    expect(tables.map((t) => t.name)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `Table ${n}`));

    const cards = await h.sql<
      { name: string; cents_per_hour: number; days_of_week: number[] | string; start_local: string; end_local: string }[]
    >`select name, cents_per_hour, days_of_week, start_local::text, end_local::text from public.rate_cards`;
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe("Standard");
    expect(cards[0].cents_per_hour).toBe(2500);
    expect(cards[0].start_local).toBe("00:00:00");
    expect(cards[0].end_local).toBe("24:00:00");
    const days = Array.isArray(cards[0].days_of_week) ? cards[0].days_of_week.map(Number) : String(cards[0].days_of_week);
    expect(days).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const [s] = await h.sql<
      { rounding_minutes: number; grace_minutes: number; minimum_minutes: number; timezone: string; bds: string }[]
    >`select rounding_minutes, grace_minutes, minimum_minutes, timezone, business_day_start::text as bds from public.settings`;
    expect(s).toEqual({
      rounding_minutes: 5,
      grace_minutes: 0,
      minimum_minutes: 30,
      timezone: "Australia/Sydney",
      bds: "06:00:00",
    });
  });

  it("reference migration is idempotent", async () => {
    const { REFERENCE_SQL } = await import("./helpers/harness");
    await h.pg.exec("reset role");
    await h.pg.exec(REFERENCE_SQL);
    await h.pg.exec("set role timer_app");
    const [c] = await h.sql<{ t: number; r: number }[]>`
      select (select count(*)::int from public.tables) t, (select count(*)::int from public.rate_cards) r`;
    expect(c).toEqual({ t: 7, r: 1 });
  });

  it("has no realtime schema (intentional)", async () => {
    const rows = await h.raw(null, "select to_regnamespace('realtime') as ns");
    expect(rows[0].ns).toBeNull();
  });
});

describe("2. audit_log is append-only", () => {
  async function seedAudit(): Promise<void> {
    await audit(h.sql, { actorStaffId: h.staff.actor.staffId, deviceLabel: "Counter", action: "test.seed", entity: "test", entityId: "1" });
  }

  it("timer_app can INSERT and SELECT", async () => {
    await seedAudit();
    const rows = await h.sql`select * from public.audit_log where action = 'test.seed'`;
    expect(rows).toHaveLength(1);
  });

  for (const role of [null, "timer_app", "service_role"]) {
    const label = role ?? "superuser";
    it(`${label}: UPDATE fails`, async () => {
      await seedAudit();
      const e = await h.rawError(role, "update public.audit_log set reason = 'tampered'");
      expect(e.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
    it(`${label}: DELETE fails`, async () => {
      await seedAudit();
      const e = await h.rawError(role, "delete from public.audit_log");
      expect(e.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
    it(`${label}: TRUNCATE fails`, async () => {
      await seedAudit();
      const e = await h.rawError(role, "truncate public.audit_log");
      expect(e.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  }

  it("superuser failure comes from the trigger (not just missing privileges)", async () => {
    await seedAudit();
    const e = await h.rawError(null, "delete from public.audit_log");
    expect(e.message).toMatch(/append-only/);
    const t = await h.rawError(null, "truncate public.audit_log");
    expect(t.message).toMatch(/append-only/);
    const u = await h.rawError(null, "update public.audit_log set reason = 'x'");
    expect(u.message).toMatch(/append-only/);
  });

  it("rows survive every attempt", async () => {
    await seedAudit();
    await h.rawError(null, "delete from public.audit_log");
    await h.rawError("timer_app", "truncate public.audit_log");
    const [c] = await h.sql<{ n: number }[]>`select count(*)::int n from public.audit_log`;
    expect(c.n).toBe(1);
  });
});

describe("3. sessions and intervals are never deleted", () => {
  const roles = [null, "timer_app", "service_role", "anon", "authenticated"];

  for (const role of roles) {
    const label = role ?? "superuser";
    it(`${label}: DELETE/TRUNCATE on sessions, session_intervals and terminal_checkouts fail`, async () => {
      const { sessionId } = await startSession(h.staff.actor, h.tableId("Table 1"), T0);
      await h.sql`
        insert into public.terminal_checkouts (id, session_id, attempt, amount_cents, status)
        values ('chk_x', ${sessionId}, 1, 100, 'PENDING')`;
      for (const stmt of [
        "delete from public.sessions",
        "truncate public.sessions cascade",
        "delete from public.session_intervals",
        "truncate public.session_intervals cascade",
        "delete from public.terminal_checkouts",
      ]) {
        const e = await h.rawError(role, stmt);
        expect(e.code, `${label}: ${stmt}`).toBe(INSUFFICIENT_PRIVILEGE);
      }
      // A plain TRUNCATE is refused too (FK references, or privilege), whichever check fires first.
      for (const stmt of ["truncate public.sessions", "truncate public.session_intervals"]) {
        const e = await h.rawError(role, stmt);
        expect(["42501", "0A000"], `${label}: ${stmt}`).toContain(e.code);
      }
      const [c] = await h.sql<{ s: number; i: number; c: number }[]>`
        select (select count(*)::int from public.sessions) s,
               (select count(*)::int from public.session_intervals) i,
               (select count(*)::int from public.terminal_checkouts) c`;
      expect(c).toEqual({ s: 1, i: 1, c: 1 });
    });
  }

  it("superuser failure comes from the trigger", async () => {
    await startSession(h.staff.actor, h.tableId("Table 1"), T0);
    const e = await h.rawError(null, "delete from public.sessions");
    expect(e.message).toMatch(/never deleted/);
    const i = await h.rawError(null, "delete from public.session_intervals");
    expect(i.message).toMatch(/never deleted/);
  });
});

describe("4. anon / authenticated are locked out", () => {
  const tables: Record<string, string> = { sessions: "note", audit_log: "reason", staff: "name" };
  for (const role of ["anon", "authenticated"]) {
    for (const [t, col] of Object.entries(tables)) {
      it(`${role} cannot SELECT/INSERT/UPDATE ${t}`, async () => {
        await startSession(h.staff.actor, h.tableId("Table 1"), T0);
        for (const stmt of [`select * from public.${t}`, `insert into public.${t} default values`, `update public.${t} set ${col} = null`]) {
          const e = await h.rawError(role, stmt);
          expect(e.code, `${role}: ${stmt}`).toBe(INSUFFICIENT_PRIVILEGE);
        }
      });
    }
  }

  it("RLS alone denies anon even if a table grant leaked", async () => {
    await startSession(h.staff.actor, h.tableId("Table 1"), T0);
    await h.pg.exec("reset role");
    await h.pg.exec("grant select on public.sessions, public.staff to anon");
    try {
      const sessions = await h.raw("anon", "select * from public.sessions");
      const staff = await h.raw("anon", "select * from public.staff");
      expect(sessions).toHaveLength(0);
      expect(staff).toHaveLength(0);
    } finally {
      await h.pg.exec("reset role");
      await h.pg.exec("revoke select on public.sessions, public.staff from anon");
      await h.pg.exec("set role timer_app");
    }
  });

  it("timer_app has no DELETE anywhere", async () => {
    for (const t of ["staff", "devices", "tables", "rate_cards", "settings", "sessions", "session_intervals", "terminal_checkouts", "webhook_events", "audit_log", "login_attempts"]) {
      const e = await h.rawError("timer_app", `delete from public.${t}`);
      expect(e.code, t).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });
});

describe("5. broadcast trigger cannot break writes", () => {
  it("writes to every broadcast-triggering table succeed without a realtime schema", async () => {
    const { sessionId } = await startSession(h.staff.actor, h.tableId("Table 3"), T0);
    await h.sql`update public.sessions set note = 'hello' where id = ${sessionId}`;
    await h.sql`update public.tables set sort_order = sort_order where name = 'Table 1'`;
    await h.sql`update public.rate_cards set priority = 1`;
    await h.sql`update public.settings set grace_minutes = 0`;
    await h.sql`
      insert into public.terminal_checkouts (id, session_id, attempt, amount_cents, status)
      values ('chk_b', ${sessionId}, 1, 100, 'PENDING')`;
    const [s] = await h.sql<{ note: string }[]>`select note from public.sessions where id = ${sessionId}`;
    expect(s.note).toBe("hello");
  });
});

describe("18. webhook_events idempotency", () => {
  it("rejects a duplicate event_id with a unique violation", async () => {
    await h.sql`insert into public.webhook_events (event_id, type) values ('evt_1', 'terminal.checkout.updated')`;
    await expect(
      h.sql`insert into public.webhook_events (event_id, type) values ('evt_1', 'terminal.checkout.updated')`,
    ).rejects.toMatchObject({ code: "23505" });
    const [c] = await h.sql<{ n: number }[]>`select count(*)::int n from public.webhook_events`;
    expect(c.n).toBe(1);
  });

  it("a duplicate inside a transaction aborts the whole transaction", async () => {
    await h.sql`insert into public.webhook_events (event_id, type) values ('evt_2', 't')`;
    await expect(
      h.sql.begin(async (tx) => {
        await tx`insert into public.audit_log (action, entity) values ('x', 'y')`;
        await tx`insert into public.webhook_events (event_id, type) values ('evt_2', 't')`;
      }),
    ).rejects.toMatchObject({ code: "23505" });
    const [c] = await h.sql<{ n: number }[]>`select count(*)::int n from public.audit_log where action = 'x'`;
    expect(c.n).toBe(0);
  });
});
