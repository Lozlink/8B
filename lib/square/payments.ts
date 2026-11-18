import "server-only";
import { upstream } from "@/lib/server/errors";
import { square, toUpstreamError } from "./client";

// These calls are made by the cash outbox (lib/server/square-cash.ts) and by manager refunds
// (lib/server/refunds.ts), outside any database lock. The caller does the retrying, with the same
// idempotency key, so the SDK must not: a short timeout and no SDK retry keep one slow call from
// eating the whole background pass (or the manager's patience).
const REQUEST_OPTIONS = { timeoutInSeconds: 8, maxRetries: 0 } as const;
const ON_TIMEOUT = "It will be tried again shortly.";

export interface CreateCashPaymentInput {
  /** `${sessionId}-cp${seq}` with an order, `${sessionId}-cq${seq}` without. ≤ 45 chars (Square's limit). */
  idempotencyKey: string;
  /** Cash collected. Must be a multiple of 5c: Square refuses anything else for AUD cash. */
  amountCents: number;
  locationId: string;
  /** Session id (≤ 40 chars). */
  referenceId: string;
  /** Shown on the payment in Square, ≤ 500 chars. */
  note: string | null;
  /**
   * The order this cash pays. The order may be for the unrounded bill: Square adds its own
   * rounding adjustment and completes the order.
   */
  orderId?: string;
}

export interface SquarePaymentState {
  id: string;
  /** COMPLETED for cash; anything else means the sale was not recorded. */
  status: string;
  amountCents: number;
  orderId: string | null;
}

/**
 * Records a cash sale in Square (`source_id: "CASH"`). Nothing is charged; it's bookkeeping, so
 * the sale shows in the Square dashboard. It does not open a cash drawer.
 */
export async function createCashPayment(input: CreateCashPaymentInput): Promise<SquarePaymentState> {
  const what = "record the cash payment";
  try {
    const money = { amount: BigInt(input.amountCents), currency: "AUD" as const };
    const res = await square().payments.create(
      {
        sourceId: "CASH",
        idempotencyKey: input.idempotencyKey,
        amountMoney: money,
        // The till works out the change; Square only needs to know the sale amount was covered.
        cashDetails: { buyerSuppliedMoney: money },
        locationId: input.locationId,
        referenceId: input.referenceId,
        ...(input.note ? { note: input.note.slice(0, 500) } : {}),
        ...(input.orderId ? { orderId: input.orderId } : {}),
      },
      REQUEST_OPTIONS,
    );
    const p = res.payment;
    if (!p?.id || !p.status) {
      throw upstream(`Square returned an unexpected response while trying to ${what}.`);
    }
    return {
      id: p.id,
      status: p.status,
      // Amounts come back as bigint; convert before anything tries to JSON.stringify them.
      amountCents: p.amountMoney?.amount != null ? Number(p.amountMoney.amount) : 0,
      orderId: p.orderId ?? null,
    };
  } catch (e) {
    throw toUpstreamError(e, what, ON_TIMEOUT);
  }
}

export interface RefundPaymentInput {
  /**
   * `${sessionId}-cr${seq}` when a reversed cash sale is taken back out of Square,
   * `${sessionId}-rf${seq}` for a manager's refund. ≤ 45 chars (Square's limit).
   */
  idempotencyKey: string;
  paymentId: string;
  amountCents: number;
  /** Shown on the refund in Square, ≤ 192 chars. */
  reason: string;
}

export interface SquareRefundState {
  id: string;
  /** PENDING at first, then COMPLETED. REJECTED or FAILED means there is no refund. */
  status: string;
}

/**
 * Refunds part or all of a payment. For a card the money goes back to the card. For cash it is
 * bookkeeping: no money moves, staff hand it back.
 */
export async function refundPayment(input: RefundPaymentInput): Promise<SquareRefundState> {
  const what = "record the refund";
  try {
    const res = await square().refunds.refundPayment(
      {
        idempotencyKey: input.idempotencyKey,
        paymentId: input.paymentId,
        amountMoney: { amount: BigInt(input.amountCents), currency: "AUD" },
        reason: input.reason.slice(0, 192),
      },
      REQUEST_OPTIONS,
    );
    const r = res.refund;
    if (!r?.id) {
      throw upstream(`Square returned an unexpected response while trying to ${what}.`);
    }
    return { id: r.id, status: r.status ?? "PENDING" };
  } catch (e) {
    throw toUpstreamError(e, what, ON_TIMEOUT);
  }
}

/**
 * Reads a refund back. A card refund is PENDING when it is made and COMPLETED a few seconds later;
 * this is how the app finds out (lib/server/refunds.ts). Background work, no lock held: one 8 s try.
 */
export async function getRefund(refundId: string): Promise<SquareRefundState> {
  const what = "check the refund";
  try {
    const res = await square().refunds.get({ refundId }, REQUEST_OPTIONS);
    const r = res.refund;
    if (!r?.id) {
      throw upstream(`Square returned an unexpected response while trying to ${what}.`);
    }
    return { id: r.id, status: r.status ?? "PENDING" };
  } catch (e) {
    throw toUpstreamError(e, what, "It will be checked again shortly.");
  }
}

// ---------------------------------------------------------------------------
// Reading payments (cash taken in the Square POS app; see lib/server/pos-cash.ts)
// ---------------------------------------------------------------------------

export interface SquarePaymentDetail {
  id: string;
  status: string;
  /** "CASH", "CARD", … */
  sourceType: string | null;
  amountCents: number;
  locationId: string | null;
  orderId: string | null;
  note: string | null;
  /** Set on sales the app records itself (the session id). Square POS leaves it empty. */
  referenceId: string | null;
  createdAt: string | null;
}

interface SdkPayment {
  id?: string;
  status?: string;
  sourceType?: string;
  amountMoney?: { amount?: bigint | null } | null;
  locationId?: string;
  orderId?: string;
  note?: string;
  referenceId?: string;
  createdAt?: string;
}

function toDetail(p: SdkPayment | undefined, what: string): SquarePaymentDetail {
  if (!p?.id || !p.status || p.amountMoney?.amount == null) {
    throw upstream(`Square returned an unexpected response while trying to ${what}.`);
  }
  return {
    id: p.id,
    status: p.status,
    sourceType: p.sourceType ?? null,
    amountCents: Number(p.amountMoney.amount),
    locationId: p.locationId ?? null,
    orderId: p.orderId ?? null,
    note: p.note ?? null,
    referenceId: p.referenceId ?? null,
    createdAt: p.createdAt ?? null,
  };
}

// Reads are made outside any lock, but a member of staff is watching a spinner: one 8 s try.
const READ_OPTIONS = { timeoutInSeconds: 8, maxRetries: 0 } as const;
const ON_READ_TIMEOUT = "Try again in a moment.";

export async function getPayment(paymentId: string): Promise<SquarePaymentDetail> {
  const what = "look up the cash sale";
  try {
    const res = await square().payments.get({ paymentId }, READ_OPTIONS);
    return toDetail(res.payment, what);
  } catch (e) {
    throw toUpstreamError(e, what, ON_READ_TIMEOUT);
  }
}

/** Cash payments at a location since `beginTime`, newest first. Looks at 200 payments at most. */
export async function listCashPayments(input: { locationId: string; beginTime: Date }): Promise<SquarePaymentDetail[]> {
  const what = "look for the cash sale";
  try {
    const page = await square().payments.list(
      { locationId: input.locationId, beginTime: input.beginTime.toISOString(), sortOrder: "DESC", limit: 100 },
      READ_OPTIONS,
    );
    const out: SquarePaymentDetail[] = [];
    let seen = 0;
    for await (const p of page) {
      if (++seen > 200) break;
      if (p.sourceType === "CASH" && p.id && p.status && p.amountMoney?.amount != null) out.push(toDetail(p, what));
    }
    return out;
  } catch (e) {
    throw toUpstreamError(e, what, ON_READ_TIMEOUT);
  }
}
