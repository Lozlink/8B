import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { squareRejection, squareServerError, squareTimeout } from "./helpers/fake-gateway";
import { at, audits, awaitingPayment, getCheckouts, getSession } from "./helpers/util";
import { withTx } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { findPayment, resolvePayment } from "@/lib/server/payment-ref";
import { getSessionDetail, getSummary } from "@/lib/server/queries";
import { printReceipt } from "@/lib/server/receipts";
import {
  MAX_SEND_ATTEMPTS,
  overRefundError,
  pushRefunds,
  refundSession,
  refundsInBackground,
  type RefundRow,
} from "@/lib/server/refunds";
import {
  addCustomItem,
  applyWebhookCheckout,
  cancelCheckout,
  chargeCard,
  markPaid,
  openCounterSale,
  reversePaid,
  setDiscount,
  splitBill,
  syncCheckout,
} from "@/lib/server/sessions";
import { pushCashRecords } from "@/lib/server/square-cash";

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
  // Records every INSERT or UPDATE statement on the tables the background pass could touch, whether
  // or not it changed a row, so "nothing due means no write at all" can be checked literally.
  await h.raw(null, `create schema probe`);
  await h.raw(null, `create table probe.writes (id serial primary key, tbl text not null, op text not null)`);
  await h.raw(
    null,
    `create function probe.note() returns trigger language plpgsql security definer set search_path = '' as $$
     begin insert into probe.writes (tbl, op) values (tg_table_name, tg_op); return null; end $$`,
  );
  await h.raw(null, `grant execute on function probe.note() to timer_app`);
  for (const t of ["refunds", "sessions", "audit_log", "terminal_checkouts", "square_cash_records"]) {
    await h.raw(null, `create trigger probe_${t} after insert or update on public.${t} for each statement execute function probe.note()`);
  }
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  await h.raw(null, `truncate realtime.sent, probe.writes`);
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const broadcasts = async () => (await h.raw<{ n: number }>(null, `select count(*)::int as n from realtime.sent`))[0]?.n ?? 0;
const writes = () => h.raw<{ tbl: string; op: string }>(null, `select tbl, op from probe.writes order by id`);

const webhook = (id: string, status: string, referenceId: string | null, paymentIds?: string[] | null) =>
  withTx((tx) => applyWebhookCheckout(tx, { id, status, referenceId, cancelReason: null, amountCents: null, paymentIds }));

/** A bill paid by card on the Terminal: 60 minutes = $25.00. The checkout is chk_1, its payment cardpay_1. */
async function paidByCard(table = "Table 1", minutes = 60): Promise<{ id: string; checkoutId: string; paymentId: string }> {
  const id = await awaitingPayment(h, table, minutes);
  const out = await chargeCard(h.staff.actor, id);
  if (out.kind !== "sent") throw new Error("expected the charge to be sent");
  const paymentId = h.gateway.cardPaymentFor(out.checkoutId);
  await webhook(out.checkoutId, "COMPLETED", id, [paymentId]);
  return { id, checkoutId: out.checkoutId, paymentId };
}

/** A bill paid in cash ($25.00 for 60 minutes). `push`: whether the sale has reached Square (as pay_N). */
async function paidByCash(table = "Table 1", minutes = 60, push = true): Promise<string> {
  const id = await awaitingPayment(h, table, minutes);
  await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, new Date());
  if (push) await pushCashRecords();
  return id;
}

const refund = (id: string, cents: number, reason = "Customer left early", requestId: string | null = null) =>
  refundSession(h.staff.actor, h.staff.manager, id, reason, cents, requestId);

type RefundDbRow = RefundRow & { next_attempt_at: Date; claimed_at: Date | null; updated_at: Date; parked: boolean };
const refundRows = (sessionId: string) =>
  h.sql<RefundDbRow[]>`
    select *, next_attempt_at > now() + interval '50 years' as parked
    from public.refunds where session_id = ${sessionId} order by seq`;

/** Makes every waiting refund due now (stands in for the wait passing). Parked refunds stay parked. */
const makeDue = () =>
  h.raw(
    null,
    `update public.refunds set next_attempt_at = now(), claimed_at = null
     where state = 'pending' and next_attempt_at < now() + interval '50 years'`,
  );

const refundedCents = async (id: string) => (await getSession(h, id)).refunded_cents;

const caught = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
};

// ---------------------------------------------------------------------------
// A. Payment ids
// ---------------------------------------------------------------------------

describe("RA. the Square payment a completed card request made is stored", () => {
  it("from the webhook's payment_ids", async () => {
    const { id, paymentId } = await paidByCard();
    expect((await getCheckouts(h, id))[0]).toMatchObject({ status: "COMPLETED", square_payment_id: paymentId });
    expect(await resolvePayment(id)).toEqual({ paymentId, method: "card", amountCents: 2500 });
    // Stored already: nobody had to ask Square.
    expect(h.gateway.gets).toHaveLength(0);
  });

  it("from the webhook route itself, and a malformed payment_ids never fails the event", async () => {
    const { POST } = await import("@/app/api/square/webhook/route");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY as string;
    const url = process.env.SQUARE_WEBHOOK_URL as string;
    const deliver = (eventId: string, checkout: Record<string, unknown>) => {
      const body = JSON.stringify({ event_id: eventId, type: "terminal.checkout.updated", data: { object: { checkout } } });
      const signature = createHmac("sha256", key).update(url + body).digest("base64");
      return POST(new Request(url, { method: "POST", headers: { "x-square-hmacsha256-signature": signature }, body }));
    };

    const a = await awaitingPayment(h, "Table 1");
    await chargeCard(h.staff.actor, a);
    const res = await deliver("evt_1", { id: "chk_1", status: "COMPLETED", reference_id: a, payment_ids: ["PAY_FROM_SQUARE"] });
    expect(res.status).toBe(200);
    expect((await getCheckouts(h, a))[0]).toMatchObject({ status: "COMPLETED", square_payment_id: "PAY_FROM_SQUARE" });

    const b = await awaitingPayment(h, "Table 2");
    await chargeCard(h.staff.actor, b);
    const odd = await deliver("evt_2", { id: "chk_2", status: "COMPLETED", reference_id: b, payment_ids: "not-a-list" });
    expect(odd.status).toBe(200);
    expect(await getSession(h, b)).toMatchObject({ status: "paid", settled_method: "card" });
    expect((await getCheckouts(h, b))[0]).toMatchObject({ status: "COMPLETED", square_payment_id: null });
  });

  it("from the status check (sync) when the webhook never came", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.getFor.set("chk_1", "COMPLETED");
    await syncCheckout(h.staff.actor, id);
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_via: "square_api" });
    expect((await getCheckouts(h, id))[0].square_payment_id).toBe("cardpay_1");
    expect(await resolvePayment(id)).toEqual({ paymentId: "cardpay_1", method: "card", amountCents: 2500 });
  });

  it("from the answer to a cancel that found the card already taken", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelFor.set("chk_1", "COMPLETED");
    expect(await cancelCheckout(h.staff.actor, id)).toMatchObject({ paid: true });
    expect((await getCheckouts(h, id))[0]).toMatchObject({ status: "COMPLETED", square_payment_id: "cardpay_1" });
  });

  it("from a charge that Square answers as already completed (idempotent replay)", async () => {
    const id = await awaitingPayment(h);
    h.gateway.createStatus = "COMPLETED";
    expect(await chargeCard(h.staff.actor, id)).toEqual({ kind: "already_paid_by_card" });
    expect((await getCheckouts(h, id))[0]).toMatchObject({ status: "COMPLETED", square_payment_id: "cardpay_1" });
  });

  it("on a card request the app never recorded and adopts from the webhook", async () => {
    const id = await awaitingPayment(h);
    await webhook("chk_ghost", "COMPLETED", id, ["PAY_GHOST"]);
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "card" });
    expect((await getCheckouts(h, id))[0]).toMatchObject({ id: "chk_ghost", status: "COMPLETED", square_payment_id: "PAY_GHOST" });
  });

  it("a completed row with no id takes it from later news, without waking the iPads", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await webhook("chk_1", "COMPLETED", id); // completed, but the id wasn't with it
    expect((await getCheckouts(h, id))[0].square_payment_id).toBeNull();
    const before = await broadcasts();
    await webhook("chk_1", "COMPLETED", id, ["PAY_LATE"]);
    expect((await getCheckouts(h, id))[0].square_payment_id).toBe("PAY_LATE");
    expect(await broadcasts()).toBe(before);
    // Never overwritten once known.
    await webhook("chk_1", "COMPLETED", id, ["PAY_OTHER"]);
    expect((await getCheckouts(h, id))[0].square_payment_id).toBe("PAY_LATE");
  });

  it("fetches the id from Square on demand for a row from before ids were kept, once", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await webhook("chk_1", "COMPLETED", id);
    expect((await getCheckouts(h, id))[0].square_payment_id).toBeNull();

    h.gateway.getFor.set("chk_1", "COMPLETED");
    const before = await broadcasts();
    expect(await resolvePayment(id)).toEqual({ paymentId: "cardpay_1", method: "card", amountCents: 2500 });
    expect(h.gateway.gets).toEqual(["chk_1"]);
    expect((await getCheckouts(h, id))[0].square_payment_id).toBe("cardpay_1");
    // Storing the id is not a status change: no floor broadcast.
    expect(await broadcasts()).toBe(before);

    expect(await resolvePayment(id)).toEqual({ paymentId: "cardpay_1", method: "card", amountCents: 2500 });
    expect(h.gateway.gets).toEqual(["chk_1"]);
  });

  it("resolves the cash sale once it is in Square, and nothing for a card taken on another reader", async () => {
    const cash = await paidByCash("Table 1", 60, false);
    expect(await findPayment(cash)).toEqual({ kind: "none", why: "cash_pending", due: true });
    expect(await resolvePayment(cash)).toBeNull();
    await pushCashRecords();
    expect(await resolvePayment(cash)).toEqual({ paymentId: "pay_1", method: "cash", amountCents: 2500 });

    const card = await awaitingPayment(h, "Table 2");
    await markPaid(h.staff.actor, card, "card", { cardConfirmed: true }, at(100));
    expect(await findPayment(card)).toEqual({ kind: "none", why: "other_reader" });

    const unpaid = await awaitingPayment(h, "Table 3");
    expect(await findPayment(unpaid)).toEqual({ kind: "none", why: "not_paid" });
  });

  it("after a reopen and a second card payment, it is the payment the bill is settled by now", async () => {
    const { id } = await paidByCard();
    await reversePaid(h.staff.managerActor, h.staff.manager, id, "Charged the wrong card");
    const again = await chargeCard(h.staff.actor, id);
    if (again.kind !== "sent") throw new Error("expected the charge to be sent");
    const second = h.gateway.cardPaymentFor(again.checkoutId);
    await webhook(again.checkoutId, "COMPLETED", id, [second]);
    expect(await resolvePayment(id)).toEqual({ paymentId: second, method: "card", amountCents: 2500 });
  });
});

// ---------------------------------------------------------------------------
// B. Refunds
// ---------------------------------------------------------------------------

describe("RB. refunding a card payment", () => {
  it("in full: recorded and counted at once, sent under a fixed key, finished off in the background exactly once", async () => {
    const { id, paymentId } = await paidByCard();
    const out = await refund(id, 2500, "Table light was broken");

    // Square answers PENDING for a card refund: it is with Square, not yet final.
    expect(out.refund).toMatchObject({
      amountCents: 2500,
      method: "card",
      reason: "Table light was broken",
      state: "pending",
      error: null,
      byName: "Sam Staff",
      approvedByName: "Mia Manager",
    });
    expect(h.gateway.refunds).toEqual([
      { idempotencyKey: `${id}-rf1`, paymentId, amountCents: 2500, reason: "Table light was broken" },
    ]);
    // Square limits refund keys to 45 characters.
    expect(h.gateway.refunds[0].idempotencyKey.length).toBeLessThanOrEqual(45);
    expect(await refundedCents(id)).toBe(2500);
    expect((await refundRows(id))[0]).toMatchObject({
      seq: 1,
      state: "pending",
      square_payment_id: paymentId,
      square_refund_id: "ref_1",
      square_status: "PENDING",
      attempts: 1,
      claimed_at: null,
      created_by: h.staff.actor.staffId,
      approved_by: h.staff.manager.id,
    });

    const [asked] = await audits(h, id, "refund.requested");
    expect(asked).toMatchObject({ actor_staff_id: h.staff.actor.staffId, approved_by_staff_id: h.staff.manager.id, reason: "Table light was broken" });
    expect(asked.after).toMatchObject({ seq: 1, method: "card", amount_cents: 2500, refunded_cents: 2500, idempotency_key: `${id}-rf1` });

    // Not due for a few seconds: a pass straight away does nothing.
    expect(await pushRefunds()).toBe(0);
    expect(h.gateway.refundGets).toHaveLength(0);

    await makeDue();
    expect(await pushRefunds()).toBe(1);
    expect(h.gateway.refundGets).toEqual(["ref_1"]);
    expect((await refundRows(id))[0]).toMatchObject({ state: "completed", square_status: "COMPLETED", last_error: null, claimed_at: null });
    expect(await audits(h, id, "refund.completed")).toHaveLength(1);
    // Completing changes nothing on the bill.
    expect(await refundedCents(id)).toBe(2500);

    // Done is done: nothing more is sent or read, ever.
    await makeDue();
    expect(await pushRefunds()).toBe(0);
    await refundsInBackground();
    expect(h.gateway.refunds).toHaveLength(1);
    expect(h.gateway.refundGets).toHaveLength(1);
    expect(h.gateway.refundsHeld.size).toBe(1);
    expect(await audits(h, id, "refund.completed")).toHaveLength(1);

    const detail = await getSessionDetail(id);
    expect(detail.refunds).toHaveLength(1);
    expect(detail.refunds[0]).toMatchObject({ state: "completed", amountCents: 2500, error: null });
    expect(detail.session).toMatchObject({ refundedCents: 2500, refundable: null, canPrintReceipt: true });
  });

  it("answers `completed` straight away when Square says so", async () => {
    const { id } = await paidByCard();
    h.gateway.refundCreateStatus = "COMPLETED";
    const out = await refund(id, 1000);
    expect(out.refund).toMatchObject({ state: "completed", amountCents: 1000, error: null });
    expect((await refundRows(id))[0]).toMatchObject({ state: "completed", square_refund_id: "ref_1" });
    const [done] = await audits(h, id, "refund.completed");
    expect(done).toMatchObject({ actor_staff_id: h.staff.actor.staffId, approved_by_staff_id: h.staff.manager.id });
  });

  it("in part, twice, each under its own key; then refuses to go past what was paid", async () => {
    const { id, paymentId } = await paidByCard();
    expect((await getSessionDetail(id)).session.refundable).toEqual({ method: "card", maxCents: 2500 });

    await refund(id, 1000);
    expect((await getSessionDetail(id)).session).toMatchObject({ refundedCents: 1000, refundable: { method: "card", maxCents: 1500 } });
    await refund(id, 1200);
    expect((await getSessionDetail(id)).session).toMatchObject({ refundedCents: 2200, refundable: { method: "card", maxCents: 300 } });
    expect(h.gateway.refunds.map((r) => [r.idempotencyKey, r.paymentId, r.amountCents])).toEqual([
      [`${id}-rf1`, paymentId, 1000],
      [`${id}-rf2`, paymentId, 1200],
    ]);

    const e = await caught(refund(id, 301));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toBe("That's more than is left to refund on this bill. The most is $3.00.");
    // Refused before anything was written or sent.
    expect(h.gateway.refunds).toHaveLength(2);
    expect(await refundRows(id)).toHaveLength(2);
    expect(await refundedCents(id)).toBe(2200);

    await refund(id, 300);
    expect((await getSessionDetail(id)).session).toMatchObject({ refundedCents: 2500, refundable: null });
    const full = await caught(refund(id, 5));
    expect(full).toMatchObject({ status: 409 });
    expect(full.message).toBe("This bill has already been refunded in full.");
  });

  it("two managers at once can't refund more than was paid", async () => {
    const { id } = await paidByCard();
    const results = await Promise.allSettled([refund(id, 2000), refund(id, 2000)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost && lost.status === "rejected" ? lost.reason : null).toMatchObject({ status: 409, code: "conflict" });
    expect(await refundRows(id)).toHaveLength(1);
    expect(await refundedCents(id)).toBe(2000);
    expect(h.gateway.refunds).toHaveLength(1);
  });

  it("the database refuses an over-refund by itself, and that reads as a 409", async () => {
    const { id } = await paidByCard();
    const e: unknown = await h.sql`update public.sessions set refunded_cents = settled_cents + 1 where id = ${id}`.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).not.toBeNull();
    expect(overRefundError(e)).toMatchObject({ status: 409, code: "conflict", message: "That's more than is left to refund on this bill." });
    expect(overRefundError(new Error("something else"))).toBeNull();
    expect(await refundedCents(id)).toBe(0);
  });

  it("checks the request before touching anything", async () => {
    const { id } = await paidByCard();
    await expect(refund(id, 0)).rejects.toMatchObject({ status: 400 });
    await expect(refund(id, -100)).rejects.toMatchObject({ status: 400 });
    await expect(refund(id, 10.5)).rejects.toMatchObject({ status: 400 });
    await expect(refund(id, 500, "  ")).rejects.toMatchObject({ status: 400 });
    await expect(refund("not-a-uuid", 500)).rejects.toMatchObject({ status: 404 });
    const unpaid = await awaitingPayment(h, "Table 2");
    await expect(refund(unpaid, 500)).rejects.toMatchObject({ name: "TransitionError" });
    expect(h.gateway.refunds).toHaveLength(0);
    expect(await refundRows(id)).toHaveLength(0);
  });
});

describe("RB. refunding a cash payment", () => {
  it("records the refund in Square against the cash sale, in 5c steps only", async () => {
    const id = await paidByCash();
    expect((await getSessionDetail(id)).session.refundable).toEqual({ method: "cash", maxCents: 2500 });

    const odd = await caught(refund(id, 1002));
    expect(odd).toMatchObject({ status: 409, code: "conflict" });
    expect(odd.message).toMatch(/5c steps/);
    expect(h.gateway.refunds).toHaveLength(0);
    expect(await refundedCents(id)).toBe(0);

    const out = await refund(id, 1000, "Overcharged an hour");
    expect(out.refund).toMatchObject({ method: "cash", amountCents: 1000, state: "pending" });
    expect(h.gateway.refunds).toEqual([{ idempotencyKey: `${id}-rf1`, paymentId: "pay_1", amountCents: 1000, reason: "Overcharged an hour" }]);
    await makeDue();
    await pushRefunds();
    expect((await refundRows(id))[0]).toMatchObject({ state: "completed", method: "cash" });
    expect((await getSessionDetail(id)).session).toMatchObject({ refundedCents: 1000, refundable: { method: "cash", maxCents: 1500 } });
    // The cash record itself is untouched: the sale is still in Square.
    const [cash] = await h.sql<{ state: string; want: string }[]>`select state, want from public.square_cash_records where session_id = ${id}`;
    expect(cash).toEqual({ state: "recorded", want: "recorded" });
  });
});

describe("RB. a payment the app can't refund", () => {
  it("a card marked paid by hand: 409 saying it was taken elsewhere", async () => {
    const id = await awaitingPayment(h);
    await markPaid(h.staff.actor, id, "card", { cardConfirmed: true }, at(100));
    const e = await caught(refund(id, 500));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toBe("This card payment wasn't taken on the Terminal, so it can't be refunded from here. Refund it in Square.");
    expect((await getSessionDetail(id)).session).toMatchObject({ refundable: null, canPrintReceipt: false });
    expect(await refundRows(id)).toHaveLength(0);
  });

  it("cash that isn't in Square yet: 409 saying so, and nothing is sent", async () => {
    const id = await paidByCash("Table 1", 60, false);
    const e = await caught(refund(id, 500));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toBe("This cash sale isn't in Square yet, so it can't be refunded from here yet. Try again in a few minutes.");
    expect((await getSessionDetail(id)).session.refundable).toBeNull();
    // Refunding doesn't push the sale itself; the background does that.
    expect(h.gateway.cashPayments).toHaveLength(0);
    expect(h.gateway.refunds).toHaveLength(0);
  });

  it("cash from before the app recorded cash in Square: 409, never offered", async () => {
    const id = await paidByCash("Table 1", 60, false);
    // Such a bill has no cash record at all. Replica mode skips the no-delete trigger; test setup only.
    await h.raw(null, `set session_replication_role = replica`);
    try {
      await h.raw(null, `delete from public.square_cash_records`);
    } finally {
      await h.raw(null, `set session_replication_role = origin`);
    }
    const e = await caught(refund(id, 500));
    expect(e.message).toBe("This cash payment was never recorded in Square, so it can't be refunded from here.");
    expect((await getSessionDetail(id)).session).toMatchObject({ refundable: null, canPrintReceipt: false });
  });

  it("a card payment whose id can't be looked up right now: 409, nothing refunded", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await webhook("chk_1", "COMPLETED", id); // no payment id stored
    h.gateway.getFor.set("chk_1", squareTimeout());
    const e = await caught(refund(id, 500));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toMatch(/nothing was refunded/);
    expect(await refundRows(id)).toHaveLength(0);
    // The screens still offer it: the id is looked up when the refund is made.
    expect((await getSessionDetail(id)).session.refundable).toEqual({ method: "card", maxCents: 2500 });

    h.gateway.getFor.set("chk_1", "COMPLETED");
    const out = await refund(id, 500);
    expect(out.refund.state).toBe("pending");
    expect(h.gateway.refunds[0]).toMatchObject({ paymentId: "cardpay_1", amountCents: 500 });
  });
});

describe("RB. a card payment Square no longer has the request for", () => {
  it("is sent to Square Dashboard rather than asked for again", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await webhook("chk_1", "COMPLETED", id); // no payment id stored
    h.gateway.getFor.set("chk_1", squareRejection(404, "NOT_FOUND"));
    const e = await caught(refund(id, 500));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toBe("The app can't find this card payment in Square, so it can't be refunded from here. Refund it in Square.");
    const p = await caught(printReceipt(h.staff.actor, id));
    expect(p).toMatchObject({ status: 409, code: "conflict" });
    expect(p.message).toMatch(/Print it from Square/);
    expect(await refundRows(id)).toHaveLength(0);
    expect(h.gateway.receiptActions).toHaveLength(0);
  });
});

describe("RB. when Square doesn't answer", () => {
  it("a timeout is not a failure: the refund stays pending and counted, and the retry uses the same key", async () => {
    const { id } = await paidByCard();
    // Square made the refund, but its answer never arrived.
    h.gateway.refundError = squareTimeout();
    h.gateway.refundFailAfterCreating = true;
    const out = await refund(id, 2500);
    expect(out.refund.state).toBe("pending");
    expect(out.refund.error).toMatch(/didn't answer in time/);
    expect(await refundedCents(id)).toBe(2500);
    expect((await refundRows(id))[0]).toMatchObject({ state: "pending", square_refund_id: null, attempts: 1, claimed_at: null, parked: false });
    // Still counted, so it can't be refunded a second time or reopened in the meantime.
    expect((await getSessionDetail(id)).session.refundable).toBeNull();
    await expect(refund(id, 100)).rejects.toMatchObject({ status: 409 });

    // Not due yet (30 s back-off).
    expect(await pushRefunds()).toBe(0);

    await makeDue();
    expect(await pushRefunds()).toBe(1);
    // Same key, same body: Square hands back the refund it already made.
    expect(h.gateway.refunds.map((r) => r.idempotencyKey)).toEqual([`${id}-rf1`, `${id}-rf1`]);
    expect(h.gateway.refunds[1]).toEqual(h.gateway.refunds[0]);
    expect(h.gateway.refundsHeld.size).toBe(1);
    expect((await refundRows(id))[0]).toMatchObject({ state: "pending", square_refund_id: "ref_1", last_error: null, attempts: 2 });

    await makeDue();
    expect(await pushRefunds()).toBe(1);
    expect((await refundRows(id))[0]).toMatchObject({ state: "completed" });
    expect(h.gateway.refundsHeld.size).toBe(1);
    expect(h.gateway.payments.get("cardpay_1")?.refundedCents).toBe(2500);
    expect(await refundedCents(id)).toBe(2500);
    expect(await audits(h, id, "refund.completed")).toHaveLength(1);
    expect(await audits(h, id, "refund.failed")).toHaveLength(0);
  });

  it("a timeout where Square did nothing: the retry makes the one and only refund", async () => {
    const { id } = await paidByCard();
    h.gateway.refundError = squareServerError();
    const out = await refund(id, 700);
    expect(out.refund).toMatchObject({ state: "pending" });
    expect(h.gateway.refundsHeld.size).toBe(0);
    await makeDue();
    await pushRefunds();
    expect(h.gateway.refundsHeld.size).toBe(1);
    await makeDue();
    await pushRefunds();
    expect((await refundRows(id))[0]).toMatchObject({ state: "completed" });
    expect(h.gateway.payments.get("cardpay_1")?.refundedCents).toBe(700);
  });

  it("a 401 is the access token, not a verdict: pending, retried", async () => {
    const { id } = await paidByCard();
    h.gateway.refundError = squareRejection(401, "UNAUTHORIZED", "Square couldn't record the refund: unauthorized");
    const out = await refund(id, 500);
    expect(out.refund.state).toBe("pending");
    expect(await refundedCents(id)).toBe(500);
    expect(await audits(h, id, "refund.failed")).toHaveLength(0);
  });

  it("after 12 unanswered tries it stops, stays pending and counted, and goes to a manager", async () => {
    const { id } = await paidByCard();
    h.gateway.refundError = squareTimeout();
    h.gateway.refundErrorSticky = true;
    await refund(id, 2500);
    for (let i = 0; i < MAX_SEND_ATTEMPTS + 3; i++) {
      await makeDue();
      await pushRefunds();
    }
    // Twelve tries, all with the one key, then silence.
    expect(h.gateway.refunds).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(new Set(h.gateway.refunds.map((r) => r.idempotencyKey))).toEqual(new Set([`${id}-rf1`]));

    const [row] = await refundRows(id);
    expect(row).toMatchObject({ state: "pending", attempts: MAX_SEND_ATTEMPTS, parked: true, claimed_at: null });
    expect(row.last_error).toMatch(/never answered/);
    expect(row.last_error).toMatch(/Look at the payment in Square/);
    // Parked with an ordinary far-future time: it reads back as a real date.
    expect(Number.isNaN(row.next_attempt_at.getTime())).toBe(false);
    // Nobody said no, so the money is still counted as refunded.
    expect(await refundedCents(id)).toBe(2500);
    expect(await audits(h, id, "refund.failed")).toHaveLength(0);
    const flagged = await audits(h, id, "refund.unconfirmed");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].after).toMatchObject({ amount_cents: 2500, attempts: MAX_SEND_ATTEMPTS, idempotency_key: `${id}-rf1` });

    // Read back through the screens' mapping: pending, with what to do, and it serialises.
    const detail = await getSessionDetail(id);
    expect(detail.refunds[0]).toMatchObject({ state: "pending", amountCents: 2500 });
    expect(detail.refunds[0].error).toMatch(/Look at the payment in Square/);
    expect(new Date(detail.refunds[0].createdAt).toISOString()).toBe(detail.refunds[0].createdAt);
    expect(() => JSON.stringify(detail)).not.toThrow();
    expect(detail.session).toMatchObject({ refundedCents: 2500, refundable: null });

    const summary = await getSummary(null);
    expect(summary.attention.map((a) => a.action)).toContain("refund.unconfirmed");
    expect(summary.refunds).toMatchObject({ count: 1, cents: 2500 });
    expect(() => JSON.stringify(summary)).not.toThrow();

    // And it can't be reopened while the refund may have happened.
    await expect(reversePaid(h.staff.managerActor, h.staff.manager, id, "Try again")).rejects.toMatchObject({ status: 409 });
  });

  it("a reused key is never retried under a new one: stop, pending, flagged", async () => {
    const { id } = await paidByCard();
    h.gateway.refundError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED", "Square couldn't record the refund: key reused");
    const out = await refund(id, 2500);
    expect(out.refund.state).toBe("pending");
    expect(out.refund.error).toMatch(/different refund on file/);

    const [row] = await refundRows(id);
    expect(row).toMatchObject({ state: "pending", parked: true, attempts: 1 });
    expect(await refundedCents(id)).toBe(2500);
    expect(await audits(h, id, "refund.unconfirmed")).toHaveLength(1);
    expect(await audits(h, id, "refund.failed")).toHaveLength(0);

    await makeDue();
    expect(await pushRefunds()).toBe(0);
    expect(h.gateway.refunds).toHaveLength(1);
    expect((await getSummary(null)).attention.map((a) => a.action)).toContain("refund.unconfirmed");
  });
});

describe("RB. a refusal of a re-send is not a verdict on the first try", () => {
  it("Square made the refund but its answer was lost, then refuses the repeat: parked, still counted, never failed", async () => {
    const { id } = await paidByCard();
    // The first call reaches Square and the refund is made; the answer never arrives.
    h.gateway.refundError = squareTimeout();
    h.gateway.refundFailAfterCreating = true;
    const out = await refund(id, 2500);
    expect(out.refund.state).toBe("pending");
    expect(h.gateway.refundsHeld.size).toBe(1);

    // The re-send is refused: Square no longer knows the key and sees a second refund of money
    // that has already gone back.
    h.gateway.refundFailAfterCreating = false;
    h.gateway.refundError = squareRejection(400, "REFUND_AMOUNT_INVALID", "Square couldn't record the refund: nothing left to refund");
    await makeDue();
    expect(await pushRefunds()).toBe(1);

    const [row] = await refundRows(id);
    expect(row).toMatchObject({ state: "pending", parked: true, attempts: 2, claimed_at: null, square_refund_id: null });
    expect(row.last_error).toMatch(/refused it when the app asked again/);
    expect(row.last_error).toMatch(/Look at the payment in Square/);
    // Square holds the refund, so the app must keep counting it.
    expect(await refundedCents(id)).toBe(2500);
    expect(await audits(h, id, "refund.failed")).toHaveLength(0);
    const [flagged] = await audits(h, id, "refund.unconfirmed");
    expect(flagged.after).toMatchObject({ amount_cents: 2500, attempts: 2, idempotency_key: `${id}-rf1` });
    expect((flagged.after as { square: { refusal: string } }).square.refusal).toMatch(/more than is left to refund/);

    // Not refundable again, not reopenable, never sent again.
    expect((await getSessionDetail(id)).session).toMatchObject({ refundedCents: 2500, refundable: null });
    await expect(refund(id, 100)).rejects.toMatchObject({ status: 409 });
    await expect(reversePaid(h.staff.managerActor, h.staff.manager, id, "Try again")).rejects.toMatchObject({ status: 409 });
    await makeDue();
    expect(await pushRefunds()).toBe(0);
    expect(h.gateway.refunds).toHaveLength(2);
    expect(h.gateway.refundsHeld.size).toBe(1);
  });

  it("the same when Square did nothing the first time: the app can't tell the two apart, so it asks a person", async () => {
    const { id } = await paidByCard();
    h.gateway.refundError = squareServerError(); // nothing was made
    await refund(id, 700);
    h.gateway.refundError = squareRejection(400, "BAD_REQUEST", "Square couldn't record the refund: This payment can no longer be refunded");
    await makeDue();
    await pushRefunds();
    expect((await refundRows(id))[0]).toMatchObject({ state: "pending", parked: true });
    expect(await refundedCents(id)).toBe(700);
    expect(await audits(h, id, "refund.failed")).toHaveLength(0);
    expect(await audits(h, id, "refund.unconfirmed")).toHaveLength(1);
  });

  it("a refund Square itself reports FAILED on the re-send is still a no: it names the refund", async () => {
    const { id } = await paidByCard();
    h.gateway.refundError = squareServerError(); // nothing was made
    await refund(id, 700);
    h.gateway.refundCreateStatus = "FAILED";
    await makeDue();
    await pushRefunds();
    expect((await refundRows(id))[0]).toMatchObject({ state: "failed", square_refund_id: "ref_1", square_status: "FAILED", parked: false });
    expect(await refundedCents(id)).toBe(0);
    expect(await audits(h, id, "refund.failed")).toHaveLength(1);
    expect(await audits(h, id, "refund.unconfirmed")).toHaveLength(0);
  });
});

describe("RB. the same refund asked for twice (request id)", () => {
  it("a retry after a lost answer makes nothing new: one row, one refund in Square, the first refund returned", async () => {
    const { id } = await paidByCard();
    const requestId = randomUUID();
    // The screen never heard back from this one...
    const first = await refund(id, 1000, "Left early", requestId);
    // ...so, with a stale copy of the bill, the manager sends the same refund again.
    const again = await refund(id, 1000, "Left early", requestId);

    expect(again.refund.id).toBe(first.refund.id);
    expect(again.refund).toMatchObject({ amountCents: 1000, state: "pending" });
    expect(await refundRows(id)).toHaveLength(1);
    expect(h.gateway.refunds).toHaveLength(1);
    expect(h.gateway.refundsHeld.size).toBe(1);
    expect(await refundedCents(id)).toBe(1000);
    expect(await audits(h, id, "refund.requested")).toHaveLength(1);

    // Returned as it stands now, not as it was first answered.
    await makeDue();
    await pushRefunds();
    const later = await refund(id, 1000, "Left early", requestId);
    expect(later.refund).toMatchObject({ id: first.refund.id, state: "completed" });
    expect(h.gateway.refunds).toHaveLength(1);
    expect(await refundRows(id)).toHaveLength(1);
  });

  it("a retry of a full refund is not mistaken for an over-refund", async () => {
    const { id } = await paidByCard();
    const requestId = randomUUID();
    const first = await refund(id, 2500, "Table light was broken", requestId);
    const again = await refund(id, 2500, "Table light was broken", requestId);
    expect(again.refund.id).toBe(first.refund.id);
    expect(await refundedCents(id)).toBe(2500);
    expect(h.gateway.refunds).toHaveLength(1);
  });

  it("a retry of a refund Square refused gets the same refusal, and still makes nothing new", async () => {
    const { id } = await paidByCard();
    const requestId = randomUUID();
    h.gateway.refundError = squareRejection(400, "BAD_REQUEST", "Square couldn't record the refund: no");
    const first = await caught(refund(id, 500, "Left early", requestId));
    expect(first).toMatchObject({ status: 409, code: "refund_failed" });
    const again = await caught(refund(id, 500, "Left early", requestId));
    expect(again).toMatchObject({ status: 409, code: "refund_failed", message: first.message });
    expect(await refundRows(id)).toHaveLength(1);
    expect(h.gateway.refunds).toHaveLength(1);
    expect(await refundedCents(id)).toBe(0);

    // Trying again for real is a new refund with a new id.
    const fresh = await refund(id, 500, "Left early", randomUUID());
    expect(fresh.refund.state).toBe("pending");
    expect(await refundRows(id)).toHaveLength(2);
  });

  it("the same id with a different amount is refused and writes nothing", async () => {
    const { id } = await paidByCard();
    const requestId = randomUUID();
    await refund(id, 1000, "Left early", requestId);
    const e = await caught(refund(id, 1200, "Left early", requestId));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toMatch(/already used for a different refund, so nothing was refunded/);
    expect(await refundRows(id)).toHaveLength(1);
    expect(h.gateway.refunds).toHaveLength(1);
    expect(await refundedCents(id)).toBe(1000);
  });

  it("the same id on another bill is refused and writes nothing", async () => {
    const a = await paidByCard("Table 1");
    const b = await paidByCard("Table 2");
    const requestId = randomUUID();
    await refund(a.id, 1000, "Left early", requestId);
    const e = await caught(refund(b.id, 1000, "Left early", requestId));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(await refundRows(b.id)).toHaveLength(0);
    expect(await refundedCents(b.id)).toBe(0);
    expect(h.gateway.refunds).toHaveLength(1);

    // Both at the same moment: still one refund, on one bill.
    const c = await paidByCard("Table 3");
    const d = await paidByCard("Table 4");
    const shared = randomUUID();
    const both = await Promise.allSettled([refund(c.id, 500, "Left early", shared), refund(d.id, 500, "Left early", shared)]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await refundRows(c.id)).length + (await refundRows(d.id)).length).toBe(1);
    expect((await refundedCents(c.id)) + (await refundedCents(d.id))).toBe(500);
  });

  it("two identical requests at the same moment make one refund", async () => {
    const { id } = await paidByCard();
    const requestId = randomUUID();
    const [x, y] = await Promise.all([refund(id, 800, "Left early", requestId), refund(id, 800, "Left early", requestId)]);
    expect(x.refund.id).toBe(y.refund.id);
    expect(await refundRows(id)).toHaveLength(1);
    expect(h.gateway.refunds).toHaveLength(1);
    expect(await refundedCents(id)).toBe(800);
  });

  it("the database keeps one refund per request id on its own", async () => {
    const { id } = await paidByCard();
    const requestId = randomUUID();
    await refund(id, 500, "Left early", requestId);
    const dup = await h.rawError(
      null,
      `insert into public.refunds (session_id, seq, square_payment_id, method, amount_cents, reason, request_id, created_by, approved_by)
       select session_id, seq + 1, square_payment_id, method, amount_cents, reason, request_id, created_by, approved_by from public.refunds`,
    );
    expect(dup.code).toBe("23505");
    expect(dup.message).toMatch(/refunds_request_uniq/);
  });

  it("without a request id every call is a new refund, as before; a malformed one is a 400", async () => {
    const { id } = await paidByCard();
    const one = await refund(id, 400);
    const two = await refund(id, 400);
    expect(two.refund.id).not.toBe(one.refund.id);
    expect(await refundRows(id)).toHaveLength(2);
    expect(h.gateway.refunds.map((r) => r.idempotencyKey)).toEqual([`${id}-rf1`, `${id}-rf2`]);
    expect(await refundedCents(id)).toBe(800);

    await expect(refund(id, 100, "Left early", "not-a-uuid")).rejects.toMatchObject({ status: 400 });
    expect(await refundRows(id)).toHaveLength(2);
  });
});

describe("RB. when Square says no", () => {
  it("a refusal fails the refund, gives the amount back and shows on Needs attention", async () => {
    const { id } = await paidByCard();
    h.gateway.refundError = squareRejection(400, "REFUND_AMOUNT_INVALID", "Square couldn't record the refund: The requested refund amount exceeds the amount available to refund.");
    const e = await caught(refund(id, 2500));
    expect(e).toMatchObject({ status: 409, code: "refund_failed" });
    expect(e.message).toMatch(/Nothing was refunded\.$/);
    expect(e.message).toMatch(/more than is left to refund on this payment/);
    expect(e.detail?.refund).toMatchObject({ state: "failed", amountCents: 2500 });

    const [row] = await refundRows(id);
    expect(row).toMatchObject({ state: "failed", claimed_at: null, square_refund_id: null });
    expect(await refundedCents(id)).toBe(0);
    const [failed] = await audits(h, id, "refund.failed");
    expect(failed.reason).toMatch(/^The \$25\.00 card refund didn't go through\./);
    expect(failed.reason).toMatch(/Nothing was refunded\.$/);
    expect(failed.after).toMatchObject({ amount_cents: 2500, refunded_cents: 0 });

    const detail = await getSessionDetail(id);
    expect(detail.refunds[0]).toMatchObject({ state: "failed" });
    expect(detail.refunds[0].error).toMatch(/more than is left/);
    // Refundable again, in full.
    expect(detail.session).toMatchObject({ refundedCents: 0, refundable: { method: "card", maxCents: 2500 } });

    const summary = await getSummary(null);
    expect(summary.attention.map((a) => a.action)).toContain("refund.failed");
    // A failed refund is not money out.
    expect(summary.refunds).toMatchObject({ count: 0, cents: 0, items: [] });

    // The next try is a new refund with its own key, never the failed one's.
    const out = await refund(id, 2500);
    expect(out.refund.state).toBe("pending");
    expect(h.gateway.refunds.map((r) => r.idempotencyKey)).toEqual([`${id}-rf1`, `${id}-rf2`]);
    // The background pass never goes back to a failed refund.
    await makeDue();
    await pushRefunds();
    expect(h.gateway.refunds).toHaveLength(2);
  });

  it("Square knows of a refund the app doesn't (made in Square Dashboard): it refuses the excess and nothing is lost", async () => {
    const { id, paymentId } = await paidByCard();
    // $20.00 of this payment was already refunded in Square by hand.
    const held = h.gateway.payments.get(paymentId);
    if (!held) throw new Error("payment missing from the fake");
    held.refundedCents = 2000;

    const e = await caught(refund(id, 1000));
    expect(e).toMatchObject({ status: 409, code: "refund_failed" });
    expect(e.message).toBe(
      "Square says that is more than is left to refund on this payment. Look at the payment in Square. Nothing was refunded.",
    );
    expect(await refundedCents(id)).toBe(0);
    expect(held.refundedCents).toBe(2000);
    expect(h.gateway.refundsHeld.size).toBe(0);

    // What Square still has left can be refunded.
    const out = await refund(id, 500);
    expect(out.refund.state).toBe("pending");
    expect(held.refundedCents).toBe(2500);
  });

  it("Square's own wording is passed on when we have no plainer one", async () => {
    const { id } = await paidByCard();
    h.gateway.refundError = squareRejection(400, "BAD_REQUEST", "Square couldn't record the refund: This payment can no longer be refunded");
    const e = await caught(refund(id, 500));
    expect(e.message).toBe("Square didn't accept the refund: This payment can no longer be refunded. Nothing was refunded.");
  });

  it("REJECTED on a later status read fails it and restores the amount, once", async () => {
    const { id } = await paidByCard();
    const out = await refund(id, 1500);
    expect(out.refund.state).toBe("pending");
    expect(await refundedCents(id)).toBe(1500);

    h.gateway.refundSettlesAs = "REJECTED";
    await makeDue();
    const before = await broadcasts();
    expect(await pushRefunds()).toBe(1);
    expect((await refundRows(id))[0]).toMatchObject({ state: "failed", square_refund_id: "ref_1", square_status: "REJECTED" });
    expect(await refundedCents(id)).toBe(0);
    // The bill really changed, so this one write does wake the iPads.
    expect(await broadcasts()).toBeGreaterThan(before);
    const [failed] = await audits(h, id, "refund.failed");
    expect(failed).toMatchObject({ actor_staff_id: null, device_label: "Square refund" });
    expect(failed.reason).toMatch(/came back rejected/);

    // Nothing more happens to it, and the amount doesn't come back twice.
    await makeDue();
    expect(await pushRefunds()).toBe(0);
    expect(await refundedCents(id)).toBe(0);
    expect(await audits(h, id, "refund.failed")).toHaveLength(1);
    expect((await getSessionDetail(id)).session.refundable).toEqual({ method: "card", maxCents: 2500 });
    expect((await getSummary(null)).attention.map((a) => a.action)).toContain("refund.failed");
  });

  it("two workers that both hear Square's no give the amount back once", async () => {
    const { id } = await paidByCard();
    await refund(id, 500);
    await makeDue();
    await pushRefunds(); // the first refund is done: $5.00 stays refunded whatever happens next
    await refund(id, 1500);
    expect(await refundedCents(id)).toBe(2000);

    h.gateway.refundSettlesAs = "REJECTED";
    await makeDue();
    // While the first worker waits on Square its claim lapses, and a second worker takes the same
    // refund, hears the same no and records it. Then the first worker's answer arrives.
    let second = -1;
    h.gateway.duringRefundRead = async () => {
      await h.raw(null, `update public.refunds set claimed_at = now() - interval '61 seconds' where state = 'pending'`);
      second = await pushRefunds();
    };
    expect(await pushRefunds()).toBe(1);
    expect(second).toBe(1);
    expect(h.gateway.refundGets.filter((r) => r === "ref_2")).toHaveLength(2);

    expect((await refundRows(id)).map((r) => r.state)).toEqual(["completed", "failed"]);
    expect(await refundedCents(id)).toBe(500);
    expect(await audits(h, id, "refund.failed")).toHaveLength(1);
    expect((await getSessionDetail(id)).session.refundable).toEqual({ method: "card", maxCents: 2000 });
  });

  it("FAILED as the first answer is a no as well", async () => {
    const { id } = await paidByCard();
    h.gateway.refundCreateStatus = "FAILED";
    const e = await caught(refund(id, 500));
    expect(e).toMatchObject({ status: 409, code: "refund_failed" });
    expect((await refundRows(id))[0]).toMatchObject({ state: "failed", square_refund_id: "ref_1", square_status: "FAILED" });
    expect(await refundedCents(id)).toBe(0);
  });
});

describe("RB. Square still processing", () => {
  it("a refund Square keeps PENDING is looked at again and again, never given up on, never failed", async () => {
    const { id } = await paidByCard();
    await refund(id, 2500);
    h.gateway.refundSettlesAs = "PENDING";
    for (let i = 0; i < MAX_SEND_ATTEMPTS + 5; i++) {
      await makeDue();
      await pushRefunds();
    }
    const [row] = await refundRows(id);
    expect(row).toMatchObject({ state: "pending", square_refund_id: "ref_1", parked: false, last_error: null });
    expect(h.gateway.refunds).toHaveLength(1); // sent once; everything after is a read
    expect(h.gateway.refundGets.length).toBe(MAX_SEND_ATTEMPTS + 5);
    expect(await audits(h, id, "refund.unconfirmed")).toHaveLength(0);

    // A read that fails says nothing about the refund, even a 4xx.
    h.gateway.refundGetError = squareRejection(404, "NOT_FOUND");
    await makeDue();
    await pushRefunds();
    expect((await refundRows(id))[0]).toMatchObject({ state: "pending", parked: false });
    expect(await refundedCents(id)).toBe(2500);

    h.gateway.refundSettlesAs = "COMPLETED";
    await makeDue();
    await pushRefunds();
    expect((await refundRows(id))[0].state).toBe("completed");
  });
});

describe("RB. the background pass", () => {
  it("with nothing due performs no write at all", async () => {
    // One of each kind that must be left alone: completed, failed, waiting (not due), parked.
    const a = await paidByCard("Table 1");
    await refund(a.id, 500);
    await makeDue();
    await pushRefunds(); // completed
    h.gateway.refundError = squareRejection(400, "BAD_REQUEST");
    await caught(refund(a.id, 500)); // failed
    const b = await paidByCard("Table 2");
    await refund(b.id, 500); // pending at Square, next look a few seconds off
    const c = await paidByCard("Table 3");
    h.gateway.refundError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
    await refund(c.id, 500); // parked

    await h.raw(null, `truncate probe.writes, realtime.sent`);
    const sent = h.gateway.refunds.length;
    const read = h.gateway.refundGets.length;

    expect(await pushRefunds()).toBe(0);
    await refundsInBackground();
    await refundsInBackground();

    expect(await writes()).toEqual([]);
    expect(await broadcasts()).toBe(0);
    expect(h.gateway.refunds).toHaveLength(sent);
    expect(h.gateway.refundGets).toHaveLength(read);
  });

  it("a status check that completes a refund writes only to refunds and the audit log: no broadcast", async () => {
    const { id } = await paidByCard();
    await refund(id, 500);
    await makeDue();
    await h.raw(null, `truncate probe.writes, realtime.sent`);
    await refundsInBackground();
    expect((await refundRows(id))[0].state).toBe("completed");
    expect(new Set((await writes()).map((w) => w.tbl))).toEqual(new Set(["refunds", "audit_log"]));
    expect(await broadcasts()).toBe(0);
  });

  it("leaves a refund another worker is on alone for a minute, then takes it over with the same key", async () => {
    const { id } = await paidByCard();
    h.gateway.refundError = squareTimeout();
    await refund(id, 500);
    // As if the request that made it died mid-call: still claimed.
    await h.raw(null, `update public.refunds set next_attempt_at = now(), claimed_at = now()`);
    expect(await pushRefunds()).toBe(0);
    await h.raw(null, `update public.refunds set claimed_at = now() - interval '61 seconds'`);
    expect(await pushRefunds()).toBe(1);
    expect(h.gateway.refunds.map((r) => r.idempotencyKey)).toEqual([`${id}-rf1`, `${id}-rf1`]);
  });
});

describe("RB. reopening a bill that has refunds", () => {
  it("is refused while a refund is pending or completed, and allowed again once it has failed", async () => {
    const { id } = await paidByCard();
    await refund(id, 500);
    const pending = await caught(reversePaid(h.staff.managerActor, h.staff.manager, id, "Wrong bill"));
    expect(pending).toMatchObject({ status: 409, code: "conflict", message: "This bill has refunds on it, so it can't be reopened." });
    await makeDue();
    await pushRefunds();
    await expect(reversePaid(h.staff.managerActor, h.staff.manager, id, "Wrong bill")).rejects.toMatchObject({ status: 409 });
    expect((await getSession(h, id)).status).toBe("paid");

    const other = await paidByCard("Table 2");
    h.gateway.refundError = squareRejection(400, "BAD_REQUEST");
    await caught(refund(other.id, 500));
    await reversePaid(h.staff.managerActor, h.staff.manager, other.id, "Wrong bill");
    expect(await getSession(h, other.id)).toMatchObject({ status: "awaiting_payment", refunded_cents: 0 });
  });

  it("a cash bill with no refunds is reopened as before: the outbox refunds the whole sale", async () => {
    const id = await paidByCash();
    await reversePaid(h.staff.managerActor, h.staff.manager, id, "Wrong bill");
    await pushCashRecords();
    expect(h.gateway.refunds).toEqual([
      { idempotencyKey: `${id}-cr1`, paymentId: "pay_1", amountCents: 2500, reason: "Payment reversed in the table timer" },
    ]);
    expect(await refundRows(id)).toHaveLength(0);
  });
});

describe("RB. the summary", () => {
  it("totals the day's refunds by method, leaves failed ones out, and carries the facts on each paid row", async () => {
    const card = await paidByCard("Table 1");
    const cash = await paidByCash("Table 2");
    await refund(card.id, 1000, "Wrong rate charged");
    await refund(card.id, 250, "Spilt drink");
    await refund(cash, 500, "Left early");
    h.gateway.refundError = squareRejection(400, "BAD_REQUEST");
    await caught(refund(cash, 300, "Refused one"));
    await makeDue();
    await pushRefunds({ limit: 10 });

    const s = await getSummary(null);
    expect(s.refunds).toMatchObject({ count: 3, cents: 1750, cardCents: 1250, cashCents: 500 });
    expect(s.refunds.items.map((r) => [r.sessionId, r.label, r.method, r.amountCents, r.state, r.reason])).toEqual([
      [card.id, "Table 1", "card", 1000, "completed", "Wrong rate charged"],
      [card.id, "Table 1", "card", 250, "completed", "Spilt drink"],
      [cash, "Table 2", "cash", 500, "completed", "Left early"],
    ]);
    expect(s.refunds.items[0]).toMatchObject({ byName: "Sam Staff", approvedByName: "Mia Manager", error: null });

    const rows = new Map(s.paidItems.map((p) => [p.id, p]));
    expect(rows.get(card.id)).toMatchObject({ refundedCents: 1250, refundable: { method: "card", maxCents: 1250 }, canPrintReceipt: true });
    expect(rows.get(cash)).toMatchObject({ refundedCents: 500, refundable: { method: "cash", maxCents: 2000 }, canPrintReceipt: true });
    // Takings for the day: what came in less what went back.
    expect(s.paid.card.cents + s.paid.cash.cents - s.refunds.cents).toBe(2500 + 2500 - 1750);
  });
});

describe("RB. refunds nobody can confirm stay in front of every shift", () => {
  it("a parked refund is on every day's summary until it is dealt with, whatever day it was asked for", async () => {
    const parked = await paidByCard("Table 1");
    h.gateway.refundError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
    await refund(parked.id, 1500, "Left early");

    // Refunds that are merely in progress, done or refused are not "outstanding".
    const others = await paidByCard("Table 2");
    await refund(others.id, 300); // with Square, being processed
    h.gateway.refundError = squareTimeout();
    await refund(others.id, 200); // unanswered, will be sent again
    h.gateway.refundError = squareRejection(400, "BAD_REQUEST");
    await caught(refund(others.id, 100)); // refused

    const today = await getSummary(null);
    expect(today.refundsOutstanding).toMatchObject({ count: 1, cents: 1500 });
    expect(today.refundsOutstanding.items).toHaveLength(1);
    expect(today.refundsOutstanding.items[0]).toMatchObject({
      sessionId: parked.id,
      label: "Table 1",
      amountCents: 1500,
      method: "card",
      state: "pending",
      reason: "Left early",
    });
    expect(today.refundsOutstanding.items[0].error).toMatch(/Look at the payment in Square/);

    // The refund was asked for days ago, and the audit row that flagged it is days old too.
    await h.raw(null, `update public.refunds set created_at = created_at - interval '3 days' where session_id = '${parked.id}'`);
    const later = await getSummary(null);
    expect(later.refunds.items.map((r) => r.sessionId)).not.toContain(parked.id);
    expect(later.refundsOutstanding).toMatchObject({ count: 1, cents: 1500 });

    // And it is there on a day that has nothing to do with it, past or future.
    for (const date of ["2026-10-01", "2027-01-15"]) {
      const s = await getSummary(date);
      expect(s.refunds.count).toBe(0);
      expect(s.attention).toHaveLength(0);
      expect(s.refundsOutstanding).toMatchObject({ count: 1, cents: 1500 });
      expect(s.refundsOutstanding.items[0]).toMatchObject({ sessionId: parked.id, label: "Table 1" });
      expect(() => JSON.stringify(s)).not.toThrow();
    }
  });

  it("is empty when nothing is parked", async () => {
    const { id } = await paidByCard();
    await refund(id, 500);
    expect((await getSummary(null)).refundsOutstanding).toEqual({ count: 0, cents: 0, items: [] });
  });
});

describe("RB. counter sales and parts are ordinary bills", () => {
  it("a counter sale paid in cash can be refunded and its receipt printed", async () => {
    const { sessionId: id } = await openCounterSale(h.staff.actor);
    await addCustomItem(h.staff.actor, id, "Cue chalk", 800);
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, new Date());
    await pushCashRecords();
    expect((await getSessionDetail(id)).session).toMatchObject({ kind: "counter", refundable: { method: "cash", maxCents: 800 }, canPrintReceipt: true });

    const out = await refund(id, 800, "Wrong item");
    expect(out.refund).toMatchObject({ method: "cash", amountCents: 800 });
    await printReceipt(h.staff.actor, id);
    expect(h.gateway.receiptActions).toHaveLength(1);
    expect((await getSummary(null)).refunds.items[0]).toMatchObject({ sessionId: id, label: "Counter sale" });
  });

  it("a bill discounted to nothing and marked paid has no payment: nothing to refund, nothing to print", async () => {
    const id = await awaitingPayment(h);
    await setDiscount(h.staff.actor, h.staff.manager, id, { custom: { name: "On the house", kind: "percent", value: 10000 } });
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, new Date());
    expect(await getSession(h, id)).toMatchObject({ status: "paid", total_cents: 0, settled_cents: 0 });

    expect(await resolvePayment(id)).toBeNull();
    expect((await getSessionDetail(id)).session).toMatchObject({ refundedCents: 0, refundable: null, canPrintReceipt: false });
    const r = await caught(refund(id, 5));
    expect(r).toMatchObject({ status: 409, code: "conflict", message: "Nothing was collected on this bill, so there is nothing to refund." });
    const p = await caught(printReceipt(h.staff.actor, id));
    expect(p).toMatchObject({ status: 409, code: "conflict", message: "Nothing was collected on this bill, so there is no receipt to print." });
    expect(h.gateway.refunds).toHaveLength(0);
    expect(h.gateway.receiptActions).toHaveLength(0);
    expect(await refundRows(id)).toHaveLength(0);
  });

  it("a part paid by card is refunded against its own payment", async () => {
    const parent = await awaitingPayment(h); // $25.00
    const { partIds } = await splitBill(h.staff.actor, parent, { amountCents: 1000 });
    const part = partIds[0];
    const out = await chargeCard(h.staff.actor, part);
    if (out.kind !== "sent") throw new Error("expected the charge to be sent");
    const paymentId = h.gateway.cardPaymentFor(out.checkoutId);
    await webhook(out.checkoutId, "COMPLETED", part, [paymentId]);

    expect((await getSessionDetail(part)).session).toMatchObject({ kind: "part", refundable: { method: "card", maxCents: 1000 } });
    await expect(refund(part, 1001)).rejects.toMatchObject({ status: 409 });
    await refund(part, 400);
    expect(h.gateway.refunds[0]).toMatchObject({ idempotencyKey: `${part}-rf1`, paymentId, amountCents: 400 });
    expect(await refundedCents(part)).toBe(400);
    // The bill it was split from is untouched.
    expect(await refundedCents(parent)).toBe(0);
  });
});

describe("RB. the refunds table", () => {
  it("can't be deleted from or read by the browser roles, and keeps one row per (bill, seq)", async () => {
    const { id } = await paidByCard();
    await refund(id, 500);
    expect((await h.rawError("timer_app", `delete from public.refunds`)).message).toMatch(/permission denied|never deleted/);
    expect((await h.rawError(null, `delete from public.refunds`)).message).toMatch(/never deleted/);
    expect((await h.rawError("anon", `select * from public.refunds`)).message).toMatch(/permission denied/);
    expect((await h.rawError("authenticated", `select * from public.refunds`)).message).toMatch(/permission denied/);
    const dup = await h.rawError(
      null,
      `insert into public.refunds (session_id, seq, square_payment_id, method, amount_cents, reason, created_by, approved_by)
       select session_id, seq, square_payment_id, method, amount_cents, reason, created_by, approved_by from public.refunds`,
    );
    expect(dup.code).toBe("23505");
  });
});

// ---------------------------------------------------------------------------
// C. Receipts
// ---------------------------------------------------------------------------

describe("RC. printing a receipt on the Terminal", () => {
  it("card: always marked as a duplicate, print only, a fresh key each time", async () => {
    const { id, paymentId } = await paidByCard();
    expect(await printReceipt(h.staff.actor, id)).toEqual({ ok: true });
    expect(await printReceipt(h.staff.actor, id)).toEqual({ ok: true });
    expect(h.gateway.receiptActions).toHaveLength(2);
    expect(h.gateway.receiptActions[0]).toMatchObject({ deviceId: "DEVICE_TEST", paymentId, isDuplicate: true });
    expect(h.gateway.receiptActions[1]).toMatchObject({ deviceId: "DEVICE_TEST", paymentId, isDuplicate: true });
    const [k1, k2] = h.gateway.receiptActions.map((a) => a.idempotencyKey);
    expect(k1).not.toBe(k2);

    const printed = await audits(h, id, "receipt.printed");
    expect(printed).toHaveLength(2);
    expect(printed[0]).toMatchObject({ actor_staff_id: h.staff.actor.staffId, device_label: "Counter" });
    expect(printed[0].after).toMatchObject({ payment_id: paymentId, method: "card", is_duplicate: true, action_id: "act_1" });
  });

  it("card from before payment ids were kept: looks the payment up first, then prints", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await webhook("chk_1", "COMPLETED", id); // no payment id stored
    expect((await getSessionDetail(id)).session.canPrintReceipt).toBe(true);
    h.gateway.getFor.set("chk_1", "COMPLETED");
    await printReceipt(h.staff.actor, id);
    expect(h.gateway.gets).toEqual(["chk_1"]);
    expect(h.gateway.receiptActions[0]).toMatchObject({ paymentId: "cardpay_1", isDuplicate: true });
  });

  it("cash: the first print is the original, later ones are duplicates", async () => {
    const id = await paidByCash();
    await printReceipt(h.staff.actor, id);
    await printReceipt(h.staff.actor, id);
    await printReceipt(h.staff.actor, id);
    expect(h.gateway.receiptActions.map((a) => [a.paymentId, a.isDuplicate])).toEqual([
      ["pay_1", false],
      ["pay_1", true],
      ["pay_1", true],
    ]);
  });

  it("cash that hasn't reached Square yet is sent first, then printed", async () => {
    const id = await paidByCash("Table 1", 60, false);
    expect(h.gateway.cashPayments).toHaveLength(0);
    expect((await getSessionDetail(id)).session).toMatchObject({ canPrintReceipt: true, refundable: null });

    expect(await printReceipt(h.staff.actor, id)).toEqual({ ok: true });
    expect(h.gateway.cashPayments).toHaveLength(1);
    expect(h.gateway.receiptActions).toEqual([
      expect.objectContaining({ paymentId: "pay_1", isDuplicate: false, deviceId: "DEVICE_TEST" }),
    ]);
    // Sent once: the background pass has nothing left to do for it.
    expect(await pushCashRecords()).toBe(0);
    expect(h.gateway.cashPayments).toHaveLength(1);
  });

  it("cash that Square won't take right now: 409, nothing printed", async () => {
    const id = await paidByCash("Table 1", 60, false);
    h.gateway.cashError = squareTimeout();
    h.gateway.cashErrorSticky = true;
    const e = await caught(printReceipt(h.staff.actor, id));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toMatch(/Square hasn't taken this cash sale yet/);
    expect(h.gateway.receiptActions).toHaveLength(0);
  });

  it("cash held back after a Square POS handoff is not pushed early", async () => {
    const id = await awaitingPayment(h);
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false, holdSquareCashSeconds: 300 }, new Date());
    expect((await getSessionDetail(id)).session.canPrintReceipt).toBe(false);
    const e = await caught(printReceipt(h.staff.actor, id));
    expect(e).toMatchObject({ status: 409 });
    expect(h.gateway.cashPayments).toHaveLength(0);
    expect(h.gateway.receiptActions).toHaveLength(0);
  });

  it("is refused when no Terminal is paired", async () => {
    const { id } = await paidByCard();
    await h.sql`update public.settings set terminal_device_id = null`;
    const e = await caught(printReceipt(h.staff.actor, id));
    expect(e).toMatchObject({ status: 409, code: "conflict" });
    expect(e.message).toMatch(/No Terminal is paired/);
    expect(h.gateway.receiptActions).toHaveLength(0);
    expect((await getSessionDetail(id)).session.canPrintReceipt).toBe(false);
    // Refunding doesn't need the Terminal.
    expect((await getSessionDetail(id)).session.refundable).toEqual({ method: "card", maxCents: 2500 });
  });

  it("is refused for a bill that isn't paid, or whose card was taken elsewhere", async () => {
    const unpaid = await awaitingPayment(h, "Table 1");
    await expect(printReceipt(h.staff.actor, unpaid)).rejects.toMatchObject({ name: "TransitionError" });
    const byHand = await awaitingPayment(h, "Table 2");
    await markPaid(h.staff.actor, byHand, "card", { cardConfirmed: true }, at(100));
    const e = await caught(printReceipt(h.staff.actor, byHand));
    expect(e).toMatchObject({ status: 409 });
    expect(e.message).toMatch(/wasn't taken on the Terminal/);
    expect(h.gateway.receiptActions).toHaveLength(0);
  });

  it("a refusal from Square answers with something staff can check, and isn't counted as a print", async () => {
    const id = await paidByCash();
    h.gateway.receiptError = squareRejection(400, "BAD_REQUEST", "Square couldn't send the receipt to the Terminal: device is not available");
    const e = await caught(printReceipt(h.staff.actor, id));
    expect(e).toMatchObject({ status: 409, code: "conflict", message: "The Terminal didn't accept the print request. Is it switched on?" });
    const [failed] = await audits(h, id, "receipt.failed");
    expect(failed.reason).toMatch(/device is not available/);
    expect(await audits(h, id, "receipt.printed")).toHaveLength(0);

    // Square unreachable is a different answer (and still not a print).
    h.gateway.receiptError = squareTimeout();
    await expect(printReceipt(h.staff.actor, id)).rejects.toMatchObject({ status: 502, code: "square_error" });

    // So the next one that works is still the original.
    await printReceipt(h.staff.actor, id);
    expect(h.gateway.receiptActions[2]).toMatchObject({ isDuplicate: false });
    expect(await getSession(h, id)).toMatchObject({ status: "paid" });
  });

  it("holds no lock and changes nothing on the bill: no floor broadcast", async () => {
    const { id } = await paidByCard();
    await h.raw(null, `truncate probe.writes, realtime.sent`);
    await printReceipt(h.staff.actor, id);
    expect(new Set((await writes()).map((w) => w.tbl))).toEqual(new Set(["audit_log"]));
    expect(await broadcasts()).toBe(0);
  });
});
