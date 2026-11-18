"use client";

import { Money } from "@/components/ui";
import { refundMethodLabel, refundStateLabel, saysNothingRefunded } from "@/lib/client/refund-view";
import type { RefundDTO } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";

/** Who asked and who approved; one name when it is the same person. */
function whoLine(r: Pick<RefundDTO, "byName" | "approvedByName">): string {
  return r.approvedByName && r.approvedByName !== r.byName
    ? `${r.byName}, approved by ${r.approvedByName}`
    : r.byName;
}

function StateText({ refund }: { refund: Pick<RefundDTO, "state"> }) {
  const tone =
    refund.state === "failed" ? "text-danger-text" : refund.state === "pending" ? "text-warn" : "text-muted";
  return <span className={`shrink-0 text-sm font-semibold ${tone}`}>{refundStateLabel(refund.state)}</span>;
}

interface RowProps {
  refund: RefundDTO;
  tz: string;
  /** Which bill it was on (the summary lists refunds from many bills). */
  label?: string;
}

/** The content of one refund: amount, method, state, reason, who, when. No outer box, so callers choose the frame. */
export function RefundDetails({ refund, tz, label }: RowProps) {
  return (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0">
          {label ? <span className="font-semibold">{label} · </span> : null}
          <Money className="font-semibold">{formatCents(refund.amountCents)}</Money>
          <span className="text-muted"> · {refundMethodLabel(refund.method)}</span>
        </span>
        <StateText refund={refund} />
      </span>
      <span className="mt-0.5 block break-words">{refund.reason}</span>
      <span className="block text-sm text-muted">
        {whoLine(refund)} · <span className="tabular-nums">{formatDateTime(refund.createdAt, tz)}</span>
      </span>
      {refund.state === "failed" ? (
        <span className="mt-0.5 block break-words text-sm text-danger-text">
          {refund.error && saysNothingRefunded(refund.error) ? refund.error : `Nothing was refunded.${refund.error ? ` ${refund.error}` : ""}`}
        </span>
      ) : refund.state === "pending" && refund.error ? (
        <span className="mt-0.5 block break-words text-sm text-muted">{refund.error}</span>
      ) : null}
    </>
  );
}

/** The refunds on one bill, oldest first (the order the server sends them in). */
export function RefundsList({ refunds, tz }: { refunds: readonly RefundDTO[]; tz: string }) {
  if (refunds.length === 0) return null;
  return (
    <ul className="divide-y divide-line rounded-xl border border-line">
      {refunds.map((r) => (
        <li key={r.id} className="block px-4 py-3">
          <RefundDetails refund={r} tz={tz} />
        </li>
      ))}
    </ul>
  );
}
