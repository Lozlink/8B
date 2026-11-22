import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { at, auditActions, audits, awaitingPayment, seedDiscount, seedProduct } from "./helpers/util";
import { withTx } from "@/lib/server/db";
import type { Manager } from "@/lib/server/auth";
import { closeDay, DEFAULT_FLOAT_CENTS, DENOMINATIONS, getDayCloseState, hasMoved, listDayCloses, totalsOf, type CloseDayInput } from "@/lib/server/day-close";
import { getSummary, parseYMD } from "@/lib/server/queries";
import { refundSession } from "@/lib/server/refunds";
import {
  addCustomItem,
  addItem,
  applyWebhookCheckout,
  chargeCard,
  markPaid,
  mergeBack,
  openCounterSale,
  pauseSession,
  reversePaid,
  setDetails,
  setDiscount,
  splitBill,
  startSession,
  voidSession,
} from "@/lib/server/sessions";
import { pushCashRecords } from "@/lib/server/square-cash";
import type { DayCloseTotals } from "@/lib/domain/types";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});

const syd = (iso: string) => new Date(`${iso}+11:00`);
/** Freezes only Date, so the server's idea of "now" is fixed while the DB socket keeps working. */
const freeze = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(syd(iso));
};

beforeEach(async () => {
  await h.reset();
  // Business day 2026-11-20 (06:00 -> 06:00 Sydney) is the day running now, and T0 (10:00) is in it.
  freeze("2026-11-20T22:00:00");
  await seedProduct(h, { id: "BEER", name: "Beer", priceCents: 1100 });
  await seedProduct(h, { id: "COKE", name: "Coke", priceCents: 450 });
  const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from public.day_closes`;
  expect(n, "day_closes starts empty").toBe(0);
});
afterEach(() => {
  vi.useRealTimers();
});

const DAY = "2026-11-20";
const A = () => h.staff.actor;
const MGR = () => h.staff.manager;

const close = (over: Partial<CloseDayInput> = {}, manager: Manager | null = null) =>
  closeDay(A(), manager, { date: null, floatCents: 20_000, countedCashCents: 20_000, ...over });
// A different count from `close()`'s default, so it is a new close and not a repeat of the same request.
const closeAgain = (over: Partial<CloseDayInput> = {}) => close({ countedCashCents: 20_050, reason: "Late sale", ...over }, MGR());
/** Makes the latest close look `minutes` old (the table is append-only, so this is test setup done as the owner with triggers off). */
async function ageCloses(minutes: number): Promise<void> {
  const when = new Date(Date.now() - minutes * 60_000).toISOString();
  await h.raw(null, `set session_replication_role = replica`);
  try {
    await h.raw(null, `update public.day_closes set closed_at = '${when}'`);
  } finally {
    await h.raw(null, `set session_replication_role = origin`);
  }
}

const state = (date: string | null = null) => getDayCloseState(date);
const rows = () =>
  h.sql<{ id: string; business_date: string; seq: number; approved_by: string | null; reason: string | null; note: string | null; totals: DayCloseTotals; cash_counts: unknown }[]>`
    select id, business_date::text, seq, approved_by, reason, note, totals, cash_counts from public.day_closes order by business_date, seq`;
const auditCount = async (action: string) =>
  (await h.sql<{ n: number }[]>`select count(*)::int as n from public.audit_log where action = ${action}`)[0].n;
const nothingWritten = async () => {
  expect(await rows()).toHaveLength(0);
  expect(await auditCount("day.close")).toBe(0);
  expect(await auditCount("day.close_again")).toBe(0);
};
const rejects = (p: Promise<unknown>, match: Record<string, unknown>) => expect(p).rejects.toMatchObject(match);

/** A table bill for `minutes` (60 = $25.00) paid in cash. Returns the bill's id. */
async function cashBill(table = "Table 1", minutes = 60): Promise<string> {
  const id = await awaitingPayment(h, table, minutes);
  await markPaid(A(), id, "cash", { cardConfirmed: false }, at(minutes + 1));
  return id;
}
/** A counter sale of one custom charge, paid by card on the Terminal. */
async function cardBill(cents: number): Promise<string> {
  const { sessionId: id } = await openCounterSale(A(), at(5));
  await addCustomItem(A(), id, "Card item", cents);
  const out = await chargeCard(A(), id);
  if (out.kind !== "sent") throw new Error("expected the charge to be sent");
  const paymentId = h.gateway.cardPaymentFor(out.checkoutId);
  await withTx((tx) => applyWebhookCheckout(tx, { id: out.checkoutId, status: "COMPLETED", referenceId: id, cancelReason: null, amountCents: null, paymentIds: [paymentId] }));
  return id;
}
/** Refunds happen "now" by the database's clock; put it inside the business day under test. */
async function refund(id: string, cents: number): Promise<void> {
  await refundSession(A(), MGR(), id, "Customer left early", cents);
  await h.raw(null, `update public.refunds set created_at = '${at(90).toISOString()}' where session_id = '${id}'`);
}

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

describe("the day's figures", () => {
  it("are what a person adds up by hand for a day with every kind of bill, and they are what a close keeps", async () => {
    await seedDiscount(h, { id: "D10", name: "Ten off", kind: "percent", value: 1000 });
    const { actor, manager } = h.staff;

    // A: 60 min + Coke, cash.                                2500 + 450 = 2950
    const a = await awaitingPayment(h, "Table 1", 60);
    await addItem(actor, a, "COKE", 1);
    await markPaid(actor, a, "cash", { cardConfirmed: false }, at(61));
    // B: 90 min with 10% off, left unpaid.                   3750 - 375 = 3375
    const b = await awaitingPayment(h, "Table 2", 90);
    await setDiscount(actor, manager, b, { discountId: "D10" });
    // C: a counter sale of $11.00, paid by card.
    const c = await cardBill(1100);
    // D: 60 min split two ways; the share is paid in cash.   parent 1250 + share 1250
    const d = await awaitingPayment(h, "Table 3", 60);
    const { partIds: dParts } = await splitBill(actor, d, { ways: 2 }, at(61));
    await markPaid(actor, dParts[0], "cash", { cardConfirmed: false }, at(62));
    // E: 60 min with a $10 share that a manager wrote off.   parent 1500 + 1000 written off
    const e = await awaitingPayment(h, "Table 4", 60);
    const { partIds: eParts } = await splitBill(actor, e, { amountCents: 1000 }, at(61));
    await voidSession(actor, manager, eParts[0], "Walked out", at(62));
    // F: a void table bill.
    const f = await awaitingPayment(h, "Table 5", 60);
    await voidSession(actor, manager, f, "Opened by mistake", at(62));
    // G: a share merged back into its bill is nobody's write-off.
    const g = await awaitingPayment(h, "Table 6", 60);
    const { partIds: gParts } = await splitBill(actor, g, { ways: 2 }, at(61));
    await mergeBack(actor, gParts[0], at(62));
    void [d, e, f];

    // A $5 cash refund on A (its sale has to be in Square first) and a $3 card refund on C.
    await pushCashRecords();
    await refund(a, 500);
    await refund(c, 300);

    const expected: DayCloseTotals = {
      sessionCount: 6, // A B C D E G: parts are shares of those, F is void
      billedMinutes: 60 + 90 + 0 + 60 + 60 + 60,
      billedCents: 2950 + 3375 + 1100 + (1250 + 1250) + 1500 + 2500,
      tableCents: 2500 + 3750 + 2500 + 2500 + 2500,
      itemsCents: 450 + 1100,
      discountCents: 375,
      writtenOffCents: 1000,
      cardCount: 1,
      cardCents: 1100,
      cashCount: 2,
      cashCents: 2950 + 1250,
      cashRoundingCents: 0,
      refundCount: 2,
      refundCents: 800,
      refundCardCents: 300,
      refundCashCents: 500,
      takingsCents: 1100 + 2950 + 1250 - 800,
      unpaidCount: 4, // B, D's rest, E's rest, G
      unpaidCents: 3375 + 1250 + 1500 + 2500,
      olderUnpaidCount: 0,
      olderUnpaidCents: 0,
      voidCount: 2, // F and E's written-off share; G's merged share is not a void
    };
    const s = await state();
    expect(s.totals).toEqual(expected);
    expect(s.cashMovementCents).toBe(4200 - 500);
    expect(totalsOf(await getSummary(DAY))).toEqual(expected);

    const { close: c1 } = await close({ floatCents: 20_000, countedCashCents: 23_700 });
    expect(c1.totals).toEqual(expected);
    expect((await rows())[0].totals).toEqual(expected);
  });

  it("an empty day is all zeros and closes fine", async () => {
    const s = await state();
    expect(Object.values(s.totals).every((v) => v === 0)).toBe(true);
    expect(s.cashMovementCents).toBe(0);
    expect(s).toMatchObject({ isCurrent: true, closes: [], changedSinceClose: false, running: [], warnings: [], timezone: "Australia/Sydney" });
    expect([s.from, s.to]).toEqual(["2026-11-19T19:00:00.000Z", "2026-11-20T19:00:00.000Z"]);
    const { close: c } = await close();
    expect(c).toMatchObject({ seq: 1, expectedCashCents: 20_000, varianceCents: 0 });
  });

  it("cash is collected rounded to 5c, and the expected cash follows what was collected, not the bill", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await addCustomItem(A(), id, "Odd", 252); // 2752 -> $27.50 in cash
    await markPaid(A(), id, "cash", { cardConfirmed: false }, at(61));
    const s = await state();
    expect(s.totals).toMatchObject({ cashCents: 2750, cashRoundingCents: -2, billedCents: 2752, takingsCents: 2750 });
    const { close: c } = await close({ floatCents: 10_000, countedCashCents: 12_750 });
    expect(c).toMatchObject({ expectedCashCents: 12_750, varianceCents: 0 });
  });

  it("a bill discounted to nothing took no money and adds nothing to the drawer", async () => {
    await seedDiscount(h, { id: "D100", name: "Comp", kind: "percent", value: 10_000 });
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(A(), MGR(), id, { discountId: "D100" });
    await markPaid(A(), id, "cash", { cardConfirmed: false }, at(61));
    const s = await state();
    expect(s.totals).toMatchObject({ sessionCount: 1, billedCents: 0, cashCount: 0, cashCents: 0, takingsCents: 0, discountCents: 2500 });
  });
});

// ---------------------------------------------------------------------------
// Expected cash and variance
// ---------------------------------------------------------------------------

describe("expected cash and variance", () => {
  it("expected = float + cash taken - cash refunded; card takings and card refunds don't touch the drawer", async () => {
    const cash = await cashBill("Table 1", 60); // +2500 cash
    await cashBill("Table 2", 120); // +5000 cash
    const card = await cardBill(4000); // card only
    await pushCashRecords();
    await refund(cash, 1000); // -1000 cash
    await refund(card, 500); // card refund: not in the drawer

    const s = await state();
    expect(s.cashMovementCents).toBe(7500 - 1000);
    expect(s.totals.takingsCents).toBe(7500 + 4000 - 1500);
    const { close: c } = await close({ floatCents: 15_000, countedCashCents: 21_500 });
    expect(c).toMatchObject({ floatCents: 15_000, expectedCashCents: 15_000 + 6500, countedCashCents: 21_500, varianceCents: 0 });
  });

  it("variance is counted - expected: negative when short, positive when over", async () => {
    await cashBill();
    const short = await close({ floatCents: 20_000, countedCashCents: 22_400 }); // expected 22500
    expect(short.close).toMatchObject({ expectedCashCents: 22_500, varianceCents: -100 });
    const over = await closeAgain({ floatCents: 20_000, countedCashCents: 22_650 });
    expect(over.close).toMatchObject({ expectedCashCents: 22_500, varianceCents: 150, seq: 2 });
    const [r1, r2] = (await h.sql<{ variance_cents: number }[]>`select variance_cents from public.day_closes order by seq`).map((r) => r.variance_cents);
    expect([r1, r2]).toEqual([-100, 150]);
  });

  it("a float of zero is fine and the drawer holds only what was taken", async () => {
    await cashBill();
    const { close: c } = await close({ floatCents: 0, countedCashCents: 2500 });
    expect(c).toMatchObject({ expectedCashCents: 2500, varianceCents: 0 });
  });

  it("the stored row carries who, where and how", async () => {
    await cashBill();
    const { close: c } = await close({ note: "  quiet night  " });
    expect(c).toMatchObject({
      businessDate: DAY,
      seq: 1,
      closedByName: "Sam Staff",
      approvedByName: null,
      deviceLabel: "Counter",
      floatCents: 20_000,
      countedCashCents: 20_000,
      note: "quiet night",
      reason: null,
      cashCounts: null,
    });
    expect(c.varianceCents).toBe(-2500);
    expect(Date.parse(c.closedAt)).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Who may close, and closing again
// ---------------------------------------------------------------------------

describe("first close and closing again", () => {
  it("a first close needs no manager and no reason; a reason sent with it is not kept", async () => {
    const { close: c } = await close({ reason: "irrelevant" });
    expect(c).toMatchObject({ seq: 1, approvedByName: null, reason: null });
    expect((await rows())[0]).toMatchObject({ approved_by: null, reason: null });
  });

  it("a second close without a manager is refused (409 already_closed) and writes nothing more", async () => {
    await close();
    await rejects(close({ countedCashCents: 20_050, reason: "Late sale" }), { status: 409, code: "already_closed" });
    expect(await rows()).toHaveLength(1);
    expect(await auditCount("day.close_again")).toBe(0);
  });

  it("a second close with a manager needs a real reason (3+ characters once trimmed)", async () => {
    await close();
    for (const reason of [undefined, null, "", "   ", "ab", "  ab  "]) {
      await rejects(close({ countedCashCents: 20_050, reason }, MGR()), { status: 400 });
    }
    expect(await rows()).toHaveLength(1);
  });

  it("a second close with manager and reason adds a row; the first is untouched", async () => {
    await cashBill();
    const first = (await close({ countedCashCents: 22_500 })).close;
    const second = (await close({ floatCents: 20_000, countedCashCents: 22_400, reason: "  Counted again  " }, MGR())).close;
    expect(second).toMatchObject({ seq: 2, approvedByName: "Mia Manager", reason: "Counted again", varianceCents: -100 });
    const s = await state();
    expect(s.closes.map((c) => c.seq)).toEqual([2, 1]); // newest first
    expect(s.closes[1]).toEqual(first);
    const third = (await close({ reason: "And once more" }, MGR())).close;
    expect(third.seq).toBe(3);
  });

  it("a manager's PIN on a first close is recorded as the approver but isn't required", async () => {
    const { close: c } = await close({}, MGR());
    expect(c).toMatchObject({ seq: 1, approvedByName: "Mia Manager", reason: null });
  });

  it("each day has its own count of closes", async () => {
    freeze("2026-11-21T10:00:00"); // today is the 21st, yesterday the 20th
    await close({ date: "2026-11-20" });
    await close({ date: "2026-11-21" });
    await close({ date: "2026-11-21", countedCashCents: 20_050, reason: "Recount" }, MGR());
    const other = await close({ date: "2026-11-20", countedCashCents: 20_050, reason: "Recount" }, MGR());
    expect(other.close.seq).toBe(2);
    const dates = (await rows()).map((r) => `${r.business_date}#${r.seq}`);
    expect(dates).toEqual(["2026-11-20#1", "2026-11-20#2", "2026-11-21#1", "2026-11-21#2"]);
  });

  it("two people closing the same day at once: one wins, the other gets the unique violation (409 in the route)", async () => {
    const results = await Promise.allSettled([close({ floatCents: 20_000 }), close({ floatCents: 20_005 })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "23505", constraint_name: "day_closes_business_date_seq_key" });
    expect(await rows()).toHaveLength(1);
    expect(await auditCount("day.close")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Which day, and what blocks closing it
// ---------------------------------------------------------------------------

describe("which day", () => {
  it("no date means the day running now; before 06:00 that is still yesterday", async () => {
    freeze("2026-11-21T02:00:00");
    expect((await close()).close.businessDate).toBe("2026-11-20");
    freeze("2026-11-21T06:00:00");
    expect((await close()).close.businessDate).toBe("2026-11-21");
  });

  it("a future date is refused (400) and nothing is written, including the day that hasn't started at 02:00", async () => {
    await rejects(close({ date: "2026-11-21" }), { status: 400 });
    await rejects(close({ date: "2099-01-01" }), { status: 400 });
    freeze("2026-11-21T02:00:00"); // still the 20th's business day
    await rejects(close({ date: "2026-11-21" }), { status: 400 });
    await expect(close({ date: "2026-11-20" })).resolves.toBeTruthy();
    expect((await rows()).map((r) => r.business_date)).toEqual(["2026-11-20"]);
    expect(await auditCount("day.close")).toBe(1);
  });

  it("a date that isn't a real date is refused (400)", async () => {
    for (const date of ["2026-02-31", "2026-13-01", "20-11-2026", "2026-11-2", "yesterday"]) {
      await rejects(close({ date }), { status: 400 });
    }
    await nothingWritten();
  });

  it("an earlier day can be closed and shows only its own figures", async () => {
    await cashBill(); // 2500 on the 20th
    freeze("2026-11-21T10:00:00");
    const s = await state("2026-11-20");
    expect(s).toMatchObject({ businessDate: "2026-11-20", isCurrent: false });
    expect(s.totals.cashCents).toBe(2500);
    expect((await state()).totals.cashCents).toBe(0);
    const { close: c } = await close({ date: "2026-11-20", floatCents: 20_000, countedCashCents: 22_500 });
    expect(c).toMatchObject({ businessDate: "2026-11-20", expectedCashCents: 22_500, varianceCents: 0 });
  });

  it("an explicit date equal to today is the current day", async () => {
    expect((await state(DAY)).isCurrent).toBe(true);
    freeze("2026-11-21T10:00:00");
    expect((await state(DAY)).isCurrent).toBe(false);
    expect((await state("2026-11-21")).isCurrent).toBe(true);
  });
});

describe("tables still running", () => {
  it("a running table blocks closing the current day (409 tables_running, naming it), and nothing is written", async () => {
    const { sessionId } = await startSession(A(), h.tableId("Table 3"), at(0), { customerName: "Sam" });
    const err = await close().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "tables_running", detail: { sessionIds: [sessionId] } });
    expect((err as Error).message).toMatch(/Table 3/);
    expect((err as Error).message).toMatch(/still running/);
    await nothingWritten();
    // the same with the date spelled out
    await rejects(close({ date: DAY }), { status: 409, code: "tables_running" });
    expect((await state()).running).toEqual([{ sessionId, label: "Table 3", customerName: "Sam" }]);
  });

  it("a paused table blocks it too", async () => {
    const { sessionId } = await startSession(A(), h.tableId("Table 1"), at(0));
    await pauseSession(A(), sessionId, at(10));
    await rejects(close(), { status: 409, code: "tables_running" });
    expect((await state()).running.map((r) => r.sessionId)).toEqual([sessionId]);
  });

  it("lists every blocker's id, and says how many more than three", async () => {
    const ids: string[] = [];
    for (const t of ["Table 1", "Table 2", "Table 3", "Table 4", "Table 5"]) ids.push((await startSession(A(), h.tableId(t), at(0))).sessionId);
    const err = await close().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "tables_running" });
    expect((err as { detail: { sessionIds: string[] } }).detail.sessionIds.sort()).toEqual([...ids].sort());
    expect((err as Error).message).toMatch(/and 2 more/);
  });

  it("stopped tables (awaiting payment) don't block; they are a warning", async () => {
    await awaitingPayment(h, "Table 1", 60);
    const s = await state();
    expect(s.running).toEqual([]);
    expect(s.warnings.join(" ")).toMatch(/1 bill from this day is still unpaid \(\$25\.00\)/);
    await expect(close()).resolves.toBeTruthy();
  });

  it("an earlier day can be closed while tables are running now", async () => {
    await startSession(A(), h.tableId("Table 1"), at(0)); // started on the 20th, still running
    freeze("2026-11-21T10:00:00");
    const s = await state("2026-11-20");
    expect(s.running).toEqual([]);
    await expect(close({ date: "2026-11-20" })).resolves.toBeTruthy();
    // ...but not the day running now
    await rejects(close({ date: "2026-11-21" }), { status: 409, code: "tables_running" });
    await rejects(close(), { status: 409, code: "tables_running" });
  });

  it("closing again is blocked by a running table as well", async () => {
    await close();
    await startSession(A(), h.tableId("Table 1"), at(0));
    await rejects(closeAgain(), { status: 409, code: "tables_running" });
    expect(await rows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Checks on what staff typed
// ---------------------------------------------------------------------------

describe("amounts", () => {
  it("float and count must be whole cents ending in 0 or 5", async () => {
    for (const bad of [20_001, 20_002, 20_003, 20_004, 20_006, 20_009, 1, 3]) {
      await rejects(close({ floatCents: bad, countedCashCents: 0 }), { status: 400 });
      await rejects(close({ floatCents: 0, countedCashCents: bad }), { status: 400 });
    }
    await nothingWritten();
    await expect(close({ floatCents: 5, countedCashCents: 5 })).resolves.toBeTruthy();
  });

  it("negative, fractional, non-finite and over-limit amounts are refused", async () => {
    const bad = [-5, -1, 0.5, 200.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_005];
    for (const v of bad) await rejects(close({ floatCents: v }), { status: 400 });
    for (const v of [-5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 100_000_005]) await rejects(close({ countedCashCents: v }), { status: 400 });
    await nothingWritten();
  });

  it("the limits themselves are allowed: float $100,000 and a count of $1,000,000", async () => {
    const { close: c } = await close({ floatCents: 10_000_000, countedCashCents: 100_000_000 });
    expect(c).toMatchObject({ floatCents: 10_000_000, countedCashCents: 100_000_000, expectedCashCents: 10_000_000, varianceCents: 90_000_000 });
  });

  it("a note is trimmed, empty is nothing, 500 is the limit (refused past it, not cut)", async () => {
    expect((await close({ note: "   " })).close.note).toBeNull();
    await closeAgain({ note: "x".repeat(500) });
    await rejects(closeAgain({ note: "x".repeat(501) }), { status: 400 });
    expect((await rows()).map((r) => r.note?.length ?? 0)).toEqual([0, 500]);
  });
});

describe("cashCounts", () => {
  const good = { "10000": 2, "5000": 1, "2000": 3, "1000": 1, "500": 1, "200": 4, "100": 2, "50": 1, "20": 2, "10": 1, "5": 1 };
  const goodSum = 20_000 + 5_000 + 6_000 + 1_000 + 500 + 800 + 200 + 50 + 40 + 10 + 5;

  it("every Australian denomination is accepted and the breakdown is kept", async () => {
    expect([...DENOMINATIONS].sort((a, b) => b - a)).toEqual([10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50, 20, 10, 5]);
    expect(Object.keys(good).map(Number).sort((a, b) => b - a)).toEqual([...DENOMINATIONS]);
    const { close: c } = await close({ countedCashCents: goodSum, cashCounts: good });
    expect(c.cashCounts).toEqual(good);
    expect((await rows())[0].cash_counts).toEqual(good);
  });

  it("zero counts are dropped from what is kept", async () => {
    const { close: c } = await close({ countedCashCents: 5_000, cashCounts: { "5000": 1, "2000": 0, "5": 0 } });
    expect(c.cashCounts).toEqual({ "5000": 1 });
  });

  it("must add up to the cash counted (400), whichever way it is out", async () => {
    await rejects(close({ countedCashCents: goodSum + 5, cashCounts: good }), { status: 400 });
    await rejects(close({ countedCashCents: goodSum - 5, cashCounts: good }), { status: 400 });
    await rejects(close({ countedCashCents: 5_000, cashCounts: {} }), { status: 400 });
    await nothingWritten();
  });

  it("is refused for anything that isn't a note or coin, or a count that isn't a whole number", async () => {
    for (const face of ["20000", "2500", "1", "3", "0", "-100", "abc", "", "1.5", "25"]) {
      await rejects(close({ countedCashCents: 0, cashCounts: { [face]: 1 } }), { status: 400 });
    }
    for (const n of [-1, 0.5, Number.NaN, 100_001]) {
      await rejects(close({ countedCashCents: 100, cashCounts: { "100": n } }), { status: 400 });
    }
    // an unknown face is refused even with a zero count
    await rejects(close({ countedCashCents: 0, cashCounts: { "2500": 0 } }), { status: 400 });
    await nothingWritten();
  });

  it("two spellings of the same face value can't be used to make the kept breakdown disagree with the count", async () => {
    // "0100" and "100" are both the $1 coin. Either refuse it, or keep {"100": 2}; never keep {"100": 1} for a count of $2.
    let kept: Record<string, number> | null | undefined;
    let counted = 0;
    try {
      const { close: c } = await close({ countedCashCents: 200, cashCounts: { "100": 1, "0100": 1 } });
      kept = c.cashCounts;
      counted = c.countedCashCents;
    } catch (e) {
      expect(e).toMatchObject({ status: 400 });
      return;
    }
    expect(Object.entries(kept ?? {}).reduce((a, [face, n]) => a + Number(face) * n, 0)).toBe(counted);
  });

  it("omitted or null keeps no breakdown (a typed-in total)", async () => {
    expect((await close({ cashCounts: null })).close.cashCounts).toBeNull();
    expect((await closeAgain({ cashCounts: undefined })).close.cashCounts).toBeNull();
  });

  it("all zero counts for a count of zero is a valid, empty breakdown", async () => {
    const { close: c } = await close({ floatCents: 0, countedCashCents: 0, cashCounts: { "5000": 0 } });
    expect(c.cashCounts).toEqual({});
  });
});

describe("the takings the screen showed", () => {
  it("a mismatch is refused (409 day_changed) and writes nothing, not even for a first close", async () => {
    await cashBill(); // takings 2500
    await rejects(close({ expectedTakingsCents: 0 }), { status: 409, code: "day_changed" });
    await rejects(close({ expectedTakingsCents: 2505 }), { status: 409, code: "day_changed" });
    await nothingWritten();
    await expect(close({ expectedTakingsCents: 2500 })).resolves.toBeTruthy();
  });

  it("a sale rung up after the screen loaded makes the old figure stale", async () => {
    await cashBill("Table 1", 60);
    const shown = (await state()).totals.takingsCents;
    await cashBill("Table 2", 60);
    await rejects(close({ expectedTakingsCents: shown }), { status: 409, code: "day_changed" });
    await nothingWritten();
    await expect(close({ expectedTakingsCents: shown + 2500 })).resolves.toBeTruthy();
  });

  it("zero is a figure like any other; leaving it out skips the check", async () => {
    await expect(close({ expectedTakingsCents: 0 })).resolves.toBeTruthy();
    await cashBill();
    await expect(closeAgain({ expectedTakingsCents: undefined })).resolves.toBeTruthy();
    await rejects(closeAgain({ countedCashCents: 22_500, expectedTakingsCents: 0 }), { status: 409, code: "day_changed" });
  });

  it("takes refunds into account: takings are card + cash - refunds", async () => {
    const id = await cashBill();
    await pushCashRecords();
    await refund(id, 500);
    await rejects(close({ expectedTakingsCents: 2500 }), { status: 409, code: "day_changed" });
    await expect(close({ expectedTakingsCents: 2000 })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Frozen totals and "changed since close"
// ---------------------------------------------------------------------------

describe("what a close keeps, and when the day has moved", () => {
  it("the stored totals are frozen: a sale after the close leaves the row alone and flips changedSinceClose", async () => {
    await cashBill("Table 1", 60);
    const { close: c } = await close({ countedCashCents: 22_500 });
    expect((await state()).changedSinceClose).toBe(false);

    await cashBill("Table 2", 60);
    const s = await state();
    expect(s.changedSinceClose).toBe(true);
    expect(s.totals.cashCents).toBe(5000);
    expect(s.closes).toHaveLength(1);
    expect(s.closes[0].totals.cashCents).toBe(2500); // as it was
    expect(s.closes[0]).toEqual(c);
    expect((await rows())[0].totals.cashCents).toBe(2500);

    // closing again records the new figures, and the day reads as settled again
    await closeAgain({ countedCashCents: 25_000 });
    const after = await state();
    expect(after.changedSinceClose).toBe(false);
    expect(after.closes[0].totals.cashCents).toBe(5000);
    expect(after.closes[1].totals.cashCents).toBe(2500);
  });

  it("a card sale, a refund, a void, and a discount each flip it", async () => {
    const cash = await cashBill("Table 1", 60);
    await pushCashRecords();
    await close();
    expect((await state()).changedSinceClose).toBe(false);

    await cardBill(1000);
    expect((await state()).changedSinceClose).toBe(true);
    await closeAgain();
    expect((await state()).changedSinceClose).toBe(false);

    await refund(cash, 500);
    expect((await state()).changedSinceClose).toBe(true);
    await closeAgain();

    const unpaid = await awaitingPayment(h, "Table 2", 60);
    expect((await state()).changedSinceClose).toBe(true); // a new bill: sessions and billed moved
    await closeAgain();
    await voidSession(A(), MGR(), unpaid, "Wrong table", at(70));
    expect((await state()).changedSinceClose).toBe(true);
  });

  it("paying an older unpaid bill later does not flip an earlier day", async () => {
    const old = await awaitingPayment(h, "Table 1", 60); // closed on the 20th, unpaid
    await close();
    expect((await state()).totals).toMatchObject({ unpaidCount: 1, unpaidCents: 2500 });

    freeze("2026-11-21T09:00:00");
    await markPaid(A(), old, "cash", { cardConfirmed: false }, new Date()); // today's money
    const s = await state("2026-11-20");
    expect(s.totals.unpaidCount).toBe(0); // the day's own figure did move...
    expect(s.closes[0].totals.unpaidCount).toBe(1); // ...the close kept what it was
    expect(s.changedSinceClose).toBe(false); // ...and that isn't a reason to close the day again
    expect(s.totals.cashCents).toBe(0);
    expect((await state()).totals.cashCents).toBe(2500); // it is the 21st's takings
  });

  it("paying an unpaid bill on the same day does flip it (the day's cash moved)", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await close();
    await markPaid(A(), id, "cash", { cardConfirmed: false }, at(70));
    expect((await state()).changedSinceClose).toBe(true);
  });

  it("an older unpaid bill is a warning on the current day only, and is not what flips an earlier day", async () => {
    await awaitingPayment(h, "Table 1", 60); // the 20th
    freeze("2026-11-21T10:00:00");
    const today = await state();
    expect(today.totals).toMatchObject({ olderUnpaidCount: 1, olderUnpaidCents: 2500 });
    expect(today.warnings.join(" ")).toMatch(/earlier days? (is|are) still unpaid/);
    const old = await state("2026-11-20");
    expect(old.warnings.join(" ")).toMatch(/from this day is still unpaid/);
    expect(old.warnings.join(" ")).not.toMatch(/earlier day/);
  });

  it("hasMoved: money, bills and voids count; unpaid, minutes and derived figures alone don't", () => {
    const base: DayCloseTotals = {
      sessionCount: 3, billedMinutes: 180, billedCents: 7500, tableCents: 7000, itemsCents: 700, discountCents: 200, writtenOffCents: 0,
      cardCount: 1, cardCents: 2500, cashCount: 2, cashCents: 5000, cashRoundingCents: 0, refundCount: 0, refundCents: 0, refundCardCents: 0,
      refundCashCents: 0, takingsCents: 7500, unpaidCount: 0, unpaidCents: 0, olderUnpaidCount: 0, olderUnpaidCents: 0, voidCount: 0,
    };
    expect(hasMoved(base, { ...base })).toBe(false);
    const flips: (keyof DayCloseTotals)[] = ["sessionCount", "billedCents", "discountCents", "writtenOffCents", "cardCents", "cashCents", "refundCents", "refundCashCents", "voidCount"];
    for (const k of flips) expect(hasMoved(base, { ...base, [k]: base[k] + 5 }), k).toBe(true);
    const quiet: (keyof DayCloseTotals)[] = ["unpaidCount", "unpaidCents", "olderUnpaidCount", "olderUnpaidCents"];
    for (const k of quiet) expect(hasMoved(base, { ...base, [k]: base[k] + 5 }), k).toBe(false);
    // money that moves between methods, or a card refund, shows up through the cents that changed
    expect(hasMoved(base, { ...base, cardCents: 0, cashCents: 7500 })).toBe(true);
    expect(hasMoved(base, { ...base, refundCents: 300, refundCardCents: 300, takingsCents: 7200 })).toBe(true);
  });

  it("hasMoved notices a change that leaves every cents figure alone but changes the number of bills", () => {
    const t = totalsOf(emptySummary());
    expect(hasMoved(t, { ...t, sessionCount: 1 })).toBe(true);
  });
});

function emptySummary(): Parameters<typeof totalsOf>[0] {
  return {
    sessions: { count: 0, billedMinutes: 0, billedCents: 0, tableCents: 0, itemsCents: 0, discountCents: 0, writtenOffCents: 0 },
    paid: { card: { count: 0, cents: 0 }, cash: { count: 0, cents: 0, roundingCents: 0 } },
    refunds: { count: 0, cents: 0, cardCents: 0, cashCents: 0 },
    unpaid: { count: 0, cents: 0 },
    outstandingOlder: { count: 0, cents: 0 },
    voids: { count: 0 },
  } as unknown as Parameters<typeof totalsOf>[0];
}

// ---------------------------------------------------------------------------
// Which days need a manager
// ---------------------------------------------------------------------------

describe("which days need a manager (needsManager)", () => {
  it("today and yesterday: any staff member's first close; older days, and any second close, need a manager", async () => {
    freeze("2026-11-21T10:00:00"); // today the 21st, yesterday the 20th
    expect((await state("2026-11-21")).needsManager).toBe(false);
    expect((await state("2026-11-20")).needsManager).toBe(false);
    expect((await state("2026-11-19")).needsManager).toBe(true);
    expect((await state("2026-01-01")).needsManager).toBe(true);
    await close({ date: "2026-11-21" });
    expect((await state("2026-11-21")).needsManager).toBe(true);
  });

  it("before 06:00 'yesterday' is the day before the business day still running", async () => {
    freeze("2026-11-21T02:00:00"); // the 20th is still running; yesterday is the 19th
    expect((await state("2026-11-20")).needsManager).toBe(false);
    expect((await state("2026-11-19")).needsManager).toBe(false);
    expect((await state("2026-11-18")).needsManager).toBe(true);
  });

  it("an older day closed without a manager is refused (409 needs_manager) and nothing is written", async () => {
    freeze("2026-11-21T10:00:00");
    await rejects(close({ date: "2026-11-19" }), { status: 409, code: "needs_manager" });
    await rejects(close({ date: "2026-11-19", reason: "Forgot to close it" }), { status: 409, code: "needs_manager" });
    await nothingWritten();
  });

  it("with a manager it also needs a reason; then it is recorded with who approved it and why", async () => {
    freeze("2026-11-21T10:00:00");
    for (const reason of [undefined, "", "  ", "ab"]) {
      await rejects(close({ date: "2026-11-19", reason }, MGR()), { status: 400 });
    }
    await nothingWritten();
    const { close: c } = await close({ date: "2026-11-19", reason: "  Forgot to close it  ", note: "counted Monday" }, MGR());
    expect(c).toMatchObject({ seq: 1, businessDate: "2026-11-19", approvedByName: "Mia Manager", reason: "Forgot to close it", note: "counted Monday" });
    const [row] = await audits(h, "2026-11-19", "day.close");
    expect(row).toMatchObject({ approved_by_staff_id: MGR().id, reason: "Forgot to close it" });
    expect(await auditCount("day.close_again")).toBe(0);
    // it can be closed again, still by a manager
    const again = await close({ date: "2026-11-19", countedCashCents: 20_050, reason: "Recount" }, MGR());
    expect(again.close.seq).toBe(2);
  });

  it("yesterday and today need no manager and no reason, and a reason sent anyway is not kept", async () => {
    freeze("2026-11-21T10:00:00");
    const y = await close({ date: "2026-11-20", reason: "not needed" });
    expect(y.close).toMatchObject({ seq: 1, approvedByName: null, reason: null });
    expect((await close({ date: "2026-11-21" })).close.reason).toBeNull();
  });
});

describe("the same close sent twice", () => {
  it("answers with the close already made and writes nothing (a lost answer, or a second iPad)", async () => {
    await cashBill();
    const first = await close({ countedCashCents: 22_500, note: "all good" });
    const again = await close({ countedCashCents: 22_500, note: "all good" });
    expect(again.close).toEqual(first.close);
    expect(await rows()).toHaveLength(1);
    expect(await auditCount("day.close")).toBe(1);
    expect(await auditCount("day.close_again")).toBe(0);
    // even with a manager's PIN and a reason on the repeat
    const withManager = await close({ countedCashCents: 22_500, note: "all good", reason: "Retry" }, MGR());
    expect(withManager.close.id).toBe(first.close.id);
    expect(await rows()).toHaveLength(1);
  });

  it("is a repeat only if float, count and note are all the same", async () => {
    await close({ floatCents: 20_000, countedCashCents: 20_000, note: "a" });
    await rejects(close({ floatCents: 20_005, countedCashCents: 20_000, note: "a" }), { status: 409, code: "already_closed" });
    await rejects(close({ floatCents: 20_000, countedCashCents: 20_005, note: "a" }), { status: 409, code: "already_closed" });
    await rejects(close({ floatCents: 20_000, countedCashCents: 20_000, note: "b" }), { status: 409, code: "already_closed" });
    await rejects(close({ floatCents: 20_000, countedCashCents: 20_000 }), { status: 409, code: "already_closed" });
    expect(await rows()).toHaveLength(1);
  });

  it("is not a repeat once the day has moved: that is a new close and needs a manager", async () => {
    await close();
    await cashBill();
    await rejects(close(), { status: 409, code: "already_closed" });
    const second = await close({ reason: "Late sale" }, MGR());
    expect(second.close.seq).toBe(2);
  });

  it("is a repeat for about two minutes, and not after", async () => {
    await close();
    await ageCloses(1);
    expect((await close()).close.seq).toBe(1);
    await ageCloses(3);
    await rejects(close(), { status: 409, code: "already_closed" });
    expect((await close({ reason: "Again" }, MGR())).close.seq).toBe(2);
    expect(await rows()).toHaveLength(2);
  });

  it("a repeat of the latest close is recognised after an earlier re-close too", async () => {
    await close();
    await ageCloses(10);
    const second = await closeAgain();
    const repeat = await closeAgain();
    expect(repeat.close.id).toBe(second.close.id);
    expect(await rows()).toHaveLength(2);
  });

  it("still can't close the day while a table is running", async () => {
    await close();
    await startSession(A(), h.tableId("Table 1"), at(0));
    await rejects(close(), { status: 409, code: "tables_running" });
  });
});

describe("the cash movement the screen showed", () => {
  it("a mismatch is refused (409 day_changed) and nothing is written; a match closes", async () => {
    await cashBill();
    await rejects(close({ expectedCashMovementCents: 0 }), { status: 409, code: "day_changed" });
    await rejects(close({ expectedTakingsCents: 2500, expectedCashMovementCents: 2000 }), { status: 409, code: "day_changed" });
    await nothingWritten();
    await expect(close({ expectedTakingsCents: 2500, expectedCashMovementCents: 2500 })).resolves.toBeTruthy();
  });

  it("catches a cash bill reopened and paid by card: the takings are the same, the drawer is not", async () => {
    const id = await cashBill();
    const shown = await state();
    expect([shown.totals.takingsCents, shown.cashMovementCents]).toEqual([2500, 2500]);

    await reversePaid(A(), MGR(), id, "Customer paid by card after all");
    await markPaid(A(), id, "card", { cardConfirmed: true }, at(80));
    const now = await state();
    expect([now.totals.takingsCents, now.cashMovementCents]).toEqual([2500, 0]);

    await rejects(close({ expectedTakingsCents: shown.totals.takingsCents, expectedCashMovementCents: shown.cashMovementCents }), { status: 409, code: "day_changed" });
    await nothingWritten();
    const { close: c } = await close({ expectedTakingsCents: 2500, expectedCashMovementCents: 0, countedCashCents: 20_000 });
    expect(c).toMatchObject({ expectedCashCents: 20_000, varianceCents: 0 });
  });
});

describe("yesterday left unclosed", () => {
  it("the new day warns when yesterday took money and was never closed, until it is", async () => {
    await cashBill(); // paid on the 20th
    freeze("2026-11-21T10:00:00");
    expect((await state()).warnings.join(" ")).toMatch(/Yesterday had sales and hasn't been closed/);
    expect((await state("2026-11-20")).warnings.join(" ")).not.toMatch(/Yesterday/); // only the screen for today says so
    await close({ date: "2026-11-20" });
    expect((await state()).warnings.join(" ")).not.toMatch(/Yesterday/);
  });

  it("not when yesterday had no sales, or only bills left unpaid", async () => {
    await awaitingPayment(h, "Table 1", 60);
    freeze("2026-11-21T10:00:00");
    expect((await state()).warnings.join(" ")).not.toMatch(/Yesterday/);
  });
});

describe("the summary's close", () => {
  it("is null until the day is closed, then the latest close in brief, and follows the day moving", async () => {
    await cashBill();
    expect((await getSummary(DAY)).close).toBeNull();
    const first = (await close({ countedCashCents: 22_400 })).close;
    expect((await getSummary(DAY)).close).toEqual({ closedAt: first.closedAt, closedByName: "Sam Staff", varianceCents: -100, changedSinceClose: false });
    await cashBill("Table 2", 60);
    expect((await getSummary(DAY)).close).toMatchObject({ varianceCents: -100, changedSinceClose: true });
    const second = (await closeAgain({ countedCashCents: 25_000 })).close;
    expect((await getSummary(DAY)).close).toEqual({ closedAt: second.closedAt, closedByName: "Sam Staff", varianceCents: 0, changedSinceClose: false });
    expect((await getSummary("2026-11-19")).close).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// State: float suggestion, history, warnings
// ---------------------------------------------------------------------------

describe("the End of day screen's state", () => {
  it("suggests $200 until a day has been closed, then the last close's float, even for another day", async () => {
    expect(DEFAULT_FLOAT_CENTS).toBe(20_000);
    expect((await state()).suggestedFloatCents).toBe(20_000);
    await close({ floatCents: 15_000, countedCashCents: 15_000 });
    expect((await state()).suggestedFloatCents).toBe(15_000);
    freeze("2026-11-21T10:00:00");
    expect((await state()).suggestedFloatCents).toBe(15_000); // another day, nothing closed: last close anywhere
    expect((await state("2026-11-20")).suggestedFloatCents).toBe(15_000);
    await close({ date: "2026-11-20", floatCents: 12_500, countedCashCents: 12_500, reason: "Recount" }, MGR());
    expect((await state("2026-11-20")).suggestedFloatCents).toBe(12_500); // this day's latest close
    expect((await state()).suggestedFloatCents).toBe(12_500);
  });

  it("the history lists newest first and across days", async () => {
    freeze("2026-11-21T10:00:00");
    await close({ date: "2026-11-19", reason: "Forgotten on the night" }, MGR());
    await close({ date: "2026-11-21" });
    await close({ date: "2026-11-20" });
    await closeAgain({ date: "2026-11-20" });
    const { closes } = await listDayCloses();
    expect(closes.map((c) => `${c.businessDate}#${c.seq}`)).toEqual(["2026-11-21#1", "2026-11-20#2", "2026-11-20#1", "2026-11-19#1"]);
    expect(closes[1]).toMatchObject({ closedByName: "Sam Staff", approvedByName: "Mia Manager", reason: "Late sale" });
  });

  it("the history holds at most 60 closes", async () => {
    const days = Array.from({ length: 65 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
    for (const d of days) {
      await h.sql`
        insert into public.day_closes (business_date, seq, closed_by, float_cents, counted_cash_cents, expected_cash_cents, variance_cents, totals)
        values (${d}::date, 1, ${A().staffId}, 0, 0, 0, 0, '{}'::jsonb)`;
    }
    const { closes } = await listDayCloses();
    expect(closes).toHaveLength(60);
    expect(closes[0].businessDate).toBe(days[64]);
    expect(closes[59].businessDate).toBe(days[5]);
  });

  it("warns about unpaid bills, cash not yet in Square and refunds that couldn't be confirmed; a quiet day has none", async () => {
    expect((await state()).warnings).toEqual([]);
    await cashBill("Table 1", 60); // sale not pushed to Square yet
    expect((await state()).warnings.join(" ")).toMatch(/1 cash payment isn't in Square yet \(\$25\.00\)/);
    await pushCashRecords();
    expect((await state()).warnings).toEqual([]);
    await awaitingPayment(h, "Table 2", 120);
    await awaitingPayment(h, "Table 3", 60);
    expect((await state()).warnings.join(" ")).toMatch(/2 bills from this day are still unpaid \(\$75\.00\)/);
  });

  it("a bad date is a 400", async () => {
    await rejects(state("2026-02-31"), { status: 400 });
    await rejects(state("nope"), { status: 400 });
  });

  it("running tables are labelled with the bill's label and name, and an unrelated earlier day is empty", async () => {
    const { sessionId } = await startSession(A(), h.tableId("Table 2"), at(0));
    await setDetails(A(), sessionId, { customerName: "Pat", note: null });
    expect((await state()).running).toEqual([{ sessionId, label: "Table 2", customerName: "Pat" }]);
    expect((await state("2026-11-19")).running).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe("audit", () => {
  it("a first close writes day.close with the figures; the note is the reason", async () => {
    await cashBill();
    await close({ floatCents: 20_000, countedCashCents: 22_400, note: "short $1" });
    const [row] = await audits(h, DAY, "day.close");
    expect(row).toMatchObject({
      actor_staff_id: A().staffId,
      approved_by_staff_id: null,
      device_label: "Counter",
      entity: "day",
      entity_id: DAY,
      reason: "short $1",
      before: null,
      after: { seq: 1, float_cents: 20_000, counted_cash_cents: 22_400, expected_cash_cents: 22_500, variance_cents: -100, takings_cents: 2500 },
    });
  });

  it("closing again writes day.close_again with the manager, the reason and the close it follows", async () => {
    await close({ floatCents: 20_000, countedCashCents: 20_000 });
    await closeAgain({ floatCents: 20_000, countedCashCents: 20_050, reason: "Found a coin" });
    expect(await auditActions(h, DAY)).toEqual(["day.close", "day.close_again"]);
    const [row] = await audits(h, DAY, "day.close_again");
    expect(row).toMatchObject({
      approved_by_staff_id: MGR().id,
      reason: "Found a coin",
      before: { seq: 1, counted_cash_cents: 20_000, variance_cents: 0 },
      after: { seq: 2, counted_cash_cents: 20_050, expected_cash_cents: 20_000, variance_cents: 50 },
    });
  });

  it("every refusal leaves the audit log alone", async () => {
    await rejects(close({ floatCents: 3 }), { status: 400 });
    await rejects(close({ date: "2099-01-01" }), { status: 400 });
    await rejects(close({ expectedTakingsCents: 99 }), { status: 409 });
    await close();
    await rejects(close({ countedCashCents: 20_050 }), { status: 409 });
    expect(await auditCount("day.close")).toBe(1);
    expect(await auditCount("day.close_again")).toBe(0);
  });

  it("the close and its audit row are one transaction: if the audit row can't be written, there is no close", async () => {
    await h.raw(
      null,
      `create function public.test_refuse_day_audit() returns trigger language plpgsql as $$
       begin if new.action like 'day.%' then raise exception 'audit refused'; end if; return new; end $$`,
    );
    await h.raw(null, `create trigger test_refuse_day_audit before insert on public.audit_log for each row execute function public.test_refuse_day_audit()`);
    try {
      await expect(close()).rejects.toThrow(/audit refused/);
      expect(await rows()).toHaveLength(0);
    } finally {
      await h.raw(null, `drop trigger test_refuse_day_audit on public.audit_log`);
      await h.raw(null, `drop function public.test_refuse_day_audit()`);
    }
    await expect(close()).resolves.toBeTruthy();
    expect(await rows()).toHaveLength(1);
    expect(await auditCount("day.close")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

describe("day_closes is append-only and locked down", () => {
  const closeId = async () => (await rows())[0].id;

  it("cannot be updated, deleted or truncated by the app's role", async () => {
    await close();
    const id = await closeId();
    for (const sql of [
      `update public.day_closes set counted_cash_cents = 0 where id = '${id}'`,
      `update public.day_closes set note = 'x'`,
      `delete from public.day_closes where id = '${id}'`,
      `delete from public.day_closes`,
      `truncate public.day_closes`,
    ]) {
      await expect(h.rawError("timer_app", sql), sql).resolves.toMatchObject({ code: "42501" });
    }
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].totals).toBeTruthy();
  });

  it("cannot be updated, deleted or truncated even by the table's owner (the trigger, not just the grants)", async () => {
    await close();
    const id = await closeId();
    const cases: [string, RegExp][] = [
      [`update public.day_closes set counted_cash_cents = 0, variance_cents = -20000 where id = '${id}'`, /UPDATE on public\.day_closes is not permitted/],
      [`update public.day_closes set totals = '{}'::jsonb`, /UPDATE on public\.day_closes is not permitted/],
      [`delete from public.day_closes where id = '${id}'`, /DELETE on public\.day_closes is not permitted/],
      [`truncate public.day_closes`, /TRUNCATE on public\.day_closes is not permitted/],
    ];
    for (const [sql, message] of cases) {
      const e = await h.rawError(null, sql);
      expect(e.message, sql).toMatch(message);
      expect(e.code).toBe("42501");
    }
    expect(await rows()).toHaveLength(1);
  });

  it("supabase's other roles can neither read nor write it, and service_role cannot change it", async () => {
    await close();
    const id = await closeId();
    for (const role of ["anon", "authenticated"]) {
      for (const sql of [
        `select * from public.day_closes`,
        `insert into public.day_closes (business_date, seq, closed_by, float_cents, counted_cash_cents, expected_cash_cents, variance_cents, totals) values ('2026-01-01', 1, '${A().staffId}', 0, 0, 0, 0, '{}')`,
        `update public.day_closes set note = 'x'`,
        `delete from public.day_closes`,
      ]) {
        await expect(h.rawError(role, sql), `${role}: ${sql}`).resolves.toMatchObject({ code: "42501" });
      }
    }
    for (const sql of [`update public.day_closes set note = 'x' where id = '${id}'`, `delete from public.day_closes`, `truncate public.day_closes`]) {
      await expect(h.rawError("service_role", sql), sql).resolves.toMatchObject({ code: "42501" });
    }
  });

  it("row level security is on", async () => {
    const [t] = await h.raw<{ relrowsecurity: boolean }>(null, `select relrowsecurity from pg_class where oid = 'public.day_closes'::regclass`);
    expect(t.relrowsecurity).toBe(true);
    const policies = await h.raw<{ policyname: string; cmd: string; roles: string }>(
      null,
      `select policyname, cmd, roles::text from pg_policies where tablename = 'day_closes' order by cmd`,
    );
    expect(policies.map((p) => [p.cmd, p.roles])).toEqual([
      ["INSERT", "{timer_app}"],
      ["SELECT", "{timer_app}"],
    ]);
  });

  const base = (over: Record<string, string | number | null> = {}) => {
    const v = {
      business_date: "'2026-01-01'",
      seq: 1,
      closed_by: `'${A().staffId}'`,
      approved_by: "null",
      float_cents: 0,
      counted_cash_cents: 100,
      expected_cash_cents: 100,
      variance_cents: 0,
      reason: "null",
      note: "null",
      totals: "'{}'",
      ...over,
    };
    return `insert into public.day_closes (${Object.keys(v).join(", ")}) values (${Object.values(v).join(", ")})`;
  };

  it("the two check constraints: variance must be counted - expected; a re-close needs an approver and a reason", async () => {
    await expect(h.rawError(null, base({ variance_cents: 5 }))).resolves.toMatchObject({ code: "23514", message: expect.stringMatching(/day_closes_variance_adds_up/) });
    await expect(h.rawError(null, base({ seq: 2 }))).resolves.toMatchObject({ code: "23514", message: expect.stringMatching(/day_closes_reclose_is_approved/) });
    await expect(h.rawError(null, base({ seq: 2, approved_by: `'${MGR().id}'` }))).resolves.toMatchObject({ code: "23514" });
    await expect(h.rawError(null, base({ seq: 2, reason: "'because'" }))).resolves.toMatchObject({ code: "23514" });
    await h.raw(null, base({ seq: 1 }));
    await h.raw(null, base({ seq: 2, approved_by: `'${MGR().id}'`, reason: "'because'" }));
    expect(await rows()).toHaveLength(2);
  });

  it("(business_date, seq) is unique, seq starts at 1, and other columns keep their limits", async () => {
    await h.raw(null, base());
    await expect(h.rawError(null, base())).resolves.toMatchObject({ code: "23505" });
    await expect(h.rawError(null, base({ seq: 0, business_date: "'2026-01-02'" }))).resolves.toMatchObject({ code: "23514" });
    await expect(h.rawError(null, base({ business_date: "'2026-01-02'", float_cents: -5 }))).resolves.toMatchObject({ code: "23514" });
    await expect(h.rawError(null, base({ business_date: "'2026-01-02'", float_cents: 10_000_001 }))).resolves.toMatchObject({ code: "23514" });
    await expect(h.rawError(null, base({ business_date: "'2026-01-02'", counted_cash_cents: -5, expected_cash_cents: -5 }))).resolves.toMatchObject({ code: "23514" });
    await expect(h.rawError(null, base({ business_date: "'2026-01-02'", note: `'${"x".repeat(501)}'` }))).resolves.toMatchObject({ code: "23514" });
    await expect(h.rawError(null, base({ business_date: "'2026-01-02'", seq: 2, approved_by: `'${MGR().id}'`, reason: "'ab'" }))).resolves.toMatchObject({ code: "23514" });
    await expect(h.rawError(null, base({ business_date: "'2026-01-02'", totals: "null" }))).resolves.toMatchObject({ code: "23502" });
  });

  it("the staff who closed a day can't be deleted out from under the record", async () => {
    await close();
    await expect(h.rawError(null, `delete from public.staff where id = '${A().staffId}'`)).resolves.toMatchObject({ code: expect.stringMatching(/^23503|42501$/) });
  });
});

// ---------------------------------------------------------------------------
// parseYMD (extracted from getSummary)
// ---------------------------------------------------------------------------

describe("parseYMD", () => {
  it("returns the parts of a real date, leap days included", () => {
    expect(parseYMD("2026-11-23")).toEqual({ y: 2026, m: 11, d: 23 });
    expect(parseYMD("2028-02-29")).toEqual({ y: 2028, m: 2, d: 29 });
    expect(parseYMD("2026-12-31")).toEqual({ y: 2026, m: 12, d: 31 });
    expect(parseYMD("2026-01-01")).toEqual({ y: 2026, m: 1, d: 1 });
  });

  it("refuses impossible and malformed dates with a 400 that names what was being read", () => {
    for (const bad of ["2026-02-31", "2026-02-29", "2025-02-29", "2026-04-31", "2026-06-31", "2026-13-01", "2026-00-10", "2026-11-00", "2026-11-32", "2026-1-5", "26-11-23", "2026/11/23", "", " 2026-11-23", "2026-11-23 ", "2026-11-23\n", "2026-11-23T00:00", "0099-01-01", "abcd-ef-gh"]) {
      expect(() => parseYMD(bad), JSON.stringify(bad)).toThrowError(expect.objectContaining({ status: 400 }));
    }
    expect(() => parseYMD("2026-02-31", "from")).toThrow(/^from must be YYYY-MM-DD/);
    expect(() => parseYMD("2026-02-31")).toThrow(/^date must be YYYY-MM-DD/);
  });

  it("the summary rejects an impossible date instead of rolling it into March", async () => {
    await rejects(getSummary("2026-02-31"), { status: 400 });
    await rejects(getSummary("2026-11-31"), { status: 400 });
    await expect(getSummary("2026-11-30")).resolves.toMatchObject({ businessDate: "2026-11-30" });
  });
});

// ---------------------------------------------------------------------------
// Regression: the daily summary after billedTotals was pulled out of it
// ---------------------------------------------------------------------------

describe("daily summary regression (billedTotals extraction)", () => {
  it("gives the figures worked out by hand for a day with discounts, split bills, write-offs and voids", async () => {
    await seedDiscount(h, { id: "D10", name: "Ten off", kind: "percent", value: 1000 });
    const { actor, manager } = h.staff;
    const a = await awaitingPayment(h, "Table 1", 60);
    await addItem(actor, a, "COKE", 1);
    await markPaid(actor, a, "cash", { cardConfirmed: false }, at(61));
    const b = await awaitingPayment(h, "Table 2", 90);
    await setDiscount(actor, manager, b, { discountId: "D10" });
    const { sessionId: c } = await openCounterSale(actor, at(5));
    await addItem(actor, c, "BEER", 1);
    const d = await awaitingPayment(h, "Table 3", 60);
    await splitBill(actor, d, { ways: 2 }, at(61));
    const e = await awaitingPayment(h, "Table 4", 60);
    const { partIds } = await splitBill(actor, e, { amountCents: 1000 }, at(61));
    await voidSession(actor, manager, partIds[0], "Walked out", at(62));
    const f = await awaitingPayment(h, "Table 5", 60);
    await voidSession(actor, manager, f, "Opened by mistake", at(62));

    const s = await getSummary(DAY);
    expect(s.sessions).toEqual({
      count: 5, // A B C D E
      billedMinutes: 60 + 90 + 0 + 60 + 60,
      billedCents: 2950 + 3375 + 1100 + 2500 + 1500, // D = parent 1250 + share 1250
      tableCents: 2500 + 3750 + 2500 + 2500,
      itemsCents: 450 + 1100,
      discountCents: 375,
      writtenOffCents: 1000,
    });
    expect(s.paid.cash).toEqual({ count: 1, cents: 2950, roundingCents: 0 });
    expect(s.unpaid.count).toBe(5); // B, C, D's rest, D's share, E's rest
    expect(s.voids.count).toBe(2);
    expect(s.itemsSold.map((i) => [i.productId, i.quantity, i.cents])).toEqual([["BEER", 1, 1100], ["COKE", 1, 450]]);
    // the independent check: billed is exactly what the bills' own rows add up to
    const [{ billed }] = await h.sql<{ billed: number }[]>`
      select coalesce(sum(total_cents), 0)::int as billed from public.sessions where status <> 'void'`;
    expect(s.sessions.billedCents).toBe(billed);
  });

  it("counts a share by the day of the bill it was split from, not the day the split happened", async () => {
    const d = await awaitingPayment(h, "Table 1", 60); // closed on the 20th
    freeze("2026-11-21T09:00:00");
    await splitBill(A(), d, { ways: 2 }, new Date());
    const s20 = await getSummary("2026-11-20");
    const s21 = await getSummary("2026-11-21");
    expect(s20.sessions).toMatchObject({ count: 1, billedCents: 2500 });
    expect(s21.sessions).toMatchObject({ count: 0, billedCents: 0, billedMinutes: 0 });
  });
});
