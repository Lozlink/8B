import "server-only";
import type { SquareCashState } from "@/lib/domain/types";
import * as orders from "@/lib/square/orders";
import type { OrderDiscountInput, OrderLineInput } from "@/lib/square/orders";
import * as payments from "@/lib/square/payments";
import type { Actor, Manager } from "./auth";
import { audit } from "./audit";
import { db, withTx, type Db, type Tx } from "./db";
import { squareEnv, squareLooksConfigured } from "./env";
import { AppError } from "./errors";
import { isKeyReused, isSquareRejection, squareStatus } from "./square-errors";

/*
 * Cash sales go into Square through an outbox.
 *
 * "Mark paid – cash" writes one `square_cash_records` row in the same transaction that marks the
 * bill paid, and returns. Everything that talks to Square happens here, afterwards, with no
 * database lock or transaction held across a Square call. A row stays `pending` until Square holds
 * what the row wants it to hold (the sale, or the sale and its refund), and is retried with the
 * same idempotency keys until it does, so a slow or absent Square can never stop staff taking cash
 * and a retry can never record a sale twice.
 *
 * `square_cash_records` has no floor-broadcast trigger and neither has `audit_log`, so this can run
 * after every floor fetch without making the iPads refetch.
 */

// ---------------------------------------------------------------------------
// Square gateway (swappable in tests)
// ---------------------------------------------------------------------------

export interface CashGateway {
  createOrder: typeof orders.createOrder;
  createCashPayment: typeof payments.createCashPayment;
  refundPayment: typeof payments.refundPayment;
}

let gateway: CashGateway = {
  createOrder: orders.createOrder,
  createCashPayment: payments.createCashPayment,
  refundPayment: payments.refundPayment,
};

export function setCashGatewayForTests(g: CashGateway): void {
  gateway = g;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface CashRecordRow {
  id: string;
  session_id: string;
  seq: number;
  amount_cents: number;
  bill_cents: number;
  /** jsonb: validated by `parseStoredOrder` before use. */
  order_lines: unknown;
  note: string | null;
  want: "recorded" | "refunded";
  state: SquareCashState;
  square_order_id: string | null;
  square_payment_id: string | null;
  square_refund_id: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
  claimed_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A row gives up and asks for a manager after this many tries. */
export const MAX_ATTEMPTS = 12;
const REFUND_REASON = "Payment reversed in the table timer";
const SYSTEM_LABEL = "Square cash";

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function isLine(v: unknown): v is OrderLineInput {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.uid === "string" &&
    (l.catalogObjectId === null || typeof l.catalogObjectId === "string") &&
    (l.name === null || typeof l.name === "string") &&
    typeof l.quantity === "number" &&
    typeof l.basePriceCents === "number" &&
    (l.note === null || typeof l.note === "string")
  );
}

function isDiscount(v: unknown): v is OrderDiscountInput {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.uid === "string" && typeof d.name === "string" && typeof d.amountCents === "number" && Number.isInteger(d.amountCents) && d.amountCents > 0;
}

/** The Square order stored on a row: its lines and, if the bill had one, its discount. */
export interface StoredOrder {
  lines: OrderLineInput[];
  discount: OrderDiscountInput | null;
}

/**
 * What goes in `order_lines`. A bill with no discount is stored as it always was, a bare array of
 * lines, so the release before this one can still read it (it runs for a short while after the
 * migration, and again if this release is ever rolled back). Only a bill with a discount uses the
 * object form; the older release treats that as "no order" and records a plain amount.
 */
export function storedOrderJson(lines: OrderLineInput[] | null, discount: OrderDiscountInput | null | undefined): string | null {
  if (!lines || lines.length === 0) return null;
  return JSON.stringify(discount && discount.amountCents > 0 ? { lines, discount } : lines);
}

/**
 * The order stored on a row, or null when the sale goes to Square as a plain amount. Reads both
 * shapes: a bare array of lines (every row written before discounts existed, and every row without
 * one since) and `{ lines, discount }`.
 */
export function parseStoredOrder(v: unknown): StoredOrder | null {
  let value = v;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  let rawLines: unknown = value;
  let rawDiscount: unknown = null;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    rawLines = o.lines;
    rawDiscount = o.discount ?? null;
  }
  if (!Array.isArray(rawLines) || rawLines.length === 0 || !rawLines.every(isLine)) return null;
  // A discount we can't read means we don't know the order: record a plain amount rather than
  // send the lines without it (Square's total would be wrong and the order thrown away anyway).
  let discount: OrderDiscountInput | null = null;
  if (rawDiscount !== null) {
    if (!isDiscount(rawDiscount)) return null;
    discount = { uid: rawDiscount.uid, name: rawDiscount.name, amountCents: rawDiscount.amountCents };
  }
  // Rebuilt field by field, in a fixed order: the body sent under an idempotency key must be the
  // same on every try, whatever order the database hands the keys back in.
  return {
    lines: rawLines.map((l) => ({
      uid: l.uid,
      catalogObjectId: l.catalogObjectId,
      name: l.name,
      quantity: l.quantity,
      basePriceCents: l.basePriceCents,
      note: l.note,
    })),
    discount,
  };
}

// ---------------------------------------------------------------------------
// Called inside the bill's own transaction
// ---------------------------------------------------------------------------

export interface EnqueueCashInput {
  sessionId: string;
  /** Cash collected: the bill rounded to 5c. */
  amountCents: number;
  /** The bill it settled. */
  billCents: number;
  note: string | null;
  /** The Square order lines as they stand now, or null to record a plain amount. */
  lines: OrderLineInput[] | null;
  /** The discount off that order, if the bill has one. Ignored without lines. */
  discount?: OrderDiscountInput | null;
  staffId: string | null;
  /** Don't send before this many seconds have passed (default: send straight away). */
  holdSeconds?: number;
}

/**
 * Queues a cash payment for Square. Call inside the transaction that marks the bill paid, with the
 * session row locked (the lock is what makes `seq` safe). Returns the record's `seq`, or null when
 * nothing was queued: Square isn't set up, or there is no amount to record.
 *
 * It never refuses: whatever happens here, the bill is still paid.
 */
export async function enqueueCashRecord(tx: Tx, input: EnqueueCashInput): Promise<number | null> {
  if (!squareLooksConfigured()) return null;
  // Square refuses cash that isn't a multiple of 5c, and the table's own check would fail the
  // whole payment. `cashDueCents` never produces one; this is the backstop.
  if (input.amountCents <= 0 || input.amountCents % 5 !== 0 || input.billCents <= 0) return null;
  const lines = storedOrderJson(input.lines, input.discount);
  const [row] = await tx<{ seq: number }[]>`
    insert into public.square_cash_records
      (session_id, seq, amount_cents, bill_cents, order_lines, note, created_by, next_attempt_at)
    values (
      ${input.sessionId},
      (select coalesce(max(seq), 0) + 1 from public.square_cash_records where session_id = ${input.sessionId}),
      ${input.amountCents}, ${input.billCents}, ${lines}::text::jsonb, ${input.note?.slice(0, 500) ?? null}, ${input.staffId},
      now() + ${Math.max(0, Math.floor(input.holdSeconds ?? 0))}::int * interval '1 second'
    )
    returning seq`;
  return row?.seq ?? null;
}

export interface PosCashInput {
  sessionId: string;
  amountCents: number;
  billCents: number;
  note: string | null;
  staffId: string | null;
  /** The cash payment Square POS made. */
  paymentId: string;
  orderId: string | null;
}

/**
 * Records a cash sale that Square POS has already made (the drawer iPad). The row starts out
 * `recorded`, so nothing is ever sent for it, and a later reversal refunds that payment through the
 * outbox like any other. Call inside the transaction that marks the bill paid, session row locked.
 */
export async function insertPosCashRecord(tx: Tx, input: PosCashInput): Promise<number> {
  const [row] = await tx<{ seq: number }[]>`
    insert into public.square_cash_records
      (session_id, seq, amount_cents, bill_cents, order_lines, note, created_by, state, attempts,
       square_payment_id, square_order_id)
    values (
      ${input.sessionId},
      (select coalesce(max(seq), 0) + 1 from public.square_cash_records where session_id = ${input.sessionId}),
      ${input.amountCents}, ${input.billCents}, null, ${input.note?.slice(0, 500) ?? null}, ${input.staffId},
      'recorded', 1, ${input.paymentId}, ${input.orderId}
    )
    returning seq`;
  return row.seq;
}

/**
 * The bill was marked paid in cash by hand and its sale hasn't gone to Square yet, and now it turns
 * out Square POS took that sale. Points the waiting row at the POS payment instead of sending a
 * second one. Returns the row's seq, or null when there is no such unsent row (already sent,
 * being sent right now, or for a different amount).
 */
export async function adoptPosPayment(
  tx: Tx,
  input: { sessionId: string; amountCents: number; paymentId: string; orderId: string | null },
): Promise<number | null> {
  const [r] = await tx<Pick<CashRecordRow, "id" | "seq" | "want" | "state" | "attempts" | "square_payment_id" | "amount_cents">[]>`
    select id, seq, want, state, attempts, square_payment_id, amount_cents from public.square_cash_records
    where session_id = ${input.sessionId}
    order by seq desc limit 1
    for update`;
  // attempts = 0 means no worker has ever claimed it: nothing has been sent (see markCashReversed).
  const unsent = r && r.want === "recorded" && r.state === "pending" && r.attempts === 0 && !r.square_payment_id;
  if (!r || !unsent || r.amount_cents !== input.amountCents) return null;
  await tx`
    update public.square_cash_records set
      state = 'recorded', attempts = 1, order_lines = null, last_error = null, claimed_at = null,
      square_payment_id = ${input.paymentId}, square_order_id = ${input.orderId}
    where id = ${r.id}`;
  return r.seq;
}

/** Which of these Square payment ids already belong to a cash record, and to which bill. */
export async function linkedPayments(q: Db, paymentIds: string[]): Promise<Map<string, string>> {
  if (paymentIds.length === 0) return new Map();
  const rows = await q<{ square_payment_id: string; session_id: string }[]>`
    select square_payment_id, session_id from public.square_cash_records
    where square_payment_id = any(${paymentIds}::text[])`;
  return new Map(rows.map((r) => [r.square_payment_id, r.session_id]));
}

/** The unique index that keeps one Square payment on one record. */
export const PAYMENT_UNIQUE_INDEX = "square_cash_records_payment_uniq";

/**
 * A manager reversed a bill that was paid in cash. Call inside that transaction.
 *
 * If nothing has been sent to Square yet, the record is `skipped` and nothing ever will be.
 * Otherwise Square has (or may have) the sale, so the record now wants a refund as well and goes
 * back in the queue. Returns what was decided, for the audit trail; null when there is no record.
 */
export async function markCashReversed(tx: Tx, sessionId: string): Promise<"skipped" | "refund_queued" | null> {
  const [r] = await tx<Pick<CashRecordRow, "id" | "want" | "state" | "attempts" | "square_payment_id">[]>`
    select id, want, state, attempts, square_payment_id from public.square_cash_records
    where session_id = ${sessionId}
    order by seq desc limit 1
    for update`;
  // No record: the bill was paid in cash while Square wasn't set up. A record that already wants a
  // refund or was skipped belongs to an earlier cash payment of this bill, not this one.
  if (!r || r.want !== "recorded" || r.state === "skipped") return null;

  // `attempts` is bumped when a worker claims the row, before it calls Square. Zero means no
  // request for this record has ever left the building.
  if (r.attempts === 0 && !r.square_payment_id) {
    await tx`update public.square_cash_records set state = 'skipped', last_error = null where id = ${r.id}`;
    return "skipped";
  }
  // `attempts` goes back to 1, not 0: the refund gets a full run of retries, and 0 keeps meaning
  // "nothing was ever sent".
  await tx`
    update public.square_cash_records
    set want = 'refunded', state = 'pending', attempts = 1, next_attempt_at = now(), last_error = null
    where id = ${r.id}`;
  return "refund_queued";
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/** Square answered, and the answer was no. Nothing was created. */
class CashRefused extends Error {}

/**
 * Square refused this particular request. A 401 or 403 is about the access token, not the sale, so
 * it is retried like an outage rather than treated as a verdict.
 */
function isRefusal(e: unknown): e is AppError {
  if (!isSquareRejection(e)) return false;
  const status = squareStatus(e);
  return status !== 401 && status !== 403;
}

// A record a worker is talking to Square about is left alone for 60 s, in case that worker died
// mid-call. After that anyone may pick it up; the idempotency keys make the second try harmless.
const dueSql = (q: Db) => q`
  state = 'pending' and next_attempt_at <= now()
  and (claimed_at is null or claimed_at < now() - interval '60 seconds')`;

/** Claims the most overdue record, or returns null. One statement, safe against other workers. */
async function claimNext(): Promise<CashRecordRow | null> {
  const q = db();
  const [row] = await q<CashRecordRow[]>`
    update public.square_cash_records set claimed_at = now(), attempts = attempts + 1
    where id in (
      select id from public.square_cash_records
      where ${dueSql(q)}
      order by next_attempt_at, created_at
      limit 1
      for update skip locked
    )
    returning *`;
  return row ?? null;
}

type Step = "order" | "payment" | "refund";

/** Gives up on the itemised order for this record: from now on it is a plain amount. */
async function goPlain(row: CashRecordRow, reason: string, detail: Record<string, unknown>): Promise<void> {
  await withTx(async (tx) => {
    // Written before the plain payment is sent, so a later try can never go back to the order
    // and record the sale a second time under the other key.
    await tx`
      update public.square_cash_records set order_lines = null, square_order_id = null, last_error = ${reason}
      where id = ${row.id}`;
    await audit(tx, {
      actorStaffId: null,
      deviceLabel: SYSTEM_LABEL,
      action: "square.cash_itemise_failed",
      entity: "session",
      entityId: row.session_id,
      after: { seq: row.seq, amount_cents: row.amount_cents, bill_cents: row.bill_cents, lines: row.order_lines, ...detail },
      reason,
    });
  });
}

async function processRecord(row: CashRecordRow, locationId: string): Promise<void> {
  const q = db();
  const sid = row.session_id;
  const stored = parseStoredOrder(row.order_lines);
  let lines = stored?.lines ?? null;
  const discount = stored?.discount ?? null;
  let orderId = row.square_order_id;
  let paymentId = row.square_payment_id;
  let refundId = row.square_refund_id;
  let want = row.want;
  let plainReason: string | null = null;
  let step: Step = "order";

  try {
    if (!paymentId) {
      if (lines && !orderId) {
        // The order is for the true bill. Square adds its own rounding line when the cash pays it.
        let detail: Record<string, unknown> = {};
        try {
          const order = await gateway.createOrder({
            idempotencyKey: `${sid}-co${row.seq}`,
            locationId,
            referenceId: sid,
            lines,
            // Left out when there is none: a row without a discount sends the body it always has.
            ...(discount ? { discount } : {}),
          });
          if (order.totalCents === row.bill_cents) {
            orderId = order.id;
            await q`update public.square_cash_records set square_order_id = ${orderId} where id = ${row.id}`;
          } else {
            plainReason = `Square's total for this bill (${dollars(order.totalCents)}) doesn't match ours (${dollars(row.bill_cents)}), so the sale went in as a single amount.`;
            detail = { order_id: order.id, square_total_cents: order.totalCents };
          }
        } catch (e) {
          if (!isRefusal(e)) throw e;
          plainReason = `Square wouldn't take the itemised sale, so it went in as a single amount. ${e.message}`;
          detail = { square: e.detail ?? null };
        }
        if (plainReason) {
          await goPlain(row, plainReason, detail);
          lines = null;
        }
      }

      step = "payment";
      const withOrder = lines !== null && orderId !== null;
      const payment = await gateway.createCashPayment({
        // `p` pays an order, `q` is a plain amount: the two bodies never share a key.
        idempotencyKey: withOrder ? `${sid}-cp${row.seq}` : `${sid}-cq${row.seq}`,
        amountCents: row.amount_cents,
        locationId,
        referenceId: sid,
        note: row.note,
        ...(withOrder && orderId ? { orderId } : {}),
      });
      if (payment.status === "FAILED" || payment.status === "CANCELED") {
        throw new CashRefused(`Square didn't accept the cash payment (it came back ${payment.status.toLowerCase()}).`);
      }
      paymentId = payment.id;
      // The reversal may have landed while Square was answering: read `want` back with the write.
      const [now] = await q<Pick<CashRecordRow, "want">[]>`
        update public.square_cash_records set square_payment_id = ${paymentId} where id = ${row.id}
        returning want`;
      want = now?.want ?? want;
    }

    if (want === "refunded" && !refundId) {
      step = "refund";
      const refund = await gateway.refundPayment({
        idempotencyKey: `${sid}-cr${row.seq}`,
        paymentId,
        amountCents: row.amount_cents,
        reason: REFUND_REASON,
      });
      if (refund.status === "REJECTED" || refund.status === "FAILED") {
        throw new CashRefused(`Square didn't accept the refund (it came back ${refund.status.toLowerCase()}).`);
      }
      refundId = refund.id;
      await q`update public.square_cash_records set square_refund_id = ${refundId} where id = ${row.id}`;
    }

    // One statement decides the final state from what the row says now. If a manager reversed the
    // payment since we last looked, `want` is 'refunded' with no refund yet: the row stays pending
    // and due, and the next pass refunds it.
    await q`
      update public.square_cash_records set
        claimed_at = null,
        last_error = ${plainReason},
        state = case
          when want = 'recorded' then 'recorded'
          when square_refund_id is not null then 'refunded'
          else 'pending' end,
        next_attempt_at = case
          when want = 'refunded' and square_refund_id is null then now()
          else next_attempt_at end
      where id = ${row.id}`;
  } catch (e) {
    await recordFailure(row, step, e);
  }
}

/** The reason shown to staff. Never includes anything but Square's own wording or ours. */
function failureMessage(e: unknown): string {
  if (isKeyReused(e)) {
    return "Square already has a different request on file for this sale. Look the sale up in Square before trying again.";
  }
  if (e instanceof AppError || e instanceof CashRefused) return e.message;
  return "Something went wrong while recording this in Square.";
}

async function recordFailure(row: CashRecordRow, step: Step, e: unknown): Promise<void> {
  const q = db();
  const refused = e instanceof CashRefused || isRefusal(e);
  const final = refused || isKeyReused(e) || row.attempts >= MAX_ATTEMPTS;
  const message = failureMessage(e).slice(0, 500);
  if (!(e instanceof AppError) && !(e instanceof CashRefused)) {
    console.warn("[square] cash record failed unexpectedly", row.id, e instanceof Error ? e.message : e);
  }

  if (!final) {
    // 15 s, doubling with each try, capped at 15 minutes.
    const waitSeconds = Math.min(15 * 2 ** row.attempts, 900);
    await q`
      update public.square_cash_records set
        claimed_at = null, last_error = ${message}, next_attempt_at = now() + ${waitSeconds}::int * interval '1 second'
      where id = ${row.id}`;
    return;
  }

  // Square said no to the payment itself, so Square holds nothing for this record. If the bill has
  // been reversed in the meantime there is nothing left to do: no sale, so no refund.
  const nothingInSquare = refused && step === "payment";
  await withTx(async (tx) => {
    const [after] = await tx<Pick<CashRecordRow, "state" | "want">[]>`
      update public.square_cash_records set
        claimed_at = null, last_error = ${message},
        state = case
          when ${nothingInSquare}::boolean and want = 'refunded' and square_payment_id is null then 'skipped'
          else 'failed' end
      where id = ${row.id}
      returning state, want`;
    if (after?.state !== "failed") return;
    const what =
      step === "refund" || (after.want === "refunded" && row.square_payment_id)
        ? `The refund of the ${dollars(row.amount_cents)} cash payment isn't in Square`
        : `The ${dollars(row.amount_cents)} cash payment isn't in Square`;
    const why = refused || isKeyReused(e) ? message : `Square couldn't be reached after ${row.attempts} tries. ${message}`;
    await audit(tx, {
      actorStaffId: null,
      deviceLabel: SYSTEM_LABEL,
      action: "square.cash_failed",
      entity: "session",
      entityId: row.session_id,
      after: {
        seq: row.seq,
        step,
        want: after.want,
        amount_cents: row.amount_cents,
        bill_cents: row.bill_cents,
        attempts: row.attempts,
        square: e instanceof AppError ? e.detail ?? null : null,
      },
      reason: `${what}. ${why} A manager can send it again from Admin → Items.`,
    });
  });
}

/**
 * Sends what is due to Square: up to `limit` records, one at a time, and no new record is started
 * once `budgetMs` has passed. Returns how many were worked on.
 *
 * Starts with a read-only check, so the usual case (nothing due) writes nothing at all.
 */
export async function pushCashRecords(opts: { limit?: number; budgetMs?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 5;
  const budgetMs = opts.budgetMs ?? 10_000;
  const q = db();
  const [due] = await q<{ due: boolean }[]>`
    select exists (select 1 from public.square_cash_records where ${dueSql(q)}) as due`;
  if (!due?.due) return 0;

  const locationId = squareEnv().SQUARE_LOCATION_ID;
  const started = Date.now();
  let worked = 0;
  // Records are claimed one at a time, each just before it is sent, so a claim never sits waiting
  // behind a slow record and expires. A record left due by its own pass (reversed while it was
  // being sent) is picked up again here and refunded.
  while (worked < limit && Date.now() - started < budgetMs) {
    const row = await claimNext();
    if (!row) break;
    try {
      await processRecord(row, locationId);
    } catch (e) {
      // The database refused to take the outcome. The claim lapses after a minute and the record is
      // tried again with the same keys.
      console.warn("[square] cash record left claimed", row.id, e instanceof Error ? e.message : e);
    }
    worked++;
  }
  return worked;
}

/** For `after()`: can never throw, and does nothing when Square isn't configured. */
export async function pushCashInBackground(): Promise<void> {
  try {
    if (!squareLooksConfigured()) return;
    await pushCashRecords();
  } catch (e) {
    console.warn("[square] cash push skipped", e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// What is still outstanding / manager retry
// ---------------------------------------------------------------------------

export interface CashOutstanding {
  pending: number;
  failed: number;
  lastError: string | null;
}

/** Every cash record (all time) that Square doesn't hold yet, and the latest reason one failed. */
export async function getCashOutstanding(q: Db = db()): Promise<CashOutstanding> {
  const [r] = await q<{ pending: number; failed: number; last_error: string | null }[]>`
    select
      count(*) filter (where state = 'pending')::int as pending,
      count(*) filter (where state = 'failed')::int as failed,
      (select last_error from public.square_cash_records
       where state in ('pending', 'failed') and last_error is not null
       order by updated_at desc limit 1) as last_error
    from public.square_cash_records
    where state in ('pending', 'failed')`;
  return { pending: r?.pending ?? 0, failed: r?.failed ?? 0, lastError: r?.last_error ?? null };
}

/**
 * Manager action: puts every failed record back in the queue, makes everything waiting due now,
 * and sends as much as fits in one request. Returns what is still outstanding afterwards.
 */
export async function retryCashRecords(actor: Actor, manager: Manager): Promise<CashOutstanding> {
  squareEnv(); // 503 with a staff-readable message when Square isn't set up
  const before = await getCashOutstanding();
  if (before.pending + before.failed > 0) {
    // A failed record restarts at 1, not 0: zero is reserved for "nothing was ever sent", which is
    // what lets a reversal skip a record instead of refunding it.
    //
    // A waiting record that has never been tried (attempts = 0, not due yet) is one being held
    // back on purpose: the bill was handed to Square POS first, and POS may still report the sale
    // (see pos-cash.ts). Retry leaves those alone. Sending one early is how Square gets a sale twice.
    await db()`
      update public.square_cash_records set
        state = 'pending', next_attempt_at = now(),
        attempts = case when state = 'failed' then 1 else attempts end
      where state = 'failed' or (state = 'pending' and next_attempt_at > now() and attempts > 0)`;
    // The iPad gives a POST 35 s. Ten seconds of starting new records, plus the one in hand, stays inside it;
    // whatever is left is picked up by the background pass.
    await pushCashRecords({ limit: 25, budgetMs: 10_000 });
  }
  const after = await getCashOutstanding();
  await audit(db(), {
    actorStaffId: actor.staffId,
    approvedByStaffId: manager.id,
    deviceLabel: actor.deviceLabel,
    action: "square.cash_retry",
    entity: "square_cash",
    entityId: null,
    before: { pending: before.pending, failed: before.failed },
    after: { pending: after.pending, failed: after.failed },
  });
  return after;
}
