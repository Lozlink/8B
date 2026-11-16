/** Anything we accept as an instant. Strings must be ISO-8601 with an offset (Postgres timestamptz output is fine). */
export type Instant = Date | string | number;

export interface PricingInterval {
  startedAt: Instant;
  /** null while the interval is still running; priced up to `now`. */
  endedAt: Instant | null;
}

export interface PricingRateCard {
  id: string;
  name: string;
  centsPerHour: number;
  /** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
  daysOfWeek: readonly number[];
  /** Local minute-of-day the window opens, 0–1439. */
  startMinute: number;
  /**
   * Local minute-of-day the window closes, 1–1440 (1440 = midnight at the end of the day).
   * If endMinute <= startMinute the window wraps past midnight; `daysOfWeek` then
   * refers to the day the window opens.
   */
  endMinute: number;
  /** Higher wins when windows overlap. */
  priority: number;
  active: boolean;
}

export interface PricingSettings {
  roundingMinutes: number;
  graceMinutes: number;
  minimumMinutes: number;
  /** IANA zone used for rate-card boundaries, e.g. "Australia/Sydney". */
  timezone: string;
}

export interface PriceInput {
  intervals: readonly PricingInterval[];
  rateCards: readonly PricingRateCard[];
  settings: PricingSettings;
  now: Instant;
}

export interface PriceLine {
  rateCardId: string;
  rateCardName: string;
  centsPerHour: number;
  /** Real elapsed time that fell under this card, before grace/minimum/rounding. */
  actualMs: number;
  /** Share of the billed (rounded) minutes allocated to this card. Lines sum to billedMinutes. */
  minutes: number;
  /** Share of the total. Lines sum to totalCents. */
  cents: number;
}

export interface PriceResult {
  /** Real elapsed time across all intervals (pauses excluded). */
  actualMs: number;
  billedMinutes: number;
  lines: PriceLine[];
  /** GST-inclusive total in cents. */
  totalCents: number;
  /** GST component (total / 11, half-up). Display only. */
  gstCents: number;
}

/** Snapshot persisted on a session at stop so the bill can be re-priced deterministically later. */
export interface RateSnapshot {
  version: 1;
  pricedAt: string;
  settings: PricingSettings;
  rateCards: PricingRateCard[];
}
