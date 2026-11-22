import { MUTED } from "@/components/end-of-day/day-figures";
import { describeDifference, formatBusinessDate } from "@/lib/client/day-close";
import type { DayCloseDTO } from "@/lib/domain/types";
import { formatTime } from "@/lib/format";

/** Recent closes, newest first. Each opens that day. */
export function CloseHistory({
  closes,
  tz,
  viewing,
  onOpen,
}: {
  closes: DayCloseDTO[] | null;
  tz: string;
  /** The business date on screen. */
  viewing: string | null;
  onOpen: (businessDate: string) => void;
}) {
  return (
    <section aria-label="Recent closes" className="flex flex-col gap-2 print:hidden">
      <h2 className="text-xl font-semibold">Recent closes</h2>
      {closes === null ? (
        <p className="text-muted">Loading…</p>
      ) : closes.length === 0 ? (
        <p className="text-muted">No days closed yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {closes.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onOpen(c.businessDate)}
                aria-current={c.businessDate === viewing ? "true" : undefined}
                className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left active:bg-surface-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-semibold">
                    {formatBusinessDate(c.businessDate)}
                    {c.businessDate === viewing ? " (on screen)" : ""}
                  </span>
                  <span className={`truncate text-sm tabular-nums ${MUTED}`}>
                    {c.closedByName} · {formatTime(c.closedAt, tz)}
                    {c.seq > 1 ? " · closed again" : ""}
                  </span>
                </span>
                <span className="shrink-0 text-right font-semibold tabular-nums">{describeDifference(c.varianceCents)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
