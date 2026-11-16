import type { PricingRateCard, PricingSettings, RateSnapshot } from "./types";

/** "HH:MM" or "HH:MM:SS" (Postgres `time`, including "24:00:00") → minute of day 0–1440. */
export function parseLocalTime(v: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(v.trim());
  if (!m) throw new Error(`Invalid local time: ${v}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  if (h > 24 || min > 59 || sec !== 0 || (h === 24 && min !== 0)) {
    throw new Error(`Local time must be a whole minute between 00:00 and 24:00: ${v}`);
  }
  return h * 60 + min;
}

/** Minute of day 0–1440 → "HH:MM". */
export function formatLocalTime(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function makeSnapshot(
  rateCards: readonly PricingRateCard[],
  settings: PricingSettings,
  pricedAt: Date,
): RateSnapshot {
  return {
    version: 1,
    pricedAt: pricedAt.toISOString(),
    settings: { ...settings },
    rateCards: rateCards.map((c) => ({ ...c, daysOfWeek: [...c.daysOfWeek] })),
  };
}

const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });

export function formatCents(cents: number): string {
  return aud.format(cents / 100);
}

/** 4_830_000 ms → "1h 20m"; under an hour → "35m". */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
