/**
 * Bill arithmetic shared by the server and the UI. Pure: no I/O.
 *
 * A bill is table time plus the items put on it. All amounts are integer cents, GST-inclusive.
 * Table hire is always taxed; an item is taxed unless its Square item has no tax attached.
 */
import { gstOf } from "@/lib/pricing";

export interface BillItem {
  unitCents: number;
  quantity: number;
  taxed: boolean;
}

export interface BillTotals {
  tableCents: number;
  itemsCents: number;
  totalCents: number;
  /** GST included in the total (one eleventh of the taxed part, rounded half up). */
  gstCents: number;
}

export function itemCents(i: Pick<BillItem, "unitCents" | "quantity">): number {
  return i.unitCents * i.quantity;
}

export function itemsCents(items: readonly BillItem[]): number {
  return items.reduce((sum, i) => sum + itemCents(i), 0);
}

/**
 * What to collect when a bill is paid in cash: the total rounded to the nearest 5c (1–2c down,
 * 3–4c up), as Australian cash is. Square refuses cash amounts that aren't a multiple of 5c.
 * Card payments are never rounded.
 */
export function cashDueCents(totalCents: number): number {
  return Math.round(totalCents / 5) * 5;
}

/**
 * What a discount takes off a bill whose table time + items come to `baseCents`.
 * percent: `value` is basis points (1000 = 10%), rounded half up to the cent.
 * amount:  `value` is cents, capped at the bill.
 * The server stores the result (sessions.discount_cents); the screens use this for live estimates.
 */
export function discountCentsFor(baseCents: number, kind: "percent" | "amount", value: number): number {
  if (baseCents <= 0 || value <= 0) return 0;
  if (kind === "amount") return Math.min(value, baseCents);
  return Math.min(baseCents, Math.floor((baseCents * value + 5000) / 10000));
}

export interface BillAdjustments {
  /** What the discount takes off (see `discountCentsFor`). */
  discountCents?: number;
  /** Money moved onto parts split off this bill. */
  splitOffCents?: number;
}

/**
 * The bill: totalCents = tableCents + itemsCents − discountCents − splitOffCents.
 *
 * GST is one eleventh of the taxed share of what is left to pay: the discount and any split come
 * off taxed and GST-free lines in proportion. For the usual bill, where everything is taxed, that
 * is simply one eleventh of the total.
 */
export function billTotals(tableCents: number, items: readonly BillItem[], adjust: BillAdjustments = {}): BillTotals & {
  discountCents: number;
  splitOffCents: number;
} {
  const all = itemsCents(items);
  const taxedItems = itemsCents(items.filter((i) => i.taxed));
  const base = tableCents + all;
  const discountCents = Math.min(adjust.discountCents ?? 0, base);
  const splitOffCents = Math.min(adjust.splitOffCents ?? 0, base - discountCents);
  const totalCents = base - discountCents - splitOffCents;
  const taxedBase = tableCents + taxedItems;
  const taxedShare = base === 0 ? 0 : Math.round((totalCents * taxedBase) / base);
  return {
    tableCents,
    itemsCents: all,
    discountCents,
    splitOffCents,
    totalCents,
    gstCents: gstOf(taxedShare),
  };
}
