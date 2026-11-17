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
}

/** An item on a bill. Name, price and GST flag were copied when it was added. */
export interface SessionItemDTO {
  id: string;
  productId: string;
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
  status: SessionStatus;
  currentTableId: string | null;
  openedAt: string;
  openedByName: string;
  closedAt: string | null;
  billedMinutes: number | null;
  /** The whole bill once the session is stopped: table time + itemsCents. Null while running. */
  totalCents: number | null;
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
  /** billedCents is the whole bill; tableCents + itemsCents = billedCents. */
  sessions: { count: number; billedMinutes: number; billedCents: number; tableCents: number; itemsCents: number };
  /** Items on the bills counted in `sessions` (closed in the window, not void), biggest first. */
  itemsSold: { productId: string; name: string; quantity: number; cents: number }[];
  /**
   * `cents` is what was collected (settledCents), so cash matches the drawer. `roundingCents` is
   * cash collected minus the bills it settled (5c rounding; can be negative).
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
  })[];
  unpaid: { count: number; cents: number; items: SummarySessionRow[] };
  outstandingOlder: { count: number; cents: number };
  voids: { count: number; items: (SummarySessionRow & { reason: string; voidedByName: string | null })[] };
  attention: AuditEntryDTO[];
}

export interface SummarySessionRow {
  id: string;
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
}

export interface AdminCatalogDTO {
  products: AdminProductDTO[];
  /** ISO; null = never synced. */
  syncedAt: string | null;
  /** true when Square has a variable-price "Table hire" item to report table time against. */
  tableHireLinked: boolean;
  /** Why the last refresh from Square failed, if it did. */
  lastError: string | null;
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
