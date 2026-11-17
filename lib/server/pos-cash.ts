import "server-only";
import { cashDueCents } from "@/lib/domain/bill";
import { assertCan, isCheckoutLive } from "@/lib/domain/machine";
import type { MarkPaidOutcome, SettledMethod } from "@/lib/domain/types";
import * as orders from "@/lib/square/orders";
import * as payments from "@/lib/square/payments";
import type { SquarePaymentDetail } from "@/lib/square/payments";
import { parsePosCallback, posCashLink, posErrorMessage } from "@/lib/square/pos";
import { signToken, verifyToken, type Actor } from "./auth";
import { audit } from "./audit";
import { formatTime } from "@/lib/format";
import { db, PG, pgCode, pgConstraint, withTx, type Db } from "./db";
import { posCashConfig, type PosCashConfig } from "./env";
import { AppError, conflict, notFound } from "./errors";
import { getCheckouts, getSettings, lockSession } from "./repo";
import { cancelLiveCheckouts, markPaid, mustLock, repriceBill, sessionNote } from "./sessions";
import { adoptPosPayment, insertPosCashRecord, linkedPayments, PAYMENT_UNIQUE_INDEX } from "./square-cash";
import { squareStatus } from "./square-errors";

/*
 * Cash through the Square POS app.
 *
 * The cash drawer hangs off the Square Stand and only Square POS can open it. So on that iPad a
 * cash bill is handed to Square POS with a link: POS takes the cash, opens the drawer and records
 * the sale itself (an amount and a note, not itemised). The app then has to find out that it
 * happened and mark the bill paid WITHOUT recording a second sale through the outbox.
 *
 * It finds out three ways, all ending in the same `settle`:
 *   1. the callback: POS opens /pos/return (in Safari, with no cookies), which posts here;
 *   2. the check: the app asks, when it comes back to the front, whether Square has the sale;
 *   3. manual "Mark paid – cash" after a handoff runs the check first.
 * Nothing the callback says is trusted beyond the signed `state` we issued. The sale itself is
 * always read back from Square.
 *
 * On any other iPad, and whenever this isn't configured, cash works as before (square-cash.ts).
 */

// ---------------------------------------------------------------------------
// Square gateway (swappable in tests)
// ---------------------------------------------------------------------------

export interface PosGateway {
  getOrder: typeof orders.getOrder;
  getPayment: typeof payments.getPayment;
  listCashPayments: typeof payments.listCashPayments;
}

let gateway: PosGateway = {
  getOrder: orders.getOrder,
  getPayment: payments.getPayment,
  listCashPayments: payments.listCashPayments,
};

export function setPosGatewayForTests(g: PosGateway): void {
  gateway = g;
}

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------

/** How long after a handoff the app keeps looking for its sale, and how long the signed state lasts. */
const HANDOFF_MINUTES = 30;
const STATE_AUDIENCE = "pos-cash";
/**
 * A manual cash payment made soon after a handoff waits this long before going to Square, so a
 * late answer from Square POS can still claim it instead of the sale being recorded twice.
 */
const HOLD_AFTER_HANDOFF_SECONDS = 5 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** Short reference put in the Square note so the sale can be matched back to the bill. */
const refOf = (sessionId: string) => sessionId.slice(0, 8);
const refTag = (sessionId: string) => `ref ${refOf(sessionId)}`;

/** Any bill's reference in a Square note. */
const ANY_REF = /\bref [0-9a-f]{8}\b/i;

const NOT_CONFIGURED = () =>
  new AppError(503, "pos_cash_not_configured", "Cash through Square POS isn't set up. Use Mark paid – cash instead.");

export function posCashAvailable(): boolean {
  return posCashConfig() !== null;
}

/**
 * Builds the link that opens Square POS with this bill's cash amount. Changes nothing on the bill.
 */
export async function startCashHandoff(actor: Actor, id: string): Promise<{ url: string; amountCents: number }> {
  const cfg = posCashConfig();
  if (!cfg) throw NOT_CONFIGURED();
  return withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "mark_paid");
    if ((await getCheckouts(tx, id)).some((c) => isCheckoutLive(c.status))) {
      throw conflict("This bill is already on the Terminal. Cancel it or use Resend.");
    }
    // Same re-pricing a card charge does, so the amount handed over is the bill as it stands.
    const { intervals, r, totalCents } = await repriceBill(tx, s, actor);
    const amountCents = cashDueCents(totalCents);
    if (amountCents <= 0) throw conflict("There's nothing to collect in cash on this bill.");

    const notes = `${await sessionNote(tx, s, intervals, r.billedMinutes)} · ${refTag(s.id)}`;
    const state = await signToken({ sub: s.id, u: actor.staffId, d: actor.deviceLabel, a: amountCents }, HANDOFF_MINUTES * 60, STATE_AUDIENCE);
    const url = posCashLink({
      amountCents,
      callbackUrl: cfg.callbackUrl,
      applicationId: cfg.applicationId,
      locationId: cfg.locationId,
      notes,
      state,
    });
    await audit(tx, {
      actorStaffId: actor.staffId,
      deviceLabel: actor.deviceLabel,
      action: "cash.handoff_started",
      entity: "session",
      entityId: s.id,
      after: { amount_cents: amountCents, total_cents: totalCents, ref: refOf(s.id), notes },
    });
    return { url, amountCents };
  });
}

interface Handoff {
  sessionId: string;
  staffId: string;
  deviceLabel: string;
  amountCents: number;
  startedAt: Date;
}

/** The handoff a signed `state` stands for, or null if it is forged, expired or malformed. */
async function readState(state: string): Promise<Handoff | null> {
  const p = await verifyToken(state, STATE_AUDIENCE);
  if (!p) return null;
  const { sub, u, d, a, iat } = p;
  if (typeof sub !== "string" || !UUID_RE.test(sub) || typeof u !== "string" || !UUID_RE.test(u)) return null;
  if (typeof d !== "string" || typeof a !== "number" || !Number.isInteger(a) || a <= 0 || typeof iat !== "number") return null;
  return { sessionId: sub, staffId: u, deviceLabel: d, amountCents: a, startedAt: new Date(iat * 1000) };
}

/** The most recent handoff of this bill in the last 30 minutes, from the audit trail. */
async function latestHandoff(q: Db, sessionId: string): Promise<{ amountCents: number; startedAt: Date } | null> {
  const [row] = await q<{ at: Date; amount_cents: number | null }[]>`
    select at, (after->>'amount_cents')::int as amount_cents from public.audit_log
    where entity = 'session' and entity_id = ${sessionId} and action = 'cash.handoff_started'
      and at > now() - interval '30 minutes'
    order by id desc limit 1`;
  if (!row || !row.amount_cents || row.amount_cents <= 0) return null;
  return { amountCents: row.amount_cents, startedAt: row.at };
}

// ---------------------------------------------------------------------------
// Finding the sale in Square
// ---------------------------------------------------------------------------

type MatchedBy = "transaction" | "note" | "amount";

/** A cash sale that went through, at our location. */
function isOurCashSale(p: SquarePaymentDetail, cfg: PosCashConfig): boolean {
  return p.sourceType === "CASH" && p.status === "COMPLETED" && p.locationId === cfg.locationId;
}

/**
 * The payment behind the callback's `transaction_id`. Square documents that id only against the
 * retired Transactions API; for current accounts it is the order id, so: read the order and take
 * its cash tender. If Square has no such order, try it as a payment id. null = can't tell.
 */
async function paymentForTransaction(transactionId: string): Promise<SquarePaymentDetail | null> {
  try {
    const order = await gateway.getOrder(transactionId);
    const tender = order.tenders.find((t) => t.type === "CASH" && t.paymentId);
    return tender?.paymentId ? await gateway.getPayment(tender.paymentId) : null;
  } catch (e) {
    if (squareStatus(e) !== 404) throw e;
  }
  try {
    return await gateway.getPayment(transactionId);
  } catch (e) {
    if (squareStatus(e) !== 404) throw e;
    return null;
  }
}

/**
 * Looks through the location's cash payments since the handoff for one that is completed, for
 * exactly the handed-over amount.
 *
 *   - One whose note carries THIS bill's reference wins.
 *   - Otherwise, a sale with no reference at all is accepted if it is the only one. Two or more is
 *     anyone's guess and nothing is picked.
 *   - A sale whose note carries any other reference is never taken: it is some other bill's cash,
 *     whether or not that bill has been settled yet. Same-amount bills are the norm here.
 *
 * A sale already tied to a bill is skipped, with one exception: if the sale carrying this bill's
 * reference has been tied to a DIFFERENT bill, it is returned anyway so `settle` can flag it.
 */
async function findSale(
  cfg: PosCashConfig,
  h: { sessionId: string; amountCents: number; startedAt: Date },
): Promise<{ payment: SquarePaymentDetail; matchedBy: MatchedBy } | null> {
  // A minute of slack for the difference between our clock and Square's.
  const beginTime = new Date(h.startedAt.getTime() - 60_000);
  const list = await gateway.listCashPayments({ locationId: cfg.locationId, beginTime });
  // A sale with a reference id is one the app itself recorded (the outbox sets it); Square POS sets none.
  const exact = list.filter((p) => isOurCashSale(p, cfg) && p.amountCents === h.amountCents && !p.referenceId);
  const linked = await linkedPayments(db(), exact.map((p) => p.id));
  const mine = exact.filter((p) => p.note?.includes(refTag(h.sessionId)));
  const mineFree = mine.find((p) => !linked.has(p.id));
  if (mineFree) return { payment: mineFree, matchedBy: "note" };
  const mineTakenElsewhere = mine.find((p) => linked.get(p.id) !== h.sessionId);
  if (mineTakenElsewhere) return { payment: mineTakenElsewhere, matchedBy: "note" };
  const unmarked = exact.filter((p) => !linked.has(p.id) && !ANY_REF.test(p.note ?? ""));
  if (unmarked.length === 1) return { payment: unmarked[0], matchedBy: "amount" };
  return null;
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

type Settled =
  | { kind: "paid"; message: string }
  /** `otherBill`: the sale is tied to a different bill. Staff need to hear about that one. */
  | { kind: "conflict"; message: string; otherBill?: boolean };

interface SettleInput {
  sessionId: string;
  staffId: string;
  deviceLabel: string;
  /** What was handed to Square POS. */
  amountCents: number;
  payment: SquarePaymentDetail;
  matchedBy: MatchedBy;
  source: "callback" | "check" | "mark_paid";
}

/**
 * Marks the bill paid by a cash sale Square POS made. The caller has already read the payment back
 * from Square and checked it is cash, completed and at our location. Safe to call any number of
 * times for the same payment.
 */
async function settle(input: SettleInput): Promise<Settled> {
  try {
    return await settleOnce(input, false);
  } catch (e) {
    // Two bills reached for the same Square sale at the same moment and the other one got it: the
    // unique index on square_payment_id refused ours and the transaction rolled back. Go round
    // again; this time the sale shows as linked and is flagged, with nothing settled.
    if (pgCode(e) === PG.UNIQUE && pgConstraint(e) === PAYMENT_UNIQUE_INDEX) return settleOnce(input, true);
    throw e;
  }
}

async function settleOnce(input: SettleInput, lostRace: boolean): Promise<Settled> {
  const { payment, amountCents } = input;
  const who = { staffId: input.staffId, deviceLabel: input.deviceLabel };
  return withTx(async (tx) => {
    const s = await lockSession(tx, input.sessionId);
    if (!s) return { kind: "conflict", message: "That bill no longer exists." };

    const [linked] = await tx<{ session_id: string }[]>`
      select session_id from public.square_cash_records where square_payment_id = ${payment.id} limit 1`;
    if (linked && linked.session_id === s.id) {
      return s.status === "paid"
        ? { kind: "paid", message: "This cash sale is already on the bill." }
        : { kind: "conflict", message: "That cash sale was already used for this bill, and the payment has since been reversed." };
    }

    const info = {
      square_payment_id: payment.id,
      square_order_id: payment.orderId,
      square_amount_cents: payment.amountCents,
      handed_off_cents: amountCents,
      matched_by: input.matchedBy,
      source: input.source,
    };
    /** Flags the problem for a person, once per Square payment however often this is replayed. */
    const flag = async (reason: string): Promise<Settled> => {
      const [seen] = await tx<{ id: string }[]>`
        select id::text as id from public.audit_log
        where entity = 'session' and entity_id = ${s.id} and action = 'payment.conflict'
          and after->>'square_payment_id' = ${payment.id}
        limit 1`;
      if (!seen) {
        await audit(tx, {
          actorStaffId: who.staffId,
          deviceLabel: who.deviceLabel,
          action: "payment.conflict",
          entity: "session",
          entityId: s.id,
          after: {
            ...info,
            session_status: s.status,
            settled_method: s.settled_method,
            total_cents: s.total_cents,
            other_session_id: linked && linked.session_id !== s.id ? linked.session_id : undefined,
          },
          reason,
        });
      }
      return { kind: "conflict", message: reason };
    };

    if (linked || lostRace) {
      const out = await flag(
        `The ${dollars(payment.amountCents)} cash sale Square POS took for this bill has been put against a different bill, so this one is still unpaid. A manager needs to find which bill was marked paid by mistake and reverse it.`,
      );
      return { ...out, otherBill: true };
    }

    if (payment.amountCents !== amountCents) {
      return flag(
        `Square POS took ${dollars(payment.amountCents)} in cash for this bill, but ${dollars(amountCents)} was asked for. The bill has not been marked paid. Check the sale in Square.`,
      );
    }

    if (s.status === "awaiting_payment") {
      // Same as a manual settlement: nothing may be left on the Terminal that could take a card.
      const live = await cancelLiveCheckouts(tx, s, who);
      if (live.completed) {
        return flag(
          `${dollars(amountCents)} cash was taken in Square POS, and a card payment for this bill went through on the Terminal as well. Refund one of them in Square.`,
        );
      }
      const billCents = s.total_cents ?? 0;
      const now = new Date();
      await tx`
        update public.sessions set
          status = 'paid', settled_method = 'cash', settled_via = 'square_api', settled_by = ${who.staffId},
          settled_at = ${now}, settled_cents = ${amountCents}, current_table_id = null
        where id = ${s.id}`;
      const seq = await insertPosCashRecord(tx, {
        sessionId: s.id,
        amountCents,
        billCents: Math.max(billCents, 1),
        note: payment.note,
        staffId: who.staffId,
        paymentId: payment.id,
        orderId: payment.orderId,
      });
      await audit(tx, {
        actorStaffId: who.staffId,
        deviceLabel: who.deviceLabel,
        action: "session.paid",
        entity: "session",
        entityId: s.id,
        before: { status: s.status, total_cents: s.total_cents },
        after: {
          ...info,
          status: "paid",
          settled_method: "cash",
          settled_via: "square_api",
          settled_at: now,
          settled_cents: amountCents,
          total_cents: s.total_cents,
          square_cash_seq: seq,
        },
        reason:
          input.matchedBy === "amount"
            ? "Cash taken in Square POS. Matched to this bill by amount and time; the sale carried no reference."
            : "Cash taken in Square POS.",
      });
      if (cashDueCents(billCents) !== amountCents) {
        // The bill changed after it was handed over. The cash is in, so it is settled, but for a
        // different amount: same treatment as a card payment for an older total.
        const due = cashDueCents(billCents);
        await audit(tx, {
          actorStaffId: who.staffId,
          deviceLabel: who.deviceLabel,
          action: "payment.conflict",
          entity: "session",
          entityId: s.id,
          after: { ...info, total_cents: billCents, difference_cents: due - amountCents },
          reason:
            `${dollars(amountCents)} cash was taken in Square POS but the bill is now ${dollars(due)}. ` +
            (amountCents < due ? `Collect the other ${dollars(due - amountCents)} from the customer.` : `Give back ${dollars(amountCents - due)} and refund it in Square.`),
        });
      }
      return { kind: "paid", message: `${dollars(amountCents)} cash recorded.` };
    }

    if (s.status === "paid" && s.settled_method === "cash") {
      // Marked paid by hand while Square POS was taking the same cash. If that sale hasn't been
      // sent to Square yet, it never needs to be: POS already recorded it.
      const seq = await adoptPosPayment(tx, { sessionId: s.id, amountCents, paymentId: payment.id, orderId: payment.orderId });
      if (seq !== null) {
        await audit(tx, {
          actorStaffId: who.staffId,
          deviceLabel: who.deviceLabel,
          action: "square.cash_from_pos",
          entity: "session",
          entityId: s.id,
          after: { ...info, square_cash_seq: seq },
          reason: "This bill was marked paid in cash by hand, and Square POS had taken the sale. The app's own copy was not sent, so Square has it once.",
        });
        return { kind: "paid", message: `${dollars(amountCents)} cash recorded.` };
      }
      return flag(
        `Square POS took ${dollars(amountCents)} in cash for this bill, and the app had already recorded the same cash sale in Square. It may be in Square twice: check, and refund one if so.`,
      );
    }

    if (s.status === "paid") {
      return flag(
        `Square POS took ${dollars(amountCents)} in cash for this bill, but it was already paid by card. Give the cash back and refund the cash sale in Square, or refund the card.`,
      );
    }
    return flag(`Square POS took ${dollars(amountCents)} in cash for this bill, but the bill is ${s.status}. Check the sale in Square and refund it if needed.`);
  });
}

// ---------------------------------------------------------------------------
// 1. The callback from Square POS (public)
// ---------------------------------------------------------------------------

export interface PosReturnResult {
  result: "paid" | "canceled" | "pending" | "error";
  message: string;
}

const GO_BACK = "Go back to the table timer and tap Check on the bill.";

type HandoffRef = { amountCents: number; startedAt: Date };

/** "Cash for this bill was sent to Square POS at 8:01 pm." */
async function unconfirmedLead(h: HandoffRef): Promise<string> {
  const { timezone } = await getSettings(db());
  return `Cash for this bill was sent to Square POS at ${formatTime(h.startedAt, timezone)}.`;
}
/** What a manager should do about a handoff nobody could confirm. */
const checkForTwo = (h: HandoffRef) =>
  `heck Square for two cash sales of ${dollars(h.amountCents)} around then and refund one if so.`;

/** Writes an audit row for this handoff once, however many times the callback is replayed. */
async function auditOnce(h: Handoff, action: string, after: Record<string, unknown>, reason: string): Promise<void> {
  const handoffAt = h.startedAt.toISOString();
  await withTx(async (tx) => {
    const [seen] = await tx<{ id: string }[]>`
      select id::text as id from public.audit_log
      where entity = 'session' and entity_id = ${h.sessionId} and action = ${action}
        and after->>'handoff_at' = ${handoffAt}
      limit 1`;
    if (seen) return;
    await audit(tx, {
      actorStaffId: h.staffId,
      deviceLabel: h.deviceLabel,
      action,
      entity: "session",
      entityId: h.sessionId,
      after: { ...after, handoff_at: handoffAt, amount_cents: h.amountCents },
      reason,
    });
  });
}

/**
 * Handles what Square POS sent back. `raw` is the callback's `data` JSON exactly as it arrived.
 *
 * This is reachable by anyone, so it does no work at all (no database, no Square) until the
 * `state` in it proves to be one we signed in the last 30 minutes. Even then the callback only
 * says where to look: the sale is read from Square before anything is settled.
 */
export async function handlePosReturn(raw: string): Promise<PosReturnResult> {
  const cb = parsePosCallback(raw);
  const h = cb?.state ? await readState(cb.state) : null;
  if (!cb || !h) {
    return { result: "error", message: `This link has run out or isn't from the table timer. ${GO_BACK}` };
  }
  const cfg = posCashConfig();
  if (!cfg) return { result: "error", message: `Cash through Square POS isn't set up. ${GO_BACK}` };

  if (cb.status === "error") {
    const { canceled, message } = posErrorMessage(cb.errorCode);
    await auditOnce(h, "cash.handoff_canceled", { error_code: cb.errorCode }, message);
    return { result: canceled ? "canceled" : "error", message };
  }

  let found: { payment: SquarePaymentDetail; matchedBy: MatchedBy } | null = null;
  try {
    const byId = cb.transactionId ? await paymentForTransaction(cb.transactionId) : null;
    // No id (an offline sale) or one Square doesn't know: look for the sale itself.
    found = byId ? { payment: byId, matchedBy: "transaction" } : await findSale(cfg, h);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    // Square can't be asked right now. The app's own check will settle it.
    return { result: "pending", message: `Square couldn't be reached to confirm the sale. ${GO_BACK}` };
  }

  if (!found) {
    await auditOnce(
      h,
      "cash.handoff_unconfirmed",
      { transaction_id: cb.transactionId, client_transaction_id: cb.clientTransactionId, offline: !cb.transactionId },
      `${await unconfirmedLead(h)} Square POS said it took the cash${cb.transactionId ? "" : " (offline)"}, but Square didn't show the sale. ` +
        `If the bill ends up marked paid by hand, c${checkForTwo(h)}`,
    );
    return { result: "pending", message: `Square hasn't confirmed the sale yet. ${GO_BACK}` };
  }
  if (!isOurCashSale(found.payment, cfg)) {
    await auditOnce(
      h,
      "cash.handoff_unconfirmed",
      { transaction_id: cb.transactionId, square_payment_id: found.payment.id, status: found.payment.status, source_type: found.payment.sourceType },
      "Square POS reported a sale, but in Square it isn't a completed cash sale at this location.",
    );
    return { result: "error", message: "Square doesn't show this as a completed cash sale. Look at the bill in the table timer before taking the cash again." };
  }

  const out = await settle({
    sessionId: h.sessionId,
    staffId: h.staffId,
    deviceLabel: h.deviceLabel,
    amountCents: h.amountCents,
    payment: found.payment,
    matchedBy: found.matchedBy,
    source: "callback",
  });
  return { result: out.kind === "paid" ? "paid" : "error", message: out.message };
}

// ---------------------------------------------------------------------------
// 2. The check, from the app
// ---------------------------------------------------------------------------

/**
 * Asks Square whether the cash sale handed to Square POS went through, and settles the bill if it
 * did. Does nothing unless this bill was handed over in the last 30 minutes and is still unpaid.
 * Square unreachable is a 502.
 */
export async function checkCashHandoff(actor: Pick<Actor, "staffId" | "deviceLabel">, id: string): Promise<{ paid: boolean }> {
  if (!UUID_RE.test(id)) throw notFound("Session not found.");
  const q = db();
  const [s] = await q<{ status: string }[]>`select status from public.sessions where id = ${id}`;
  if (!s) throw notFound("Session not found.");
  if (s.status !== "awaiting_payment") return { paid: s.status === "paid" };
  const cfg = posCashConfig();
  const h = cfg ? await latestHandoff(q, id) : null;
  if (!cfg || !h) return { paid: false };

  const found = await findSale(cfg, { sessionId: id, ...h });
  if (!found) return { paid: false };
  const out = await settle({
    sessionId: id,
    staffId: actor.staffId,
    deviceLabel: actor.deviceLabel,
    amountCents: h.amountCents,
    payment: found.payment,
    matchedBy: found.matchedBy,
    source: "check",
  });
  // The one answer that must not be swallowed as "not paid yet": the cash is in Square, against
  // the wrong bill. It is on Needs attention too.
  if (out.kind === "conflict" && out.otherBill) throw conflict(out.message);
  return { paid: out.kind === "paid" };
}

// ---------------------------------------------------------------------------
// 3. Manual "Mark paid" after a handoff
// ---------------------------------------------------------------------------

/**
 * `markPaid`, with one thing first for cash: if this bill was handed to Square POS in the last 30
 * minutes, ask Square whether POS took the sale. If it did, the bill is settled from that sale and
 * nothing else is recorded. If it didn't (or Square can't say), the bill is marked paid as usual,
 * but its sale is held back from Square for five minutes so a late answer from POS can still claim it.
 *
 * Square being unreachable never stops staff marking a bill paid.
 */
export async function markPaidCheckingPos(
  actor: Actor,
  id: string,
  method: SettledMethod,
  opts: { cardConfirmed: boolean },
  now = new Date(),
): Promise<MarkPaidOutcome & { warnings: string[] }> {
  const cfg = method === "cash" && UUID_RE.test(id) ? posCashConfig() : null;
  const h = cfg ? await latestHandoff(db(), id) : null;
  if (!cfg || !h) return markPaid(actor, id, method, opts, now);

  try {
    const found = await findSale(cfg, { sessionId: id, ...h });
    if (found) {
      const out = await settle({
        sessionId: id,
        staffId: actor.staffId,
        deviceLabel: actor.deviceLabel,
        amountCents: h.amountCents,
        payment: found.payment,
        matchedBy: found.matchedBy,
        source: "mark_paid",
      });
      if (out.kind === "paid") {
        return { kind: "paid", method: "cash", via: "square_api", amountCents: h.amountCents, warnings: [] };
      }
    }
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== "square_error") throw e;
    await audit(db(), {
      actorStaffId: actor.staffId,
      deviceLabel: actor.deviceLabel,
      action: "cash.handoff_check_skipped",
      entity: "session",
      entityId: id,
      after: { amount_cents: h.amountCents, handoff_at: h.startedAt },
      reason:
        `${await unconfirmedLead(h)} It was then marked paid by hand, and Square couldn't be reached to see whether POS had taken the cash. ` +
        `C${checkForTwo(h)}`,
    });
    return markPaid(actor, id, method, { ...opts, holdSquareCashSeconds: HOLD_AFTER_HANDOFF_SECONDS }, now);
  }

  const out = await markPaid(actor, id, method, { ...opts, holdSquareCashSeconds: HOLD_AFTER_HANDOFF_SECONDS }, now);
  if (out.kind === "paid" && out.via === "staff") {
    // Square showed no sale, so the app will record its own in five minutes. If POS did take the
    // cash (offline, or Square's list was behind), that makes two, and nothing looks again once
    // the bill is paid. Put it in front of a manager now. One row per handoff.
    await auditOnce(
      { sessionId: id, staffId: actor.staffId, deviceLabel: actor.deviceLabel, ...h },
      "cash.handoff_unconfirmed",
      { marked_paid_by_hand: true },
      `${await unconfirmedLead(h)} It was never confirmed, and the bill was then marked paid by hand. C${checkForTwo(h)}`,
    );
  }
  return out;
}
