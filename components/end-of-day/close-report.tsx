import type { ReactNode } from "react";
import { DayFigures, MUTED } from "@/components/end-of-day/day-figures";
import { countRows, describeDifference } from "@/lib/client/day-close";
import type { DayCloseDTO } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";

function CashLine({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className={strong ? "font-semibold" : ""}>{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? "text-xl font-bold" : "text-lg font-semibold"}`}>{value}</dd>
    </div>
  );
}

/** Who closed it, when and where, in one line each. */
export function closeByline(c: DayCloseDTO, tz: string): string {
  return `${formatDateTime(c.closedAt, tz)} by ${c.closedByName}${c.deviceLabel ? ` on ${c.deviceLabel}` : ""}`;
}

/**
 * One close as a report: who, when, the cash against what was expected, the note, and the day's
 * figures as they were at that moment. Never changes. `compact` is for the earlier closes.
 */
export function CloseReport({
  close: c,
  tz,
  title,
  compact,
  actions,
}: {
  close: DayCloseDTO;
  tz: string;
  title: string;
  compact?: boolean;
  actions?: ReactNode;
}) {
  const rows = countRows(c.cashCounts);
  const H = compact ? "h4" : "h2";
  return (
    <article
      aria-label={title}
      className={`flex flex-col gap-4 text-chalk print:gap-3 print:text-black ${
        compact ? "" : "rounded-2xl border border-line bg-surface p-4 print:rounded-none print:border-0 print:bg-white print:p-0"
      }`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <H className="text-xl font-semibold">{title}</H>
          <p className={`tabular-nums ${MUTED}`}>Closed {closeByline(c, tz)}</p>
          {c.seq > 1 ? (
            <p className={MUTED}>
              Closed again (close {c.seq})
              {c.approvedByName ? `, approved by ${c.approvedByName}` : ""}
            </p>
          ) : null}
          {c.reason ? <p className="break-words">Reason: {c.reason}</p> : null}
        </div>
        {actions}
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 print:grid-cols-2">
        <section aria-label="Cash" className="rounded-2xl border border-line bg-bg px-4 py-2 print:border-black print:bg-white">
          <h3 className={`pt-2 text-sm font-semibold ${MUTED}`}>Cash drawer</h3>
          <dl className="divide-y divide-line print:divide-black">
            <CashLine label="Float" value={formatCents(c.floatCents)} />
            <CashLine label="Expected in drawer" value={formatCents(c.expectedCashCents)} />
            <CashLine label="Counted" value={formatCents(c.countedCashCents)} />
            <CashLine label="Difference" strong value={describeDifference(c.varianceCents)} />
          </dl>
        </section>

        {rows.length > 0 ? (
          <section aria-label="Count" className="rounded-2xl border border-line bg-bg px-4 py-2 print:border-black print:bg-white">
            <h3 className={`pt-2 text-sm font-semibold ${MUTED}`}>Counted by note and coin</h3>
            <ul className="divide-y divide-line print:divide-black">
              {rows.map((r) => (
                <li key={r.cents} className="flex items-baseline justify-between gap-3 py-1.5 tabular-nums">
                  <span className="w-14 font-semibold">{r.label}</span>
                  <span className={MUTED}>× {r.quantity}</span>
                  <span className="w-24 text-right">{formatCents(r.subtotalCents)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section aria-label="Count" className="rounded-2xl border border-line bg-bg px-4 py-3 print:border-black print:bg-white">
            <h3 className={`text-sm font-semibold ${MUTED}`}>Count</h3>
            <p className="mt-1">Typed as one total.</p>
          </section>
        )}
      </div>

      {c.note ? (
        <div>
          <h3 className={`text-sm font-semibold ${MUTED}`}>Note</h3>
          <p className="whitespace-pre-wrap break-words">{c.note}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className={`text-sm font-semibold ${MUTED}`}>Figures at the time of closing</h3>
        <DayFigures totals={c.totals} />
      </div>
    </article>
  );
}
