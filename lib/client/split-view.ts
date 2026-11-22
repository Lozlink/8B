/** What staff see when a bill is split into parts. Pure: no I/O. */
import { isCheckoutLive } from "@/lib/domain/machine";
import type { BillKind, PartDTO, SessionDTO } from "@/lib/domain/types";
import { billCan } from "./bill-view";

export const MIN_WAYS = 2;
export const MAX_WAYS = 10;

/** The ways a bill can be split evenly: 2, 3, … 10. */
export const WAYS: readonly number[] = Array.from({ length: MAX_WAYS - MIN_WAYS + 1 }, (_, i) => MIN_WAYS + i);

export interface EvenSplit {
  /** What each new part is. */
  shareCents: number;
  /** What stays on this bill: one share plus the odd cents. */
  keepsCents: number;
  /** How many cents above `shareCents` this bill keeps (0 when it divides evenly). */
  oddCents: number;
}

/**
 * Splitting evenly the way the server does it: every part gets floor(total / ways), and this bill
 * keeps the rest. Null when the split isn't possible (ways outside 2–10, nothing to split, or a
 * share that would come to nothing).
 */
export function evenSplit(totalCents: number, ways: number): EvenSplit | null {
  if (!Number.isInteger(ways) || ways < MIN_WAYS || ways > MAX_WAYS) return null;
  if (!Number.isInteger(totalCents) || totalCents <= 0) return null;
  const shareCents = Math.floor(totalCents / ways);
  if (shareCents < 1) return null;
  const keepsCents = totalCents - shareCents * (ways - 1);
  return { shareCents, keepsCents, oddCents: keepsCents - shareCents };
}

/** Taking `amountCents` out of a bill: what stays on it. Null unless 0 < amount < total. */
export function takeOut(totalCents: number, amountCents: number): { keepsCents: number } | null {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents >= totalCents) return null;
  return { keepsCents: totalCents - amountCents };
}

/**
 * Whether "Split bill" is on offer: awaiting payment, a table or counter bill, something to pay,
 * and no card request live on the Terminal. (A cash handoff in progress is the sheet's to check.)
 */
export function canOfferSplit(s: SessionDTO): boolean {
  return (
    billCan(s, "split") &&
    (s.totalCents ?? 0) > 0 &&
    !(s.checkout && isCheckoutLive(s.checkout.status))
  );
}

export type PartTone = "info" | "warn" | "muted" | "ok";

/** A part's state in words. */
export function partStatus(part: PartDTO): { label: string; tone: PartTone } {
  switch (part.status) {
    case "paid":
      return { label: "Paid", tone: "ok" };
    case "void":
      return { label: "Void", tone: "muted" };
    case "awaiting_payment":
      return part.onTerminal ? { label: "On the Terminal", tone: "info" } : { label: "Unpaid", tone: "warn" };
    default:
      return { label: "Unpaid", tone: "warn" };
  }
}

/** Parts that can still be paid or merged back: unpaid and not on the Terminal. */
export function partIsOpen(part: PartDTO): boolean {
  return part.status === "awaiting_payment" && !part.onTerminal;
}

export interface NextBill {
  id: string;
  kind: BillKind;
  label: string;
  amountCents: number;
}

/**
 * After a bill in a split is paid: the next one to take money for, so staff don't have to go back
 * to the Unpaid list. `root` is the bill the parts were split from (the bill itself when `current`
 * is that bill). Other unpaid parts come first, oldest first, then the original bill if it is still
 * unpaid. Anything with a card request live is skipped. Null when nothing is left.
 */
export function nextUnpaidBill(current: SessionDTO, root: SessionDTO | null): NextBill | null {
  if (!root) return null;
  const part = root.parts.find((p) => p.id !== current.id && partIsOpen(p));
  if (part) {
    // A named share says whose it is, so staff know who to turn to next.
    const label = part.customerName ? `${root.label} · share · ${part.customerName}` : `${root.label} · share`;
    return { id: part.id, kind: "part", label, amountCents: part.amountCents };
  }
  const rootOpen =
    current.id !== root.id &&
    root.status === "awaiting_payment" &&
    !(root.checkout && isCheckoutLive(root.checkout.status)) &&
    root.totalCents !== null &&
    root.totalCents > 0;
  if (rootOpen && root.totalCents !== null) {
    return { id: root.id, kind: root.kind, label: root.label, amountCents: root.totalCents };
  }
  return null;
}

/** true when this bill is part of a split, one way or the other: it has parts, or it is one. */
export function inSplit(s: Pick<SessionDTO, "kind" | "parts" | "splitOffCents">): boolean {
  return s.kind === "part" || s.parts.length > 0 || s.splitOffCents > 0;
}
