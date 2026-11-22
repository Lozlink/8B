import "server-only";
import { businessWindow, currentBusinessDate, formatYMD } from "@/lib/domain/business-day";
import type { ProfitLineDTO, ProfitReportDTO } from "@/lib/domain/types";
import { audit } from "./audit";
import type { Actor, Manager } from "./auth";
import { db, withTx } from "./db";
import { badRequest } from "./errors";
import { billedTotals, parseYMD } from "./queries";
import { getProducts, getSettings } from "./repo";
import { heldStock } from "./stock";

/*
 * What items cost the venue, and the profit on what was sold.
 *
 * Costs are typed in by a manager and stay in the app: Square only keeps unit costs on its paid
 * plans, and is never asked for them or told them. A cost is EX GST, in whole cents. Only manager
 * screens are ever sent one (see `ProductRow.cost_cents`).
 */

export const COST_MAX_CENTS = 1_000_000;
const MAX_COSTS_PER_CALL = 500;
const MAX_REPORT_DAYS = 366;

export interface CostInput {
  productId: string;
  costCents: number | null;
}

/**
 * Sets (or with null, clears) what products cost. All or nothing: one id that isn't a product and
 * nothing is saved. Each cost that actually changes gets its own audit row, so a product's cost
 * history can be read off the audit log.
 */
export async function setCosts(actor: Actor, manager: Manager, costs: CostInput[]): Promise<{ changed: number }> {
  if (costs.length === 0) throw badRequest("There are no costs to save.");
  if (costs.length > MAX_COSTS_PER_CALL) throw badRequest(`Save ${MAX_COSTS_PER_CALL} costs at a time at most.`);
  const wanted = new Map<string, number | null>();
  for (const c of costs) {
    if (wanted.has(c.productId)) throw badRequest("The same item is listed twice.");
    if (c.costCents !== null && (!Number.isInteger(c.costCents) || c.costCents < 0 || c.costCents > COST_MAX_CENTS)) {
      throw badRequest("A cost has to be between $0 and $10,000.");
    }
    wanted.set(c.productId, c.costCents);
  }
  const ids = [...wanted.keys()];

  return withTx(async (tx) => {
    // In id order, so two managers saving overlapping lists can't lock each other out.
    const rows = await tx<{ id: string; name: string; cost_cents: number | null }[]>`
      select id, name, cost_cents from public.products where id = any(${ids}::text[]) order by id for update`;
    if (rows.length !== ids.length) {
      const missing = ids.length - rows.length;
      throw badRequest(`${missing} of those items ${missing === 1 ? "isn't" : "aren't"} on the item list. Refresh and try again.`);
    }
    let changed = 0;
    for (const row of rows) {
      const cost = wanted.get(row.id) ?? null;
      if (cost === row.cost_cents) continue;
      await tx`
        update public.products set cost_cents = ${cost}, cost_updated_at = now(), cost_updated_by = ${manager.id}
        where id = ${row.id}`;
      await audit(tx, {
        actorStaffId: actor.staffId,
        approvedByStaffId: manager.id,
        deviceLabel: actor.deviceLabel,
        action: "product.cost",
        entity: "product",
        entityId: row.id,
        before: { name: row.name, cost_cents: row.cost_cents },
        after: { cost_cents: cost },
      });
      changed += 1;
    }
    return { changed };
  });
}

/** GST-inclusive cents with the GST taken out (one eleventh), to the nearest cent. */
export const exGst = (cents: number): number => Math.round((cents * 10) / 11);

const bps = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part * 10_000) / whole) : null);

interface ProfitRow {
  product_id: string | null;
  name: string;
  quantity: number;
  sales_cents: number;
  sales_ex_cents: number;
  uncosted_quantity: number;
  costed_sales_ex_cents: number;
  cost_cents: number;
}

/**
 * Profit on the items sold between two business dates (both included). No dates = the business
 * day running now. The bills counted are the daily summary's: table and counter bills that are
 * not void, by the day they were closed.
 */
export async function getProfitReport(fromIn: string | null, toIn: string | null): Promise<ProfitReportDTO> {
  // `?from=2026-11-01&to=` arrives as an empty string: that is a date left out, not a date.
  const fromParam = fromIn || null;
  const toParam = toIn || null;
  const q = db();
  const settings = await getSettings(q);
  const tz = settings.timezone;
  const today = currentBusinessDate(new Date(), settings.businessDayStartMinute, tz);
  if ((fromParam === null) !== (toParam === null)) throw badRequest("Give both dates, or neither.");
  const first = fromParam ? parseYMD(fromParam, "from") : today;
  const last = toParam ? parseYMD(toParam, "to") : today;
  const days = (Date.UTC(last.y, last.m - 1, last.d) - Date.UTC(first.y, first.m - 1, first.d)) / 86_400_000;
  if (days < 0) throw badRequest("The first date is after the last.");
  if (days >= MAX_REPORT_DAYS) throw badRequest("Pick a year at most.");
  const from = businessWindow(first, settings.businessDayStartMinute, tz).from;
  const to = businessWindow(last, settings.businessDayStartMinute, tz).to;

  const [rows, billed, products, held] = await Promise.all([
    // A line's cost is the one copied onto the bill when it was sold; a line from before costs
    // were entered falls back to the product's cost now. One with neither is uncosted: it counts
    // in the sales, and in nothing after that. GST comes out line by line, so a product sold both
    // taxed and GST-free over time is still right.
    q<ProfitRow[]>`
      select i.product_id, (array_agg(i.name order by i.added_at desc, i.id))[1] as name,
             sum(i.quantity)::int as quantity,
             sum(l.cents)::int as sales_cents,
             sum(l.ex_cents)::int as sales_ex_cents,
             coalesce(sum(i.quantity) filter (where l.unit_cost is null), 0)::int as uncosted_quantity,
             coalesce(sum(l.ex_cents) filter (where l.unit_cost is not null), 0)::int as costed_sales_ex_cents,
             coalesce(sum(l.unit_cost * i.quantity), 0)::int as cost_cents
      from public.session_items i
      join public.sessions s on s.id = i.session_id
      left join public.products p on p.id = i.product_id
      cross join lateral (
        select i.unit_cents * i.quantity as cents,
               case when i.taxed then round(i.unit_cents * i.quantity * 10 / 11.0)::int else i.unit_cents * i.quantity end as ex_cents,
               coalesce(i.unit_cost_cents, p.cost_cents) as unit_cost
      ) l
      where i.removed_at is null and i.kind <> 'split'
        and s.kind <> 'part' and s.status <> 'void' and s.closed_at >= ${from} and s.closed_at < ${to}
      group by i.product_id, case when i.product_id is null then lower(btrim(i.name)) end`,
    billedTotals(q, from, to),
    getProducts(q, { activeOnly: true }),
    heldStock(q),
  ]);

  const lines: ProfitLineDTO[] = rows.map((r) => {
    const profitCents = r.costed_sales_ex_cents - r.cost_cents;
    return {
      productId: r.product_id,
      name: r.name,
      quantity: r.quantity,
      salesCents: r.sales_cents,
      salesExGstCents: r.sales_ex_cents,
      uncostedQuantity: r.uncosted_quantity,
      costCents: r.cost_cents,
      profitCents,
      marginBps: bps(profitCents, r.costed_sales_ex_cents),
    };
  });
  // Biggest profit first. A line with nothing costed has no profit to rank by, so those go last,
  // biggest seller first: they are the ones most worth entering a cost for.
  const anyCosted = (l: ProfitLineDTO) => l.uncostedQuantity < l.quantity;
  lines.sort(
    (a, b) =>
      Number(anyCosted(b)) - Number(anyCosted(a)) ||
      (anyCosted(a) ? b.profitCents - a.profitCents : b.salesCents - a.salesCents) ||
      a.name.localeCompare(b.name),
  );

  const sum = (pick: (r: ProfitRow) => number) => rows.reduce((a, r) => a + pick(r), 0);
  const costedSalesEx = sum((r) => r.costed_sales_ex_cents);
  const costCents = sum((r) => r.cost_cents);
  const salesExGstCents = sum((r) => r.sales_ex_cents);

  // Same sum as the daily summary: billed = table + items − discounts − shares written off.
  const b = billed[0];
  const tableCents = b ? b.cents - b.items_cents + b.discount_cents + b.written_off_cents : 0;

  // What is on the shelf, at cost. Square's count less what is on bills it hasn't heard about,
  // as the item list shows it; a count below zero is worth nothing rather than a negative amount.
  let stockCost = 0;
  let stockUnits = 0;
  let stockUncosted = 0;
  for (const p of products) {
    if (!p.tracked || p.stock_count === null) continue;
    const onHand = Math.max(0, p.stock_count - (held.get(p.id) ?? 0));
    if (onHand === 0) continue;
    if (p.cost_cents === null) stockUncosted += 1;
    else {
      stockCost += onHand * p.cost_cents;
      stockUnits += onHand;
    }
  }

  return {
    today: formatYMD(today),
    from: formatYMD(first),
    to: formatYMD(last),
    lines,
    items: {
      quantity: sum((r) => r.quantity),
      salesCents: sum((r) => r.sales_cents),
      salesExGstCents,
      uncostedQuantity: sum((r) => r.uncosted_quantity),
      uncostedSalesExGstCents: salesExGstCents - costedSalesEx,
      costCents,
      profitCents: costedSalesEx - costCents,
      marginBps: bps(costedSalesEx - costCents, costedSalesEx),
    },
    table: { cents: tableCents, exGstCents: exGst(tableCents) },
    discountCents: b?.discount_cents ?? 0,
    stock: { costCents: stockCost, units: stockUnits, uncostedProducts: stockUncosted },
  };
}
