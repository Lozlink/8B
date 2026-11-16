import { PricingError } from "./errors";
import { assertTimeZone, localMinute } from "./tz";
import type {
  Instant,
  PriceInput,
  PriceLine,
  PriceResult,
  PricingRateCard,
  PricingSettings,
} from "./types";

const MINUTE_MS = 60_000;

export function toMs(v: Instant, field = "instant"): number {
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(ms)) {
    throw new PricingError("INVALID_INSTANT", `Invalid ${field}: ${String(v)}`, { field, value: String(v) });
  }
  return ms;
}

function validateSettings(s: PricingSettings): void {
  const intOk = (n: number, min: number) => Number.isInteger(n) && n >= min;
  if (!intOk(s.roundingMinutes, 1) || !intOk(s.graceMinutes, 0) || !intOk(s.minimumMinutes, 0)) {
    throw new PricingError("INVALID_SETTINGS", "rounding must be >= 1; grace and minimum must be >= 0 (whole minutes)", {
      ...s,
    });
  }
  try {
    assertTimeZone(s.timezone);
  } catch {
    throw new PricingError("INVALID_SETTINGS", `Unknown time zone: ${s.timezone}`, { timezone: s.timezone });
  }
}

function validateCard(c: PricingRateCard): void {
  const ok =
    Number.isInteger(c.centsPerHour) &&
    c.centsPerHour >= 0 &&
    Number.isInteger(c.startMinute) &&
    Number.isInteger(c.endMinute) &&
    c.startMinute >= 0 &&
    c.startMinute <= 1439 &&
    c.endMinute >= 1 &&
    c.endMinute <= 1440 &&
    c.startMinute !== c.endMinute &&
    c.daysOfWeek.length > 0 &&
    c.daysOfWeek.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  if (!ok) {
    throw new PricingError("INVALID_RATE_CARD", `Rate card "${c.name}" is invalid`, { rateCardId: c.id });
  }
}

const prevDow = (d: number) => (d === 1 ? 7 : d - 1);

/** Whether a card's window covers the given local weekday/minute. */
export function cardApplies(card: PricingRateCard, isoDow: number, minuteOfDay: number): boolean {
  if (!card.active) return false;
  const { startMinute: s, endMinute: e } = card;
  if (s < e) {
    return minuteOfDay >= s && minuteOfDay < e && card.daysOfWeek.includes(isoDow);
  }
  // Wraps midnight: [s, 1440) on an opening day, then [0, e) on the following day.
  if (minuteOfDay >= s) return card.daysOfWeek.includes(isoDow);
  if (minuteOfDay < e) return card.daysOfWeek.includes(prevDow(isoDow));
  return false;
}

/** Highest priority wins; ties break on id so the choice is deterministic. */
function sortCards(cards: readonly PricingRateCard[]): PricingRateCard[] {
  return cards
    .filter((c) => c.active)
    .slice()
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Round a non-negative rational num/den half-up to an integer. */
function roundHalfUp(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

/**
 * Split `total` across items in proportion to their exact rational shares (num_i / den),
 * flooring each and handing leftover units to the largest remainders (earliest first on ties).
 * The parts always sum to `total`.
 */
function allocate(nums: readonly bigint[], den: bigint, total: bigint): bigint[] {
  const parts = nums.map((n) => n / den);
  const remainders = nums.map((n, i) => ({ i, r: n % den }));
  let leftover = total - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (let k = 0; leftover > 0n && remainders.length > 0; k = (k + 1) % remainders.length) {
    parts[remainders[k].i] += 1n;
    leftover -= 1n;
  }
  return parts;
}

interface Bucket {
  card: PricingRateCard;
  ms: number;
}

/**
 * Prices a session. Pure and deterministic: the same input always yields the same output.
 *
 * 1. Sum real elapsed time of each interval (open intervals run to `now`). Pauses are gaps, never billed.
 * 2. Attribute each elapsed minute to the rate card covering it in local time (DST-aware).
 * 3. Apply grace → minimum → round-up once, to the whole session.
 * 4. Allocate billed minutes across cards in proportion; integer cents, half-up once at the end.
 */
export function price(input: PriceInput): PriceResult {
  const { settings } = input;
  validateSettings(settings);
  input.rateCards.forEach(validateCard);

  const cards = sortCards(input.rateCards);
  const now = toMs(input.now, "now");
  const tz = settings.timezone;

  const buckets = new Map<string, Bucket>();
  const order: string[] = [];

  const cardAt = (utcMs: number): PricingRateCard => {
    const { isoDow, minuteOfDay } = localMinute(tz, utcMs);
    for (const c of cards) if (cardApplies(c, isoDow, minuteOfDay)) return c;
    throw new PricingError("NO_RATE_CARD", `No active rate card covers ${new Date(utcMs).toISOString()}`, {
      at: new Date(utcMs).toISOString(),
    });
  };

  let actualMs = 0;
  for (const iv of input.intervals) {
    const start = toMs(iv.startedAt, "startedAt");
    let end: number;
    if (iv.endedAt === null) {
      end = Math.max(start, now); // an open interval never goes negative (client clock skew)
    } else {
      end = toMs(iv.endedAt, "endedAt");
      if (end < start) {
        throw new PricingError("NEGATIVE_INTERVAL", "Interval ends before it starts", {
          startedAt: new Date(start).toISOString(),
          endedAt: new Date(end).toISOString(),
        });
      }
    }

    // Rate boundaries sit on local minute marks, which are also UTC minute marks for every
    // zone with a whole-minute offset, so a single lookup per UTC minute slice is exact.
    let t = start;
    while (t < end) {
      const sliceEnd = Math.min(end, (Math.floor(t / MINUTE_MS) + 1) * MINUTE_MS);
      const card = cardAt(t);
      let b = buckets.get(card.id);
      if (!b) {
        b = { card, ms: 0 };
        buckets.set(card.id, b);
        order.push(card.id);
      }
      b.ms += sliceEnd - t;
      t = sliceEnd;
    }
    actualMs += end - start;
  }

  const zero: PriceResult = { actualMs, billedMinutes: 0, lines: [], totalCents: 0, gstCents: 0 };
  if (actualMs <= settings.graceMinutes * MINUTE_MS) return zero;

  const billableMs = Math.max(actualMs, settings.minimumMinutes * MINUTE_MS);
  const roundMs = settings.roundingMinutes * MINUTE_MS;
  const billedMinutes = Math.ceil(billableMs / roundMs) * settings.roundingMinutes;

  const ordered = order.map((id) => buckets.get(id) as Bucket);
  const B = BigInt(billedMinutes);
  const T = BigInt(actualMs);

  // cents_i = billedMinutes * (ms_i / actualMs) * (centsPerHour_i / 60), kept exact as num_i / den.
  const den = T * 60n;
  const centNums = ordered.map((b) => B * BigInt(b.ms) * BigInt(b.card.centsPerHour));
  const totalCents = roundHalfUp(centNums.reduce((a, b) => a + b, 0n), den);
  const lineCents = allocate(centNums, den, totalCents);
  const lineMinutes = allocate(
    ordered.map((b) => B * BigInt(b.ms)),
    T,
    B,
  );

  const lines: PriceLine[] = ordered.map((b, i) => ({
    rateCardId: b.card.id,
    rateCardName: b.card.name,
    centsPerHour: b.card.centsPerHour,
    actualMs: b.ms,
    minutes: Number(lineMinutes[i]),
    cents: Number(lineCents[i]),
  }));

  const total = Number(totalCents);
  return {
    actualMs,
    billedMinutes,
    lines,
    totalCents: total,
    gstCents: gstOf(total),
  };
}

/** GST component of a GST-inclusive amount (1/11), rounded half-up. */
export function gstOf(totalCents: number): number {
  return Number(roundHalfUp(BigInt(totalCents), 11n));
}
