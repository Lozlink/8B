"use client";

import { useRef, useState } from "react";
import { PinDots, PinPad } from "@/components/pin-pad";
import { useToast } from "@/components/toast";
import { Button, Field, Notice, Sheet, inputClass } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useFloorOptional } from "@/lib/client/floor-context";
import { attemptAfter, attemptFor, attemptStore, type RefundAttempt } from "@/lib/client/refund-request";
import {
  checkRefundAmount,
  outcomeUnknown,
  refundOutcome,
  saysNothingRefunded,
  settlesRefund,
  whereTheMoneyGoes,
} from "@/lib/client/refund-view";
import { useAction } from "@/lib/client/use-action";
import type { SessionDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";

interface Props {
  sessionId: string;
  /** What to call the bill in the title: "Table 3", "Counter sale". */
  label: string;
  /** From `SessionDTO.refundable`: how the money goes back and the most that can still be refunded. */
  refundable: NonNullable<SessionDTO["refundable"]>;
  onClose: () => void;
  /** The screen behind should look again: a refund was recorded, or we can't tell whether one was. */
  onChanged: () => void | Promise<void>;
}

/**
 * Manager refund: whole or part, a reason, a manager PIN. One request at a time.
 *
 * Every request carries an id that belongs to this refund (bill + amount). If the answer is lost
 * (timeout, dropped connection, server error) the refund may have gone through, so the form gives
 * way to "couldn't confirm". "Try again" there sends the SAME id with the same amount, and the
 * server hands back the refund it already made instead of making a second. Any definite answer
 * spends the id, so the next refund gets a new one.
 */
export function RefundDialog({ sessionId, label, refundable, onClose, onChanged }: Props) {
  const toast = useToast();
  const offline = useFloorOptional()?.offline ?? false;
  const { run, pending } = useAction();
  const [mode, setMode] = useState<"whole" | "part">("whole");
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * An earlier refund on this bill whose answer was lost and never settled (this dialog was closed and
   * reopened, or the page reloaded). Asking for the same amount again reuses its id, so it can't be made twice.
   */
  const [earlier, setEarlier] = useState(() => attemptStore().get(sessionId));
  /** This refund's attempt: its id is sent again on every retry, until some answer settles it. */
  const attempt = useRef<RefundAttempt | null>(earlier);
  /** Trying the same refund again after a lost answer: amount and reason can't change. */
  const [retrying, setRetrying] = useState(false);
  /**
   * Replaces the form when the outcome is not a clean yes or no. `retry`: the answer was lost, and
   * sending the same request again is safe. Otherwise Square hasn't confirmed it yet (it is recorded
   * and will be retried by itself).
   */
  const [after, setAfter] = useState<{ headline: string; body: string; detail: string | null; retry: boolean } | null>(null);

  const { method, maxCents } = refundable;
  const amount = checkRefundAmount({ mode, text, maxCents, method });
  const ready = amount.ok && reason.trim().length >= 3 && pin.length >= 4 && !after && !offline;

  const submit = async () => {
    if (!amount.ok || !ready) return;
    const cents = amount.cents;
    const sending = attemptFor(attempt.current, sessionId, cents);
    attempt.current = sending;
    setError(null);
    const refund = await run(
      async () => (await api.refund(sessionId, pin, reason.trim(), cents, sending.requestId)).refund,
      {
        inline: (m) => setError(m),
        onError: (e) => {
          if (e instanceof ApiError && outcomeUnknown(e.status)) {
            attempt.current = attemptAfter(sending, "unknown");
            attemptStore().set(sessionId, sending);
            setAfter({
              headline: "Couldn't confirm the refund.",
              body: "It may have gone through. It's safe to try again with the same amount: if it already went through, it won't be refunded twice. Or close this and check the bill's Refunds.",
              detail: e.status === 0 ? null : e.message,
              retry: true,
            });
            void onChanged();
            return true;
          }
          if (e instanceof ApiError && settlesRefund(e)) {
            // Square refused it: that is this refund's final answer, so the id is spent.
            attempt.current = attemptAfter(sending, "settled");
            attemptStore().set(sessionId, null);
            setEarlier(null);
          }
          // Anything else (wrong PIN, too many tries, amount checks) turned the call away before anything
          // was done: nothing is learned about this refund, so its id stays.
          return false;
        },
      },
    );
    if (!refund) {
      setPin("");
      if (attempt.current === null) setRetrying(false);
      return;
    }
    attempt.current = attemptAfter(sending, "settled");
    attemptStore().set(sessionId, null);
    setEarlier(null);
    setRetrying(false);
    if (refund.state === "failed") {
      // The server normally throws for a refusal; this is the same answer arriving as data.
      setError(refund.error ?? "Square didn't accept the refund. Nothing was refunded.");
      setPin("");
      void onChanged();
      return;
    }
    if (refund.state === "pending" && refund.error) {
      // Recorded, but Square hasn't answered. A toast is too brief for "sent, not confirmed".
      setAfter({
        headline: "Refund sent. Square hasn't confirmed it yet.",
        body: `${refund.error}${refund.method === "cash" ? " Hand the cash back." : ""}`,
        detail: "It shows under Refunds on the bill as Processing.",
        retry: false,
      });
      await onChanged();
      return;
    }
    const outcome = refundOutcome(refund);
    toast.show(outcome.message, outcome.kind === "success" ? "success" : "info");
    await onChanged();
    onClose();
  };

  const close = () => {
    // Leaving after a lost answer: look at the bill again so the manager sees what happened.
    if (after || attempt.current) void onChanged();
    onClose();
  };

  const tryAgain = () => {
    setAfter(null);
    setRetrying(true);
    setPin("");
    setError(null);
  };

  if (after) {
    return (
      <Sheet title={`Refund ${label}`} onClose={close} raised>
        <div className="flex flex-col gap-5">
          <Notice tone="warn" strong>
            {after.headline}
          </Notice>
          <p className="text-base">{after.body}</p>
          {after.detail ? <p className="text-sm text-muted">{after.detail}</p> : null}
          {after.retry ? (
            <div className="grid grid-cols-2 gap-3">
              <Button size="lg" onClick={close}>
                Close
              </Button>
              <Button size="lg" variant="primary" onClick={tryAgain}>
                Try again
              </Button>
            </div>
          ) : (
            <Button size="lg" variant="primary" onClick={close}>
              Close
            </Button>
          )}
        </div>
      </Sheet>
    );
  }

  const frozen = pending || retrying;
  const partMessage = mode === "part" && !amount.ok ? amount.message : null;
  const wholeMessage = mode === "whole" && !amount.ok ? amount.message : null;

  return (
    <Sheet title={`Refund ${label}`} onClose={close} raised locked={pending}>
      <div className="flex flex-col gap-5">
        <Notice tone="info">{whereTheMoneyGoes(method)}</Notice>
        {earlier && !retrying ? (
          <Notice tone="warn">
            An earlier refund of <span className="font-semibold tabular-nums">{formatCents(earlier.amountCents)}</span> on this bill wasn&apos;t
            confirmed. Check Refunds on the bill first. If you refund that same amount again, it won&apos;t be made twice.
          </Notice>
        ) : null}
        {retrying && amount.ok ? (
          <Notice tone="warn">
            Same refund as before: <span className="font-semibold tabular-nums">{formatCents(amount.cents)}</span>. Enter the PIN to send it
            again. To change the amount, cancel and start a new refund.
          </Notice>
        ) : null}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-muted">How much</p>
          <div role="group" aria-label="How much to refund" className="grid grid-cols-2 gap-3">
            <Button
              size="lg"
              variant={mode === "whole" ? "primary" : "secondary"}
              aria-pressed={mode === "whole"}
              disabled={frozen}
              onClick={() => setMode("whole")}
            >
              <span className="flex flex-col items-center leading-tight">
                <span>Whole amount</span>
                <span className="text-sm font-normal tabular-nums">{formatCents(maxCents)}</span>
              </span>
            </Button>
            <Button
              size="lg"
              variant={mode === "part" ? "primary" : "secondary"}
              aria-pressed={mode === "part"}
              disabled={frozen}
              onClick={() => setMode("part")}
            >
              Part
            </Button>
          </div>
          {mode === "part" ? (
            <Field
              label={`Amount to refund ($), up to ${formatCents(maxCents)}`}
              hint={!partMessage && method === "cash" ? "Cash goes back in 5c steps, like 12.50 or 12.55." : undefined}
            >
              <input
                className={`${inputClass} text-xl tabular-nums`}
                inputMode="decimal"
                autoComplete="off"
                autoFocus={!retrying}
                placeholder="0.00"
                value={text}
                disabled={frozen}
                aria-invalid={partMessage !== null}
                onChange={(e) => setText(e.target.value)}
              />
              {partMessage ? <span className="text-sm text-danger-text">{partMessage}</span> : null}
            </Field>
          ) : null}
          {wholeMessage ? <p className="text-sm text-danger-text">{wholeMessage}</p> : null}
        </div>

        <Field label="Reason (required)">
          <textarea
            className={`${inputClass} min-h-24 py-2`}
            value={reason}
            maxLength={300}
            disabled={frozen}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being refunded?"
          />
        </Field>

        <div className="flex flex-col gap-3">
          <p className="text-center text-sm font-semibold text-muted">Manager PIN</p>
          <PinDots value={pin} />
          <PinPad compact value={pin} onChange={setPin} disabled={pending} />
        </div>

        {offline ? <Notice tone="warn">No connection. Wait for it to come back before refunding.</Notice> : null}
        {error ? (
          <Notice tone="danger">
            {saysNothingRefunded(error) ? null : <span className="block font-semibold">Nothing was refunded.</span>}
            <span className="block">{error}</span>
          </Notice>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button size="lg" variant="danger" disabled={!ready || pending} onClick={() => void submit()}>
            {pending ? "Refunding…" : amount.ok ? `Refund ${formatCents(amount.cents)}` : "Refund"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
