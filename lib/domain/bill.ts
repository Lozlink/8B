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

export function billTotals(tableCents: number, items: readonly BillItem[]): BillTotals {
  const all = itemsCents(items);
  const taxedItems = itemsCents(items.filter((i) => i.taxed));
  return {
    tableCents,
    itemsCents: all,
    totalCents: tableCents + all,
    gstCents: gstOf(tableCents + taxedItems),
  };
}
