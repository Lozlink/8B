"use client";

import { useState, type ReactNode } from "react";
import { PinDots, PinPad } from "@/components/pin-pad";
import { Button, Field, Notice, Sheet, inputClass } from "@/components/ui";
import { useAction } from "@/lib/client/use-action";

interface ActionDialogProps {
  title: string;
  description?: ReactNode;
  /** Extra fields shown above the reason. */
  children?: ReactNode;
  /** Ask for a manager PIN (void / reverse / edit times). */
  requirePin?: boolean;
  submitLabel: string;
  danger?: boolean;
  /** Extra validity check for the fields in `children`. */
  canSubmit?: boolean;
  /** Skip the reason field (never for mutations; only for PIN-only prompts). */
  noReason?: boolean;
  onSubmit: (input: { pin: string; reason: string }) => Promise<void>;
  onClose: () => void;
  /** Errors the caller wants to handle itself (e.g. manager_required). Return true if handled. */
  onError?: (e: unknown) => boolean;
}

/** Reused confirmation dialog: optional manager PIN pad + required reason. Errors show inline. */
export function ActionDialog({
  title,
  description,
  children,
  requirePin,
  submitLabel,
  danger,
  canSubmit = true,
  noReason,
  onSubmit,
  onClose,
  onError,
}: ActionDialogProps) {
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { run, pending } = useAction();

  const reasonOk = noReason || reason.trim().length >= 3;
  const pinOk = !requirePin || pin.length >= 4;
  const ready = canSubmit && reasonOk && pinOk;

  const submit = async () => {
    if (!ready) return;
    setError(null);
    const done = await run(
      async () => {
        await onSubmit({ pin, reason: reason.trim() });
        return true as const;
      },
      { inline: setError, onError },
    );
    if (done) onClose();
    else setPin("");
  };

  return (
    <Sheet title={title} onClose={onClose} raised locked={pending}>
      <div className="flex flex-col gap-5">
        {description ? <div className="text-base text-muted">{description}</div> : null}
        {children}
        {noReason ? null : (
          <Field label="Reason (required)">
            <textarea
              className={`${inputClass} min-h-24 py-2`}
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What happened and why?"
            />
          </Field>
        )}
        {requirePin ? (
          <div className="flex flex-col gap-3">
            <p className="text-center text-sm font-semibold text-muted">Manager PIN</p>
            <PinDots value={pin} />
            <PinPad compact value={pin} onChange={setPin} disabled={pending} />
          </div>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="lg" variant={danger ? "danger" : "primary"} disabled={!ready || pending} onClick={() => void submit()}>
            {pending ? "Working…" : submitLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
