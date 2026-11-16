import { localDate, localToUtc } from "@/lib/pricing";

export interface LocalYMD {
  y: number;
  m: number;
  d: number;
}

/** [from, to) for the business day that starts on `date` at `startMinute` local time. */
export function businessWindow(date: LocalYMD, startMinute: number, tz: string): { from: Date; to: Date } {
  const from = localToUtc(tz, date.y, date.m, date.d, startMinute);
  const next = new Date(Date.UTC(date.y, date.m - 1, date.d + 1));
  const to = localToUtc(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), startMinute);
  return { from: new Date(from), to: new Date(to) };
}

/** The business date `now` falls in: before the cut-over (e.g. 06:00) it's still the previous day. */
export function currentBusinessDate(now: Date, startMinute: number, tz: string): LocalYMD {
  const today = localDate(tz, now.getTime());
  const { from } = businessWindow(today, startMinute, tz);
  if (now.getTime() >= from.getTime()) return today;
  const prev = new Date(Date.UTC(today.y, today.m - 1, today.d - 1));
  return { y: prev.getUTCFullYear(), m: prev.getUTCMonth() + 1, d: prev.getUTCDate() };
}

export function formatYMD(d: LocalYMD): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
}
