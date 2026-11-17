import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { bootHarness, INIT_SQL, PRELUDE_SQL, REFERENCE_SQL, SESSION_ITEMS_SQL, SQUARE_CASH_SQL, type Harness } from "./helpers/harness";
import { squareRejection, squareServerError, squareTimeout } from "./helpers/fake-gateway";
import { T0, at, audits, awaitingPayment, getSession, seedProduct } from "./helpers/util";
import { getAdminState } from "@/lib/server/admin";
import { setDbForTests, withTx } from "@/lib/server/db";
import { getSessionDetail, getSummary } from "@/lib/server/queries";
import {
  addItem,
  applyWebhookCheckout,
  chargeCard,
  markPaid,
  reversePaid,
  startSession,
  stopSession,
} from "@/lib/server/sessions";
import {
  MAX_ATTEMPTS,
  getCashOutstanding,
  pushCashInBackground,
  pushCashRecords,
  retryCashRecords,
  type CashRecordRow,
} from "@/lib/server/square-cash";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
  // Stand-in for Supabase's realtime.send: records each floor broadcast so a test can count them.
  await h.raw(null, `create schema realtime`);
  await h.raw(null, `create table realtime.sent (id serial primary key, topic text not null, event text not null)`);
  await h.raw(
    null,
    `create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void
     language sql as $$ insert into realtime.sent (topic, event) values (topic, event) $$`,
  );
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const broadcasts = async () => (await h.raw<{ n: number }>(null, `select count(*)::int as n from realtime.sent`))[0]?.n ?? 0;

const records = (sessionId: string) =>
  h.sql<CashRecordRow[]>`select * from public.square_cash_records where session_id = ${sessionId} order by seq`;

const record = async (sessionId: string): Promise<CashRecordRow> => {
  const rows = await records(sessionId);
  return rows[rows.length - 1];
};

/** Makes every waiting record due now (stands in for the back-off time passing). */
const makeDue = () => h.raw(null, `update public.square_cash_records set next_attempt_at = now() where state = 'pending'`);

/** 85 minutes at $25/h = $35.42: a bill that isn't a multiple of 5c. Cash collects $35.40. */
const oddBill = () => awaitingPayment(h, "Table 1", 85);

const payCash = (id: string, minute = 100) => markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(minute));
const reverse = (id: string) => reversePaid(h.staff.managerActor, h.staff.manager, id, "Wrong bill");

describe("SC1. marking a bill paid in cash", () => {
  it("collects the bill rounded to 5c and queues the sale for Square without calling Square", async () => {
    const id = await oddBill();
    const out = await payCash(id);
    expect(out).toMatchObject({ kind: "paid", method: "cash", via: "staff", amountCents: 3540 });

    const s = await getSession(h, id);
    expect(s).toMatchObject({ status: "paid", settled_method: "cash", total_cents: 3542, settled_cents: 3540 });

    const rows = await records(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: 1,
      amount_cents: 3540,
      bill_cents: 3542,
      want: "recorded",
      state: "pending",
      attempts: 0,
      square_order_id: null,
      square_payment_id: null,
      created_by: h.staff.actor.staffId,
    });
    expect(rows[0].note).toMatch(/Table 1/);
    // Nothing has gone to Square: that happens after the response.
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.cashPayments).toHaveLength(0);

    const [row] = await audits(h, id, "session.mark_paid");
    expect(row.after).toMatchObject({ total_cents: 3542, settled_cents: 3540, square_cash_seq: 1 });
  });

  it("records the rounded cash against an order for the true bill, exactly once", async () => {
    await seedProduct(h, { id: "VAR_COKE", name: "Coke", priceCents: 450 });
    const { sessionId: id } = await startSession(h.staff.actor, h.tableId("Table 1"), T0);
    await addItem(h.staff.actor, id, "VAR_COKE", 2);
    await stopSession(h.staff.actor, id, at(85)); // 3542 + 900 = 4442 → cash 4440
    expect(await payCash(id)).toMatchObject({ kind: "paid", amountCents: 4440 });

    expect(await pushCashRecords()).toBe(1);

    expect(h.gateway.orders).toHaveLength(1);
    expect(h.gateway.orders[0]).toMatchObject({ idempotencyKey: `${id}-co1`, locationId: "LOC_TEST", referenceId: id });
    expect(h.gateway.orders[0].lines.map((l) => [l.uid === "table" ? "table" : l.catalogObjectId, l.quantity, l.basePriceCents])).toEqual([
      ["table", 1, 3542],
      ["VAR_COKE", 2, 450],
    ]);
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(h.gateway.cashPayments[0]).toMatchObject({
      idempotencyKey: `${id}-cp1`,
      amountCents: 4440,
      locationId: "LOC_TEST",
      referenceId: id,
      orderId: "ord_1",
    });
    // Square limits payment and refund keys to 45 characters.
    expect(h.gateway.cashPayments[0].idempotencyKey.length).toBeLessThanOrEqual(45);
    // The order was for $44.42; the cash paid it and Square rounded it to $44.40.
    expect(h.gateway.paidOrders.get("ord_1")).toBe(4440);

    expect(await record(id)).toMatchObject({
      state: "recorded",
      square_order_id: "ord_1",
      square_payment_id: "pay_1",
      square_refund_id: null,
      attempts: 1,
      last_error: null,
      claimed_at: null,
    });

    // Nothing is due any more: further passes send nothing.
    expect(await pushCashRecords()).toBe(0);
    await pushCashInBackground();
    expect(h.gateway.orders).toHaveLength(1);
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(h.gateway.payments.size).toBe(1);
  });

  it("the order lines are fixed when the bill is paid, whatever changes afterwards", async () => {
    const id = await oddBill();
    await payCash(id);
    // "Table hire" gets linked in the catalogue before the sale is sent.
    await h.sql`update public.catalog_state set table_hire_variation_id = 'VAR_TABLE'`;
    await pushCashRecords();
    expect(h.gateway.orders[0].lines).toEqual([
      { uid: "table", catalogObjectId: null, name: "Table hire", quantity: 1, basePriceCents: 3542, note: expect.stringMatching(/Table 1/) },
    ]);
  });

  it("with itemised charges off it records a plain amount and creates no order", async () => {
    await h.sql`update public.settings set itemise_charges = false`;
    const id = await oddBill();
    await payCash(id);
    expect((await record(id)).order_lines).toBeNull();

    await pushCashRecords();
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(h.gateway.cashPayments[0]).toMatchObject({ idempotencyKey: `${id}-cq1`, amountCents: 3540, referenceId: id });
    expect(h.gateway.cashPayments[0].orderId).toBeUndefined();
    expect(await record(id)).toMatchObject({ state: "recorded", square_order_id: null, square_payment_id: "pay_1" });
  });

  it("queues nothing when Square isn't set up, and the bill is still paid", async () => {
    const token = process.env.SQUARE_ACCESS_TOKEN;
    delete process.env.SQUARE_ACCESS_TOKEN;
    try {
      const id = await oddBill();
      expect(await payCash(id)).toMatchObject({ kind: "paid", amountCents: 3540 });
      expect(await records(id)).toHaveLength(0);
      await pushCashInBackground();
      expect(h.gateway.cashPayments).toHaveLength(0);
      // Reversing it has nothing to undo in Square.
      await reverse(id);
      expect((await getSession(h, id)).status).toBe("awaiting_payment");
    } finally {
      process.env.SQUARE_ACCESS_TOKEN = token;
    }
  });
});

describe("SC2. Square slow or down", () => {
  it("the bill is paid anyway; the sale stays pending and a later pass records it once", async () => {
    h.gateway.orderError = squareTimeout();
    h.gateway.orderErrorSticky = true;
    h.gateway.cashError = squareTimeout();
    h.gateway.cashErrorSticky = true;

    const id = await oddBill();
    expect(await payCash(id)).toMatchObject({ kind: "paid", amountCents: 3540 });
    expect((await getSession(h, id)).status).toBe("paid");

    await pushCashInBackground(); // never throws
    let r = await record(id);
    expect(r).toMatchObject({ state: "pending", attempts: 1, square_payment_id: null, claimed_at: null });
    expect(r.last_error).toMatch(/didn't answer/);
    expect(r.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 20_000); // backed off 30 s
    expect(await audits(h, id, "square.cash_failed")).toHaveLength(0);

    // Not due yet: polling again doesn't hit Square.
    const calls = h.gateway.orders.length;
    await pushCashInBackground();
    expect(h.gateway.orders).toHaveLength(calls);

    // Square comes back.
    h.gateway.orderError = null;
    h.gateway.cashError = null;
    await makeDue();
    await pushCashInBackground();
    r = await record(id);
    expect(r).toMatchObject({ state: "recorded", attempts: 2, square_order_id: "ord_1", square_payment_id: "pay_1", last_error: null });
    expect(h.gateway.payments.size).toBe(1);
  });

  it("a payment Square made but answered too slowly is not made twice", async () => {
    const id = await oddBill();
    await payCash(id);
    h.gateway.cashError = squareTimeout();
    h.gateway.cashFailAfterCreating = true;
    await pushCashRecords();
    expect(await record(id)).toMatchObject({ state: "pending", square_order_id: "ord_1", square_payment_id: null });
    expect(h.gateway.payments.size).toBe(1); // Square has it; the app doesn't know yet

    await makeDue();
    await pushCashRecords();
    expect(await record(id)).toMatchObject({ state: "recorded", square_payment_id: "pay_1" });
    // Same keys, same bodies: one order, one payment.
    expect(h.gateway.orders).toHaveLength(1);
    expect(h.gateway.cashPayments.map((p) => p.idempotencyKey)).toEqual([`${id}-cp1`, `${id}-cp1`]);
    expect(h.gateway.payments.size).toBe(1);
  });

  it("a server error or an expired token is retried, not treated as a refusal", async () => {
    const id = await oddBill();
    await payCash(id);

    h.gateway.cashError = squareServerError();
    await pushCashRecords();
    expect(await record(id)).toMatchObject({ state: "pending", attempts: 1 });

    // 401: the token is the problem, not the sale. The itemised order is kept for the retry.
    h.gateway.orderErrorSticky = true;
    h.gateway.cashError = squareRejection(401, "UNAUTHORIZED");
    await makeDue();
    await pushCashRecords();
    const r = await record(id);
    expect(r).toMatchObject({ state: "pending", attempts: 2, square_order_id: "ord_1" });
    expect(r.order_lines).not.toBeNull();

    await makeDue();
    await pushCashRecords();
    expect(await record(id)).toMatchObject({ state: "recorded", square_payment_id: "pay_1" });
    expect(h.gateway.payments.size).toBe(1);
  });

  it("gives up after 12 tries and asks for a manager", async () => {
    const id = await oddBill();
    await payCash(id);
    await h.raw(null, `update public.square_cash_records set attempts = ${MAX_ATTEMPTS - 1}`);
    h.gateway.cashError = squareTimeout();
    await pushCashRecords();

    expect(await record(id)).toMatchObject({ state: "failed", attempts: MAX_ATTEMPTS, claimed_at: null });
    const [a] = await audits(h, id, "square.cash_failed");
    expect(a.reason).toMatch(/\$35\.40 cash payment isn't in Square/);
    expect(a.reason).toMatch(/after 12 tries/);
    expect(a.actor_staff_id).toBeNull();
  });

  it("backs off longer each time, up to 15 minutes", async () => {
    const id = await oddBill();
    await payCash(id);
    h.gateway.cashError = squareTimeout();
    h.gateway.cashErrorSticky = true;
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      await makeDue();
      await pushCashRecords();
      const [w] = await h.sql<{ s: number }[]>`
        select round(extract(epoch from next_attempt_at - updated_at))::int as s from public.square_cash_records`;
      waits.push(w.s);
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 900, 900]);
  });
});

describe("SC3. Square won't take the itemised order", () => {
  it("a different total from Square falls back to a plain amount and says why", async () => {
    h.gateway.orderTotalSkewCents = 10;
    const id = await oddBill();
    await payCash(id);
    await pushCashRecords();

    expect(h.gateway.orders).toHaveLength(1);
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(h.gateway.cashPayments[0]).toMatchObject({ idempotencyKey: `${id}-cq1`, amountCents: 3540 });
    expect(h.gateway.cashPayments[0].orderId).toBeUndefined();
    expect(h.gateway.paidOrders.size).toBe(0);

    const r = await record(id);
    expect(r).toMatchObject({ state: "recorded", square_order_id: null, square_payment_id: "pay_1", order_lines: null });
    expect(r.last_error).toMatch(/\$35\.52\) doesn't match ours \(\$35\.42\)/);

    const [a] = await audits(h, id, "square.cash_itemise_failed");
    expect(a.after).toMatchObject({ seq: 1, order_id: "ord_1", square_total_cents: 3552, bill_cents: 3542 });
    expect(Array.isArray(a.after?.lines)).toBe(true); // the lines that were dropped are kept here
    // Recorded in Square, so staff aren't shown an error for it.
    expect((await getSessionDetail(id)).session.squareCash).toEqual({ state: "recorded", amountCents: 3540, error: null });
  });

  it("a refused order falls back to a plain amount", async () => {
    h.gateway.orderError = squareRejection(400, "INVALID_VALUE", "Square couldn't itemise the bill: bad line");
    const id = await oddBill();
    await payCash(id);
    await pushCashRecords();
    expect(h.gateway.cashPayments.map((p) => [p.idempotencyKey, p.orderId])).toEqual([[`${id}-cq1`, undefined]]);
    expect(await record(id)).toMatchObject({ state: "recorded", order_lines: null });
    expect(await audits(h, id, "square.cash_itemise_failed")).toHaveLength(1);
  });

  it("once it has gone plain it stays plain, even if the plain payment has to be retried", async () => {
    h.gateway.orderError = squareRejection();
    h.gateway.cashError = squareTimeout();
    h.gateway.cashFailAfterCreating = true; // Square made the plain payment, then timed out
    const id = await oddBill();
    await payCash(id);
    await pushCashRecords();
    expect(await record(id)).toMatchObject({ state: "pending", order_lines: null });

    await makeDue();
    await pushCashRecords(); // the order would be accepted now, but must not be tried again
    expect(h.gateway.orders).toHaveLength(1);
    expect(h.gateway.cashPayments.map((p) => p.idempotencyKey)).toEqual([`${id}-cq1`, `${id}-cq1`]);
    expect(h.gateway.payments.size).toBe(1);
    expect((await record(id)).state).toBe("recorded");
  });
});

describe("SC4. Square refuses the payment", () => {
  it("fails the record, writes an audit row, and shows in the summary and Admin until a manager retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(105));
    try {
      const id = await oddBill();
      await payCash(id);
      h.gateway.cashError = squareRejection(400, "BAD_REQUEST", "Square couldn't record the cash payment: location is not active");
      await pushCashRecords();

      const r = await record(id);
      expect(r).toMatchObject({ state: "failed", attempts: 1, square_payment_id: null, claimed_at: null });
      expect(r.last_error).toMatch(/location is not active/);
      expect((await getSession(h, id)).status).toBe("paid"); // the bill is unaffected

      const failed = await audits(h, id, "square.cash_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].entity).toBe("session");
      expect(failed[0].reason).toMatch(/The \$35\.40 cash payment isn't in Square\. .*location is not active/);
      expect(failed[0].after).toMatchObject({ seq: 1, step: "payment", amount_cents: 3540 });

      // A failed record is left alone by the background pass.
      await pushCashInBackground();
      expect(h.gateway.cashPayments).toHaveLength(1);

      const sum = await getSummary(null);
      expect(sum.attention.map((a) => a.action)).toContain("square.cash_failed");
      expect(sum.squareCashOutstanding).toEqual({ count: 1, cents: 3540, failed: 1 });
      expect(sum.paid.cash).toEqual({ count: 1, cents: 3540, roundingCents: -2 });
      expect(sum.paidItems[0]).toMatchObject({ totalCents: 3542, settledCents: 3540 });
      expect(sum.paidItems[0].squareCash).toMatchObject({ state: "failed", amountCents: 3540 });
      expect(sum.paidItems[0].squareCash?.error).toMatch(/location is not active/);
      expect(() => JSON.stringify(sum)).not.toThrow();

      const admin = await getAdminState(h.staff.manager);
      expect(admin.squareCash).toMatchObject({ pending: 0, failed: 1 });
      expect(admin.squareCash.lastError).toMatch(/location is not active/);

      // The manager fixes the problem in Square and retries.
      const after = await retryCashRecords(h.staff.managerActor, h.staff.manager);
      expect(after).toEqual({ pending: 0, failed: 0, lastError: null });
      expect(await record(id)).toMatchObject({ state: "recorded", square_payment_id: "pay_1" });
      expect(h.gateway.payments.size).toBe(1);
      expect((await getSummary(null)).squareCashOutstanding).toEqual({ count: 0, cents: 0, failed: 0 });

      const [retry] = await h.sql<{ before: unknown; after: unknown; approved_by_staff_id: string }[]>`
        select before, after, approved_by_staff_id from public.audit_log where action = 'square.cash_retry'`;
      expect(retry).toMatchObject({ before: { pending: 0, failed: 1 }, after: { pending: 0, failed: 0 }, approved_by_staff_id: h.staff.manager.id });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refused payment against an order fails rather than being sent again as a plain amount", async () => {
    const id = await oddBill();
    await payCash(id);
    h.gateway.cashError = squareRejection(400, "BAD_REQUEST", "Square couldn't record the cash payment: the order is already paid.");
    await pushCashRecords();
    // "Already paid" may mean the sale is in Square. Sending a plain one could record it twice.
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(await record(id)).toMatchObject({ state: "failed", square_order_id: "ord_1" });
  });

  it("an idempotency key Square has seen with a different body fails without sending anything else", async () => {
    const id = await oddBill();
    await payCash(id);
    h.gateway.cashError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
    await pushCashRecords();
    const r = await record(id);
    expect(r.state).toBe("failed");
    expect(r.last_error).toMatch(/different request on file/);
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(await audits(h, id, "square.cash_failed")).toHaveLength(1);
  });

  it("retry also sends records that were only waiting, and still reports what is left", async () => {
    const a = await oddBill();
    await payCash(a);
    h.gateway.cashError = squareTimeout();
    await pushCashRecords(); // a: pending, backed off
    const b = await awaitingPayment(h, "Table 2", 60);
    await payCash(b);
    h.gateway.orderError = squareRejection();
    h.gateway.cashError = squareRejection(400, "BAD_REQUEST", "Square couldn't record the cash payment: nope");
    await pushCashRecords(); // b: failed
    expect(await getCashOutstanding()).toMatchObject({ pending: 1, failed: 1 });

    h.gateway.cashError = squareRejection(400, "BAD_REQUEST", "Square couldn't record the cash payment: still nope");
    const left = await retryCashRecords(h.staff.managerActor, h.staff.manager);
    // One of the two went through; the other was refused again.
    expect(left.pending + left.failed).toBe(1);
    expect(left.failed).toBe(1);
    expect(left.lastError).toMatch(/still nope/);
    expect(h.gateway.payments.size).toBe(1);
  });
});

describe("SC5. reversing a cash payment", () => {
  it("before anything was sent: the record is skipped and nothing ever goes to Square", async () => {
    const id = await oddBill();
    await payCash(id);
    await reverse(id);

    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", settled_cents: null, settled_method: null });
    expect(await record(id)).toMatchObject({ state: "skipped", want: "recorded", attempts: 0 });
    const [a] = await audits(h, id, "session.reverse_paid");
    expect(a.after).toMatchObject({ square_cash: "skipped" });
    expect(a.before).toMatchObject({ settled_cents: 3540 });

    expect(await pushCashRecords()).toBe(0);
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.cashPayments).toHaveLength(0);
    expect(h.gateway.refunds).toHaveLength(0);
    expect((await getSessionDetail(id)).session).toMatchObject({ settledCents: null, squareCash: { state: "skipped", amountCents: 3540, error: null } });
  });

  it("after it was recorded: the sale is refunded in full, once", async () => {
    const id = await oddBill();
    await payCash(id);
    await pushCashRecords();
    await reverse(id);

    expect(await record(id)).toMatchObject({ state: "pending", want: "refunded", square_payment_id: "pay_1", square_refund_id: null });
    expect((await audits(h, id, "session.reverse_paid"))[0].after).toMatchObject({ square_cash: "refund_queued" });

    await pushCashRecords();
    expect(h.gateway.refunds).toEqual([
      { idempotencyKey: `${id}-cr1`, paymentId: "pay_1", amountCents: 3540, reason: "Payment reversed in the table timer" },
    ]);
    expect(await record(id)).toMatchObject({ state: "refunded", square_refund_id: "ref_1", claimed_at: null });

    await pushCashRecords();
    await pushCashInBackground();
    expect(h.gateway.refunds).toHaveLength(1);
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(h.gateway.payments.get("pay_1")?.refundedCents).toBe(3540);
  });

  it("a refund Square is slow to take is retried with the same key", async () => {
    const id = await oddBill();
    await payCash(id);
    await pushCashRecords();
    await reverse(id);
    h.gateway.refundError = squareTimeout();
    await pushCashRecords();
    expect(await record(id)).toMatchObject({ state: "pending", want: "refunded", square_refund_id: null });

    await makeDue();
    await pushCashRecords();
    expect(h.gateway.refunds.map((r) => r.idempotencyKey)).toEqual([`${id}-cr1`, `${id}-cr1`]);
    expect(h.gateway.refundsHeld.size).toBe(1);
    expect((await record(id)).state).toBe("refunded");
  });

  it("a refused refund fails and is flagged as a refund", async () => {
    const id = await oddBill();
    await payCash(id);
    await pushCashRecords();
    await reverse(id);
    h.gateway.refundError = squareRejection(400, "REFUND_AMOUNT_INVALID", "Square couldn't record the refund: already refunded");
    await pushCashRecords();
    expect(await record(id)).toMatchObject({ state: "failed", want: "refunded" });
    const [a] = await audits(h, id, "square.cash_failed");
    expect(a.reason).toMatch(/The refund of the \$35\.40 cash payment isn't in Square\. .*already refunded/);
  });

  it("while the sale is on its way to Square: it ends up refunded", async () => {
    const id = await oddBill();
    await payCash(id);
    // The manager reverses the payment while Square is still answering.
    h.gateway.duringCashPayment = () => reverse(id);
    await pushCashRecords();

    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(h.gateway.refunds).toHaveLength(1);
    expect(h.gateway.refunds[0]).toMatchObject({ idempotencyKey: `${id}-cr1`, paymentId: "pay_1", amountCents: 3540 });
    expect(await record(id)).toMatchObject({ state: "refunded", want: "refunded", square_payment_id: "pay_1", square_refund_id: "ref_1" });
  });

  it("while the sale is on its way and Square times out: the next pass finds the sale and refunds it", async () => {
    const id = await oddBill();
    await payCash(id);
    h.gateway.cashError = squareTimeout();
    h.gateway.cashFailAfterCreating = true;
    h.gateway.duringCashPayment = () => reverse(id);
    await pushCashRecords();
    // Something was sent, so the reversal could not just skip the record.
    expect(await record(id)).toMatchObject({ state: "pending", want: "refunded", square_payment_id: null });

    await makeDue();
    await pushCashRecords();
    expect(h.gateway.payments.size).toBe(1);
    expect(h.gateway.refundsHeld.size).toBe(1);
    expect((await record(id)).state).toBe("refunded");
  });

  it("reversed after Square refused the sale: nothing in Square, so nothing to refund", async () => {
    const id = await oddBill();
    await payCash(id);
    h.gateway.cashError = squareRejection(400, "BAD_REQUEST", "Square couldn't record the cash payment: nope");
    h.gateway.cashErrorSticky = true;
    await pushCashRecords();
    expect((await record(id)).state).toBe("failed");

    await reverse(id);
    await pushCashRecords();
    expect(await record(id)).toMatchObject({ state: "skipped", square_payment_id: null });
    expect(h.gateway.refunds).toHaveLength(0);
    expect(await audits(h, id, "square.cash_failed")).toHaveLength(1); // not flagged a second time
  });

  it("paid in cash, reversed, paid in cash again: a second record with its own keys", async () => {
    const id = await oddBill();
    await payCash(id);
    await pushCashRecords();
    await reverse(id);
    await payCash(id, 110);
    await pushCashRecords();

    const rows = await records(id);
    expect(rows.map((r) => [r.seq, r.state, r.want])).toEqual([
      [1, "refunded", "refunded"],
      [2, "recorded", "recorded"],
    ]);
    expect(h.gateway.orders.map((o) => o.idempotencyKey)).toEqual([`${id}-co1`, `${id}-co2`]);
    expect(h.gateway.cashPayments.map((p) => p.idempotencyKey)).toEqual([`${id}-cp1`, `${id}-cp2`]);
    expect(h.gateway.refunds.map((r) => r.idempotencyKey)).toEqual([`${id}-cr1`]);
    expect(rows[1]).toMatchObject({ square_order_id: "ord_2", square_payment_id: "pay_2" });
    expect(h.gateway.payments.size).toBe(2);
    expect((await getSessionDetail(id)).session).toMatchObject({ settledCents: 3540, squareCash: { state: "recorded" } });

    // Reversing again touches only the second record.
    await reverse(id);
    await pushCashRecords();
    expect((await records(id)).map((r) => r.state)).toEqual(["refunded", "refunded"]);
    expect(h.gateway.refunds.map((r) => [r.idempotencyKey, r.paymentId])).toEqual([
      [`${id}-cr1`, "pay_1"],
      [`${id}-cr2`, "pay_2"],
    ]);
  });

  it("reversed before sending, then paid by card: the skipped record is left alone", async () => {
    const id = await oddBill();
    await payCash(id);
    await reverse(id);
    await markPaid(h.staff.actor, id, "card", { cardConfirmed: true }, at(110));
    await reverse(id);
    expect((await records(id)).map((r) => [r.seq, r.state])).toEqual([[1, "skipped"]]);
    await pushCashRecords();
    expect(h.gateway.cashPayments).toHaveLength(0);
    expect(h.gateway.refunds).toHaveLength(0);
  });
});

describe("SC6. concurrency and the background pass", () => {
  it("two passes at once send each sale once", async () => {
    const a = await oddBill();
    const b = await awaitingPayment(h, "Table 2", 60);
    await payCash(a);
    await payCash(b);
    await Promise.all([pushCashRecords(), pushCashRecords(), pushCashInBackground()]);

    expect(h.gateway.cashPayments.map((p) => p.idempotencyKey).sort()).toEqual([`${a}-cp1`, `${b}-cp1`].sort());
    expect(h.gateway.orders).toHaveLength(2);
    expect(h.gateway.payments.size).toBe(2);
    expect((await record(a)).attempts).toBe(1);
    expect((await record(b)).attempts).toBe(1);
  });

  it("a record another worker is sending is left alone for a minute, then picked up", async () => {
    const id = await oddBill();
    await payCash(id);
    await h.raw(null, `update public.square_cash_records set claimed_at = now() - interval '30 seconds', attempts = 1`);
    expect(await pushCashRecords()).toBe(0);
    expect(h.gateway.cashPayments).toHaveLength(0);

    // The worker died: its claim lapses.
    await h.raw(null, `update public.square_cash_records set claimed_at = now() - interval '61 seconds'`);
    expect(await pushCashRecords()).toBe(1);
    expect((await record(id)).state).toBe("recorded");
  });

  it("with nothing due it only reads: no write, no floor broadcast", async () => {
    const id = await oddBill();
    await payCash(id);
    await pushCashRecords(); // recorded: nothing left to do

    const statements: string[] = [];
    const spy = new Proxy(h.sql, {
      apply(target, thisArg, args: unknown[]) {
        const first = args[0];
        if (Array.isArray(first) && "raw" in first) statements.push(first.join("?"));
        return Reflect.apply(target, thisArg, args) as unknown;
      },
    });
    setDbForTests(spy);
    const before = await broadcasts();
    try {
      await pushCashInBackground();
      await pushCashInBackground();
    } finally {
      setDbForTests(h.sql);
    }
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((s) => /\b(update|insert|delete)\b/i.test(s))).toEqual([]);
    expect(await broadcasts()).toBe(before);
  });

  it("sending a sale doesn't broadcast to the floor either", async () => {
    const id = await oddBill();
    await payCash(id);
    const before = await broadcasts();
    await pushCashRecords();
    expect((await record(id)).state).toBe("recorded");
    expect(await broadcasts()).toBe(before);
  });

  it("stops starting new records once the time budget is spent", async () => {
    const a = await oddBill();
    const b = await awaitingPayment(h, "Table 2", 60);
    await payCash(a);
    await payCash(b);
    expect(await pushCashRecords({ budgetMs: 0 })).toBe(0);
    expect(await pushCashRecords({ limit: 1 })).toBe(1);
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(await pushCashRecords()).toBe(1);
    expect(h.gateway.payments.size).toBe(2);
  });
});

describe("SC7. settled_cents on every way a bill is paid", () => {
  it("card on the Terminal: what the card was charged", async () => {
    const id = await oddBill();
    await chargeCard(h.staff.actor, id);
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "COMPLETED", referenceId: id, cancelReason: null, amountCents: null }));
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "card", settled_cents: 3542 });
    expect((await audits(h, id, "session.paid"))[0].after).toMatchObject({ settled_cents: 3542 });
    expect(await records(id)).toHaveLength(0);
  });

  it("card marked by staff: the exact bill, not rounded, and nothing queued for Square", async () => {
    const id = await oddBill();
    const out = await markPaid(h.staff.actor, id, "card", { cardConfirmed: true }, at(100));
    expect(out).toMatchObject({ kind: "paid", method: "card", amountCents: 3542 });
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_cents: 3542 });
    expect(await records(id)).toHaveLength(0);

    await reverse(id);
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", settled_cents: null });
  });

  it("the summary reports what was collected and the cash rounding", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(130));
    try {
      const cash = await oddBill(); // 3542 → 3540
      const card = await awaitingPayment(h, "Table 2", 85);
      const { sessionId: up } = await startSession(h.staff.actor, h.tableId("Table 3"), T0);
      await stopSession(h.staff.actor, up, at(91)); // 95 min billed → 3958 → 3960
      await payCash(cash);
      await payCash(up, 101);
      await markPaid(h.staff.actor, card, "card", { cardConfirmed: true }, at(102));
      const total = (await getSession(h, up)).total_cents ?? 0;
      expect(total % 5).toBeGreaterThan(2); // rounds up

      const sum = await getSummary(null);
      expect(sum.paid.card).toEqual({ count: 1, cents: 3542 });
      const rounded = Math.round(total / 5) * 5;
      expect(sum.paid.cash).toEqual({ count: 2, cents: 3540 + rounded, roundingCents: -2 + (rounded - total) });
      // Queued but not sent yet.
      expect(sum.squareCashOutstanding).toEqual({ count: 2, cents: 3540 + rounded, failed: 0 });
      const cardRow = sum.paidItems.find((p) => p.id === card);
      expect(cardRow).toMatchObject({ settledCents: 3542, squareCash: null });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SC8. the migration", () => {
  it("backfills settled_cents for bills already paid, and only those", async () => {
    const pg = await PGlite.create({ extensions: { btree_gist } });
    try {
      await pg.exec(PRELUDE_SQL);
      await pg.exec(INIT_SQL);
      await pg.exec(REFERENCE_SQL);
      await pg.exec(SESSION_ITEMS_SQL);
      await pg.exec(`
        insert into public.staff (id, name, pin_hash, role)
          values ('00000000-0000-4000-8000-00000000000a', 'Sam', 'x', 'staff');
        insert into public.sessions (id, status, opened_at, opened_by, closed_at, closed_by, billed_minutes, total_cents,
                                     rate_snapshot, settled_method, settled_via, settled_by, settled_at)
          values ('00000000-0000-4000-8000-000000000001', 'paid', now() - interval '2 hours', '00000000-0000-4000-8000-00000000000a',
                  now() - interval '1 hour', '00000000-0000-4000-8000-00000000000a', 85, 3542,
                  '{}'::jsonb, 'cash', 'staff', '00000000-0000-4000-8000-00000000000a', now());
        insert into public.sessions (id, status, opened_at, opened_by, closed_at, closed_by, billed_minutes, total_cents, rate_snapshot)
          values ('00000000-0000-4000-8000-000000000002', 'awaiting_payment', now() - interval '2 hours', '00000000-0000-4000-8000-00000000000a',
                  now() - interval '1 hour', '00000000-0000-4000-8000-00000000000a', 60, 2500, '{}'::jsonb);
      `);
      await pg.exec(SQUARE_CASH_SQL);
      const { rows } = await pg.query<{ status: string; settled_cents: number | null }>(
        `select status, settled_cents from public.sessions order by id`,
      );
      // History keeps the amount that was recorded at the time: old cash bills are not re-rounded.
      expect(rows).toEqual([
        { status: "paid", settled_cents: 3542 },
        { status: "awaiting_payment", settled_cents: null },
      ]);
      const { rows: queued } = await pg.query(`select 1 from public.square_cash_records`);
      expect(queued).toHaveLength(0); // old cash sales are not sent to Square
    } finally {
      await pg.close();
    }
  });

  it("settled_cents follows status even for a writer that doesn't know the column (the previous release)", async () => {
    const id = await oddBill();
    // Not paid: an amount can't be left on it.
    await h.raw(null, `update public.sessions set settled_cents = 100 where id = '${id}'`);
    expect((await getSession(h, id)).settled_cents).toBeNull();

    // The old markPaid: sets the status and the settlement fields, and nothing else.
    await h.sql`
      update public.sessions set
        status = 'paid', settled_method = 'cash', settled_via = 'staff', settled_by = ${h.staff.actor.staffId},
        settled_at = now(), current_table_id = null
      where id = ${id}`;
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_cents: 3542 });

    // The old reversePaid.
    await h.sql`
      update public.sessions set
        status = 'awaiting_payment', settled_method = null, settled_via = null, settled_by = null, settled_at = null
      where id = ${id}`;
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", settled_cents: null });

    // The constraint itself still stands behind the trigger.
    await h.raw(null, `alter table public.sessions disable trigger sessions_settled_cents_default`);
    try {
      const e = await h.rawError(null, `update public.sessions set settled_cents = 100 where id = '${id}'`);
      expect(e.message).toMatch(/sessions_settled_cents_iff_paid/);
    } finally {
      await h.raw(null, `alter table public.sessions enable trigger sessions_settled_cents_default`);
    }
  });

  it("retrying needs Square to be set up", async () => {
    const { resetEnvCacheForTests } = await import("@/lib/server/env");
    const token = process.env.SQUARE_ACCESS_TOKEN;
    delete process.env.SQUARE_ACCESS_TOKEN;
    resetEnvCacheForTests();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(retryCashRecords(h.staff.managerActor, h.staff.manager)).rejects.toMatchObject({ status: 503, code: "square_not_configured" });
    } finally {
      process.env.SQUARE_ACCESS_TOKEN = token;
      resetEnvCacheForTests();
    }
  });

  it("fails fast on a lock instead of queueing, and the setting doesn't outlive the migration", async () => {
    expect(SQUARE_CASH_SQL).toMatch(/^set local lock_timeout = '3s';$/m);
    // The harness applied the file with one exec (one implicit transaction), as the Supabase CLI
    // and SQL editor do. Afterwards the session is back to no timeout.
    const [r] = await h.raw<{ lock_timeout: string }>(null, `show lock_timeout`);
    expect(r.lock_timeout).toBe("0");
  });

  it("cash records can't be deleted, hold only 5c amounts, and are closed to the API roles", async () => {
    const id = await oddBill();
    await payCash(id);
    expect((await h.rawError("timer_app", `delete from public.square_cash_records`)).message).toMatch(/permission denied|never deleted/);
    expect((await h.rawError(null, `delete from public.square_cash_records`)).message).toMatch(/never deleted/);
    expect((await h.rawError(null, `update public.square_cash_records set amount_cents = 3542`)).code).toBe("23514");
    expect((await h.rawError("anon", `select 1 from public.square_cash_records`)).code).toBe("42501");
    expect((await h.rawError("authenticated", `select 1 from public.square_cash_records`)).code).toBe("42501");
    const dup = await h.rawError(
      null,
      `insert into public.square_cash_records (session_id, seq, amount_cents, bill_cents) values ('${id}', 1, 5, 5)`,
    );
    expect(dup.code).toBe("23505");
  });
});
