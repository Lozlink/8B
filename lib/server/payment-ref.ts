import "server-only";
import type { SessionStatus } from "@/lib/domain/machine";
import type { SessionDTO, SettledMethod, SettledVia, SquareCashState } from "@/lib/domain/types";
import * as payments from "@/lib/square/payments";
import * as terminal from "@/lib/square/terminal";
import { db, type Db } from "./db";
import { squareStatus } from "./square-errors";

/*
 * Which Square payment settled a bill.
 *
 * A refund and a receipt reprint are both asked for against a Square payment id, so this is the one
 * place that knows where a paid bill's payment id lives:
 *
 *   - card taken on the Terminal: on the COMPLETED row in `terminal_checkouts` (stored whenever a
 *     checkout is seen COMPLETED; fetched from Square on demand for rows from before that);
 *   - cash: on the bill's latest `square_cash_records` row, once the sale is in Square. That covers
 *     both the app's own outbox and sales taken in Square POS on the drawer iPad;
 *   - anything else (card marked paid by hand, cash that never reached Square): nowhere. The app
 *     can't refund or print it.
 */

// ---------------------------------------------------------------------------
// Square gateway for refunds, receipts and payment ids (swappable in tests)
// ---------------------------------------------------------------------------

export interface PaymentsGateway {
  refundPayment: typeof payments.refundPayment;
  getRefund: typeof payments.getRefund;
  /** Reads a Terminal checkout. Named as in the Terminal gateway, so one fake can serve both. */
  get: typeof terminal.getTerminalCheckout;
  createReceiptAction: typeof terminal.createReceiptAction;
}

let gateway: PaymentsGateway = {
  refundPayment: payments.refundPayment,
  getRefund: payments.getRefund,
  get: terminal.getTerminalCheckout,
  createReceiptAction: terminal.createReceiptAction,
};

export function setPaymentsGatewayForTests(g: PaymentsGateway): void {
  gateway = g;
}

export function paymentsGateway(): PaymentsGateway {
  return gateway;
}

// ---------------------------------------------------------------------------
// Looking the payment up
// ---------------------------------------------------------------------------

export interface ResolvedPayment {
  paymentId: string;
  /** How the bill was paid, which is also how a refund goes back. */
  method: SettledMethod;
  /** What that payment was for: the amount the card was charged, or the cash recorded in Square. */
  amountCents: number;
}

/**
 * Why a bill has no payment the app can act on.
 *   not_paid          — the bill isn't paid (or doesn't exist)
 *   other_reader      — card, marked paid by staff: it was taken on another reader
 *   card_unknown      — card, settled by Square, but no completed card request carries a payment
 *   cash_not_recorded — cash that was never queued for Square (Square not set up at the time, or
 *                       paid before the app recorded cash in Square)
 *   cash_pending      — cash on its way to Square; `due` says whether it can be sent right now
 *   cash_held         — cash held back for a few minutes after a Square POS handoff
 *   cash_failed       — cash Square refused or that kept failing; a manager retries in Admin → Items
 */
export type NoPaymentReason =
  | "not_paid"
  | "other_reader"
  | "card_unknown"
  | "cash_not_recorded"
  | "cash_pending"
  | "cash_held"
  | "cash_failed";

export type PaymentLookup =
  | { kind: "found"; payment: ResolvedPayment }
  | { kind: "none"; why: NoPaymentReason; due?: boolean };

/** `fetch`: the card payment exists but its id was never stored (a row from before ids were kept). */
type StoredLookup = PaymentLookup | { kind: "fetch"; checkoutId: string; amountCents: number };

interface LookupRow {
  status: SessionStatus;
  settled_method: SettledMethod | null;
  settled_via: SettledVia | null;
  checkout_id: string | null;
  checkout_payment_id: string | null;
  checkout_amount_cents: number | null;
  cash_state: SquareCashState | null;
  cash_want: "recorded" | "refunded" | null;
  cash_amount_cents: number | null;
  cash_payment_id: string | null;
  cash_attempts: number | null;
  cash_due: boolean | null;
}

/**
 * What the database says about a bill's payment. No Square call, so it is safe under the bill's
 * lock. `q` may be a transaction.
 */
export async function lookupStoredPayment(q: Db, sessionId: string): Promise<StoredLookup> {
  // The card request that settled the bill is the one named on its latest `session.paid` audit row.
  // That matters only when two completed for one bill (a flagged double payment), or the bill was
  // reopened and charged again: then it picks the payment the bill is settled by now.
  const [r] = await q<LookupRow[]>`
    select s.status, s.settled_method, s.settled_via,
           co.id as checkout_id, co.square_payment_id as checkout_payment_id, co.amount_cents as checkout_amount_cents,
           sc.state as cash_state, sc.want as cash_want, sc.amount_cents as cash_amount_cents,
           sc.square_payment_id as cash_payment_id, sc.attempts as cash_attempts,
           (sc.next_attempt_at <= now()) as cash_due
    from public.sessions s
    left join lateral (
      select c.id, c.square_payment_id, c.amount_cents
      from public.terminal_checkouts c
      where c.session_id = s.id and c.status = 'COMPLETED'
      order by (c.id = (select a.after->>'checkout_id' from public.audit_log a
                        where a.entity = 'session' and a.entity_id = s.id::text and a.action = 'session.paid'
                        order by a.id desc limit 1)) desc nulls last,
               c.last_synced_at desc nulls last, c.attempt desc
      limit 1
    ) co on true
    left join lateral (
      select c.state, c.want, c.amount_cents, c.square_payment_id, c.attempts, c.next_attempt_at
      from public.square_cash_records c
      where c.session_id = s.id
      order by c.seq desc limit 1
    ) sc on true
    where s.id = ${sessionId}`;
  if (!r || r.status !== "paid") return { kind: "none", why: "not_paid" };

  if (r.settled_method === "card") {
    // Marked paid by hand: the card went through some other reader and the app never saw a payment.
    // A card request for this bill completing afterwards is flagged for a person (payment.conflict)
    // and is deliberately not offered here: nobody has confirmed which payment is the bill's.
    if (r.settled_via === "staff") return { kind: "none", why: "other_reader" };
    if (!r.checkout_id || r.checkout_amount_cents === null) return { kind: "none", why: "card_unknown" };
    if (!r.checkout_payment_id) return { kind: "fetch", checkoutId: r.checkout_id, amountCents: r.checkout_amount_cents };
    return { kind: "found", payment: { paymentId: r.checkout_payment_id, method: "card", amountCents: r.checkout_amount_cents } };
  }

  // Cash. A latest record that wants a refund, or was skipped, belongs to an earlier cash payment
  // of this bill that was reversed; this payment has no record of its own.
  if (!r.cash_state || r.cash_want !== "recorded" || r.cash_state === "skipped" || r.cash_amount_cents === null) {
    return { kind: "none", why: "cash_not_recorded" };
  }
  if (r.cash_state === "recorded") {
    return r.cash_payment_id
      ? { kind: "found", payment: { paymentId: r.cash_payment_id, method: "cash", amountCents: r.cash_amount_cents } }
      : { kind: "none", why: "cash_not_recorded" };
  }
  if (r.cash_state === "failed") return { kind: "none", why: "cash_failed" };
  if (r.cash_state !== "pending") return { kind: "none", why: "cash_not_recorded" };
  // Never tried and not due yet: held back on purpose after a Square POS handoff (pos-cash.ts).
  if (r.cash_attempts === 0 && r.cash_due === false) return { kind: "none", why: "cash_held" };
  return { kind: "none", why: "cash_pending", due: r.cash_due === true };
}

/**
 * The payment that settled this bill, or why there isn't one the app can use.
 *
 * Call it with NO lock held: for a card payment whose id was never stored it asks Square for the
 * checkout and stores the id. Throws the usual `square_error` if Square can't be asked.
 */
export async function findPayment(sessionId: string): Promise<PaymentLookup> {
  const q = db();
  const stored = await lookupStoredPayment(q, sessionId);
  if (stored.kind !== "fetch") return stored;

  // One 8 s try: a member of staff is waiting.
  let checkout: terminal.SquareCheckoutState;
  try {
    checkout = await gateway.get(stored.checkoutId, { underLock: true });
  } catch (e) {
    // Square no longer has the checkout (it keeps them for a limited time). Asking again won't
    // help: this payment has to be dealt with in Square. Anything else is "couldn't ask" and throws.
    if (squareStatus(e) === 404) return { kind: "none", why: "card_unknown" };
    throw e;
  }
  if (checkout.status !== "COMPLETED" || !checkout.paymentId) return { kind: "none", why: "card_unknown" };
  // Only the payment id changes: no status change, so no floor broadcast.
  await q`
    update public.terminal_checkouts set square_payment_id = ${checkout.paymentId}
    where id = ${stored.checkoutId} and square_payment_id is null`;
  const again = await lookupStoredPayment(q, sessionId);
  return again.kind === "fetch" ? { kind: "none", why: "card_unknown" } : again;
}

/** The Square payment that settled this bill, or null when the app can't refund or print it. */
export async function resolvePayment(sessionId: string): Promise<ResolvedPayment | null> {
  const found = await findPayment(sessionId);
  return found.kind === "found" ? found.payment : null;
}

// ---------------------------------------------------------------------------
// The same question for the screens (SessionDTO), many bills at once and without Square
// ---------------------------------------------------------------------------

export type RefundFacts = Pick<SessionDTO, "refundedCents" | "refundable" | "canPrintReceipt">;

/** A bill that isn't paid: nothing refunded, nothing to refund, nothing to print. */
export const NO_REFUND_FACTS: RefundFacts = { refundedCents: 0, refundable: null, canPrintReceipt: false };

interface FactsRow {
  id: string;
  settled_method: SettledMethod | null;
  settled_via: SettledVia | null;
  settled_cents: number | null;
  refunded_cents: number;
  card_completed: boolean;
  cash_state: SquareCashState | null;
  cash_want: "recorded" | "refunded" | null;
  cash_amount_cents: number | null;
  cash_has_payment: boolean | null;
  cash_due: boolean | null;
  terminal_paired: boolean | null;
}

/**
 * `refundedCents`, `refundable` and `canPrintReceipt` for the paid bills among `rows`, by id.
 * Bills that aren't paid are left out (use `NO_REFUND_FACTS`), and when none is paid, which is
 * every floor and Unpaid fetch, this runs no query at all.
 */
export async function loadRefundFacts(
  q: Db,
  rows: readonly { id: string; status: SessionStatus }[],
): Promise<Map<string, RefundFacts>> {
  const out = new Map<string, RefundFacts>();
  const paidIds = rows.filter((r) => r.status === "paid").map((r) => r.id);
  if (paidIds.length === 0) return out;

  const facts = await q<FactsRow[]>`
    select s.id, s.settled_method, s.settled_via, s.settled_cents, s.refunded_cents,
           exists (select 1 from public.terminal_checkouts c
                   where c.session_id = s.id and c.status = 'COMPLETED') as card_completed,
           sc.state as cash_state, sc.want as cash_want, sc.amount_cents as cash_amount_cents,
           (sc.square_payment_id is not null) as cash_has_payment,
           (sc.next_attempt_at <= now()) as cash_due,
           (select terminal_device_id is not null from public.settings where id) as terminal_paired
    from public.sessions s
    left join lateral (
      select c.state, c.want, c.amount_cents, c.square_payment_id, c.next_attempt_at
      from public.square_cash_records c
      where c.session_id = s.id
      order by c.seq desc limit 1
    ) sc on true
    where s.id = any(${paidIds}::uuid[]) and s.status = 'paid'`;

  for (const f of facts) {
    const settled = f.settled_cents ?? 0;
    let method: SettledMethod | null = null;
    let paymentCents = 0;
    // A cash sale that is due to go to Square can't be refunded yet, but its receipt can be asked
    // for: the print request sends the sale first.
    let printableSoon = false;
    if (f.settled_method === "card") {
      // A completed card request whose payment id isn't stored yet still counts: the id is fetched
      // from Square when it is needed.
      if (f.settled_via !== "staff" && f.card_completed) {
        method = "card";
        paymentCents = settled;
      }
    } else if (f.settled_method === "cash" && f.cash_want === "recorded" && f.cash_amount_cents !== null) {
      if (f.cash_state === "recorded" && f.cash_has_payment) {
        method = "cash";
        paymentCents = f.cash_amount_cents;
      } else if (f.cash_state === "pending" && f.cash_due) {
        printableSoon = true;
      }
    }
    const maxCents = Math.min(settled, paymentCents) - f.refunded_cents;
    out.set(f.id, {
      refundedCents: f.refunded_cents,
      refundable: method && maxCents > 0 ? { method, maxCents } : null,
      canPrintReceipt: f.terminal_paired === true && (method !== null || printableSoon),
    });
  }
  return out;
}
