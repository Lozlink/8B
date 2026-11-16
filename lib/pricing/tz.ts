/**
 * Minimal, dependency-free time-zone helpers built on Intl.
 *
 * Every real-world UTC offset in use today is a multiple of 15 minutes, so offset
 * transitions always land on a UTC quarter-hour. We therefore cache the offset per
 * 15-minute UTC block, which turns the per-minute rate lookup into arithmetic.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const BLOCK_MS = 15 * MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, Map<number, number>>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Throws RangeError for an unknown IANA zone. */
export function assertTimeZone(timeZone: string): void {
  formatterFor(timeZone);
}

function computeOffsetMs(timeZone: string, utcMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
  for (const p of parts) {
    switch (p.type) {
      case "year": y = Number(p.value); break;
      case "month": mo = Number(p.value); break;
      case "day": d = Number(p.value); break;
      case "hour": h = Number(p.value) % 24; break;
      case "minute": mi = Number(p.value); break;
      case "second": s = Number(p.value); break;
      default: break;
    }
  }
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Offset of local wall time from UTC at the given instant, in ms (e.g. +11h → 39_600_000). */
export function offsetMs(timeZone: string, utcMs: number): number {
  let zoneCache = offsetCache.get(timeZone);
  if (!zoneCache) {
    zoneCache = new Map();
    offsetCache.set(timeZone, zoneCache);
  }
  const block = Math.floor(utcMs / BLOCK_MS);
  let off = zoneCache.get(block);
  if (off === undefined) {
    if (zoneCache.size > 50_000) zoneCache.clear();
    off = computeOffsetMs(timeZone, block * BLOCK_MS);
    zoneCache.set(block, off);
  }
  return off;
}

export interface LocalMinute {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  isoDow: number;
  /** 0–1439 */
  minuteOfDay: number;
}

/** Local weekday and minute-of-day for a UTC instant. */
export function localMinute(timeZone: string, utcMs: number): LocalMinute {
  const local = utcMs + offsetMs(timeZone, utcMs);
  const dayIndex = Math.floor(local / DAY_MS);
  const msOfDay = local - dayIndex * DAY_MS;
  // 1970-01-01 was a Thursday (ISO 4).
  const isoDow = ((((dayIndex + 3) % 7) + 7) % 7) + 1;
  return { isoDow, minuteOfDay: Math.floor(msOfDay / MINUTE_MS) };
}

/**
 * Converts a local wall-clock date + minute-of-day to a UTC instant (two-pass offset fix-up).
 * Only used for business-day boundaries (e.g. 06:00), which never fall inside a DST
 * transition in Australia; wall times inside a gap/overlap resolve to one of the
 * plausible instants without further guarantees.
 */
export function localToUtc(timeZone: string, y: number, m: number, d: number, minuteOfDay: number): number {
  const wallAsUtc = Date.UTC(y, m - 1, d) + minuteOfDay * MINUTE_MS;
  const first = wallAsUtc - offsetMs(timeZone, wallAsUtc);
  return wallAsUtc - offsetMs(timeZone, first);
}

/** Local calendar date (y, m, d) for a UTC instant. */
export function localDate(timeZone: string, utcMs: number): { y: number; m: number; d: number } {
  const local = new Date(utcMs + offsetMs(timeZone, utcMs));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}
