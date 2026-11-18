import "server-only";
import { parseLocalTime, type PricingRateCard, type PricingSettings, type RateSnapshot } from "@/lib/pricing";
import { PG, pgCode, type Db } from "./db";
import { AppError } from "./errors";
import type { CheckoutStatus, SessionStatus } from "@/lib/domain/machine";
import type { BillKind, SettledMethod, SettledVia } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Settings & rate cards
// ---------------------------------------------------------------------------

export interface Settings extends PricingSettings {
  businessDayStartMinute: number;
  terminalDeviceId: string | null;
  /** Send charges to Square as an itemised order rather than a single amount. */
  itemiseCharges: boolean;
}

interface SettingsRow {
  rounding_minutes: number;
  grace_minutes: number;
  minimum_minutes: number;
  timezone: string;
  business_day_start: string;
  terminal_device_id: string | null;
  itemise_charges: boolean;
}

export async function getSettings(q: Db): Promise<Settings> {
  const [r] = await q<SettingsRow[]>`
    select rounding_minutes, grace_minutes, minimum_minutes, timezone,
           business_day_start::text as business_day_start, terminal_device_id, itemise_charges
    from public.settings where id`;
  if (!r) throw new Error("settings row missing — run the reference-data migration");
  return {
    roundingMinutes: r.rounding_minutes,
    graceMinutes: r.grace_minutes,
    minimumMinutes: r.minimum_minutes,
    timezone: r.timezone,
    businessDayStartMinute: parseLocalTime(r.business_day_start),
    terminalDeviceId: r.terminal_device_id,
    itemiseCharges: r.itemise_charges,
  };
}

export function pricingSettingsOf(s: Settings): PricingSettings {
  return {
    roundingMinutes: s.roundingMinutes,
    graceMinutes: s.graceMinutes,
    minimumMinutes: s.minimumMinutes,
    timezone: s.timezone,
  };
}

export interface RateCardRow {
  id: string;
  name: string;
  cents_per_hour: number;
  days_of_week: number[];
  start_local: string;
  end_local: string;
  priority: number;
  active: boolean;
}

export function mapRateCard(r: RateCardRow): PricingRateCard {
  return {
    id: r.id,
    name: r.name,
    centsPerHour: r.cents_per_hour,
    daysOfWeek: r.days_of_week.map(Number),
    startMinute: parseLocalTime(r.start_local),
    endMinute: parseLocalTime(r.end_local),
    priority: r.priority,
    active: r.active,
  };
}

export async function getRateCards(q: Db, opts: { activeOnly: boolean }): Promise<PricingRateCard[]> {
  const rows = await q<RateCardRow[]>`
    select id, name, cents_per_hour, days_of_week, start_local::text as start_local,
           end_local::text as end_local, priority, active
    from public.rate_cards
    where ${opts.activeOnly ? q`active` : q`true`}
    order by priority desc, name`;
  return rows.map(mapRateCard);
}

export async function getPricingConfig(q: Db): Promise<{ settings: Settings; rateCards: PricingRateCard[] }> {
  // One after the other on purpose. This is called inside Stop's transaction, and postgres.js sends
  // two queries started together on a transaction's connection back to back (`max_pipeline` only
  // governs the shared pool). Supavisor doesn't answer pipelined queries in transaction mode.
  const settings = await getSettings(q);
  const rateCards = await getRateCards(q, { activeOnly: true });
  return { settings, rateCards };
}

// ---------------------------------------------------------------------------
// Session rows
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  status: SessionStatus;
  current_table_id: string | null;
  opened_at: Date;
  opened_by: string;
  closed_at: Date | null;
  closed_by: string | null;
  billed_minutes: number | null;
  /**
   * What is owed on THIS bill once closed: table time + items_cents − discount_cents −
   * split_off_cents. Only `repriceBill` (sessions.ts) works it out.
   */
  total_cents: number | null;
  /** Sum of the live (not removed) items on the bill. */
  items_cents: number;
  /** Null for counter sales and parts: they have no table time to price. */
  rate_snapshot: RateSnapshot | null;
  kind: BillKind;
  /** On a part: the bill it was split from. */
  split_of: string | null;
  /** On a bill that was split: the amounts of its parts that still stand (not merged back). */
  split_off_cents: number;
  /** A part that was folded back into its bill (it is void, but not a write-off). */
  merged: boolean;
  /** Square catalogue discount id; null with a discount set = typed in by a manager. */
  discount_id: string | null;
  discount_name: string | null;
  discount_kind: "percent" | "amount" | null;
  /** Basis points (percent) or cents (amount). */
  discount_value: number | null;
  /** What the discount takes off. 0 while the session is still running. */
  discount_cents: number;
  discount_by: string | null;
  discount_approved_by: string | null;
  /** Sum of this bill's refunds that have not failed. */
  refunded_cents: number;
  settled_method: SettledMethod | null;
  settled_via: SettledVia | null;
  settled_by: string | null;
  settled_at: Date | null;
  /** What was collected, set exactly while the bill is paid. Cash is rounded to 5c. */
  settled_cents: number | null;
  square_checkout_id: string | null;
  checkout_attempt: number;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
  note: string | null;
}

export interface IntervalRow {
  id: string;
  session_id: string;
  table_id: string;
  started_at: Date;
  ended_at: Date | null;
}

export interface CheckoutRow {
  id: string;
  session_id: string;
  attempt: number;
  amount_cents: number;
  status: CheckoutStatus;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
  last_synced_at: Date | null;
  /** The Square order this attempt was itemised against; null = sent as a plain amount. */
  square_order_id: string | null;
  /**
   * The Square payment this checkout made, stored when it is seen COMPLETED. Null before that, and
   * on rows from before ids were kept (lib/server/payment-ref.ts fetches those on demand).
   */
  square_payment_id: string | null;
}

export interface SessionItemRow {
  id: string;
  session_id: string;
  /** product = a catalogue item; custom = typed in by staff; split = a part's share of its bill. */
  kind: "product" | "custom" | "split";
  /** Set exactly when `kind` is "product". */
  product_id: string | null;
  name: string;
  unit_cents: number;
  quantity: number;
  taxed: boolean;
  added_by: string;
  added_at: Date;
  removed_at: Date | null;
  removed_by: string | null;
}

export interface ProductRow {
  id: string;
  item_id: string;
  name: string;
  price_cents: number;
  taxed: boolean;
  category: string | null;
  sort_order: number;
  active: boolean;
}

export interface CatalogStateRow {
  synced_at: Date | null;
  table_hire_variation_id: string | null;
  last_error: string | null;
}

export const BILL_BUSY_MESSAGE = "Someone else is working on this bill. Give it a few seconds and try again.";

/** What a counter sale is called wherever a table's bill would show its table names. */
export const COUNTER_LABEL = "Counter sale";
/** What a part is called if its one line can't be found (it always can). */
export const PART_FALLBACK_LABEL = "Share of a split bill";
/** Why a thrown-away counter sale is void. The daily summary uses it to tell one from a write-off. */
export const DISCARD_REASON = "Empty counter sale";
/** Why a merged-back part is void. */
export const MERGED_REASON = "Merged back into the bill";

/**
 * Locks and returns a session row for the rest of the transaction. Must be called inside one.
 *
 * Another request can hold this lock for as long as its Square calls take, so the wait is capped
 * at 4 s (`set local`: it lasts until this transaction ends and applies to every later lock wait in it).
 * Running out of time is a 409 staff can act on, not a crash. The webhook route turns any error
 * into a 5xx, so Square still retries an event that lost the race.
 */
export async function lockSession(q: Db, id: string): Promise<SessionRow | null> {
  await q`set local lock_timeout = '4s'`;
  try {
    const [row] = await q<SessionRow[]>`select * from public.sessions where id = ${id} for update`;
    return row ?? null;
  } catch (e) {
    const code = pgCode(e);
    // 55P03: Postgres gave up waiting for the lock. QUERY_TIMEOUT: postgres.js gave up on the
    // statement (the pooler went quiet while we waited).
    if (code === PG.LOCK_NOT_AVAILABLE || code === "QUERY_TIMEOUT") {
      throw new AppError(409, "bill_busy", BILL_BUSY_MESSAGE);
    }
    throw e;
  }
}


export async function getIntervals(q: Db, sessionId: string): Promise<IntervalRow[]> {
  return q<IntervalRow[]>`
    select id, session_id, table_id, started_at, ended_at
    from public.session_intervals where session_id = ${sessionId}
    order by started_at, id`;
}

export async function getCheckouts(q: Db, sessionId: string): Promise<CheckoutRow[]> {
  return q<CheckoutRow[]>`
    select * from public.terminal_checkouts where session_id = ${sessionId} order by attempt`;
}

/** Items currently on the bill (not removed), oldest first. */
export async function getLiveItems(q: Db, sessionId: string): Promise<SessionItemRow[]> {
  return q<SessionItemRow[]>`
    select id, session_id, kind, product_id, name, unit_cents, quantity, taxed, added_by, added_at, removed_at, removed_by
    from public.session_items where session_id = ${sessionId} and removed_at is null
    order by added_at, id`;
}

export interface DiscountRow {
  id: string;
  name: string;
  kind: "percent" | "amount" | "variable_percent" | "variable_amount";
  /** Basis points or cents; null for the variable kinds. */
  value: number | null;
  active: boolean;
}

export async function getDiscounts(q: Db, opts: { activeOnly: boolean }): Promise<DiscountRow[]> {
  return q<DiscountRow[]>`
    select id, name, kind, value, active
    from public.discounts
    where ${opts.activeOnly ? q`active` : q`true`}
    order by lower(name), id`;
}

/**
 * When this bill was last handed to Square POS for cash, if that handoff is still open: it was
 * made in the last 30 minutes (the window in which pos-cash.ts keeps looking for the sale) and
 * nothing since has ended it. Null otherwise. While it is set, Square POS may be holding the
 * amount it was given, so the bill's amount must not change underneath it.
 *
 * A handoff is over once any of these is on the bill's audit trail after it:
 *   - `cash.handoff_canceled`: POS said the sale was cancelled or couldn't be taken;
 *   - `session.paid` / `session.mark_paid`: the bill was settled (by that sale, by hand, or by
 *     card). Whatever happens to the bill afterwards, that handoff has run its course;
 *   - `session.reverse_paid`: a manager reopened it. (Implied by the one above, since a bill can't
 *     be reopened without having been paid; listed so the rule doesn't hang on that.)
 * Without the last two, a bill paid through Square POS and then reopened by a manager would
 * refuse a discount or a split for the rest of the half hour.
 */
export async function cashHandoffInProgress(q: Db, sessionId: string): Promise<Date | null> {
  const [row] = await q<{ at: Date; called_off: boolean }[]>`
    select h.at, exists (
      select 1 from public.audit_log c
      where c.entity = 'session' and c.entity_id = ${sessionId} and c.id > h.id
        and c.action in ('cash.handoff_canceled', 'session.paid', 'session.mark_paid', 'session.reverse_paid')
    ) as called_off
    from public.audit_log h
    where h.entity = 'session' and h.entity_id = ${sessionId} and h.action = 'cash.handoff_started'
      and h.at > now() - interval '30 minutes'
    order by h.id desc limit 1`;
  return row && !row.called_off ? row.at : null;
}

export async function getProducts(q: Db, opts: { activeOnly: boolean }): Promise<ProductRow[]> {
  return q<ProductRow[]>`
    select id, item_id, name, price_cents, taxed, category, sort_order, active
    from public.products
    where ${opts.activeOnly ? q`active` : q`true`}
    order by sort_order, name, id`;
}

export async function getCatalogState(q: Db): Promise<CatalogStateRow> {
  const [r] = await q<CatalogStateRow[]>`
    select synced_at, table_hire_variation_id, last_error from public.catalog_state where id`;
  if (!r) throw new Error("catalog_state row missing — run the session-items migration");
  return r;
}

/** The fields worth recording in the audit trail. */
export function auditView(s: SessionRow) {
  return {
    status: s.status,
    current_table_id: s.current_table_id,
    opened_at: s.opened_at,
    closed_at: s.closed_at,
    billed_minutes: s.billed_minutes,
    total_cents: s.total_cents,
    items_cents: s.items_cents,
    // Only what is set: a plain table bill's audit rows read as they always have.
    kind: s.kind === "table" ? undefined : s.kind,
    split_of: s.split_of ?? undefined,
    split_off_cents: s.split_off_cents || undefined,
    discount: s.discount_kind
      ? { id: s.discount_id, name: s.discount_name, kind: s.discount_kind, value: s.discount_value, cents: s.discount_cents }
      : undefined,
    settled_method: s.settled_method,
    settled_via: s.settled_via,
    settled_by: s.settled_by,
    settled_at: s.settled_at,
    settled_cents: s.settled_cents,
    square_checkout_id: s.square_checkout_id,
    void_reason: s.void_reason,
  };
}

export async function tableNames(q: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await q<{ id: string; name: string }[]>`
    select id, name from public.tables where id = any(${[...ids]}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.name]));
}
