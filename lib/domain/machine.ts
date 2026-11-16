/**
 * Session state machine. Pure: no I/O. The server calls `assertCan` inside the
 * transaction (after locking the session row) before every mutation.
 *
 *   (free) ──start──▶ running ⇄ paused
 *                       │  pause/resume, transfer
 *                       └──stop──▶ awaiting_payment ──mark paid / Square COMPLETED──▶ paid
 *                                         │                                             │
 *            void (manager) ◀─────────────┘                 reverse (manager) ◀────────┘
 */

export const SESSION_STATUSES = ["running", "paused", "awaiting_payment", "paid", "void"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type SessionAction =
  | "pause"
  | "resume"
  | "transfer"
  | "stop"
  | "release_table"
  | "charge_card"
  | "cancel_checkout"
  | "resend_checkout"
  | "sync_checkout"
  | "mark_paid"
  | "void"
  | "reverse_paid"
  | "edit_times"
  | "add_item"
  | "remove_item";

const ALLOWED_FROM: Record<SessionAction, readonly SessionStatus[]> = {
  add_item: ["running", "paused", "awaiting_payment"],
  remove_item: ["running", "paused", "awaiting_payment"],
  pause: ["running"],
  resume: ["paused"],
  transfer: ["running", "paused"],
  stop: ["running", "paused"],
  release_table: ["awaiting_payment"],
  charge_card: ["awaiting_payment"],
  cancel_checkout: ["awaiting_payment"],
  resend_checkout: ["awaiting_payment"],
  sync_checkout: ["awaiting_payment"],
  mark_paid: ["awaiting_payment"],
  void: ["running", "paused", "awaiting_payment"],
  reverse_paid: ["paid"],
  edit_times: ["running", "paused", "awaiting_payment"],
};

/** Actions that need a manager PIN and a written reason. */
export const MANAGER_ACTIONS: ReadonlySet<SessionAction> = new Set(["void", "reverse_paid", "edit_times"]);

export class TransitionError extends Error {
  readonly from: SessionStatus;
  readonly action: SessionAction;
  constructor(from: SessionStatus, action: SessionAction) {
    super(`Can't ${ACTION_LABEL[action]} a session that is ${STATUS_LABEL[from].toLowerCase()}.`);
    this.name = "TransitionError";
    this.from = from;
    this.action = action;
  }
}

export function can(from: SessionStatus, action: SessionAction): boolean {
  return ALLOWED_FROM[action].includes(from);
}

export function assertCan(from: SessionStatus, action: SessionAction): void {
  if (!can(from, action)) throw new TransitionError(from, action);
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "Running",
  paused: "Paused",
  awaiting_payment: "Awaiting payment",
  paid: "Paid",
  void: "Void",
};

const ACTION_LABEL: Record<SessionAction, string> = {
  pause: "pause",
  resume: "resume",
  transfer: "transfer",
  stop: "stop",
  release_table: "move to the unpaid list",
  charge_card: "charge",
  cancel_checkout: "cancel the card checkout for",
  resend_checkout: "resend",
  sync_checkout: "check the card status of",
  mark_paid: "mark paid",
  void: "void",
  reverse_paid: "reverse",
  edit_times: "edit the times of",
  add_item: "add items to",
  remove_item: "remove items from",
};

// ---------------------------------------------------------------------------
// Square Terminal checkout status (mirrors Square's enum).
// ---------------------------------------------------------------------------

export const CHECKOUT_STATUSES = ["PENDING", "IN_PROGRESS", "CANCEL_REQUESTED", "CANCELED", "COMPLETED"] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export function isCheckoutStatus(v: unknown): v is CheckoutStatus {
  return typeof v === "string" && (CHECKOUT_STATUSES as readonly string[]).includes(v);
}

/**
 * A checkout that may still take money. CANCEL_REQUESTED counts as live: until Square
 * confirms CANCELED the buyer could still complete it on the Terminal.
 */
export function isCheckoutLive(s: CheckoutStatus | null | undefined): boolean {
  return s === "PENDING" || s === "IN_PROGRESS" || s === "CANCEL_REQUESTED";
}
