import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import {
  at,
  audits,
  auditActions,
  awaitingPayment,
  expectBillAddsUp,
  expectFamilyAddsUp,
  getCheckouts,
  getIntervals,
  getItems,
  getSession,
  seedDiscount,
  seedProduct,
} from "./helpers/util";
import { TransitionError } from "@/lib/domain/machine";
import { withTx } from "@/lib/server/db";
import { handlePosReturn, startCashHandoff } from "@/lib/server/pos-cash";
import { getFloor, getSessionDetail, getSummary, getUnpaid } from "@/lib/server/queries";
import {
  MERGED_REASON,
  addCustomItem,
  addItem,
  applyWebhookCheckout,
  cancelCheckout,
  chargeCard,
  discardCounterSale,
  editTimes,
  markPaid,
  mergeBack,
  openCounterSale,
  pauseSession,
  removeDiscount,
  removeItem,
  reversePaid,
  setDiscount,
  splitBill,
  startSession,
  stopSession,
  transferSession,
  voidSession,
} from "@/lib/server/sessions";
import { pushCashRecords, type CashRecordRow } from "@/lib/server/square-cash";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  vi.restoreAllMocks();
  await seedProduct(h, { id: "VAR_COKE", name: "Coke", priceCents: 450 });
  await seedProduct(h, { id: "VAR_CHIPS", name: "Chips", priceCents: 600 });
  await seedProduct(h, { id: "VAR_WATER", name: "Water", priceCents: 300, taxed: false });
  await seedDiscount(h, { id: "D_10", name: "Members 10%", kind: "percent", value: 1000 });
  await seedDiscount(h, { id: "D_125", name: "Staff 12.5%", kind: "percent", value: 1250 });
});

const LIVE = /Cancel the card request on the Terminal before changing the bill/;
const PART_FIXED = /A share of a split bill can't be changed/;
const local = (iso: string) => new Date(`${iso}+11:00`);

const records = (sessionId: string) =>
  h.sql<CashRecordRow[]>`select * from public.square_cash_records where session_id = ${sessionId} order by seq`;
const webhookPaid = (checkoutId: string, sessionId: string, amountCents: number) =>
  withTx((tx) => applyWebhookCheckout(tx, { id: checkoutId, status: "COMPLETED", referenceId: sessionId, cancelReason: null, amountCents }));
const totalOf = async (id: string) => (await getSession(h, id)).total_cents ?? 0;
/** What is owed across a bill and every part of it that still stands, straight from the rows. */
async function owedAcross(parentId: string): Promise<number> {
  const [r] = await h.sql<{ cents: number }[]>`
    select (coalesce((select total_cents from public.sessions where id = ${parentId}), 0)
          + coalesce((select sum(total_cents) from public.sessions where split_of = ${parentId} and not merged), 0))::int as cents`;
  return r.cents;
}
const PREFIX = "square-commerce-v1://payment/create?data=";
const stateOf = (url: string) => (JSON.parse(decodeURIComponent(url.slice(PREFIX.length))) as { state: string }).state;
async function ageHandoffs(ago: string): Promise<void> {
  await h.raw(null, `alter table public.audit_log disable trigger audit_log_no_update`);
  try {
    await h.raw(null, `update public.audit_log set at = now() - interval '${ago}' where action = 'cash.handoff_started'`);
  } finally {
    await h.raw(null, `alter table public.audit_log enable trigger audit_log_no_update`);
  }
}
/** A counter sale with one custom charge on it: the quickest way to a bill of an exact amount. */
async function billOf(cents: number): Promise<string> {
  const { sessionId } = await openCounterSale(h.staff.actor, at(1));
  let left = cents;
  while (left > 0) {
    const line = Math.min(left, 200_000);
    await addCustomItem(h.staff.actor, sessionId, "Thing", line);
    left -= line;
  }
  return sessionId;
}

// ---------------------------------------------------------------------------
// G1. Splitting
// ---------------------------------------------------------------------------

describe("G1. splitting a bill", () => {
  it("ways: N − 1 parts of floor(total / N); this bill keeps one share and the odd cents", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 3", 60); // 2500
    const { partIds } = await splitBill(actor, id, { ways: 3 }, at(61));
    expect(partIds).toHaveLength(2);

    expect(await getSession(h, id)).toMatchObject({ kind: "table", split_off_cents: 1666, total_cents: 834, checkout_attempt: 1, status: "awaiting_payment" });
    for (const pid of partIds) {
      const p = await getSession(h, pid);
      expect(p).toMatchObject({
        kind: "part",
        split_of: id,
        status: "awaiting_payment",
        current_table_id: null,
        billed_minutes: 0,
        total_cents: 833,
        items_cents: 833,
        discount_cents: 0,
        split_off_cents: 0,
        merged: false,
        rate_snapshot: null,
        opened_by: actor.staffId,
        closed_by: actor.staffId,
        checkout_attempt: 0,
      });
      expect(p.opened_at).toEqual(at(61));
      expect(p.closed_at).toEqual(at(61));
      expect(await getIntervals(h, pid)).toHaveLength(0);
      expect(await getItems(h, pid)).toEqual([
        expect.objectContaining({ kind: "split", product_id: null, name: "Table 3 · share", unit_cents: 833, quantity: 1, taxed: true, added_by: actor.staffId, removed_at: null }),
      ]);
      const [made] = await audits(h, pid, "session.split_off");
      expect(made.actor_staff_id).toBe(actor.staffId);
      expect(made.after).toMatchObject({ split_of: id, label: "Table 3 · share", total_cents: 833 });
    }

    const [row] = await audits(h, id, "session.split");
    expect(row.actor_staff_id).toBe(actor.staffId);
    expect(row.before).toMatchObject({ total_cents: 2500, split_off_cents: 0 });
    expect(row.after).toMatchObject({
      ways: 3,
      parts: partIds.map((p) => ({ id: p, amount_cents: 833 })),
      split_off_cents: 1666,
      total_cents: 834,
    });
    expect(await auditActions(h, id)).not.toContain("session.repriced");

    await expectFamilyAddsUp(h, id);
    expect(await owedAcross(id)).toBe(2500);
  });

  it("amount: one part of that size", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const { partIds } = await splitBill(actor, id, { amountCents: 1000 }, at(61));
    expect(partIds).toHaveLength(1);
    expect(await getSession(h, id)).toMatchObject({ split_off_cents: 1000, total_cents: 1500, checkout_attempt: 1 });
    expect(await getSession(h, partIds[0])).toMatchObject({ kind: "part", total_cents: 1000, items_cents: 1000 });
    const [row] = await audits(h, id, "session.split");
    expect(row.after).toMatchObject({ amount_cents: 1000, split_off_cents: 1000, total_cents: 1500 });
    await expectFamilyAddsUp(h, id);

    // the share has to be less than the bill, and more than nothing
    for (const cents of [1500, 1501, 99_999]) {
      await expect(splitBill(actor, id, { amountCents: cents }), String(cents)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/less than what is on the bill \(\$15\.00\)/) });
    }
    for (const cents of [0, -100, 12.5, Number.NaN]) {
      await expect(splitBill(actor, id, { amountCents: cents }), String(cents)).rejects.toMatchObject({ status: 400 });
    }
    expect(await owedAcross(id)).toBe(2500);
    // one cent short of everything is the most that can go
    await splitBill(actor, id, { amountCents: 1499 }, at(62));
    expect(await totalOf(id)).toBe(1);
    await expectFamilyAddsUp(h, id);
  });

  it("the bill and its parts add up to the bill before the split, to the cent, for 2 to 10 ways and any total", async () => {
    const { actor } = h.staff;
    const totals = [1, 2, 3, 7, 9, 10, 11, 99, 100, 101, 833, 1000, 2501, 3333, 9999, 10_007, 123_457, 200_000];
    let checked = 0;
    for (let ways = 2; ways <= 10; ways++) {
      for (const total of totals) {
        const id = await billOf(total);
        expect(await totalOf(id), `bill of ${total}`).toBe(total);
        if (total < ways) {
          // every share would be nothing
          await expect(splitBill(actor, id, { ways }), `${total} / ${ways}`).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/too little to split/) });
          expect(await owedAcross(id)).toBe(total);
          continue;
        }
        const { partIds } = await splitBill(actor, id, { ways }, at(2));
        const share = Math.floor(total / ways);
        const tag = `${total} split ${ways} ways`;
        expect(partIds, tag).toHaveLength(ways - 1);
        const parts = await h.sql<{ total_cents: number; items_cents: number }[]>`
          select total_cents, items_cents from public.sessions where split_of = ${id} and not merged`;
        expect(parts.map((p) => p.total_cents), tag).toEqual(Array.from({ length: ways - 1 }, () => share));
        const kept = await totalOf(id);
        expect(kept, tag).toBe(total - share * (ways - 1));
        expect(kept, `${tag}: this bill keeps a share plus the odd cents`).toBeGreaterThanOrEqual(share);
        expect(kept - share, tag).toBeLessThan(ways);
        expect(await owedAcross(id), tag).toBe(total);
        if (checked++ % 6 === 0) await expectFamilyAddsUp(h, id);
      }
    }
    expect(checked).toBeGreaterThan(120);
  });

  it("… and the same holds for a table's bill with items and a percentage discount", async () => {
    let n = 0;
    for (const minutes of [35, 60, 85, 110]) {
      for (const ways of [2, 3, 7, 10]) {
        await h.reset(); // a fresh floor each time (and fresh staff rows: read them after it)
        const { actor } = h.staff;
        await seedProduct(h, { id: "VAR_COKE", name: "Coke", priceCents: 450 });
        await seedDiscount(h, { id: "D_125", name: "Staff 12.5%", kind: "percent", value: 1250 });
        const id = await awaitingPayment(h, "Table 1", minutes);
        await addItem(actor, id, "VAR_COKE", 1 + (n++ % 3));
        await setDiscount(actor, null, id, { discountId: "D_125" });
        const before = await expectBillAddsUp(h, id);
        const total = before.totalCents ?? 0;

        const { partIds } = await splitBill(actor, id, { ways }, at(minutes + 1));
        const after = await expectFamilyAddsUp(h, id);
        expect(partIds).toHaveLength(ways - 1);
        // the discount is untouched by a split: it is on table time + items, not on what is left
        expect(after.parent.discountCents).toBe(before.discountCents);
        expect(after.parent.splitOffCents).toBe(Math.floor(total / ways) * (ways - 1));
        expect(await owedAcross(id), `${minutes} min, ${ways} ways`).toBe(total);
      }
    }
  });

  it("splitting again later splits what is left on this bill", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const first = await splitBill(actor, id, { ways: 2 }, at(61)); // 1250 + 1250
    const second = await splitBill(actor, id, { amountCents: 500 }, at(62)); // 750 left
    const third = await splitBill(actor, id, { ways: 3 }, at(63)); // 750 → 250 × 3
    expect(await getSession(h, id)).toMatchObject({ total_cents: 250, split_off_cents: 2250, checkout_attempt: 3 });
    const all = [...first.partIds, ...second.partIds, ...third.partIds];
    expect(await Promise.all(all.map(totalOf))).toEqual([1250, 500, 250, 250]);
    await expectFamilyAddsUp(h, id);
    expect(await owedAcross(id)).toBe(2500);
  });

  it("DTOs: the bill lists its parts; each part is a bill of its own in the Unpaid list", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 3", 60); // still on its table
    const { partIds } = await splitBill(actor, id, { ways: 3 }, at(61));

    const unpaid = (await getUnpaid()).sessions;
    expect(unpaid.map((s) => s.id).sort()).toEqual([id, ...partIds].sort());
    const parent = unpaid.find((s) => s.id === id);
    expect(parent).toMatchObject({
      kind: "table",
      label: "Table 3",
      totalCents: 834,
      splitOffCents: 1666,
      splitOfId: null,
      billedMinutes: 60,
    });
    expect(parent?.parts.map((p) => p.id).sort()).toEqual([...partIds].sort());
    expect(parent?.parts.every((p) => p.amountCents === 833 && p.status === "awaiting_payment" && p.onTerminal === false)).toBe(true);

    const part = unpaid.find((s) => s.id === partIds[0]);
    expect(part).toMatchObject({
      kind: "part",
      label: "Table 3 · share",
      status: "awaiting_payment",
      currentTableId: null,
      splitOfId: id,
      splitOffCents: 0,
      parts: [],
      totalCents: 833,
      itemsCents: 833,
      billedMinutes: 0,
      discount: null,
      intervals: [],
      checkout: null,
    });
    expect(part?.items).toEqual([expect.objectContaining({ kind: "split", productId: null, name: "Table 3 · share", unitCents: 833, quantity: 1 })]);

    // On the floor the bill is still on its table; the parts have none and count as off-table.
    const f = await getFloor();
    expect(f.sessions.map((s) => s.id)).toEqual([id]);
    expect(f.sessions[0].parts).toHaveLength(2);
    expect(f.unpaidOffTableCount).toBe(2);

    // A part's detail has an empty table-time breakdown; the bill's is its full table time.
    expect((await getSessionDetail(partIds[0])).breakdown).toEqual({ billedMinutes: 0, totalCents: 0, gstCents: 0, actualMs: 0, lines: [] });
    expect((await getSessionDetail(id)).breakdown).toMatchObject({ billedMinutes: 60, totalCents: 2500 });

    // A part on the Terminal says so on the bill it came from.
    await chargeCard(actor, partIds[0]);
    const again = (await getUnpaid()).sessions.find((s) => s.id === id);
    expect(again?.parts.find((p) => p.id === partIds[0])).toMatchObject({ onTerminal: true });
    expect(again?.parts.find((p) => p.id === partIds[1])).toMatchObject({ onTerminal: false });
  });

  it("a bill that moved tables names its parts after both; a counter sale's parts say so", async () => {
    const { actor } = h.staff;
    const { sessionId: moved } = await startSession(actor, h.tableId("Table 3"), at(0));
    await transferSession(actor, moved, h.tableId("Table 5"), at(30));
    await stopSession(actor, moved, at(60));
    const a = await splitBill(actor, moved, { ways: 2 }, at(61));
    expect((await getItems(h, a.partIds[0]))[0].name).toBe("Table 3 → Table 5 · share");

    const counter = await billOf(1000);
    const b = await splitBill(actor, counter, { ways: 2 }, at(2));
    expect((await getItems(h, b.partIds[0]))[0].name).toBe("Counter sale · share");
    const part = (await getUnpaid()).sessions.find((s) => s.id === b.partIds[0]);
    expect(part?.label).toBe("Counter sale · share");
  });

  it("refuses a bill that isn't awaiting payment, a part, an empty bill, and a bad number of ways", async () => {
    const { actor } = h.staff;
    const run = (await startSession(actor, h.tableId("Table 1"), at(0))).sessionId;
    await expect(splitBill(actor, run, { ways: 2 })).rejects.toBeInstanceOf(TransitionError);

    const paid = await awaitingPayment(h, "Table 2", 60);
    await markPaid(actor, paid, "cash", { cardConfirmed: false }, at(61));
    await expect(splitBill(actor, paid, { ways: 2 })).rejects.toBeInstanceOf(TransitionError);

    const id = await awaitingPayment(h, "Table 3", 60);
    for (const ways of [0, 1, 11, 2.5, -2, Number.NaN]) {
      await expect(splitBill(actor, id, { ways }), String(ways)).rejects.toMatchObject({ status: 400 });
    }
    const { partIds } = await splitBill(actor, id, { ways: 2 }, at(61));
    await expect(splitBill(actor, partIds[0], { ways: 2 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/can't be split again/) });
    await expect(splitBill(actor, partIds[0], { amountCents: 100 })).rejects.toMatchObject({ status: 409 });

    const { sessionId: empty } = await openCounterSale(actor, at(5));
    await expect(splitBill(actor, empty, { ways: 2 })).rejects.toMatchObject({ status: 409, message: "There's nothing left on this bill to split." });

    await expect(splitBill(actor, "nope", { ways: 2 })).rejects.toMatchObject({ status: 404 });
    expect(await owedAcross(id)).toBe(2500);
  });

  it("refuses while a card request is live or Square POS may be taking cash, and nothing is split", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await chargeCard(actor, id);
    await expect(splitBill(actor, id, { ways: 2 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(LIVE) });
    await cancelCheckout(actor, id);

    const state = stateOf((await startCashHandoff(actor, id)).url);
    await expect(splitBill(actor, id, { ways: 2 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Square POS/) });
    expect(await h.sql`select id from public.sessions where split_of = ${id}`).toHaveLength(0);
    expect(await getSession(h, id)).toMatchObject({ total_cents: 2500, split_off_cents: 0 });

    await handlePosReturn(JSON.stringify({ status: "error", error_code: "payment_canceled", state }));
    const { partIds } = await splitBill(actor, id, { ways: 2 }, at(62));
    expect(partIds).toHaveLength(1);
    await expectFamilyAddsUp(h, id);
  });

  it("the new amount goes to Square under keys it has never seen", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await chargeCard(actor, id); // attempt 1, $25.00
    await cancelCheckout(actor, id);
    await splitBill(actor, id, { ways: 2 }, at(61)); // attempt 2 skipped
    const out = await chargeCard(actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 1250 });
    expect(h.gateway.orders.at(-1)?.idempotencyKey).toBe(`${id}-o3`);
    expect(h.gateway.creates.at(-1)).toMatchObject({ idempotencyKey: `${id}-a3i`, amountCents: 1250 });
    expect(await auditActions(h, id)).not.toContain("checkout.key_conflict");
  });

  it("a bill can't be cut into more than 30 standing parts", async () => {
    const { actor } = h.staff;
    const id = await billOf(100_000);
    for (let i = 0; i < 3; i++) await splitBill(actor, id, { ways: 10 }, at(2 + i)); // 27 parts
    await splitBill(actor, id, { ways: 4 }, at(6)); // 30
    await expect(splitBill(actor, id, { ways: 2 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/too many parts/) });
    expect(await owedAcross(id)).toBe(100_000);
  });

  it("one share can't be more than the $10,000 a single bill line can hold", async () => {
    const { actor } = h.staff;
    const id = await billOf(2_100_000); // $21,000
    await expect(splitBill(actor, id, { ways: 2 })).rejects.toMatchObject({ status: 409, message: "One share can be $10,000 at most." });
    await expect(splitBill(actor, id, { amountCents: 1_000_001 })).rejects.toMatchObject({ status: 409 });
    expect(await h.sql`select id from public.sessions where split_of = ${id}`).toHaveLength(0);
    const { partIds } = await splitBill(actor, id, { amountCents: 1_000_000 }, at(2));
    expect(await totalOf(partIds[0])).toBe(1_000_000);
    expect(await owedAcross(id)).toBe(2_100_000);
    await expectFamilyAddsUp(h, id);
  });

  it("the stored total is checked against the bill before it is shared out", async () => {
    // A row left wrong by anything else (say the release before this one, mid-deploy) is put
    // right first, and what gets split is the true bill.
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 2250
    await h.sql`update public.sessions set total_cents = 2500 where id = ${id}`; // the discount "forgotten"
    await splitBill(actor, id, { ways: 2 }, at(61));
    expect(await auditActions(h, id)).toContain("session.repriced");
    expect(await owedAcross(id)).toBe(2250);
    await expectFamilyAddsUp(h, id);
  });
});

// ---------------------------------------------------------------------------
// G2. Merging back, voiding and paying parts
// ---------------------------------------------------------------------------

describe("G2. merging a part back", () => {
  it("the part becomes void and merged; its amount goes back on the bill, which skips an attempt number", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const { partIds } = await splitBill(actor, id, { ways: 3 }, at(61)); // 833, 833, parent 834
    await mergeBack(actor, partIds[0], at(65));

    const part = await getSession(h, partIds[0]);
    expect(part).toMatchObject({ status: "void", merged: true, void_reason: MERGED_REASON, voided_by: actor.staffId, kind: "part", split_of: id, total_cents: 833 });
    expect(MERGED_REASON).toBe("Merged back into the bill");
    expect(part.voided_at).toEqual(at(65));
    expect(await getSession(h, id)).toMatchObject({ split_off_cents: 833, total_cents: 1667, checkout_attempt: 2 });

    const [onBill] = await audits(h, id, "session.merge_back");
    expect(onBill.before).toMatchObject({ total_cents: 834, split_off_cents: 1666 });
    expect(onBill.after).toMatchObject({ part_id: partIds[0], amount_cents: 833, split_off_cents: 833, total_cents: 1667 });
    const [onPart] = await audits(h, partIds[0], "session.merged_back");
    expect(onPart).toMatchObject({ actor_staff_id: actor.staffId, reason: MERGED_REASON });
    expect(onPart.after).toMatchObject({ status: "void", merged: true, split_of: id });

    await expectFamilyAddsUp(h, id);
    expect(await owedAcross(id)).toBe(2500);

    // It is no longer one of the bill's parts, and no longer in the Unpaid list.
    const unpaid = (await getUnpaid()).sessions;
    expect(unpaid.map((s) => s.id).sort()).toEqual([id, partIds[1]].sort());
    expect(unpaid.find((s) => s.id === id)?.parts.map((p) => p.id)).toEqual([partIds[1]]);
    // It can't be merged twice.
    await expect(mergeBack(actor, partIds[0])).rejects.toBeInstanceOf(TransitionError);
  });

  it("merging every part back leaves an ordinary bill again", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const coke = (await addItem(actor, id, "VAR_COKE", 2)).itemId;
    const { partIds } = await splitBill(actor, id, { ways: 4 }, at(61));
    for (const p of partIds) await mergeBack(actor, p, at(62));
    expect(await getSession(h, id)).toMatchObject({ split_off_cents: 0, total_cents: 3400 });
    await expectFamilyAddsUp(h, id);
    expect((await getUnpaid()).sessions.map((s) => s.id)).toEqual([id]);

    // The discount can change again, and Square gets the itemised bill with its discount.
    await setDiscount(actor, null, id, { discountId: "D_10" });
    await chargeCard(actor, id);
    const order = h.gateway.orders[0];
    expect(order.lines.map((l) => l.uid)).toEqual(["table", coke]);
    expect(order.discount).toEqual({ uid: "discount", name: "Members 10%", amountCents: 340 });
    expect(h.gateway.creates[0].amountCents).toBe(3060);
  });

  it("any number of parts merged back, in any order, still adds up", async () => {
    const { actor } = h.staff;
    const id = await billOf(10_007);
    const { partIds } = await splitBill(actor, id, { ways: 7 }, at(2));
    for (const [i, p] of [partIds[4], partIds[0], partIds[5], partIds[2]].entries()) {
      await mergeBack(actor, p, at(3 + i));
      expect(await owedAcross(id)).toBe(10_007);
      await expectBillAddsUp(h, id);
    }
    expect(await getSession(h, id)).toMatchObject({ split_off_cents: 1429 * 2, total_cents: 10_007 - 1429 * 2 });
    await expectFamilyAddsUp(h, id);
  });

  it("only a part can be merged back", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await expect(mergeBack(actor, id)).rejects.toMatchObject({ status: 409, message: "Only a share of a split bill can be merged back." });
    const { sessionId: counter } = await openCounterSale(actor, at(5));
    await expect(mergeBack(actor, counter)).rejects.toMatchObject({ status: 409 });
    await expect(mergeBack(actor, "00000000-0000-4000-8000-0000000000ff")).rejects.toMatchObject({ status: 404 });
    await expect(mergeBack(actor, "nope")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a part that has been paid, is on the Terminal, or is with Square POS", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const { partIds } = await splitBill(actor, id, { ways: 4 }, at(61)); // 625 each
    const [paid, onTerminal, withPos] = partIds;

    await markPaid(actor, paid, "cash", { cardConfirmed: false }, at(62));
    await expect(mergeBack(actor, paid)).rejects.toBeInstanceOf(TransitionError);

    await chargeCard(actor, onTerminal);
    await expect(mergeBack(actor, onTerminal)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Cancel the card request on the Terminal for this share/) });
    await cancelCheckout(actor, onTerminal);
    await mergeBack(actor, onTerminal, at(63));

    await startCashHandoff(actor, withPos);
    await expect(mergeBack(actor, withPos)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Cash for this share was sent to Square POS/) });
    await ageHandoffs("31 minutes");
    await mergeBack(actor, withPos, at(64));

    expect(await getSession(h, id)).toMatchObject({ split_off_cents: 625, total_cents: 1875 });
    await expectFamilyAddsUp(h, id);
    expect(await owedAcross(id)).toBe(2500);
  });

  it("refuses when the bill it came from is paid, void, on the Terminal, or with Square POS", async () => {
    const { actor, managerActor, manager } = h.staff;
    // on the Terminal
    const a = await awaitingPayment(h, "Table 1", 60);
    const pa = (await splitBill(actor, a, { ways: 2 }, at(61))).partIds[0];
    await chargeCard(actor, a);
    await expect(mergeBack(actor, pa)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/is on the Terminal\. Cancel that card request first/) });
    await cancelCheckout(actor, a);
    // with Square POS
    await startCashHandoff(actor, a);
    await expect(mergeBack(actor, pa)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Cash for the bill this share came from was sent to Square POS/) });
    await ageHandoffs("31 minutes");
    // paid
    await markPaid(actor, a, "card", { cardConfirmed: true }, at(62));
    await expect(mergeBack(actor, pa)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/rest of this bill has been paid.*Take payment for the share, or ask a manager to void it/) });
    expect(await getSession(h, pa)).toMatchObject({ status: "awaiting_payment", merged: false });
    expect(await getSession(h, a)).toMatchObject({ status: "paid", total_cents: 1250, split_off_cents: 1250, settled_cents: 1250 });

    // void
    const b = await awaitingPayment(h, "Table 2", 60);
    const pb = (await splitBill(actor, b, { ways: 2 }, at(61))).partIds[0];
    await voidSession(managerActor, manager, b, "Walked out", at(62));
    await expect(mergeBack(actor, pb)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/has been voided/) });
    expect((await getSession(h, pb)).status).toBe("awaiting_payment");
  });
});

describe("G3. what can and can't be done to a part, and to a bill with parts", () => {
  it("a part takes no items, custom charges, discount, further split or time edits", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const [part] = (await splitBill(actor, id, { ways: 2 }, at(61))).partIds;
    const [line] = await getItems(h, part);

    await expect(addItem(actor, part, "VAR_COKE", 1)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(PART_FIXED) });
    await expect(addCustomItem(actor, part, "Chalk", 250)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(PART_FIXED) });
    await expect(removeItem(actor, part, line.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(PART_FIXED) });
    await expect(setDiscount(actor, null, part, { discountId: "D_10" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/share of a split bill can't be discounted/) });
    await expect(setDiscount(managerActor, manager, part, { custom: { name: "Mates", kind: "amount", value: 100 } })).rejects.toMatchObject({ status: 409 });
    await expect(removeDiscount(actor, part)).rejects.toMatchObject({ status: 409 });
    await expect(splitBill(actor, part, { ways: 2 })).rejects.toMatchObject({ status: 409 });
    await expect(editTimes(managerActor, manager, part, "Wrong times", [], at(70))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/share of a split bill has no table time/) });
    await expect(transferSession(actor, part, h.tableId("Table 2"), at(70))).rejects.toBeInstanceOf(TransitionError);
    await expect(pauseSession(actor, part, at(70))).rejects.toBeInstanceOf(TransitionError);
    await expect(stopSession(actor, part, at(70))).rejects.toBeInstanceOf(TransitionError);
    await expect(discardCounterSale(actor, part)).rejects.toMatchObject({ status: 409 });

    expect(await getSession(h, part)).toMatchObject({ status: "awaiting_payment", total_cents: 1250, items_cents: 1250, discount_kind: null, checkout_attempt: 0 });
    expect(await getItems(h, part)).toHaveLength(1);
    await expectFamilyAddsUp(h, id);
  });

  const MERGE_FIRST = "This bill has been split, so its discount can't change. Merge the parts back first.";
  const SHARE_SETTLED = "A share of this bill has already been paid or written off, so its discount can't be changed.";

  it("a bill whose parts are all unpaid: the discount can't change until they are merged back, and the message says so", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 2250
    const parts = (await splitBill(actor, id, { ways: 3 }, at(61))).partIds; // 750 each
    await expect(setDiscount(actor, null, id, { discountId: "D_125" })).rejects.toMatchObject({ status: 409, code: "conflict", message: MERGE_FIRST });
    await expect(setDiscount(managerActor, manager, id, { custom: { name: "Mates", kind: "amount", value: 1 } })).rejects.toMatchObject({ status: 409, message: MERGE_FIRST });
    await expect(removeDiscount(actor, id)).rejects.toMatchObject({ status: 409, message: MERGE_FIRST });
    expect(await getSession(h, id)).toMatchObject({ discount_id: "D_10", discount_cents: 250, total_cents: 750, split_off_cents: 1500, checkout_attempt: 2 });
    expect(await audits(h, id, "session.set_discount")).toHaveLength(1);

    // One merged back, one still out: still "merge the parts back".
    await mergeBack(actor, parts[0], at(62));
    await expect(removeDiscount(actor, id)).rejects.toMatchObject({ status: 409, message: MERGE_FIRST });
    // And the advice works: with the last one back, the discount can change.
    await mergeBack(actor, parts[1], at(63));
    await setDiscount(actor, null, id, { discountId: "D_125" });
    expect(await getSession(h, id)).toMatchObject({ discount_id: "D_125", discount_cents: 313, total_cents: 2187, split_off_cents: 0 });
    await expectFamilyAddsUp(h, id);
  });

  it("a bill with a share already paid or written off: the discount can't change, and the message doesn't suggest a merge that can't happen", async () => {
    const { actor, managerActor, manager } = h.staff;

    // A share paid.
    const a = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, a, { discountId: "D_10" });
    const [paidShare, openShare] = (await splitBill(actor, a, { ways: 3 }, at(61))).partIds;
    await markPaid(actor, paidShare, "cash", { cardConfirmed: false }, at(62));
    await expect(setDiscount(actor, null, a, { discountId: "D_125" })).rejects.toMatchObject({ status: 409, code: "conflict", message: SHARE_SETTLED });
    await expect(setDiscount(managerActor, manager, a, { custom: { name: "Mates", kind: "amount", value: 1 } })).rejects.toMatchObject({ status: 409, message: SHARE_SETTLED });
    await expect(removeDiscount(actor, a)).rejects.toMatchObject({ status: 409, message: SHARE_SETTLED });
    // Merging the unpaid one back doesn't change that: the paid share still stands.
    await mergeBack(actor, openShare, at(63));
    await expect(removeDiscount(actor, a)).rejects.toMatchObject({ status: 409, message: SHARE_SETTLED });
    expect(await getSession(h, a)).toMatchObject({ discount_id: "D_10", discount_cents: 250, split_off_cents: 750, total_cents: 1500 });
    await expectFamilyAddsUp(h, a);
    // If the manager reverses that payment, the share is unpaid again and the advice goes back to merging.
    await reversePaid(managerActor, manager, paidShare, "Wrong share");
    await expect(removeDiscount(actor, a)).rejects.toMatchObject({ status: 409, message: MERGE_FIRST });

    // A share written off by a manager: it stays split off for good.
    const b = await awaitingPayment(h, "Table 2", 60);
    await setDiscount(actor, null, b, { discountId: "D_10" });
    const [writtenOff] = (await splitBill(actor, b, { amountCents: 1000 }, at(61))).partIds;
    await voidSession(managerActor, manager, writtenOff, "Walked out", at(62));
    await expect(setDiscount(actor, null, b, { discountId: "D_125" })).rejects.toMatchObject({ status: 409, message: SHARE_SETTLED });
    await expect(removeDiscount(actor, b)).rejects.toMatchObject({ status: 409, message: SHARE_SETTLED });
    expect(await getSession(h, b)).toMatchObject({ discount_id: "D_10", discount_cents: 250, total_cents: 1250, split_off_cents: 1000 });
    await expectFamilyAddsUp(h, b);
  });

  it("a bill with parts: items can go on; one can come off only if the bill still covers what was split off", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const coke = (await addItem(actor, id, "VAR_COKE", 2)).itemId; // 3400
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 340 off → 3060
    await splitBill(actor, id, { amountCents: 2400 }, at(61)); // 660 left

    // Without the Coke: 2500 − 250 − 2400 = −150.
    await expect(removeItem(actor, id, coke, at(62))).rejects.toMatchObject({
      status: 409,
      message: "That would leave less on this bill than has been split off it. Merge the parts back first.",
    });
    expect((await getItems(h, id))[0].removed_at).toBeNull();
    expect(await getSession(h, id)).toMatchObject({ items_cents: 900, discount_cents: 340, total_cents: 660, split_off_cents: 2400 });

    // Something added: the percentage follows, the split stays.
    const chips = (await addItem(actor, id, "VAR_CHIPS", 1)).itemId; // base 4000 → 400 off → 1200
    expect(await getSession(h, id)).toMatchObject({ items_cents: 1500, discount_cents: 400, total_cents: 1200, split_off_cents: 2400 });
    await expectFamilyAddsUp(h, id);
    // Chips off again is fine (back to 660) …
    await removeItem(actor, id, chips, at(63));
    expect(await totalOf(id)).toBe(660);
    // … and so is the Coke once there is room: 2500 + 600 − 310 − 2400 = 390.
    await addItem(actor, id, "VAR_CHIPS", 1);
    await removeItem(actor, id, coke, at(64));
    expect(await getSession(h, id)).toMatchObject({ items_cents: 600, discount_cents: 310, total_cents: 390 });
    await expectFamilyAddsUp(h, id);
    expect(await owedAcross(id)).toBe(390 + 2400);
  });

  it("a bill with parts: times can be edited only if the bill still covers what was split off", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60); // 2500
    await splitBill(actor, id, { amountCents: 1500 }, at(61)); // 1000 left
    const [iv] = await getIntervals(h, id);

    // 30 minutes would be $12.50, less than the $15.00 already split off.
    await expect(
      editTimes(managerActor, manager, id, "Timer left running", [{ id: iv.id, startedAt: at(0), endedAt: at(30) }], at(120)),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/less on this bill than has been split off/) });
    const [same] = await getIntervals(h, id);
    expect(same.ended_at).toEqual(at(60)); // nothing was kept
    expect(await getSession(h, id)).toMatchObject({ total_cents: 1000, billed_minutes: 60, checkout_attempt: 1 });
    expect(await audits(h, id, "session.edit_times")).toHaveLength(0);

    // 45 minutes is $18.75: fine, $3.75 left.
    const r = await editTimes(managerActor, manager, id, "Timer left running", [{ id: iv.id, startedAt: at(0), endedAt: at(45) }], at(120));
    expect(r.totalCents).toBe(375);
    expect(await getSession(h, id)).toMatchObject({ total_cents: 375, billed_minutes: 45, split_off_cents: 1500, checkout_attempt: 2 });
    await expectFamilyAddsUp(h, id);
  });

  it("a manager can void a part: that share is written off and stays split off", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const { partIds } = await splitBill(actor, id, { ways: 3 }, at(61));
    expect(await voidSession(managerActor, manager, partIds[0], "Walked out", at(65))).toEqual({ kind: "voided" });

    expect(await getSession(h, partIds[0])).toMatchObject({ status: "void", merged: false, void_reason: "Walked out", voided_by: manager.id, total_cents: 833 });
    // The bill is exactly as it was: nothing comes back onto it.
    expect(await getSession(h, id)).toMatchObject({ total_cents: 834, split_off_cents: 1666, checkout_attempt: 1 });
    await expectFamilyAddsUp(h, id);
    const parent = (await getUnpaid()).sessions.find((s) => s.id === id);
    expect(parent?.parts.map((p) => [p.id, p.status]).sort()).toEqual(
      [[partIds[0], "void"], [partIds[1], "awaiting_payment"]].sort(),
    );
    // A written-off share can't be merged back.
    await expect(mergeBack(actor, partIds[0])).rejects.toBeInstanceOf(TransitionError);
  });

  it("a part is paid like any bill, and a manager can reverse that", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const [cashPart, cardPart] = (await splitBill(actor, id, { ways: 3 }, at(61))).partIds; // 833 each

    expect(await markPaid(actor, cashPart, "cash", { cardConfirmed: false }, at(62))).toMatchObject({ kind: "paid", amountCents: 835 });
    expect(await getSession(h, cashPart)).toMatchObject({ status: "paid", settled_method: "cash", settled_cents: 835, total_cents: 833 });

    expect(await chargeCard(actor, cardPart)).toMatchObject({ kind: "sent", amountCents: 833 });
    await webhookPaid("chk_1", cardPart, 833);
    expect(await getSession(h, cardPart)).toMatchObject({ status: "paid", settled_method: "card", settled_via: "square_webhook", settled_cents: 833 });
    expect(await audits(h, cardPart, "payment.conflict")).toHaveLength(0);

    // The bill it came from is untouched by either payment, and is paid for what is left on it.
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", total_cents: 834, split_off_cents: 1666 });
    await markPaid(actor, id, "card", { cardConfirmed: true }, at(63));
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_cents: 834 });
    const parent = (await getSessionDetail(id)).session;
    expect(parent.parts.map((p) => p.status)).toEqual(["paid", "paid"]);
    await expectFamilyAddsUp(h, id);

    // Reversed, the part is simply unpaid again.
    await reversePaid(managerActor, manager, cashPart, "Wrong share");
    expect(await getSession(h, cashPart)).toMatchObject({ status: "awaiting_payment", settled_cents: null, total_cents: 833 });
    await expectFamilyAddsUp(h, id);
  });
});

// ---------------------------------------------------------------------------
// G4. A split bill in Square
// ---------------------------------------------------------------------------

describe("G4. a split bill in Square: one line each, never itemised, no discount line", () => {
  async function splitDiscountedBill(): Promise<{ id: string; partId: string }> {
    const { actor } = h.staff;
    const { sessionId: id } = await startSession(actor, h.tableId("Table 3"), at(0));
    await addItem(actor, id, "VAR_COKE", 2);
    await addItem(actor, id, "VAR_WATER", 1);
    await setDiscount(actor, null, id, { discountId: "D_10" });
    await stopSession(actor, id, at(80)); // 80 min = 3333; + 1200 = 4533; 453.3 → 453 off → 4080
    expect(await totalOf(id)).toBe(4080);
    const [partId] = (await splitBill(actor, id, { ways: 2 }, at(81))).partIds; // 2040 + 2040
    return { id, partId };
  }

  it("card, the bill that was split: one ad hoc line for what is left on it", async () => {
    await h.sql`update public.catalog_state set table_hire_variation_id = 'VAR_TABLE_HIRE'`;
    const { id } = await splitDiscountedBill();
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 2040 });

    expect(h.gateway.orders).toHaveLength(1);
    const order = h.gateway.orders[0];
    expect(order.lines).toEqual([
      { uid: "split", catalogObjectId: null, name: "Table 3 · 1h 20m · part of a split bill", quantity: 1, basePriceCents: 2040, note: expect.stringMatching(/^Table 3 · 1h 20m · /) },
    ]);
    expect("discount" in order).toBe(false);
    expect(h.gateway.creates[0]).toMatchObject({ amountCents: 2040, orderId: "ord_1" });
    expect(await auditActions(h, id)).not.toContain("checkout.itemise_failed");
  });

  it("card, a part: one ad hoc line for its amount", async () => {
    const { id, partId } = await splitDiscountedBill();
    const out = await chargeCard(h.staff.actor, partId);
    expect(out).toMatchObject({ kind: "sent", amountCents: 2040 });
    const order = h.gateway.orders[0];
    expect(order).toMatchObject({ idempotencyKey: `${partId}-o1`, referenceId: partId });
    expect(order.lines).toEqual([
      { uid: "split", catalogObjectId: null, name: "Table 3 · share of a split bill", quantity: 1, basePriceCents: 2040, note: "Table 3 · share · 11:21" },
    ]);
    expect("discount" in order).toBe(false);
    expect(h.gateway.creates[0]).toMatchObject({ idempotencyKey: `${partId}-a1i`, amountCents: 2040, referenceId: partId, note: "Table 3 · share · 11:21" });

    await webhookPaid("chk_1", partId, 2040);
    expect((await getSession(h, partId)).status).toBe("paid");
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    expect(await getCheckouts(h, id)).toHaveLength(0);
  });

  it("cash: the stored order for each is that same single line", async () => {
    const { actor } = h.staff;
    const { id, partId } = await splitDiscountedBill();
    await markPaid(actor, partId, "cash", { cardConfirmed: false }, at(82));
    await markPaid(actor, id, "cash", { cardConfirmed: false }, at(83));

    const [partRec] = await records(partId);
    expect(partRec).toMatchObject({ amount_cents: 2040, bill_cents: 2040 });
    expect(partRec.order_lines).toEqual([
      { uid: "split", catalogObjectId: null, name: "Table 3 · share of a split bill", quantity: 1, basePriceCents: 2040, note: "Table 3 · share · 11:21" },
    ]);
    const [billRec] = await records(id);
    expect(billRec.order_lines).toEqual([
      expect.objectContaining({ uid: "split", catalogObjectId: null, name: "Table 3 · 1h 20m · part of a split bill", basePriceCents: 2040 }),
    ]);

    expect(await pushCashRecords()).toBe(2);
    expect(h.gateway.orders).toHaveLength(2);
    expect(h.gateway.orders.every((o) => o.lines.length === 1 && !("discount" in o))).toBe(true);
    expect(h.gateway.cashPayments.map((p) => p.amountCents)).toEqual([2040, 2040]);
    expect((await records(partId))[0].state).toBe("recorded");
    expect((await records(id))[0].state).toBe("recorded");
    expect(await audits(h, id, "square.cash_itemise_failed")).toHaveLength(0);
  });

  it("a bill whose only part was written off is still a split bill in Square", async () => {
    const { actor, managerActor, manager } = h.staff;
    const { id, partId } = await splitDiscountedBill();
    await voidSession(managerActor, manager, partId, "Walked out", at(82));
    await chargeCard(actor, id);
    expect(h.gateway.orders[0].lines).toEqual([expect.objectContaining({ uid: "split", basePriceCents: 2040 })]);
    expect("discount" in h.gateway.orders[0]).toBe(false);
  });

  it("a counter sale that was split says so too", async () => {
    const { actor } = h.staff;
    const id = await billOf(1001);
    const [partId] = (await splitBill(actor, id, { ways: 2 }, at(2))).partIds; // part 500, bill keeps 501
    await chargeCard(actor, id);
    expect(h.gateway.orders[0].lines).toEqual([
      { uid: "split", catalogObjectId: null, name: "Counter sale · part of a split bill", quantity: 1, basePriceCents: 501, note: "Counter sale · 10:01" },
    ]);
    await chargeCard(actor, partId);
    expect(h.gateway.orders[1].lines).toEqual([
      { uid: "split", catalogObjectId: null, name: "Counter sale · share of a split bill", quantity: 1, basePriceCents: 500, note: "Counter sale · share · 10:02" },
    ]);
  });

  it("the Square POS handoff for a part is for its amount, with a note that says what it is", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const [partId] = (await splitBill(actor, id, { ways: 3 }, at(61))).partIds; // 833
    const out = await startCashHandoff(actor, partId);
    expect(out.amountCents).toBe(835);
    const notes = (JSON.parse(decodeURIComponent(out.url.slice(PREFIX.length))) as { notes: string }).notes;
    expect(notes).toBe(`Table 1 · share · 11:01 · ref ${partId.slice(0, 8)}`);
  });
});

// ---------------------------------------------------------------------------
// The daily summary
// ---------------------------------------------------------------------------

describe("G5. the daily summary with discounts, counter sales and split bills", () => {
  const run = async (table: string, from: string, to: string): Promise<string> => {
    const s = await startSession(h.staff.actor, h.tableId(table), local(from));
    await stopSession(h.staff.actor, s.sessionId, local(to));
    return s.sessionId;
  };

  it("an intact split counts once, for the whole bill; every unpaid piece is listed", async () => {
    const { actor } = h.staff;
    const { sessionId: id } = await startSession(actor, h.tableId("Table 1"), local("2026-11-20T09:00:00"));
    await addItem(actor, id, "VAR_COKE", 2); // 900
    await setDiscount(actor, null, id, { discountId: "D_10" });
    await stopSession(actor, id, local("2026-11-20T10:00:00")); // 3400 − 340 = 3060
    const parts = (await splitBill(actor, id, { ways: 3 }, local("2026-11-20T10:01:00"))).partIds; // 1020 each

    const sum = await getSummary("2026-11-20");
    expect(sum.sessions).toEqual({ count: 1, billedMinutes: 60, billedCents: 3060, tableCents: 2500, itemsCents: 900, discountCents: 340, writtenOffCents: 0 });
    expect(sum.sessions.tableCents + sum.sessions.itemsCents - sum.sessions.discountCents).toBe(sum.sessions.billedCents);
    expect(sum.itemsSold).toEqual([{ productId: "VAR_COKE", name: "Coke", quantity: 2, cents: 900 }]);
    expect(sum.unpaid.count).toBe(3);
    expect(sum.unpaid.cents).toBe(3060);
    expect(sum.unpaid.items[0]).toMatchObject({ id, kind: "table", tableNames: "Table 1", billedMinutes: 60, totalCents: 1020 });
    expect(sum.unpaid.items.slice(1).map((r) => r.id).sort()).toEqual([...parts].sort());
    for (const r of sum.unpaid.items.slice(1)) {
      expect(r).toMatchObject({ kind: "part", tableNames: "Table 1 · share", billedMinutes: 0, totalCents: 1020 });
    }
    expect(sum.voids).toEqual({ count: 0, items: [] });
    expect(sum.paidItems).toEqual([]);
  });

  it("a day with everything on it: every figure", async () => {
    const { actor, managerActor, manager } = h.staff;

    // A. A discounted table bill, paid by card. 2500 + 900, 10% off = 3060.
    const { sessionId: a } = await startSession(actor, h.tableId("Table 1"), local("2026-11-20T06:10:00"));
    await addItem(actor, a, "VAR_COKE", 2);
    await setDiscount(actor, null, a, { discountId: "D_10" });
    await stopSession(actor, a, local("2026-11-20T07:10:00"));
    await markPaid(actor, a, "card", { cardConfirmed: true }, local("2026-11-20T07:12:00"));

    // B. A counter sale, paid in cash. 600 + 252 = 852, collected as 850.
    const { sessionId: b } = await openCounterSale(actor, local("2026-11-20T08:00:00"));
    await addItem(actor, b, "VAR_CHIPS", 1);
    await addCustomItem(actor, b, "Chalk", 252);
    await markPaid(actor, b, "cash", { cardConfirmed: false }, local("2026-11-20T08:01:00"));

    // C. A split bill: 2500 + 300 = 2800, three ways (933, 933, the bill keeps 934).
    //    One part paid in cash (935 collected), one voided by a manager, the bill itself unpaid.
    const { sessionId: c } = await startSession(actor, h.tableId("Table 2"), local("2026-11-20T09:00:00"));
    await addItem(actor, c, "VAR_WATER", 1);
    await stopSession(actor, c, local("2026-11-20T10:00:00"));
    const [cPaid, cVoid] = (await splitBill(actor, c, { ways: 3 }, local("2026-11-20T10:01:00"))).partIds;
    await markPaid(actor, cPaid, "cash", { cardConfirmed: false }, local("2026-11-20T10:05:00"));
    await voidSession(managerActor, manager, cVoid, "Walked out", local("2026-11-20T10:10:00"));

    // D. A bill split and merged back again: 90 minutes = 3750, unpaid.
    const d = await run("Table 3", "2026-11-20T11:00:00", "2026-11-20T12:30:00");
    const [dMerged] = (await splitBill(actor, d, { ways: 2 }, local("2026-11-20T12:31:00"))).partIds;
    await mergeBack(actor, dMerged, local("2026-11-20T12:40:00"));

    // E. A counter sale opened by mistake and thrown away.
    const { sessionId: e } = await openCounterSale(actor, local("2026-11-20T13:00:00"));
    await discardCounterSale(actor, e, local("2026-11-20T13:01:00"));

    for (const id of [a, b, d, e]) await expectBillAddsUp(h, id);
    await expectFamilyAddsUp(h, c);
    await expectFamilyAddsUp(h, d);

    const sum = await getSummary("2026-11-20");

    // Billed: every bill that isn't void, for what is owed on it.
    //   A 3060 + B 852 + C 934 + C's paid part 933 + D 3750 = 9529
    //   (C's voided part 933, D's merged-back part and the thrown-away sale are not in it.)
    // Sessions, minutes, items and discounts: the four table and counter bills.
    //   items: A 900 + B 852 + C 300 = 2052; discounts: A 340
    // Written off: C's voided share, 933. (D's merged-back part is not a write-off.)
    // Table time is the rest: 9529 − 2052 + 340 + 933 = 8750, which is the real table time:
    // 2500 + 2500 + 3750.
    expect(sum.sessions).toEqual({
      count: 4,
      billedMinutes: 60 + 0 + 60 + 90,
      billedCents: 9529,
      tableCents: 8750,
      itemsCents: 2052,
      discountCents: 340,
      writtenOffCents: 933,
    });
    const t = sum.sessions;
    expect(t.tableCents + t.itemsCents - t.discountCents - t.writtenOffCents).toBe(t.billedCents);
    expect(t.tableCents).toBe(2500 + 2500 + 3750);

    expect(sum.itemsSold).toEqual([
      { productId: "VAR_COKE", name: "Coke", quantity: 2, cents: 900 },
      { productId: "VAR_CHIPS", name: "Chips", quantity: 1, cents: 600 },
      { productId: "VAR_WATER", name: "Water", quantity: 1, cents: 300 },
      { productId: null, name: "Chalk", quantity: 1, cents: 252 },
    ]);
    expect(sum.itemsSold.reduce((n, i) => n + i.cents, 0)).toBe(sum.sessions.itemsCents);

    // Paid: what was collected. Cash is B 850 + C's part 935; the 5c rounding nets to nothing.
    expect(sum.paid.card).toEqual({ count: 1, cents: 3060 });
    expect(sum.paid.cash).toEqual({ count: 2, cents: 1785, roundingCents: 0 });
    expect(sum.paidItems.map((p) => [p.id, p.kind, p.tableNames, p.method, p.totalCents, p.settledCents, p.billedMinutes])).toEqual([
      [a, "table", "Table 1", "card", 3060, 3060, 60],
      [b, "counter", "Counter sale", "cash", 852, 850, 0],
      [cPaid, "part", "Table 2 · share", "cash", 933, 935, 0],
    ]);
    // Neither cash sale has been sent to Square yet in this test.
    expect(sum.squareCashOutstanding).toEqual({ count: 2, cents: 1785, failed: 0 });

    // Unpaid: C for what is left on it, and D back at its full amount.
    expect(sum.unpaid.count).toBe(2);
    expect(sum.unpaid.cents).toBe(934 + 3750);
    expect(sum.unpaid.items.map((r) => [r.id, r.kind, r.tableNames, r.totalCents])).toEqual([
      [c, "table", "Table 2", 934],
      [d, "table", "Table 3", 3750],
    ]);
    expect(sum.outstandingOlder).toEqual({ count: 0, cents: 0 });

    // Voids: the share a manager wrote off, and only that.
    expect(sum.voids.count).toBe(1);
    expect(sum.voids.items).toEqual([
      expect.objectContaining({ id: cVoid, kind: "part", tableNames: "Table 2 · share", totalCents: 933, billedMinutes: 0, reason: "Walked out", voidedByName: "Mia Manager" }),
    ]);

    // The merged-back part and the thrown-away sale appear nowhere.
    const everywhere = JSON.stringify(sum);
    expect(everywhere).not.toContain(dMerged);
    expect(everywhere).not.toContain(e);

    // Billed is exactly what was or will be collected on bills, before cash rounding:
    // paid bills' totals + unpaid.
    const paidBills = sum.paidItems.reduce((n, p) => n + (p.totalCents ?? 0), 0);
    expect(paidBills + sum.unpaid.cents).toBe(sum.sessions.billedCents);
    expect(() => JSON.stringify(sum)).not.toThrow();
  });

  it("the rest of a split bill voided after a share was paid: the paid share stays in billed", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await run("Table 4", "2026-11-20T09:00:00", "2026-11-20T10:00:00"); // 2500
    const [share] = (await splitBill(actor, id, { ways: 2 }, local("2026-11-20T10:01:00"))).partIds; // 1250 + 1250
    await markPaid(actor, share, "card", { cardConfirmed: true }, local("2026-11-20T10:02:00"));
    await voidSession(managerActor, manager, id, "Walked out", local("2026-11-20T10:30:00"));
    // The void leaves the paid share alone.
    expect(await getSession(h, share)).toMatchObject({ status: "paid", total_cents: 1250, settled_cents: 1250 });
    expect(await getSession(h, id)).toMatchObject({ status: "void", total_cents: 1250, split_off_cents: 1250 });

    const sum = await getSummary("2026-11-20");
    // The bill itself is void, so it is not a session; its paid share is still money billed.
    expect(sum.sessions).toEqual({ count: 0, billedMinutes: 0, billedCents: 1250, tableCents: 1250, itemsCents: 0, discountCents: 0, writtenOffCents: 0 });
    expect(sum.paid.card).toEqual({ count: 1, cents: 1250 });
    expect(sum.paidItems.map((p) => [p.id, p.kind, p.totalCents])).toEqual([[share, "part", 1250]]);
    expect(sum.unpaid).toMatchObject({ count: 0, cents: 0 });
    expect(sum.voids.items.map((v) => [v.id, v.kind, v.tableNames, v.totalCents, v.reason])).toEqual([[id, "table", "Table 4", 1250, "Walked out"]]);
  });

  it("a share written off on a counter sale: table time is $0.00, not negative", async () => {
    // $30.00 at the counter, split 2 ways, a manager voids one share, the rest is paid.
    const { actor, managerActor, manager } = h.staff;
    const { sessionId: id } = await openCounterSale(actor, local("2026-11-20T09:00:00"));
    await addCustomItem(actor, id, "Cue", 3000);
    const [share] = (await splitBill(actor, id, { ways: 2 }, local("2026-11-20T09:01:00"))).partIds;
    await voidSession(managerActor, manager, share, "Walked out", local("2026-11-20T09:05:00"));
    await markPaid(actor, id, "card", { cardConfirmed: true }, local("2026-11-20T09:06:00"));

    const sum = await getSummary("2026-11-20");
    expect(sum.sessions).toEqual({
      count: 1,
      billedMinutes: 0,
      billedCents: 1500,
      tableCents: 0,
      itemsCents: 3000,
      discountCents: 0,
      writtenOffCents: 1500,
    });
    const t = sum.sessions;
    expect(t.tableCents + t.itemsCents - t.discountCents - t.writtenOffCents).toBe(t.billedCents);
    expect(sum.paid.card).toEqual({ count: 1, cents: 1500 });
    expect(sum.voids.items.map((v) => [v.id, v.totalCents])).toEqual([[share, 1500]]);
    // what was written off on the summary is what the void list shows
    expect(sum.voids.items.reduce((n, v) => n + (v.totalCents ?? 0), 0)).toBe(t.writtenOffCents);
  });

  it("a share written off on a table's bill with items and a discount: table time is the real table time", async () => {
    // 60 minutes ($25.00) + 2 Cokes ($9.00), 10% off ($3.40) = $30.60, three ways ($10.20 each).
    const { actor, managerActor, manager } = h.staff;
    const { sessionId: id } = await startSession(actor, h.tableId("Table 1"), local("2026-11-20T09:00:00"));
    await addItem(actor, id, "VAR_COKE", 2);
    await setDiscount(actor, null, id, { discountId: "D_10" });
    await stopSession(actor, id, local("2026-11-20T10:00:00"));
    const [gone, paid] = (await splitBill(actor, id, { ways: 3 }, local("2026-11-20T10:01:00"))).partIds;
    await voidSession(managerActor, manager, gone, "Walked out", local("2026-11-20T10:05:00"));
    await markPaid(actor, paid, "card", { cardConfirmed: true }, local("2026-11-20T10:06:00"));

    const sum = await getSummary("2026-11-20");
    expect(sum.sessions).toEqual({
      count: 1,
      billedMinutes: 60,
      billedCents: 2040, // the bill's own $10.20 (unpaid) + the paid share's $10.20
      tableCents: 2500,
      itemsCents: 900,
      discountCents: 340,
      writtenOffCents: 1020,
    });
    const t = sum.sessions;
    expect(t.tableCents + t.itemsCents - t.discountCents - t.writtenOffCents).toBe(t.billedCents);

    // Merged back instead of written off, nothing is written off and the bill is whole again.
    const { sessionId: other } = await startSession(actor, h.tableId("Table 2"), local("2026-11-20T11:00:00"));
    await stopSession(actor, other, local("2026-11-20T12:00:00"));
    const [back] = (await splitBill(actor, other, { ways: 2 }, local("2026-11-20T12:01:00"))).partIds;
    await mergeBack(actor, back, local("2026-11-20T12:02:00"));
    const again = (await getSummary("2026-11-20")).sessions;
    expect(again).toEqual({ count: 2, billedMinutes: 120, billedCents: 4540, tableCents: 5000, itemsCents: 900, discountCents: 340, writtenOffCents: 1020 });
  });

  it("a merged-back part is nowhere: not billed, not unpaid, not a void", async () => {
    const { actor } = h.staff;
    const id = await run("Table 5", "2026-11-20T09:00:00", "2026-11-20T10:00:00");
    const [share] = (await splitBill(actor, id, { ways: 2 }, local("2026-11-20T10:01:00"))).partIds;
    await mergeBack(actor, share, local("2026-11-20T10:05:00"));
    const sum = await getSummary("2026-11-20");
    expect(sum.sessions).toEqual({ count: 1, billedMinutes: 60, billedCents: 2500, tableCents: 2500, itemsCents: 0, discountCents: 0, writtenOffCents: 0 });
    expect(sum.unpaid.items.map((r) => [r.id, r.totalCents])).toEqual([[id, 2500]]);
    expect(sum.voids).toEqual({ count: 0, items: [] });
    expect(JSON.stringify(sum)).not.toContain(share);
  });

  it("a bill split the morning after still counts whole on the day it was closed", async () => {
    const { actor } = h.staff;
    const id = await run("Table 6", "2026-11-20T22:00:00", "2026-11-20T23:00:00"); // 2500, left unpaid overnight
    const [share] = (await splitBill(actor, id, { ways: 2 }, local("2026-11-21T07:00:00"))).partIds; // next business day

    const day = await getSummary("2026-11-20");
    expect(day.sessions).toEqual({ count: 1, billedMinutes: 60, billedCents: 2500, tableCents: 2500, itemsCents: 0, discountCents: 0, writtenOffCents: 0 });
    expect(day.unpaid.items.map((r) => [r.id, r.totalCents])).toEqual([[id, 1250]]);

    const next = await getSummary("2026-11-21");
    expect(next.sessions).toEqual({ count: 0, billedMinutes: 0, billedCents: 0, tableCents: 0, itemsCents: 0, discountCents: 0, writtenOffCents: 0 });
    // The share was made today, so it is on today's unpaid list; the bill it came from is "older".
    expect(next.unpaid.items.map((r) => [r.id, r.kind, r.totalCents])).toEqual([[share, "part", 1250]]);
    expect(next.outstandingOlder).toEqual({ count: 1, cents: 1250 });
  });
});
