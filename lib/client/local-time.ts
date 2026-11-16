import { localToUtc, offsetMs } from "@/lib/pricing";

/** ISO instant → "YYYY-MM-DDTHH:mm" wall time in `timeZone` (for <input type="datetime-local">). */
export function isoToLocalInput(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  return new Date(ms + offsetMs(timeZone, ms)).toISOString().slice(0, 16);
}

/**
 * "YYYY-MM-DDTHH:mm[:ss]" wall time in `timeZone` → ISO UTC instant, or null if unparseable.
 * A wall time that happens twice (clocks going back) resolves to the occurrence closest to `nearIso`
 * (the field's original instant), or the earlier one if none is given.
 */
export function localInputToIso(value: string, timeZone: string, nearIso?: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const sec = m[6] ? Number(m[6]) : 0;
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec);
  const DAY = 86_400_000;
  const candidates = new Set<number>();
  for (const probe of [wall - DAY, wall, wall + DAY]) {
    const c = wall - offsetMs(timeZone, probe);
    if (c + offsetMs(timeZone, c) === wall) candidates.add(c);
  }
  let ms: number;
  if (candidates.size === 0) {
    // Inside a spring-forward gap: use the zone's own resolution.
    ms = localToUtc(timeZone, y, mo, d, h * 60 + mi) + sec * 1000;
  } else {
    const list = [...candidates].sort((a, b) => a - b);
    const near = nearIso ? Date.parse(nearIso) : NaN;
    ms = Number.isFinite(near) ? list.reduce((best, c) => (Math.abs(c - near) < Math.abs(best - near) ? c : best)) : list[0];
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
