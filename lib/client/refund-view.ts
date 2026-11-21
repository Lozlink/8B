import type { RefundDTO, SessionDTO, SettledMethod, SummaryDTO } from "@/lib/domain/types";
import { parseCents } from "@/lib/client/money";
import { formatCents } from "@/lib/pricing";

// ---------------------------------------------------------------------------
// Amount entry
// ---------------------------------------------------------------------------

/** Cash is handed over in 5c steps. */
export function isFiveCentStep(cents: number): boolean {
  return cents % 5 === 0;
}

export type RefundAmountCheck =
  | { ok: true; cents: number }
  /** `message` is null while nothing has been typed yet (don't scold an empty field). */
  | { ok: false; message: string | null };

export interface RefundAmountInput {
  mode: "whole" | "part";
  /** What is in the dollars field (ignored for "whole"). */
  text: string;
  /** The most that can still be refunded (`SessionDTO.refundable.maxCents`). */
  maxCents: number;
  method: SettledMethod;
}

/** The refund amount to send, or the reason it can't be sent yet. The server checks all of this again. */
export function checkRefundAmount({ mode, text, maxCents, method }: RefundAmountInput): RefundAmountCheck {
  let cents: number;
  if (mode === "whole") {
    cents = maxCents;
  } else {
    if (text.trim() === "") return { ok: false, message: null };
    const parsed = parseCents(text);
    if (parsed === null) return { ok: false, message: "Enter dollars and cents, like 12.50." };
    cents = parsed;
  }
  if (cents <= 0) {
    return { ok: false, message: mode === "whole" ? "There is nothing left to refund." : "Enter more than $0." };
  }
  if (cents > maxCents) {
    return { ok: false, message: `The most you can refund is ${formatCents(maxCents)}.` };
  }
  if (method === "cash" && !isFiveCentStep(cents)) {
    return { ok: false, message: cashStepMessage(mode, cents, maxCents) };
  }
  return { ok: true, cents };
}

function cashStepMessage(mode: "whole" | "part", cents: number, maxCents: number): string {
  const lower = Math.floor(cents / 5) * 5;
  const upper = lower + 5;
  if (mode === "whole") {
    return lower > 0
      ? `Cash is handed back in 5c steps, so the whole amount won't work. Choose Part and enter ${formatCents(lower)}.`
      : "Cash is handed back in 5c steps.";
  }
  const options: string[] = [];
  if (lower > 0) options.push(formatCents(lower));
  if (upper <= maxCents) options.push(formatCents(upper));
  return options.length > 0 ? `Cash is handed back in 5c steps. Try ${options.join(" or ")}.` : "Cash is handed back in 5c steps.";
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export function whereTheMoneyGoes(method: SettledMethod): string {
  return method === "card"
    ? "Goes back to the customer's card. It can take a few days to show."
    : "Hand the cash back. The app records the refund in Square.";
}

export function refundMethodLabel(method: SettledMethod): string {
  return method === "card" ? "Card" : "Cash";
}

export function refundStateLabel(state: RefundDTO["state"]): string {
  return state === "pending" ? "Processing" : state === "completed" ? "Refunded" : "Failed";
}

/** What to tell staff once the refund route answered (it throws for anything that was refused). */
export function refundOutcome(refund: Pick<RefundDTO, "state" | "method" | "amountCents" | "error">): {
  kind: "success" | "info" | "error";
  message: string;
} {
  const cash = refund.method === "cash";
  if (refund.state === "completed") {
    const done = `Refunded ${formatCents(refund.amountCents)}`;
    return { kind: "success", message: cash ? `${done}. Hand the cash back.` : done };
  }
  if (refund.state === "pending") {
    const sent = "Refund sent. Square is still processing it.";
    return { kind: "info", message: cash ? `${sent} Hand the cash back.` : sent };
  }
  return { kind: "error", message: `Nothing was refunded. ${refund.error ?? "Square didn't accept it."}` };
}

/** The server's refusal usually ends with "Nothing was refunded." already; don't say it twice. */
export function saysNothingRefunded(message: string): boolean {
  return /nothing was refunded/i.test(message);
}

/** True when any refund is still waiting on Square (these change without a floor broadcast). */
export function hasPendingRefund(refunds: readonly Pick<RefundDTO, "state">[]): boolean {
  return refunds.some((r) => r.state === "pending");
}

const ATTENTION_TITLES: Record<string, string> = {
  "payment.conflict": "Paid twice?",
  "session.reverse_paid": "Payment reopened",
  "checkout.cancel_failed": "Card request couldn't be cancelled",
  "square.cash_failed": "Cash payment not in Square",
  "square.stock_failed": "Stock not updated in Square",
  "cash.handoff_unconfirmed": "Cash sale in Square POS not confirmed",
  "cash.handoff_check_skipped": "Cash sale in Square POS not checked",
  "refund.failed": "Refund failed",
  "refund.unconfirmed": "Refund not confirmed",
};

/** Summary "Needs attention" titles; an entry the list doesn't know is shown as it came. */
export function attentionTitle(action: string): string {
  return ATTENTION_TITLES[action] ?? action;
}

/**
 * A failed call: was anything possibly refunded? A timeout, a dropped connection or a server error
 * could have happened after the refund was recorded. Everything else (wrong PIN, Square's refusal,
 * a 409) is a clear "no".
 */
export function outcomeUnknown(status: number): boolean {
  return status === 0 || status >= 500;
}

/** The refund was recorded and Square then refused it (409 `refund_failed`): a final answer, and nothing was refunded. */
export function settlesRefund(e: { status: number; code: string }): boolean {
  return e.status === 409 && e.code === "refund_failed";
}

export const RECEIPT_SENT = "Sent to the Terminal. It prints when the Terminal is free.";

/**
 * "Reverse payment" undoes a payment that never happened (marked paid by mistake). It is not how
 * money goes back to a customer; that is Refund.
 */
export const REOPEN_BUTTON = "Paid by mistake: reopen bill (manager)";
export const REOPEN_TITLE = "Reopen this bill";
export const REOPEN_SUBMIT = "Reopen bill";
export const REOPENED_TOAST = "Bill reopened";

export function reopenBlurb(method: SettledMethod | null): string {
  const common = "Use this only if the bill was marked paid by mistake. It goes back to unpaid. To give a customer money back, use Refund instead.";
  return method === "cash"
    ? `${common} The app takes the cash sale back out of Square. Hand the cash back yourself. Needs a manager PIN.`
    : `${common} Reopening doesn't send any money back. Needs a manager PIN.`;
}

export const HAS_REFUNDS_NOTE = "This bill has refunds, so it can't be reopened.";

/**
 * One quiet line for a paid bill that has no Refund button, saying why and where to go instead.
 * Null when there is nothing to add (it can be refunded, or refunds already tell the story).
 */
export function noRefundNote(
  s: Pick<SessionDTO, "status" | "refundable" | "refundedCents" | "settledMethod" | "settledVia" | "squareCash">,
): string | null {
  if (s.status !== "paid" || s.refundable || s.refundedCents > 0) return null;
  if (s.settledMethod === "card") {
    return s.settledVia === "staff"
      ? "Taken on another reader. Refund it in Square."
      : "This payment can't be refunded from here. Refund it in Square.";
  }
  if (s.settledMethod === "cash" && (s.squareCash?.state === "pending" || s.squareCash?.state === "failed")) {
    return "This cash sale isn't in Square yet. It can be refunded once it is.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** What came in on the day, less what went back out. Refunds that failed are not in `refunds.cents`. */
export function takingsAfterRefunds(paid: SummaryDTO["paid"], refunds: Pick<SummaryDTO["refunds"], "cents">): number {
  return paid.card.cents + paid.cash.cents - refunds.cents;
}

/** Part of the day's refund total that Square hasn't finished yet. */
export function processingRefundCents(items: readonly Pick<RefundDTO, "state" | "amountCents">[]): number {
  return items.reduce((sum, r) => (r.state === "pending" ? sum + r.amountCents : sum), 0);
}
