"use client";

import { discountRowLabel, minus, PAID_SEPARATELY_LABEL, type BillView } from "@/lib/client/bill-view";

/**
 * The two lines that sit between a bill's items and its total: the discount and the part paid
 * separately. Renders list rows, so it goes inside the same <ul> as the table time and item rows.
 * While the table is still running the discount is an estimate and says so, like the running total.
 */
export function AdjustmentRows({ bill, rowClass }: { bill: BillView; rowClass: string }) {
  if (!bill.discount && bill.splitOffCents <= 0) return null;
  return (
    <>
      {bill.discount ? (
        <li className={rowClass}>
          <span className="min-w-0 break-words">{discountRowLabel(bill.discount)}</span>
          <span className="shrink-0 tabular-nums">
            {minus(bill.discountCents)}
            {bill.estimate ? <span className="text-muted"> est.</span> : null}
          </span>
        </li>
      ) : null}
      {bill.splitOffCents > 0 ? (
        <li className={rowClass}>
          <span>{PAID_SEPARATELY_LABEL}</span>
          <span className="shrink-0 tabular-nums">{minus(bill.splitOffCents)}</span>
        </li>
      ) : null}
    </>
  );
}
