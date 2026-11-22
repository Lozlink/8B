/** What a day close keeps of the day's figures, and when a day counts as having moved. Pure: no I/O. */
import type { DayCloseTotals, SummaryDTO } from "./types";

type SummaryFigures = Pick<SummaryDTO, "sessions" | "paid" | "refunds" | "unpaid" | "outstandingOlder" | "voids">;

/** The daily summary's figures, flattened into what a close keeps. */
export function totalsOf(s: SummaryFigures): DayCloseTotals {
  return {
    sessionCount: s.sessions.count,
    billedMinutes: s.sessions.billedMinutes,
    billedCents: s.sessions.billedCents,
    tableCents: s.sessions.tableCents,
    itemsCents: s.sessions.itemsCents,
    discountCents: s.sessions.discountCents,
    writtenOffCents: s.sessions.writtenOffCents,
    cardCount: s.paid.card.count,
    cardCents: s.paid.card.cents,
    cashCount: s.paid.cash.count,
    cashCents: s.paid.cash.cents,
    cashRoundingCents: s.paid.cash.roundingCents,
    refundCount: s.refunds.count,
    refundCents: s.refunds.cents,
    refundCardCents: s.refunds.cardCents,
    refundCashCents: s.refunds.cashCents,
    takingsCents: s.paid.card.cents + s.paid.cash.cents - s.refunds.cents,
    unpaidCount: s.unpaid.count,
    unpaidCents: s.unpaid.cents,
    olderUnpaidCount: s.outstandingOlder.count,
    olderUnpaidCents: s.outstandingOlder.cents,
    voidCount: s.voids.count,
  };
}

/**
 * The figures that mean "the day has moved since it was closed": what was billed and what was
 * taken. Unpaid bills are left out on purpose: yesterday's unpaid bill being paid this morning is
 * today's money, and must not make yesterday look as if it needs closing again.
 */
const MOVES: readonly (keyof DayCloseTotals)[] = [
  "sessionCount",
  "billedCents",
  "discountCents",
  "writtenOffCents",
  "cardCents",
  "cashCents",
  "refundCents",
  "refundCashCents",
  "voidCount",
];

export const hasMoved = (then: DayCloseTotals, now: DayCloseTotals): boolean => MOVES.some((k) => then[k] !== now[k]);
