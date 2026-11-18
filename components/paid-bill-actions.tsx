"use client";

import { useState } from "react";
import { ReceiptButton } from "@/components/receipt-button";
import { RefundDialog } from "@/components/refund-dialog";
import { RefundsList } from "@/components/refunds-list";
import { SettleRefundButton } from "@/components/settle-refund-dialog";
import { Button, Money } from "@/components/ui";
import { hasPendingRefund, noRefundNote, processingRefundCents } from "@/lib/client/refund-view";
import { usePendingPoll } from "@/lib/client/use-pending-poll";
import type { SessionDetailDTO, SessionDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";

type Refundable = NonNullable<SessionDTO["refundable"]>;

/**
 * "Refund (manager)": the button, and the dialog it opens. Always render this, even when `refundable`
 * is null: the dialog has to outlive the button. A refund that goes through can use up what was
 * refundable, and the dialog still has to finish and be seen.
 */
export function RefundButton({
  sessionId,
  label,
  refundable,
  onChanged,
  size = "lg",
  stale = false,
}: {
  sessionId: string;
  label: string;
  refundable: Refundable | null;
  onChanged: () => void | Promise<void>;
  size?: "md" | "lg";
  /** The screen couldn't refresh, so it may not show a refund that went through. Refunding is off until it does. */
  stale?: boolean;
}) {
  // What the dialog was opened with. Later refreshes of the bill don't change a dialog already open.
  const [opened, setOpened] = useState<Refundable | null>(null);
  return (
    <>
      {refundable ? (
        <Button size={size} disabled={stale} onClick={() => setOpened(refundable)}>
          {size === "lg" ? "Refund (manager)" : "Refund"}
        </Button>
      ) : null}
      {opened ? (
        <RefundDialog
          sessionId={sessionId}
          label={label}
          refundable={opened}
          onChanged={onChanged}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </>
  );
}

/**
 * What a manager does with a paid bill: print a receipt, give money back. Sits near the top of the
 * detail sheet so it isn't buried under the audit trail. Renders nothing when neither applies.
 */
export function PaidBillActions({
  session,
  onChanged,
  stale = false,
}: {
  session: SessionDTO;
  onChanged: () => void | Promise<void>;
  /** The sheet couldn't refresh this bill. Refund stays off until it can, so a refund that already went through isn't made twice. */
  stale?: boolean;
}) {
  if (session.status !== "paid") return null;
  return (
    <div className="grid grid-cols-1 gap-3 empty:hidden sm:grid-cols-2">
      <ReceiptButton session={session} />
      <RefundButton
        sessionId={session.id}
        label={session.label}
        refundable={session.refundable}
        onChanged={onChanged}
        stale={stale}
      />
      {stale && session.refundable ? (
        <p className="text-sm text-warn sm:col-span-2">Couldn&apos;t refresh this bill, so Refund is off until it does.</p>
      ) : null}
    </div>
  );
}

/** The refunds on this bill: how much is back with the customer, each refund, and why there is no Refund button. */
export function RefundsSection({
  detail,
  tz,
  reload,
  stale = false,
}: {
  detail: SessionDetailDTO;
  tz: string;
  /** The bill couldn't refresh, so "I checked Square" is off until it does. */
  stale?: boolean;
  /** Looks at the bill again. Called every few seconds while a refund is still processing (no broadcast tells us it finished). */
  reload: () => Promise<void>;
}) {
  const s = detail.session;
  const refunds = detail.refunds;
  usePendingPoll(hasPendingRefund(refunds), reload, 5000, 6);
  const note = noRefundNote(s);
  if (refunds.length === 0 && !note) return null;

  const processing = processingRefundCents(refunds);
  const inFull = s.settledCents !== null && s.settledCents > 0 && s.refundedCents >= s.settledCents;
  return (
    <section aria-label="Refunds" className="flex flex-col gap-2">
      <h3 className="text-lg font-semibold">Refunds</h3>
      {s.refundedCents > 0 ? (
        <div className="rounded-xl border border-line bg-bg px-4 py-3">
          <p className="flex justify-between gap-3 text-lg font-semibold">
            <span>Refunded{inFull ? " in full" : ""}</span>
            <Money>{formatCents(s.refundedCents)}</Money>
          </p>
          {processing > 0 ? (
            <p className="text-sm text-muted">
              <Money>{formatCents(processing)}</Money> of this is still processing.
            </p>
          ) : null}
          {s.refundable ? (
            <p className="text-sm text-muted">
              Up to <Money>{formatCents(s.refundable.maxCents)}</Money> more can be refunded.
            </p>
          ) : null}
        </div>
      ) : null}
      <RefundsList
        refunds={refunds}
        tz={tz}
        action={(r) => (
          <SettleRefundButton sessionId={s.id} label={s.label} refund={r} tz={tz} onChanged={reload} stale={stale} />
        )}
      />
      {note ? <p className="text-sm text-muted">{note}</p> : null}
    </section>
  );
}
