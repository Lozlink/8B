import "server-only";
import { parseLocalTime, type PricingRateCard, type PricingSettings, type RateSnapshot } from "@/lib/pricing";
import type { Db } from "./db";
import type { CheckoutStatus, SessionStatus } from "@/lib/domain/machine";
import type { SettledMethod, SettledVia } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Settings & rate cards
// ---------------------------------------------------------------------------

export interface Settings extends PricingSettings {
  businessDayStartMinute: number;
  terminalDeviceId: string | null;
}

interface SettingsRow {
  rounding_minutes: number;
  grace_minutes: number;
  minimum_minutes: number;
  timezone: string;
  business_day_start: string;
  terminal_device_id: string | null;
}

export async function getSettings(q: Db): Promise<Settings> {
  const [r] = await q<SettingsRow[]>`
    select rounding_minutes, grace_minutes, minimum_minutes, timezone,
           business_day_start::text as business_day_start, terminal_device_id
    from public.settings where id`;
  if (!r) throw new Error("settings row missing — run the reference-data migration");
  return {
    roundingMinutes: r.rounding_minutes,
    graceMinutes: r.grace_minutes,
    minimumMinutes: r.minimum_minutes,
    timezone: r.timezone,
    businessDayStartMinute: parseLocalTime(r.business_day_start),
    terminalDeviceId: r.terminal_device_id,
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
  const [settings, rateCards] = await Promise.all([getSettings(q), getRateCards(q, { activeOnly: true })]);
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
  total_cents: number | null;
  rate_snapshot: RateSnapshot | null;
  settled_method: SettledMethod | null;
  settled_via: SettledVia | null;
  settled_by: string | null;
  settled_at: Date | null;
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
}

/** Locks and returns a session row for the rest of the transaction. */
export async function lockSession(q: Db, id: string): Promise<SessionRow | null> {
  const [row] = await q<SessionRow[]>`select * from public.sessions where id = ${id} for update`;
  return row ?? null;
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

/** The fields worth recording in the audit trail. */
export function auditView(s: SessionRow) {
  return {
    status: s.status,
    current_table_id: s.current_table_id,
    opened_at: s.opened_at,
    closed_at: s.closed_at,
    billed_minutes: s.billed_minutes,
    total_cents: s.total_cents,
    settled_method: s.settled_method,
    settled_via: s.settled_via,
    settled_by: s.settled_by,
    settled_at: s.settled_at,
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
