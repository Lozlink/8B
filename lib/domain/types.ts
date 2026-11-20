/** DTOs shared by server routes and client components. Dates are ISO strings. */
import type { PricingRateCard, PricingSettings, PriceLine } from "@/lib/pricing";
import type { CheckoutStatus, SessionStatus } from "./machine";

export type StaffRole = "staff" | "manager";
export type SettledMethod = "card" | "cash";
export type SettledVia = "square_webhook" | "square_api" | "staff";

export interface MeDTO {
  staff: { id: string; name: string; role: StaffRole };
  device: { id: string; label: string };
}

export interface TableDTO {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface IntervalDTO {
  id: string;
  tableId: string;
  tableName: string;
  startedAt: string;
  endedAt: string | null;
}

export interface CheckoutDTO {
  id: string;
  attempt: number;
  amountCents: number;
  status: CheckoutStatus;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A fixed-price item from the Square catalogue that can go on a bill. `id` is the Square variation id. */
export interface ProductDTO {
  id: string;
  name: string;
  priceCents: number;
  /** false = GST-free (the Square item has no tax attached). */
  taxed: boolean;
  category: string | null;
  /** The item's barcode in Square (its GTIN), digits only. null = it has none. */
  barcode: string | null;
  /**
   * How many are left to sell right now: Square's count, less what is sitting on bills Square
   * hasn't been told about yet (unpaid bills, and paid ones still on their way). Can be zero or
   * negative; the item can still be sold. null = Square doesn't track stock for this item, or it
   * has never been counted there.
   */
  stock: number | null;
}

/**
 * A discount staff can put on a bill, copied from the Square catalogue.
 *   percent / amount                   — fixed in Square; any staff member can apply it
 *   variable_percent / variable_amount — the value is typed in when applied; needs a manager PIN
 * `value` is basis points for the percent kinds (1000 = 10%) and cents for the amount kinds; null
 * for the variable kinds.
 */
export interface DiscountDTO {
  id: string;
  name: string;
  kind: "percent" | "amount" | "variable_percent" | "variable_amount";
  value: number | null;
}

/** The discount on a bill. One per bill, off the whole bill (table time + items). */
export interface BillDiscountDTO {
  /** Square catalogue discount id; null = typed in by a manager. */
  discountId: string | null;
  name: string;
  kind: "percent" | "amount";
  /** Basis points (percent) or cents (amount). */
  value: number;
  /**
   * What it takes off the bill. Exact once the session is stopped; 0 while it is still running
   * (use `discountCentsFor` in lib/domain/bill.ts on the live estimate).
   */
  cents: number;
  byName: string;
}

/**
 * A refund a manager asked for.
 *   pending   — Square hasn't confirmed it yet
 *   completed — done
 *   failed    — Square refused it or it failed; nothing was refunded
 */
export interface RefundDTO {
  id: string;
  amountCents: number;
  /** card = back to the card; cash = handed back and recorded in Square. */
  method: SettledMethod;
  reason: string;
  state: "pending" | "completed" | "failed";
  /** Why it failed or is still waiting, if known. Staff-readable. */
  error: string | null;
  /** the app has stopped trying; a manager has to look at this payment in Square and say what happened */
  needsCheck: boolean;
  createdAt: string;
  byName: string;
  approvedByName: string;
}

/**
 * table   — a table's bill
 * counter — a sale with no table (no table time)
 * part    — a share split off another bill; paid like any bill, but nothing can be added to it
 */
export type BillKind = "table" | "counter" | "part";

/** A share split off a bill, as listed on that bill. Merged-back parts are not listed. */
export interface PartDTO {
  id: string;
  amountCents: number;
  status: SessionStatus;
  /** true while a card request for this part is live on the Terminal. */
  onTerminal: boolean;
}

/**
 * A line on a bill. Name, price and GST flag were copied when it was added.
 *   product — a Square catalogue item (`productId` set)
 *   custom  — a name and price typed in by staff
 *   split   — the single line on a part: its share of the bill it was split from
 */
export interface SessionItemDTO {
  id: string;
  kind: "product" | "custom" | "split";
  productId: string | null;
  name: string;
  unitCents: number;
  quantity: number;
  taxed: boolean;
  addedAt: string;
  addedByName: string;
  /** Set once the item has been taken off the bill (the row is kept). */
  removedAt: string | null;
  removedByName: string | null;
}

/**
 * A cash payment's record in Square.
 *   pending  — still being sent (retried in the background)
 *   recorded — the sale is in Square
 *   refunded — the payment was reversed here and the sale and its refund are both in Square
 *   skipped  — reversed before anything reached Square
 *   failed   — Square refused it or it kept failing; a manager can retry in Admin → Items
 */
export type SquareCashState = "pending" | "recorded" | "refunded" | "skipped" | "failed";

export interface SquareCashDTO {
  state: SquareCashState;
  amountCents: number;
  /** Why the last try failed, if it did. Staff-readable. */
  error: string | null;
}

export interface SessionDTO {
  id: string;
  kind: BillKind;
  /**
   * What to call this bill when it isn't on a table: "Counter sale", "Table 3 · share", or the
   * table names for a table's bill. Always set.
   */
  label: string;
  status: SessionStatus;
  currentTableId: string | null;
  openedAt: string;
  openedByName: string;
  closedAt: string | null;
  billedMinutes: number | null;
  /**
   * What is owed on THIS bill once the session is stopped:
   * table time + itemsCents − discount.cents − splitOffCents. Null while running.
   */
  totalCents: number | null;
  discount: BillDiscountDTO | null;
  /** On a part: the bill it was split from. */
  splitOfId: string | null;
  /** On a bill that was split: the total of its parts that still stand (collected on those parts). */
  splitOffCents: number;
  /** On a bill that was split: its parts, oldest first. Empty otherwise. */
  parts: PartDTO[];
  /** Refunds on this bill that have not failed (pending + completed). */
  refundedCents: number;
  /**
   * Set when this paid bill can be refunded from the app: how the money goes back and the most that
   * can still be refunded. Null when it can't (not paid, fully refunded, the card was taken on
   * another reader, or the cash sale isn't in Square yet).
   */
  refundable: { method: SettledMethod; maxCents: number } | null;
  /** true when the Terminal can print a receipt for this bill (paid, payment known to Square, Terminal paired). */
  canPrintReceipt: boolean;
  /** Sum of the items currently on the bill (0 if none). Valid in every status. */
  itemsCents: number;
  /** Items currently on the bill, oldest first. Removed items are only in SessionDetailDTO. */
  items: SessionItemDTO[];
  settledMethod: SettledMethod | null;
  settledVia: SettledVia | null;
  settledAt: string | null;
  settledByName: string | null;
  /**
   * What was actually collected, once paid. Cash is the bill rounded to the nearest 5c
   * (`cashDueCents` in lib/domain/bill.ts); a card is the amount the card was charged.
   */
  settledCents: number | null;
  /** Where the latest cash payment for this bill stands in Square. Null if it was never paid in cash. */
  squareCash: SquareCashDTO | null;
  voidReason: string | null;
  note: string | null;
  intervals: IntervalDTO[];
  /** Latest Terminal checkout attempt, if any. */
  checkout: CheckoutDTO | null;
}

export interface PricingConfigDTO {
  settings: PricingSettings;
  rateCards: PricingRateCard[];
}

export interface FloorDTO {
  serverTime: string;
  tables: TableDTO[];
  /** Sessions occupying a table (running, paused, or a bill still on the table). */
  sessions: SessionDTO[];
  /** Count of bills awaiting payment that are no longer on a table. */
  unpaidOffTableCount: number;
  /**
   * Changes whenever any bill awaiting payment that is NOT on a table changes: a counter sale, a
   * part of a split bill, a bill left unpaid. Those are not in `sessions`, so nothing else in this
   * payload moves when another iPad adds an item to one, discounts it, splits it, sends it to the
   * Terminal or takes payment for it. Opaque: compare it, don't read it. Null when there are none.
   * It does not change when nothing has (the background checks never move it).
   */
  unpaidStamp: string | null;
  pricing: PricingConfigDTO;
  terminalPaired: boolean;
  /**
   * true when the server can hand a cash sale to the Square POS app (SQUARE_APPLICATION_ID is set).
   * Whether THIS iPad offers it is a per-device switch kept in the browser (the iPad on the Square
   * Stand, where the cash drawer is).
   */
  posCashAvailable: boolean;
  /** Items staff can put on a bill (active products, in display order). Empty if none are synced. */
  products: ProductDTO[];
  /** Discounts staff can put on a bill (active ones from Square, by name). Empty if none exist. */
  discounts: DiscountDTO[];
}

export interface SessionDetailDTO {
  session: SessionDTO;
  checkouts: CheckoutDTO[];
  /**
   * TABLE TIME ONLY: `totalCents` and `gstCents` here exclude items. The whole bill is
   * `breakdown.totalCents + session.itemsCents` (see lib/domain/bill.ts).
   */
  breakdown: { billedMinutes: number; totalCents: number; gstCents: number; actualMs: number; lines: PriceLine[] } | null;
  /** Items that were taken off this bill, oldest first. */
  removedItems: SessionItemDTO[];
  /** Every refund asked for on this bill, oldest first, including failed ones. */
  refunds: RefundDTO[];
  audit: AuditEntryDTO[];
}

export interface AuditEntryDTO {
  id: string;
  at: string;
  actorName: string | null;
  approvedByName: string | null;
  deviceLabel: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface SummaryDTO {
  businessDate: string; // YYYY-MM-DD (local)
  from: string;
  to: string;
  /**
   * Bills closed in the window that are not void.
   *   billedCents   — what is owed on every one of them, parts included (each at its own
   *                   totalCents). A split bill and its parts add up to the bill before the split;
   *                   a part or a bill a manager voided drops out, a merged-back part was never in.
   *                   A part counts on the business day of the bill it was split from, even if the
   *                   split was made on a later day.
   *   count, billedMinutes, itemsCents, discountCents — table and counter bills only. A part is a
   *                   share of one of those, never a bill of its own here.
   *   writtenOffCents — shares a manager voided (parts that are void and were not merged back) on
   *                   bills that are themselves counted here. That money is not in billedCents,
   *                   but the bill's items and discount are still counted whole, so it is shown.
   *   tableCents    — the rest: billedCents − itemsCents + discountCents + writtenOffCents, so
   *                   tableCents + itemsCents − discountCents − writtenOffCents = billedCents
   *                   always holds, and tableCents is the real table time (never negative).
   * One case stays approximate: the REST of a split bill voided after a share was paid. The bill
   * is void, so its items and discount aren't counted, and the paid share's money all shows as
   * table time. The billed figure is exact even then.
   */
  sessions: {
    count: number;
    billedMinutes: number;
    billedCents: number;
    tableCents: number;
    itemsCents: number;
    discountCents: number;
    writtenOffCents: number;
  };
  /**
   * Lines on the table and counter bills counted in `sessions`, biggest first. Custom charges have
   * a null productId and are grouped by name. Split lines are left out.
   */
  itemsSold: { productId: string | null; name: string; quantity: number; cents: number }[];
  /**
   * Refunds asked for in the window that have not failed. Takings for the day are
   * paid.card.cents + paid.cash.cents − refunds.cents.
   */
  refunds: {
    count: number;
    cents: number;
    cardCents: number;
    cashCents: number;
    items: (RefundDTO & { sessionId: string; label: string })[];
  };
  /**
   * Refunds nobody can confirm: the app has stopped trying (Square never answered, refused a
   * re-send, or holds a different refund under the same reference) and a manager has to look at
   * the payment in Square. NOT limited to the window: every such refund, whatever day it was asked
   * for, is on every day's summary until it has been dealt with. Oldest first. Each one is still
   * `pending` and still counted as refunded on its bill; `error` says what to do.
   */
  refundsOutstanding: {
    count: number;
    cents: number;
    items: (RefundDTO & { sessionId: string; label: string })[];
  };
  /**
   * `cents` is what was collected (settledCents), so cash matches the drawer. `roundingCents` is
   * cash collected minus the bills it settled (5c rounding; can be negative).
   * A bill closed with nothing to pay (discounted to $0 and marked paid: totalCents 0,
   * settledCents 0) is counted under neither: no money was taken. It is still in `paidItems`,
   * with whichever method staff tapped, so a manager can reverse it.
   */
  paid: { card: { count: number; cents: number }; cash: { count: number; cents: number; roundingCents: number } };
  /** Cash payments settled in the window that aren't in Square yet. `failed` of them need a manager. */
  squareCashOutstanding: { count: number; cents: number; failed: number };
  /** Every session settled in the window (for "Reverse paid", manager only). `totalCents` is the bill. */
  paidItems: (SummarySessionRow & {
    method: SettledMethod;
    via: SettledVia;
    settledAt: string;
    settledByName: string | null;
    settledCents: number;
    squareCash: SquareCashDTO | null;
    /** Same meaning as on SessionDTO. */
    refundedCents: number;
    refundable: { method: SettledMethod; maxCents: number } | null;
    canPrintReceipt: boolean;
  })[];
  unpaid: { count: number; cents: number; items: SummarySessionRow[] };
  outstandingOlder: { count: number; cents: number };
  voids: { count: number; items: (SummarySessionRow & { reason: string; voidedByName: string | null })[] };
  attention: AuditEntryDTO[];
}

export interface SummarySessionRow {
  id: string;
  kind: BillKind;
  /** Table names for a table's bill; "Counter sale" or "Table 3 · share" otherwise (SessionDTO.label). */
  tableNames: string;
  openedAt: string;
  closedAt: string | null;
  billedMinutes: number | null;
  totalCents: number | null;
}

export type MarkPaidOutcome =
  /** `amountCents` is what was collected (cash: rounded to 5c). */
  | { kind: "paid"; method: SettledMethod; via: SettledVia; amountCents: number }
  /** A pending card checkout turned out to have completed — it's paid by card; don't take cash. */
  | { kind: "already_paid_by_card" };

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminRateCardDTO {
  id: string;
  name: string;
  centsPerHour: number;
  daysOfWeek: number[];
  /** "HH:MM" local */
  startLocal: string;
  /** "HH:MM" local; "24:00" allowed */
  endLocal: string;
  priority: number;
  active: boolean;
}

export interface AdminStaffDTO {
  id: string;
  name: string;
  role: StaffRole;
  active: boolean;
}

export interface AdminDeviceDTO {
  id: string;
  label: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface AdminSettingsDTO {
  roundingMinutes: number;
  graceMinutes: number;
  minimumMinutes: number;
  timezone: string;
  /** "HH:MM" local */
  businessDayStart: string;
  terminalDeviceId: string | null;
  /** Send charges to Square as an itemised order (true) or as a single amount (false). */
  itemiseCharges: boolean;
}

export interface AdminProductDTO extends ProductDTO {
  /** false = no longer in the Square catalogue (kept so old bills still resolve). */
  active: boolean;
  sku: string | null;
  /** true when Square tracks stock for this item at our location. */
  tracked: boolean;
}

/** How the app's stock updates to Square are going. */
export interface AdminStockDTO {
  /** ISO; when stock counts were last read from Square. null = never. */
  syncedAt: string | null;
  /** Why the last read of the counts failed, if it did. */
  lastError: string | null;
  /** Paid bills whose items haven't come off Square's stock yet. */
  pending: number;
  /** Stock updates Square refused or that kept failing. A manager can retry them. */
  failed: number;
  /** The most recent reason one failed. */
  lastMoveError: string | null;
}

export interface AdminDiscountDTO extends DiscountDTO {
  /** false = no longer in the Square catalogue, or no longer usable here (kept so old bills still say what it was). */
  active: boolean;
}

export interface AdminCatalogDTO {
  products: AdminProductDTO[];
  /** Every discount read from Square, by name, including ones no longer active. Read-only here. */
  discounts: AdminDiscountDTO[];
  /** ISO; null = never synced. */
  syncedAt: string | null;
  /** true when Square has a variable-price "Table hire" item to report table time against. */
  tableHireLinked: boolean;
  /** Why the last refresh from Square failed, if it did. */
  lastError: string | null;
  /** Set when an item's tax is added on top of its price in Square instead of included in it. */
  taxWarning: string | null;
  stock: AdminStockDTO;
}

export interface AdminStateDTO {
  manager: { id: string; name: string };
  catalog: AdminCatalogDTO;
  /** Cash payments (all time) not yet in Square, and the most recent reason one failed. */
  squareCash: { pending: number; failed: number; lastError: string | null };
  tables: TableDTO[];
  rateCards: AdminRateCardDTO[];
  settings: AdminSettingsDTO;
  staff: AdminStaffDTO[];
  devices: AdminDeviceDTO[];
  /** null when Square isn't configured on the server. */
  squareEnvironment: "sandbox" | "production" | null;
}

export interface PairingCodeDTO {
  codeId: string;
  code: string;
  /** ISO; codes expire 5 minutes after creation */
  pairBy: string | null;
  status: "UNKNOWN" | "UNPAIRED" | "PAIRED" | "EXPIRED";
  deviceId: string | null;
}
