import "server-only";
import { assertCan, isCheckoutLive, isCheckoutStatus, type CheckoutStatus } from "@/lib/domain/machine";
import { cashDueCents } from "@/lib/domain/bill";
import type { MarkPaidOutcome, SettledMethod } from "@/lib/domain/types";
import { formatDuration, makeSnapshot, price, type PriceResult, type PricingInterval } from "@/lib/pricing";
import { formatTime } from "@/lib/format";
import * as orders from "@/lib/square/orders";
import type { OrderLineInput } from "@/lib/square/orders";
import * as terminal from "@/lib/square/terminal";
import type { SquareCheckoutState } from "@/lib/square/terminal";
import type { Actor, Manager } from "./auth";
import { audit } from "./audit";
import { db, withTx, type Db, type Tx } from "./db";
import { squareEnv } from "./env";
import { enqueueCashRecord, markCashReversed } from "./square-cash";
import { isKeyReused, isSquareRejection, squareStatus } from "./square-errors";
import { badRequest, conflict, notFound, AppError } from "./errors";
import {
  auditView,
  getCatalogState,
  getCheckouts,
  getIntervals,
  getLiveItems,
  getPricingConfig,
  getSettings,
  lockSession,
  pricingSettingsOf,
  tableNames,
  type CheckoutRow,
  type IntervalRow,
  type SessionItemRow,
  type SessionRow,
  type Settings,
} from "./repo";

// ---------------------------------------------------------------------------
// Square Terminal gateway (swappable in tests)
// ---------------------------------------------------------------------------

export interface TerminalGateway {
  create: typeof terminal.createTerminalCheckout;
  get: typeof terminal.getTerminalCheckout;
  cancel: typeof terminal.cancelTerminalCheckout;
  /** Orders API: the itemised order a checkout is charged against. */
  createOrder: typeof orders.createOrder;
}

let gateway: TerminalGateway = {
  create: terminal.createTerminalCheckout,
  get: terminal.getTerminalCheckout,
  cancel: terminal.cancelTerminalCheckout,
  createOrder: orders.createOrder,
};

export function setTerminalGatewayForTests(g: TerminalGateway): void {
  gateway = g;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const by = (a: Pick<Actor, "staffId" | "deviceLabel">) => ({ actorStaffId: a.staffId, deviceLabel: a.deviceLabel });

export async function mustLock(tx: Tx, id: string): Promise<SessionRow> {
  if (!UUID_RE.test(id)) throw notFound("Session not found.");
  const s = await lockSession(tx, id);
  if (!s) throw notFound("Session not found.");
  return s;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const toPricing = (i: IntervalRow): PricingInterval => ({ startedAt: i.started_at, endedAt: i.ended_at });

async function closeOpenInterval(tx: Tx, sessionId: string, at: Date): Promise<IntervalRow | null> {
  const [row] = await tx<IntervalRow[]>`
    update public.session_intervals
    set ended_at = greatest(started_at, ${at})
    where session_id = ${sessionId} and ended_at is null
    returning id, session_id, table_id, started_at, ended_at`;
  return row ?? null;
}

async function lockFreeTable(tx: Tx, tableId: string): Promise<{ id: string; name: string }> {
  if (!UUID_RE.test(tableId)) throw notFound("Table not found.");
  const [t] = await tx<{ id: string; name: string; active: boolean }[]>`
    select id, name, active from public.tables where id = ${tableId} for update`;
  if (!t) throw notFound("Table not found.");
  if (!t.active) throw conflict(`${t.name} is out of service.`);
  const [busy] = await tx<{ id: string }[]>`select id from public.sessions where current_table_id = ${tableId}`;
  if (busy) throw conflict(`${t.name} already has a session.`);
  return { id: t.id, name: t.name };
}

/**
 * Re-prices a closed session's TABLE TIME from the rates captured at stop, so the bill can't drift.
 * The whole bill is this plus `s.items_cents`.
 */
function repriceClosed(s: SessionRow, intervals: IntervalRow[]): PriceResult {
  if (!s.rate_snapshot) throw new Error(`session ${s.id} has no rate snapshot`);
  return price({
    intervals: intervals.map(toPricing),
    rateCards: s.rate_snapshot.rateCards,
    settings: s.rate_snapshot.settings,
    now: s.closed_at ?? new Date(),
  });
}

// ---------------------------------------------------------------------------
// Start / pause / resume / transfer / stop / release
// ---------------------------------------------------------------------------

export async function startSession(actor: Actor, tableId: string, now = new Date()): Promise<{ sessionId: string }> {
  return withTx(async (tx) => {
    const table = await lockFreeTable(tx, tableId);
    const [s] = await tx<SessionRow[]>`
      insert into public.sessions (status, current_table_id, opened_at, opened_by)
      values ('running', ${table.id}, ${now}, ${actor.staffId})
      returning *`;
    await tx`
      insert into public.session_intervals (session_id, table_id, started_at)
      values (${s.id}, ${table.id}, ${now})`;
    await audit(tx, {
      ...by(actor),
      action: "session.start",
      entity: "session",
      entityId: s.id,
      after: { ...auditView(s), table: table.name },
    });
    return { sessionId: s.id };
  });
}

export async function pauseSession(actor: Actor, id: string, now = new Date()): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "pause");
    const closed = await closeOpenInterval(tx, id, now);
    await tx`update public.sessions set status = 'paused' where id = ${id}`;
    await audit(tx, {
      ...by(actor),
      action: "session.pause",
      entity: "session",
      entityId: id,
      before: { status: s.status },
      after: { status: "paused", interval_ended_at: closed?.ended_at ?? null },
    });
  });
}

export async function resumeSession(actor: Actor, id: string, now = new Date()): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "resume");
    if (!s.current_table_id) throw conflict("This session has no table.");
    await tx`
      insert into public.session_intervals (session_id, table_id, started_at)
      values (${id}, ${s.current_table_id}, ${now})`;
    await tx`update public.sessions set status = 'running' where id = ${id}`;
    await audit(tx, {
      ...by(actor),
      action: "session.resume",
      entity: "session",
      entityId: id,
      before: { status: s.status },
      after: { status: "running", interval_started_at: now },
    });
  });
}

export async function transferSession(actor: Actor, id: string, toTableId: string, now = new Date()): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "transfer");
    if (s.current_table_id === toTableId) throw badRequest("That's the table it's already on.");
    const to = await lockFreeTable(tx, toTableId);
    const names = await tableNames(tx, s.current_table_id ? [s.current_table_id] : []);

    if (s.status === "running") {
      await closeOpenInterval(tx, id, now);
      await tx`
        insert into public.session_intervals (session_id, table_id, started_at)
        values (${id}, ${to.id}, ${now})`;
    }
    await tx`update public.sessions set current_table_id = ${to.id} where id = ${id}`;
    await audit(tx, {
      ...by(actor),
      action: "session.transfer",
      entity: "session",
      entityId: id,
      before: { table_id: s.current_table_id, table: s.current_table_id ? names.get(s.current_table_id) : null },
      after: { table_id: to.id, table: to.name, at: now },
    });
  });
}

export interface StopResult {
  status: "awaiting_payment" | "void";
  billedMinutes: number;
  totalCents: number;
}

export async function stopSession(actor: Actor, id: string, now = new Date()): Promise<StopResult> {
  return withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "stop");
    await closeOpenInterval(tx, id, now);
    const intervals = await getIntervals(tx, id);
    const { settings, rateCards } = await getPricingConfig(tx);
    const ps = pricingSettingsOf(settings);
    const result = price({ intervals: intervals.map(toPricing), rateCards, settings: ps, now });
    const snapshot = JSON.stringify(makeSnapshot(rateCards, ps, now));
    // The bill is table time plus whatever was put on it. billed_minutes stays table time only.
    const totalCents = result.totalCents + s.items_cents;

    if (totalCents === 0) {
      // Nothing to charge (zero time or inside the grace period, and no items). Close it as a
      // no-charge void so the record, the times and the reason all stay visible in the daily summary.
      const reason = "No charge — stopped within the grace period";
      await tx`
        update public.sessions set
          status = 'void', current_table_id = null, closed_at = ${now}, closed_by = ${actor.staffId},
          billed_minutes = 0, total_cents = 0, rate_snapshot = ${snapshot}::text::jsonb,
          voided_at = ${now}, voided_by = ${actor.staffId}, void_reason = ${reason}
        where id = ${id}`;
      await audit(tx, {
        ...by(actor),
        action: "session.stop_no_charge",
        entity: "session",
        entityId: id,
        before: auditView(s),
        after: { status: "void", actual_ms: result.actualMs, total_cents: 0 },
        reason,
      });
      return { status: "void", billedMinutes: 0, totalCents: 0 };
    }

    await tx`
      update public.sessions set
        status = 'awaiting_payment', closed_at = ${now}, closed_by = ${actor.staffId},
        billed_minutes = ${result.billedMinutes}, total_cents = ${totalCents},
        rate_snapshot = ${snapshot}::text::jsonb
      where id = ${id}`;
    await audit(tx, {
      ...by(actor),
      action: "session.stop",
      entity: "session",
      entityId: id,
      before: auditView(s),
      after: {
        status: "awaiting_payment",
        actual_ms: result.actualMs,
        billed_minutes: result.billedMinutes,
        table_cents: result.totalCents,
        items_cents: s.items_cents,
        total_cents: totalCents,
        lines: result.lines,
      },
    });
    return { status: "awaiting_payment", billedMinutes: result.billedMinutes, totalCents };
  });
}

/** Frees the table; the bill stays awaiting payment on the unpaid list. */
export async function releaseTable(actor: Actor, id: string): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "release_table");
    if (!s.current_table_id) return; // already on the unpaid list
    await tx`update public.sessions set current_table_id = null where id = ${id}`;
    await audit(tx, {
      ...by(actor),
      action: "session.move_to_unpaid",
      entity: "session",
      entityId: id,
      before: { current_table_id: s.current_table_id },
      after: { current_table_id: null, total_cents: s.total_cents },
    });
  });
}

// ---------------------------------------------------------------------------
// Square checkout state
// ---------------------------------------------------------------------------

const RANK: Record<CheckoutStatus, number> = {
  PENDING: 0,
  IN_PROGRESS: 1,
  CANCEL_REQUESTED: 2,
  CANCELED: 3,
  COMPLETED: 4,
};

type Source = "square_webhook" | "square_api";

/**
 * Applies Square's view of a checkout. Status only moves forward (webhooks can arrive out of
 * order), except that CANCELED may still become COMPLETED (Square: TIMED_OUT isn't final).
 * Returns true if this call is what recorded the checkout as COMPLETED.
 *
 * Writes nothing when Square's view is what we already hold. Every write to this table used to
 * wake every iPad, and the common answer by far is "still pending". The background sync does its
 * own stamping of `last_synced_at` when it claims a checkout, so nothing here needs to.
 */
async function applyCheckoutState(
  tx: Tx,
  s: SessionRow,
  row: CheckoutRow,
  state: Pick<SquareCheckoutState, "status" | "cancelReason">,
  source: Source,
  actor: Pick<Actor, "staffId" | "deviceLabel"> | null,
  /** Why, when the status didn't come straight from Square. Goes on the audit row. */
  note: string | null = null,
): Promise<boolean> {
  const next = RANK[state.status] > RANK[row.status] ? state.status : row.status;
  const cancelReason = next === "CANCELED" ? state.cancelReason ?? row.cancel_reason : row.cancel_reason;
  if (next === row.status) {
    if (cancelReason !== row.cancel_reason) {
      await tx`update public.terminal_checkouts set cancel_reason = ${cancelReason} where id = ${row.id}`;
    }
    return false;
  }
  await tx`
    update public.terminal_checkouts
    set status = ${next}, cancel_reason = ${cancelReason}, last_synced_at = now()
    where id = ${row.id}`;

  const base = {
    actorStaffId: actor?.staffId ?? null,
    deviceLabel: actor?.deviceLabel ?? (source === "square_webhook" ? "Square webhook" : "Square check"),
    entity: "session",
    entityId: s.id,
  };
  const checkoutInfo = { checkout_id: row.id, attempt: row.attempt, amount_cents: row.amount_cents };

  if (next !== "COMPLETED") {
    await audit(tx, {
      ...base,
      action: next === "CANCELED" ? "checkout.canceled" : "checkout.status",
      before: { status: row.status },
      after: { ...checkoutInfo, status: next, cancel_reason: cancelReason },
      reason: note,
    });
    return false;
  }

  if (s.status === "awaiting_payment") {
    const now = new Date();
    await tx`
      update public.sessions set
        status = 'paid', settled_method = 'card', settled_via = ${source}, settled_by = null,
        settled_at = ${now}, settled_cents = ${row.amount_cents}, current_table_id = null
      where id = ${s.id}`;
    await audit(tx, {
      ...base,
      action: "session.paid",
      before: auditView(s),
      after: {
        ...checkoutInfo,
        status: "paid",
        settled_method: "card",
        settled_via: source,
        settled_at: now,
        settled_cents: row.amount_cents,
      },
    });
    if (row.amount_cents !== s.total_cents) {
      // The money was taken, so the bill is settled — but for a different amount. This is an older
      // card request (one the app never recorded, or one that completed after being cancelled)
      // being paid after the bill changed. Flag it so someone squares up the difference.
      const billCents = s.total_cents ?? 0;
      await audit(tx, {
        ...base,
        action: "payment.conflict",
        after: {
          ...checkoutInfo,
          total_cents: s.total_cents,
          difference_cents: billCents - row.amount_cents,
        },
        reason:
          `The card payment was for ${dollars(row.amount_cents)} but the bill is ${dollars(billCents)}. ` +
          (row.amount_cents < billCents
            ? `Collect the other ${dollars(billCents - row.amount_cents)} from the customer.`
            : `Refund ${dollars(row.amount_cents - billCents)} in Square.`),
      });
    }
    return true;
  }

  if (s.status === "paid") {
    const [c] = await tx<{ n: number }[]>`
      select count(*)::int as n from public.terminal_checkouts
      where session_id = ${s.id} and status = 'COMPLETED'`;
    const completedCount = c?.n ?? 0;
    // A staff settlement only succeeds when Square did NOT report this checkout as completed at that
    // moment (markPaid cancels first and takes the "already paid" path otherwise). So a COMPLETED
    // arriving afterwards may be a second payment — always flag it for a human to check.
    // Cash taken through Square POS is also settled "by Square", but a card completing after it is
    // a second payment, never a confirmation.
    const settledBySquare =
      s.settled_method === "card" && (s.settled_via === "square_webhook" || s.settled_via === "square_api");
    if (settledBySquare && completedCount <= 1) {
      await audit(tx, { ...base, action: "payment.confirmed_by_square", after: { ...checkoutInfo, settled_via: s.settled_via } });
    } else {
      await audit(tx, {
        ...base,
        action: "payment.conflict",
        after: {
          ...checkoutInfo,
          settled_method: s.settled_method,
          settled_via: s.settled_via,
          completed_checkouts: completedCount,
        },
        reason:
          s.settled_method === "cash"
            ? "A card payment completed on the Terminal after this session was paid in cash. Check for a double payment and refund one in Square."
            : s.settled_via === "staff"
              ? "Square reported a card payment completing on the Terminal after staff marked this bill paid by card. If the card was taken on the Terminal it's the same payment and nothing needs doing; if it was taken another way (e.g. the Stand reader), the customer paid twice — refund one in Square."
              : "More than one card payment completed for this session. Refund the duplicate in Square.",
      });
    }
    return true;
  }

  await audit(tx, {
    ...base,
    action: "payment.conflict",
    after: { ...checkoutInfo, session_status: s.status },
    reason: `A card payment completed on the Terminal but the session is ${s.status}. Check Square and refund if needed.`,
  });
  return true;
}

export interface LiveResolution {
  /** A live checkout turned out to be COMPLETED — the session is now paid by card. */
  completed: boolean;
  /** Still waiting on the Terminal to confirm a cancel. */
  cancelPending: boolean;
  warnings: string[];
}

const NOT_FOUND_REASON = "Not found in Square";
const NOT_FOUND_NOTE =
  "Square has no record of this card request, more than 10 minutes after it was sent, so it can't take a payment. Treated as cancelled.";

/**
 * Square answered 404 NOT_FOUND for this checkout: it doesn't exist there. Only that exact answer
 * counts. A timeout, a 5xx or a 401/403 says nothing about the checkout and must never cancel it.
 */
function isCheckoutNotFound(e: unknown): boolean {
  if (squareStatus(e) !== 404 || !(e instanceof AppError)) return false;
  const codes = e.detail?.codes;
  return Array.isArray(codes) && codes.includes("NOT_FOUND");
}

/**
 * Sent more than 10 minutes ago, by the database's clock. A checkout expires after 5, so one this
 * old that Square can't find will never complete. A younger one is left alone: Square may simply
 * not have caught up with a request it answered slowly.
 */
async function isOldCheckout(tx: Tx, checkoutId: string): Promise<boolean> {
  const [r] = await tx<{ old: boolean }[]>`
    select created_at < now() - interval '10 minutes' as old from public.terminal_checkouts where id = ${checkoutId}`;
  return r?.old === true;
}

/** Cancels every live checkout for the session, reconciling with what Square says happened. */
export async function cancelLiveCheckouts(tx: Tx, s: SessionRow, actor: Pick<Actor, "staffId" | "deviceLabel">): Promise<LiveResolution> {
  const res: LiveResolution = { completed: false, cancelPending: false, warnings: [] };
  const live = (await getCheckouts(tx, s.id)).filter((c) => isCheckoutLive(c.status));
  for (const c of live) {
    let state: SquareCheckoutState;
    try {
      state = await gateway.cancel(c.id);
    } catch (e) {
      if (isCheckoutNotFound(e) && (await isOldCheckout(tx, c.id))) {
        // Nothing to cancel: Square doesn't have it. Close it here so the bill isn't stuck behind it.
        await applyCheckoutState(tx, s, c, { status: "CANCELED", cancelReason: NOT_FOUND_REASON }, "square_api", actor, NOT_FOUND_NOTE);
        continue;
      }
      const msg = e instanceof AppError ? e.message : "Couldn't reach Square.";
      res.warnings.push(`${msg} Cancel the request on the Terminal by hand.`);
      await audit(tx, {
        ...by(actor),
        action: "checkout.cancel_failed",
        entity: "session",
        entityId: s.id,
        after: { checkout_id: c.id, attempt: c.attempt },
        reason: msg,
      });
      continue;
    }
    await audit(tx, {
      ...by(actor),
      action: "checkout.cancel_requested",
      entity: "session",
      entityId: s.id,
      after: { checkout_id: c.id, attempt: c.attempt, square_status: state.status },
    });
    const completedNow = await applyCheckoutState(tx, s, c, state, "square_api", actor);
    if (completedNow || state.status === "COMPLETED") res.completed = true;
    if (state.status === "CANCEL_REQUESTED") res.cancelPending = true;
  }
  return res;
}

export function buildNote(tables: string[], billedMinutes: number, openedAt: Date, closedAt: Date | null, tz: string): string {
  const times = `${formatTime(openedAt, tz)}–${closedAt ? formatTime(closedAt, tz) : "now"}`;
  return [tables.join(" → "), formatDuration(billedMinutes * 60_000), times].join(" · ");
}

/** The note Square shows against a bill: the tables it was on, the time billed and the clock times. */
export async function sessionNote(tx: Tx, s: SessionRow, intervals: IntervalRow[], billedMinutes: number): Promise<string> {
  const names = await tableNames(tx, [...new Set(intervals.map((i) => i.table_id))]);
  return buildNote(
    intervals.map((i) => names.get(i.table_id) ?? "Table").filter((n, idx, arr) => arr.indexOf(n) === idx),
    billedMinutes,
    s.opened_at,
    s.closed_at,
    s.rate_snapshot?.settings.timezone ?? "Australia/Sydney",
  );
}

type KeyConflict = { kind: "key_conflict" };

const KEY_CONFLICT_MESSAGE =
  "Square already has a card request for this bill that the app didn't record. Check the Terminal and cancel anything waiting there, then charge again.";

/** The lines of the Square order for a bill: table time first, then each item as it sits on the bill. */
export function orderLines(tableCents: number, tableHireVariationId: string | null, note: string, items: SessionItemRow[]): OrderLineInput[] {
  const lines: OrderLineInput[] = [];
  if (tableCents > 0) {
    lines.push({
      uid: "table",
      // Without a "Table hire" item in Square the line is ad hoc: still charged and taxed, just
      // not reported against a catalogue item.
      catalogObjectId: tableHireVariationId,
      name: tableHireVariationId ? null : "Table hire",
      quantity: 1,
      basePriceCents: tableCents,
      note,
    });
  }
  for (const i of items) {
    // The price copied onto the bill is what's charged, whatever the catalogue says today.
    lines.push({ uid: i.id, catalogObjectId: i.product_id, name: null, quantity: i.quantity, basePriceCents: i.unit_cents, note: null });
  }
  return lines;
}

/**
 * Re-prices a closed bill from its stored rates and writes the result if it moved, so the amount
 * about to be asked for is the bill as it stands. Caller holds the lock.
 */
export async function repriceBill(
  tx: Tx,
  s: SessionRow,
  actor: Pick<Actor, "staffId" | "deviceLabel">,
): Promise<{ intervals: IntervalRow[]; r: PriceResult; totalCents: number }> {
  const intervals = await getIntervals(tx, s.id);
  const r = repriceClosed(s, intervals);
  const totalCents = r.totalCents + s.items_cents;
  if (totalCents !== s.total_cents || r.billedMinutes !== s.billed_minutes) {
    await tx`
      update public.sessions set total_cents = ${totalCents}, billed_minutes = ${r.billedMinutes}
      where id = ${s.id}`;
    await audit(tx, {
      ...by(actor),
      action: "session.repriced",
      entity: "session",
      entityId: s.id,
      before: { total_cents: s.total_cents, billed_minutes: s.billed_minutes },
      after: { total_cents: totalCents, items_cents: s.items_cents, billed_minutes: r.billedMinutes },
    });
  }
  return { intervals, r, totalCents };
}

/**
 * Prices, sends a new checkout attempt to the Terminal and records it. Caller holds the lock.
 *
 * Returns `key_conflict` (rather than throwing) when Square says an idempotency key was already used
 * for a different request: nothing else is sent, the attempt number is skipped so the next try uses
 * fresh keys, and the caller must let the transaction COMMIT before telling staff.
 */
async function sendAttempt(tx: Tx, s: SessionRow, actor: Actor, settings: Settings): Promise<SquareCheckoutState | KeyConflict> {
  const deviceId = settings.terminalDeviceId;
  if (!deviceId) throw conflict("No Terminal is paired.");
  const { intervals, r, totalCents } = await repriceBill(tx, s, actor);
  if (totalCents <= 0) throw conflict("There's nothing to charge on this bill.");

  const attempt = s.checkout_attempt + 1;
  const note = await sessionNote(tx, s, intervals, r.billedMinutes);
  const request = { amountCents: totalCents, deviceId, referenceId: s.id, note };

  // The Square calls happen while we hold the row lock. If one fails, the transaction rolls back and
  // the attempt number isn't consumed, so a retry reuses the same idempotency keys and Square
  // returns the order / checkout it may already have created instead of making a second one.
  // The checkout key says which kind of request it was (`i` itemised, none plain, `p` plain after a
  // refused itemised try), so switching itemising on or off between a timed-out charge and its retry
  // can never present Square with a different body under a key it has seen.
  let co: SquareCheckoutState | null = null;
  let orderId: string | null = null;
  let itemiseFailed = false;
  let stage: "order" | "checkout" | "plain" = "order";

  const keyConflict = async (): Promise<KeyConflict> => {
    await tx`update public.sessions set checkout_attempt = ${attempt} where id = ${s.id}`;
    await audit(tx, {
      ...by(actor),
      action: "checkout.key_conflict",
      entity: "session",
      entityId: s.id,
      after: { attempt, stage, amount_cents: totalCents },
      reason:
        "Square had already seen a different card request under this attempt's key (an earlier try it answered too slowly, most likely). Nothing was sent; the next charge uses a new attempt number.",
    });
    return { kind: "key_conflict" };
  };

  if (settings.itemiseCharges) {
    let createdOrderId: string | null = null;
    try {
      const { table_hire_variation_id: tableHireVariationId } = await getCatalogState(tx);
      const order = await gateway.createOrder({
        idempotencyKey: `${s.id}-o${attempt}`,
        locationId: squareEnv().SQUARE_LOCATION_ID,
        referenceId: s.id,
        lines: orderLines(r.totalCents, tableHireVariationId, note, await getLiveItems(tx, s.id)),
      });
      createdOrderId = order.id;
      if (order.totalCents !== totalCents) {
        // Square would charge a different amount from the bill (a tax or price rule we don't
        // know about). Charge nothing rather than the wrong amount.
        throw conflict(
          "Square's total for this bill doesn't match ours, so nothing was charged. A manager can turn off itemised charges in Admin → Items, or take the card in Square POS and mark it paid.",
          { square_total_cents: order.totalCents, total_cents: totalCents, order_id: order.id },
        );
      }
      stage = "checkout";
      co = await gateway.create({ ...request, idempotencyKey: `${s.id}-a${attempt}i`, orderId: order.id });
      orderId = order.id;
    } catch (e) {
      if (isKeyReused(e)) return keyConflict();
      if (!isSquareRejection(e)) throw e;
      // Itemising must never stop a payment: Square refused the itemised version, so send the
      // same total as a plain amount instead.
      itemiseFailed = true;
      await audit(tx, {
        ...by(actor),
        action: "checkout.itemise_failed",
        entity: "session",
        entityId: s.id,
        after: { attempt, stage, order_id: createdOrderId, amount_cents: totalCents, square: e.detail ?? null },
        reason: e.message,
      });
    }
  }

  if (!co) {
    stage = "plain";
    try {
      co = await gateway.create({ ...request, idempotencyKey: itemiseFailed ? `${s.id}-a${attempt}p` : `${s.id}-a${attempt}` });
    } catch (e) {
      if (isKeyReused(e)) return keyConflict();
      throw e;
    }
  }

  const [row] = await tx<CheckoutRow[]>`
    insert into public.terminal_checkouts (id, session_id, attempt, amount_cents, status, created_by, square_order_id)
    values (${co.id}, ${s.id}, ${attempt}, ${totalCents}, 'PENDING', ${actor.staffId}, ${orderId})
    returning *`;
  await tx`
    update public.sessions set square_checkout_id = ${co.id}, checkout_attempt = ${attempt}
    where id = ${s.id}`;
  await audit(tx, {
    ...by(actor),
    action: "checkout.sent",
    entity: "session",
    entityId: s.id,
    after: { checkout_id: co.id, attempt, amount_cents: totalCents, note, order_id: orderId },
  });
  if (co.status !== "PENDING") {
    // Idempotent replay of a checkout that already moved on.
    await applyCheckoutState(tx, { ...s, total_cents: totalCents }, row, co, "square_api", actor);
  }
  return co;
}

export type ChargeOutcome =
  | { kind: "sent"; checkoutId: string; amountCents: number }
  | { kind: "already_paid_by_card" };

type Refused = { kind: "refused"; message: string };

export async function chargeCard(actor: Actor, id: string): Promise<ChargeOutcome> {
  const result = await withTx<ChargeOutcome | Refused>(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "charge_card");
    const settings = await getSettings(tx);
    if (!settings.terminalDeviceId) {
      throw conflict("No Terminal is paired. A manager can pair one in Admin → Terminal, or take the card in Square POS and mark it paid.");
    }
    const checkouts = await getCheckouts(tx, id);
    if (checkouts.some((c) => isCheckoutLive(c.status))) {
      throw conflict("This bill is already on the Terminal. Cancel it or use Resend.");
    }
    const co = await sendAttempt(tx, s, actor, settings);
    // Return (not throw) so the skipped attempt number and its audit row commit.
    if ("kind" in co) return { kind: "refused", message: KEY_CONFLICT_MESSAGE };
    if (co.status === "COMPLETED") return { kind: "already_paid_by_card" };
    return { kind: "sent", checkoutId: co.id, amountCents: co.amountCents };
  });
  if (result.kind === "refused") throw conflict(result.message);
  return result;
}


export async function resendCheckout(actor: Actor, id: string): Promise<ChargeOutcome> {
  const result = await withTx<ChargeOutcome | Refused>(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "resend_checkout");
    const settings = await getSettings(tx);
    if (!settings.terminalDeviceId) throw conflict("No Terminal is paired.");
    const r = await cancelLiveCheckouts(tx, s, actor);
    if (r.completed) return { kind: "already_paid_by_card" };
    // Whatever the cancels reported, look at what the rows say now: if any request for this bill
    // could still take money, a second one must not go on the Terminal.
    const stillLive = (await getCheckouts(tx, id)).some((c) => isCheckoutLive(c.status));
    if (r.cancelPending || r.warnings.length > 0 || stillLive) {
      // Return (not throw) so the cancel we already sent to Square — its status and audit row — commits.
      return {
        kind: "refused",
        message:
          r.warnings[0] ??
          "The Terminal is still cancelling the previous request (this can take up to a minute if a card was being presented). Try again shortly.",
      };
    }
    const fresh = await mustLock(tx, id);
    const co = await sendAttempt(tx, fresh, actor, settings);
    if ("kind" in co) return { kind: "refused", message: KEY_CONFLICT_MESSAGE };
    if (co.status === "COMPLETED") return { kind: "already_paid_by_card" };
    return { kind: "sent", checkoutId: co.id, amountCents: co.amountCents };
  });
  if (result.kind === "refused") throw conflict(result.message);
  return result;
}

export async function cancelCheckout(actor: Actor, id: string): Promise<{ status: CheckoutStatus | null; paid: boolean; warnings: string[] }> {
  return withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "cancel_checkout");
    const live = (await getCheckouts(tx, id)).filter((c) => isCheckoutLive(c.status));
    if (live.length === 0) throw conflict("There's nothing on the Terminal to cancel.");
    const r = await cancelLiveCheckouts(tx, s, actor);
    const [latest] = await tx<{ status: CheckoutStatus }[]>`
      select status from public.terminal_checkouts where id = ${s.square_checkout_id}`;
    return { status: latest?.status ?? null, paid: r.completed, warnings: r.warnings };
  });
}

/**
 * Asks Square for its view of a checkout, then applies it under the session lock. The Square call
 * is made WITHOUT holding the lock, so a slow Square never blocks Cancel / Mark paid on the same
 * bill. That's safe because applyCheckoutState only ever moves a checkout's status forward.
 */
async function reconcileCheckout(checkoutId: string, sessionId: string, actor: Actor | null): Promise<void> {
  let state: SquareCheckoutState | null = null;
  let notFound: unknown = null;
  try {
    state = await gateway.get(checkoutId);
  } catch (e) {
    if (!isCheckoutNotFound(e)) throw e;
    notFound = e;
  }
  await withTx(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (!s) return;
    const [c] = await tx<CheckoutRow[]>`
      select * from public.terminal_checkouts where id = ${checkoutId} and session_id = ${sessionId} for update`;
    if (!c || !isCheckoutLive(c.status)) return; // settled meanwhile (webhook / another iPad)
    if (state) {
      await applyCheckoutState(tx, s, c, state, "square_api", actor);
      return;
    }
    // Square says it has no such checkout. Young ones fail as they always have.
    if (!(await isOldCheckout(tx, c.id))) throw notFound;
    await applyCheckoutState(tx, s, c, { status: "CANCELED", cancelReason: NOT_FOUND_REASON }, "square_api", actor, NOT_FOUND_NOTE);
  });
}

/** Asks Square for the latest state of any live checkout on this session. */
export async function syncCheckout(actor: Actor | null, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw notFound("Session not found.");
  const q = db();
  const [exists] = await q<{ id: string }[]>`select id from public.sessions where id = ${id}`;
  if (!exists) throw notFound("Session not found.");
  const live = await q<{ id: string }[]>`
    select id from public.terminal_checkouts
    where session_id = ${id} and status in ('PENDING', 'IN_PROGRESS', 'CANCEL_REQUESTED')
    order by attempt`;
  for (const c of live) await reconcileCheckout(c.id, id, actor);
}

/**
 * Background reconciliation for lost/late webhooks. Called opportunistically (after the floor
 * view is served). Throttled by last_synced_at so several iPads don't all hit Square.
 */
export async function syncStaleCheckouts(limit = 3): Promise<void> {
  // Covers every live checkout, whether or not its bill is still on a table (bills charged from
  // the Unpaid list, or marked paid while the Terminal was still cancelling).
  //
  // Read-only check first. The floor-change broadcast triggers are statement-level, so they fire
  // even for an UPDATE that matches no rows. An unconditional claim on every floor fetch would
  // broadcast "changed", make every iPad refetch the floor, run this again, and loop forever.
  const [due] = await db()<{ due: boolean }[]>`
    select exists (
      select 1 from public.terminal_checkouts
      where status in ('PENDING', 'IN_PROGRESS', 'CANCEL_REQUESTED')
        and created_at < now() - interval '8 seconds'
        and (last_synced_at is null or last_synced_at < now() - interval '15 seconds')
    ) as due`;
  if (!due?.due) return;

  // Claim the rows atomically by stamping last_synced_at first: concurrent callers (three iPads
  // polling) skip each other's rows, and a failing Square call can't make us retry the same
  // checkout on every poll.
  const rows = await db()<{ id: string; session_id: string }[]>`
    update public.terminal_checkouts set last_synced_at = now()
    where id in (
      select id from public.terminal_checkouts
      where status in ('PENDING', 'IN_PROGRESS', 'CANCEL_REQUESTED')
        and created_at < now() - interval '8 seconds'
        and (last_synced_at is null or last_synced_at < now() - interval '15 seconds')
      order by last_synced_at nulls first
      limit ${limit}
      for update skip locked
    )
    returning id, session_id`;
  for (const r of rows) {
    try {
      await reconcileCheckout(r.id, r.session_id, null);
    } catch (e) {
      console.warn("[square] background checkout sync failed", r.id, e instanceof Error ? e.message : e);
    }
  }
}

/** For `after()`: background reconciliation that can never throw (Square may be unconfigured). */
export async function reconcileInBackground(): Promise<void> {
  try {
    await syncStaleCheckouts();
  } catch (e) {
    console.warn("[square] stale checkout sync skipped", e instanceof Error ? e.message : e);
  }
}

/** Webhook entry point. Caller holds the transaction that also recorded the event id. */
export async function applyWebhookCheckout(
  tx: Tx,
  payload: {
    id: string;
    status: string;
    referenceId: string | null;
    cancelReason: string | null;
    amountCents?: number | null;
    /** The Square order the checkout pays, when it was sent itemised. */
    orderId?: string | null;
  },
): Promise<"applied" | "unknown" | "ignored"> {
  if (!isCheckoutStatus(payload.status)) return "ignored";

  // Lock the session first (found via reference_id) so a webhook racing the charge transaction
  // waits for it to commit instead of seeing an "unknown" checkout.
  let sessionId: string | null = payload.referenceId && UUID_RE.test(payload.referenceId) ? payload.referenceId : null;
  if (!sessionId) {
    const [c] = await tx<{ session_id: string }[]>`
      select session_id from public.terminal_checkouts where id = ${payload.id}`;
    sessionId = c?.session_id ?? null;
  }
  const s = sessionId ? await lockSession(tx, sessionId) : null;
  let [row] = s
    ? await tx<CheckoutRow[]>`
        select * from public.terminal_checkouts where id = ${payload.id} and session_id = ${s.id} for update`
    : [];

  if (s && !row) {
    // Square created this checkout (reference_id is our session) but the transaction that sent it
    // never committed — e.g. Square answered after our timeout. Adopt it so its outcome counts:
    // a completed payment must settle the bill (or be flagged if the bill was paid another way).
    const amount = payload.amountCents && payload.amountCents > 0 ? payload.amountCents : s.total_cents;
    if (amount && amount > 0) {
      const attempt = s.checkout_attempt + 1;
      [row] = await tx<CheckoutRow[]>`
        insert into public.terminal_checkouts (id, session_id, attempt, amount_cents, status, square_order_id)
        values (${payload.id}, ${s.id}, ${attempt}, ${amount}, 'PENDING', ${payload.orderId ?? null})
        returning *`;
      await tx`
        update public.sessions set checkout_attempt = ${attempt}, square_checkout_id = ${payload.id}
        where id = ${s.id}`;
      s.checkout_attempt = attempt;
      s.square_checkout_id = payload.id;
      await audit(tx, {
        actorStaffId: null,
        deviceLabel: "Square webhook",
        action: "checkout.adopted",
        entity: "session",
        entityId: s.id,
        after: {
          checkout_id: payload.id,
          attempt,
          amount_cents: amount,
          square_status: payload.status,
          order_id: payload.orderId ?? null,
        },
        reason: "Square created this card request but the app hadn't recorded it (Square answered slowly). Recorded now from Square's webhook.",
      });
    }
  }

  if (!s || !row) {
    await audit(tx, {
      actorStaffId: null,
      deviceLabel: "Square webhook",
      action: "webhook.unknown_checkout",
      entity: s ? "session" : "square_checkout",
      entityId: s ? s.id : payload.id,
      after: { checkout_id: payload.id, status: payload.status, reference_id: payload.referenceId },
    });
    console.warn("[square] webhook for unknown checkout", payload.id, payload.status);
    return "unknown";
  }

  await applyCheckoutState(tx, s, row, { status: payload.status, cancelReason: payload.cancelReason }, "square_webhook", null);
  return "applied";
}

// ---------------------------------------------------------------------------
// Items on the bill
// ---------------------------------------------------------------------------

const MAX_LINES_PER_BILL = 100;
const MAX_ITEMS_CENTS = 10_000_000; // $100,000 — far past any real bill; keeps the integer columns safe

const CHECKOUT_LIVE_MESSAGE = "Cancel the card request on the Terminal before changing the bill.";

/**
 * Puts `quantity` of a product on the bill at the product's current price. The name, price and
 * GST flag are copied onto the bill, so a later catalogue change can't alter it.
 */
export async function addItem(actor: Actor, id: string, productId: string, quantity: number): Promise<{ itemId: string }> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw badRequest("Quantity must be between 1 and 99.");
  }
  return withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "add_item");
    if ((await getCheckouts(tx, id)).some((c) => isCheckoutLive(c.status))) throw conflict(CHECKOUT_LIVE_MESSAGE);

    const [product] = await tx<{ id: string; name: string; price_cents: number; taxed: boolean; active: boolean }[]>`
      select id, name, price_cents, taxed, active from public.products where id = ${productId}`;
    if (!product) throw notFound("That item isn't on the list.");
    if (!product.active) throw conflict(`${product.name} isn't for sale any more. Pick something else.`);

    const [lines] = await tx<{ n: number }[]>`
      select count(*)::int as n from public.session_items where session_id = ${id} and removed_at is null`;
    if ((lines?.n ?? 0) >= MAX_LINES_PER_BILL) {
      throw conflict(`A bill can hold ${MAX_LINES_PER_BILL} lines at most. Take something off before adding more.`);
    }

    const cents = product.price_cents * quantity;
    const itemsCents = s.items_cents + cents;
    if (itemsCents > MAX_ITEMS_CENTS) throw conflict("That's more than one bill can hold.");
    const closed = s.status === "awaiting_payment";
    const totalCents = closed ? (s.total_cents ?? 0) + cents : s.total_cents;

    const [item] = await tx<{ id: string }[]>`
      insert into public.session_items (session_id, product_id, name, unit_cents, quantity, taxed, added_by)
      values (${id}, ${product.id}, ${product.name}, ${product.price_cents}, ${quantity}, ${product.taxed}, ${actor.staffId})
      returning id`;
    if (closed) {
      // The bill is already totalled, so the total moves with it. Skip an attempt number so the
      // new amount can never reuse an idempotency key Square has seen.
      await tx`
        update public.sessions set items_cents = ${itemsCents}, total_cents = ${totalCents},
          checkout_attempt = checkout_attempt + 1
        where id = ${id}`;
    } else {
      await tx`update public.sessions set items_cents = ${itemsCents} where id = ${id}`;
    }
    await audit(tx, {
      ...by(actor),
      action: "session.add_item",
      entity: "session",
      entityId: id,
      before: { items_cents: s.items_cents, total_cents: s.total_cents },
      after: {
        item_id: item.id,
        product_id: product.id,
        name: product.name,
        unit_cents: product.price_cents,
        quantity,
        taxed: product.taxed,
        items_cents: itemsCents,
        total_cents: totalCents,
      },
    });
    return { itemId: item.id };
  });
}

/** Takes one line off the bill. The row is kept and stamped with who removed it and when. */
export async function removeItem(actor: Actor, id: string, itemId: string, now = new Date()): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "remove_item");
    if ((await getCheckouts(tx, id)).some((c) => isCheckoutLive(c.status))) throw conflict(CHECKOUT_LIVE_MESSAGE);

    const [item] = UUID_RE.test(itemId)
      ? await tx<SessionItemRow[]>`
          select id, session_id, product_id, name, unit_cents, quantity, taxed, added_by, added_at, removed_at, removed_by
          from public.session_items where id = ${itemId} and session_id = ${id} for update`
      : [];
    if (!item) throw notFound("That item isn't on this bill.");
    if (item.removed_at) throw conflict("That item has already been taken off the bill.");

    const cents = item.unit_cents * item.quantity;
    const itemsCents = s.items_cents - cents;
    const closed = s.status === "awaiting_payment";
    const totalCents = closed ? (s.total_cents ?? 0) - cents : s.total_cents;
    if (closed && (totalCents ?? 0) <= 0) {
      throw conflict("That would leave nothing on the bill. Ask a manager to void it instead.");
    }

    await tx`update public.session_items set removed_at = ${now}, removed_by = ${actor.staffId} where id = ${item.id}`;
    if (closed) {
      // Same as adding: a changed amount must never reuse an idempotency key Square has seen.
      await tx`
        update public.sessions set items_cents = ${itemsCents}, total_cents = ${totalCents},
          checkout_attempt = checkout_attempt + 1
        where id = ${id}`;
    } else {
      await tx`update public.sessions set items_cents = ${itemsCents} where id = ${id}`;
    }
    await audit(tx, {
      ...by(actor),
      action: "session.remove_item",
      entity: "session",
      entityId: id,
      before: {
        item_id: item.id,
        product_id: item.product_id,
        name: item.name,
        unit_cents: item.unit_cents,
        quantity: item.quantity,
        items_cents: s.items_cents,
        total_cents: s.total_cents,
      },
      after: { item_id: item.id, removed_at: now, items_cents: itemsCents, total_cents: totalCents },
    });
  });
}

// ---------------------------------------------------------------------------
// Staff settlement
// ---------------------------------------------------------------------------

export async function markPaid(
  actor: Actor,
  id: string,
  method: SettledMethod,
  opts: {
    cardConfirmed: boolean;
    /**
     * Cash only: hold the sale back from Square for this long. Used when the bill was handed to
     * Square POS a moment ago and POS may yet report a sale of its own (see pos-cash.ts).
     */
    holdSquareCashSeconds?: number;
  },
  now = new Date(),
): Promise<MarkPaidOutcome & { warnings: string[] }> {
  if (method === "card" && !opts.cardConfirmed) {
    throw badRequest("Confirm that the card payment shows as approved on the Terminal or in Square.");
  }
  return withTx(async (tx) => {
    const s = await mustLock(tx, id);
    if (s.status === "paid" && s.settled_method === "card" && s.settled_via !== "staff") {
      return { kind: "already_paid_by_card", warnings: [] };
    }
    assertCan(s.status, "mark_paid");

    // Brief §6.5: cancel any checkout still on the Terminal before recording a staff settlement.
    const live = await cancelLiveCheckouts(tx, s, actor);
    if (live.completed) return { kind: "already_paid_by_card", warnings: live.warnings };

    const billCents = s.total_cents ?? 0;
    // Cash is collected to the nearest 5c; a card is taken for the exact bill.
    const settledCents = method === "cash" ? cashDueCents(billCents) : billCents;
    await tx`
      update public.sessions set
        status = 'paid', settled_method = ${method}, settled_via = 'staff', settled_by = ${actor.staffId},
        settled_at = ${now}, settled_cents = ${settledCents}, current_table_id = null
      where id = ${id}`;
    // Cash goes into Square too, but not from here: this only writes the outbox row, in the same
    // transaction as the payment. The Square calls happen after the response (see square-cash.ts),
    // so Square being slow or down never holds up the till.
    const squareCashSeq =
      method === "cash" ? await queueCashForSquare(tx, s, actor, settledCents, opts.holdSquareCashSeconds ?? 0) : null;
    await audit(tx, {
      ...by(actor),
      action: "session.mark_paid",
      entity: "session",
      entityId: id,
      before: auditView(s),
      after: {
        status: "paid",
        settled_method: method,
        settled_via: "staff",
        settled_at: now,
        total_cents: s.total_cents,
        settled_cents: settledCents,
        card_confirmed_by_staff: method === "card" ? true : undefined,
        square_cash_seq: squareCashSeq ?? undefined,
      },
      reason: live.cancelPending ? "Marked paid while the Terminal was still cancelling a card request." : null,
    });
    const warnings = [...live.warnings];
    if (live.cancelPending) {
      warnings.push("The Terminal was still cancelling the card request. If the customer taps their card anyway, the app will flag it.");
    }
    return { kind: "paid", method, via: "staff", amountCents: settledCents, warnings };
  });
}

/**
 * Writes the outbox row for a cash payment, with the order lines as they stand right now. Returns
 * the record's sequence number, or null when there is nothing to send to Square.
 */
async function queueCashForSquare(tx: Tx, s: SessionRow, actor: Actor, cashCents: number, holdSeconds: number): Promise<number | null> {
  const billCents = s.total_cents ?? 0;
  if (cashCents <= 0 || billCents <= 0) return null;
  const intervals = await getIntervals(tx, s.id);
  const note = await sessionNote(tx, s, intervals, s.billed_minutes ?? 0);
  let lines: OrderLineInput[] | null = null;
  const tableCents = billCents - s.items_cents;
  if ((await getSettings(tx)).itemiseCharges && tableCents >= 0) {
    const { table_hire_variation_id: tableHireVariationId } = await getCatalogState(tx);
    lines = orderLines(tableCents, tableHireVariationId, note, await getLiveItems(tx, s.id));
  }
  return enqueueCashRecord(tx, { sessionId: s.id, amountCents: cashCents, billCents, note, lines, staffId: actor.staffId, holdSeconds });
}

// ---------------------------------------------------------------------------
// Manager actions (PIN verified by the caller; reason required)
// ---------------------------------------------------------------------------

function requireReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 3) throw badRequest("A reason is required.");
  if (r.length > 500) throw badRequest("Keep the reason under 500 characters.");
  return r;
}

export async function voidSession(
  actor: Actor,
  manager: Manager,
  id: string,
  reasonIn: string,
  now = new Date(),
): Promise<{ kind: "voided" } | { kind: "already_paid_by_card" }> {
  const reason = requireReason(reasonIn);
  const result = await withTx<{ kind: "voided" } | { kind: "already_paid_by_card" } | Refused>(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "void");
    if (s.status === "awaiting_payment") {
      const live = await cancelLiveCheckouts(tx, s, actor);
      if (live.completed) return { kind: "already_paid_by_card" } as const;
      if (live.cancelPending || live.warnings.length) {
        // Return (not throw) so the cancel already sent to Square is recorded.
        return { kind: "refused", message: "A card request is still on the Terminal. Cancel it there first, then void." } as const;
      }
    }
    await closeOpenInterval(tx, id, now);
    await tx`
      update public.sessions set
        status = 'void', current_table_id = null,
        closed_at = coalesce(closed_at, ${now}), closed_by = coalesce(closed_by, ${actor.staffId}),
        voided_at = ${now}, voided_by = ${manager.id}, void_reason = ${reason}
      where id = ${id}`;
    await audit(tx, {
      ...by(actor),
      approvedByStaffId: manager.id,
      action: "session.void",
      entity: "session",
      entityId: id,
      before: auditView(s),
      after: { status: "void", voided_by: manager.id },
      reason,
    });
    return { kind: "voided" } as const;
  });
  if (result.kind === "refused") throw conflict(result.message);
  return result;
}

export async function reversePaid(actor: Actor, manager: Manager, id: string, reasonIn: string): Promise<void> {
  const reason = requireReason(reasonIn);
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "reverse_paid");
    await tx`
      update public.sessions set
        status = 'awaiting_payment', settled_method = null, settled_via = null, settled_by = null, settled_at = null,
        settled_cents = null
      where id = ${id}`;
    // A cash sale the app put (or is putting) into Square has to come back out of it.
    const squareCash = s.settled_method === "cash" ? await markCashReversed(tx, id) : null;
    await audit(tx, {
      ...by(actor),
      approvedByStaffId: manager.id,
      action: "session.reverse_paid",
      entity: "session",
      entityId: id,
      before: auditView(s),
      after: { status: "awaiting_payment", square_cash: squareCash ?? undefined },
      reason,
    });
  });
}

export interface IntervalEdit {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
}

export async function editTimes(
  actor: Actor,
  manager: Manager,
  id: string,
  reasonIn: string,
  edits: IntervalEdit[],
  now = new Date(),
): Promise<{ totalCents: number | null }> {
  const reason = requireReason(reasonIn);
  return withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "edit_times");
    if ((await getCheckouts(tx, id)).some((c) => isCheckoutLive(c.status))) {
      throw conflict("Cancel the card request on the Terminal before changing times.");
    }
    const current = await getIntervals(tx, id);
    const byId = new Map(current.map((i) => [i.id, i]));
    if (edits.length !== current.length || edits.some((e) => !byId.has(e.id))) {
      throw badRequest("Send every interval of the session exactly once.");
    }
    for (const e of edits) {
      const orig = byId.get(e.id) as IntervalRow;
      const wasOpen = orig.ended_at === null;
      if (wasOpen !== (e.endedAt === null)) {
        throw badRequest(wasOpen ? "The running interval can't be given an end time here — use Stop." : "A finished interval needs an end time.");
      }
      if (e.startedAt.getTime() > now.getTime() || (e.endedAt && e.endedAt.getTime() > now.getTime())) {
        throw badRequest("Times can't be in the future.");
      }
      if (e.endedAt && e.endedAt.getTime() < e.startedAt.getTime()) {
        throw badRequest("An interval can't end before it starts.");
      }
    }
    const sorted = [...edits].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1].endedAt;
      if (!prevEnd || prevEnd.getTime() > sorted[i].startedAt.getTime()) {
        throw badRequest("Intervals overlap. Each one must end before the next starts.");
      }
    }

    for (const e of edits) {
      await tx`
        update public.session_intervals set started_at = ${e.startedAt}, ended_at = ${e.endedAt}
        where id = ${e.id} and session_id = ${id}`;
    }
    const openedAt = sorted[0]?.startedAt ?? s.opened_at;
    const lastEnd = sorted.reduce<Date | null>((m, e) => (e.endedAt && (!m || e.endedAt > m) ? e.endedAt : m), null);
    await tx`
      update public.sessions set
        opened_at = ${openedAt},
        closed_at = case when closed_at is null then null else greatest(closed_at, ${lastEnd ?? openedAt}) end
      where id = ${id}`;

    let totalCents: number | null = s.total_cents;
    let billedMinutes: number | null = s.billed_minutes;
    if (s.status === "awaiting_payment") {
      const fresh = await mustLock(tx, id);
      const r = repriceClosed(fresh, await getIntervals(tx, id));
      // Changing the times re-prices the table time only; the items on the bill stay as they are.
      totalCents = r.totalCents + fresh.items_cents;
      billedMinutes = r.billedMinutes;
      // Skip an attempt number so a new amount can never reuse an idempotency key Square has seen.
      await tx`
        update public.sessions set total_cents = ${totalCents}, billed_minutes = ${r.billedMinutes},
          checkout_attempt = checkout_attempt + 1
        where id = ${id}`;
    }

    await audit(tx, {
      ...by(actor),
      approvedByStaffId: manager.id,
      action: "session.edit_times",
      entity: "session",
      entityId: id,
      before: {
        intervals: current.map((i) => ({ id: i.id, started_at: i.started_at, ended_at: i.ended_at })),
        total_cents: s.total_cents,
        billed_minutes: s.billed_minutes,
      },
      after: {
        intervals: edits.map((e) => ({ id: e.id, started_at: e.startedAt, ended_at: e.endedAt })),
        total_cents: totalCents,
        billed_minutes: billedMinutes,
      },
      reason,
    });
    return { totalCents };
  });
}

export type { Db };
