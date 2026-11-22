/**
 * The arithmetic behind the End of day screen. Pure: no I/O, no clock, no floats for money.
 * Everything is integer cents; a cash count is always a multiple of 5c.
 */
import { centsToField, parseCents } from "@/lib/client/money";
import { formatCents } from "@/lib/pricing";

export interface Denomination {
  cents: number;
  label: string;
}

/** Australian notes and coins in the drawer, biggest first. */
export const DENOMINATIONS: readonly Denomination[] = [
  { cents: 10_000, label: "$100" },
  { cents: 5_000, label: "$50" },
  { cents: 2_000, label: "$20" },
  { cents: 1_000, label: "$10" },
  { cents: 500, label: "$5" },
  { cents: 200, label: "$2" },
  { cents: 100, label: "$1" },
  { cents: 50, label: "50c" },
  { cents: 20, label: "20c" },
  { cents: 10, label: "10c" },
  { cents: 5, label: "5c" },
];

/** Face value in cents → how many. Missing = none. */
export type Counts = Readonly<Record<number, number>>;

export const NOTE_MAX = 500;
/** More than this of one note or coin is a typo, not a drawer. */
export const QUANTITY_MAX = 999;

/** Keeps a quantity a whole number from 0 to `QUANTITY_MAX`. */
export function clampQuantity(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(QUANTITY_MAX, Math.max(0, Math.trunc(n)));
}

/** What a typed quantity means: digits only, empty = 0. */
export function parseQuantity(text: string): number {
  const digits = text.replace(/\D/g, "").slice(0, 4);
  return digits === "" ? 0 : clampQuantity(Number(digits));
}

/** The count for one denomination after a step of +1 or -1. */
export function stepCount(counts: Counts, cents: number, delta: 1 | -1): Counts {
  return { ...counts, [cents]: clampQuantity((counts[cents] ?? 0) + delta) };
}

/** Value of one row. */
export function rowSubtotalCents(cents: number, quantity: number): number {
  return cents * clampQuantity(quantity);
}

/** The whole drawer counted by note and coin, in cents. Only known denominations count. */
export function sumCounts(counts: Counts): number {
  let total = 0;
  for (const d of DENOMINATIONS) total += rowSubtotalCents(d.cents, counts[d.cents] ?? 0);
  return total;
}

/**
 * The `cashCounts` the server takes: face value in cents (as a string key) → how many, leaving out
 * rows with none. Null when nothing was counted.
 */
export function cashCountsPayload(counts: Counts): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const d of DENOMINATIONS) {
    const q = clampQuantity(counts[d.cents] ?? 0);
    if (q > 0) out[String(d.cents)] = q;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** What should be in the drawer: the float plus the cash that came in, less the cash refunded. */
export function expectedCashCents(floatCents: number, cashMovementCents: number): number {
  return floatCents + cashMovementCents;
}

/** counted − expected. Negative = short. */
export function differenceCents(countedCents: number, expectedCents: number): number {
  return countedCents - expectedCents;
}

/** "Balanced", "$4.50 short", "$2.00 over". */
export function describeDifference(diffCents: number): string {
  if (diffCents === 0) return "Balanced";
  return `${formatCents(Math.abs(diffCents))} ${diffCents < 0 ? "short" : "over"}`;
}

export type CountMode = "notes" | "total";

export interface CloseInput {
  floatText: string;
  mode: CountMode;
  counts: Counts;
  totalText: string;
  note: string;
  /** A table is still running: the day can't be closed yet. */
  tablesRunning: boolean;
}

export type CloseCheck =
  | {
      ok: true;
      floatCents: number;
      countedCashCents: number;
      /** Only when counted by note and coin. */
      cashCounts: Record<string, number> | null;
      /** Trimmed; null when empty. */
      note: string | null;
    }
  /** `reason` is null while there is nothing to tell staff yet. */
  | { ok: false; reason: string | null };

const FIVE_CENTS = "Cash comes in 5c steps. Check the amount.";

/** The float typed in, in cents, or null when it can't be used. */
export function parseFloat5c(text: string): number | null {
  const c = parseCents(text);
  return c === null || c % 5 !== 0 ? null : c;
}

/** The counted total for the current mode, or null while it can't be worked out. */
export function countedCents(input: Pick<CloseInput, "mode" | "counts" | "totalText">): number | null {
  if (input.mode === "notes") return sumCounts(input.counts);
  const c = parseCents(input.totalText);
  return c === null || c % 5 !== 0 ? null : c;
}

/** Whether the form can be sent, and if not, the plain reason. */
export function checkClose(input: CloseInput): CloseCheck {
  if (input.tablesRunning) return { ok: false, reason: "Stop the running tables first." };
  const floatText = input.floatText.trim();
  if (floatText === "") return { ok: false, reason: "Type the float, even if it is $0." };
  const floatCents = parseCents(floatText);
  if (floatCents === null) return { ok: false, reason: "Type the float in dollars, like 200.00." };
  if (floatCents % 5 !== 0) return { ok: false, reason: FIVE_CENTS };

  let counted: number;
  if (input.mode === "notes") {
    counted = sumCounts(input.counts);
    if (counted === 0) return { ok: false, reason: "Count the drawer, or type one total." };
  } else {
    if (input.totalText.trim() === "") return { ok: false, reason: "Type what is in the drawer." };
    const typed = parseCents(input.totalText);
    if (typed === null) return { ok: false, reason: "Type the total in dollars, like 412.50." };
    if (typed % 5 !== 0) return { ok: false, reason: FIVE_CENTS };
    counted = typed;
  }

  const note = input.note.trim();
  if (note.length > NOTE_MAX) return { ok: false, reason: `Keep the note to ${NOTE_MAX} characters.` };

  return {
    ok: true,
    floatCents,
    countedCashCents: counted,
    cashCounts: input.mode === "notes" ? cashCountsPayload(input.counts) : null,
    note: note === "" ? null : note,
  };
}

/**
 * Whether anything has been typed into the close form (so leaving would throw it away). A float
 * left at its suggestion doesn't count; a typed one does.
 */
export function hasTypedInput(input: {
  floatTyped: string | null;
  counts: Counts;
  totalText: string;
  note: string;
}): boolean {
  return (
    input.floatTyped !== null || sumCounts(input.counts) > 0 || input.totalText.trim() !== "" || input.note.trim() !== ""
  );
}

/** Field text for the float the screen starts with. */
export function floatFieldText(suggestedFloatCents: number): string {
  return centsToField(suggestedFloatCents);
}

export interface CountRow {
  cents: number;
  label: string;
  quantity: number;
  subtotalCents: number;
}

/**
 * A saved close's note and coin count as rows, biggest first, leaving out denominations with none.
 * A key this screen doesn't know about is kept, labelled with its value, so nothing is hidden.
 */
export function countRows(cashCounts: Record<string, number> | null): CountRow[] {
  if (!cashCounts) return [];
  const rows: CountRow[] = [];
  for (const [key, quantity] of Object.entries(cashCounts)) {
    const cents = Number(key);
    if (!Number.isInteger(cents) || cents <= 0 || !Number.isInteger(quantity) || quantity <= 0) continue;
    const known = DENOMINATIONS.find((d) => d.cents === cents);
    rows.push({ cents, label: known?.label ?? formatCents(cents), quantity, subtotalCents: cents * quantity });
  }
  return rows.sort((a, b) => b.cents - a.cents);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isBusinessDate(text: string | null | undefined): text is string {
  if (!text) return false;
  const m = DATE_RE.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "2026-11-21" -> "Sat 21 Nov 2026". A calendar date, so no time zone is involved. */
export function formatBusinessDate(date: string): string {
  if (!isBusinessDate(date)) return date;
  return dateFormatter.format(new Date(`${date}T12:00:00Z`)).replace(",", "");
}
