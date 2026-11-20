import "server-only";
import * as inventory from "@/lib/square/inventory";
import * as orders from "@/lib/square/orders";
import type { Actor, Manager } from "./auth";
import { audit } from "./audit";
import { db, withTx, type Db, type Tx } from "./db";
import { squareEnv, squareLooksConfigured } from "./env";
import { AppError } from "./errors";
import { lockSession } from "./repo";
import { isKeyReused, isSquareRejection, squareStatus } from "./square-errors";
import { parseStoredOrder } from "./square-cash";

/*
 * Stock. Square is the source of truth for how many of each item are on the shelf; this module
 * reads the counts and makes sure Square's stock ends up with exactly what the bills say.
 *
 * The rule, for every bill:
 *
 *     what Square's stock has had taken off for this bill
 *       == the bill's live product lines (items Square tracks) if the bill is paid, else nothing
 *
 * Nothing is inferred from a bill's status or timestamps. A `stock_moves` row is the record of one
 * thing that changed Square's stock:
 *
 *   - via = 'square': a paid Square order of this bill that carried catalogue lines. Square moves
 *     the tracked quantity itself when such an order is paid, and a later refund does not put it
 *     back. One row per order (`source_order_id`, unique). Evidence only; nothing is sent for it.
 *   - via = 'app': an inventory adjustment the app sends, a `sale` or a `restock`.
 *
 * A background pass records the paid orders it hasn't seen, then, for each bill whose moves don't
 * add up to what the bill says, writes the app moves that make the difference, then sends them. It
 * recomputes from the rows every time, so any order of pay / reverse / late card completion ends
 * in the same place. Settlement code doesn't know stock exists, and no lock is held across a Square
 * call, so Square being slow or down never holds up the till.
 *
 * `products`, `catalog_state`, `stock_moves` and `audit_log` have no floor-broadcast trigger, so the
 * pass can run after every floor fetch without making the iPads refetch (see items.ts).
 */

// ---------------------------------------------------------------------------
// Square gateway (swappable in tests)
// ---------------------------------------------------------------------------

export interface StockGateway {
  getCounts: typeof inventory.getStockCounts;
  change: typeof inventory.changeStock;
  /** What a paid order carried, read from Square. */
  getOrderItems: typeof orders.getOrderItems;
}

let gateway: StockGateway = { getCounts: inventory.getStockCounts, change: inventory.changeStock, getOrderItems: orders.getOrderItems };

export function setStockGatewayForTests(g: StockGateway): void {
  gateway = g;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface StockLine {
  productId: string;
  quantity: number;
}

export interface StockMoveRow {
  id: string;
  session_id: string;
  seq: number;
  kind: "sale" | "restock";
  via: "square" | "app";
  /** jsonb: read with `parseLines`. */
  lines: unknown;
  state: "pending" | "done" | "failed";
  occurred_at: Date | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
  claimed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  source_order_id: string | null;
  refused: boolean;
}

/** A move gives up and asks for a manager after this many tries. */
export const MAX_ATTEMPTS = 12;
const SYSTEM_LABEL = "Square stock";
/** How long a pass leaves the stock count alone after reading it. */
const REFRESH_EVERY = "2 minutes";

function parseLines(v: unknown): StockLine[] {
  let value = v;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: StockLine[] = [];
  for (const l of value) {
    if (typeof l !== "object" || l === null) continue;
    const o = l as Record<string, unknown>;
    if (typeof o.productId === "string" && typeof o.quantity === "number" && Number.isInteger(o.quantity) && o.quantity > 0) {
      out.push({ productId: o.productId, quantity: o.quantity });
    }
  }
  return out;
}

const linesJson = (lines: StockLine[]) => JSON.stringify(lines);

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

interface Reading {
  id: string;
  /** null = Square has no count for it. */
  qty: number | null;
  /** null = Square didn't say when; treated as now. */
  at: Date | null;
}

/**
 * Stores readings, and only the ones that change something: a different count, or a newer time on
 * the same one. A reading older than the one already stored never overwrites it (the webhook and a
 * refresh can pass each other). Returns how many rows were written.
 */
async function writeCounts(q: Db, readings: Reading[], opts: { trackedOnly: boolean }): Promise<number> {
  // A count the database column can't hold is not a real shelf count; one of those must never fail the rest.
  readings = readings.filter((r) => r.qty === null || (Number.isInteger(r.qty) && Math.abs(r.qty) <= 2_147_483_647));
  if (readings.length === 0) return 0;
  const json = JSON.stringify(readings.map((r) => ({ id: r.id, qty: r.qty, read_at: r.at?.toISOString() ?? null })));
  const rows = await q<{ id: string }[]>`
    update public.products p set stock_count = v.qty, stock_at = coalesce(v.read_at, now())
    from jsonb_to_recordset(${json}::text::jsonb) as v(id text, qty integer, read_at timestamptz)
    where p.id = v.id
      ${opts.trackedOnly ? q`and p.tracked` : q``}
      and (p.stock_at is null or p.stock_at <= coalesce(v.read_at, now()))
      and (p.stock_count is distinct from v.qty or (v.read_at is not null and p.stock_at is distinct from v.read_at))
    returning p.id`;
  return rows.length;
}

/** Newest reading per product, in case Square lists one twice. */
function newest(counts: { variationId: string; quantity: number; calculatedAt: Date | null }[]): Map<string, Reading> {
  const out = new Map<string, Reading>();
  for (const c of counts) {
    const have = out.get(c.variationId);
    if (have && (have.at?.getTime() ?? Infinity) >= (c.calculatedAt?.getTime() ?? Infinity)) continue;
    out.set(c.variationId, { id: c.variationId, qty: c.quantity, at: c.calculatedAt });
  }
  return out;
}

function stockErrorMessage(e: unknown): string {
  return (e instanceof AppError ? e.message : "Couldn't read stock levels from Square.").slice(0, 300);
}

/**
 * Reads counts from Square for the given products (default: every active product Square tracks) and
 * stores them. A tracked product Square has no count for keeps whatever it had ("never counted" if nothing).
 * Throws when Square can't be reached; the reason is also left on `catalog_state.stock_error` for
 * Admin → Items, and cleared again by the next full refresh that works.
 */
export async function refreshStock(opts: { productIds?: string[] } = {}): Promise<void> {
  const q = db();
  const full = !opts.productIds;
  try {
    const locationId = squareEnv().SQUARE_LOCATION_ID;
    const ids = (
      full
        ? await q<{ id: string }[]>`select id from public.products where active and tracked order by id`
        : await q<{ id: string }[]>`select id from public.products where tracked and id = any(${opts.productIds ?? []}::text[]) order by id`
    ).map((r) => r.id);
    if (full) await q`update public.catalog_state set stock_synced_at = now() where id`;
    if (ids.length > 0) {
      // Square is called with no transaction open.
      const found = newest(await gateway.getCounts({ locationId, variationIds: ids }));
      // An item Square returns no count for is left as it is. Writing "no count" over a number, or
      // stamping the time, could shut out a real count that reached us by webhook a moment ago.
      await writeCounts(q, [...found.values()], { trackedOnly: true });
    }
    if (full) await q`update public.catalog_state set stock_error = null where id and stock_error is not null`;
  } catch (e) {
    try {
      await q`update public.catalog_state set stock_error = ${stockErrorMessage(e)} where id`;
    } catch {
      // The database is the problem; the original error is the one worth reporting.
    }
    throw e;
  }
}

/** Applies `inventory.count.updated` counts inside the webhook's transaction. Unknown ids are ignored. */
export async function applyWebhookCounts(
  tx: Tx,
  counts: { variationId: string; quantity: number; calculatedAt: Date | null }[],
): Promise<void> {
  await writeCounts(tx, [...newest(counts).values()], { trackedOnly: false });
}

// ---------------------------------------------------------------------------
// What is held back
// ---------------------------------------------------------------------------

/**
 * productId → how many are on bills Square's stock hasn't caught up with yet. Staff see Square's
 * count less this. It is advice only and never stops a sale.
 *
 * Per bill it is what the bill says (its live tracked product lines, while it is open or paid) less
 * what Square's stock has had taken off for it (moves that are `done`: Square's own paid orders and
 * adjustments Square has accepted). Summed per product, not clamped per bill, so a reopened bill
 * waiting for its restock nets to zero. A bill counts while it is open, for 2 days after it was
 * paid, and for 2 days after any of its moves last changed. That last bound is what stops a move
 * that failed and was never retried from holding stock back for ever.
 *
 * One query, run on every floor fetch: open bills from `sessions_open_status`, recently paid ones
 * from the index on `settled_at`, recently changed moves from `stock_moves_by_updated`, lines from
 * `session_items_by_session`, a bill's moves from the `(session_id, seq)` unique index.
 */
export async function heldStock(q: Db): Promise<Map<string, number>> {
  const rows = await q<{ product_id: string; held: number }[]>`
    with b as (
      select s.id from public.sessions s where s.status in ('running', 'paused', 'awaiting_payment')
      union
      select s.id from public.sessions s, public.catalog_state c
      where c.id and s.status = 'paid' and s.kind <> 'part'
        and s.settled_at >= c.stock_from and s.settled_at > now() - interval '2 days'
      union
      select m.session_id from public.stock_moves m where m.updated_at > now() - interval '2 days'
    ),
    wanted as (
      select i.product_id, sum(i.quantity)::int as q
      from b
      join public.sessions s on s.id = b.id and s.status in ('running', 'paused', 'awaiting_payment', 'paid')
      join public.session_items i on i.session_id = s.id and i.kind = 'product' and i.removed_at is null
      join public.products p on p.id = i.product_id and p.tracked and s.opened_at >= p.tracked_since
      group by i.product_id
    ),
    taken as (
      select l."productId" as product_id, sum(case when m.kind = 'sale' then l.quantity else -l.quantity end)::int as q
      from b
      join public.sessions bs on bs.id = b.id
      join public.stock_moves m on m.session_id = b.id and m.state = 'done'
      cross join lateral jsonb_to_recordset(m.lines) as l("productId" text, quantity integer)
      join public.products p on p.id = l."productId" and p.tracked and bs.opened_at >= p.tracked_since
      group by l."productId"
    )
    select coalesce(w.product_id, t.product_id) as product_id, (coalesce(w.q, 0) - coalesce(t.q, 0))::int as held
    from wanted w full outer join taken t on t.product_id = w.product_id`;
  return new Map(rows.filter((r) => r.held !== 0).map((r) => [r.product_id, r.held]));
}

// ---------------------------------------------------------------------------
// Evidence: paid Square orders
// ---------------------------------------------------------------------------

/** Paid orders read from Square in one pass. The rest wait for the next. */
const MAX_ORDER_READS = 10;
/** How far back a pass looks for bills and orders that changed. */
const WINDOW = "7 days";

async function insertMove(
  tx: Tx,
  input: { sessionId: string; kind: "sale" | "restock"; via: "square" | "app"; lines: StockLine[]; state: "pending" | "done"; sourceOrderId?: string; note?: string },
): Promise<number | null> {
  // The session row is locked by the caller, which is what makes `seq` safe. A second pass
  // recording the same order loses on the unique index and does nothing.
  const [row] = await tx<{ seq: number }[]>`
    insert into public.stock_moves (session_id, seq, kind, via, lines, state, source_order_id, last_error)
    values (
      ${input.sessionId},
      (select coalesce(max(seq), 0) + 1 from public.stock_moves where session_id = ${input.sessionId}),
      ${input.kind}, ${input.via}, ${linesJson(input.lines)}::text::jsonb, ${input.state}, ${input.sourceOrderId ?? null}, ${input.note ?? null}
    )
    on conflict (source_order_id) where source_order_id is not null do nothing
    returning seq`;
  return row?.seq ?? null;
}

const sum = (lines: { productId: string; quantity: number }[]): StockLine[] => {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.productId, (m.get(l.productId) ?? 0) + l.quantity);
  return [...m].map(([productId, quantity]) => ({ productId, quantity })).sort((a, b) => (a.productId < b.productId ? -1 : 1));
};

/**
 * Writes the evidence row for one paid order: every catalogue line it carried. Not filtered by
 * whether we think the item is tracked: that flag can be stale or change later, and the sums that
 * read these rows apply it themselves. `note` says why a row is empty when that isn't because the
 * order had nothing on it.
 */
async function recordOrder(sessionId: string, orderId: string, raw: StockLine[], touched: Set<string>, note?: string): Promise<void> {
  await withTx(async (tx) => {
    // If the lock is busy this throws and the order is looked at again on the next pass.
    if (!(await lockSession(tx, sessionId))) return;
    const lines = sum(raw);
    // Written even with no lines, so the order is never read again.
    const seq = await insertMove(tx, { sessionId, kind: "sale", via: "square", lines, state: "done", sourceOrderId: orderId, note });
    if (seq === null) return;
    if (note) {
      await audit(tx, {
        actorStaffId: null,
        deviceLabel: SYSTEM_LABEL,
        action: "square.stock_order_missing",
        entity: "session",
        entityId: sessionId,
        after: { order_id: orderId },
        reason: note,
      });
    }
    // Only items we think are tracked have a count worth reading back.
    const ids = lines.map((l) => l.productId);
    const tracked = await tx<{ id: string }[]>`select id from public.products where tracked and id = any(${ids}::text[])`;
    for (const t of tracked) touched.add(t.id);
  });
}

/**
 * Records every paid Square order of a bill that carried catalogue lines, because Square took the
 * stock when the order was paid and whatever happens to the bill afterwards doesn't give it back.
 *
 *   - cash the app recorded: a `square_cash_records` row with a payment on an order. The lines are
 *     the ones stored on the row. A later refund doesn't put the stock back, so refunded rows count.
 *   - card: a completed Terminal checkout against an order, whichever attempt, whenever it
 *     completed, whatever the bill looks like now. The lines are read from Square (the app can't
 *     know what an old order carried, or whether it was a split bill's single ad hoc line).
 *
 * If Square can't be read the order is left for the next pass; the bill isn't reconciled until it
 * is recorded.
 */
export async function recordStockEvidence(touched: Set<string> = new Set(), opts: { budgetMs?: number } = {}): Promise<void> {
  const q = db();
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 5_000;
  const cash = await q<{ session_id: string; square_order_id: string; order_lines: unknown }[]>`
    select r.session_id, r.square_order_id, r.order_lines
    from public.square_cash_records r
    join public.sessions s on s.id = r.session_id and s.kind <> 'part', public.catalog_state c
    where c.id and r.square_payment_id is not null and r.square_order_id is not null
      and r.created_at >= c.stock_from and r.updated_at > now() - ${WINDOW}::interval
      and not exists (select 1 from public.stock_moves m where m.source_order_id = r.square_order_id)
    order by r.updated_at desc limit 50`;
  // Newest first: an order that keeps failing can only hold up older ones, never newer.
  const card = await q<{ session_id: string; square_order_id: string }[]>`
    select k.session_id, k.square_order_id
    from public.terminal_checkouts k
    join public.sessions s on s.id = k.session_id and s.kind <> 'part', public.catalog_state c
    where c.id and k.status = 'COMPLETED' and k.square_order_id is not null
      and k.created_at >= c.stock_from and k.updated_at > now() - ${WINDOW}::interval
      and not exists (select 1 from public.stock_moves m where m.source_order_id = k.square_order_id)
    order by k.updated_at desc limit 50`;

  const done = new Set<string>();
  for (const r of cash) {
    if (done.has(r.square_order_id)) continue;
    done.add(r.square_order_id);
    const stored = parseStoredOrder(r.order_lines);
    const lines = (stored?.lines ?? []).flatMap((l) => (l.catalogObjectId ? [{ productId: l.catalogObjectId, quantity: l.quantity }] : []));
    try {
      await recordOrder(r.session_id, r.square_order_id, lines, touched);
    } catch (e) {
      console.warn("[square] stock evidence not recorded yet", r.square_order_id, e instanceof Error ? e.message : e);
    }
  }
  let reads = 0;
  for (const k of card) {
    if (done.has(k.square_order_id)) continue;
    done.add(k.square_order_id);
    // An order that failed to read lately is skipped (on this server) until its wait is over.
    if ((readWait.get(k.square_order_id)?.until ?? 0) > Date.now()) continue;
    if (reads >= MAX_ORDER_READS || Date.now() - started >= budgetMs) break;
    reads++;
    let items: { catalogObjectId: string; quantity: number }[];
    let note: string | undefined;
    try {
      items = (await gateway.getOrderItems(k.square_order_id)).items;
    } catch (e) {
      if (squareStatus(e) === 404) {
        // Square has no such order, so it can't have taken anything. Recorded as empty (with the
        // reason, and on the audit trail) so it isn't asked about again.
        items = [];
        note = "Square has no record of this order, so it can't have taken any stock";
      } else {
        // Square is slow or down, or this order won't read. Stop reading for this pass (the rest
        // would most likely fail the same way, each costing up to 8 s), and don't try this order
        // again for a while so it can't take a slot from the ones behind it.
        const tries = (readWait.get(k.square_order_id)?.tries ?? 0) + 1;
        readWait.set(k.square_order_id, { tries, until: Date.now() + Math.min(30_000 * 2 ** (tries - 1), 900_000) });
        console.warn("[square] stock evidence not read yet", k.square_order_id, e instanceof Error ? e.message : e);
        break;
      }
    }
    readWait.delete(k.square_order_id);
    try {
      await recordOrder(k.session_id, k.square_order_id, items.map((i) => ({ productId: i.catalogObjectId, quantity: i.quantity })), touched, note);
    } catch (e) {
      console.warn("[square] stock evidence not recorded yet", k.square_order_id, e instanceof Error ? e.message : e);
    }
  }
}

/** Orders whose last read failed, on this server: when to try again, and how many tries so far. */
const readWait = new Map<string, { tries: number; until: number }>();

/** For tests: forget which orders are waiting out a failed read. */
export function resetStockReadWaitForTests(): void {
  readWait.clear();
}

// ---------------------------------------------------------------------------
// Reconciling: what Square's stock should hold for each bill
// ---------------------------------------------------------------------------

interface Diff {
  sessionId: string;
  productId: string;
  /** wanted − taken: positive = Square still has to be told about a sale, negative = items to put back. */
  delta: number;
}

/**
 * The bills whose moves don't add up to what they say, one row per product that differs.
 *
 *   wanted = the bill's live product lines for tracked items, if the bill is paid
 *   taken  = sale lines − restock lines, over moves that are done or on their way (pending)
 *
 * A bill is left out of this pass (and so never counts against `limit`) when it is not time to
 * judge it: a move of its own failed (a manager has to retry first), its cash sale is still on its
 * way to Square or failed (whether that sale ends up itemised isn't known yet), a card request with
 * an order is still live on the Terminal (it may yet pay and take the stock itself), or a paid
 * order of it hasn't been recorded. That is churn avoidance only: the same sums are taken again
 * next time, so nothing depends on what was skipped.
 *
 * Only bills opened after an item became tracked count for that item, on both sides of the sum:
 * Square's opening count for it already leaves out every earlier sale, so neither taking those off
 * nor putting them back is right.
 *
 * Bills come from what changed lately (`sessions.updated_at`, which every change to a bill touches,
 * a move, or a cash record, so a sale that sat failed for a week and is then retried is still found) rather than from when a bill was paid, so a bill reopened a week after payment is
 * still found. Bills paid before `stock_from` are never touched unless they already have moves.
 */
async function diffRows(q: Db, opts: { sessionId?: string; limit: number }): Promise<Diff[]> {
  const scope = opts.sessionId
    ? q`s.id = ${opts.sessionId}`
    : q`s.id in (
          select id from public.sessions where updated_at > now() - ${WINDOW}::interval
          union
          select session_id from public.stock_moves where updated_at > now() - ${WINDOW}::interval
          union
          select session_id from public.square_cash_records where updated_at > now() - ${WINDOW}::interval)`;
  const rows = await q<{ session_id: string; product_id: string; delta: number }[]>`
    with cand as (
      select s.id from public.sessions s, public.catalog_state c
      where c.id and s.kind <> 'part' and ${scope}
        and (s.settled_at >= c.stock_from or exists (select 1 from public.stock_moves m where m.session_id = s.id))
        and not exists (select 1 from public.stock_moves m where m.session_id = s.id and m.state = 'failed')
        and not exists (
          select 1 from public.square_cash_records r
          where r.session_id = s.id and r.want = 'recorded' and r.state in ('pending', 'failed')
            and r.seq = (select max(r2.seq) from public.square_cash_records r2 where r2.session_id = s.id))
        and not exists (
          select 1 from public.terminal_checkouts k
          where k.session_id = s.id and k.square_order_id is not null and k.status in ('PENDING', 'IN_PROGRESS', 'CANCEL_REQUESTED'))
        and not exists (
          select 1 from public.square_cash_records r
          where r.session_id = s.id and r.square_payment_id is not null and r.square_order_id is not null
            and r.created_at >= c.stock_from
            and not exists (select 1 from public.stock_moves m where m.source_order_id = r.square_order_id))
        and not exists (
          select 1 from public.terminal_checkouts k
          where k.session_id = s.id and k.status = 'COMPLETED' and k.square_order_id is not null
            and k.created_at >= c.stock_from
            and not exists (select 1 from public.stock_moves m where m.source_order_id = k.square_order_id))
    ),
    wanted as (
      select i.session_id, i.product_id, sum(i.quantity)::int as q
      from cand
      join public.sessions s on s.id = cand.id and s.status = 'paid'
      join public.session_items i on i.session_id = s.id and i.kind = 'product' and i.removed_at is null
      join public.products p on p.id = i.product_id and p.tracked and s.opened_at >= p.tracked_since
      group by i.session_id, i.product_id
    ),
    taken as (
      select m.session_id, l."productId" as product_id, sum(case when m.kind = 'sale' then l.quantity else -l.quantity end)::int as q
      from cand
      join public.sessions bs on bs.id = cand.id
      join public.stock_moves m on m.session_id = cand.id and m.state in ('done', 'pending')
      cross join lateral jsonb_to_recordset(m.lines) as l("productId" text, quantity integer)
      join public.products p on p.id = l."productId" and p.tracked and bs.opened_at >= p.tracked_since
      group by m.session_id, l."productId"
    ),
    diff as (
      select coalesce(w.session_id, t.session_id) as session_id, coalesce(w.product_id, t.product_id) as product_id,
             (coalesce(w.q, 0) - coalesce(t.q, 0))::int as delta
      from wanted w full outer join taken t on t.session_id = w.session_id and t.product_id = w.product_id
      where coalesce(w.q, 0) <> coalesce(t.q, 0)
    )
    select d.session_id, d.product_id, d.delta from diff d
    where d.session_id in (select session_id from diff group by session_id order by session_id limit ${opts.limit})
    order by d.session_id, d.product_id`;
  return rows.map((r) => ({ sessionId: r.session_id, productId: r.product_id, delta: r.delta }));
}

/** Writes the app moves that bring one bill's stock right, if it still needs them once its row is locked. */
async function reconcileBill(id: string): Promise<void> {
  await withTx(async (tx) => {
    // If the lock is busy this throws and the bill is looked at again on the next pass.
    if (!(await lockSession(tx, id))) return;
    const diff = await diffRows(tx, { sessionId: id, limit: 1 });
    const sale = diff.filter((d) => d.delta > 0).map((d): StockLine => ({ productId: d.productId, quantity: d.delta }));
    const restock = diff.filter((d) => d.delta < 0).map((d): StockLine => ({ productId: d.productId, quantity: -d.delta }));
    // Sale first: if both are needed they go out in that order.
    if (sale.length > 0) await insertMove(tx, { sessionId: id, kind: "sale", via: "app", lines: sale, state: "pending" });
    if (restock.length > 0) await insertMove(tx, { sessionId: id, kind: "restock", via: "app", lines: restock, state: "pending" });
  });
}

/**
 * Writes the app moves every bill needs. A bill whose lock is busy is skipped until the next pass;
 * nothing throws.
 */
export async function reconcileStock(limit = 50): Promise<void> {
  const bills = [...new Set((await diffRows(db(), { limit })).map((d) => d.sessionId))];
  for (const id of bills) {
    try {
      await reconcileBill(id);
    } catch (e) {
      console.warn("[square] stock not reconciled yet", id, e instanceof Error ? e.message : e);
    }
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Square answered, and the answer was no. A 401 or 403 is about the token, not the move: retried like an outage. */
function isRefusal(e: unknown): e is AppError {
  if (!isSquareRejection(e)) return false;
  const status = squareStatus(e);
  return status !== 401 && status !== 403;
}

// A move waits while any earlier move of its bill isn't done: one still on its way, or one that
// failed (a restock sent behind a sale Square never took would put back stock that never left).
// A move a worker is talking to Square about is left alone for 60 s, in case that worker died.
const dueSql = (q: Db) => q`
  m.state = 'pending' and m.next_attempt_at <= now()
  and (m.claimed_at is null or m.claimed_at < now() - interval '60 seconds')
  and not exists (
    select 1 from public.stock_moves p
    where p.session_id = m.session_id and p.seq < m.seq and p.state <> 'done')`;

/**
 * Claims the most overdue move that is due, or returns null. One statement, safe against other
 * workers. A bill's moves go out strictly in order: a move waits while an earlier one of the same
 * bill is still pending. `occurred_at` is fixed on the first claim and reused on every retry, so
 * the body under an idempotency key never changes. It is a few seconds in the past, because Square
 * refuses a time that is ahead of its own clock.
 */
async function claimNext(): Promise<StockMoveRow | null> {
  const q = db();
  const [row] = await q<StockMoveRow[]>`
    update public.stock_moves set
      claimed_at = now(), attempts = attempts + 1,
      occurred_at = coalesce(occurred_at, now() - interval '5 seconds')
    where id in (
      select m.id from public.stock_moves m
      where ${dueSql(q)}
      order by m.next_attempt_at, m.created_at
      limit 1
      for update skip locked)
    returning *`;
  return row ?? null;
}

const moveKey = (row: Pick<StockMoveRow, "session_id" | "seq">) => `${row.session_id}-st${row.seq}`;

function failureMessage(e: unknown): string {
  if (isKeyReused(e)) {
    return "Square already has a different request on file for this update. Look the item up in Square before trying again.";
  }
  if (e instanceof AppError) return e.message;
  return "Something went wrong while updating stock in Square.";
}

async function recordFailure(row: StockMoveRow, lines: StockLine[], e: unknown, tooOld = false): Promise<void> {
  const q = db();
  // `tooOld`: we didn't ask Square at all, but the answer would have been no, so it counts as refused.
  const refused = tooOld || isRefusal(e);
  const final = refused || isKeyReused(e) || row.attempts >= MAX_ATTEMPTS;
  const message = failureMessage(e).slice(0, 500);
  if (!(e instanceof AppError)) {
    console.warn("[square] stock move failed unexpectedly", row.id, e instanceof Error ? e.message : e);
  }

  if (!final) {
    // 30 s, doubling with each try, capped at 15 minutes.
    const waitSeconds = Math.min(30 * 2 ** Math.max(0, row.attempts - 1), 900);
    await q`
      update public.stock_moves set
        claimed_at = null, last_error = ${message}, next_attempt_at = now() + ${waitSeconds}::int * interval '1 second'
      where id = ${row.id}`;
    return;
  }

  await withTx(async (tx) => {
    const [after] = await tx<{ id: string }[]>`
      update public.stock_moves set claimed_at = null, last_error = ${message}, state = 'failed', refused = ${refused}
      where id = ${row.id} and state = 'pending'
      returning id`;
    if (!after) return;
    const names = await tx<{ id: string; name: string }[]>`
      select id, name from public.products where id = any(${lines.map((l) => l.productId)}::text[])`;
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const what = lines.map((l) => `${nameOf.get(l.productId) ?? "An item"} × ${l.quantity}`).join(", ");
    const head =
      row.kind === "sale"
        ? `Square's stock wasn't told about this bill's items (${what})`
        : `Square's stock wasn't given this bill's items back (${what})`;
    const why = refused || isKeyReused(e) ? message : `Square couldn't be reached after ${row.attempts} tries. ${message}`;
    await audit(tx, {
      actorStaffId: null,
      deviceLabel: SYSTEM_LABEL,
      action: "square.stock_failed",
      entity: "session",
      entityId: row.session_id,
      after: {
        seq: row.seq,
        kind: row.kind,
        lines,
        attempts: row.attempts,
        square: e instanceof AppError ? e.detail ?? null : null,
      },
      reason: tooOld
        ? `${head}. ${why}`
        : `${head}. ${why} A manager can send it again from Admin → Items.`,
    });
  });
}

/** Sends one claimed move. Returns the lines Square now holds, or null when it didn't take them. */
async function processMove(row: StockMoveRow, locationId: string): Promise<StockLine[] | null> {
  const q = db();
  const lines = parseLines(row.lines);
  try {
    // Square refuses an adjustment dated more than 24 h ago. A move Square refused is retried with
    // its original time (a changed body under the same key is exactly what a key is there to
    // catch), so by the time a manager retries it, it may be too old to be taken at all.
    if (lines.length > 0 && row.occurred_at && Date.now() - row.occurred_at.getTime() > 23.5 * 3_600_000) {
      await recordFailure(
        row,
        lines,
        new AppError(409, "stock_move_too_old", "This update is more than 24 hours old, which Square won't take. Correct the count in Square by hand."),
        true,
      );
      return null;
    }
    if (lines.length > 0) {
      await gateway.change({
        idempotencyKey: moveKey(row),
        locationId,
        kind: row.kind,
        lines: lines.map((l) => ({ variationId: l.productId, quantity: l.quantity })),
        occurredAt: row.occurred_at ?? new Date(),
      });
    }
    await q`
      update public.stock_moves set state = 'done', claimed_at = null, last_error = null
      where id = ${row.id} and state = 'pending'`;
    return lines;
  } catch (e) {
    if (isKeyReused(e)) {
      // Square already holds this move under its key. That can only be a move a manager retried
      // after `occurred_at` was refreshed, when the first try had in fact been applied. Nothing
      // is left to send; it must not be sent under another key.
      await q`
        update public.stock_moves set state = 'done', claimed_at = null,
          last_error = 'Square already had this update, so it was not sent again'
        where id = ${row.id} and state = 'pending'`;
      return lines;
    }
    await recordFailure(row, lines, e);
    return null;
  }
}

/**
 * Sends what is due: up to `limit` moves, one at a time, and no new move is started once
 * `budgetMs` has passed. Product ids Square has now been told about are added to `touched`.
 * Returns how many were worked on. Starts with a read-only check, so nothing due writes nothing.
 */
export async function sendStockMoves(
  opts: { limit?: number; budgetMs?: number } = {},
  touched: Set<string> = new Set(),
): Promise<number> {
  const limit = opts.limit ?? 5;
  const budgetMs = opts.budgetMs ?? 10_000;
  const q = db();
  const [due] = await q<{ due: boolean }[]>`
    select exists (select 1 from public.stock_moves m where ${dueSql(q)}) as due`;
  if (!due?.due) return 0;

  const locationId = squareEnv().SQUARE_LOCATION_ID;
  const started = Date.now();
  let worked = 0;
  while (worked < limit && Date.now() - started < budgetMs) {
    const row = await claimNext();
    if (!row) break;
    try {
      const sent = await processMove(row, locationId);
      if (sent) for (const l of sent) touched.add(l.productId);
    } catch (e) {
      // The database refused to take the outcome. The claim lapses after a minute and the move is
      // tried again with the same key.
      console.warn("[square] stock move left claimed", row.id, e instanceof Error ? e.message : e);
    }
    worked++;
  }
  return worked;
}

/** One pass: record paid orders, reconcile bills, send, then read back the counts of everything Square has just been told about. */
export async function runStockPass(opts: { limit?: number; budgetMs?: number } = {}): Promise<number> {
  const touched = new Set<string>();
  // One time budget for reading orders and sending moves, so a slow Square can't spend the whole
  // request before anything is sent. Reading stops at half of it; sending always gets a turn.
  const started = Date.now();
  const total = opts.budgetMs ?? 10_000;
  await recordStockEvidence(touched, { budgetMs: total / 2 });
  await reconcileStock();
  const worked = await sendStockMoves({ ...opts, budgetMs: Math.max(1_000, total - (Date.now() - started)) }, touched);
  if (touched.size > 0) {
    try {
      await refreshStock({ productIds: [...touched] });
    } catch (e) {
      console.warn("[square] stock counts not refreshed", e instanceof Error ? e.message : e);
    }
  }
  return worked;
}

/**
 * For `after()` on the floor route. Never throws, and does nothing when Square isn't configured.
 *
 * Reads every count from Square at most once every 2 minutes however many iPads are polling (the
 * refresh is claimed by stamping `stock_synced_at` first, so a failing Square isn't hammered), then
 * runs the pass. With nothing to do the pass is a few reads and no writes.
 */
export async function stockInBackground(): Promise<void> {
  try {
    if (!squareLooksConfigured()) return;
    const claimed = await db()<{ id: boolean }[]>`
      update public.catalog_state set stock_synced_at = now()
      where id and (stock_synced_at is null or stock_synced_at < now() - ${REFRESH_EVERY}::interval)
      returning id`;
    if (claimed.length > 0) {
      try {
        await refreshStock();
      } catch (e) {
        console.warn("[square] stock refresh skipped", e instanceof Error ? e.message : e);
      }
    }
    await runStockPass();
  } catch (e) {
    console.warn("[square] stock pass skipped", e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// What is still outstanding / manager retry
// ---------------------------------------------------------------------------

export interface StockOutstanding {
  pending: number;
  failed: number;
  lastError: string | null;
}

/** Every move (all time) Square hasn't taken yet, and the latest reason one failed or is being retried. */
export async function getStockOutstanding(q: Db = db()): Promise<StockOutstanding> {
  const [r] = await q<{ pending: number; failed: number; last_error: string | null }[]>`
    select
      count(*) filter (where state = 'pending')::int as pending,
      count(*) filter (where state = 'failed')::int as failed,
      (select last_error from public.stock_moves
       where state in ('pending', 'failed') and last_error is not null
       order by updated_at desc limit 1) as last_error
    from public.stock_moves
    where state in ('pending', 'failed')`;
  return { pending: r?.pending ?? 0, failed: r?.failed ?? 0, lastError: r?.last_error ?? null };
}

/**
 * Manager action: puts every failed move back in the queue, makes everything waiting due now, and
 * sends as much as fits in one request. Returns what is still outstanding afterwards.
 */
export async function retryStockMoves(actor: Actor, manager: Manager): Promise<{ pending: number; failed: number }> {
  squareEnv(); // 503 with a staff-readable message when Square isn't set up
  const before = await getStockOutstanding();
  if (before.pending + before.failed > 0) {
    // A failed move restarts at 1, not 0: zero means "nothing was ever sent", which is what lets a
    // reversal close a move instead of reversing it. A move that is more than 20 h old gets a new
    // `occurred_at`: Square refuses an adjustment older than 24 h, and if it did take the first
    // one, the key now says so ("a different request is on file") rather than counting it twice.
    // Only a move that never got an answer is refreshed: it may have been applied, and the key
    // settles that. A move Square refused keeps its time (and fails again if it is too old).
    await db()`
      update public.stock_moves set
        state = 'pending', next_attempt_at = now(), claimed_at = null,
        attempts = case when state = 'failed' then 1 else attempts end,
        occurred_at = case when not refused and occurred_at < now() - interval '20 hours' then now() - interval '5 seconds' else occurred_at end,
        refused = false
      where state = 'failed' or (state = 'pending' and next_attempt_at > now() and attempts > 0)`;
    // The iPad gives a POST 35 s. Ten seconds of starting new moves, plus the one in hand, fits.
    await runStockPass({ limit: 25, budgetMs: 10_000 });
  }
  const after = await getStockOutstanding();
  await audit(db(), {
    actorStaffId: actor.staffId,
    approvedByStaffId: manager.id,
    deviceLabel: actor.deviceLabel,
    action: "square.stock_retry",
    entity: "square_stock",
    entityId: null,
    before: { pending: before.pending, failed: before.failed },
    after: { pending: after.pending, failed: after.failed },
  });
  return { pending: after.pending, failed: after.failed };
}
