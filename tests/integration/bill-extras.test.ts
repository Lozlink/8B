import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Square } from "square";
import { bootHarness, type Harness } from "./helpers/harness";
import { squareRejection } from "./helpers/fake-gateway";
import {
  at,
  audits,
  auditActions,
  awaitingPayment,
  expectBillAddsUp,
  getCheckouts,
  getIntervals,
  getItems,
  getSession,
  seedDiscount,
  seedProduct,
} from "./helpers/util";
import { TransitionError } from "@/lib/domain/machine";
import { getAdminState } from "@/lib/server/admin";
import { withTx } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { refreshProductsInBackground, syncProducts } from "@/lib/server/items";
import { handlePosReturn, markPaidCheckingPos, startCashHandoff } from "@/lib/server/pos-cash";
import { getFloor, getSessionDetail, getSummary, getUnpaid } from "@/lib/server/queries";
import {
  COUNTER_LABEL,
  DISCARD_REASON,
  addCustomItem,
  addItem,
  applyWebhookCheckout,
  cancelCheckout,
  chargeCard,
  discardCounterSale,
  editTimes,
  markPaid,
  openCounterSale,
  pauseSession,
  removeDiscount,
  removeItem,
  resumeSession,
  reversePaid,
  setDiscount,
  splitBill,
  startSession,
  stopSession,
  transferSession,
  voidSession,
} from "@/lib/server/sessions";
import { parseStoredOrder, pushCashRecords, storedOrderJson, type CashRecordRow } from "@/lib/server/square-cash";
import { mapCatalog, percentageToBasisPoints } from "@/lib/square/catalog";

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
});

const LIVE = /Cancel the card request on the Terminal before changing the bill/;
const LOC = "LOC_TEST";

const running = async (table = "Table 1") => (await startSession(h.staff.actor, h.tableId(table), at(0))).sessionId;
const records = (sessionId: string) =>
  h.sql<CashRecordRow[]>`select * from public.square_cash_records where session_id = ${sessionId} order by seq`;
const webhookPaid = (checkoutId: string, sessionId: string, amountCents: number) =>
  withTx((tx) => applyWebhookCheckout(tx, { id: checkoutId, status: "COMPLETED", referenceId: sessionId, cancelReason: null, amountCents }));
/** Stands in for time passing since a bill was handed to Square POS (the audit log itself can't be edited). */
async function ageHandoffs(ago: string): Promise<void> {
  await h.raw(null, `alter table public.audit_log disable trigger audit_log_no_update`);
  try {
    await h.raw(null, `update public.audit_log set at = now() - interval '${ago}' where action = 'cash.handoff_started'`);
  } finally {
    await h.raw(null, `alter table public.audit_log enable trigger audit_log_no_update`);
  }
}
const PREFIX = "square-commerce-v1://payment/create?data=";
const linkData = (url: string) => JSON.parse(decodeURIComponent(url.slice(PREFIX.length))) as { notes: string; state: string };

// ---------------------------------------------------------------------------
// D. Custom charge
// ---------------------------------------------------------------------------

describe("D. custom charge", () => {
  it("running: a line with a typed name and price, no product, quantity 1, GST included", async () => {
    const { actor } = h.staff;
    const id = await running();
    const { itemId } = await addCustomItem(actor, id, "  Cue repair  ", 1500);

    expect(await getItems(h, id)).toEqual([
      expect.objectContaining({
        id: itemId,
        kind: "custom",
        product_id: null,
        name: "Cue repair",
        unit_cents: 1500,
        quantity: 1,
        taxed: true,
        added_by: actor.staffId,
        removed_at: null,
      }),
    ]);
    expect(await getSession(h, id)).toMatchObject({ items_cents: 1500, total_cents: null, checkout_attempt: 0, status: "running" });

    const [row] = await audits(h, id, "session.add_item");
    expect(row.actor_staff_id).toBe(actor.staffId);
    expect(row.before).toMatchObject({ items_cents: 0, total_cents: null });
    expect(row.after).toMatchObject({
      item_id: itemId,
      kind: "custom",
      product_id: null,
      name: "Cue repair",
      unit_cents: 1500,
      quantity: 1,
      taxed: true,
      items_cents: 1500,
      total_cents: null,
    });
    await expectBillAddsUp(h, id);
  });

  it("paused: allowed; and it is priced with the rest of the bill at stop", async () => {
    const { actor } = h.staff;
    const id = await running();
    await pauseSession(actor, id, at(10));
    await addCustomItem(actor, id, "Chalk", 250);
    await resumeSession(actor, id, at(10));
    expect(await stopSession(actor, id, at(60))).toEqual({ status: "awaiting_payment", billedMinutes: 60, totalCents: 2750 });
    await expectBillAddsUp(h, id);
  });

  it("awaiting payment: the total moves with it and an attempt number is skipped", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60); // 2500
    await addCustomItem(actor, id, "Cue repair", 1500);
    expect(await getSession(h, id)).toMatchObject({ items_cents: 1500, total_cents: 4000, billed_minutes: 60, checkout_attempt: 1 });
    const [row] = await audits(h, id, "session.add_item");
    expect(row.before).toMatchObject({ items_cents: 0, total_cents: 2500 });
    expect(row.after).toMatchObject({ items_cents: 1500, total_cents: 4000 });
    await expectBillAddsUp(h, id);

    const out = await chargeCard(actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 4000 });
    expect(h.gateway.creates[0].idempotencyKey).toBe(`${id}-a2i`);
    expect(await auditActions(h, id)).not.toContain("session.repriced");
  });

  it("goes to Square as an ad hoc line under its own name, with no catalogue id and no discount", async () => {
    const { actor } = h.staff;
    const id = await running();
    const coke = (await addItem(actor, id, "VAR_COKE", 2)).itemId;
    const custom = (await addCustomItem(actor, id, "Cue repair", 1500)).itemId;
    await stopSession(actor, id, at(60)); // 2500 + 900 + 1500
    await chargeCard(actor, id);

    const order = h.gateway.orders[0];
    expect(order.lines).toEqual([
      { uid: "table", catalogObjectId: null, name: "Table hire", quantity: 1, basePriceCents: 2500, note: expect.stringMatching(/Table 1 · 1h/) },
      { uid: coke, catalogObjectId: "VAR_COKE", name: null, quantity: 2, basePriceCents: 450, note: null },
      { uid: custom, catalogObjectId: null, name: "Cue repair", quantity: 1, basePriceCents: 1500, note: null },
    ]);
    // A bill with no discount sends exactly the body it always has: no `discount` key at all.
    expect("discount" in order).toBe(false);
    expect(h.gateway.creates[0]).toMatchObject({ amountCents: 4900, orderId: "ord_1" });
  });

  it("is in the cash sale's stored order too, which stays a plain array of lines", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const custom = (await addCustomItem(actor, id, "Cue repair", 1500)).itemId;
    await markPaid(actor, id, "cash", { cardConfirmed: false }, at(70));

    const [rec] = await records(id);
    expect(rec).toMatchObject({ amount_cents: 4000, bill_cents: 4000, state: "pending" });
    expect(Array.isArray(rec.order_lines)).toBe(true);
    expect(rec.order_lines).toEqual([
      expect.objectContaining({ uid: "table", basePriceCents: 2500 }),
      { uid: custom, catalogObjectId: null, name: "Cue repair", quantity: 1, basePriceCents: 1500, note: null },
    ]);

    expect(await pushCashRecords()).toBe(1);
    expect(h.gateway.orders[0].lines[1]).toEqual({ uid: custom, catalogObjectId: null, name: "Cue repair", quantity: 1, basePriceCents: 1500, note: null });
    expect("discount" in h.gateway.orders[0]).toBe(false);
    expect(h.gateway.cashPayments[0]).toMatchObject({ amountCents: 4000, orderId: "ord_1" });
    expect((await records(id))[0].state).toBe("recorded");
  });

  it("comes off again with removeItem, like any line", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const { itemId } = await addCustomItem(actor, id, "Cue repair", 1500);
    await removeItem(actor, id, itemId, at(65));
    const [item] = await getItems(h, id);
    expect(item.removed_by).toBe(actor.staffId);
    expect(await getSession(h, id)).toMatchObject({ items_cents: 0, total_cents: 2500, checkout_attempt: 2 });
    await expectBillAddsUp(h, id);
  });

  it("name must be 1–60 characters and the amount 1c–$2,000, in whole cents", async () => {
    const { actor } = h.staff;
    const id = await running();
    for (const name of ["", "   ", "x".repeat(61)]) {
      await expect(addCustomItem(actor, id, name, 500), JSON.stringify(name)).rejects.toMatchObject({ status: 400 });
    }
    for (const cents of [0, -1, 200_001, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(addCustomItem(actor, id, "Chalk", cents), String(cents)).rejects.toMatchObject({ status: 400 });
    }
    expect(await getItems(h, id)).toHaveLength(0);
    // the edges themselves are fine
    await addCustomItem(actor, id, "x".repeat(60), 1);
    await addCustomItem(actor, id, "Function hire", 200_000);
    expect((await getSession(h, id)).items_cents).toBe(200_001);
    await expectBillAddsUp(h, id);
  });

  it("same refusals as add-item: paid, void, a live card request, an unknown bill", async () => {
    const { actor, managerActor, manager } = h.staff;
    const paid = await awaitingPayment(h, "Table 1", 60);
    await markPaid(actor, paid, "cash", { cardConfirmed: false }, at(61));
    await expect(addCustomItem(actor, paid, "Chalk", 250)).rejects.toBeInstanceOf(TransitionError);

    const voided = await running("Table 2");
    await voidSession(managerActor, manager, voided, "Opened by mistake", at(5));
    await expect(addCustomItem(actor, voided, "Chalk", 250)).rejects.toBeInstanceOf(TransitionError);

    const live = await awaitingPayment(h, "Table 3", 60);
    await chargeCard(actor, live);
    await expect(addCustomItem(actor, live, "Chalk", 250)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(LIVE) });
    await cancelCheckout(actor, live);
    await addCustomItem(actor, live, "Chalk", 250);
    expect((await getSession(h, live)).total_cents).toBe(2750);

    await expect(addCustomItem(actor, "00000000-0000-4000-8000-0000000000ff", "Chalk", 250)).rejects.toMatchObject({ status: 404 });
    await expect(addCustomItem(actor, "nope", "Chalk", 250)).rejects.toMatchObject({ status: 404 });
  });

  it("counts toward the 100-line cap", async () => {
    const { actor } = h.staff;
    const id = await running();
    await h.sql`
      insert into public.session_items (session_id, product_id, name, unit_cents, quantity, taxed, added_by)
      select ${id}, 'VAR_COKE', 'Coke', 450, 1, true, ${actor.staffId} from generate_series(1, 100)`;
    await h.sql`update public.sessions set items_cents = ${100 * 450} where id = ${id}`;
    await expect(addCustomItem(actor, id, "Chalk", 250)).rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("DTOs carry it as kind custom with a null productId; the summary groups custom lines by name", async () => {
    const { actor } = h.staff;
    const a = await awaitingPayment(h, "Table 1", 60);
    const customId = (await addCustomItem(actor, a, "Corkage", 1000)).itemId;
    await addItem(actor, a, "VAR_COKE", 1);
    const b = await awaitingPayment(h, "Table 2", 60);
    await addCustomItem(actor, b, " corkage ", 1500);
    await addCustomItem(actor, b, "Cue repair", 2000);

    const unpaid = (await getUnpaid()).sessions.find((s) => s.id === a);
    expect(unpaid?.items[0]).toMatchObject({ id: customId, kind: "custom", productId: null, name: "Corkage", unitCents: 1000, quantity: 1, taxed: true });
    expect(unpaid?.items[1]).toMatchObject({ kind: "product", productId: "VAR_COKE" });
    expect((await getSessionDetail(a)).session.items.map((i) => i.kind)).toEqual(["custom", "product"]);

    const sum = await getSummary("2026-11-20");
    expect(sum.itemsSold).toEqual([
      { productId: null, name: expect.stringMatching(/^corkage$/i), quantity: 2, cents: 2500 },
      { productId: null, name: "Cue repair", quantity: 1, cents: 2000 },
      { productId: "VAR_COKE", name: "Coke", quantity: 1, cents: 450 },
    ]);
    expect(sum.sessions).toEqual({ count: 2, billedMinutes: 120, billedCents: 9950, tableCents: 5000, itemsCents: 4950, discountCents: 0, writtenOffCents: 0 });
  });
});

// ---------------------------------------------------------------------------
// E. Counter sale
// ---------------------------------------------------------------------------

describe("E. counter sale", () => {
  it("opens an empty bill that is already awaiting payment, with no table, no timer and no rates", async () => {
    const { actor } = h.staff;
    const { sessionId: id } = await openCounterSale(actor, at(5));
    const s = await getSession(h, id);
    expect(s).toMatchObject({
      kind: "counter",
      status: "awaiting_payment",
      current_table_id: null,
      opened_by: actor.staffId,
      closed_by: actor.staffId,
      billed_minutes: 0,
      total_cents: 0,
      items_cents: 0,
      discount_cents: 0,
      split_off_cents: 0,
      split_of: null,
      rate_snapshot: null,
      checkout_attempt: 0,
      settled_cents: null,
    });
    expect(s.opened_at).toEqual(at(5));
    expect(s.closed_at).toEqual(at(5));
    expect(await getIntervals(h, id)).toHaveLength(0);
    const [row] = await audits(h, id, "session.counter_sale");
    expect(row).toMatchObject({ actor_staff_id: actor.staffId, entity: "session" });
    expect(row.after).toMatchObject({ kind: "counter", status: "awaiting_payment", total_cents: 0 });
    await expectBillAddsUp(h, id);
  });

  it("lives in the Unpaid list as \"Counter sale\", counts as off-table on the floor, and has an empty breakdown", async () => {
    const { actor } = h.staff;
    const { sessionId: id } = await openCounterSale(actor, at(5));
    const u = (await getUnpaid()).sessions;
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({
      id,
      kind: "counter",
      label: COUNTER_LABEL,
      status: "awaiting_payment",
      currentTableId: null,
      billedMinutes: 0,
      totalCents: 0,
      itemsCents: 0,
      items: [],
      intervals: [],
      discount: null,
      splitOfId: null,
      splitOffCents: 0,
      parts: [],
      checkout: null,
    });
    expect(COUNTER_LABEL).toBe("Counter sale");

    const f = await getFloor();
    expect(f.sessions).toEqual([]);
    expect(f.unpaidOffTableCount).toBe(1);

    const d = await getSessionDetail(id);
    expect(d.breakdown).toEqual({ billedMinutes: 0, totalCents: 0, gstCents: 0, actualMs: 0, lines: [] });
    expect(d.audit.map((a) => a.action)).toEqual(["session.counter_sale"]);
  });

  it("takes items, custom charges and a discount like any bill, and is charged by card itemised with no table line", async () => {
    const { actor } = h.staff;
    await seedDiscount(h, { id: "D_10", name: "Members 10%", kind: "percent", value: 1000 });
    const { sessionId: id } = await openCounterSale(actor, at(5));
    const coke = (await addItem(actor, id, "VAR_COKE", 2)).itemId; // 900
    await expectBillAddsUp(h, id);
    const chalk = (await addCustomItem(actor, id, "Chalk", 250)).itemId; // 1150
    await expectBillAddsUp(h, id);
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 115 off
    const facts = await expectBillAddsUp(h, id);
    expect(facts).toEqual({ tableCents: 0, itemsCents: 1150, discountCents: 115, splitOffCents: 0, totalCents: 1035 });
    expect((await getSession(h, id)).checkout_attempt).toBe(3);

    const out = await chargeCard(actor, id);
    expect(out).toEqual({ kind: "sent", checkoutId: "chk_1", amountCents: 1035 });
    const order = h.gateway.orders[0];
    expect(order.idempotencyKey).toBe(`${id}-o4`);
    expect(order.lines).toEqual([
      { uid: coke, catalogObjectId: "VAR_COKE", name: null, quantity: 2, basePriceCents: 450, note: null },
      { uid: chalk, catalogObjectId: null, name: "Chalk", quantity: 1, basePriceCents: 250, note: null },
    ]);
    expect(order.discount).toEqual({ uid: "discount", name: "Members 10%", amountCents: 115 });
    // The note Square shows has no table or duration to give: what it is and when.
    expect(h.gateway.creates[0]).toMatchObject({ idempotencyKey: `${id}-a4i`, amountCents: 1035, orderId: "ord_1", note: "Counter sale · 10:05" });

    await webhookPaid("chk_1", id, 1035);
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "card", settled_cents: 1035, total_cents: 1035 });
    expect(await audits(h, id, "payment.conflict")).toHaveLength(0);
    await expectBillAddsUp(h, id);
  });

  it("cash: collected to 5c, and the sale goes to Square with its lines", async () => {
    const { actor } = h.staff;
    const { sessionId: id } = await openCounterSale(actor, at(5));
    await addCustomItem(actor, id, "Chalk", 252);
    const out = await markPaid(actor, id, "cash", { cardConfirmed: false }, at(6));
    expect(out).toMatchObject({ kind: "paid", method: "cash", amountCents: 250 });
    const [rec] = await records(id);
    expect(rec).toMatchObject({ amount_cents: 250, bill_cents: 252, note: "Counter sale · 10:05" });
    expect(await pushCashRecords()).toBe(1);
    expect(h.gateway.orders[0].lines).toEqual([expect.objectContaining({ catalogObjectId: null, name: "Chalk", basePriceCents: 252 })]);
    expect(h.gateway.cashPayments[0]).toMatchObject({ amountCents: 250, orderId: "ord_1", note: "Counter sale · 10:05" });
  });

  it("Square POS cash handoff works for it and its note says what it is", async () => {
    const { actor } = h.staff;
    const { sessionId: id } = await openCounterSale(actor, at(5));
    await addItem(actor, id, "VAR_CHIPS", 1);
    const out = await startCashHandoff(actor, id);
    expect(out.amountCents).toBe(600);
    expect(linkData(out.url).notes).toBe(`Counter sale · 10:05 · ref ${id.slice(0, 8)}`);
  });

  it("with nothing on it there is nothing to charge or collect", async () => {
    const { actor } = h.staff;
    const { sessionId: id } = await openCounterSale(actor, at(5));
    await expect(chargeCard(actor, id)).rejects.toMatchObject({ status: 409, message: "There's nothing to charge on this bill." });
    await expect(startCashHandoff(actor, id)).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.creates).toHaveLength(0);
  });

  it("the last line can come off again (unlike a table's bill), leaving an empty sale", async () => {
    const { actor } = h.staff;
    const { sessionId: id } = await openCounterSale(actor, at(5));
    const { itemId } = await addItem(actor, id, "VAR_COKE", 1);
    await removeItem(actor, id, itemId, at(6));
    expect(await getSession(h, id)).toMatchObject({ items_cents: 0, total_cents: 0, status: "awaiting_payment" });
    await expectBillAddsUp(h, id);
  });

  it("has no timer: pause, resume, stop, transfer and edit times are all refused", async () => {
    const { actor, managerActor, manager } = h.staff;
    const { sessionId: id } = await openCounterSale(actor, at(5));
    await expect(pauseSession(actor, id, at(6))).rejects.toBeInstanceOf(TransitionError);
    await expect(resumeSession(actor, id, at(6))).rejects.toBeInstanceOf(TransitionError);
    await expect(stopSession(actor, id, at(6))).rejects.toBeInstanceOf(TransitionError);
    await expect(transferSession(actor, id, h.tableId("Table 2"), at(6))).rejects.toBeInstanceOf(TransitionError);
    await expect(editTimes(managerActor, manager, id, "Wrong times", [], at(6))).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/counter sale has no table time/),
    });
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", current_table_id: null, total_cents: 0 });
    expect(await getIntervals(h, id)).toHaveLength(0);
  });

  describe("discard", () => {
    it("any staff member can throw away an empty one: void, fixed reason, voided by them", async () => {
      const { actor } = h.staff;
      const { sessionId: id } = await openCounterSale(actor, at(5));
      await discardCounterSale(actor, id, at(7));
      const s = await getSession(h, id);
      expect(s).toMatchObject({ status: "void", void_reason: DISCARD_REASON, voided_by: actor.staffId, merged: false, total_cents: 0, items_cents: 0 });
      expect(DISCARD_REASON).toBe("Empty counter sale");
      expect(s.voided_at).toEqual(at(7));
      const [row] = await audits(h, id, "session.discard");
      expect(row).toMatchObject({ actor_staff_id: actor.staffId, approved_by_staff_id: null, reason: DISCARD_REASON });
      expect((await getUnpaid()).sessions).toEqual([]);
      // it can't be thrown away twice
      await expect(discardCounterSale(actor, id, at(8))).rejects.toBeInstanceOf(TransitionError);
    });

    it("one that had a line put on and taken off again is still empty", async () => {
      const { actor } = h.staff;
      const { sessionId: id } = await openCounterSale(actor, at(5));
      const { itemId } = await addItem(actor, id, "VAR_COKE", 1);
      await expect(discardCounterSale(actor, id, at(6))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Only an empty counter sale/) });
      await removeItem(actor, id, itemId, at(6));
      await discardCounterSale(actor, id, at(7));
      expect((await getSession(h, id)).status).toBe("void");
      // the line and who removed it are still on record
      expect(await getItems(h, id)).toHaveLength(1);
    });

    it("refuses anything that isn't an empty counter sale", async () => {
      const { actor } = h.staff;
      // a table's bill
      const table = await awaitingPayment(h, "Table 1", 60);
      await expect(discardCounterSale(actor, table)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Ask a manager to void/) });
      // a running session
      const run = await running("Table 2");
      await expect(discardCounterSale(actor, run)).rejects.toBeInstanceOf(TransitionError);
      // a counter sale with a free item on it (items_cents is 0, but it isn't empty)
      await seedProduct(h, { id: "VAR_FREE", name: "Free water", priceCents: 0 });
      const { sessionId: free } = await openCounterSale(actor, at(5));
      await addItem(actor, free, "VAR_FREE", 1);
      await expect(discardCounterSale(actor, free)).rejects.toMatchObject({ status: 409 });
      // a paid one
      const { sessionId: paid } = await openCounterSale(actor, at(5));
      await addItem(actor, paid, "VAR_COKE", 1);
      await markPaid(actor, paid, "cash", { cardConfirmed: false }, at(6));
      await expect(discardCounterSale(actor, paid)).rejects.toBeInstanceOf(TransitionError);

      for (const id of [table, run, free]) expect((await getSession(h, id)).status, id).not.toBe("void");
      await expect(discardCounterSale(actor, "nope")).rejects.toMatchObject({ status: 404 });
    });

    it("refuses once a card request was ever sent for it, even a cancelled one", async () => {
      const { actor } = h.staff;
      const { sessionId: id } = await openCounterSale(actor, at(5));
      const { itemId } = await addItem(actor, id, "VAR_COKE", 1);
      await chargeCard(actor, id);
      await cancelCheckout(actor, id);
      await removeItem(actor, id, itemId, at(6));
      expect((await getSession(h, id)).total_cents).toBe(0);
      await expect(discardCounterSale(actor, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/card request was sent.*manager/) });
      expect((await getSession(h, id)).status).toBe("awaiting_payment");
    });

    it("refuses once it was ever handed to Square POS for cash", async () => {
      const { actor } = h.staff;
      const { sessionId: id } = await openCounterSale(actor, at(5));
      const { itemId } = await addItem(actor, id, "VAR_COKE", 1);
      await startCashHandoff(actor, id);
      await removeItem(actor, id, itemId, at(6));
      // even long after the handoff
      await ageHandoffs("3 hours");
      await expect(discardCounterSale(actor, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Square POS.*manager/) });
    });

    it("the daily summary leaves a thrown-away empty sale out of its voids, but lists a manager's void of one", async () => {
      const { actor, managerActor, manager } = h.staff;
      const { sessionId: thrown } = await openCounterSale(actor, at(5));
      await discardCounterSale(actor, thrown, at(6));
      // A manager voids a counter sale that had something on it, typing the very same words.
      const { sessionId: writeOff } = await openCounterSale(actor, at(10));
      await addItem(actor, writeOff, "VAR_COKE", 2);
      await voidSession(managerActor, manager, writeOff, DISCARD_REASON, at(12));
      // A manager voids an empty one with their own reason: listed too (it isn't the staff discard).
      const { sessionId: managerEmpty } = await openCounterSale(actor, at(20));
      await voidSession(managerActor, manager, managerEmpty, "Opened by mistake", at(21));

      const sum = await getSummary("2026-11-20");
      expect(sum.voids.count).toBe(2);
      expect(sum.voids.items.map((v) => [v.id, v.kind, v.tableNames, v.totalCents, v.reason])).toEqual([
        [writeOff, "counter", "Counter sale", 900, DISCARD_REASON],
        [managerEmpty, "counter", "Counter sale", 0, "Opened by mistake"],
      ]);
      // none of the three is a sale
      expect(sum.sessions).toEqual({ count: 0, billedMinutes: 0, billedCents: 0, tableCents: 0, itemsCents: 0, discountCents: 0, writtenOffCents: 0 });
      expect(sum.itemsSold).toEqual([]);
      expect(sum.unpaid.count).toBe(0);
      // the thrown-away one is still a row, with its audit trail
      expect((await getSessionDetail(thrown)).audit.map((a) => a.action)).toEqual(["session.counter_sale", "session.discard"]);
    });
  });

  it("in the summary a counter sale is a session with no minutes; its items are sold items", async () => {
    const { actor } = h.staff;
    const { sessionId: open } = await openCounterSale(actor, at(5));
    await addItem(actor, open, "VAR_COKE", 2); // 900 unpaid
    const { sessionId: paid } = await openCounterSale(actor, at(10));
    await addItem(actor, paid, "VAR_CHIPS", 1); // 600
    await markPaid(actor, paid, "card", { cardConfirmed: true }, at(11));

    const sum = await getSummary("2026-11-20");
    expect(sum.sessions).toEqual({ count: 2, billedMinutes: 0, billedCents: 1500, tableCents: 0, itemsCents: 1500, discountCents: 0, writtenOffCents: 0 });
    expect(sum.itemsSold).toEqual([
      { productId: "VAR_COKE", name: "Coke", quantity: 2, cents: 900 },
      { productId: "VAR_CHIPS", name: "Chips", quantity: 1, cents: 600 },
    ]);
    expect(sum.paid.card).toEqual({ count: 1, cents: 600 });
    expect(sum.paidItems.map((p) => [p.id, p.kind, p.tableNames, p.totalCents])).toEqual([[paid, "counter", "Counter sale", 600]]);
    expect(sum.unpaid).toMatchObject({ count: 1, cents: 900 });
    expect(sum.unpaid.items[0]).toMatchObject({ id: open, kind: "counter", tableNames: "Counter sale", billedMinutes: 0, totalCents: 900 });
  });
});

// ---------------------------------------------------------------------------
// F. Discounts: the catalogue
// ---------------------------------------------------------------------------

function variation(id: string, cents = 450): Square.CatalogObject.ItemVariation {
  return {
    type: "ITEM_VARIATION",
    id,
    presentAtAllLocations: true,
    itemVariationData: { name: "Regular", pricingType: "FIXED_PRICING", priceMoney: { amount: BigInt(cents), currency: "AUD" } },
  };
}
function item(id: string, name: string, variations: Square.CatalogObject.ItemVariation[]): Square.CatalogObject.Item {
  return { type: "ITEM", id, presentAtAllLocations: true, itemData: { name, productType: "REGULAR", taxIds: ["TAX_GST"], variations } };
}
function discount(
  id: string,
  data: Partial<Square.CatalogDiscount>,
  o: Partial<Square.CatalogObject.Discount> = {},
): Square.CatalogObject.Discount {
  return { type: "DISCOUNT", id, presentAtAllLocations: true, ...o, discountData: { name: `Discount ${id}`, ...data } };
}
const aud = (cents: number): Square.Money => ({ amount: BigInt(cents), currency: "AUD" });

interface DbDiscount {
  id: string;
  name: string;
  kind: string;
  value: number | null;
  active: boolean;
  updated_at: Date;
}
const dbDiscounts = () => h.sql<DbDiscount[]>`select id, name, kind, value, active, updated_at from public.discounts order by id`;
const dbProducts = () => h.sql<{ id: string; active: boolean }[]>`select id, active from public.products where id like 'V\\_%' order by id`;

describe("F1. discounts from the Square catalogue", () => {
  it("reads Square's percentage string as exact basis points", () => {
    expect(percentageToBasisPoints("10")).toBe(1000);
    expect(percentageToBasisPoints("12.5")).toBe(1250);
    expect(percentageToBasisPoints("7.25")).toBe(725);
    expect(percentageToBasisPoints("10.0")).toBe(1000);
    expect(percentageToBasisPoints("12.500")).toBe(1250);
    expect(percentageToBasisPoints(" 5 ")).toBe(500);
    expect(percentageToBasisPoints("100")).toBe(10_000);
    expect(percentageToBasisPoints("100.00")).toBe(10_000);
    expect(percentageToBasisPoints("0.01")).toBe(1);
    expect(percentageToBasisPoints("0.5")).toBe(50);
    // every hundredth of a percent comes out exact (0.07 × 100 is 7.000000000000001 in floating point)
    for (let bp = 1; bp <= 10_000; bp++) {
      const text = `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, "0")}`;
      expect(percentageToBasisPoints(text), text).toBe(bp);
    }
    // not usable: nothing, zero, over 100%, finer than a hundredth of a percent, or not a number
    for (const bad of [null, undefined, "", "0", "0.0", "0.00", "100.01", "101", "150", "33.333", "0.001", "-5", "+5", "5%", "1e1", "abc", "1,5", ".5", "5.", "1000"]) {
      expect(percentageToBasisPoints(bad), String(bad)).toBeNull();
    }
  });

  it("maps fixed and variable discounts, by name", () => {
    const { discounts } = mapCatalog(
      [
        discount("D_PCT", { name: " Staff ", discountType: "FIXED_PERCENTAGE", percentage: "12.5" }),
        discount("D_AMT", { name: "Five off", discountType: "FIXED_AMOUNT", amountMoney: aud(500) }),
        discount("D_VPCT", { name: "Manager percent", discountType: "VARIABLE_PERCENTAGE", percentage: "0" }),
        discount("D_VAMT", { name: "manager amount", discountType: "VARIABLE_AMOUNT", amountMoney: aud(0) }),
      ],
      LOC,
    );
    expect(discounts).toEqual([
      { id: "D_AMT", name: "Five off", kind: "amount", value: 500 },
      { id: "D_VAMT", name: "manager amount", kind: "variable_amount", value: null },
      { id: "D_VPCT", name: "Manager percent", kind: "variable_percent", value: null },
      { id: "D_PCT", name: "Staff", kind: "percent", value: 1250 },
    ]);
    expect(() => JSON.stringify(discounts)).not.toThrow(); // no bigint left in it
  });

  it("respects the location, and a long name is cut to 60 characters", () => {
    const here = (o: Partial<Square.CatalogObject.Discount>) => mapCatalog([discount("D", { discountType: "FIXED_PERCENTAGE", percentage: "10" }, o)], LOC).discounts.length;
    expect(here({})).toBe(1);
    expect(here({ presentAtAllLocations: false })).toBe(0);
    expect(here({ presentAtAllLocations: false, presentAtLocationIds: [LOC] })).toBe(1);
    expect(here({ presentAtAllLocations: false, presentAtLocationIds: ["LOC_OTHER"] })).toBe(0);
    expect(here({ presentAtAllLocations: true, absentAtLocationIds: [LOC] })).toBe(0);
    expect(here({ isDeleted: true })).toBe(0);

    const [long] = mapCatalog([discount("D", { name: `${"x".repeat(59)} yz`, discountType: "FIXED_PERCENTAGE", percentage: "10" })], LOC).discounts;
    expect(long.name).toBe("x".repeat(59));
    expect(long.name.length).toBeLessThanOrEqual(60);
  });

  it("skips what staff can't use here, without throwing and without touching the products", () => {
    const odd: Square.CatalogObject[] = [
      discount("D_PIN", { discountType: "FIXED_PERCENTAGE", percentage: "10", pinRequired: true }),
      discount("D_NONAME", { name: "   ", discountType: "FIXED_PERCENTAGE", percentage: "10" }),
      discount("D_NULLNAME", { name: null, discountType: "FIXED_PERCENTAGE", percentage: "10" }),
      discount("D_BADPCT", { discountType: "FIXED_PERCENTAGE", percentage: "ten" }),
      discount("D_FINE_PCT", { discountType: "FIXED_PERCENTAGE", percentage: "33.333" }),
      discount("D_ZERO", { discountType: "FIXED_PERCENTAGE", percentage: "0" }),
      discount("D_OVER", { discountType: "FIXED_PERCENTAGE", percentage: "150" }),
      discount("D_NOPCT", { discountType: "FIXED_PERCENTAGE" }),
      discount("D_CAPPED", { discountType: "FIXED_PERCENTAGE", percentage: "50", maximumAmountMoney: aud(2000) }),
      discount("D_VCAPPED", { discountType: "VARIABLE_PERCENTAGE", maximumAmountMoney: aud(2000) }),
      discount("D_USD", { discountType: "FIXED_AMOUNT", amountMoney: { amount: BigInt(500), currency: "USD" } }),
      discount("D_NOAMT", { discountType: "FIXED_AMOUNT" }),
      discount("D_ZEROAMT", { discountType: "FIXED_AMOUNT", amountMoney: aud(0) }),
      discount("D_HUGE", { discountType: "FIXED_AMOUNT", amountMoney: aud(1_000_001) }),
      discount("D_NOTYPE", { percentage: "10" }),
      { type: "DISCOUNT", id: "D_NODATA", presentAtAllLocations: true },
      // Not even the right shape: a getter that throws must not take the sync down.
      Object.defineProperty({ type: "DISCOUNT", id: "D_BOOM", presentAtAllLocations: true }, "discountData", {
        get() {
          throw new Error("boom");
        },
      }) as Square.CatalogObject,
    ];
    const good = discount("D_OK", { name: "Staff", discountType: "FIXED_PERCENTAGE", percentage: "10" });
    const coke = item("I_COKE", "Coke", [variation("V_COKE")]);

    const m = mapCatalog([...odd, coke, good], LOC);
    expect(m.discounts).toEqual([{ id: "D_OK", name: "Staff", kind: "percent", value: 1000 }]);
    expect(m.products.map((p) => p.id)).toEqual(["V_COKE"]);
    // and the products are exactly what they are without any discount in the list
    expect(m.products).toEqual(mapCatalog([coke], LOC).products);
  });

  it("the same id twice is kept once", () => {
    const d = discount("D", { name: "Staff", discountType: "FIXED_PERCENTAGE", percentage: "10" });
    expect(mapCatalog([d, d], LOC).discounts).toHaveLength(1);
  });
});

describe("F2. catalogue sync keeps `discounts` in step with Square", () => {
  const coke = () => item("I_COKE", "Coke", [variation("V_COKE")]);
  const staff = (percentage = "10") => discount("D_STAFF", { name: "Staff", discountType: "FIXED_PERCENTAGE", percentage });
  const five = () => discount("D_FIVE", { name: "Five off", discountType: "FIXED_AMOUNT", amountMoney: aud(500) });

  it("fills the table in the same sync as the products", async () => {
    h.catalog.objects = [coke(), staff(), five(), discount("D_VAR", { name: "Manager %", discountType: "VARIABLE_PERCENTAGE" })];
    expect(await syncProducts()).toBe(1); // still the number of products
    expect((await dbDiscounts()).map(({ id, name, kind, value, active }) => ({ id, name, kind, value, active }))).toEqual([
      { id: "D_FIVE", name: "Five off", kind: "amount", value: 500, active: true },
      { id: "D_STAFF", name: "Staff", kind: "percent", value: 1000, active: true },
      { id: "D_VAR", name: "Manager %", kind: "variable_percent", value: null, active: true },
    ]);
    expect(await dbProducts()).toEqual([{ id: "V_COKE", active: true }]);
  });

  it("unchanged rows are not rewritten; a changed one is; one that leaves is made inactive, never deleted, and can come back", async () => {
    h.catalog.objects = [coke(), staff(), five()];
    await syncProducts();
    await h.raw(null, `set session_replication_role = replica`);
    try {
      await h.raw(null, `update public.discounts set updated_at = '2020-01-01T00:00:00Z'`);
    } finally {
      await h.raw(null, `set session_replication_role = origin`);
    }
    const old = new Date("2020-01-01T00:00:00Z");

    await syncProducts();
    expect((await dbDiscounts()).map((d) => d.updated_at)).toEqual([old, old]);

    h.catalog.objects = [coke(), staff("15")]; // Staff changed, Five off gone
    await syncProducts();
    const [fiveRow, staffRow] = await dbDiscounts();
    expect(staffRow).toMatchObject({ id: "D_STAFF", value: 1500, active: true });
    expect(staffRow.updated_at.getTime()).toBeGreaterThan(old.getTime());
    expect(fiveRow).toMatchObject({ id: "D_FIVE", value: 500, active: false });

    h.catalog.objects = [coke(), staff("15"), five()];
    await syncProducts();
    expect((await dbDiscounts()).map((d) => [d.id, d.active])).toEqual([["D_FIVE", true], ["D_STAFF", true]]);
  });

  it("a discount that becomes unusable (PIN added in Square) is made inactive", async () => {
    h.catalog.objects = [coke(), staff()];
    await syncProducts();
    h.catalog.objects = [coke(), discount("D_STAFF", { name: "Staff", discountType: "FIXED_PERCENTAGE", percentage: "10", pinRequired: true })];
    await syncProducts();
    expect((await dbDiscounts()).map((d) => [d.id, d.active])).toEqual([["D_STAFF", false]]);
  });

  it("an empty discount list from Square deactivates the discounts and nothing else", async () => {
    h.catalog.objects = [coke(), staff(), five()];
    await syncProducts();
    h.catalog.objects = [coke()];
    expect(await syncProducts()).toBe(1);
    expect((await dbDiscounts()).map((d) => d.active)).toEqual([false, false]);
    expect(await dbProducts()).toEqual([{ id: "V_COKE", active: true }]);
    expect((await getFloor()).discounts).toEqual([]);
  });

  it("odd discount objects neither fail the sync nor deactivate products", async () => {
    h.catalog.objects = [coke(), staff()];
    await syncProducts();
    h.catalog.objects = [
      coke(),
      staff(),
      discount("D_BAD", { discountType: "FIXED_PERCENTAGE", percentage: "lots" }),
      { type: "DISCOUNT", id: "D_NODATA", presentAtAllLocations: true },
      discount("D_PIN", { discountType: "FIXED_AMOUNT", amountMoney: aud(500), pinRequired: true }),
    ];
    expect(await syncProducts()).toBe(1);
    expect(await dbProducts()).toEqual([{ id: "V_COKE", active: true }]);
    expect((await dbDiscounts()).map((d) => [d.id, d.active])).toEqual([["D_STAFF", true]]);
    const [st] = await h.sql<{ last_error: string | null }[]>`select last_error from public.catalog_state`;
    expect(st.last_error).toBeNull();
  });

  it("if writing the discounts fails, the item list is still saved, the discounts stay as they were, and Admin is told", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.catalog.objects = [coke(), staff()];
    await syncProducts();
    // Make any write to `discounts` blow up, as a constraint we didn't foresee would.
    await h.raw(null, `create function public.test_boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end; $$`);
    await h.raw(null, `create trigger test_boom before insert or update on public.discounts for each row execute function public.test_boom()`);
    try {
      h.catalog.objects = [coke(), item("I_PIE", "Pie", [variation("V_PIE", 600)]), staff("20"), five()];
      expect(await syncProducts()).toBe(2);
      expect(await dbProducts()).toEqual([{ id: "V_COKE", active: true }, { id: "V_PIE", active: true }]);
      expect((await dbDiscounts()).map((d) => [d.id, d.value, d.active])).toEqual([["D_STAFF", 1000, true]]);
      const [st] = await h.sql<{ last_error: string | null; synced_at: Date | null }[]>`select last_error, synced_at from public.catalog_state`;
      expect(st.last_error).toMatch(/item list was updated, but the discounts couldn't be/);
      expect(st.synced_at).toBeInstanceOf(Date);
      expect(warn).toHaveBeenCalled();
    } finally {
      await h.raw(null, `drop trigger test_boom on public.discounts`);
      await h.raw(null, `drop function public.test_boom()`);
    }
    // and the next sync puts it right and clears the message
    await syncProducts();
    expect((await dbDiscounts()).map((d) => [d.id, d.value])).toEqual([["D_FIVE", 500], ["D_STAFF", 2000]]);
    expect((await h.sql<{ last_error: string | null }[]>`select last_error from public.catalog_state`)[0].last_error).toBeNull();
  });

  it("a failed read from Square leaves the discounts alone", async () => {
    h.catalog.objects = [coke(), staff()];
    await syncProducts();
    h.catalog.error = new AppError(502, "square_error", "Square is down");
    await expect(syncProducts()).rejects.toMatchObject({ status: 502 });
    expect((await dbDiscounts()).map((d) => [d.id, d.active])).toEqual([["D_STAFF", true]]);
  });

  it("the floor offers the active ones by name; Admin lists them all", async () => {
    await seedDiscount(h, { id: "D_Z", name: "zebra night", kind: "amount", value: 500 });
    await seedDiscount(h, { id: "D_A", name: "Aces 10%", kind: "percent", value: 1000 });
    await seedDiscount(h, { id: "D_V", name: "Manager $", kind: "variable_amount" });
    await seedDiscount(h, { id: "D_OLD", name: "Old promo", kind: "percent", value: 2500, active: false });

    expect((await getFloor()).discounts).toEqual([
      { id: "D_A", name: "Aces 10%", kind: "percent", value: 1000 },
      { id: "D_V", name: "Manager $", kind: "variable_amount", value: null },
      { id: "D_Z", name: "zebra night", kind: "amount", value: 500 },
    ]);
    const admin = await getAdminState(h.staff.manager);
    expect(admin.catalog.discounts).toEqual([
      { id: "D_A", name: "Aces 10%", kind: "percent", value: 1000, active: true },
      { id: "D_V", name: "Manager $", kind: "variable_amount", value: null, active: true },
      { id: "D_OLD", name: "Old promo", kind: "percent", value: 2500, active: false },
      { id: "D_Z", name: "zebra night", kind: "amount", value: 500, active: true },
    ]);
  });

  it("the background refresh brings discounts in too, and `discounts` has no floor-broadcast trigger", async () => {
    h.catalog.objects = [coke(), staff()];
    await refreshProductsInBackground();
    expect((await dbDiscounts()).map((d) => d.id)).toEqual(["D_STAFF"]);
    const rows = await h.raw<{ t: string }>(
      null,
      `select c.relname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_proc p on p.oid = g.tgfoid
       where p.proname = 'broadcast_floor_change' and not g.tgisinternal`,
    );
    expect(rows.map((r) => r.t)).not.toContain("discounts");
    expect(rows.map((r) => r.t)).not.toContain("refunds");
  });

  it("the database refuses a discount row that makes no sense, and nobody outside the server can read the table", async () => {
    const bad = [
      `insert into public.discounts (id, name, kind, value) values ('X', 'x', 'percent', null)`,
      `insert into public.discounts (id, name, kind, value) values ('X', 'x', 'variable_amount', 500)`,
      `insert into public.discounts (id, name, kind, value) values ('X', 'x', 'percent', 10001)`,
      `insert into public.discounts (id, name, kind, value) values ('X', 'x', 'amount', 0)`,
      `insert into public.discounts (id, name, kind, value) values ('X', '  ', 'amount', 5)`,
      `insert into public.discounts (id, name, kind, value) values ('X', 'x', 'bogus', 5)`,
    ];
    for (const stmt of bad) expect((await h.rawError(null, stmt)).code, stmt).toBe("23514");
    for (const role of ["anon", "authenticated"]) {
      expect((await h.rawError(role, `select * from public.discounts`)).code, role).toBe("42501");
    }
    expect((await h.rawError("timer_app", `delete from public.discounts`)).code).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
// F. Discounts: on a bill
// ---------------------------------------------------------------------------

describe("F3. putting a discount on a bill", () => {
  beforeEach(async () => {
    await seedDiscount(h, { id: "D_10", name: "Members 10%", kind: "percent", value: 1000 });
    await seedDiscount(h, { id: "D_125", name: "Staff 12.5%", kind: "percent", value: 1250 });
    await seedDiscount(h, { id: "D_5", name: "Five off", kind: "amount", value: 500 });
    await seedDiscount(h, { id: "D_VPCT", name: "Manager %", kind: "variable_percent" });
    await seedDiscount(h, { id: "D_VAMT", name: "Manager $", kind: "variable_amount" });
    await seedDiscount(h, { id: "D_OLD", name: "Old promo", kind: "percent", value: 2500, active: false });
  });

  it("running: any staff member, no PIN; nothing is taken off until the session stops", async () => {
    const { actor } = h.staff;
    const id = await running();
    await addItem(actor, id, "VAR_COKE", 2); // 900
    await setDiscount(actor, null, id, { discountId: "D_10" });

    expect(await getSession(h, id)).toMatchObject({
      status: "running",
      discount_id: "D_10",
      discount_name: "Members 10%",
      discount_kind: "percent",
      discount_value: 1000,
      discount_cents: 0,
      discount_by: actor.staffId,
      discount_approved_by: null,
      total_cents: null,
      checkout_attempt: 0,
    });
    const [row] = await audits(h, id, "session.set_discount");
    expect(row).toMatchObject({ actor_staff_id: actor.staffId, approved_by_staff_id: null });
    expect(row.before).toMatchObject({ discount: null, discount_cents: 0, total_cents: null });
    expect(row.after).toMatchObject({ discount: { id: "D_10", name: "Members 10%", kind: "percent", value: 1000 }, discount_cents: 0, total_cents: null });
    await expectBillAddsUp(h, id);

    // The screens estimate from this while it runs.
    const live = (await getFloor()).sessions.find((s) => s.id === id);
    expect(live?.discount).toEqual({ discountId: "D_10", name: "Members 10%", kind: "percent", value: 1000, cents: 0, byName: "Sam Staff" });

    // Stop: 2500 + 900 = 3400, less 10% = 340.
    expect(await stopSession(actor, id, at(60))).toEqual({ status: "awaiting_payment", billedMinutes: 60, totalCents: 3060 });
    expect(await getSession(h, id)).toMatchObject({ total_cents: 3060, discount_cents: 340, items_cents: 900, billed_minutes: 60 });
    const [stop] = await audits(h, id, "session.stop");
    expect(stop.after).toMatchObject({ table_cents: 2500, items_cents: 900, discount_cents: 340, total_cents: 3060 });
    expect(await expectBillAddsUp(h, id)).toEqual({ tableCents: 2500, itemsCents: 900, discountCents: 340, splitOffCents: 0, totalCents: 3060 });

    const stopped = (await getUnpaid()).sessions.find((s) => s.id === id);
    expect(stopped?.discount).toMatchObject({ cents: 340, name: "Members 10%" });
    expect(stopped?.totalCents).toBe(3060);
  });

  it("awaiting payment: the total moves, an attempt number is skipped, and it is audited with before and after", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60); // 2500
    await setDiscount(actor, null, id, { discountId: "D_10" });
    expect(await getSession(h, id)).toMatchObject({ total_cents: 2250, discount_cents: 250, checkout_attempt: 1, status: "awaiting_payment" });
    const [row] = await audits(h, id, "session.set_discount");
    expect(row.before).toMatchObject({ discount: null, discount_cents: 0, total_cents: 2500 });
    expect(row.after).toMatchObject({ discount: { id: "D_10", kind: "percent", value: 1000 }, discount_cents: 250, total_cents: 2250 });
    expect(await auditActions(h, id)).not.toContain("session.repriced");
    await expectBillAddsUp(h, id);
  });

  it("a percentage follows the bill: it is worked out again when items or the times change", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60); // 2500
    await setDiscount(actor, null, id, { discountId: "D_125" }); // 312.5 → 313
    expect(await getSession(h, id)).toMatchObject({ discount_cents: 313, total_cents: 2187 });

    const { itemId } = await addItem(actor, id, "VAR_COKE", 1); // base 2950 → 368.75 → 369
    expect(await getSession(h, id)).toMatchObject({ items_cents: 450, discount_cents: 369, total_cents: 2581, checkout_attempt: 2 });
    const [added] = await audits(h, id, "session.add_item");
    expect(added.before).toMatchObject({ total_cents: 2187, discount_cents: 313 });
    expect(added.after).toMatchObject({ total_cents: 2581, discount_cents: 369 });
    await expectBillAddsUp(h, id);

    await addCustomItem(actor, id, "Chalk", 250); // base 3200 → 400
    expect(await getSession(h, id)).toMatchObject({ discount_cents: 400, total_cents: 2800 });
    await expectBillAddsUp(h, id);

    await removeItem(actor, id, itemId, at(62)); // base 2750 → 343.75 → 344
    expect(await getSession(h, id)).toMatchObject({ items_cents: 250, discount_cents: 344, total_cents: 2406 });
    const [removed] = await audits(h, id, "session.remove_item");
    expect(removed.after).toMatchObject({ total_cents: 2406, discount_cents: 344 });
    await expectBillAddsUp(h, id);

    // Manager halves the time: table 1250, base 1500 → 187.5 → 188.
    const [iv] = await getIntervals(h, id);
    const r = await editTimes(managerActor, manager, id, "Timer left running", [{ id: iv.id, startedAt: at(0), endedAt: at(30) }], at(120));
    expect(r.totalCents).toBe(1312);
    expect(await getSession(h, id)).toMatchObject({ billed_minutes: 30, discount_cents: 188, total_cents: 1312 });
    expect(await expectBillAddsUp(h, id)).toEqual({ tableCents: 1250, itemsCents: 250, discountCents: 188, splitOffCents: 0, totalCents: 1312 });

    // What goes on the Terminal is that amount, with nothing left to correct.
    expect(await chargeCard(actor, id)).toMatchObject({ kind: "sent", amountCents: 1312 });
    expect(await auditActions(h, id)).not.toContain("session.repriced");
  });

  it("an amount is capped at the bill, and the cap lifts as the bill grows", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60); // 2500
    await setDiscount(managerActor, manager, id, { custom: { name: "Sorry about the table", kind: "amount", value: 3000 } });
    expect(await getSession(h, id)).toMatchObject({ discount_value: 3000, discount_cents: 2500, total_cents: 0 });
    await expectBillAddsUp(h, id);
    await addCustomItem(actor, id, "Function hire", 1500); // base 4000 → 3000 off
    expect(await getSession(h, id)).toMatchObject({ discount_cents: 3000, total_cents: 1000 });
    await expectBillAddsUp(h, id);
  });

  it("a fixed amount from Square: any staff member", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, id, { discountId: "D_5" });
    expect(await getSession(h, id)).toMatchObject({ discount_id: "D_5", discount_kind: "amount", discount_value: 500, discount_cents: 500, total_cents: 2000, discount_approved_by: null });
    await expectBillAddsUp(h, id);
  });

  it("a variable discount from Square needs a manager and a value", async () => {
    const { actor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    // no PIN came with it
    await expect(setDiscount(actor, null, id, { discountId: "D_VPCT", value: 2000 })).rejects.toMatchObject({ status: 403, code: "forbidden", message: expect.stringMatching(/manager PIN/) });
    // no value
    await expect(setDiscount(actor, manager, id, { discountId: "D_VPCT" })).rejects.toMatchObject({ status: 400 });
    for (const v of [0, -5, 10_001, 12.5, Number.NaN]) {
      await expect(setDiscount(actor, manager, id, { discountId: "D_VPCT", value: v }), String(v)).rejects.toMatchObject({ status: 400 });
    }
    for (const v of [0, 200_001, 9.99]) {
      await expect(setDiscount(actor, manager, id, { discountId: "D_VAMT", value: v }), String(v)).rejects.toMatchObject({ status: 400 });
    }
    expect(await getSession(h, id)).toMatchObject({ discount_kind: null, total_cents: 2500, checkout_attempt: 0 });
    expect(await audits(h, id, "session.set_discount")).toHaveLength(0);

    await setDiscount(actor, manager, id, { discountId: "D_VPCT", value: 2000 });
    expect(await getSession(h, id)).toMatchObject({
      discount_id: "D_VPCT",
      discount_name: "Manager %",
      discount_kind: "percent",
      discount_value: 2000,
      discount_cents: 500,
      total_cents: 2000,
      discount_by: actor.staffId,
      discount_approved_by: manager.id,
    });
    const [row] = await audits(h, id, "session.set_discount");
    expect(row).toMatchObject({ actor_staff_id: actor.staffId, approved_by_staff_id: manager.id });

    await setDiscount(actor, manager, id, { discountId: "D_VAMT", value: 750 });
    expect(await getSession(h, id)).toMatchObject({ discount_id: "D_VAMT", discount_kind: "amount", discount_value: 750, discount_cents: 750, total_cents: 1750 });
    await expectBillAddsUp(h, id);
  });

  it("one typed in needs a manager; it has a name, no Square id, and says who approved it", async () => {
    const { actor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const custom = { name: "  Mate's rates ", kind: "percent" as const, value: 1500 };
    await expect(setDiscount(actor, null, id, { custom })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    for (const bad of [
      { ...custom, name: "" },
      { ...custom, name: "  " },
      { ...custom, name: "x".repeat(61) },
      { ...custom, value: 0 },
      { ...custom, value: 10_001 },
      { ...custom, kind: "amount" as const, value: 200_001 },
      { ...custom, kind: "bogus" as unknown as "percent" },
    ]) {
      await expect(setDiscount(actor, manager, id, { custom: bad }), JSON.stringify(bad)).rejects.toMatchObject({ status: 400 });
    }
    await setDiscount(actor, manager, id, { custom });
    expect(await getSession(h, id)).toMatchObject({
      discount_id: null,
      discount_name: "Mate's rates",
      discount_kind: "percent",
      discount_value: 1500,
      discount_cents: 375,
      total_cents: 2125,
      discount_by: actor.staffId,
      discount_approved_by: manager.id,
    });
    const d = (await getSessionDetail(id)).session.discount;
    expect(d).toEqual({ discountId: null, name: "Mate's rates", kind: "percent", value: 1500, cents: 375, byName: "Sam Staff" });
    await expectBillAddsUp(h, id);
  });

  it("refuses a fixed discount sent with a value, one that isn't on the list, and one no longer offered", async () => {
    const { actor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await expect(setDiscount(actor, manager, id, { discountId: "D_10", value: 5000 })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/set value in Square/) });
    await expect(setDiscount(actor, null, id, { discountId: "D_NOPE" })).rejects.toMatchObject({ status: 404 });
    await expect(setDiscount(actor, null, id, { discountId: "D_OLD" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Old promo isn't offered any more/) });
    expect(await getSession(h, id)).toMatchObject({ discount_kind: null, total_cents: 2500 });
  });

  it("replaces whatever discount was there", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, id, { discountId: "D_10" });
    await setDiscount(actor, null, id, { discountId: "D_5" });
    expect(await getSession(h, id)).toMatchObject({ discount_id: "D_5", discount_kind: "amount", discount_cents: 500, total_cents: 2000, checkout_attempt: 2 });
    const rows = await audits(h, id, "session.set_discount");
    expect(rows[1].before).toMatchObject({ discount: { id: "D_10" }, discount_cents: 250, total_cents: 2250 });
    expect(rows[1].after).toMatchObject({ discount: { id: "D_5" }, discount_cents: 500, total_cents: 2000 });
    await expectBillAddsUp(h, id);
  });

  it("a later change to the discount in Square doesn't touch a bill that already carries it", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, id, { discountId: "D_10" });
    await h.sql`update public.discounts set value = 5000, name = 'Members 50%', active = false where id = 'D_10'`;
    await addItem(actor, id, "VAR_COKE", 2); // still 10%: 3400 → 340
    expect(await getSession(h, id)).toMatchObject({ discount_name: "Members 10%", discount_value: 1000, discount_cents: 340, total_cents: 3060 });
  });

  it("remove-discount: any staff member; the bill goes back to full; 409 when there is none", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await expect(removeDiscount(actor, id)).rejects.toMatchObject({ status: 409, message: "There's no discount on this bill." });
    await setDiscount(actor, null, id, { discountId: "D_10" });
    await removeDiscount(actor, id);
    expect(await getSession(h, id)).toMatchObject({
      discount_id: null,
      discount_name: null,
      discount_kind: null,
      discount_value: null,
      discount_cents: 0,
      discount_by: null,
      discount_approved_by: null,
      total_cents: 2500,
      checkout_attempt: 2,
    });
    const [row] = await audits(h, id, "session.remove_discount");
    expect(row.before).toMatchObject({ discount: { id: "D_10" }, discount_cents: 250, total_cents: 2250 });
    expect(row.after).toMatchObject({ discount: null, discount_cents: 0, total_cents: 2500 });
    await expectBillAddsUp(h, id);

    // running: allowed, and there is still no total
    const run = await running("Table 2");
    await setDiscount(actor, null, run, { discountId: "D_5" });
    await removeDiscount(actor, run);
    expect(await getSession(h, run)).toMatchObject({ discount_kind: null, total_cents: null, checkout_attempt: 0 });
  });

  it("paused: allowed. Paid or void: refused", async () => {
    const { actor, managerActor, manager } = h.staff;
    const paused = await running("Table 1");
    await pauseSession(actor, paused, at(10));
    await setDiscount(actor, null, paused, { discountId: "D_10" });
    expect((await getSession(h, paused)).discount_id).toBe("D_10");

    const paid = await awaitingPayment(h, "Table 2", 60);
    await setDiscount(actor, null, paid, { discountId: "D_10" });
    await markPaid(actor, paid, "card", { cardConfirmed: true }, at(61));
    await expect(setDiscount(actor, null, paid, { discountId: "D_5" })).rejects.toBeInstanceOf(TransitionError);
    await expect(removeDiscount(actor, paid)).rejects.toBeInstanceOf(TransitionError);
    expect(await getSession(h, paid)).toMatchObject({ discount_id: "D_10", total_cents: 2250, settled_cents: 2250 });

    const voided = await running("Table 3");
    await voidSession(managerActor, manager, voided, "Opened by mistake", at(5));
    await expect(setDiscount(actor, null, voided, { discountId: "D_10" })).rejects.toBeInstanceOf(TransitionError);
  });

  it("refused while a card request is live, like items; allowed again once it is cancelled", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await chargeCard(actor, id);
    await expect(setDiscount(actor, null, id, { discountId: "D_10" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(LIVE) });
    h.gateway.cancelDefault = "CANCEL_REQUESTED"; // still able to take money
    await cancelCheckout(actor, id);
    await expect(setDiscount(actor, null, id, { discountId: "D_10" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(LIVE) });
    expect(await getSession(h, id)).toMatchObject({ discount_kind: null, total_cents: 2500 });

    h.gateway.cancelDefault = "CANCELED";
    await cancelCheckout(actor, id);
    await setDiscount(actor, null, id, { discountId: "D_10" });
    // the new amount goes out under keys Square has never seen
    await chargeCard(actor, id);
    expect(h.gateway.creates.at(-1)).toMatchObject({ idempotencyKey: `${id}-a3i`, amountCents: 2250 });

    await expect(removeDiscount(actor, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(LIVE) });
  });

  it("refused while Square POS may be taking cash for the bill; allowed once POS says it was cancelled, or 30 minutes on", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const link = linkData((await startCashHandoff(actor, id)).url);
    await expect(setDiscount(actor, null, id, { discountId: "D_10" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/sent to Square POS at \d\d:\d\d\. Finish or cancel that sale in Square POS first/),
    });
    expect(await getSession(h, id)).toMatchObject({ discount_kind: null, total_cents: 2500, checkout_attempt: 0 });

    // POS comes back cancelled: nothing is being taken any more.
    await handlePosReturn(JSON.stringify({ status: "error", error_code: "payment_canceled", state: link.state }));
    await setDiscount(actor, null, id, { discountId: "D_10" });
    expect((await getSession(h, id)).total_cents).toBe(2250);

    // A second handoff blocks again (the cancel belonged to the first one) …
    await startCashHandoff(actor, id);
    await expect(removeDiscount(actor, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Square POS/) });
    // … until it is old enough that nothing is looking for its sale any more.
    await ageHandoffs("31 minutes");
    await removeDiscount(actor, id);
    expect((await getSession(h, id)).total_cents).toBe(2500);
  });

  it("a bill paid through Square POS and then reopened by a manager can be discounted and split straight away", async () => {
    const { actor, managerActor, manager } = h.staff;
    // Paid by the Square POS sale itself, a minute after the handoff.
    const a = await awaitingPayment(h, "Table 1", 60); // 2500
    const link = linkData((await startCashHandoff(actor, a)).url);
    const sale = h.gateway.posSale({ amountCents: 2500, note: link.notes });
    const back = await handlePosReturn(JSON.stringify({ status: "ok", client_transaction_id: "c-1", transaction_id: sale.orderId, state: link.state }));
    expect(back.result).toBe("paid");
    expect(await getSession(h, a)).toMatchObject({ status: "paid", settled_method: "cash", settled_via: "square_api" });

    // The manager reopens it. The handoff is over: that sale has been and gone.
    await reversePaid(managerActor, manager, a, "Wrong bill");
    await setDiscount(actor, null, a, { discountId: "D_10" });
    expect(await getSession(h, a)).toMatchObject({ status: "awaiting_payment", discount_cents: 250, total_cents: 2250 });
    await removeDiscount(actor, a);
    await setDiscount(actor, null, a, { discountId: "D_5" });
    const { partIds } = await splitBill(actor, a, { ways: 2 }, at(70));
    expect(partIds).toHaveLength(1);
    expect(await getSession(h, a)).toMatchObject({ total_cents: 1000, split_off_cents: 1000 });
    await expectBillAddsUp(h, a);
  });

  it("… and so can one handed to Square POS, marked paid by hand, then reopened", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await startCashHandoff(actor, id);
    // Square shows no sale for it, so the manual payment stands.
    expect(await markPaidCheckingPos(actor, id, "cash", { cardConfirmed: false }, at(61))).toMatchObject({ kind: "paid", via: "staff" });
    await reversePaid(managerActor, manager, id, "Wrong bill");

    await setDiscount(actor, null, id, { discountId: "D_10" });
    await removeDiscount(actor, id);
    const { partIds } = await splitBill(actor, id, { amountCents: 1000 }, at(70));
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", total_cents: 1500, split_off_cents: 1000 });

    // Still protected where it matters: a NEW handoff after the reopen is open, and blocks again.
    await startCashHandoff(actor, id);
    await expect(splitBill(actor, id, { amountCents: 100 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Square POS/) });
    await startCashHandoff(actor, partIds[0]);
    await expect(splitBill(actor, id, { amountCents: 100 })).rejects.toMatchObject({ status: 409 });
    expect(await getSession(h, id)).toMatchObject({ total_cents: 1500, split_off_cents: 1000 });
  });

  it("a card payment after a handoff ends it too", async () => {
    // Handed to Square POS, the customer changes their mind and pays by card, the manager reopens.
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await startCashHandoff(actor, id);
    await chargeCard(actor, id);
    await webhookPaid("chk_1", id, 2500);
    await reversePaid(managerActor, manager, id, "Refunded on the Terminal");
    await setDiscount(actor, null, id, { discountId: "D_10" });
    expect((await getSession(h, id)).total_cents).toBe(2250);
  });

  it("the handed-over cash amount is the discounted total", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 85); // 3542
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 354.2 → 354 → 3188
    const out = await startCashHandoff(actor, id);
    expect(out.amountCents).toBe(3190);
    const [row] = await audits(h, id, "cash.handoff_started");
    expect(row.after).toMatchObject({ amount_cents: 3190, total_cents: 3188 });
  });
});

describe("F4. a discounted bill in Square", () => {
  beforeEach(async () => {
    await seedDiscount(h, { id: "D_10", name: "Members 10%", kind: "percent", value: 1000 });
    await seedDiscount(h, { id: "D_100", name: "On the house", kind: "percent", value: 10_000 });
  });

  async function discountedBill(): Promise<{ id: string; coke: string; water: string }> {
    const { actor } = h.staff;
    const id = await running();
    const coke = (await addItem(actor, id, "VAR_COKE", 2)).itemId;
    const water = (await addItem(actor, id, "VAR_WATER", 1)).itemId;
    await setDiscount(actor, null, id, { discountId: "D_10" });
    await stopSession(actor, id, at(60)); // 2500 + 900 + 300 = 3700, less 370 = 3330
    return { id, coke, water };
  }

  it("card: the bill's lines plus ONE amount off the whole order, named after the discount", async () => {
    await h.sql`update public.catalog_state set table_hire_variation_id = 'VAR_TABLE_HIRE'`;
    const { id, coke, water } = await discountedBill();
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toEqual({ kind: "sent", checkoutId: "chk_1", amountCents: 3330 });

    expect(h.gateway.orders).toHaveLength(1);
    const order = h.gateway.orders[0];
    expect(order.lines).toEqual([
      { uid: "table", catalogObjectId: "VAR_TABLE_HIRE", name: null, quantity: 1, basePriceCents: 2500, note: expect.stringMatching(/Table 1 · 1h/) },
      { uid: coke, catalogObjectId: "VAR_COKE", name: null, quantity: 2, basePriceCents: 450, note: null },
      { uid: water, catalogObjectId: "VAR_WATER", name: null, quantity: 1, basePriceCents: 300, note: null },
    ]);
    expect(order.discount).toEqual({ uid: "discount", name: "Members 10%", amountCents: 370 });
    // lines − discount is exactly what the Terminal is asked for
    expect(order.lines.reduce((a, l) => a + l.basePriceCents * l.quantity, 0) - (order.discount?.amountCents ?? 0)).toBe(3330);
    expect(h.gateway.creates[0]).toMatchObject({ idempotencyKey: `${id}-a1i`, amountCents: 3330, orderId: "ord_1" });
    expect(await auditActions(h, id)).not.toContain("checkout.itemise_failed");

    await webhookPaid("chk_1", id, 3330);
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_cents: 3330, total_cents: 3330, discount_cents: 370 });
    expect(await audits(h, id, "payment.conflict")).toHaveLength(0);
    await expectBillAddsUp(h, id);
  });

  it("the \"Square's total must equal ours\" check still stands behind it", async () => {
    const { id } = await discountedBill();
    h.gateway.orderTotalSkewCents = 1; // Square rounds the discount differently from us
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/doesn't match ours/) });
    expect(h.gateway.creates).toHaveLength(0);
    expect(await getCheckouts(h, id)).toHaveLength(0);
  });

  it("if Square refuses the itemised order, the discounted total still goes to the Terminal as a plain amount", async () => {
    const { id } = await discountedBill();
    h.gateway.orderError = squareRejection(400, "INVALID_VALUE", "Square couldn't itemise the bill: bad discount");
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 3330 });
    expect(h.gateway.creates[0]).toMatchObject({ idempotencyKey: `${id}-a1p`, amountCents: 3330 });
    expect(h.gateway.creates[0].orderId).toBeUndefined();
  });

  it("itemising off: exactly the discounted total as a plain amount, no order", async () => {
    await h.sql`update public.settings set itemise_charges = false`;
    const { id } = await discountedBill();
    await chargeCard(h.staff.actor, id);
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.creates[0]).toMatchObject({ idempotencyKey: `${id}-a1`, amountCents: 3330 });
  });

  it("cash: the stored order carries the discount, and Square gets the same order a card would", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 85); // 3542
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 354 off → 3188
    const out = await markPaid(actor, id, "cash", { cardConfirmed: false }, at(90));
    expect(out).toMatchObject({ kind: "paid", amountCents: 3190 });

    const [rec] = await records(id);
    expect(rec).toMatchObject({ amount_cents: 3190, bill_cents: 3188, state: "pending" });
    expect(rec.order_lines).toEqual({
      lines: [{ uid: "table", catalogObjectId: null, name: "Table hire", quantity: 1, basePriceCents: 3542, note: expect.stringMatching(/Table 1/) }],
      discount: { uid: "discount", name: "Members 10%", amountCents: 354 },
    });

    expect(await pushCashRecords()).toBe(1);
    expect(h.gateway.orders).toHaveLength(1);
    expect(h.gateway.orders[0]).toMatchObject({ idempotencyKey: `${id}-co1`, referenceId: id });
    expect(h.gateway.orders[0].lines).toEqual([expect.objectContaining({ uid: "table", basePriceCents: 3542 })]);
    expect(h.gateway.orders[0].discount).toEqual({ uid: "discount", name: "Members 10%", amountCents: 354 });
    // Cash for the 5c-rounded amount pays the order for the true (discounted) bill.
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(h.gateway.cashPayments[0]).toMatchObject({ idempotencyKey: `${id}-cp1`, amountCents: 3190, orderId: "ord_1" });
    expect((await records(id))[0]).toMatchObject({ state: "recorded", square_order_id: "ord_1", last_error: null });
    expect(await audits(h, id, "square.cash_itemise_failed")).toHaveLength(0);
  });

  it("a row stored the old way (a bare array of lines) is still read and sent with no discount", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await markPaid(actor, id, "cash", { cardConfirmed: false }, at(61));
    const [rec] = await records(id);
    expect(Array.isArray(rec.order_lines)).toBe(true); // no discount → exactly the old shape
    expect(await pushCashRecords()).toBe(1);
    expect("discount" in h.gateway.orders[0]).toBe(false);
    expect((await records(id))[0].state).toBe("recorded");
  });

  it("the stored order reads both shapes, and anything it can't read goes in as a plain amount", () => {
    const line = { uid: "table", catalogObjectId: null, name: "Table hire", quantity: 1, basePriceCents: 2500, note: "n" };
    const d = { uid: "discount", name: "Members 10%", amountCents: 250 };
    // old shape, as jsonb and as text
    expect(parseStoredOrder([line])).toEqual({ lines: [line], discount: null });
    expect(parseStoredOrder(JSON.stringify([line]))).toEqual({ lines: [line], discount: null });
    // new shape
    expect(parseStoredOrder({ lines: [line], discount: d })).toEqual({ lines: [line], discount: d });
    expect(parseStoredOrder({ lines: [line], discount: null })).toEqual({ lines: [line], discount: null });
    expect(parseStoredOrder({ lines: [line] })).toEqual({ lines: [line], discount: null });
    // fields come back in a fixed order whatever order they were stored in
    const shuffled = { note: "n", basePriceCents: 2500, quantity: 1, name: "Table hire", catalogObjectId: null, uid: "table", extra: 1 };
    expect(JSON.stringify(parseStoredOrder({ discount: { amountCents: 250, name: "Members 10%", uid: "discount" }, lines: [shuffled] }))).toBe(
      JSON.stringify({ lines: [line], discount: d }),
    );
    // unreadable → null (a plain amount), never lines without their discount
    for (const bad of [null, undefined, "", "not json", [], {}, { lines: [] }, [{ uid: 1 }], { lines: [line], discount: { uid: "discount" } }, { lines: [line], discount: { ...d, amountCents: 0 } }, { lines: [line], discount: "10%" }, 5]) {
      expect(parseStoredOrder(bad), JSON.stringify(bad)).toBeNull();
    }
    // what is written: a bare array without a discount, the object form with one
    expect(storedOrderJson([line], null)).toBe(JSON.stringify([line]));
    expect(storedOrderJson([line], undefined)).toBe(JSON.stringify([line]));
    expect(storedOrderJson([line], d)).toBe(JSON.stringify({ lines: [line], discount: d }));
    expect(storedOrderJson(null, d)).toBeNull();
    expect(storedOrderJson([], d)).toBeNull();
  });

  it("a stored order whose discount can't be read is recorded as a plain amount, not sent without its discount", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, id, { discountId: "D_10" });
    await markPaid(actor, id, "cash", { cardConfirmed: false }, at(61)); // 2250
    await h.sql`update public.square_cash_records set order_lines = jsonb_set(order_lines, '{discount}', '"ten percent"') where session_id = ${id}`;
    expect(await pushCashRecords()).toBe(1);
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.cashPayments[0]).toMatchObject({ idempotencyKey: `${id}-cq1`, amountCents: 2250 });
    expect(h.gateway.cashPayments[0].orderId).toBeUndefined();
    expect((await records(id))[0].state).toBe("recorded");
  });

  it("100% off: the bill stops at $0 awaiting payment, nothing can be charged, and Mark paid settles it with no Square call", async () => {
    const { actor } = h.staff;
    const id = await running();
    await addItem(actor, id, "VAR_COKE", 2);
    await setDiscount(actor, null, id, { discountId: "D_100" });
    expect(await stopSession(actor, id, at(60))).toEqual({ status: "awaiting_payment", billedMinutes: 60, totalCents: 0 });
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", total_cents: 0, discount_cents: 3400, items_cents: 900, void_reason: null });
    await expectBillAddsUp(h, id);

    await expect(chargeCard(actor, id)).rejects.toMatchObject({ status: 409, message: "There's nothing to charge on this bill." });
    await expect(startCashHandoff(actor, id)).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.creates).toHaveLength(0);

    const out = await markPaid(actor, id, "cash", { cardConfirmed: false }, at(61));
    expect(out).toMatchObject({ kind: "paid", method: "cash", via: "staff", amountCents: 0, warnings: [] });
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "cash", settled_cents: 0, total_cents: 0 });
    expect(await records(id)).toHaveLength(0);
    expect(await pushCashRecords()).toBe(0);
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.cashPayments).toHaveLength(0);
    const [paid] = await audits(h, id, "session.mark_paid");
    expect(paid.actor_staff_id).toBe(actor.staffId);
    expect(paid.after).toMatchObject({ status: "paid", total_cents: 0, settled_cents: 0, nothing_to_pay: true });
    expect(paid.after?.square_cash_seq).toBeUndefined();
    expect(paid.reason).toBe("Closed with nothing to pay: the bill came to $0.00.");

    // by card is the same: recorded, nothing sent anywhere
    const other = await awaitingPayment(h, "Table 2", 60);
    await setDiscount(actor, null, other, { discountId: "D_100" });
    expect(await markPaid(actor, other, "card", { cardConfirmed: true }, at(61))).toMatchObject({ kind: "paid", method: "card", amountCents: 0 });
    expect(await getSession(h, other)).toMatchObject({ status: "paid", settled_cents: 0 });
    expect(h.gateway.creates).toHaveLength(0);

    // In the summary both are sessions with their discounts, and both are on the paid list (so a
    // manager can reverse one), but neither is a card payment or a cash payment: no money was taken.
    const sum = await getSummary("2026-11-20");
    expect(sum.sessions).toEqual({ count: 2, billedMinutes: 120, billedCents: 0, tableCents: 5000, itemsCents: 900, discountCents: 5900, writtenOffCents: 0 });
    expect(sum.paid.card).toEqual({ count: 0, cents: 0 });
    expect(sum.paid.cash).toEqual({ count: 0, cents: 0, roundingCents: 0 });
    expect(sum.squareCashOutstanding).toEqual({ count: 0, cents: 0, failed: 0 });
    expect(sum.paidItems.map((p) => [p.id, p.method, p.totalCents, p.settledCents, p.squareCash]).sort()).toEqual(
      [
        [id, "cash", 0, 0, null],
        [other, "card", 0, 0, null],
      ].sort(),
    );
    expect(sum.unpaid.count).toBe(0);

    // An ordinary bill marked paid is audited as it always was: no "nothing to pay" on it.
    const plain = await awaitingPayment(h, "Table 3", 60);
    await markPaid(actor, plain, "cash", { cardConfirmed: false }, at(62));
    const [plainRow] = await audits(h, plain, "session.mark_paid");
    expect(plainRow.reason).toBeNull();
    expect(plainRow.after?.nothing_to_pay).toBeUndefined();
    const after = await getSummary("2026-11-20");
    expect(after.paid.cash).toEqual({ count: 1, cents: 2500, roundingCents: 0 });
    expect(after.paid.card).toEqual({ count: 0, cents: 0 });
  });

  it("a real 1c or 2c cash bill (rounds to nothing collected) is still a cash payment, with its rounding", async () => {
    // Not a $0 bill: something was owed and the 5c rule rounded it away. It stays in the cash tally
    // so the rounding figure is complete.
    const { actor } = h.staff;
    const { sessionId: id } = await openCounterSale(actor, at(5));
    await addCustomItem(actor, id, "Sticker", 2);
    expect(await markPaid(actor, id, "cash", { cardConfirmed: false }, at(6))).toMatchObject({ kind: "paid", amountCents: 0 });
    const [row] = await audits(h, id, "session.mark_paid");
    expect(row.after?.nothing_to_pay).toBeUndefined();
    const sum = await getSummary("2026-11-20");
    expect(sum.paid.cash).toEqual({ count: 1, cents: 0, roundingCents: -2 });
  });

  it("a discount on a session with nothing to charge changes nothing: it still closes as a no-charge void", async () => {
    const { actor } = h.staff;
    const id = await running();
    await setDiscount(actor, null, id, { discountId: "D_10" });
    expect(await stopSession(actor, id, at(0))).toEqual({ status: "void", billedMinutes: 0, totalCents: 0 });
    expect(await getSession(h, id)).toMatchObject({ status: "void", total_cents: 0, discount_cents: 0, discount_id: "D_10" });
    await expectBillAddsUp(h, id);
  });

  it("summary: table time + items − discounts = billed", async () => {
    const { actor } = h.staff;
    const { id } = await discountedBill(); // table 2500, items 1200, 370 off → 3330
    await markPaid(actor, id, "cash", { cardConfirmed: false }, at(61));
    const plain = await awaitingPayment(h, "Table 2", 60); // 2500, no discount

    const sum = await getSummary("2026-11-20");
    expect(sum.sessions).toEqual({ count: 2, billedMinutes: 120, billedCents: 3330 + 2500, tableCents: 5000, itemsCents: 1200, discountCents: 370, writtenOffCents: 0 });
    expect(sum.sessions.tableCents + sum.sessions.itemsCents - sum.sessions.discountCents).toBe(sum.sessions.billedCents);
    expect(sum.itemsSold.reduce((a, i) => a + i.cents, 0)).toBe(sum.sessions.itemsCents);
    expect(sum.paid.cash).toEqual({ count: 1, cents: 3330, roundingCents: 0 });
    expect(sum.paidItems[0]).toMatchObject({ id, kind: "table", tableNames: "Table 1", totalCents: 3330, settledCents: 3330 });
    expect(sum.unpaid).toMatchObject({ count: 1, cents: 2500 });
    expect(sum.unpaid.items[0]).toMatchObject({ id: plain, kind: "table" });
  });
});

// ---------------------------------------------------------------------------
// The release before this one, against this schema
// ---------------------------------------------------------------------------

describe("X. old code on the new schema, and new code on what old code wrote", () => {
  beforeEach(async () => {
    await seedDiscount(h, { id: "D_10", name: "Members 10%", kind: "percent", value: 1000 });
  });

  /** The statements the previous release runs, word for word, which know none of the new columns. */
  const old = {
    start: async (table: string) =>
      (
        await h.sql<{ id: string }[]>`
          insert into public.sessions (status, current_table_id, opened_at, opened_by)
          values ('running', ${h.tableId(table)}, ${at(0)}, ${h.staff.actor.staffId})
          returning id`
      )[0].id,
    addItemRunning: async (id: string, cents: number) => {
      await h.sql`
        insert into public.session_items (session_id, product_id, name, unit_cents, quantity, taxed, added_by)
        values (${id}, 'VAR_COKE', 'Coke', ${cents}, 1, true, ${h.staff.actor.staffId})`;
      await h.sql`update public.sessions set items_cents = items_cents + ${cents} where id = ${id}`;
    },
    addItemClosed: async (id: string, cents: number) => {
      await h.sql`
        insert into public.session_items (session_id, product_id, name, unit_cents, quantity, taxed, added_by)
        values (${id}, 'VAR_COKE', 'Coke', ${cents}, 1, true, ${h.staff.actor.staffId})`;
      await h.sql`
        update public.sessions set items_cents = items_cents + ${cents}, total_cents = total_cents + ${cents},
          checkout_attempt = checkout_attempt + 1
        where id = ${id}`;
    },
  };

  it("a session and a line written the old way get safe defaults for every new column", async () => {
    const id = await old.start("Table 1");
    await h.sql`insert into public.session_intervals (session_id, table_id, started_at) values (${id}, ${h.tableId("Table 1")}, ${at(0)})`;
    await old.addItemRunning(id, 450);
    expect(await getSession(h, id)).toMatchObject({
      kind: "table",
      split_of: null,
      split_off_cents: 0,
      merged: false,
      discount_id: null,
      discount_name: null,
      discount_kind: null,
      discount_value: null,
      discount_cents: 0,
      discount_by: null,
      discount_approved_by: null,
      refunded_cents: 0,
    });
    expect((await getItems(h, id))[0]).toMatchObject({ kind: "product", product_id: "VAR_COKE" });

    // The new code takes it from there: stop, add to the closed bill the old way, charge.
    expect(await stopSession(h.staff.actor, id, at(60))).toEqual({ status: "awaiting_payment", billedMinutes: 60, totalCents: 2950 });
    await old.addItemClosed(id, 450);
    expect(await expectBillAddsUp(h, id)).toEqual({ tableCents: 2500, itemsCents: 900, discountCents: 0, splitOffCents: 0, totalCents: 3400 });
    expect(await chargeCard(h.staff.actor, id)).toMatchObject({ kind: "sent", amountCents: 3400 });
    expect(await auditActions(h, id)).not.toContain("session.repriced");

    const dto = (await getUnpaid()).sessions.find((s) => s.id === id);
    expect(dto).toMatchObject({ kind: "table", label: "Table 1", discount: null, splitOffCents: 0, parts: [], splitOfId: null });
  });

  it("an item added the old way to a discounted bill leaves the percentage stale; the next charge puts it right first", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 250 off → 2250
    await old.addItemClosed(id, 450); // old code: total 2700, discount still 250 (should be 295)
    expect(await getSession(h, id)).toMatchObject({ total_cents: 2700, discount_cents: 250, items_cents: 450 });

    const out = await chargeCard(actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 2655 });
    expect(h.gateway.orders[0].discount).toEqual({ uid: "discount", name: "Members 10%", amountCents: 295 });
    const [fixed] = await audits(h, id, "session.repriced");
    expect(fixed.before).toMatchObject({ total_cents: 2700, discount_cents: 250 });
    expect(fixed.after).toMatchObject({ total_cents: 2655, discount_cents: 295, items_cents: 450 });
    await expectBillAddsUp(h, id);
  });

  it("a total the old code re-priced without the discount is put right before cash is handed to Square POS", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 2250
    // What the previous release's charge-time re-pricing writes: table time + items, nothing else.
    await h.sql`update public.sessions set total_cents = 2500 where id = ${id}`;
    const out = await startCashHandoff(actor, id);
    expect(out.amountCents).toBe(2250);
    expect(await getSession(h, id)).toMatchObject({ total_cents: 2250, discount_cents: 250 });
    expect(await audits(h, id, "session.repriced")).toHaveLength(1);
    await expectBillAddsUp(h, id);
  });

  it("marking paid never re-prices: a bill whose stored total is off is settled as shown, and its cash sale goes to Square as a plain amount", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 2250
    await h.sql`update public.sessions set total_cents = 2500 where id = ${id}`;
    const out = await markPaid(actor, id, "cash", { cardConfirmed: false }, at(61));
    expect(out).toMatchObject({ kind: "paid", amountCents: 2500 });
    const [rec] = await records(id);
    // The lines would add up to 2250, not the 2500 collected: no order, just the amount.
    expect(rec).toMatchObject({ amount_cents: 2500, bill_cents: 2500, order_lines: null });
    expect(await pushCashRecords()).toBe(1);
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.cashPayments[0]).toMatchObject({ idempotencyKey: `${id}-cq1`, amountCents: 2500 });
  });
});
