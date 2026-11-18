/** Words and checks for the "I checked Square" dialog. Kept apart from the component so they can be tested. */

export type SettleOutcome = "refunded" | "not_refunded";

export interface SettleChoice {
  outcome: SettleOutcome;
  title: string;
  /** One line saying what choosing it does. */
  effect: string;
}

export const SETTLE_WARNING = "Only after you have looked at this payment in Square Dashboard.";

export const SETTLE_CHOICES: readonly SettleChoice[] = [
  { outcome: "refunded", title: "It went through", effect: "Marks the refund as done." },
  { outcome: "not_refunded", title: "It did not", effect: "Cancels the refund here. The amount can be refunded again." },
];

export const SETTLE_REASON_PLACEHOLDER = "What did you see in Square?";

/** The toast once the server has recorded the answer. */
export function settledMessage(outcome: SettleOutcome): string {
  return outcome === "refunded" ? "Refund marked as done." : "Refund cancelled. Nothing was refunded.";
}

export interface SettleReadiness {
  outcome: SettleOutcome | null;
  reason: string;
  pin: string;
  offline: boolean;
}

/** Everything the dialog needs before it may send: an answer picked, a reason, a PIN, a connection. */
export function canSettle({ outcome, reason, pin, offline }: SettleReadiness): boolean {
  return outcome !== null && reason.trim().length >= 3 && pin.length >= 4 && !offline;
}

/** The button beside a refund is shown for rows the server marks, and only while what is on screen is current. */
export function canOfferSettle(refund: { needsCheck: boolean }, stale: boolean): boolean {
  return refund.needsCheck && !stale;
}
