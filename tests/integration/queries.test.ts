import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import {
  applyWebhookCheckout,
  chargeCard,
  markPaid,
  pauseSession,
  releaseTable,
  resumeSession,
  startSession,
  stopSession,
  transferSession,
  voidSession,
} from "@/lib/server/sessions";
import { withTx } from "@/lib/server/db";
import { getAudit, getFloor, getSessionDetail, getSummary, getUnpaid } from "@/lib/server/queries";
import { at, awaitingPayment } from "./helpers/util";

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
afterEach(() => {
  vi.useRealTimers();
});

/** Freezes only Date (timers stay real so the DB socket keeps working). */
const freeze = (d: Date) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(d);
};

// Business day 2026-11-20 runs 06:00 -> 06:00 Sydney (UTC+11).
const local = (iso: string) => new Date(`${iso}+11:00`);

describe("getFloor", () => {
  it("returns tables, occupying sessions, off-table unpaid count, pricing and pairing", async () => {
    const { actor } = h.staff;
    const run = await startSession(actor, h.tableId("Table 1"), at(0));
    const bill = await awaitingPayment(h, "Table 2", 60); // stays on Table 2
    const offTable = await awaitingPayment(h, "Table 3", 60);
    await releaseTable(actor, offTable);

    const f = await getFloor();
    expect(f.tables).toHaveLength(7);
    expect(f.tables.map((t) => t.name)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `Table ${n}`));
    expect(f.sessions.map((s) => s.id).sort()).toEqual([run.sessionId, bill].sort());
    const running = f.sessions.find((s) => s.id === run.sessionId);
    expect(running).toMatchObject({ status: "running", currentTableId: h.tableId("Table 1"), openedByName: "Sam Staff" });
    expect(running?.intervals).toHaveLength(1);
    expect(running?.intervals[0]).toMatchObject({ tableName: "Table 1", endedAt: null });
    const billed = f.sessions.find((s) => s.id === bill);
    expect(billed).toMatchObject({ status: "awaiting_payment", totalCents: 2500, billedMinutes: 60 });
    expect(f.unpaidOffTableCount).toBe(1);
    expect(f.pricing.rateCards).toHaveLength(1);
    expect(f.pricing.rateCards[0]).toMatchObject({ centsPerHour: 2500, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1440 });
    expect(f.pricing.settings).toMatchObject({ roundingMinutes: 5, minimumMinutes: 30, timezone: "Australia/Sydney" });
    expect(f.terminalPaired).toBe(true);
    expect(new Date(f.serverTime).getTime()).not.toBeNaN();
  });

  it("terminalPaired is false without a device, and the latest checkout rides along", async () => {
    await h.sql`update public.settings set terminal_device_id = null`;
    expect((await getFloor()).terminalPaired).toBe(false);
    await h.sql`update public.settings set terminal_device_id = 'D'`;
    const id = await awaitingPayment(h, "Table 1", 60);
    await chargeCard(h.staff.actor, id);
    const f = await getFloor();
    expect(f.sessions[0].checkout).toMatchObject({ id: "chk_1", attempt: 1, amountCents: 2500, status: "PENDING" });
  });

  it("hides inactive tables unless they are occupied", async () => {
    const { actor } = h.staff;
    await startSession(actor, h.tableId("Table 7"), at(0));
    await h.sql`update public.tables set active = false where name in ('Table 7', 'Table 6')`;
    const names = (await getFloor()).tables.map((t) => t.name);
    expect(names).toContain("Table 7");
    expect(names).not.toContain("Table 6");
  });

  it("empty floor", async () => {
    const f = await getFloor();
    expect(f.sessions).toEqual([]);
    expect(f.unpaidOffTableCount).toBe(0);
  });
});

describe("getUnpaid", () => {
  it("lists every awaiting-payment bill, on or off a table, oldest first", async () => {
    const a = await awaitingPayment(h, "Table 1", 60);
    await releaseTable(h.staff.actor, a);
    const b = await awaitingPayment(h, "Table 2", 45);
    const c = await awaitingPayment(h, "Table 3", 30);
    await markPaid(h.staff.actor, c, "cash", { cardConfirmed: false }, at(40));
    const u = await getUnpaid();
    expect(u.timezone).toBe("Australia/Sydney");
    expect(u.sessions.map((s) => s.id).sort()).toEqual([a, b].sort());
    expect(u.sessions.find((s) => s.id === a)?.currentTableId).toBeNull();
  });
});

describe("getSessionDetail", () => {
  it("prices a running session live and orders the audit trail oldest first", async () => {
    const { actor } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    await pauseSession(actor, sessionId, at(20));
    await resumeSession(actor, sessionId, at(30));
    freeze(at(55)); // 20 + 25 = 45 min live
    const d = await getSessionDetail(sessionId);
    expect(d.session.status).toBe("running");
    expect(d.breakdown).toMatchObject({ billedMinutes: 45, totalCents: 1875 });
    expect(d.audit.map((a) => a.action)).toEqual(["session.start", "session.pause", "session.resume"]);
    expect(d.audit[0]).toMatchObject({ actorName: "Sam Staff", deviceLabel: "Counter", entity: "session", entityId: sessionId });
    expect(d.checkouts).toEqual([]);
  });

  it("after stop, prices from the snapshot even if rates change later", async () => {
    const { actor } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    await transferSession(actor, sessionId, h.tableId("Table 2"), at(30));
    await stopSession(actor, sessionId, at(60));
    await h.sql`update public.rate_cards set cents_per_hour = 9900`;
    freeze(at(500));
    const d = await getSessionDetail(sessionId);
    expect(d.breakdown).toMatchObject({ billedMinutes: 60, totalCents: 2500 });
    expect(d.breakdown?.gstCents).toBe(227); // GST-inclusive: 2500 / 11 = 227.27
    expect(d.breakdown?.lines.length).toBeGreaterThan(0);
    expect(d.session.intervals.map((i) => i.tableName)).toEqual(["Table 1", "Table 2"]);
    expect(d.audit.map((a) => a.action)).toEqual(["session.start", "session.transfer", "session.stop"]);
  });

  it("voided no-charge sessions still show a breakdown from their snapshot; unknown ids are 404", async () => {
    const { sessionId } = await startSession(h.staff.actor, h.tableId("Table 1"), at(0));
    await stopSession(h.staff.actor, sessionId, at(0));
    const d = await getSessionDetail(sessionId);
    expect(d.session.status).toBe("void");
    expect(d.breakdown?.totalCents).toBe(0);
    await expect(getSessionDetail("nope")).rejects.toMatchObject({ status: 404 });
    await expect(getSessionDetail("00000000-0000-4000-8000-0000000000ff")).rejects.toMatchObject({ status: 404 });
  });

  it("includes the checkouts and the bill's checkout events", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "COMPLETED", referenceId: id, cancelReason: null }));
    const d = await getSessionDetail(id);
    expect(d.checkouts).toHaveLength(1);
    expect(d.checkouts[0].status).toBe("COMPLETED");
    expect(d.session).toMatchObject({ status: "paid", settledMethod: "card", settledVia: "square_webhook", settledByName: null });
    expect(d.audit.map((a) => a.action)).toEqual(["session.start", "session.stop", "checkout.sent", "session.paid"]);
  });
});

describe("getAudit", () => {
  async function seed(): Promise<string> {
    const id = await awaitingPayment(h, "Table 1", 60); // start, stop
    await chargeCard(h.staff.actor, id); // checkout.sent
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(70)); // cancel_requested, canceled, mark_paid
    return id;
  }

  it("returns newest first and filters by entity, entityId and action prefix", async () => {
    const id = await seed();
    const all = await getAudit({});
    const ids = all.entries.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(all.nextBefore).toBeNull();

    expect((await getAudit({ entity: "session", entityId: id })).entries.length).toBe(all.entries.length);
    expect((await getAudit({ entity: "device" })).entries).toEqual([]);
    expect((await getAudit({ entityId: "nothing" })).entries).toEqual([]);

    const sessionActions = await getAudit({ action: "session." });
    expect(sessionActions.entries.map((e) => e.action).sort()).toEqual(["session.mark_paid", "session.start", "session.stop"]);
    const checkout = await getAudit({ action: "checkout" });
    expect(checkout.entries.every((e) => e.action.startsWith("checkout"))).toBe(true);
    expect(checkout.entries.length).toBeGreaterThan(0);
    // LIKE wildcards in input are literal, never wildcards
    for (const a of ["%", "session%", "_ession.", "session_start", "\\"]) {
      expect((await getAudit({ action: a })).entries, a).toEqual([]);
    }

    const exact = await getAudit({ actions: ["session.start", "session.stop"] });
    expect(exact.entries).toHaveLength(2);
  });

  it("resolves actor and approver names", async () => {
    const id = await awaitingPayment(h);
    await voidSession(h.staff.managerActor, h.staff.manager, id, "Comped", at(70));
    const [v] = (await getAudit({ action: "session.void" })).entries;
    expect(v).toMatchObject({ actorName: "Mia Manager", approvedByName: "Mia Manager", reason: "Comped" });
  });

  it("paginates with before / nextBefore", async () => {
    await seed();
    const total = (await getAudit({})).entries.length;
    expect(total).toBeGreaterThanOrEqual(5);
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    for (;;) {
      const p = await getAudit({ limit: 2, before });
      expect(p.entries.length).toBeLessThanOrEqual(2);
      seen.push(...p.entries.map((e) => e.id));
      pages++;
      if (!p.nextBefore) break;
      expect(p.nextBefore).toBe(p.entries[p.entries.length - 1].id);
      before = p.nextBefore;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(pages).toBe(Math.ceil(total / 2));
  });

  it("filters by time window and clamps limit", async () => {
    await seed();
    const far = new Date(Date.now() + 86_400_000);
    expect((await getAudit({ from: far })).entries).toEqual([]);
    expect((await getAudit({ to: new Date(0) })).entries).toEqual([]);
    expect((await getAudit({ from: new Date(0), to: far })).entries.length).toBeGreaterThan(0);
    expect((await getAudit({ limit: 0 })).entries).toHaveLength(1);
    expect((await getAudit({ before: "abc" })).entries.length).toBeGreaterThan(0); // non-numeric ignored
  });

  it("round-trips before/after as real JSON objects", async () => {
    const id = await awaitingPayment(h);
    const [stop] = (await getAudit({ entityId: id, action: "session.stop" })).entries;
    expect(typeof stop.after).toBe("object");
    expect(stop.after).toMatchObject({ status: "awaiting_payment", total_cents: 2500 });
    expect(typeof stop.before).toBe("object");
  });
});

describe("getSummary", () => {
  async function seedDay(): Promise<Record<string, string>> {
    const { actor, managerActor, manager } = h.staff;
    const out: Record<string, string> = {};
    const run = async (name: string, table: string, from: string, to: string) => {
      const s = await startSession(actor, h.tableId(table), local(from));
      await stopSession(actor, s.sessionId, local(to));
      out[name] = s.sessionId;
    };
    // Belongs to the PREVIOUS business day (stopped 05:50, before the 06:00 cut-over): $20.83 cash.
    await run("prev", "Table 1", "2026-11-20T05:00:00", "2026-11-20T05:50:00");
    await markPaid(actor, out.prev, "cash", { cardConfirmed: false }, local("2026-11-20T05:55:00"));
    // On 20 Nov: stopped 07:10 exactly 60 min = $25.00, paid card by staff.
    await run("card", "Table 2", "2026-11-20T06:10:00", "2026-11-20T07:10:00");
    await markPaid(actor, out.card, "card", { cardConfirmed: true }, local("2026-11-20T07:12:00"));
    // Closed exactly at 06:00:00 is inside the new window; 60 min cash.
    await run("cash", "Table 3", "2026-11-20T05:00:00", "2026-11-20T06:00:00");
    await markPaid(actor, out.cash, "cash", { cardConfirmed: false }, local("2026-11-20T06:00:00"));
    // After midnight, still 20 Nov's business day: 45 min = $18.75 left unpaid.
    await run("late", "Table 4", "2026-11-21T01:00:00", "2026-11-21T01:45:00");
    // Void with reason.
    await run("void", "Table 5", "2026-11-20T09:00:00", "2026-11-20T09:20:00");
    await voidSession(managerActor, manager, out.void, "Customer walked out", local("2026-11-20T09:30:00"));
    // Starts the NEXT business day (06:30 on the 21st): not in this window.
    await run("next", "Table 6", "2026-11-21T06:30:00", "2026-11-21T07:30:00");
    return out;
  }

  it("splits card/cash, lists unpaid and voids, and respects the 06:00 cut-over", async () => {
    const s = await seedDay();
    const sum = await getSummary("2026-11-20");
    expect(sum.businessDate).toBe("2026-11-20");
    expect(sum.from).toBe(local("2026-11-20T06:00:00").toISOString());
    expect(sum.to).toBe(local("2026-11-21T06:00:00").toISOString());

    // closed in window, non-void: card (2500) + cash@06:00 (2500) + late (1875) = 3 sessions, 130 min
    expect(sum.sessions).toEqual({ count: 3, billedMinutes: 60 + 60 + 45, billedCents: 2500 + 2500 + 1875 });
    // Paid in window: the 05:55 cash sale is the previous day's.
    expect(sum.paid.card).toEqual({ count: 1, cents: 2500 });
    expect(sum.paid.cash).toEqual({ count: 1, cents: 2500 });
    expect(sum.paidItems.map((p) => [p.id, p.method, p.via, p.settledByName])).toEqual([
      [s.cash, "cash", "staff", "Sam Staff"],
      [s.card, "card", "staff", "Sam Staff"],
    ]);
    expect(sum.paidItems.find((p) => p.id === s.card)).toMatchObject({ tableNames: "Table 2", totalCents: 2500, billedMinutes: 60 });

    expect(sum.unpaid.count).toBe(1);
    expect(sum.unpaid.cents).toBe(1875);
    expect(sum.unpaid.items[0]).toMatchObject({ id: s.late, tableNames: "Table 4" });
    expect(sum.outstandingOlder).toEqual({ count: 0, cents: 0 });

    expect(sum.voids.count).toBe(1);
    expect(sum.voids.items[0]).toMatchObject({ id: s.void, reason: "Customer walked out", voidedByName: "Mia Manager" });

    // previous business day carries the 05:50 session
    const prev = await getSummary("2026-11-19");
    expect(prev.sessions).toEqual({ count: 1, billedMinutes: 50, billedCents: 2083 });
    expect(prev.paid.cash).toEqual({ count: 1, cents: 2083 });
    expect(prev.paid.card.count).toBe(0);

    // and the following day carries the 06:30 session, plus yesterday's unpaid as "older"
    const next = await getSummary("2026-11-21");
    expect(next.sessions.count).toBe(1);
    expect(next.unpaid.count).toBe(1);
    expect(next.outstandingOlder).toEqual({ count: 1, cents: 1875 });
  });

  it("defaults to the current business date (before 06:00 it is still yesterday)", async () => {
    freeze(local("2026-11-21T03:00:00"));
    expect((await getSummary(null)).businessDate).toBe("2026-11-20");
    freeze(local("2026-11-21T06:00:00"));
    expect((await getSummary(null)).businessDate).toBe("2026-11-21");
    freeze(local("2026-11-21T05:59:59"));
    expect((await getSummary(null)).businessDate).toBe("2026-11-20");
  });

  it("rejects a malformed date", async () => {
    await expect(getSummary("20/11/2026")).rejects.toMatchObject({ status: 400 });
  });

  it("attention surfaces payment.conflict, reversals and cancel failures", async () => {
    const { actor, managerActor, manager } = h.staff;
    // cash while a card request is out, then the card completes anyway
    const id = await awaitingPayment(h, "Table 1", 60);
    await chargeCard(actor, id);
    await markPaid(actor, id, "cash", { cardConfirmed: false }, at(70));
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "COMPLETED", referenceId: id, cancelReason: null }));
    const other = await awaitingPayment(h, "Table 2", 60);
    await markPaid(actor, other, "cash", { cardConfirmed: false }, at(70));
    await (await import("@/lib/server/sessions")).reversePaid(managerActor, manager, other, "Wrong amount keyed");

    // audit.at is the DB clock, so use the real current business date for this one
    const { currentBusinessDate, formatYMD } = await import("@/lib/domain/business-day");
    const settings = await h.sql<{ m: string }[]>`select business_day_start::text as m from public.settings`;
    const [hh, mm] = settings[0].m.split(":").map(Number);
    const date = formatYMD(currentBusinessDate(new Date(), hh * 60 + mm, "Australia/Sydney"));
    const sum = await getSummary(date);
    const actions = sum.attention.map((a) => a.action);
    expect(actions).toContain("payment.conflict");
    expect(actions).toContain("session.reverse_paid");
    expect(sum.attention.find((a) => a.action === "payment.conflict")?.reason).toMatch(/cash/i);
  });
});
