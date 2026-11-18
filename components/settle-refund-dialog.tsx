"use client";

import { useState } from "react";
import { PinDots, PinPad } from "@/components/pin-pad";
import { useToast } from "@/components/toast";
import { Button, Field, Money, Notice, Sheet, inputClass } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useFloorOptional } from "@/lib/client/floor-context";
import { outcomeUnknown, refundMethodLabel } from "@/lib/client/refund-view";
import {
  SETTLE_CHOICES,
  SETTLE_REASON_PLACEHOLDER,
  SETTLE_WARNING,
  canOfferSettle,
  canSettle,
  settledMessage,
  type SettleOutcome,
} from "@/lib/client/settle-refund";
import { useAction } from "@/lib/client/use-action";
import type { RefundDTO } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";

interface DialogProps {
  sessionId: string;
  /** What to call the bill: "Table 3", "Counter sale". */
  label: string;
  refund: RefundDTO;
  tz: string;
  onClose: () => void;
  /** The screen behind should look again so the row and the notice update. */
  onChanged: () => void | Promise<void>;
}

/** A manager says what Square Dashboard showed for a refund the app could not confirm. */
export function SettleRefundDialog({ sessionId, label, refund, tz, onClose, onChanged }: DialogProps) {
  const toast = useToast();
  const offline = useFloorOptional()?.offline ?? false;
  const { run, pending } = useAction();
  const [outcome, setOutcome] = useState<SettleOutcome | null>(null);
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const ready = canSettle({ outcome, reason, pin, offline });

  const submit = async () => {
    if (!ready || outcome === null) return;
    setError(null);
    const done = await run(async () => (await api.settleRefund(sessionId, pin, reason.trim(), refund.id, outcome)).refund, {
      inline: setError,
      onError: (e) => {
        // The row has probably changed (409), or the answer was lost: look again behind the dialog.
        if (e instanceof ApiError && (e.status === 409 || outcomeUnknown(e.status))) void onChanged();
        return false;
      },
    });
    if (!done) {
      // Wrong PIN or a refusal: stay open, show the message, start the PIN again.
      setPin("");
      return;
    }
    toast.show(settledMessage(outcome), "success");
    await onChanged();
    onClose();
  };

  return (
    <Sheet title={`Check refund: ${label}`} onClose={onClose} raised locked={pending}>
      <div className="flex flex-col gap-5">
        <div className="rounded-xl border border-line bg-bg px-4 py-3">
          <p>
            <span className="font-semibold">{label}</span> · <Money className="font-semibold">{formatCents(refund.amountCents)}</Money>
            <span className="text-muted"> · {refundMethodLabel(refund.method)}</span>
          </p>
          <p className="text-sm text-muted tabular-nums">{formatDateTime(refund.createdAt, tz)}</p>
        </div>

        <Notice tone="warn" strong>
          {SETTLE_WARNING}
        </Notice>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-muted">What did Square show?</p>
          <div role="radiogroup" aria-label="What Square showed" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {SETTLE_CHOICES.map((c) => (
              <Button
                key={c.outcome}
                size="lg"
                variant={outcome === c.outcome ? "primary" : "secondary"}
                role="radio"
                aria-checked={outcome === c.outcome}
                disabled={pending}
                onClick={() => setOutcome(c.outcome)}
                className="h-auto min-h-16 py-3"
              >
                <span className="flex flex-col items-center gap-0.5 text-center leading-tight">
                  <span>{c.title}</span>
                  <span className="text-sm font-normal">{c.effect}</span>
                </span>
              </Button>
            ))}
          </div>
        </div>

        <Field label="Reason (required)">
          <textarea
            className={`${inputClass} min-h-24 py-2`}
            value={reason}
            maxLength={300}
            disabled={pending}
            onChange={(e) => setReason(e.target.value)}
            placeholder={SETTLE_REASON_PLACEHOLDER}
          />
        </Field>

        <div className="flex flex-col gap-3">
          <p className="text-center text-sm font-semibold text-muted">Manager PIN</p>
          <PinDots value={pin} />
          <PinPad compact value={pin} onChange={setPin} disabled={pending} />
        </div>

        {offline ? <Notice tone="warn">No connection. Wait for it to come back.</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="lg" variant="primary" disabled={!ready || pending} onClick={() => void submit()}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * "I checked Square" and the dialog it opens. Renders nothing for a refund that doesn't need a check.
 * While the screen's data is stale the button is off, as Refund is.
 */
export function SettleRefundButton({
  sessionId,
  label,
  refund,
  tz,
  onChanged,
  stale,
}: {
  sessionId: string;
  label: string;
  refund: RefundDTO;
  tz: string;
  onChanged: () => void | Promise<void>;
  /** The screen couldn't refresh, so it may not show an answer already given. */
  stale: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Keep the dialog up once opened even if a reload clears needsCheck under it: it has to finish and be seen.
  if (!open && !refund.needsCheck) return null;
  return (
    <>
      {refund.needsCheck ? (
        <Button disabled={!canOfferSettle(refund, stale)} onClick={() => setOpen(true)}>
          I checked Square
        </Button>
      ) : null}
      {open ? (
        <SettleRefundDialog sessionId={sessionId} label={label} refund={refund} tz={tz} onChanged={onChanged} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
