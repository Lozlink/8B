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

/** Table names in the order they were used, without repeats of adjacent names. */
function tableNamesInOrder(session: Pick<SessionDTO, "intervals">): string[] {
  const ordered = session.intervals.slice().sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const names: string[] = [];
  for (const i of ordered) {
    if (names[names.length - 1] !== i.tableName) names.push(i.tableName);
  }
  return names;
}

/** "Table 2 → Table 5" in order of use, without repeats of adjacent names. */
export function sessionTableNames(session: Pick<SessionDTO, "intervals">): string {
  return tableNamesInOrder(session).join(" → ");
}

/**
 * "Moved from Table 3": the table a bill was on just before the one it is on now. Null when it has
 * only been on one table. (3 to 5 to 3 reads "Moved from Table 5".)
 */
export function movedFrom(session: Pick<SessionDTO, "intervals">): string | null {
  const names = tableNamesInOrder(session);
  return names.length > 1 ? `Moved from ${names[names.length - 2]}` : null;
}

export function sessionSpan(session: SessionDTO): { start: string | null; end: string | null } {
  const first = session.intervals[0];
  const last = session.intervals[session.intervals.length - 1];
  return { start: first?.startedAt ?? null, end: last?.endedAt ?? null };
}
