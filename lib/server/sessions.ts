import "server-only";
import { assertCan, isCheckoutLive, isCheckoutStatus, type CheckoutStatus } from "@/lib/domain/machine";
import { billTotals, cashDueCents, discountCentsFor } from "@/lib/domain/bill";
import type { MarkPaidOutcome, SettledMethod } from "@/lib/domain/types";
import { formatDuration, makeSnapshot, price, type PriceResult, type PricingInterval } from "@/lib/pricing";
import { formatTime } from "@/lib/format";
import * as orders from "@/lib/square/orders";
import type { OrderDiscountInput, OrderLineInput } from "@/lib/square/orders";
import * as terminal from "@/lib/square/terminal";
import type { SquareCheckoutState } from "@/lib/square/terminal";
import type { Actor, Manager } from "./auth";
import { audit } from "./audit";
import { db, withTx, type Db, type Tx } from "./db";
import { squareEnv } from "./env";
import { enqueueCashRecord, markCashReversed } from "./square-cash";
import { isKeyReused, isSquareRejection, squareStatus } from "./square-errors";
import { badRequest, conflict, forbidden, notFound, AppError } from "./errors";
import {
  auditView,
  cashHandoffInProgress,
  COUNTER_LABEL,
  DISCARD_REASON,
  MERGED_REASON,
  PART_FALLBACK_LABEL,
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
  type DiscountRow,
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
 * The whole bill is worked out from this by `billAmounts`.
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
// The bill
// ---------------------------------------------------------------------------

export { COUNTER_LABEL, DISCARD_REASON, MERGED_REASON };

/** The names of the tables a session was on, in the order it used them, each once. */
async function tablesUsed(tx: Tx, intervals: IntervalRow[]): Promise<string[]> {
  const names = await tableNames(tx, [...new Set(intervals.map((i) => i.table_id))]);
  return intervals.map((i) => names.get(i.table_id) ?? "Table").filter((n, idx, arr) => arr.indexOf(n) === idx);
}

/** What to call a bill: its tables ("Table 3 → Table 5"), "Counter sale", or "Table 3 · share" for a part. */
export async function billLabel(tx: Tx, s: SessionRow, intervals?: IntervalRow[]): Promise<string> {
  if (s.kind === "counter") return COUNTER_LABEL;
  if (s.kind === "part") {
    // A part is named once, when it is split off, and keeps that name on its one line.
    const [line] = await tx<{ name: string }[]>`
      select name from public.session_items where session_id = ${s.id} and kind = 'split' order by added_at, id limit 1`;
    return line?.name ?? PART_FALLBACK_LABEL;
  }
  return (await tablesUsed(tx, intervals ?? (await getIntervals(tx, s.id)))).join(" → ") || "Table";
}

/** Counter sales and parts have no timer: they are never paused, stopped, moved or re-timed. */
function requireTimer(s: SessionRow, what: string): void {
  if (s.kind === "counter") throw conflict(`A counter sale has no table time, so there is nothing to ${what}.`);
  if (s.kind === "part") throw conflict(`A share of a split bill has no table time, so there is nothing to ${what}.`);
}

const PART_FIXED_MESSAGE = "A share of a split bill can't be changed. Merge it back into the bill it came from and change that.";
const BELOW_SPLIT_MESSAGE = "That would leave less on this bill than has been split off it. Merge the parts back first.";

type BillTerms = Pick<SessionRow, "items_cents" | "discount_kind" | "discount_value" | "split_off_cents">;

export interface BillAmounts {
  /** Table time. 0 for a counter sale or a part. */
  tableCents: number;
  itemsCents: number;
  discountCents: number;
  splitOffCents: number;
  /** tableCents + itemsCents − discountCents − splitOffCents. Never below 0. */
  totalCents: number;
}

/**
 * THE bill identity. Nothing else in the app works out a total:
 *
 *     total = table time + items − discount − split off
 *
 * The discount is recomputed here from its kind and value every time, so a percentage follows the
 * bill as items or table time change. Refuses (409) anything that would take the total below zero,
 * which can only happen when money has been split off onto parts.
 */
export function billAmounts(s: BillTerms, tableCents: number): BillAmounts {
  const baseCents = tableCents + s.items_cents;
  const discountCents = s.discount_kind && s.discount_value ? discountCentsFor(baseCents, s.discount_kind, s.discount_value) : 0;
  if (baseCents - discountCents - s.split_off_cents < 0) throw conflict(BELOW_SPLIT_MESSAGE);
  // Same function the screens use, so the server and the iPads can't disagree on the arithmetic.
  const t = billTotals(tableCents, [{ unitCents: s.items_cents, quantity: 1, taxed: true }], {
    discountCents,
    splitOffCents: s.split_off_cents,
  });
  return {
    tableCents,
    itemsCents: t.itemsCents,
    discountCents: t.discountCents,
    splitOffCents: t.splitOffCents,
    totalCents: t.totalCents,
  };
}

export interface PricedBill extends BillAmounts {
  /** Empty for a counter sale or a part. */
  intervals: IntervalRow[];
  /** TABLE TIME ONLY (as SessionDetailDTO.breakdown): `r.totalCents` is `tableCents`. */
  r: PriceResult;
  billedMinutes: number;
}

/**
 * Works out a closed bill from its stored rates, items, discount and split. Reads only; `s` is
 * the row as it stands (pass the changed terms when a caller has just written them).
 */
async function priceBill(tx: Tx, s: SessionRow): Promise<PricedBill> {
  // No intervals and no rate snapshot on a counter sale or a part: their table time is nil.
  const intervals = s.kind === "table" ? await getIntervals(tx, s.id) : [];
  const r: PriceResult =
    s.kind === "table" ? repriceClosed(s, intervals) : { actualMs: 0, billedMinutes: 0, lines: [], totalCents: 0, gstCents: 0 };
  return { ...billAmounts(s, r.totalCents), intervals, r, billedMinutes: r.billedMinutes };
}

/**
 * The one place a bill's total is rewritten once it has been stopped. (Stop itself writes it the
 * first time, from the same `billAmounts`.) Works the bill out (`priceBill`) and stores total,
 * billed minutes and what the discount takes off, if any of them moved. Caller holds the bill's
 * lock.
 *
 * `changed: true` is for a caller that has just changed something on the bill (an item, the
 * discount, the times, a split). Pass the row with the new `items_cents` / `split_off_cents` on
 * it: they are stored here, in the same statement as the total they produce, so the row can never
 * be seen with one and not the other. It also skips an attempt number, so the new amount can never
 * go to Square under an idempotency key Square has already seen with the old one, and it leaves
 * the audit row to the caller.
 *
 * Without it this is the check made just before money is asked for (card charge, Square POS
 * handoff): normally nothing has moved and nothing is written; if something has, the correction
 * is audited as `session.repriced`.
 */
export async function repriceBill(
  tx: Tx,
  s: SessionRow,
  actor: Pick<Actor, "staffId" | "deviceLabel">,
  opts: { changed?: boolean } = {},
): Promise<PricedBill> {
  if (s.status !== "awaiting_payment") throw new Error(`session ${s.id} is ${s.status}: only a bill awaiting payment is priced`);
  const bill = await priceBill(tx, s);
  const moved =
    bill.totalCents !== s.total_cents || bill.billedMinutes !== s.billed_minutes || bill.discountCents !== s.discount_cents;
  if (moved || opts.changed) {
    await tx`
      update public.sessions set
        items_cents = ${bill.itemsCents}, split_off_cents = ${bill.splitOffCents},
        total_cents = ${bill.totalCents}, billed_minutes = ${bill.billedMinutes}, discount_cents = ${bill.discountCents},
        checkout_attempt = checkout_attempt + ${opts.changed ? 1 : 0}
      where id = ${s.id}`;
  }
  if (moved && !opts.changed) {
    await audit(tx, {
      ...by(actor),
      action: "session.repriced",
      entity: "session",
      entityId: s.id,
      before: { total_cents: s.total_cents, billed_minutes: s.billed_minutes, discount_cents: s.discount_cents || undefined },
      after: {
        total_cents: bill.totalCents,
        items_cents: bill.itemsCents,
        billed_minutes: bill.billedMinutes,
        discount_cents: bill.discountCents || undefined,
        split_off_cents: bill.splitOffCents || undefined,
      },
    });
  }
  return bill;
}

export const BILL_CHANGED_MESSAGE = "This bill has changed. Check the amount and try again.";

/**
 * What a money action answers when the bill is no longer the amount the screen showed when staff
 * tapped (another iPad changed it in between). Its own code, so the screens can tell it from any
 * other refusal, refetch the bill and show the new amount.
 */
export const billChanged = () => new AppError(409, "bill_changed", BILL_CHANGED_MESSAGE);

/**
 * True when the request said what total it was acting on and the bill isn't that. A request that
 * says nothing (the release before this one doesn't send it) is never refused on these grounds.
 */
export function totalHasMoved(expectedTotalCents: number | undefined, actualCents: number | null): boolean {
  return expectedTotalCents !== undefined && expectedTotalCents !== (actualCents ?? 0);
}

/**
 * Returned (not thrown) from inside a transaction when a money action is refused because the bill
 * changed, so that anything the same transaction has already put right is kept: if the stored
 * total was wrong and the re-pricing corrected it, throwing would roll the correction back and
 * the screen would be shown the same wrong amount for ever. The caller throws `billChanged()` once
 * the transaction has committed. When nothing needed correcting, nothing was written at all.
 */
export type BillChanged = { kind: "bill_changed" };

/** Shown when the amount of a bill can't change because Square POS may be taking cash for it. */
async function refuseDuringCashHandoff(tx: Tx, s: SessionRow, which = "this bill"): Promise<void> {
  if (s.status !== "awaiting_payment") return;
  const since = await cashHandoffInProgress(tx, s.id);
  if (!since) return;
  const { timezone } = await getSettings(tx);
  throw conflict(
    `Cash for ${which} was sent to Square POS at ${formatTime(since, timezone)}. Finish or cancel that sale in Square POS first, then try again.`,
  );
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
    // The bill is table time plus whatever was put on it, less any discount (worked out here for
    // the first time: it is 0 while the session runs). billed_minutes stays table time only.
    const bill = billAmounts(s, result.totalCents);
    const totalCents = bill.totalCents;

    if (bill.tableCents + bill.itemsCents === 0) {
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
        billed_minutes = ${result.billedMinutes}, total_cents = ${totalCents}, discount_cents = ${bill.discountCents},
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
        discount_cents: s.discount_kind ? bill.discountCents : undefined,
        total_cents: totalCents,
        lines: result.lines,
      },
    });
    return { status: "awaiting_payment", billedMinutes: result.billedMinutes, totalCents };
  });
}

/**
 * "Keep playing": a stopped table goes back to running, as if Stop had not been the end of it.
 * The bill worked out at Stop is thrown away (it is worked out again at the next Stop); the items
 * and any discount stay on it.
 *
 *   countGap true  — stopped by mistake: the clock carries on from the moment it was stopped, so
 *                    the time since is charged.
 *   countGap false — they came back for more: the clock starts again now, and the time in between
 *                    is not charged (the same as a pause).
 *
 * Only while the bill is still on its table: once it has been left unpaid the table may have been
 * given to someone else, and that bill is paid as it stands. Not once any of it has been split
 * off, and not while a card request or a Square POS cash sale could still take the old amount.
 */
export async function continueSession(actor: Actor, id: string, opts: { countGap: boolean }, now = new Date()): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "continue");
    if (s.kind !== "table") throw conflict("Only a table's bill can go back to running.");
    if (!s.current_table_id || !s.closed_at) {
      throw conflict("This bill has left its table, so it can't go back to running. Start the table again and take this bill as it is.");
    }
    const [part] = await tx<{ id: string }[]>`select id from public.sessions where split_of = ${id} and not merged limit 1`;
    if (part || s.split_off_cents !== 0) throw conflict("This bill has been split, so it can't go back to running.");
    if ((await getCheckouts(tx, id)).some((c) => isCheckoutLive(c.status))) {
      throw conflict("Cancel the card request on the Terminal first.");
    }
    await refuseDuringCashHandoff(tx, s);

    // The clock: carry on the interval Stop closed, or open a new one.
    const intervals = await getIntervals(tx, id);
    const last = intervals[intervals.length - 1];
    const lastEnd = last?.ended_at ?? null;
    let startedAt: Date;
    if (opts.countGap && last && lastEnd && lastEnd.getTime() >= s.closed_at.getTime()) {
      // Running when it was stopped: that interval simply never ended.
      await tx`update public.session_intervals set ended_at = null where id = ${last.id}`;
      startedAt = last.started_at;
    } else {
      // Paused when it was stopped (count from the stop), or starting again from now. Never before
      // the last interval ended: two intervals of one session can't overlap.
      const from = opts.countGap ? s.closed_at : now;
      startedAt = lastEnd && lastEnd.getTime() > from.getTime() ? lastEnd : from;
      await tx`
        insert into public.session_intervals (session_id, table_id, started_at)
        values (${id}, ${s.current_table_id}, ${startedAt})`;
    }

    await tx`
      update public.sessions set
        status = 'running', closed_at = null, closed_by = null, billed_minutes = null, total_cents = null,
        discount_cents = 0, rate_snapshot = null
      where id = ${id}`;
    await audit(tx, {
      ...by(actor),
      action: "session.continue",
      entity: "session",
      entityId: id,
      before: auditView(s),
      after: { status: "running", count_gap: opts.countGap, interval_started_at: startedAt, stopped_at: s.closed_at },
    });
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
 *
 * A COMPLETED view carries the Square payment the checkout made. It is stored on the row (once),
 * because a refund or a receipt reprint is asked for against that payment id.
 */
async function applyCheckoutState(
  tx: Tx,
  s: SessionRow,
  row: CheckoutRow,
  state: Pick<SquareCheckoutState, "status" | "cancelReason"> & { paymentId?: string | null },
  source: Source,
  actor: Pick<Actor, "staffId" | "deviceLabel"> | null,
  /** Why, when the status didn't come straight from Square. Goes on the audit row. */
  note: string | null = null,
): Promise<boolean> {
  const next = RANK[state.status] > RANK[row.status] ? state.status : row.status;
  const cancelReason = next === "CANCELED" ? state.cancelReason ?? row.cancel_reason : row.cancel_reason;
  // Only Square saying COMPLETED names the payment; never overwrite one already stored.
  const paymentId = state.status === "COMPLETED" && !row.square_payment_id ? state.paymentId ?? null : null;
  if (next === row.status) {
    if (cancelReason !== row.cancel_reason) {
      await tx`update public.terminal_checkouts set cancel_reason = ${cancelReason} where id = ${row.id}`;
    }
    if (paymentId) {
      // Already known to be completed, but the id wasn't with that news. No status change, so
      // this wakes no iPad.
      await tx`
        update public.terminal_checkouts set square_payment_id = ${paymentId}
        where id = ${row.id} and square_payment_id is null`;
    }
    return false;
  }
  await tx`
    update public.terminal_checkouts
    set status = ${next}, cancel_reason = ${cancelReason}, last_synced_at = now(),
        square_payment_id = coalesce(square_payment_id, ${paymentId})
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

/**
 * The note Square shows against a bill: the tables it was on, the time billed and the clock times.
 * A counter sale or a part has no table time: its note is what it is and when ("Counter sale · 19:42").
 */
export async function sessionNote(tx: Tx, s: SessionRow, intervals: IntervalRow[], billedMinutes: number): Promise<string> {
  if (s.kind !== "table") {
    const { timezone } = await getSettings(tx);
    return [await billLabel(tx, s), formatTime(s.opened_at, timezone)].join(" · ");
  }
  return buildNote(
    await tablesUsed(tx, intervals),
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
    // A custom charge has no catalogue item behind it: it goes as an ad hoc line under its own name.
    lines.push({
      uid: i.id,
      catalogObjectId: i.product_id,
      name: i.product_id ? null : i.name,
      quantity: i.quantity,
      basePriceCents: i.unit_cents,
      note: null,
    });
  }
  return lines;
}

/** A bill as a Square order: its lines and, at most, one discount off the whole order. */
export interface SquareOrderBody {
  lines: OrderLineInput[];
  discount: OrderDiscountInput | null;
}

const SPLIT_LINE_SUFFIX = "part of a split bill";

/**
 * What a bill looks like in Square. The lines always add up to `bill.totalCents`.
 *
 *   - An ordinary bill: table time and each item, plus the discount (if any) as one amount off
 *     the whole order, under the discount's name.
 *   - A bill that has been split, and every part of one: a single ad hoc line for what is owed on
 *     it, and no discount line. Deliberate: scaling the lines down, or inventing a "paid
 *     separately" discount, would put figures in the owner's Square reports that never happened.
 *     The app keeps the itemised truth.
 */
export async function squareOrderBody(
  tx: Tx,
  s: SessionRow,
  bill: PricedBill,
  note: string,
  tableHireVariationId: string | null,
): Promise<SquareOrderBody> {
  if (s.kind === "part" || bill.splitOffCents > 0) {
    const what =
      s.kind === "part"
        ? `${await billLabel(tx, s)} of a split bill`
        : [await billLabel(tx, s, bill.intervals), ...(s.kind === "table" ? [formatDuration(bill.billedMinutes * 60_000)] : []), SPLIT_LINE_SUFFIX].join(" · ");
    return {
      lines: [{ uid: "split", catalogObjectId: null, name: what, quantity: 1, basePriceCents: bill.totalCents, note }],
      discount: null,
    };
  }
  return {
    lines: orderLines(bill.tableCents, tableHireVariationId, note, await getLiveItems(tx, s.id)),
    discount:
      bill.discountCents > 0 ? { uid: "discount", name: s.discount_name ?? "Discount", amountCents: bill.discountCents } : null,
  };
}

/**
 * Prices, sends a new checkout attempt to the Terminal and records it. Caller holds the lock.
 *
 * Returns `key_conflict` (rather than throwing) when Square says an idempotency key was already used
 * for a different request: nothing else is sent, the attempt number is skipped so the next try uses
 * fresh keys, and the caller must let the transaction COMMIT before telling staff.
 */
async function sendAttempt(
  tx: Tx,
  s: SessionRow,
  actor: Actor,
  settings: Settings,
  /** What the screen showed as the bill's total, if the request said. */
  expectedTotalCents?: number,
): Promise<SquareCheckoutState | KeyConflict | BillChanged> {
  const deviceId = settings.terminalDeviceId;
  if (!deviceId) throw conflict("No Terminal is paired.");
  const bill = await repriceBill(tx, s, actor);
  const { intervals, r, totalCents } = bill;
  // Nothing goes to Square for an amount staff weren't looking at.
  if (totalHasMoved(expectedTotalCents, totalCents)) return { kind: "bill_changed" };
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
      const body = await squareOrderBody(tx, s, bill, note, tableHireVariationId);
      const order = await gateway.createOrder({
        idempotencyKey: `${s.id}-o${attempt}`,
        locationId: squareEnv().SQUARE_LOCATION_ID,
        referenceId: s.id,
        lines: body.lines,
        // Left out entirely when there is none, so a bill without a discount sends what it always has.
        ...(body.discount ? { discount: body.discount } : {}),
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

export async function chargeCard(actor: Actor, id: string, opts: { expectedTotalCents?: number } = {}): Promise<ChargeOutcome> {
  const result = await withTx<ChargeOutcome | Refused | BillChanged>(async (tx) => {
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
    const co = await sendAttempt(tx, s, actor, settings, opts.expectedTotalCents);
    // Return (not throw) so the skipped attempt number and its audit row commit.
    if ("kind" in co) return co.kind === "bill_changed" ? co : { kind: "refused", message: KEY_CONFLICT_MESSAGE };
    if (co.status === "COMPLETED") return { kind: "already_paid_by_card" };
    return { kind: "sent", checkoutId: co.id, amountCents: co.amountCents };
  });
  if (result.kind === "bill_changed") throw billChanged();
  if (result.kind === "refused") throw conflict(result.message);
  return result;
}


export async function resendCheckout(actor: Actor, id: string, opts: { expectedTotalCents?: number } = {}): Promise<ChargeOutcome> {
  const result = await withTx<ChargeOutcome | Refused | BillChanged>(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "resend_checkout");
    const settings = await getSettings(tx);
    if (!settings.terminalDeviceId) throw conflict("No Terminal is paired.");
    // Checked against the stored total BEFORE the request on the Terminal is touched: a stale
    // screen must not cancel a card request it wasn't looking at. (Checked again in sendAttempt,
    // against the re-priced bill, before anything new is sent.)
    if (totalHasMoved(opts.expectedTotalCents, s.total_cents)) throw billChanged();
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
    const co = await sendAttempt(tx, fresh, actor, settings, opts.expectedTotalCents);
    if ("kind" in co) return co.kind === "bill_changed" ? co : { kind: "refused", message: KEY_CONFLICT_MESSAGE };
    if (co.status === "COMPLETED") return { kind: "already_paid_by_card" };
    return { kind: "sent", checkoutId: co.id, amountCents: co.amountCents };
  });
  if (result.kind === "bill_changed") throw billChanged();
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
    /** `payment_ids` of a completed checkout (one for a normal sale). */
    paymentIds?: string[] | null;
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

  await applyCheckoutState(
    tx,
    s,
    row,
    { status: payload.status, cancelReason: payload.cancelReason, paymentId: payload.paymentIds?.[0] ?? null },
    "square_webhook",
    null,
  );
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
    await requireOpenToChange(tx, s);

    const [product] = await tx<{ id: string; name: string; price_cents: number; taxed: boolean; active: boolean }[]>`
      select id, name, price_cents, taxed, active from public.products where id = ${productId}`;
    if (!product) throw notFound("That item isn't on the list.");
    if (!product.active) throw conflict(`${product.name} isn't for sale any more. Pick something else.`);

    return putLineOnBill(tx, s, actor, {
      kind: "product",
      productId: product.id,
      name: product.name,
      unitCents: product.price_cents,
      quantity,
      taxed: product.taxed,
    });
  });
}

/** The most a custom charge can be: $2,000. */
export const CUSTOM_ITEM_MAX_CENTS = 200_000;

/**
 * A custom charge: a name and a price typed in by staff, for something that isn't in the Square
 * catalogue. One line, quantity 1, GST included. Everything else is as for `addItem`, and it comes
 * off again with `removeItem`.
 */
export async function addCustomItem(actor: Actor, id: string, nameIn: string, amountCents: number): Promise<{ itemId: string }> {
  const name = nameIn.trim();
  if (name.length < 1 || name.length > 60) throw badRequest("Give the charge a name, up to 60 characters.");
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > CUSTOM_ITEM_MAX_CENTS) {
    throw badRequest("A custom charge must be between 1c and $2,000.");
  }
  return withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "add_item");
    await requireOpenToChange(tx, s);
    return putLineOnBill(tx, s, actor, { kind: "custom", productId: null, name, unitCents: amountCents, quantity: 1, taxed: true });
  });
}

/** What every change to a bill's lines needs first: not a part, and nothing live on the Terminal. */
async function requireOpenToChange(tx: Tx, s: SessionRow): Promise<void> {
  if (s.kind === "part") throw conflict(PART_FIXED_MESSAGE);
  if ((await getCheckouts(tx, s.id)).some((c) => isCheckoutLive(c.status))) throw conflict(CHECKOUT_LIVE_MESSAGE);
}

interface NewLine {
  kind: "product" | "custom";
  productId: string | null;
  name: string;
  unitCents: number;
  quantity: number;
  taxed: boolean;
}

/** Puts one line on a bill and brings the bill's sums into line. Caller holds the lock and has checked the status. */
async function putLineOnBill(tx: Tx, s: SessionRow, actor: Actor, line: NewLine): Promise<{ itemId: string }> {
  const [lines] = await tx<{ n: number }[]>`
    select count(*)::int as n from public.session_items where session_id = ${s.id} and removed_at is null`;
  if ((lines?.n ?? 0) >= MAX_LINES_PER_BILL) {
    throw conflict(`A bill can hold ${MAX_LINES_PER_BILL} lines at most. Take something off before adding more.`);
  }

  const itemsCents = s.items_cents + line.unitCents * line.quantity;
  if (itemsCents > MAX_ITEMS_CENTS) throw conflict("That's more than one bill can hold.");

  const [item] = await tx<{ id: string }[]>`
    insert into public.session_items (session_id, kind, product_id, name, unit_cents, quantity, taxed, added_by)
    values (${s.id}, ${line.kind}, ${line.productId}, ${line.name}, ${line.unitCents}, ${line.quantity}, ${line.taxed}, ${actor.staffId})
    returning id`;
  // A bill that is already totalled moves with it (and a percentage discount with that), and skips
  // an attempt number so the new amount can never reuse an idempotency key Square has seen.
  const bill = s.status === "awaiting_payment" ? await repriceBill(tx, { ...s, items_cents: itemsCents }, actor, { changed: true }) : null;
  if (!bill) await tx`update public.sessions set items_cents = ${itemsCents} where id = ${s.id}`;
  await audit(tx, {
    ...by(actor),
    action: "session.add_item",
    entity: "session",
    entityId: s.id,
    before: { items_cents: s.items_cents, total_cents: s.total_cents, discount_cents: s.discount_kind ? s.discount_cents : undefined },
    after: {
      item_id: item.id,
      kind: line.kind === "product" ? undefined : line.kind,
      product_id: line.productId,
      name: line.name,
      unit_cents: line.unitCents,
      quantity: line.quantity,
      taxed: line.taxed,
      items_cents: itemsCents,
      total_cents: bill ? bill.totalCents : s.total_cents,
      discount_cents: s.discount_kind ? (bill?.discountCents ?? 0) : undefined,
    },
  });
  return { itemId: item.id };
}

/** Takes one line off the bill. The row is kept and stamped with who removed it and when. */
export async function removeItem(actor: Actor, id: string, itemId: string, now = new Date()): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "remove_item");
    await requireOpenToChange(tx, s);

    const [item] = UUID_RE.test(itemId)
      ? await tx<SessionItemRow[]>`
          select id, session_id, kind, product_id, name, unit_cents, quantity, taxed, added_by, added_at, removed_at, removed_by
          from public.session_items where id = ${itemId} and session_id = ${id} for update`
      : [];
    if (!item) throw notFound("That item isn't on this bill.");
    if (item.removed_at) throw conflict("That item has already been taken off the bill.");
    if (item.kind === "split") throw conflict(PART_FIXED_MESSAGE);

    const itemsCents = s.items_cents - item.unit_cents * item.quantity;
    await tx`update public.session_items set removed_at = ${now}, removed_by = ${actor.staffId} where id = ${item.id}`;
    // Same as adding: the total follows, and a changed amount must never reuse an idempotency key
    // Square has seen. Refused (nothing is kept) if it would leave less than has been split off.
    const bill = s.status === "awaiting_payment" ? await repriceBill(tx, { ...s, items_cents: itemsCents }, actor, { changed: true }) : null;
    if (!bill) await tx`update public.sessions set items_cents = ${itemsCents} where id = ${id}`;
    // A table's bill with nothing left on it isn't a bill. (A counter sale may go back to empty:
    // staff can then put the right thing on it, or throw it away.)
    if (bill && s.kind === "table" && bill.tableCents + bill.itemsCents === 0) {
      throw conflict("That would leave nothing on the bill. Ask a manager to void it instead.");
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
        discount_cents: s.discount_kind ? s.discount_cents : undefined,
      },
      after: {
        item_id: item.id,
        removed_at: now,
        items_cents: itemsCents,
        total_cents: bill ? bill.totalCents : s.total_cents,
        discount_cents: s.discount_kind ? (bill?.discountCents ?? 0) : undefined,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

/** The most a discount typed in at the till (or a variable one from Square) can take off: $2,000. */
export const DISCOUNT_AMOUNT_MAX_CENTS = 200_000;
const HAS_PARTS_MESSAGE = "This bill has been split, so its discount can't change. Merge the parts back first.";
const PART_SETTLED_MESSAGE = "A share of this bill has already been paid or written off, so its discount can't be changed.";

export type DiscountChoice =
  /** A discount from the Square catalogue. `value` only for a variable one (basis points or cents). */
  | { discountId: string; value?: number }
  /** Typed in by a manager. `value` is basis points for a percentage, cents for an amount. */
  | { custom: { name: string; kind: "percent" | "amount"; value: number } };

interface ResolvedDiscount {
  id: string | null;
  name: string;
  kind: "percent" | "amount";
  value: number;
  approvedBy: string | null;
}

function checkDiscountValue(kind: "percent" | "amount", value: number): void {
  if (!Number.isInteger(value) || value < 1) throw badRequest("Enter how much the discount is.");
  if (kind === "percent" && value > 10_000) throw badRequest("A discount can't be more than 100%.");
  if (kind === "amount" && value > DISCOUNT_AMOUNT_MAX_CENTS) throw badRequest("A discount can't be more than $2,000.");
}

/** Turns what staff picked into the discount to store, and decides whether it needed a manager. */
async function resolveDiscount(tx: Tx, choice: DiscountChoice, manager: Manager | null): Promise<ResolvedDiscount> {
  const needManager = () => forbidden("A manager PIN is needed for this discount.");
  if ("custom" in choice) {
    if (!manager) throw needManager();
    const name = choice.custom.name.trim();
    if (name.length < 1 || name.length > 60) throw badRequest("Give the discount a name, up to 60 characters.");
    if (choice.custom.kind !== "percent" && choice.custom.kind !== "amount") throw badRequest("Pick a percentage or an amount.");
    checkDiscountValue(choice.custom.kind, choice.custom.value);
    return { id: null, name, kind: choice.custom.kind, value: choice.custom.value, approvedBy: manager.id };
  }

  const [row] = await tx<DiscountRow[]>`
    select id, name, kind, value, active from public.discounts where id = ${choice.discountId}`;
  if (!row) throw notFound("That discount isn't on the list.");
  if (!row.active) throw conflict(`${row.name} isn't offered any more. Pick another discount.`);

  if (row.kind === "percent" || row.kind === "amount") {
    // Fixed in Square: any staff member can apply it, and nobody can change what it is worth here.
    if (choice.value !== undefined) throw badRequest(`${row.name} has a set value in Square. It can't be changed here.`);
    if (row.value === null) throw conflict(`${row.name} has no value set in Square.`);
    return { id: row.id, name: row.name, kind: row.kind, value: row.value, approvedBy: null };
  }

  if (!manager) throw needManager();
  const kind = row.kind === "variable_percent" ? "percent" : "amount";
  if (choice.value === undefined) throw badRequest("Enter how much the discount is.");
  checkDiscountValue(kind, choice.value);
  return { id: row.id, name: row.name, kind, value: choice.value, approvedBy: manager.id };
}

const discountView = (s: Pick<SessionRow, "discount_id" | "discount_name" | "discount_kind" | "discount_value">) =>
  s.discount_kind ? { id: s.discount_id, name: s.discount_name, kind: s.discount_kind, value: s.discount_value } : null;

/** What putting a discount on, or taking it off, needs first. */
async function requireDiscountable(tx: Tx, s: SessionRow): Promise<void> {
  if (s.kind === "part") throw conflict("A share of a split bill can't be discounted. Merge it back and discount the bill it came from.");
  if (s.split_off_cents > 0) {
    // Say what staff can actually do about it. Unpaid parts can be merged back; one that has been
    // paid, or written off by a manager, can't, so "merge them back" would be a dead end.
    const [settled] = await tx<{ id: string }[]>`
      select id from public.sessions
      where split_of = ${s.id} and not merged and status <> 'awaiting_payment' limit 1`;
    throw conflict(settled ? PART_SETTLED_MESSAGE : HAS_PARTS_MESSAGE);
  }
  if ((await getCheckouts(tx, s.id)).some((c) => isCheckoutLive(c.status))) throw conflict(CHECKOUT_LIVE_MESSAGE);
  await refuseDuringCashHandoff(tx, s);
}

/**
 * Puts a discount on a bill, replacing any already there. One per bill, off the whole bill.
 * `manager` is whoever's PIN came with the request, if one did: a fixed discount from Square needs
 * none; a variable one, or one typed in, does.
 */
export async function setDiscount(actor: Actor, manager: Manager | null, id: string, choice: DiscountChoice): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "set_discount");
    await requireDiscountable(tx, s);
    const d = await resolveDiscount(tx, choice, manager);

    await tx`
      update public.sessions set
        discount_id = ${d.id}, discount_name = ${d.name}, discount_kind = ${d.kind}, discount_value = ${d.value},
        discount_by = ${actor.staffId}, discount_approved_by = ${d.approvedBy}
      where id = ${id}`;
    const next: SessionRow = {
      ...s,
      discount_id: d.id,
      discount_name: d.name,
      discount_kind: d.kind,
      discount_value: d.value,
      discount_by: actor.staffId,
      discount_approved_by: d.approvedBy,
    };
    // While the session runs there is no total yet: the discount is worked out when it stops.
    const bill = s.status === "awaiting_payment" ? await repriceBill(tx, next, actor, { changed: true }) : null;
    await audit(tx, {
      ...by(actor),
      approvedByStaffId: d.approvedBy,
      action: "session.set_discount",
      entity: "session",
      entityId: id,
      before: { discount: discountView(s), discount_cents: s.discount_cents, total_cents: s.total_cents },
      after: { discount: discountView(next), discount_cents: bill?.discountCents ?? 0, total_cents: bill ? bill.totalCents : s.total_cents },
    });
  });
}

export async function removeDiscount(actor: Actor, id: string): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "remove_discount");
    await requireDiscountable(tx, s);
    if (!s.discount_kind) throw conflict("There's no discount on this bill.");

    await tx`
      update public.sessions set
        discount_id = null, discount_name = null, discount_kind = null, discount_value = null,
        discount_by = null, discount_approved_by = null, discount_cents = 0
      where id = ${id}`;
    const next: SessionRow = {
      ...s,
      discount_id: null,
      discount_name: null,
      discount_kind: null,
      discount_value: null,
      discount_by: null,
      discount_approved_by: null,
      discount_cents: 0,
    };
    const bill = s.status === "awaiting_payment" ? await repriceBill(tx, next, actor, { changed: true }) : null;
    await audit(tx, {
      ...by(actor),
      action: "session.remove_discount",
      entity: "session",
      entityId: id,
      before: { discount: discountView(s), discount_cents: s.discount_cents, total_cents: s.total_cents },
      after: { discount: null, discount_cents: 0, total_cents: bill ? bill.totalCents : s.total_cents },
    });
  });
}

// ---------------------------------------------------------------------------
// Counter sales
// ---------------------------------------------------------------------------

/**
 * A sale with no table. Opens an empty bill that is already awaiting payment: it has no timer, no
 * intervals and no rates to capture, so it never passes through running. Items, custom charges and
 * a discount then go on it like on any other bill.
 */
export async function openCounterSale(actor: Actor, now = new Date()): Promise<{ sessionId: string }> {
  return withTx(async (tx) => {
    const [s] = await tx<SessionRow[]>`
      insert into public.sessions
        (kind, status, current_table_id, opened_at, opened_by, closed_at, closed_by, billed_minutes, total_cents)
      values ('counter', 'awaiting_payment', null, ${now}, ${actor.staffId}, ${now}, ${actor.staffId}, 0, 0)
      returning *`;
    await audit(tx, {
      ...by(actor),
      action: "session.counter_sale",
      entity: "session",
      entityId: s.id,
      after: auditView(s),
    });
    return { sessionId: s.id };
  });
}

/**
 * Throws away a counter sale that was opened and never used. Any staff member can: nothing is
 * being written off. Anything that has (or had) money moving on it needs a manager's void instead.
 */
export async function discardCounterSale(actor: Actor, id: string, now = new Date()): Promise<void> {
  await withTx(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "discard");
    const refuse = (why: string) => conflict(`Only an empty counter sale can be thrown away. ${why}`);
    if (s.kind !== "counter") throw refuse("Ask a manager to void this bill.");
    const [lines] = await tx<{ n: number }[]>`
      select count(*)::int as n from public.session_items where session_id = ${id} and removed_at is null`;
    if (s.items_cents !== 0 || (lines?.n ?? 0) > 0) throw refuse("Take everything off it first.");
    if (s.split_off_cents !== 0) throw refuse("This one has been split: merge the parts back first.");
    // Anything ever sent to the Terminal or to Square POS could still turn into a payment.
    if ((await getCheckouts(tx, id)).length > 0) throw refuse("A card request was sent for this one, so a manager needs to void it.");
    const [handoff] = await tx<{ id: string }[]>`
      select id::text as id from public.audit_log
      where entity = 'session' and entity_id = ${id} and action = 'cash.handoff_started' limit 1`;
    if (handoff) throw refuse("This one was sent to Square POS for cash, so a manager needs to void it.");

    await tx`
      update public.sessions set
        status = 'void', voided_at = ${now}, voided_by = ${actor.staffId}, void_reason = ${DISCARD_REASON}
      where id = ${id}`;
    await audit(tx, {
      ...by(actor),
      action: "session.discard",
      entity: "session",
      entityId: id,
      before: auditView(s),
      after: { status: "void", voided_by: actor.staffId },
      reason: DISCARD_REASON,
    });
  });
}

// ---------------------------------------------------------------------------
// Split bills
// ---------------------------------------------------------------------------

/** session_items.unit_cents holds at most $10,000, and a part's one line is its whole amount. */
const SHARE_MAX_CENTS = 1_000_000;
/** A bill can have this many parts standing at once. Far more than a table of friends needs. */
const MAX_STANDING_PARTS = 30;

/**
 * Splits a bill awaiting payment: takes money OFF it and puts it on new bills ("parts"), each
 * paid like any other bill. `ways: N` makes N − 1 parts of floor(total / N) and leaves the rest
 * (one share plus any odd cents) on this bill; `amountCents` makes one part of that size.
 *
 * Whatever is passed, this bill and its new parts add up to exactly what this bill was a moment
 * ago. Splitting again later splits what is left.
 */
export async function splitBill(
  actor: Actor,
  id: string,
  /** `expectedTotalCents`: what the screen showed as owed on this bill, if the request said. */
  how: ({ ways: number } | { amountCents: number }) & { expectedTotalCents?: number },
  now = new Date(),
): Promise<{ partIds: string[] }> {
  if ("ways" in how) {
    if (!Number.isInteger(how.ways) || how.ways < 2 || how.ways > 10) throw badRequest("Split a bill between 2 and 10 ways.");
  } else if (!Number.isInteger(how.amountCents) || how.amountCents < 1) {
    throw badRequest("Enter the amount to split off.");
  }
  const result = await withTx<{ partIds: string[] } | BillChanged>(async (tx) => {
    // Only the bill being split is locked; its parts don't exist yet.
    const s = await mustLock(tx, id);
    assertCan(s.status, "split");
    if (s.kind === "part") throw conflict("A share of a split bill can't be split again. Merge it back, then split the bill it came from.");
    if ((await getCheckouts(tx, id)).some((c) => isCheckoutLive(c.status))) throw conflict(CHECKOUT_LIVE_MESSAGE);
    await refuseDuringCashHandoff(tx, s);

    // The bill as it stands right now is what gets shared out.
    const before = await repriceBill(tx, s, actor);
    const total = before.totalCents;
    // Two iPads both showing $60 and both tapping "Split 2 ways": the second one is told the bill
    // has changed instead of quietly splitting the $30 the first one left.
    if (totalHasMoved(how.expectedTotalCents, total)) return { kind: "bill_changed" };
    if (total <= 0) throw conflict("There's nothing left on this bill to split.");

    let amounts: number[];
    if ("ways" in how) {
      const share = Math.floor(total / how.ways);
      if (share < 1) throw conflict(`${dollars(total)} is too little to split ${how.ways} ways.`);
      amounts = Array.from({ length: how.ways - 1 }, () => share);
    } else {
      if (how.amountCents >= total) throw conflict(`The share has to be less than what is on the bill (${dollars(total)}).`);
      amounts = [how.amountCents];
    }
    if (amounts.some((a) => a > SHARE_MAX_CENTS)) throw conflict("One share can be $10,000 at most.");
    const [standing] = await tx<{ n: number }[]>`
      select count(*)::int as n from public.sessions where split_of = ${id} and not merged`;
    if ((standing?.n ?? 0) + amounts.length > MAX_STANDING_PARTS) {
      throw conflict("This bill has been split into too many parts. Merge some back first.");
    }

    // "Table 3 · share". Kept on the part's one line; trimmed to fit that column (120 characters).
    const label = await billLabel(tx, s, before.intervals);
    const name = `${label.slice(0, 100)} · share`;
    const parts: { id: string; amount_cents: number }[] = [];
    for (const amount of amounts) {
      const [part] = await tx<{ id: string }[]>`
        insert into public.sessions
          (kind, split_of, status, current_table_id, opened_at, opened_by, closed_at, closed_by,
           billed_minutes, total_cents, items_cents)
        values ('part', ${id}, 'awaiting_payment', null, ${now}, ${actor.staffId}, ${now}, ${actor.staffId},
                0, ${amount}, ${amount})
        returning id`;
      await tx`
        insert into public.session_items (session_id, kind, product_id, name, unit_cents, quantity, taxed, added_by, added_at)
        values (${part.id}, 'split', null, ${name}, ${amount}, 1, true, ${actor.staffId}, ${now})`;
      parts.push({ id: part.id, amount_cents: amount });
    }

    const splitOff = amounts.reduce((a, b) => a + b, 0);
    const after = await repriceBill(tx, { ...s, split_off_cents: s.split_off_cents + splitOff }, actor, { changed: true });
    if (after.totalCents + splitOff !== total) {
      // Can't happen: the discount is on the base, which a split doesn't touch. If it ever did,
      // money would appear or vanish, so nothing is kept.
      throw new Error(`split of ${id} does not add up: ${after.totalCents} + ${splitOff} != ${total}`);
    }

    await audit(tx, {
      ...by(actor),
      action: "session.split",
      entity: "session",
      entityId: id,
      before: { total_cents: total, split_off_cents: s.split_off_cents },
      after: {
        ...("ways" in how ? { ways: how.ways } : { amount_cents: how.amountCents }),
        parts,
        split_off_cents: after.splitOffCents,
        total_cents: after.totalCents,
      },
    });
    for (const p of parts) {
      await audit(tx, {
        ...by(actor),
        action: "session.split_off",
        entity: "session",
        entityId: p.id,
        after: { split_of: id, label: name, total_cents: p.amount_cents, status: "awaiting_payment" },
      });
    }
    return { partIds: parts.map((p) => p.id) };
  });
  if ("kind" in result) throw billChanged();
  return result;
}

/**
 * Folds a part that hasn't been paid back into the bill it came from. The part becomes void (and
 * `merged`: it is not a write-off), and its amount goes back on the bill.
 *
 * Locks the PARENT first and then the part. Every path that holds both takes them in that order.
 */
export async function mergeBack(actor: Actor, partId: string, now = new Date()): Promise<void> {
  if (!UUID_RE.test(partId)) throw notFound("Session not found.");
  await withTx(async (tx) => {
    // Unlocked read, only to learn which bill to lock first. `split_of` never changes.
    const [ref] = await tx<{ kind: string; split_of: string | null }[]>`
      select kind, split_of from public.sessions where id = ${partId}`;
    if (!ref) throw notFound("Session not found.");
    if (ref.kind !== "part" || !ref.split_of) throw conflict("Only a share of a split bill can be merged back.");

    const parent = await mustLock(tx, ref.split_of);
    const part = await mustLock(tx, partId);
    assertCan(part.status, "merge_back");
    if ((await getCheckouts(tx, part.id)).some((c) => isCheckoutLive(c.status))) {
      throw conflict("Cancel the card request on the Terminal for this share first.");
    }
    await refuseDuringCashHandoff(tx, part, "this share");

    if (parent.status === "paid") {
      throw conflict("The rest of this bill has been paid, so this share can't go back on it. Take payment for the share, or ask a manager to void it.");
    }
    if (parent.status !== "awaiting_payment") {
      throw conflict("The bill this share came from has been voided, so the share can't go back on it. Take payment for the share, or ask a manager to void it.");
    }
    if ((await getCheckouts(tx, parent.id)).some((c) => isCheckoutLive(c.status))) {
      throw conflict("The bill this share came from is on the Terminal. Cancel that card request first.");
    }
    await refuseDuringCashHandoff(tx, parent, "the bill this share came from");

    const amount = part.total_cents ?? 0;
    if (amount <= 0 || amount > parent.split_off_cents) {
      throw new Error(`part ${part.id} (${amount}) does not fit what was split off ${parent.id} (${parent.split_off_cents})`);
    }

    await tx`
      update public.sessions set
        status = 'void', merged = true, voided_at = ${now}, voided_by = ${actor.staffId}, void_reason = ${MERGED_REASON}
      where id = ${part.id}`;
    const after = await repriceBill(tx, { ...parent, split_off_cents: parent.split_off_cents - amount }, actor, { changed: true });

    await audit(tx, {
      ...by(actor),
      action: "session.merge_back",
      entity: "session",
      entityId: parent.id,
      before: { total_cents: parent.total_cents, split_off_cents: parent.split_off_cents },
      after: { part_id: part.id, amount_cents: amount, split_off_cents: after.splitOffCents, total_cents: after.totalCents },
    });
    await audit(tx, {
      ...by(actor),
      action: "session.merged_back",
      entity: "session",
      entityId: part.id,
      before: auditView(part),
      after: { status: "void", merged: true, split_of: parent.id },
      reason: MERGED_REASON,
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
    /**
     * The bill's total as the screen showed it when staff tapped, if the request said. Refused
     * (409 `bill_changed`, nothing done) if the bill is no longer that amount.
     */
    expectedTotalCents?: number;
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
    // Before anything is cancelled or recorded. Marking paid settles the stored total as it is (it
    // never re-prices), and the stored total is what the screen was showing, so that is what the
    // expectation is held against.
    if (totalHasMoved(opts.expectedTotalCents, s.total_cents)) throw billChanged();

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
        // A bill discounted to nothing: closed, with no money taken and nothing sent to Square.
        nothing_to_pay: billCents === 0 ? true : undefined,
      },
      reason:
        [
          billCents === 0 ? "Closed with nothing to pay: the bill came to $0.00." : null,
          live.cancelPending ? "Marked paid while the Terminal was still cancelling a card request." : null,
        ]
          .filter((r) => r !== null)
          .join(" ") || null,
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
  // Worked out the same way a card charge is, but read-only: marking a bill paid must never fail
  // or change the amount staff were just shown. If the bill can't be worked out, or doesn't come
  // to what was collected against, the sale goes to Square as a plain amount instead.
  let bill: PricedBill | null = null;
  try {
    bill = await priceBill(tx, s);
  } catch (e) {
    console.warn("[square] cash sale queued as a plain amount: the bill couldn't be itemised", s.id, e instanceof Error ? e.message : e);
  }
  const intervals = bill?.intervals ?? (s.kind === "table" ? await getIntervals(tx, s.id) : []);
  const note = await sessionNote(tx, s, intervals, s.billed_minutes ?? 0);
  let order: SquareOrderBody | null = null;
  if (bill && bill.totalCents === billCents && (await getSettings(tx)).itemiseCharges) {
    const { table_hire_variation_id: tableHireVariationId } = await getCatalogState(tx);
    order = await squareOrderBody(tx, s, bill, note, tableHireVariationId);
  }
  return enqueueCashRecord(tx, {
    sessionId: s.id,
    amountCents: cashCents,
    billCents,
    note,
    lines: order?.lines ?? null,
    discount: order?.discount ?? null,
    staffId: actor.staffId,
    holdSeconds,
  });
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
    // A refund has sent (or is sending) money back against this payment. Reopening the bill would
    // let it be paid and refunded all over again, and for cash the outbox would refund the whole
    // sale on top. Refunds are written under this same lock, so the check can't be raced. A refund
    // that failed doesn't count: nothing went back.
    const [refund] = await tx<{ id: string }[]>`
      select id from public.refunds where session_id = ${id} and state <> 'failed' limit 1`;
    if (refund || s.refunded_cents > 0) throw conflict("This bill has refunds on it, so it can't be reopened.");
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
    requireTimer(s, "edit");
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
      // Changing the times re-prices the table time; the items stay as they are, a percentage
      // discount follows the new bill, and an attempt number is skipped so a new amount can never
      // reuse an idempotency key Square has seen. Refused if it would leave less on the bill than
      // has been split off it.
      const bill = await repriceBill(tx, await mustLock(tx, id), actor, { changed: true });
      totalCents = bill.totalCents;
      billedMinutes = bill.billedMinutes;
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
