import type { ReactNode } from "react";
import type { DayCloseTotals } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";

/** Secondary text: grey on screen, black on paper. */
export const MUTED = "text-muted print:text-black";

interface RowProps {
  label: string;
  detail?: ReactNode;
  value: string;
  strong?: boolean;
}

function Row({ label, detail, value, strong }: RowProps) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="min-w-0">
        <span className={strong ? "font-semibold" : ""}>{label}</span>
        {detail ? <span className={`block text-sm ${MUTED}`}>{detail}</span> : null}
      </dt>
      <dd className={`shrink-0 tabular-nums ${strong ? "text-xl font-bold" : "text-lg font-semibold"}`}>{value}</dd>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="rounded-2xl border border-line bg-surface px-4 py-2 print:break-inside-avoid print:border-black print:bg-white"
    >
      <h3 className={`pt-2 text-sm font-semibold ${MUTED}`}>{title}</h3>
      <dl className="divide-y divide-line print:divide-black">{children}</dl>
    </section>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A day's figures, grouped the way Square's end-of-day report reads: what was billed, what was
 * paid, what is still owing. Used for the live day and for the frozen figures of a close.
 */
export function DayFigures({ totals: t }: { totals: DayCloseTotals }) {
  const rounding =
    t.cashRoundingCents !== 0
      ? `${t.cashRoundingCents > 0 ? "+" : "−"}${formatCents(Math.abs(t.cashRoundingCents))} rounding`
      : null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3 print:gap-2">
      <Group title="Billed">
        <Row
          label="Billed"
          strong
          value={formatCents(t.billedCents)}
          detail={`${plural(t.sessionCount, "bill")} · ${t.billedMinutes} min`}
        />
        <Row label="Table time" value={formatCents(t.tableCents)} />
        <Row label="Items" value={formatCents(t.itemsCents)} />
        <Row label="Discounts" value={formatCents(t.discountCents)} />
        <Row label="Written off" value={formatCents(t.writtenOffCents)} />
      </Group>
      <Group title="Paid">
        <Row label="Card" value={formatCents(t.cardCents)} detail={plural(t.cardCount, "payment")} />
        <Row
          label="Cash"
          value={formatCents(t.cashCents)}
          detail={[plural(t.cashCount, "payment"), rounding].filter(Boolean).join(" · ")}
        />
        <Row
          label="Refunds"
          value={formatCents(t.refundCents)}
          detail={
            t.refundCount === 0
              ? "None"
              : `${plural(t.refundCount, "refund")} · card ${formatCents(t.refundCardCents)}, cash ${formatCents(t.refundCashCents)}`
          }
        />
        <Row label="Takings" strong value={formatCents(t.takingsCents)} detail="Card plus cash, less refunds" />
      </Group>
      <Group title="Still open">
        <Row label="Unpaid" value={formatCents(t.unpaidCents)} detail={plural(t.unpaidCount, "bill")} />
        <Row
          label="Earlier unpaid"
          value={formatCents(t.olderUnpaidCents)}
          detail={`${plural(t.olderUnpaidCount, "bill")} from earlier days`}
        />
        <Row label="Voids" value={String(t.voidCount)} />
      </Group>
    </div>
  );
}
