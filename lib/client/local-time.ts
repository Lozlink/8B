import { localToUtc, offsetMs } from "@/lib/pricing";

/** ISO instant → "YYYY-MM-DDTHH:mm" wall time in `timeZone` (for <input type="datetime-local">). */
export function isoToLocalInput(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  return new Date(ms + offsetMs(timeZone, ms)).toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:mm" wall time in `timeZone` → ISO UTC instant, or null if unparseable. */
export function localInputToIso(value: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const ms = localToUtc(timeZone, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]) * 60 + Number(m[5]));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
