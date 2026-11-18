import "server-only";
import type postgres from "postgres";
import { assertCan, type SessionStatus } from "@/lib/domain/machine";
import type { RefundDTO, SettledMethod, SummaryDTO } from "@/lib/domain/types";
import type { Actor, Manager } from "./auth";
import { audit } from "./audit";
import { db, PG, pgCode, pgConstraint, withTx, type Db } from "./db";
import { squareEnv, squareLooksConfigured } from "./env";
import { AppError, badRequest, conflict, notFound } from "./errors";
import { findPayment, lookupStoredPayment, paymentsGateway, type NoPaymentReason, type PaymentLookup } from "./payment-ref";
import { lockSession } from "./repo";
import { isKeyReused, isSquareRejection, squareStatus } from "./square-errors";

/*
 * Refunds: real money leaving the owner's account, so the rules are strict.
 *
 * A manager's refund writes one `refunds` row and takes its amount off what the bill can still be
 * refunded (`sessions.refunded_cents`), in one transaction under the bill's lock. Only then is
 * Square called, with no lock held, under an idempotency key fixed by the row
 * (`${sessionId}-rf${seq}`) that never changes. Three things can come back:
 *
 *   - Square says yes  → `completed`, or still `pending` while Square finishes it (a card refund is
 *                        PENDING for a few seconds); a background pass reads it until it is final.
 *   - Square says no   → `failed`, and the amount goes back on what can be refunded. Only a definite
 *                        no does that: a 4xx refusal of the FIRST try, or a refund Square reports
 *                        FAILED / REJECTED. (A refusal of a re-send proves nothing about the first try.)
 *   - Square says nothing (timeout, 5xx, rate limit, a token problem) → the refund MAY have
 *                        happened. It stays `pending`, still counted as refunded, and is sent again
 *                        in the background with the same key, so it can only ever happen once.
 *
 * If Square never answers (12 tries), refuses a re-send, or says the key is on file against a
 * different request, the app stops and leaves the row `pending` for a person to check in Square.
 * It never guesses "no".
 *
 * A refund request carries a request id made by the screen. The same id never makes a second
 * refund: a repeat (a retry after a lost answer) is answered with the refund the first one made.
 *
 * `refunds` and `audit_log` have no floor-broadcast trigger, so the background pass can run after
 * every floor fetch. It touches `sessions` only when a refund really failed.
 */

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface RefundRow {
  id: string;
  session_id: string;
  /** nth refund of this bill; part of the idempotency key. */
  seq: number;
  square_payment_id: string;
  method: SettledMethod;
  amount_cents: number;
  reason: string;
  state: "pending" | "completed" | "failed";
  /** Set once Square has answered with a refund. From then on the row is only read back, never re-sent. */
  square_refund_id: string | null;
  square_status: string | null;
  /** Calls made to Square for this row, counted when a worker takes it. */
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

const columns = (q: Db) => q`
  r.id, r.session_id, r.seq, r.square_payment_id, r.method, r.amount_cents, r.reason, r.state,
  r.square_refund_id, r.square_status, r.attempts, r.last_error, r.created_at`;

/** The app stops sending a refund Square has never answered after this many tries. */
export const MAX_SEND_ATTEMPTS = 12;
const SYSTEM_LABEL = "Square refund";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** Square's wording doesn't always end in a full stop; ours always does. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** Fixed for the life of the row. 39 characters plus the digits of `seq`; Square allows 45. */
export const refundKey = (r: Pick<RefundRow, "session_id" | "seq">) => `${r.session_id}-rf${r.seq}`;

interface Who {
  actorStaffId: string | null;
  approvedByStaffId?: string | null;
  deviceLabel: string;
}
const SYSTEM: Who = { actorStaffId: null, deviceLabel: SYSTEM_LABEL };

// ---------------------------------------------------------------------------
// Asking Square
// ---------------------------------------------------------------------------

type Outcome =
  | { kind: "completed"; refundId: string; status: string }
  /** Square has the refund and hasn't finished it. */
  | { kind: "processing"; refundId: string; status: string }
  /** A definite no: nothing was refunded. */
  | { kind: "refused"; message: string; refundId: string | null; status: string | null; square: unknown }
  /** Square holds a different request under this row's key. */
  | { kind: "key_reused"; square: unknown }
  /** No verdict. `reading`: the refund exists in Square and only the look at it failed. */
  | { kind: "unanswered"; reading: boolean; message: string; square: unknown };

/**
 * Square refused this particular request. A 401 or 403 is about the access token, not the refund,
 * so it is retried like an outage rather than treated as a verdict.
 */
function isRefusal(e: unknown): e is AppError {
  if (!isSquareRejection(e)) return false;
  const status = squareStatus(e);
  return status !== 401 && status !== 403;
}

function squareCodes(e: AppError): string[] {
  const codes = e.detail?.codes;
  return Array.isArray(codes) ? codes.filter((c): c is string => typeof c === "string") : [];
}

/** Why Square said no, for staff. Square's own wording unless we know a plainer one. */
function refusalMessage(e: AppError): string {
  const codes = squareCodes(e);
  if (codes.includes("REFUND_AMOUNT_INVALID")) {
    return "Square says that is more than is left to refund on this payment. Look at the payment in Square.";
  }
  // Two refunds of one payment in quick succession: Square takes them one at a time.
  if (codes.includes("REFUND_ALREADY_PENDING")) {
    return "Square is still finishing an earlier refund of this payment. Wait a few seconds and try again.";
  }
  return sentence(e.message.replace("couldn't record the refund", "didn't accept the refund"));
}

/**
 * Sends the refund, or reads it back if Square already has it. Never throws: every way this can go
 * is an `Outcome`. The request body is built only from the row, so it is the same on every try.
 */
async function askSquare(row: RefundRow): Promise<Outcome> {
  const gateway = paymentsGateway();
  const reading = row.square_refund_id !== null;
  try {
    const r = row.square_refund_id
      ? await gateway.getRefund(row.square_refund_id)
      : await gateway.refundPayment({
          idempotencyKey: refundKey(row),
          paymentId: row.square_payment_id,
          amountCents: row.amount_cents,
          reason: row.reason,
        });
    if (r.status === "COMPLETED") return { kind: "completed", refundId: r.id, status: r.status };
    if (r.status === "REJECTED" || r.status === "FAILED") {
      return {
        kind: "refused",
        message: `Square didn't make the refund (it came back ${r.status.toLowerCase()}).`,
        refundId: r.id,
        status: r.status,
        square: null,
      };
    }
    return { kind: "processing", refundId: r.id, status: r.status };
  } catch (e) {
    const square = e instanceof AppError ? e.detail ?? null : null;
    // An error while READING a refund says nothing about the refund itself, whatever the status.
    if (!reading && isKeyReused(e)) return { kind: "key_reused", square };
    if (!reading && isRefusal(e)) return { kind: "refused", message: refusalMessage(e), refundId: null, status: null, square };
    if (!(e instanceof AppError)) {
      console.warn("[square] refund call failed unexpectedly", row.id, e instanceof Error ? e.message : e);
    }
    return {
      kind: "unanswered",
      reading,
      message: e instanceof AppError ? sentence(e.message) : "Something went wrong while sending this refund to Square.",
      square,
    };
  }
}

// ---------------------------------------------------------------------------
// Recording what Square said
// ---------------------------------------------------------------------------

const auditInfo = (row: RefundRow) => ({
  refund_id: row.id,
  seq: row.seq,
  method: row.method,
  amount_cents: row.amount_cents,
  square_payment_id: row.square_payment_id,
  attempts: row.attempts,
});

/**
 * When to look at a refund Square is still processing: soon at first, then less and less often.
 * The wait is the refund's age (4 s at least, 15 minutes at most), so it needs no counter and never
 * gives up: a refund Square holds as PENDING is a real refund.
 */
const nextLookSql = (q: Db) => q`now() + least(greatest(now() - created_at, interval '4 seconds'), interval '15 minutes')`;

/** Square said no. The amount goes back on what the bill can be refunded, under the bill's lock. */
async function fail(row: RefundRow, o: Extract<Outcome, { kind: "refused" }>, who: Who): Promise<void> {
  await withTx(async (tx) => {
    // The bill first, then the refund: the same order the refund route takes them in.
    await lockSession(tx, row.session_id);
    const [done] = await tx<{ id: string }[]>`
      update public.refunds set
        state = 'failed', claimed_at = null, last_error = ${o.message},
        square_refund_id = coalesce(${o.refundId}, square_refund_id),
        square_status = coalesce(${o.status}, square_status)
      where id = ${row.id} and state = 'pending'
      returning id`;
    // Already settled by another worker: the amount must come back exactly once.
    if (!done) return;
    const [s] = await tx<{ refunded_cents: number }[]>`
      update public.sessions set refunded_cents = greatest(refunded_cents - ${row.amount_cents}, 0)
      where id = ${row.session_id}
      returning refunded_cents`;
    await audit(tx, {
      ...who,
      action: "refund.failed",
      entity: "session",
      entityId: row.session_id,
      after: { ...auditInfo(row), square_refund_id: o.refundId, square_status: o.status, refunded_cents: s?.refunded_cents, square: o.square },
      reason: `The ${dollars(row.amount_cents)} ${row.method} refund didn't go through. ${o.message} Nothing was refunded.`,
    });
  });
}

/**
 * Nobody knows whether this refund happened, and asking again won't tell us. The row stays
 * `pending` and counted as refunded (the safe side), is never sent again, and goes in front of a
 * manager.
 *
 * What takes it out of the queue is a `next_attempt_at` a hundred years off: an ordinary timestamp
 * the due check never reaches. (Not 'infinity': postgres.js reads that back as an Invalid Date.)
 */
async function stop(row: RefundRow, message: string, square: unknown): Promise<void> {
  await withTx(async (tx) => {
    const [done] = await tx<{ id: string }[]>`
      update public.refunds set claimed_at = null, last_error = ${message}, next_attempt_at = now() + interval '100 years'
      where id = ${row.id} and state = 'pending' and next_attempt_at < now() + interval '50 years'
      returning id`;
    if (!done) return;
    await audit(tx, {
      ...SYSTEM,
      action: "refund.unconfirmed",
      entity: "session",
      entityId: row.session_id,
      after: { ...auditInfo(row), idempotency_key: refundKey(row), square },
      reason: message,
    });
  });
}

/** A refund the app has stopped trying: `pending`, with no further try scheduled. Over alias `r`. */
const parkedSql = (q: Db) => q`r.state = 'pending' and r.next_attempt_at > now() + interval '50 years'`;

const checkInSquare = (row: RefundRow) =>
  `Look at the payment in Square: if the ${dollars(row.amount_cents)} refund isn't there, make it in Square. The app counts it as refunded either way.`;

/** Writes the outcome of one call to Square. Every write is guarded by `state = 'pending'`. */
async function settle(row: RefundRow, o: Outcome, who: Who): Promise<void> {
  const q = db();
  switch (o.kind) {
    case "completed":
      await withTx(async (tx) => {
        const [done] = await tx<{ id: string }[]>`
          update public.refunds set
            state = 'completed', square_refund_id = ${o.refundId}, square_status = ${o.status},
            last_error = null, claimed_at = null
          where id = ${row.id} and state = 'pending'
          returning id`;
        if (!done) return;
        await audit(tx, {
          ...who,
          action: "refund.completed",
          entity: "session",
          entityId: row.session_id,
          after: { ...auditInfo(row), square_refund_id: o.refundId, square_status: o.status },
        });
      });
      return;

    case "processing":
      await q`
        update public.refunds set
          square_refund_id = ${o.refundId}, square_status = ${o.status}, last_error = null, claimed_at = null,
          next_attempt_at = ${nextLookSql(q)}
        where id = ${row.id} and state = 'pending'`;
      return;

    case "refused":
      // A refusal is a verdict only on a request Square has never seen before. If an earlier try
      // got no answer, Square may have made the refund then, and this "no" may be about the repeat:
      // the first request still in flight, or a key Square no longer recognises, so that it sees a
      // second refund of money already refunded. Failing the row there would hand the amount back
      // while Square holds the refund. So: not the first try, and no refund id from Square → a
      // person checks. A refund Square itself reports FAILED / REJECTED carries its id and is
      // always a no.
      if (o.refundId === null && row.attempts > 1) {
        await stop(
          row,
          `Square didn't answer when this refund was first sent, and refused it when the app asked again, so the first try may have gone through. ${checkInSquare(row)}`,
          { refusal: o.message, square: o.square },
        );
        return;
      }
      await fail(row, o, who);
      return;

    case "key_reused":
      // Whatever Square holds under this key isn't this refund, and a new key could refund twice.
      await stop(
        row,
        `Square already has a different refund on file under this one's reference, so the app has stopped. ${checkInSquare(row)}`,
        o.square,
      );
      return;

    case "unanswered":
      if (o.reading) {
        // Square has the refund; only the look at it failed. Look again later.
        await q`
          update public.refunds set claimed_at = null, next_attempt_at = ${nextLookSql(q)}
          where id = ${row.id} and state = 'pending'`;
        return;
      }
      if (row.attempts >= MAX_SEND_ATTEMPTS) {
        await stop(
          row,
          `Square never answered about this refund (${row.attempts} tries), so the app has stopped trying. It may or may not have gone through. ${checkInSquare(row)}`,
          o.square,
        );
        return;
      }
      {
        // 30 s, doubling with each try, capped at 15 minutes: the cash outbox's schedule.
        const waitSeconds = Math.min(15 * 2 ** row.attempts, 900);
        await q`
          update public.refunds set
            claimed_at = null, last_error = ${o.message},
            next_attempt_at = now() + ${waitSeconds}::int * interval '1 second'
          where id = ${row.id} and state = 'pending'`;
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// The manager's refund
// ---------------------------------------------------------------------------

function requireReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 3) throw badRequest("A reason is required.");
  if (r.length > 500) throw badRequest("Keep the reason under 500 characters.");
  return r;
}

/** Why this bill's payment can't be refunded from the app, for the manager. */
function cantRefund(why: NoPaymentReason): AppError {
  switch (why) {
    case "other_reader":
      return conflict("This card payment wasn't taken on the Terminal, so it can't be refunded from here. Refund it in Square.");
    case "card_unknown":
      return conflict("The app can't find this card payment in Square, so it can't be refunded from here. Refund it in Square.");
    case "cash_pending":
    case "cash_held":
      return conflict("This cash sale isn't in Square yet, so it can't be refunded from here yet. Try again in a few minutes.");
    case "cash_failed":
      return conflict(
        "This cash sale didn't go into Square, so it can't be refunded from here. A manager can send it again in Admin → Items, then refund it.",
      );
    case "cash_not_recorded":
      return conflict("This cash payment was never recorded in Square, so it can't be refunded from here.");
    case "not_paid":
      return conflict("Only a paid bill can be refunded.");
  }
}

const OVER_REFUND_CONSTRAINT = "sessions_refund_within_paid";
/** The unique index that keeps one refund per request id. */
const REQUEST_UNIQUE_INDEX = "refunds_request_uniq";

/**
 * The database's own refusal to refund more than was paid, as a 409 staff can read. The check under
 * the bill's lock comes first; this is what is left if that check is ever wrong.
 */
export function overRefundError(e: unknown): AppError | null {
  return pgCode(e) === PG.CHECK && pgConstraint(e) === OVER_REFUND_CONSTRAINT
    ? conflict("That's more than is left to refund on this bill.")
    : null;
}

/**
 * The refund an earlier request with this request id made, if there is one. The screen sends the
 * same id again when it retries after a lost answer, and must get that refund back rather than a
 * second one. An id that was used for a different bill or a different amount is not a retry of
 * anything: 409, and nothing is written.
 */
async function refundForRequest(q: Db, requestId: string, sessionId: string, amountCents: number): Promise<RefundWithSession | null> {
  const [existing] = await loadRefunds(q, q`r.request_id = ${requestId}`);
  if (!existing) return null;
  if (existing.sessionId !== sessionId || existing.amountCents !== amountCents) {
    throw conflict("This refund request was already used for a different refund, so nothing was refunded. Close this and start the refund again.");
  }
  return existing;
}

/** What the refund route answers for a refund as it stands. A failed one is thrown, as a 4xx on purpose. */
function answer(stands: RefundWithSession, note: string | null = null): { refund: RefundDTO } {
  const { sessionId: _sessionId, ...refund } = stands;
  void _sessionId;
  if (refund.state === "failed") {
    // The screens read any 5xx as "it may have gone through". This one certainly didn't.
    throw new AppError(409, "refund_failed", `${sentence(refund.error ?? "Square didn't accept the refund.")} Nothing was refunded.`, {
      refund,
    });
  }
  return { refund: note && refund.state === "pending" && !refund.error ? { ...refund, error: note } : refund };
}

/**
 * Refunds part or all of a paid bill through Square: back to the card, or (cash) recorded in Square
 * while staff hand the money back. The manager's PIN has been checked by the caller.
 *
 * Answers once Square has given its first answer: the refund `completed`, or `pending` (Square is
 * still processing it, or didn't answer and the refund will be sent again with the same key).
 * Throws 409 `refund_failed` when Square refused it: nothing was refunded.
 *
 * `requestId` (a UUID from the screen, one per refund the manager means to make) makes the request
 * repeatable: a second call with the same id, bill and amount makes nothing new and answers with
 * the first one's refund as it stands. Without one (an older screen) every call is a new refund.
 */
export async function refundSession(
  actor: Actor,
  manager: Manager,
  id: string,
  reasonIn: string,
  amountCents: number,
  requestId: string | null = null,
): Promise<{ refund: RefundDTO }> {
  const reason = requireReason(reasonIn);
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw badRequest("Enter the amount to refund.");
  if (requestId !== null && !UUID_RE.test(requestId)) throw badRequest("Invalid request id.");
  if (!UUID_RE.test(id)) throw notFound("Session not found.");
  const [before] = await db()<{ status: SessionStatus; settled_cents: number | null }[]>`
    select status, settled_cents from public.sessions where id = ${id}`;
  if (!before) throw notFound("Session not found.");
  // A repeat of a request that already made its refund: answer with that refund, whatever has
  // happened to the bill since. Checked again under the lock for a first request still in flight.
  if (requestId) {
    const made = await refundForRequest(db(), requestId, id, amountCents);
    if (made) return answer(made);
  }
  assertCan(before.status, "refund");
  // A bill discounted to nothing is "paid" with no payment behind it.
  if (before.settled_cents === 0) throw conflict("Nothing was collected on this bill, so there is nothing to refund.");
  squareEnv(); // 503 with a staff-readable message before anything is written

  // 1. Which payment. Done with no lock held: for a card payment from before payment ids were
  //    stored, this asks Square for it.
  let found: PaymentLookup;
  try {
    found = await findPayment(id);
  } catch (e) {
    if (e instanceof AppError && e.code === "square_error") {
      throw conflict("The app couldn't look this card payment up in Square just now, so nothing was refunded. Try again in a moment.");
    }
    throw e;
  }
  if (found.kind !== "found") throw cantRefund(found.why);

  // 2. The row and the amount, together, under the bill's lock. From this commit on the refund
  //    exists: whatever happens next, it is finished off with this row's key.
  const who: Who = { actorStaffId: actor.staffId, approvedByStaffId: manager.id, deviceLabel: actor.deviceLabel };
  let row: RefundRow;
  try {
    const made = await withTx<RefundRow | RefundWithSession>(async (tx) => {
      const s = await lockSession(tx, id);
      if (!s) throw notFound("Session not found.");
      // The same request again, now that an earlier one on this bill can no longer be mid-flight.
      // Before every other check: the first request has already used up what it asked for.
      if (requestId) {
        const earlier = await refundForRequest(tx, requestId, id, amountCents);
        if (earlier) return earlier;
      }
      assertCan(s.status, "refund");
      // Read again now that nothing can change underneath: the bill may have been reopened and
      // paid a different way since step 1.
      const stored = await lookupStoredPayment(tx, id);
      if (stored.kind === "fetch") {
        throw conflict("This bill's payment changed while the refund was being set up, so nothing was refunded. Try again.");
      }
      if (stored.kind !== "found") throw cantRefund(stored.why);
      const payment = stored.payment;
      const [money] = await tx<{ settled_cents: number | null; refunded_cents: number }[]>`
        select settled_cents, refunded_cents from public.sessions where id = ${id}`;
      const refunded = money?.refunded_cents ?? 0;
      const left = Math.min(money?.settled_cents ?? 0, payment.amountCents) - refunded;
      if (left <= 0) throw conflict("This bill has already been refunded in full.");
      if (amountCents > left) {
        throw conflict(`That's more than is left to refund on this bill. The most is ${dollars(left)}.`);
      }
      if (payment.method === "cash" && amountCents % 5 !== 0) {
        throw conflict("Cash is handed back in 5c steps. Enter an amount that ends in 0 or 5 cents.");
      }

      // The route makes the first call itself, so the row starts out claimed (attempts = 1): the
      // background pass leaves it alone for a minute, and takes over if this request dies.
      const [inserted] = await tx<RefundRow[]>`
        insert into public.refunds as r
          (session_id, seq, square_payment_id, method, amount_cents, reason, attempts, claimed_at, request_id,
           created_by, approved_by)
        values (
          ${id},
          (select coalesce(max(seq), 0) + 1 from public.refunds where session_id = ${id}),
          ${payment.paymentId}, ${payment.method}, ${amountCents}, ${reason}, 1, now(), ${requestId},
          ${actor.staffId}, ${manager.id}
        )
        returning ${columns(tx)}`;
      await tx`update public.sessions set refunded_cents = refunded_cents + ${amountCents} where id = ${id}`;
      await audit(tx, {
        ...who,
        action: "refund.requested",
        entity: "session",
        entityId: id,
        before: { refunded_cents: refunded },
        after: {
          ...auditInfo(inserted),
          idempotency_key: refundKey(inserted),
          settled_cents: money?.settled_cents ?? null,
          refunded_cents: refunded + amountCents,
        },
        reason,
      });
      return inserted;
    });
    // A repeat: nothing was written and nothing is sent. The first request's refund is the answer.
    if ("sessionId" in made) return answer(made);
    row = made;
  } catch (e) {
    // The same request id reached two bills at the same moment (each under its own lock) and the
    // other one's row got there first: the unique index refused ours and nothing of ours was
    // written. Answer exactly as if we had seen that row to begin with.
    if (requestId && pgCode(e) === PG.UNIQUE && pgConstraint(e) === REQUEST_UNIQUE_INDEX) {
      const earlier = await refundForRequest(db(), requestId, id, amountCents);
      if (earlier) return answer(earlier);
    }
    throw overRefundError(e) ?? e;
  }

  // 3. Square, with no lock held. One 8 s try; the background pass does any retrying.
  const outcome = await askSquare(row);
  let unsaved = false;
  try {
    await settle(row, outcome, who);
  } catch (e) {
    // Square answered and the answer couldn't be written. The row is still pending and claimed;
    // the background pass asks again with the same key in a minute and gets the same answer.
    unsaved = true;
    console.error("[square] refund outcome not saved; it will be asked for again", row.id, e instanceof Error ? e.message : e);
  }

  const [stands] = await loadRefunds(db(), db()`r.id = ${row.id}`);
  if (!stands) throw new Error(`refund ${row.id} vanished`);
  return answer(stands, unsaved ? "The app couldn't save Square's answer just now. It will check again shortly." : null);
}

// ---------------------------------------------------------------------------
// The background pass
// ---------------------------------------------------------------------------

// A refund a worker is talking to Square about is left alone for 60 s, in case that worker died
// mid-call. After that anyone may pick it up; the idempotency key makes the second try harmless.
const dueSql = (q: Db) => q`
  state = 'pending' and next_attempt_at <= now()
  and (claimed_at is null or claimed_at < now() - interval '60 seconds')`;

/** Claims the most overdue refund, or returns null. One statement, safe against other workers. */
async function claimNext(): Promise<RefundRow | null> {
  const q = db();
  const [row] = await q<RefundRow[]>`
    update public.refunds as r set claimed_at = now(), attempts = r.attempts + 1
    where r.id in (
      select id from public.refunds
      where ${dueSql(q)}
      order by next_attempt_at, created_at
      limit 1
      for update skip locked
    )
    returning ${columns(q)}`;
  return row ?? null;
}

/**
 * Finishes off refunds Square hasn't confirmed: sends the ones it never answered (same key) and
 * reads back the ones it is still processing. Up to `limit` refunds, one at a time, and no new one
 * is started once `budgetMs` has passed. Returns how many were worked on.
 *
 * Starts with a read-only check, so the usual case (nothing due) writes nothing at all.
 */
export async function pushRefunds(opts: { limit?: number; budgetMs?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 5;
  const budgetMs = opts.budgetMs ?? 10_000;
  const q = db();
  const [due] = await q<{ due: boolean }[]>`
    select exists (select 1 from public.refunds where ${dueSql(q)}) as due`;
  if (!due?.due) return 0;

  squareEnv();
  const started = Date.now();
  let worked = 0;
  while (worked < limit && Date.now() - started < budgetMs) {
    const row = await claimNext();
    if (!row) break;
    try {
      await settle(row, await askSquare(row), SYSTEM);
    } catch (e) {
      // The database refused to take the outcome. The claim lapses after a minute and the refund is
      // asked about again with the same key.
      console.warn("[square] refund left claimed", row.id, e instanceof Error ? e.message : e);
    }
    worked++;
  }
  return worked;
}

/** For `after()`: can never throw, and does nothing when Square isn't configured. */
export async function refundsInBackground(): Promise<void> {
  try {
    if (!squareLooksConfigured()) return;
    await pushRefunds();
  } catch (e) {
    console.warn("[square] refund pass skipped", e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Reading refunds for the screens
// ---------------------------------------------------------------------------

interface RefundJoinRow extends RefundRow {
  by_name: string;
  approved_by_name: string;
}

function refundDTO(r: RefundJoinRow): RefundDTO {
  return {
    id: r.id,
    amountCents: r.amount_cents,
    method: r.method,
    reason: r.reason,
    state: r.state,
    // Once Square has done it, an earlier "didn't answer in time" is history.
    error: r.state === "completed" ? null : r.last_error,
    createdAt: r.created_at.toISOString(),
    byName: r.by_name,
    approvedByName: r.approved_by_name,
  };
}

type RefundWithSession = RefundDTO & { sessionId: string };

/** Refunds matching `where` (a fragment over alias `r`), oldest first. */
async function loadRefunds(q: Db, where: postgres.Fragment): Promise<RefundWithSession[]> {
  const rows = await q<RefundJoinRow[]>`
    select ${columns(q)}, cb.name as by_name, ab.name as approved_by_name
    from public.refunds r
    join public.staff cb on cb.id = r.created_by
    join public.staff ab on ab.id = r.approved_by
    where ${where}
    order by r.created_at, r.seq, r.id`;
  return rows.map((r) => ({ ...refundDTO(r), sessionId: r.session_id }));
}

/** Every refund asked for on a bill, oldest first, including failed ones (SessionDetailDTO.refunds). */
export async function listRefunds(q: Db, sessionId: string): Promise<RefundDTO[]> {
  const rows = await loadRefunds(q, q`r.session_id = ${sessionId}`);
  return rows.map(({ sessionId: _sessionId, ...refund }) => {
    void _sessionId;
    return refund;
  });
}

type LabelOf = (sessionIds: string[]) => Promise<Map<string, string>>;

/**
 * SummaryDTO.refundsOutstanding: every refund, whatever day it was asked for, that the app has
 * stopped trying and nobody has dealt with yet. Shown on every day's summary until it is gone, so a
 * refund parked after closing is still in front of the next shift.
 */
export async function outstandingRefunds(q: Db, labelOf: LabelOf): Promise<SummaryDTO["refundsOutstanding"]> {
  const rows = await loadRefunds(q, parkedSql(q));
  const labels = rows.length > 0 ? await labelOf([...new Set(rows.map((r) => r.sessionId))]) : new Map<string, string>();
  return {
    count: rows.length,
    cents: rows.reduce((a, r) => a + r.amountCents, 0),
    items: rows.map((r) => ({ ...r, label: labels.get(r.sessionId) ?? "" })),
  };
}

/**
 * SummaryDTO.refunds: refunds asked for in the window that have not failed (pending + completed).
 * `labelOf` gives each bill's label (SessionDTO.label).
 */
export async function summaryRefunds(
  q: Db,
  from: Date,
  to: Date,
  labelOf: LabelOf,
): Promise<SummaryDTO["refunds"]> {
  const rows = await loadRefunds(q, q`r.created_at >= ${from} and r.created_at < ${to} and r.state <> 'failed'`);
  const labels = rows.length > 0 ? await labelOf([...new Set(rows.map((r) => r.sessionId))]) : new Map<string, string>();
  const sum = (method: SettledMethod) => rows.reduce((a, r) => (r.method === method ? a + r.amountCents : a), 0);
  const cardCents = sum("card");
  const cashCents = sum("cash");
  return {
    count: rows.length,
    cents: cardCents + cashCents,
    cardCents,
    cashCents,
    items: rows.map((r) => ({ ...r, label: labels.get(r.sessionId) ?? "" })),
  };
}
