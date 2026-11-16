/** Formatting helpers usable on server and client. */

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatTime(iso: string | Date, timeZone: string): string {
  let f = timeFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-AU", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    timeFormatters.set(timeZone, f);
  }
  return f.format(typeof iso === "string" ? new Date(iso) : iso);
}

export function formatDateTime(iso: string | Date, timeZone: string): string {
  let f = dateTimeFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-AU", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    dateTimeFormatters.set(timeZone, f);
  }
  return f.format(typeof iso === "string" ? new Date(iso) : iso);
}

/** Elapsed clock for a running timer: 1:05:09 / 12:34. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
