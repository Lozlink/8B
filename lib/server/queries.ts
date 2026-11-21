import "server-only";
import { ATTENTION_ACTIONS, attentionChecks } from "./attention";
import type {
  AuditEntryDTO,
  BillKind,
  CheckoutDTO,
  DiscountDTO,
  FloorDTO,
  IntervalDTO,
  PartDTO,
  ProductDTO,
  SessionDetailDTO,
  SessionDTO,
  SessionItemDTO,
  SettledMethod,
  SquareCashDTO,
  SquareCashState,
  SettledVia,
  SummaryDTO,
  SummarySessionRow,
  TableDTO,
} from "@/lib/domain/types";
import { price, type RateSnapshot } from "@/lib/pricing";
import { businessWindow, currentBusinessDate, formatYMD } from "@/lib/domain/business-day";
import type postgres from "postgres";
import { db, type Db } from "./db";
import { posCashConfig } from "./env";
import { notFound, badRequest } from "./errors";
import { NO_REFUND_FACTS, loadRefundFacts } from "./payment-ref";
import { listRefunds, outstandingRefunds, summaryRefunds } from "./refunds";
import { heldStock } from "./stock";
import {
  COUNTER_LABEL,
  DISCARD_REASON,
  PART_FALLBACK_LABEL,
  getDiscounts,
  getPricingConfig,
  getProducts,
  getSettings,
  pricingSettingsOf,
  type CheckoutRow,
  type DiscountRow,
  type ProductRow,
  type SessionItemRow,
  type SessionRow,
} from "./repo";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The latest cash record for a session, as joined onto it (all null when there is none). */
interface CashJoin {
  cash_state: SquareCashState | null;
  cash_amount_cents: number | null;
  cash_error: string | null;
}

interface SessionJoinRow extends SessionRow, CashJoin {
  opened_by_name: string;
  settled_by_name: string | null;
  /** Who put the discount on, when there is one. */
  discount_by_name: string | null;
}

/**
 * What to call the bill in alias `s`, as SQL (same rule as `SessionDTO.label`): "Counter sale", a
 * part's own name ("Table 3 · share"), or the tables a table's bill was on. Select it `as table_names`
 * or under any other name.
 */
export const billLabelSql = (q: Db) => q`
  case s.kind
    when 'counter' then ${COUNTER_LABEL}::text
    when 'part' then coalesce(
      (select pi.name from public.session_items pi
       where pi.session_id = s.id and pi.kind = 'split' order by pi.added_at, pi.id limit 1),
      ${PART_FALLBACK_LABEL}::text)
    else coalesce((select string_agg(distinct t.name, ' → ')
                   from public.session_intervals i join public.tables t on t.id = i.table_id
                   where i.session_id = s.id), '')
  end`;

/**
 * Joins the latest `square_cash_records` row for session alias `s` as `sc`. One index probe per
 * session on (session_id, seq); no extra query.
 */
const cashJoinSql = (q: Db) => q`
  left join lateral (
    select c.state, c.amount_cents, c.last_error
    from public.square_cash_records c
    where c.session_id = s.id
    order by c.seq desc limit 1
  ) sc on true`;
const cashColumnsSql = (q: Db) => q`sc.state as cash_state, sc.amount_cents as cash_amount_cents, sc.last_error as cash_error`;

function squareCashDTO(r: CashJoin): SquareCashDTO | null {
  if (!r.cash_state || r.cash_amount_cents === null) return null;
  const waiting = r.cash_state === "pending" || r.cash_state === "failed";
  // Once the sale is in Square an old error is history, not something staff need to act on.
  return { state: r.cash_state, amountCents: r.cash_amount_cents, error: waiting ? r.cash_error : null };
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

interface ItemJoinRow extends SessionItemRow {
  added_by_name: string;
  removed_by_name: string | null;
}

function itemDTO(i: ItemJoinRow): SessionItemDTO {
  return {
    id: i.id,
    kind: i.kind,
    productId: i.product_id,
    name: i.name,
    unitCents: i.unit_cents,
    quantity: i.quantity,
    taxed: i.taxed,
    addedAt: i.added_at.toISOString(),
    addedByName: i.added_by_name,
    removedAt: iso(i.removed_at),
    removedByName: i.removed_by_name,
  };
}

/** Bill items for the given sessions: the live ones (`removed: false`) or the ones taken off. */
async function loadItems(q: Db, sessionIds: string[], opts: { removed: boolean }): Promise<ItemJoinRow[]> {
  return q<ItemJoinRow[]>`
    select i.id, i.session_id, i.kind, i.product_id, i.name, i.unit_cents, i.quantity, i.taxed, i.added_by, i.added_at,
           i.removed_at, i.removed_by, ab.name as added_by_name, rb.name as removed_by_name
    from public.session_items i
    join public.staff ab on ab.id = i.added_by
    left join public.staff rb on rb.id = i.removed_by
    where i.session_id = any(${sessionIds}::uuid[])
      and ${opts.removed ? q`i.removed_at is not null` : q`i.removed_at is null`}
    order by ${opts.removed ? q`i.removed_at, i.id` : q`i.added_at, i.id`}`;
}

/**
 * `held` is how many of this product sit on bills Square hasn't been told about yet (see
 * `heldStock` in stock.ts). What is left to sell is Square's count less that.
 */
export function productDTO(p: ProductRow, held = 0): ProductDTO {
  return {
    id: p.id,
    name: p.name,
    priceCents: p.price_cents,
    taxed: p.taxed,
    category: p.category,
    barcode: p.barcode,
    imageUrl: p.image_url,
    stock: p.tracked && p.stock_count !== null ? p.stock_count - held : null,
  };
}

export function discountDTO(d: DiscountRow): DiscountDTO {
  return { id: d.id, name: d.name, kind: d.kind, value: d.value };
}

/** A part as listed on the bill it was split from. */
interface PartRow {
  id: string;
  split_of: string;
  total_cents: number | null;
  status: SessionRow["status"];
  /** A card request for the part is live on the Terminal (same statuses as `isCheckoutLive`). */
  on_terminal: boolean;
}

/** The label of a bill, from what is already loaded for it. Same rule as `billLabelSql`. */
function labelOf(kind: BillKind, intervals: readonly IntervalDTO[], items: readonly SessionItemDTO[]): string {
  if (kind === "counter") return COUNTER_LABEL;
  if (kind === "part") return items.find((i) => i.kind === "split")?.name ?? PART_FALLBACK_LABEL;
  // The tables in the order the session used them, each once.
  return intervals.map((i) => i.tableName).filter((n, idx, arr) => arr.indexOf(n) === idx).join(" → ") || "Table";
}

/** Loads sessions matching `where` (a fragment over alias `s`) with intervals, items and latest checkout. */
async function loadSessions(q: Db, where: postgres.Fragment): Promise<SessionDTO[]> {
  const rows = await q<SessionJoinRow[]>`
    select s.*, op.name as opened_by_name, sb.name as settled_by_name, dby.name as discount_by_name, ${cashColumnsSql(q)}
    from public.sessions s
    join public.staff op on op.id = s.opened_by
    left join public.staff sb on sb.id = s.settled_by
    left join public.staff dby on dby.id = s.discount_by
    ${cashJoinSql(q)}
    where ${where}
    order by s.opened_at, s.created_at, s.id`;
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const checkoutIds = rows.map((r) => r.square_checkout_id).filter((x): x is string => !!x);
  // Only a bill that has money split off it can have parts to list.
  const parentIds = rows.filter((r) => r.split_off_cents > 0).map((r) => r.id);

  const [intervals, checkouts, items, parts] = await Promise.all([
    q<{ id: string; session_id: string; table_id: string; table_name: string; started_at: Date; ended_at: Date | null }[]>`
      select i.id, i.session_id, i.table_id, t.name as table_name, i.started_at, i.ended_at
      from public.session_intervals i join public.tables t on t.id = i.table_id
      where i.session_id = any(${ids}::uuid[])
      order by i.started_at, i.id`,
    checkoutIds.length
      ? q<CheckoutRow[]>`select * from public.terminal_checkouts where id = any(${checkoutIds}::text[])`
      : Promise.resolve([] as CheckoutRow[]),
    // One query for every session's items, not one per session.
    loadItems(q, ids, { removed: false }),
    // The parts of those bills that still stand: awaiting payment, paid, or written off by a
    // manager. A part that was merged back is not one any more.
    parentIds.length
      ? q<PartRow[]>`
          select p.id, p.split_of, p.total_cents, p.status,
                 exists (select 1 from public.terminal_checkouts c
                         where c.session_id = p.id and c.status in ('PENDING', 'IN_PROGRESS', 'CANCEL_REQUESTED')) as on_terminal
          from public.sessions p
          where p.split_of = any(${parentIds}::uuid[]) and not p.merged
          order by p.opened_at, p.created_at, p.id`
      : Promise.resolve([] as PartRow[]),
  ]);

  // What has been refunded on each paid bill, what still can be, and whether its receipt can be
  // printed. No query at all unless one of the bills is paid (the floor and the Unpaid list never are).
  const refundFacts = await loadRefundFacts(q, rows);

  const partsByParent = new Map<string, PartDTO[]>();
  for (const p of parts) {
    const list = partsByParent.get(p.split_of) ?? [];
    list.push({ id: p.id, amountCents: p.total_cents ?? 0, status: p.status, onTerminal: p.on_terminal });
    partsByParent.set(p.split_of, list);
  }

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
  const itemsBySession = new Map<string, SessionItemDTO[]>();
  for (const i of items) {
    const list = itemsBySession.get(i.session_id) ?? [];
    list.push(itemDTO(i));
    itemsBySession.set(i.session_id, list);
  }

  return rows.map((r): SessionDTO => ({
    id: r.id,
    kind: r.kind,
    label: labelOf(r.kind, bySession.get(r.id) ?? [], itemsBySession.get(r.id) ?? []),
    status: r.status,
    currentTableId: r.current_table_id,
    openedAt: r.opened_at.toISOString(),
    openedByName: r.opened_by_name,
    closedAt: iso(r.closed_at),
    billedMinutes: r.billed_minutes,
    totalCents: r.total_cents,
    discount:
      r.discount_kind && r.discount_value !== null
        ? {
            discountId: r.discount_id,
            name: r.discount_name ?? "Discount",
            kind: r.discount_kind,
            value: r.discount_value,
            // 0 while the session is still running: it is worked out when the session stops.
            cents: r.discount_cents,
            byName: r.discount_by_name ?? "",
          }
        : null,
    splitOfId: r.split_of,
    splitOffCents: r.split_off_cents,
    parts: partsByParent.get(r.id) ?? [],
    // refundedCents, refundable, canPrintReceipt: all zero / null / false unless the bill is paid.
    ...(refundFacts.get(r.id) ?? NO_REFUND_FACTS),
    itemsCents: r.items_cents,
    items: itemsBySession.get(r.id) ?? [],
    settledMethod: r.settled_method,
    settledVia: r.settled_via,
    settledAt: iso(r.settled_at),
    settledByName: r.settled_by_name,
    settledCents: r.settled_cents,
    squareCash: squareCashDTO(r),
    voidReason: r.void_reason,
    note: r.note,
    intervals: bySession.get(r.id) ?? [],
    checkout: r.square_checkout_id ? checkoutById.get(r.square_checkout_id) ?? null : null,
  }));
}

export async function getFloor(): Promise<FloorDTO> {
  const q = db();
  const [tables, sessions, [unpaid], { settings, rateCards }, products, discounts, held] = await Promise.all([
    q<{ id: string; name: string; sort_order: number; active: boolean }[]>`
      select id, name, sort_order, active from public.tables
      where active or id in (select current_table_id from public.sessions where current_table_id is not null)
      order by sort_order, name`,
    loadSessions(q, q`s.current_table_id is not null`),
    // Bills awaiting payment that aren't on a table: how many, and a stamp that moves when any of
    // them does. The stamp is built from what staff can see change: which bills there are, each
    // one's `updated_at` (every change to a bill, its lines, discount, split or payment writes its
    // row) and the STATUS of each of its card requests. Deliberately not a checkout's own
    // timestamps: the background check stamps `last_synced_at` on a waiting request every 15 s,
    // which changes nothing anyone can see and must not make every iPad reload.
    q<{ n: number; stamp: string | null }[]>`
      select count(*)::int as n,
             md5(string_agg(
               s.id::text || ' ' || to_char(s.updated_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS') || ' ' || coalesce(c.states, ''),
               ',' order by s.id)) as stamp
      from public.sessions s
      left join lateral (
        select string_agg(k.status, '/' order by k.attempt) as states
        from public.terminal_checkouts k where k.session_id = s.id
      ) c on true
      where s.status = 'awaiting_payment' and s.current_table_id is null`,
    getPricingConfig(q),
    getProducts(q, { activeOnly: true }),
    getDiscounts(q, { activeOnly: true }),
    // What sits on bills Square's stock hasn't been told about yet, so the count staff see is
    // what is really left to sell.
    heldStock(q),
  ]);
  return {
    serverTime: new Date().toISOString(),
    tables: tables.map((t): TableDTO => ({ id: t.id, name: t.name, sortOrder: t.sort_order, active: t.active })),
    sessions,
    unpaidOffTableCount: unpaid?.n ?? 0,
    unpaidStamp: unpaid?.stamp ?? null,
    pricing: { settings: pricingSettingsOf(settings), rateCards },
    terminalPaired: !!settings.terminalDeviceId,
    posCashAvailable: posCashConfig() !== null,
    products: products.map((p) => productDTO(p, held.get(p.id) ?? 0)),
    discounts: discounts.map(discountDTO),
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

  const [[snapRow], checkouts, removed, audit, refunds] = await Promise.all([
    q<{ rate_snapshot: RateSnapshot | null; closed_at: Date | null }[]>`
      select rate_snapshot, closed_at from public.sessions where id = ${id}`,
    q<CheckoutRow[]>`select * from public.terminal_checkouts where session_id = ${id} order by attempt`,
    loadItems(q, [id], { removed: true }),
    getAudit({ entity: "session", entityId: id, limit: 200 }),
    // Every refund asked for on this bill, oldest first, failed ones included.
    listRefunds(q, id),
  ]);

  // Table time only: the items are on `session.items` and add to this (see lib/domain/bill.ts).
  let breakdown: SessionDetailDTO["breakdown"] = null;
  if (session.kind !== "table") {
    // A counter sale or a part has no table time: no intervals, no rates, nothing to price. (The
    // live rates must not be run over an empty session either: a minimum charge would appear.)
    if (session.status !== "void") breakdown = { billedMinutes: 0, totalCents: 0, gstCents: 0, actualMs: 0, lines: [] };
  } else if (session.status !== "void" || snapRow?.rate_snapshot) {
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

  return {
    session,
    checkouts: checkouts.map(checkoutDTO),
    breakdown,
    removedItems: removed.map(itemDTO),
    refunds,
    audit: audit.entries.reverse(),
  };
}

// ---------------------------------------------------------------------------
// Daily summary (app data only — no Square calls)
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface SummaryRow {
  id: string;
  kind: BillKind;
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

  // Table names for a table's bill; "Counter sale" or "Table 3 · share" otherwise.
  const tableNamesSql = q`${billLabelSql(q)} as table_names`;

  const [closed, itemsSold, paid, unpaid, older, voids, attention] = await Promise.all([
    // Every bill that isn't void counts for what it is owed: a table's bill, a counter sale, and
    // each part on its own. A split bill and its parts therefore add up to the bill before the
    // split, a share or a remainder a manager voided drops out, and a merged-back part (void)
    // was never in. Sessions, minutes, items and discounts are counted on table and counter bills
    // only: a part is a share of one of those, not a bill of its own.
    //
    // A part counts on the business day of the bill it was split from (`p`), whenever the split
    // itself happened: splitting yesterday's unpaid bill this morning must not move money between
    // two days' figures. (Two halves so each can use an index: bills by their own closed_at, parts
    // through the bill they came from.)
    //
    // `written_off` marks a share a manager voided on a bill that itself still counts. Its money
    // is not billed, but the bill's items and discount are still counted whole, so it has to be
    // shown as its own figure or the missing money would come out of table time (and could take
    // it below zero).
    q<{ count: number; minutes: number; cents: number; items_cents: number; discount_cents: number; written_off_cents: number }[]>`
      select count(*) filter (where b.kind <> 'part')::int as count,
             coalesce(sum(b.billed_minutes) filter (where b.kind <> 'part'), 0)::int as minutes,
             coalesce(sum(b.total_cents) filter (where not b.written_off), 0)::int as cents,
             coalesce(sum(b.items_cents) filter (where b.kind <> 'part'), 0)::int as items_cents,
             coalesce(sum(b.discount_cents) filter (where b.kind <> 'part'), 0)::int as discount_cents,
             coalesce(sum(b.total_cents) filter (where b.written_off), 0)::int as written_off_cents
      from (
        select s.kind, false as written_off, s.billed_minutes, s.total_cents, s.items_cents, s.discount_cents
        from public.sessions s
        where s.split_of is null and s.status <> 'void' and s.closed_at >= ${from} and s.closed_at < ${to}
        union all
        select s.kind, (s.status = 'void') as written_off, s.billed_minutes, s.total_cents, s.items_cents, s.discount_cents
        from public.sessions p join public.sessions s on s.split_of = p.id
        where p.closed_at >= ${from} and p.closed_at < ${to}
          and (s.status <> 'void' or (not s.merged and p.status <> 'void'))
      ) b`,
    // What was sold on those same table and counter bills. Catalogue items are grouped by product
    // (the name is the latest one used); custom charges have no product and are grouped by the
    // name staff typed, ignoring capitals and stray spaces. A part's one line is its share of a
    // bill whose own lines are already counted here, so split lines are left out.
    q<{ product_id: string | null; name: string; quantity: number; cents: number }[]>`
      select i.product_id, (array_agg(i.name order by i.added_at desc, i.id))[1] as name,
             sum(i.quantity)::int as quantity, sum(i.unit_cents * i.quantity)::int as cents
      from public.session_items i join public.sessions s on s.id = i.session_id
      where i.removed_at is null and i.kind <> 'split'
        and s.kind <> 'part' and s.status <> 'void' and s.closed_at >= ${from} and s.closed_at < ${to}
      group by i.product_id, case when i.product_id is null then lower(btrim(i.name)) end
      order by cents desc, name, i.product_id`,
    q<
      (SummaryRow &
        CashJoin & {
          settled_method: SettledMethod;
          settled_via: SettledVia;
          settled_at: Date;
          settled_cents: number;
          settled_by_name: string | null;
        })[]
    >`
      select s.id, s.kind, s.opened_at, s.closed_at, s.billed_minutes, s.total_cents, s.settled_method, s.settled_via,
             s.settled_at, s.settled_cents, sb.name as settled_by_name, ${cashColumnsSql(q)}, ${tableNamesSql}
      from public.sessions s left join public.staff sb on sb.id = s.settled_by
      ${cashJoinSql(q)}
      where s.status = 'paid' and s.settled_at >= ${from} and s.settled_at < ${to}
      order by s.settled_at, s.id`,
    // Every bill still to be paid, parts included, each for what is owed on it.
    q<SummaryRow[]>`
      select s.id, s.kind, s.opened_at, s.closed_at, s.billed_minutes, s.total_cents, ${tableNamesSql}
      from public.sessions s
      where s.status = 'awaiting_payment' and s.closed_at >= ${from} and s.closed_at < ${to}
      order by s.closed_at, s.created_at, s.id`,
    q<{ count: number; cents: number }[]>`
      select count(*)::int as count, coalesce(sum(total_cents), 0)::int as cents
      from public.sessions where status = 'awaiting_payment' and closed_at < ${from}`,
    // Write-offs. Two kinds of void row are not write-offs and are left out:
    //   - a part that was merged back into its bill (`merged`): the money is back on that bill;
    //   - a counter sale thrown away with nothing on it: kind counter, nothing owed, no items,
    //     and the fixed reason `discardCounterSale` writes. All four must hold, so a manager's
    //     void of a counter sale that had anything on it is always listed, whatever reason is typed.
    // Both stay in the database and in the audit log (session.merged_back / session.discard).
    q<(SummaryRow & { void_reason: string; voided_by_name: string | null })[]>`
      select s.id, s.kind, s.opened_at, s.closed_at, s.billed_minutes, s.total_cents, s.void_reason,
             vb.name as voided_by_name, ${tableNamesSql}
      from public.sessions s left join public.staff vb on vb.id = s.voided_by
      where s.status = 'void' and s.voided_at >= ${from} and s.voided_at < ${to}
        and not s.merged
        and not (s.kind = 'counter' and coalesce(s.total_cents, 0) = 0 and s.items_cents = 0
                 and coalesce(s.void_reason, '') = ${DISCARD_REASON})
      order by s.voided_at, s.id`,
    getAudit({ from, to, actions: [...ATTENTION_ACTIONS], limit: 200 }),
  ]);
  const checks = await attentionChecks(q, attention.entries.map((a) => a.id));

  // Refunds asked for in the window; refunds nobody can confirm, whatever day they are from; and
  // for each bill paid in the window, what has been refunded, what still can be, and whether its
  // receipt can be printed. Three queries however many bills there are.
  const refundLabels = async (ids: string[]) => {
    const labels = await q<{ id: string; label: string }[]>`
      select s.id, ${billLabelSql(q)} as label from public.sessions s where s.id = any(${ids}::uuid[])`;
    return new Map(labels.map((l) => [l.id, l.label]));
  };
  const [refunds, refundsOutstanding, refundFacts] = await Promise.all([
    summaryRefunds(q, from, to, refundLabels),
    outstandingRefunds(q, refundLabels),
    loadRefundFacts(q, paid.map((p) => ({ id: p.id, status: "paid" as const }))),
  ]);

  const row = (r: SummaryRow): SummarySessionRow => ({
    id: r.id,
    kind: r.kind,
    tableNames: r.table_names,
    openedAt: r.opened_at.toISOString(),
    closedAt: iso(r.closed_at),
    billedMinutes: r.billed_minutes,
    totalCents: r.total_cents,
  });
  const sum = (list: { total_cents: number | null }[]) => list.reduce((a, r) => a + (r.total_cents ?? 0), 0);
  const billedCents = closed[0]?.cents ?? 0;
  const soldCents = closed[0]?.items_cents ?? 0;
  const discountCents = closed[0]?.discount_cents ?? 0;
  const writtenOffCents = closed[0]?.written_off_cents ?? 0;
  // A bill closed with nothing to pay (discounted to $0, then marked paid) took no money. Every
  // paid row must carry a settled method, so it has whichever button staff tapped, but it is
  // neither a card payment nor a cash payment and is left out of both tallies. It is still listed
  // in `paidItems` (a manager can reverse it) and still counted in `sessions`.
  const tookMoney = (p: { settled_cents: number; total_cents: number | null }) => p.settled_cents > 0 || (p.total_cents ?? 0) > 0;
  const card = paid.filter((p) => p.settled_method === "card" && tookMoney(p));
  const cash = paid.filter((p) => p.settled_method === "cash" && tookMoney(p));
  // What was collected, not what was billed: cash is rounded to 5c, and a card can have been
  // charged a different amount from the final bill (flagged separately as a payment conflict).
  const collected = (list: { settled_cents: number }[]) => list.reduce((a, r) => a + r.settled_cents, 0);
  // Cash bills whose sale Square doesn't hold yet. A reversed-and-repaid bill counts by its latest record.
  const notInSquare = cash.filter((p) => p.cash_state === "pending" || p.cash_state === "failed");
  return {
    businessDate: formatYMD(date),
    from: from.toISOString(),
    to: to.toISOString(),
    sessions: {
      count: closed[0]?.count ?? 0,
      billedMinutes: closed[0]?.minutes ?? 0,
      billedCents,
      // Table time is what is left: billed = table + items − discounts − shares written off.
      // Exact for every bill that still counts, split or not. The one case it can't get right is
      // the REST of a split bill being voided after a share was paid: the bill is void, so its
      // items and discount aren't counted at all, and the paid share's money all lands here.
      // billedCents is exact even then.
      tableCents: billedCents - soldCents + discountCents + writtenOffCents,
      itemsCents: soldCents,
      discountCents,
      writtenOffCents,
    },
    itemsSold: itemsSold.map((i) => ({ productId: i.product_id, name: i.name, quantity: i.quantity, cents: i.cents })),
    refunds,
    refundsOutstanding,
    paid: {
      card: { count: card.length, cents: collected(card) },
      cash: { count: cash.length, cents: collected(cash), roundingCents: collected(cash) - sum(cash) },
    },
    squareCashOutstanding: {
      count: notInSquare.length,
      cents: notInSquare.reduce((a, p) => a + (p.cash_amount_cents ?? 0), 0),
      failed: notInSquare.filter((p) => p.cash_state === "failed").length,
    },
    paidItems: paid.map((p) => ({
      ...row(p),
      method: p.settled_method,
      via: p.settled_via,
      settledAt: p.settled_at.toISOString(),
      settledByName: p.settled_by_name,
      settledCents: p.settled_cents,
      // Only a bill paid in cash has a sale of its own in Square to report on.
      squareCash: p.settled_method === "cash" ? squareCashDTO(p) : null,
      // refundedCents, refundable, canPrintReceipt: same meaning as on SessionDTO.
      ...(refundFacts.get(p.id) ?? NO_REFUND_FACTS),
    })),
    unpaid: { count: unpaid.length, cents: sum(unpaid), items: unpaid.map(row) },
    outstandingOlder: { count: older[0]?.count ?? 0, cents: older[0]?.cents ?? 0 },
    voids: {
      count: voids.length,
      items: voids.map((v) => ({ ...row(v), reason: v.void_reason, voidedByName: v.voided_by_name })),
    },
    attention: attention.entries.map((a) => {
      const c = checks.get(a.id);
      return { ...a, checked: c ? { at: c.at.toISOString(), byName: c.byName } : null };
    }),
  };
}
