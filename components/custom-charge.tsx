"use client";

import { useState } from "react";
import { useToast } from "@/components/toast";
import { Button, Field, Notice, Sheet, inputClass } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { errorMessage } from "@/lib/client/errors";
import { CUSTOM_NAME_MAX, checkCustomCharge } from "@/lib/client/money";
import { useAction } from "@/lib/client/use-action";
import { formatCents } from "@/lib/pricing";

interface Props {
  sessionId: string;
  /** The items panel is blocked, busy, or holding after a timeout. */
  disabled: boolean;
  /** The charge is on the bill: reload the sheet. (The floor is refreshed by the request itself.) */
  onAdded: () => Promise<void>;
  /** The request timed out. It may still have gone through: hold the add buttons for a moment. */
  onTimedOut: () => void;
}

/** "Custom charge": a name and a price typed in, put on the bill as one line. */
export function CustomCharge({ sessionId, disabled, onAdded, onTimedOut }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)} className="self-start">
        Custom charge
      </Button>
      {open ? (
        <CustomChargeSheet sessionId={sessionId} onClose={() => setOpen(false)} onAdded={onAdded} onTimedOut={onTimedOut} />
      ) : null}
    </>
  );
}

function CustomChargeSheet({
  sessionId,
  onClose,
  onAdded,
  onTimedOut,
}: {
  sessionId: string;
  onClose: () => void;
  onAdded: () => Promise<void>;
  onTimedOut: () => void;
}) {
  const toast = useToast();
  const { run, pending } = useAction();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const check = checkCustomCharge(name, price);

  const submit = async () => {
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(null);
    const done = await run(
      async () => {
        await api.addCustomItem(sessionId, check.name, check.amountCents);
        return true as const;
      },
      {
        inline: setError,
        onError: (e) => {
          // A timeout: the server may still have added it. Close, hold the buttons, look again.
          if (e instanceof ApiError && e.status === 0) {
            toast.show(errorMessage(e), "error");
            onTimedOut();
            onClose();
            void onAdded();
            return true;
          }
          return false;
        },
      },
    );
    if (done) {
      toast.show(`${check.name} added`, "success");
      onClose();
      await onAdded();
    }
  };

  return (
    <Sheet title="Custom charge" onClose={onClose} raised locked={pending}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="What is it for?">
          <input
            className={inputClass}
            value={name}
            maxLength={CUSTOM_NAME_MAX}
            autoComplete="off"
            autoCapitalize="sentences"
            enterKeyHint="next"
            placeholder="Name"
            disabled={pending}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field label="Price" hint="Dollars and cents, GST included.">
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
              $
            </span>
            <input
              className={`${inputClass} pl-7 tabular-nums`}
              value={price}
              maxLength={10}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              placeholder="0.00"
              disabled={pending}
              onChange={(e) => {
                setPrice(e.target.value);
                setError(null);
              }}
            />
          </div>
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="lg" variant="primary" type="submit" disabled={!check.ok || pending}>
            {pending ? "Adding…" : check.ok ? `Add ${formatCents(check.amountCents)}` : "Add to bill"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
