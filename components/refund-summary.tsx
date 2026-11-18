"use client";

import type { ReactNode } from "react";
import { ReceiptButton } from "@/components/receipt-button";
import { RefundButton } from "@/components/paid-bill-actions";
import { RefundDetails } from "@/components/refunds-list";
import { Button, Money, Notice } from "@/components/ui";
import { hasPendingRefund, processingRefundCents, refundMethodLabel, takingsAfterRefunds } from "@/lib/client/refund-view";
import { usePendingPoll } from "@/lib/client/use-pending-poll";
import type { SummaryDTO } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";

/** A paid row in the summary. */
export type PaidSummaryRow = SummaryDTO["paidItems"][number];

function StatCard({ title, big, sub }: { title: string; big: string; sub: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-sm font-semibold text-muted">{title}</p>
      <p className="mt-1 text-4xl font-bold tabular-nums">{big}</p>
      <p className="mt-1 text-base text-muted">{sub}</p>
    </div>
  );
}

/** Two cards for the stat grid: what went back, and what is left once it has. */
export function RefundStats({ data }: { data: SummaryDTO }) {
  const { refunds, paid } = data;
  const processing = processingRefundCents(refunds.items);
  return (
    <>
      <StatCard
        title="Refunds"
        big={formatCents(refunds.cents)}
        sub={
          refunds.count === 0 ? (
            "None today"
          ) : (
            <>
              {refunds.count} refund{refunds.count === 1 ? "" : "s"} · Card <Money>{formatCents(refunds.cardCents)}</Money> · Cash{" "}
              <Money>{formatCents(refunds.cashCents)}</Money>
            </>
          )
        }
      />
      <StatCard
        title="Takings after refunds"
        big={formatCents(takingsAfterRefunds(paid, refunds))}
        sub={
          <>
            Paid by card + cash, less refunds
            {processing > 0 ? (
              <>
                {" "}
                · <Money>{formatCents(processing)}</Money> of the refunds still processing
              </>
            ) : null}
          </>
        }
      />
    </>
  );
}

/**
 * Above the paid list: a warning when the summary couldn't refresh, the refunds from any day that
 * still need a manager to check Square, and the day's refunds. Tapping one opens its bill.
 */
export function RefundsSummarySection({
  data,
  tz,
  onOpen,
  reload,
  stale,
}: {
  data: SummaryDTO;
  tz: string;
  onOpen: (sessionId: string) => void;
  /** Looks at the summary again, every 10 s while a refund is still processing (nothing broadcasts when it finishes). */
  reload: () => Promise<void>;
  /** The summary couldn't refresh, so it may not show a refund that went through. Refund and Reopen are off. */
  stale: boolean;
}) {
  const { refunds, refundsOutstanding } = data;
  usePendingPoll(hasPendingRefund(refunds.items), reload, 10_000, 6);
  return (
    <>
      {stale ? (
        <Notice tone="warn">Couldn&apos;t refresh, so Refund and Reopen are off until it does. The figures may be out of date.</Notice>
      ) : null}

      {refundsOutstanding.count > 0 ? (
        <section aria-label="Refunds to check in Square" className="flex flex-col gap-2">
          <Notice tone="warn">
            <p className="font-semibold">
              {refundsOutstanding.count} refund{refundsOutstanding.count === 1 ? "" : "s"} (
              <Money>{formatCents(refundsOutstanding.cents)}</Money>) Square never confirmed. Check each one in Square.
            </p>
            <p className="text-sm">These stay here, whatever day it is, until they are sorted out.</p>
            <ul className="mt-2 flex flex-col divide-y divide-line">
              {refundsOutstanding.items.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-2">
                  <span className="min-w-0 flex-1 basis-60">
                    <span className="block">
                      <span className="font-semibold">{r.label}</span> · <Money className="font-semibold">{formatCents(r.amountCents)}</Money>
                      <span className="text-muted"> · {refundMethodLabel(r.method)} · </span>
                      <span className="tabular-nums text-muted">{formatDateTime(r.createdAt, tz)}</span>
                    </span>
                    {r.error ? <span className="mt-0.5 block break-words text-sm">{r.error}</span> : null}
                  </span>
                  <Button onClick={() => onOpen(r.sessionId)}>Open bill</Button>
                </li>
              ))}
            </ul>
          </Notice>
        </section>
      ) : null}

      {refunds.items.length > 0 ? (
        <section aria-label="Refunds" className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold">Refunds ({refunds.count})</h2>
          <p className="text-sm text-muted">Refunds made in this window, whichever day the bill was paid.</p>
          <ul className="flex flex-col gap-2">
            {refunds.items.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(r.sessionId)}
                  className="block min-h-14 w-full rounded-xl border border-line bg-surface px-4 py-3 text-left active:bg-surface-2"
                >
                  <RefundDetails refund={r} tz={tz} label={r.label} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** "Refunded $X" under a paid row's details. Nothing when there are no refunds. */
export function RefundedTag({ row }: { row: PaidSummaryRow }) {
  const cents = row.refundedCents;
  if (cents <= 0) return null;
  return (
    <span className="text-sm font-semibold text-warn">
      Refunded <Money>{formatCents(cents)}</Money>
    </span>
  );
}

/**
 * The buttons beside a paid row: print a receipt, refund, reopen. A bill with refunds can't be
 * reopened (the server refuses), so that button is left off rather than shown and refused.
 */
export function PaidRowActions({
  row,
  onReopen,
  onChanged,
  stale,
}: {
  row: PaidSummaryRow;
  onReopen: () => void;
  onChanged: () => void | Promise<void>;
  /** The summary couldn't refresh: Refund and Reopen are off until it does (see RefundsSummarySection). */
  stale: boolean;
}) {
  const refunded = row.refundedCents > 0;
  return (
    <div className="flex shrink-0 flex-wrap items-stretch gap-2">
      <ReceiptButton session={{ id: row.id, canPrintReceipt: row.canPrintReceipt }} size="md" />
      <RefundButton sessionId={row.id} label={row.tableNames} refundable={row.refundable} onChanged={onChanged} size="md" stale={stale} />
      {refunded ? null : (
        <Button variant="secondary" disabled={stale} onClick={onReopen}>
          Reopen
        </Button>
      )}
    </div>
  );
}
