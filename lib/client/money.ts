/**
 * Parsing of what staff type into money and percent fields. Pure: no I/O.
 * Everything comes out as integer cents or integer basis points, never as a float.
 */
import { discountCentsFor } from "@/lib/domain/bill";
import { formatCents } from "@/lib/pricing";

/** A custom charge is between 1c and $2,000, with a name of 1 to 60 characters. */
export const CUSTOM_PRICE_MIN_CENTS = 1;
export const CUSTOM_PRICE_MAX_CENTS = 200_000;
export const CUSTOM_NAME_MAX = 60;
/** What a typed-in discount is called when staff leave the name alone. */
export const DEFAULT_DISCOUNT_NAME = "Discount";
export const DISCOUNT_NAME_MAX = 60;

/**
 * "12", "12.5", "12.50", "$12.50", ".5" -> cents. Anything else is null, including more than two
 * decimals, commas and minus signs: a comma could be a decimal comma on some keyboards, and
 * guessing wrong would charge ten times too much.
 */
export function parseCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").trim();
  const m = /^(\d{0,7})(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return null;
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (whole === "" && frac === "") return null;
  return (whole === "" ? 0 : Number(whole)) * 100 + Number(`${frac}00`.slice(0, 2));
}

/** 1250 -> "12.50". For filling a field from a value we already hold. */
export function centsToField(cents: number): string {
  const c = Math.max(0, Math.round(cents));
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

/**
 * "10", "12.5", "7.50", "10%" -> basis points (1000, 1250, 750, 1000). Whole or half percents only,
 * above 0 and at most 100. Anything else is null.
 */
export function parsePercentBps(text: string): number | null {
  const t = text.trim().replace(/%$/, "").trim();
  const m = /^(\d{0,3})(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return null;
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (whole === "" && frac === "") return null;
  const bps = (whole === "" ? 0 : Number(whole)) * 100 + Number(`${frac}00`.slice(0, 2));
  if (bps <= 0 || bps > 10_000 || bps % 50 !== 0) return null;
  return bps;
}

/** 1000 -> "10%", 1250 -> "12.5%", 825 -> "8.25%". */
export function formatBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

export type CustomChargeCheck = { ok: true; name: string; amountCents: number } | { ok: false; error: string };

/** Checks a custom charge the way the server will: name 1-60 characters, price 1c to $2,000. */
export function checkCustomCharge(nameText: string, priceText: string): CustomChargeCheck {
  const name = nameText.trim();
  if (name.length === 0) return { ok: false, error: "Type a name for the charge." };
  if (name.length > CUSTOM_NAME_MAX) return { ok: false, error: `Keep the name to ${CUSTOM_NAME_MAX} characters.` };
  const cents = parseCents(priceText);
  if (cents === null) return { ok: false, error: "Type the price in dollars, like 12.50." };
  if (cents < CUSTOM_PRICE_MIN_CENTS) return { ok: false, error: "The price has to be more than nothing." };
  if (cents > CUSTOM_PRICE_MAX_CENTS) return { ok: false, error: `The most is ${formatCents(CUSTOM_PRICE_MAX_CENTS)}.` };
  return { ok: true, name, amountCents: cents };
}

export type DiscountValueCheck =
  | {
      ok: true;
      /** Basis points (percent) or cents (amount): what the API takes. */
      value: number;
      /** What it would take off the bill, when the bill's size is known. */
      takesCents: number | null;
    }
  /** `error` is null while the field is empty, so a blank form isn't scolded. */
  | { ok: false; error: string | null };

/**
 * Checks a typed discount value. A percent is whole or half, up to 100. An amount can't be more
 * than the bill (`baseCents`: table time plus items; null when not known yet).
 */
export function checkDiscountValue(
  kind: "percent" | "amount",
  text: string,
  baseCents: number | null,
): DiscountValueCheck {
  const empty = text.trim() === "";
  if (kind === "percent") {
    const bps = parsePercentBps(text);
    if (bps === null) return { ok: false, error: empty ? null : "Use a whole or half percent, up to 100." };
    return { ok: true, value: bps, takesCents: baseCents === null ? null : discountCentsFor(baseCents, "percent", bps) };
  }
  const cents = parseCents(text);
  if (cents === null) return { ok: false, error: empty ? null : "Type the amount in dollars, like 5.00." };
  if (cents < 1) return { ok: false, error: "The amount has to be more than nothing." };
  if (baseCents !== null && cents > baseCents) {
    return { ok: false, error: `That's more than the bill (${formatCents(baseCents)}).` };
  }
  return { ok: true, value: cents, takesCents: baseCents === null ? null : discountCentsFor(baseCents, "amount", cents) };
}

/** The name for a typed-in discount: what staff typed, or the default when left empty. */
export function discountNameOrDefault(text: string): string {
  const t = text.trim();
  return t === "" ? DEFAULT_DISCOUNT_NAME : t.slice(0, DISCOUNT_NAME_MAX);
}
