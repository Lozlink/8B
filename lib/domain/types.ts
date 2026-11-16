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

export interface SessionDTO {
  id: string;
  status: SessionStatus;
  currentTableId: string | null;
  openedAt: string;
  openedByName: string;
  closedAt: string | null;
  billedMinutes: number | null;
  totalCents: number | null;
  settledMethod: SettledMethod | null;
  settledVia: SettledVia | null;
  settledAt: string | null;
  settledByName: string | null;
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
}

export interface SessionDetailDTO {
  session: SessionDTO;
  checkouts: CheckoutDTO[];
  breakdown: { billedMinutes: number; totalCents: number; gstCents: number; actualMs: number; lines: PriceLine[] } | null;
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
  sessions: { count: number; billedMinutes: number; billedCents: number };
  paid: { card: { count: number; cents: number }; cash: { count: number; cents: number } };
  /** Every session settled in the window (for "Reverse paid", manager only). */
  paidItems: (SummarySessionRow & { method: SettledMethod; via: SettledVia; settledAt: string; settledByName: string | null })[];
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
  | { kind: "paid"; method: SettledMethod; via: SettledVia }
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
}

export interface AdminStateDTO {
  manager: { id: string; name: string };
  tables: TableDTO[];
  rateCards: AdminRateCardDTO[];
  settings: AdminSettingsDTO;
  staff: AdminStaffDTO[];
  devices: AdminDeviceDTO[];
  squareEnvironment: "sandbox" | "production";
}

export interface PairingCodeDTO {
  codeId: string;
  code: string;
  /** ISO; codes expire 5 minutes after creation */
  pairBy: string | null;
  status: "UNKNOWN" | "UNPAIRED" | "PAIRED" | "EXPIRED";
  deviceId: string | null;
}
