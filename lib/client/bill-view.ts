import { billTotals, itemCents, type BillTotals } from "@/lib/domain/bill";
import type { SessionDetailDTO, SessionItemDTO } from "@/lib/domain/types";

/** Items counted by quantity (3 lines of "Snack" = 3 items). */
export function itemCount(items: readonly Pick<SessionItemDTO, "quantity">[]): number {
  return items.reduce((n, i) => n + i.quantity, 0);
}

export function itemsLabel(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

export interface ItemGroup {
  key: string;
  name: string;
  unitCents: number;
  quantity: number;
  cents: number;
  taxed: boolean;
}

/** Merges lines of the same product at the same price ("Snack × 2"). Display only; removal is per line. */
export function groupItems(items: readonly SessionItemDTO[]): ItemGroup[] {
  const map = new Map<string, ItemGroup>();
  for (const i of items) {
    const key = `${i.productId}|${i.unitCents}|${i.taxed ? 1 : 0}`;
    const g = map.get(key);
    if (g) {
      g.quantity += i.quantity;
      g.cents += itemCents(i);
    } else {
      map.set(key, { key, name: i.name, unitCents: i.unitCents, quantity: i.quantity, cents: itemCents(i), taxed: i.taxed });
    }
  }
  return [...map.values()];
}

/**
 * The bill for a stopped session (or one still running, when `liveTableCents` is given).
 * `breakdown` is table time only; once stopped, `session.totalCents` is the whole bill.
 */
export function billOf(detail: SessionDetailDTO, liveTableCents?: number | null): BillTotals | null {
  const s = detail.session;
  let tableCents: number | null;
  if (liveTableCents !== undefined) tableCents = liveTableCents;
  else if (s.totalCents !== null) tableCents = s.totalCents - s.itemsCents;
  else tableCents = detail.breakdown?.totalCents ?? null;
  if (tableCents === null) return null;
  return billTotals(tableCents, s.items);
}
