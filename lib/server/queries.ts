import "server-only";
import type {
  AuditEntryDTO,
  CheckoutDTO,
  FloorDTO,
  IntervalDTO,
  SessionDetailDTO,
  SessionDTO,
  SettledMethod,
  SettledVia,
  SummaryDTO,
  SummarySessionRow,
  TableDTO,
} from "@/lib/domain/types";
import { price, type RateSnapshot } from "@/lib/pricing";
import { businessWindow, currentBusinessDate, formatYMD } from "@/lib/domain/business-day";
import type postgres from "postgres";
import { db, type Db } from "./db";
import { notFound, badRequest } from "./errors";
import { getPricingConfig, getSettings, pricingSettingsOf, type CheckoutRow, type SessionRow } from "./repo";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SessionJoinRow extends SessionRow {
  opened_by_name: string;
  settled_by_name: string | null;
}

function checkoutDTO(c: CheckoutRow): CheckoutDTO {
  return {
    id: c.id,
    attempt: c.attempt,
    amountCents: c.amount_cents,
    status: c.status,
    cancelReason: c.cancel_reason,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
  };
}

/** Loads sessions matching `where` (a fragment over alias `s`) with intervals and latest checkout. */
async function loadSessions(q: Db, where: postgres.Fragment): Promise<SessionDTO[]> {
  const rows = await q<SessionJoinRow[]>`
    select s.*, op.name as opened_by_name, sb.name as settled_by_name
    from public.sessions s
    join public.staff op on op.id = s.opened_by
    left join public.staff sb on sb.id = s.settled_by
    where ${where}
    order by s.opened_at`;
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const checkoutIds = rows.map((r) => r.square_checkout_id).filter((x): x is string => !!x);

  const [intervals, checkouts] = await Promise.all([
    q<{ id: string; session_id: string; table_id: string; table_name: string; started_at: Date; ended_at: Date | null }[]>`
      select i.id, i.session_id, i.table_id, t.name as table_name, i.started_at, i.ended_at
      from public.session_intervals i join public.tables t on t.id = i.table_id
      where i.session_id = any(${ids}::uuid[])
      order by i.started_at, i.id`,
    checkoutIds.length
      ? q<CheckoutRow[]>`select * from public.terminal_checkouts where id = any(${checkoutIds}::text[])`
      : Promise.resolve([] as CheckoutRow[]),
  ]);

  const bySession = new Map<string, IntervalDTO[]>();
  for (const i of intervals) {
    const list = bySession.get(i.session_id) ?? [];
    list.push({
      id: i.id,
      tableId: i.table_id,
      tableName: i.table_name,
      startedAt: i.started_at.toISOString(),
      endedAt: iso(i.ended_at),
    });
    bySession.set(i.session_id, list);
  }
  const checkoutById = new Map(checkouts.map((c) => [c.id, checkoutDTO(c)]));

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    currentTableId: r.current_table_id,
    openedAt: r.opened_at.toISOString(),
    openedByName: r.opened_by_name,
    closedAt: iso(r.closed_at),
    billedMinutes: r.billed_minutes,
    totalCents: r.total_cents,
    settledMethod: r.settled_method,
    settledVia: r.settled_via,
    settledAt: iso(r.settled_at),
    settledByName: r.settled_by_name,
    voidReason: r.void_reason,
    note: r.note,
    intervals: bySession.get(r.id) ?? [],
    checkout: r.square_checkout_id ? checkoutById.get(r.square_checkout_id) ?? null : null,
  }));
}

export async function getFloor(): Promise<FloorDTO> {
  const q = db();
  const [tables, sessions, [unpaid], { settings, rateCards }] = await Promise.all([
    q<{ id: string; name: string; sort_order: number; active: boolean }[]>`
      select id, name, sort_order, active from public.tables
      where active or id in (select current_table_id from public.sessions where current_table_id is not null)
      order by sort_order, name`,
    loadSessions(q, q`s.current_table_id is not null`),
    q<{ n: number }[]>`
      select count(*)::int as n from public.sessions
      where status = 'awaiting_payment' and current_table_id is null`,
    getPricingConfig(q),
  ]);
  return {
    serverTime: new Date().toISOString(),
    tables: tables.map((t): TableDTO => ({ id: t.id, name: t.name, sortOrder: t.sort_order, active: t.active })),
    sessions,
    unpaidOffTableCount: unpaid?.n ?? 0,
    pricing: { settings: pricingSettingsOf(settings), rateCards },
    terminalPaired: !!settings.terminalDeviceId,
  };
}

export async function getUnpaid(): Promise<{ sessions: SessionDTO[]; timezone: string }> {
  const q = db();
  const [sessions, settings] = await Promise.all([
    loadSessions(q, q`s.status = 'awaiting_payment'`),
    getSettings(q),
  ]);
  return { sessions, timezone: settings.timezone };
}

interface AuditJoinRow {
  id: string;
  at: Date;
  actor_name: string | null;
  approved_by_name: string | null;
  device_label: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

function auditDTO(r: AuditJoinRow): AuditEntryDTO {
  return {
    id: String(r.id),
    at: r.at.toISOString(),
    actorName: r.actor_name,
    approvedByName: r.approved_by_name,
    deviceLabel: r.device_label,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    before: r.before,
    after: r.after,
    reason: r.reason,
  };
}

/** Literal prefix for LIKE: %, _ and \ in user input match themselves, never act as wildcards. */
function likePrefix(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
}

export async function getAudit(opts: {
  before?: string;
  entity?: string;
  entityId?: string;
  action?: string;
  limit?: number;
  from?: Date;
  to?: Date;
  actions?: string[];
}): Promise<{ entries: AuditEntryDTO[]; nextBefore: string | null }> {
  const q = db();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const before = opts.before && /^\d+$/.test(opts.before) ? opts.before : null;
  const rows = await q<AuditJoinRow[]>`
    select a.id::text as id, a.at, sa.name as actor_name, sm.name as approved_by_name, a.device_label,
           a.action, a.entity, a.entity_id, a.before, a.after, a.reason
    from public.audit_log a
    left join public.staff sa on sa.id = a.actor_staff_id
    left join public.staff sm on sm.id = a.approved_by_staff_id
    where true
      ${before ? q`and a.id < ${before}::bigint` : q``}
      ${opts.entity ? q`and a.entity = ${opts.entity}` : q``}
      ${opts.entityId ? q`and a.entity_id = ${opts.entityId}` : q``}
      ${opts.action ? q`and a.action like ${likePrefix(opts.action)} escape '\\'` : q``}
      ${opts.actions?.length ? q`and a.action = any(${opts.actions}::text[])` : q``}
      ${opts.from ? q`and a.at >= ${opts.from}` : q``}
      ${opts.to ? q`and a.at < ${opts.to}` : q``}
    order by a.id desc
    limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  return {
    entries: page.map(auditDTO),
    nextBefore: rows.length > limit ? page[page.length - 1]?.id ?? null : null,
  };
}

export async function getSessionDetail(id: string): Promise<SessionDetailDTO> {
  if (!UUID_RE.test(id)) throw notFound("Session not found.");
  const q = db();
  const [session] = await loadSessions(q, q`s.id = ${id}`);
  if (!session) throw notFound("Session not found.");

  const [[snapRow], checkouts, audit] = await Promise.all([
    q<{ rate_snapshot: RateSnapshot | null; closed_at: Date | null }[]>`
      select rate_snapshot, closed_at from public.sessions where id = ${id}`,
    q<CheckoutRow[]>`select * from public.terminal_checkouts where session_id = ${id} order by attempt`,
    getAudit({ entity: "session", entityId: id, limit: 200 }),
  ]);

  let breakdown: SessionDetailDTO["breakdown"] = null;
  if (session.status !== "void" || snapRow?.rate_snapshot) {
    const intervals = session.intervals.map((i) => ({ startedAt: i.startedAt, endedAt: i.endedAt }));
    const snap = snapRow?.rate_snapshot;
    const r = snap
      ? price({ intervals, rateCards: snap.rateCards, settings: snap.settings, now: snapRow?.closed_at ?? new Date() })
      : await (async () => {
          const { settings, rateCards } = await getPricingConfig(q);
          return price({ intervals, rateCards, settings: pricingSettingsOf(settings), now: new Date() });
        })();
    breakdown = {
      billedMinutes: r.billedMinutes,
      totalCents: r.totalCents,
      gstCents: r.gstCents,
      actualMs: r.actualMs,
      lines: r.lines,
    };
  }

  return { session, checkouts: checkouts.map(checkoutDTO), breakdown, audit: audit.entries.reverse() };
}

// ---------------------------------------------------------------------------
// Daily summary (app data only — no Square calls)
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface SummaryRow {
  id: string;
  opened_at: Date;
  closed_at: Date | null;
  billed_minutes: number | null;
  total_cents: number | null;
  table_names: string;
}

export async function getSummary(dateParam: string | null): Promise<SummaryDTO> {
  const q = db();
  const settings = await getSettings(q);
  const tz = settings.timezone;

  let date: { y: number; m: number; d: number };
  if (dateParam) {
    const m = DATE_RE.exec(dateParam);
    if (!m) throw badRequest("date must be YYYY-MM-DD");
    date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  } else {
    date = currentBusinessDate(new Date(), settings.businessDayStartMinute, tz);
  }
  const { from, to } = businessWindow(date, settings.businessDayStartMinute, tz);

  const tableNamesSql = q`
    coalesce((select string_agg(distinct t.name, ' → ')
              from public.session_intervals i join public.tables t on t.id = i.table_id
              where i.session_id = s.id), '') as table_names`;

  const [closed, paid, unpaid, older, voids, attention] = await Promise.all([
    q<{ count: number; minutes: number; cents: number }[]>`
      select count(*)::int as count, coalesce(sum(billed_minutes), 0)::int as minutes,
             coalesce(sum(total_cents), 0)::int as cents
      from public.sessions
      where status <> 'void' and closed_at >= ${from} and closed_at < ${to}`,
    q<(SummaryRow & { settled_method: SettledMethod; settled_via: SettledVia; settled_at: Date; settled_by_name: string | null })[]>`
      select s.id, s.opened_at, s.closed_at, s.billed_minutes, s.total_cents, s.settled_method, s.settled_via,
             s.settled_at, sb.name as settled_by_name, ${tableNamesSql}
      from public.sessions s left join public.staff sb on sb.id = s.settled_by
      where s.status = 'paid' and s.settled_at >= ${from} and s.settled_at < ${to}
      order by s.settled_at`,
    q<SummaryRow[]>`
      select s.id, s.opened_at, s.closed_at, s.billed_minutes, s.total_cents, ${tableNamesSql}
      from public.sessions s
      where s.status = 'awaiting_payment' and s.closed_at >= ${from} and s.closed_at < ${to}
      order by s.closed_at`,
    q<{ count: number; cents: number }[]>`
      select count(*)::int as count, coalesce(sum(total_cents), 0)::int as cents
      from public.sessions where status = 'awaiting_payment' and closed_at < ${from}`,
    q<(SummaryRow & { void_reason: string; voided_by_name: string | null })[]>`
      select s.id, s.opened_at, s.closed_at, s.billed_minutes, s.total_cents, s.void_reason,
             vb.name as voided_by_name, ${tableNamesSql}
      from public.sessions s left join public.staff vb on vb.id = s.voided_by
      where s.status = 'void' and s.voided_at >= ${from} and s.voided_at < ${to}
      order by s.voided_at`,
    getAudit({ from, to, actions: ["payment.conflict", "session.reverse_paid", "checkout.cancel_failed"], limit: 200 }),
  ]);

  const row = (r: SummaryRow): SummarySessionRow => ({
    id: r.id,
    tableNames: r.table_names,
    openedAt: r.opened_at.toISOString(),
    closedAt: iso(r.closed_at),
    billedMinutes: r.billed_minutes,
    totalCents: r.total_cents,
  });
  const sum = (list: { total_cents: number | null }[]) => list.reduce((a, r) => a + (r.total_cents ?? 0), 0);
  const card = paid.filter((p) => p.settled_method === "card");
  const cash = paid.filter((p) => p.settled_method === "cash");
  return {
    businessDate: formatYMD(date),
    from: from.toISOString(),
    to: to.toISOString(),
    sessions: { count: closed[0]?.count ?? 0, billedMinutes: closed[0]?.minutes ?? 0, billedCents: closed[0]?.cents ?? 0 },
    paid: { card: { count: card.length, cents: sum(card) }, cash: { count: cash.length, cents: sum(cash) } },
    paidItems: paid.map((p) => ({
      ...row(p),
      method: p.settled_method,
      via: p.settled_via,
      settledAt: p.settled_at.toISOString(),
      settledByName: p.settled_by_name,
    })),
    unpaid: { count: unpaid.length, cents: sum(unpaid), items: unpaid.map(row) },
    outstandingOlder: { count: older[0]?.count ?? 0, cents: older[0]?.cents ?? 0 },
    voids: {
      count: voids.length,
      items: voids.map((v) => ({ ...row(v), reason: v.void_reason, voidedByName: v.voided_by_name })),
    },
    attention: attention.entries,
  };
}
