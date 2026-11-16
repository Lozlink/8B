import "server-only";
import { assertCan, isCheckoutLive, isCheckoutStatus, type CheckoutStatus } from "@/lib/domain/machine";
import type { MarkPaidOutcome, SettledMethod } from "@/lib/domain/types";
import { formatDuration, makeSnapshot, price, type PriceResult, type PricingInterval } from "@/lib/pricing";
import { formatTime } from "@/lib/format";
import * as terminal from "@/lib/square/terminal";
import type { SquareCheckoutState } from "@/lib/square/terminal";
import type { Actor, Manager } from "./auth";
import { audit } from "./audit";
import { db, withTx, type Db, type Tx } from "./db";
import { badRequest, conflict, notFound, AppError } from "./errors";
import {
  auditView,
  getCheckouts,
  getIntervals,
  getPricingConfig,
  getSettings,
  lockSession,
  pricingSettingsOf,
  tableNames,
  type CheckoutRow,
  type IntervalRow,
  type SessionRow,
} from "./repo";

// ---------------------------------------------------------------------------
// Square Terminal gateway (swappable in tests)
// ---------------------------------------------------------------------------

export interface TerminalGateway {
  create: typeof terminal.createTerminalCheckout;
  get: typeof terminal.getTerminalCheckout;
  cancel: typeof terminal.cancelTerminalCheckout;
}

let gateway: TerminalGateway = {
  create: terminal.createTerminalCheckout,
  get: terminal.getTerminalCheckout,
  cancel: terminal.cancelTerminalCheckout,
};

export function setTerminalGatewayForTests(g: TerminalGateway): void {
  gateway = g;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const by = (a: Actor) => ({ actorStaffId: a.staffId, deviceLabel: a.deviceLabel });

async function mustLock(tx: Tx, id: string): Promise<SessionRow> {
  if (!UUID_RE.test(id)) throw notFound("Session not found.");
  const s = await lockSession(tx, id);
  if (!s) throw notFound("Session not found.");
  return s;
}

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

/** Re-prices a closed session from the rates captured at stop, so the bill can't drift. */
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

    if (result.totalCents === 0) {
      // Nothing to charge (zero time or inside the grace period). Close it as a no-charge void so
      // the record, the times and the reason all stay visible in the daily summary.
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
        billed_minutes = ${result.billedMinutes}, total_cents = ${result.totalCents},
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
        total_cents: result.totalCents,
        lines: result.lines,
      },
    });
    return { status: "awaiting_payment", billedMinutes: result.billedMinutes, totalCents: result.totalCents };
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
 */
async function applyCheckoutState(
  tx: Tx,
  s: SessionRow,
  row: CheckoutRow,
  state: Pick<SquareCheckoutState, "status" | "cancelReason">,
  source: Source,
  actor: Actor | null,
): Promise<boolean> {
  const next = RANK[state.status] > RANK[row.status] ? state.status : row.status;
  const cancelReason = next === "CANCELED" ? state.cancelReason : row.cancel_reason;
  await tx`
    update public.terminal_checkouts
    set status = ${next}, cancel_reason = ${cancelReason}, last_synced_at = now()
    where id = ${row.id}`;
  if (next === row.status) return false;

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
    });
    return false;
  }

  if (s.status === "awaiting_payment") {
    const now = new Date();
    await tx`
      update public.sessions set
        status = 'paid', settled_method = 'card', settled_via = ${source}, settled_by = null,
        settled_at = ${now}, current_table_id = null
      where id = ${s.id}`;
    await audit(tx, {
      ...base,
      action: "session.paid",
      before: auditView(s),
      after: { ...checkoutInfo, status: "paid", settled_method: "card", settled_via: source, settled_at: now },
    });
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
    const settledBySquare = s.settled_via === "square_webhook" || s.settled_via === "square_api";
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
            ? "A card payment completed on the Terminal after this session was marked paid in cash. Check for a double payment and refund one in Square."
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

interface LiveResolution {
  /** A live checkout turned out to be COMPLETED — the session is now paid by card. */
  completed: boolean;
  /** Still waiting on the Terminal to confirm a cancel. */
  cancelPending: boolean;
  warnings: string[];
}

/** Cancels every live checkout for the session, reconciling with what Square says happened. */
async function cancelLiveCheckouts(tx: Tx, s: SessionRow, actor: Actor): Promise<LiveResolution> {
  const res: LiveResolution = { completed: false, cancelPending: false, warnings: [] };
  const live = (await getCheckouts(tx, s.id)).filter((c) => isCheckoutLive(c.status));
  for (const c of live) {
    let state: SquareCheckoutState;
    try {
      state = await gateway.cancel(c.id);
    } catch (e) {
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

function buildNote(tables: string[], billedMinutes: number, openedAt: Date, closedAt: Date | null, tz: string): string {
  const times = `${formatTime(openedAt, tz)}–${closedAt ? formatTime(closedAt, tz) : "now"}`;
  return [tables.join(" → "), formatDuration(billedMinutes * 60_000), times].join(" · ");
}

/** Prices, sends a new checkout attempt to the Terminal and records it. Caller holds the lock. */
async function sendAttempt(tx: Tx, s: SessionRow, actor: Actor, deviceId: string): Promise<SquareCheckoutState> {
  const intervals = await getIntervals(tx, s.id);
  const r = repriceClosed(s, intervals);
  if (r.totalCents !== s.total_cents || r.billedMinutes !== s.billed_minutes) {
    await tx`
      update public.sessions set total_cents = ${r.totalCents}, billed_minutes = ${r.billedMinutes}
      where id = ${s.id}`;
    await audit(tx, {
      ...by(actor),
      action: "session.repriced",
      entity: "session",
      entityId: s.id,
      before: { total_cents: s.total_cents, billed_minutes: s.billed_minutes },
      after: { total_cents: r.totalCents, billed_minutes: r.billedMinutes },
    });
  }
  if (r.totalCents <= 0) throw conflict("There's nothing to charge on this bill.");

  const attempt = s.checkout_attempt + 1;
  const tableIds = [...new Set(intervals.map((i) => i.table_id))];
  const names = await tableNames(tx, tableIds);
  const tz = s.rate_snapshot?.settings.timezone ?? "Australia/Sydney";
  const note = buildNote(
    intervals.map((i) => names.get(i.table_id) ?? "Table").filter((n, idx, arr) => arr.indexOf(n) === idx),
    r.billedMinutes,
    s.opened_at,
    s.closed_at,
    tz,
  );

  // The Square call happens while we hold the row lock. If it fails, the transaction rolls back and
  // the attempt number isn't consumed, so a retry reuses the same idempotency key and Square
  // returns the checkout it may already have created instead of making a second one.
  const co = await gateway.create({
    idempotencyKey: `${s.id}-a${attempt}`,
    amountCents: r.totalCents,
    deviceId,
    referenceId: s.id,
    note,
  });

  const [row] = await tx<CheckoutRow[]>`
    insert into public.terminal_checkouts (id, session_id, attempt, amount_cents, status, created_by)
    values (${co.id}, ${s.id}, ${attempt}, ${r.totalCents}, 'PENDING', ${actor.staffId})
    returning *`;
  await tx`
    update public.sessions set square_checkout_id = ${co.id}, checkout_attempt = ${attempt}
    where id = ${s.id}`;
  await audit(tx, {
    ...by(actor),
    action: "checkout.sent",
    entity: "session",
    entityId: s.id,
    after: { checkout_id: co.id, attempt, amount_cents: r.totalCents, note },
  });
  if (co.status !== "PENDING") {
    // Idempotent replay of a checkout that already moved on.
    await applyCheckoutState(tx, { ...s, total_cents: r.totalCents }, row, co, "square_api", actor);
  }
  return co;
}

export type ChargeOutcome =
  | { kind: "sent"; checkoutId: string; amountCents: number }
  | { kind: "already_paid_by_card" };

export async function chargeCard(actor: Actor, id: string): Promise<ChargeOutcome> {
  return withTx(async (tx) => {
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
    const co = await sendAttempt(tx, s, actor, settings.terminalDeviceId);
    if (co.status === "COMPLETED") return { kind: "already_paid_by_card" };
    return { kind: "sent", checkoutId: co.id, amountCents: co.amountCents };
  });
}

type Refused = { kind: "refused"; message: string };

export async function resendCheckout(actor: Actor, id: string): Promise<ChargeOutcome> {
  const result = await withTx<ChargeOutcome | Refused>(async (tx) => {
    const s = await mustLock(tx, id);
    assertCan(s.status, "resend_checkout");
    const settings = await getSettings(tx);
    if (!settings.terminalDeviceId) throw conflict("No Terminal is paired.");
    const r = await cancelLiveCheckouts(tx, s, actor);
    if (r.completed) return { kind: "already_paid_by_card" };
    if (r.cancelPending || r.warnings.length > 0) {
      // Never put a second request on the Terminal while the first could still take money. Return
      // (not throw) so the cancel we already sent to Square — its status and audit row — commits.
      return {
        kind: "refused",
        message:
          r.warnings[0] ??
          "The Terminal is still cancelling the previous request (this can take up to a minute if a card was being presented). Try again shortly.",
      };
    }
    const fresh = await mustLock(tx, id);
    const co = await sendAttempt(tx, fresh, actor, settings.terminalDeviceId);
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
  const state = await gateway.get(checkoutId);
  await withTx(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (!s) return;
    const [c] = await tx<CheckoutRow[]>`
      select * from public.terminal_checkouts where id = ${checkoutId} and session_id = ${sessionId} for update`;
    if (!c || !isCheckoutLive(c.status)) return; // settled meanwhile (webhook / another iPad)
    await applyCheckoutState(tx, s, c, state, "square_api", actor);
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
  payload: { id: string; status: string; referenceId: string | null; cancelReason: string | null; amountCents?: number | null },
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
        insert into public.terminal_checkouts (id, session_id, attempt, amount_cents, status)
        values (${payload.id}, ${s.id}, ${attempt}, ${amount}, 'PENDING')
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
        after: { checkout_id: payload.id, attempt, amount_cents: amount, square_status: payload.status },
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
// Staff settlement
// ---------------------------------------------------------------------------

export async function markPaid(
  actor: Actor,
  id: string,
  method: SettledMethod,
  opts: { cardConfirmed: boolean },
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

    await tx`
      update public.sessions set
        status = 'paid', settled_method = ${method}, settled_via = 'staff', settled_by = ${actor.staffId},
        settled_at = ${now}, current_table_id = null
      where id = ${id}`;
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
        card_confirmed_by_staff: method === "card" ? true : undefined,
      },
      reason: live.cancelPending ? "Marked paid while the Terminal was still cancelling a card request." : null,
    });
    const warnings = [...live.warnings];
    if (live.cancelPending) {
      warnings.push("The Terminal was still cancelling the card request. If the customer taps their card anyway, the app will flag it.");
    }
    return { kind: "paid", method, via: "staff", warnings };
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
    await tx`
      update public.sessions set
        status = 'awaiting_payment', settled_method = null, settled_via = null, settled_by = null, settled_at = null
      where id = ${id}`;
    await audit(tx, {
      ...by(actor),
      approvedByStaffId: manager.id,
      action: "session.reverse_paid",
      entity: "session",
      entityId: id,
      before: auditView(s),
      after: { status: "awaiting_payment" },
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
      totalCents = r.totalCents;
      billedMinutes = r.billedMinutes;
      // Skip an attempt number so a new amount can never reuse an idempotency key Square has seen.
      await tx`
        update public.sessions set total_cents = ${r.totalCents}, billed_minutes = ${r.billedMinutes},
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
