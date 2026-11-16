import { price, isPricingError } from "@/lib/pricing";
import type { PriceResult } from "@/lib/pricing";
import type { PricingConfigDTO, SessionDTO } from "@/lib/domain/types";
import { isCheckoutLive } from "@/lib/domain/machine";

/** Running estimate (client-side). Null if the pricing engine rejects the input. */
export function estimate(session: SessionDTO, pricing: PricingConfigDTO, nowMs: number): PriceResult | null {
  if (nowMs === 0) return null;
  try {
    return price({
      intervals: session.intervals.map((i) => ({ startedAt: i.startedAt, endedAt: i.endedAt })),
      rateCards: pricing.rateCards,
      settings: pricing.settings,
      now: nowMs,
    });
  } catch (e) {
    if (isPricingError(e)) return null;
    throw e;
  }
}

export type CheckoutTone = "info" | "warn" | "muted";

/** Sub-state line for an awaiting_payment session. */
export function checkoutLabel(session: SessionDTO): { label: string; tone: CheckoutTone } {
  const status = session.checkout?.status;
  if (!status) return { label: "Not charged yet", tone: "muted" };
  if (status === "CANCEL_REQUESTED") return { label: "Cancelling on Terminal…", tone: "warn" };
  if (status === "CANCELED") return { label: "Card not completed", tone: "warn" };
  // A COMPLETED checkout on a bill that is still awaiting payment only happens after a manager reversed it.
  if (status === "COMPLETED") return { label: "Card payment was reversed — take payment again", tone: "warn" };
  if (isCheckoutLive(status)) return { label: "Sent to Terminal", tone: "info" };
  return { label: "Not charged yet", tone: "muted" };
}

/** "Table 2 → Table 5" in order of use, without repeats of adjacent names. */
export function sessionTableNames(session: SessionDTO): string {
  const names: string[] = [];
  for (const i of session.intervals) {
    if (names[names.length - 1] !== i.tableName) names.push(i.tableName);
  }
  return names.join(" → ");
}

export function sessionSpan(session: SessionDTO): { start: string | null; end: string | null } {
  const first = session.intervals[0];
  const last = session.intervals[session.intervals.length - 1];
  return { start: first?.startedAt ?? null, end: last?.endedAt ?? null };
}
