import { billTotals, discountCentsFor, itemCents, itemsCents as sumItems, type BillTotals } from "@/lib/domain/bill";
import { can, isCheckoutLive, type SessionAction } from "@/lib/domain/machine";
import type {
  BillDiscountDTO,
  DiscountDTO,
  SessionDetailDTO,
  SessionDTO,
  SessionItemDTO,
} from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";
import { formatBps } from "./money";
import { sessionTableNames } from "./session-view";

/** Items counted by quantity (3 lines of "Snack" = 3 items). */
export function itemCount(items: readonly Pick<SessionItemDTO, "quantity">[]): number {
  return items.reduce((n, i) => n + i.quantity, 0);
}

export function itemsLabel(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

export interface ItemGroup {
  key: string;
  kind: SessionItemDTO["kind"];
  name: string;
  unitCents: number;
  quantity: number;
  cents: number;
  taxed: boolean;
}

/**
 * Merges lines of the same product at the same price ("Snack × 2"). Display only; removal is per line.
 * Custom charges have no product, so they merge only when the name and price are the same.
 */
export function groupItems(items: readonly SessionItemDTO[]): ItemGroup[] {
  const map = new Map<string, ItemGroup>();
  for (const i of items) {
    const who = i.kind === "product" && i.productId !== null ? i.productId : `${i.kind}:${i.name}`;
    const key = `${who}|${i.unitCents}|${i.taxed ? 1 : 0}`;
    const g = map.get(key);
    if (g) {
      g.quantity += i.quantity;
      g.cents += itemCents(i);
    } else {
      map.set(key, {
        key,
        kind: i.kind,
        name: i.name,
        unitCents: i.unitCents,
        quantity: i.quantity,
        cents: itemCents(i),
        taxed: i.taxed,
      });
    }
  }
  return [...map.values()];
}

/** "2 × Snack". A part's one line is its share of the bill, so it is just the name. */
export function lineLabel(i: Pick<SessionItemDTO, "kind" | "quantity" | "name">): string {
  return i.kind === "split" ? i.name : `${i.quantity} × ${i.name}`;
}

// ---------------------------------------------------------------------------
// The bill
// ---------------------------------------------------------------------------

/** What a bill comes to, with the discount and the part paid separately shown on their own. */
export interface BillView extends BillTotals {
  discountCents: number;
  /** Money moved onto parts split off this bill (they are paid separately). */
  splitOffCents: number;
  /** The discount on the bill, if any (its `cents` is exact only once the session is stopped). */
  discount: BillDiscountDTO | null;
  /** true while the table is still running: table time and the discount are worked out live. */
  estimate: boolean;
}

export interface BillViewInput {
  /**
   * Table time for a session that is still running or paused (the live estimate). Ignored once
   * stopped: then the stored total is the truth. `undefined` = use `storedTableCents`.
   */
  liveTableCents?: number | null;
  /** Table time from the server's own breakdown; only used when there is no stored total. */
  storedTableCents?: number | null;
}

/**
 * The bill for a session, whatever its status.
 *   total = table time + items − discount − paid separately (never below 0)
 *
 * Running or paused: table time is the live estimate and the discount is worked out from it with
 * `discountCentsFor` (the server stores 0 until the session stops); `estimate` is true.
 * Stopped: the stored total is authoritative, so table time is whatever is left once items, the
 * discount and the split-off part are put back.
 * Null when there is nothing to work from yet.
 */
export function sessionBill(s: SessionDTO, input: BillViewInput = {}): BillView | null {
  const live = s.status === "running" || s.status === "paused";
  const items = sumItems(s.items);
  let tableCents: number;
  let discountCents: number;
  let splitOffCents = 0;

  if (live) {
    const t = input.liveTableCents !== undefined ? input.liveTableCents : (input.storedTableCents ?? null);
    if (t === null) return null;
    tableCents = t;
    discountCents = s.discount ? discountCentsFor(tableCents + items, s.discount.kind, s.discount.value) : 0;
  } else if (s.totalCents !== null) {
    discountCents = s.discount?.cents ?? 0;
    splitOffCents = s.splitOffCents;
    tableCents = Math.max(0, s.totalCents - items + discountCents + splitOffCents);
  } else {
    const t = input.storedTableCents ?? null;
    if (t === null) return null;
    tableCents = t;
    discountCents = s.discount ? discountCentsFor(tableCents + items, s.discount.kind, s.discount.value) : 0;
    splitOffCents = s.splitOffCents;
  }
  return {
    ...billTotals(tableCents, s.items, { discountCents, splitOffCents }),
    discount: s.discount,
    estimate: live,
  };
}

/**
 * The bill for a session with its detail loaded (or one still running, when `liveTableCents` is
 * given). `breakdown` is table time only; once stopped, `session.totalCents` is the whole bill.
 */
export function billOf(detail: SessionDetailDTO, liveTableCents?: number | null): BillView | null {
  return sessionBill(detail.session, {
    liveTableCents,
    storedTableCents: detail.breakdown?.totalCents ?? null,
  });
}

/** Table time plus items: what a discount is worked out on and what an amount discount is capped at. */
export function discountBase(bill: Pick<BillView, "tableCents" | "itemsCents">): number {
  return bill.tableCents + bill.itemsCents;
}

// ---------------------------------------------------------------------------
// Words for discounts
// ---------------------------------------------------------------------------

/** What a discount from the Square list is: "10% off", "$5.00 off", "Any percent", "Any amount". */
export function discountWhat(d: Pick<DiscountDTO, "kind" | "value">): string {
  switch (d.kind) {
    case "percent":
      return `${formatBps(d.value ?? 0)} off`;
    case "amount":
      return `${formatCents(d.value ?? 0)} off`;
    case "variable_percent":
      return "Any percent";
    case "variable_amount":
      return "Any amount";
  }
}

/** The bill's own discount, as a short phrase: "10%" or "$5.00". */
export function appliedWhat(d: Pick<BillDiscountDTO, "kind" | "value">): string {
  return d.kind === "percent" ? formatBps(d.value) : formatCents(d.value);
}

/** "Discount — Staff (10%)". An amount discount has no bracket: its amount is on the same line. */
export function discountRowLabel(d: Pick<BillDiscountDTO, "name" | "kind" | "value">): string {
  return `Discount — ${d.name}${d.kind === "percent" ? ` (${formatBps(d.value)})` : ""}`;
}

export const PAID_SEPARATELY_LABEL = "Paid separately (split)";

/** "−$2.50". Uses a real minus sign. */
export function minus(cents: number): string {
  return `−${formatCents(cents)}`;
}

/** "Discount −$2.50" / "Paid separately −$20.00", for small summaries. Null when the bill has neither. */
export function adjustmentsSummary(bill: Pick<BillView, "discountCents" | "splitOffCents" | "estimate">): string | null {
  const parts: string[] = [];
  if (bill.discountCents > 0) parts.push(`Discount ${minus(bill.discountCents)}${bill.estimate ? " est." : ""}`);
  if (bill.splitOffCents > 0) parts.push(`${minus(bill.splitOffCents)} paid separately`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The small line under the day's Billed figure: table time, items, and what came off (discounts, and
 * shares of split bills a manager wrote off) when there is any, so
 * table + items − discounts − written off = billed can be read off the screen.
 */
export function billedSubtitle(t: {
  tableCents: number;
  itemsCents: number;
  discountCents: number;
  writtenOffCents?: number;
}): string {
  const writtenOff = t.writtenOffCents ?? 0;
  if (t.itemsCents <= 0 && t.discountCents <= 0 && writtenOff <= 0) return "GST included";
  const parts = [`Table ${formatCents(t.tableCents)}`, `Items ${formatCents(t.itemsCents)}`];
  if (t.discountCents > 0) parts.push(`Discounts ${minus(t.discountCents)}`);
  if (writtenOff > 0) parts.push(`Written off ${minus(writtenOff)}`);
  parts.push("GST included");
  return parts.join(" · ");
}

/** A stable list key for an items-sold row: custom charges have no product, so they go by name. */
export function itemsSoldKey(i: { productId: string | null; name: string }): string {
  return i.productId ?? `custom:${i.name}`;
}

// ---------------------------------------------------------------------------
// What a bill can do
// ---------------------------------------------------------------------------

const TABLE_ONLY: ReadonlySet<SessionAction> = new Set([
  "pause",
  "resume",
  "transfer",
  "stop",
  "continue",
  "release_table",
  "edit_times",
]);
const NOT_ON_PART: ReadonlySet<SessionAction> = new Set(["add_item", "remove_item", "set_discount", "remove_discount", "split"]);

/**
 * `can` from the state machine, narrowed by the kind of bill: a counter sale or a part has no
 * timer (no pause, stop, transfer, edit times); a part takes no items, discount or split; only a
 * part can be merged back; only a counter sale can be discarded; only table and counter bills split.
 */
export function billCan(s: Pick<SessionDTO, "status" | "kind">, action: SessionAction): boolean {
  if (!can(s.status, action)) return false;
  if (s.kind !== "table" && TABLE_ONLY.has(action)) return false;
  if (s.kind === "part" && NOT_ON_PART.has(action)) return false;
  if (action === "merge_back") return s.kind === "part";
  if (action === "discard") return s.kind === "counter";
  return true;
}

/** true once a bill has parts standing: its discount can't change until they are merged back. */
export function hasParts(s: Pick<SessionDTO, "parts" | "splitOffCents">): boolean {
  return s.parts.length > 0 || s.splitOffCents > 0;
}

/**
 * Why a bill's discount can't change, in the server's own words, or null when it can. Once a share
 * has been paid or written off it can't be merged back, so "merge the parts back" would be a lie.
 */
export function discountLockedReason(s: Pick<SessionDTO, "parts" | "splitOffCents">): string | null {
  if (!hasParts(s)) return null;
  if (s.parts.some((p) => p.status === "paid" || p.status === "void")) {
    return "A share of this bill has already been paid or written off, so its discount can't be changed.";
  }
  return "This bill has been split, so its discount can't change. Merge the parts back first.";
}

/**
 * What to call a bill: a table's bill reads as the tables it used; a counter sale or a part has no
 * table, so it uses the server's label ("Counter sale", "Table 3 · share").
 */
export function billName(s: Pick<SessionDTO, "kind" | "label" | "intervals">): string {
  if (s.kind !== "table") return s.label;
  return sessionTableNames(s) || s.label;
}

/** "Table 3 · Sam": a title with the customer's name after it, when the bill has one. */
export function withName(title: string, customerName: string | null | undefined): string {
  const name = customerName?.trim();
  return name ? `${title} · ${name}` : title;
}

/** `billName` plus the customer's name: what to put in a sheet title or a toast. */
export function billTitle(s: Pick<SessionDTO, "kind" | "label" | "intervals" | "customerName">): string {
  return withName(billName(s), s.customerName);
}

/**
 * true when a stopped table can go back to running ("Keep playing"): a table's own bill, still on
 * its table, not split, and with nothing on the Terminal. The server checks the same things.
 */
export function canContinue(s: Pick<SessionDTO, "status" | "kind" | "currentTableId" | "parts" | "splitOffCents" | "checkout">): boolean {
  return billCan(s, "continue") && s.currentTableId !== null && !hasParts(s) && !isCheckoutLive(s.checkout?.status);
}

/** true for a counter sale that has nothing on it and no card or cash started: safe to throw away. */
export function isEmptyCounterSale(s: SessionDTO): boolean {
  return s.kind === "counter" && s.status === "awaiting_payment" && s.itemsCents === 0 && s.checkout === null;
}
