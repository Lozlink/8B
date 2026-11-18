"use client";

import { useRef, useState, type ReactNode } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useToast } from "@/components/toast";
import { Button, Field, Notice, Sheet, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import { appliedWhat, billCan, discountLockedReason, discountWhat } from "@/lib/client/bill-view";
import { useFloor } from "@/lib/client/floor-context";
import {
  DEFAULT_DISCOUNT_NAME,
  DISCOUNT_NAME_MAX,
  checkDiscountValue,
  discountNameOrDefault,
  type DiscountValueCheck,
} from "@/lib/client/money";
import { useAction } from "@/lib/client/use-action";
import { isCheckoutLive } from "@/lib/domain/machine";
import type { DiscountDTO, SessionDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";

interface Props {
  session: SessionDTO;
  /**
   * Table time plus items right now (the live estimate while the table is running), which is what
   * a discount comes off. Null until it is known.
   */
  baseCents: number | null;
  /** Reloads the open sheet's detail. The floor is refetched by the request itself. */
  reload: () => Promise<void>;
  /** The sheet is mid-action (e.g. sending a charge): leave the discount alone meanwhile. */
  busy?: boolean;
}

type Step = { t: "closed" } | { t: "list" } | { t: "other" } | { t: "variable"; discount: DiscountDTO };

/**
 * The discount on a bill: add one from the Square list or type one in (manager PIN), see who put it
 * there, take it off. For the session sheet (running, paused) and the charge sheet (awaiting
 * payment). A bill that has parts can't change its discount until they are merged back.
 */
export function DiscountPanel({ session, baseCents, reload, busy = false }: Props) {
  const toast = useToast();
  const { floor, offline } = useFloor();
  const { run, pending } = useAction();
  const [step, setStep] = useState<Step>({ t: "closed" });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // Set once a dialog's discount went on, so closing the dialog doesn't fall back to the list.
  const applied = useRef(false);

  const current = session.discount;
  if (!billCan(session, "set_discount")) return null;
  // Nothing to take a discount off yet (a counter sale before its first item).
  if (!current && baseCents !== null && baseCents <= 0) return null;

  const cardLive = session.status === "awaiting_payment" && isCheckoutLive(session.checkout?.status);
  const blocked = cardLive
    ? "Cancel the card request before changing the bill."
    : offline
      ? "No connection. Wait for it to come back before changing the bill."
      : discountLockedReason(session);
  const off = !!blocked || busy || pending;
  const discounts = floor?.discounts ?? [];

  const applyFixed = async (d: DiscountDTO) => {
    setListError(null);
    const done = await run(
      async () => {
        await api.setDiscount(session.id, { discountId: d.id });
        await reload();
        return true as const;
      },
      { inline: setListError },
    );
    if (done) {
      toast.show(`${d.name} added`, "success");
      setStep({ t: "closed" });
    }
  };

  const remove = async () => {
    const done = await run(async () => {
      await api.removeDiscount(session.id);
      await reload();
      return true as const;
    });
    if (done) {
      toast.show("Discount taken off", "success");
      setConfirmRemove(false);
    }
  };

  const dialogClosed = () => {
    if (applied.current) {
      applied.current = false;
      setStep({ t: "closed" });
    } else {
      setStep({ t: "list" });
    }
  };

  return (
    <section aria-label="Discount" className="flex flex-col gap-3">
      {blocked ? <p className="text-warn">{blocked}</p> : null}

      {current ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
          <div className="min-w-0">
            <p className="font-semibold">
              {current.name}{" "}
              <span className="font-normal text-muted">
                ({appliedWhat(current)}
                {current.kind === "amount" ? " off" : ""})
              </span>
            </p>
            <p className="text-sm text-muted">Applied by {current.byName}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              disabled={off}
              onClick={() => {
                setListError(null);
                setStep({ t: "list" });
              }}
            >
              Change
            </Button>
            <Button disabled={off} aria-label={`Remove ${current.name} discount`} onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <Button
          className="self-start"
          disabled={off}
          onClick={() => {
            setListError(null);
            setStep({ t: "list" });
          }}
        >
          Discount
        </Button>
      )}

      {step.t === "list" ? (
        <Sheet title="Discount" onClose={() => setStep({ t: "closed" })} raised locked={pending}>
          <div className="flex flex-col gap-3">
            {listError ? <Notice tone="danger">{listError}</Notice> : null}
            {discounts.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {discounts.map((d) => {
                  const variable = d.kind === "variable_percent" || d.kind === "variable_amount";
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        disabled={pending}
                        aria-label={`${d.name}, ${discountWhat(d)}${variable ? ", needs a manager PIN" : ""}`}
                        onClick={() => {
                          if (variable) setStep({ t: "variable", discount: d });
                          else void applyFixed(d);
                        }}
                        className="flex min-h-16 w-full select-none items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 text-left transition-colors active:bg-line disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <span className="min-w-0">
                          <span className="block break-words text-base font-semibold">{d.name}</span>
                          {variable ? <span className="block text-sm text-muted">Manager PIN</span> : null}
                        </span>
                        <span className="shrink-0 text-base tabular-nums text-muted">{discountWhat(d)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <Button size="lg" disabled={pending} onClick={() => setStep({ t: "other" })}>
              Other discount…
            </Button>
            {discounts.length === 0 ? (
              <p className="text-sm text-muted">Discounts set up in Square appear here by themselves.</p>
            ) : null}
          </div>
        </Sheet>
      ) : null}

      {step.t === "variable" ? (
        <VariableDiscountDialog
          key={step.discount.id}
          session={session}
          discount={step.discount}
          baseCents={baseCents}
          onApplied={async () => {
            applied.current = true;
            toast.show(`${step.discount.name} added`, "success");
            await reload();
          }}
          onClose={dialogClosed}
        />
      ) : null}

      {step.t === "other" ? (
        <OtherDiscountDialog
          session={session}
          baseCents={baseCents}
          onApplied={async (name) => {
            applied.current = true;
            toast.show(`${name} added`, "success");
            await reload();
          }}
          onClose={dialogClosed}
        />
      ) : null}

      {confirmRemove && current ? (
        <Sheet title="Take the discount off?" onClose={() => setConfirmRemove(false)} raised locked={pending}>
          <div className="flex flex-col gap-5">
            <p className="text-lg">
              {current.name} <span className="text-muted">({appliedWhat(current)}{current.kind === "amount" ? " off" : ""})</span>
            </p>
            <p className="text-muted">The bill goes back to its full price.</p>
            <div className="grid grid-cols-2 gap-3">
              <Button size="lg" onClick={() => setConfirmRemove(false)} disabled={pending}>
                Keep it
              </Button>
              <Button size="lg" variant="danger" disabled={pending || !!blocked} onClick={() => void remove()}>
                {pending ? "Removing…" : "Take it off"}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Typing a value
// ---------------------------------------------------------------------------

function ValueField({
  kind,
  value,
  onChange,
  check,
  baseCents,
  estimate,
}: {
  kind: "percent" | "amount";
  value: string;
  onChange: (v: string) => void;
  check: DiscountValueCheck;
  baseCents: number | null;
  estimate: boolean;
}) {
  const hint =
    kind === "percent"
      ? "Whole or half percent, up to 100."
      : baseCents !== null
        ? `Up to ${formatCents(baseCents)}${estimate ? " so far" : ""}.`
        : "Dollars and cents.";
  return (
    <div className="flex flex-col gap-1.5">
      <Field label={kind === "percent" ? "Percent off" : "Amount off"}>
        <div className="relative">
          {kind === "amount" ? (
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
              $
            </span>
          ) : (
            <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted">
              %
            </span>
          )}
          <input
            className={`${inputClass} tabular-nums ${kind === "amount" ? "pl-7" : "pr-8"}`}
            value={value}
            maxLength={8}
            inputMode="decimal"
            autoComplete="off"
            placeholder={kind === "percent" ? "10" : "0.00"}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      </Field>
      {check.ok ? (
        <p className="text-sm text-muted">
          {check.takesCents !== null ? (
            <>
              Takes off <span className="tabular-nums">{formatCents(check.takesCents)}</span>
              {estimate ? " so far" : ""}.
            </>
          ) : (
            hint
          )}
        </p>
      ) : check.error ? (
        <p role="alert" className="text-sm text-warn">
          {check.error}
        </p>
      ) : (
        <p className="text-sm text-muted">{hint}</p>
      )}
    </div>
  );
}

function VariableDiscountDialog({
  session,
  discount,
  baseCents,
  onApplied,
  onClose,
}: {
  session: SessionDTO;
  discount: DiscountDTO;
  baseCents: number | null;
  onApplied: () => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const kind = discount.kind === "variable_percent" ? "percent" : "amount";
  const [value, setValue] = useState("");
  const check = checkDiscountValue(kind, value, baseCents);
  const estimate = session.status === "running" || session.status === "paused";
  return (
    <ActionDialog
      title={discount.name}
      description="Type how much to take off. Needs a manager PIN."
      requirePin
      noReason
      submitLabel="Add discount"
      canSubmit={check.ok}
      onClose={onClose}
      onSubmit={async ({ pin }) => {
        if (!check.ok) return;
        await api.setDiscount(session.id, { discountId: discount.id, value: check.value, managerPin: pin });
        await onApplied();
      }}
    >
      <ValueField kind={kind} value={value} onChange={setValue} check={check} baseCents={baseCents} estimate={estimate} />
    </ActionDialog>
  );
}

function OtherDiscountDialog({
  session,
  baseCents,
  onApplied,
  onClose,
}: {
  session: SessionDTO;
  baseCents: number | null;
  onApplied: (name: string) => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const [kind, setKind] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [name, setName] = useState("");
  const check = checkDiscountValue(kind, value, baseCents);
  const estimate = session.status === "running" || session.status === "paused";
  return (
    <ActionDialog
      title="Other discount"
      description="A manager types the discount in. Needs a manager PIN."
      requirePin
      noReason
      submitLabel="Add discount"
      canSubmit={check.ok}
      onClose={onClose}
      onSubmit={async ({ pin }) => {
        if (!check.ok) return;
        const finalName = discountNameOrDefault(name);
        await api.setDiscount(session.id, { custom: { name: finalName, kind, value: check.value }, managerPin: pin });
        await onApplied(finalName);
      }}
    >
      <div className="flex flex-col gap-4">
        <div role="group" aria-label="Kind of discount" className="grid grid-cols-2 gap-2">
          {(["percent", "amount"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => {
                if (k === kind) return;
                setKind(k);
                setValue("");
              }}
              className={`min-h-12 rounded-xl border px-4 text-base font-semibold transition-colors ${
                kind === k ? "border-[#2f9265] bg-felt text-white" : "border-line bg-surface-2 text-chalk active:bg-line"
              }`}
            >
              {k === "percent" ? "Percent" : "Dollar amount"}
            </button>
          ))}
        </div>
        <ValueField kind={kind} value={value} onChange={setValue} check={check} baseCents={baseCents} estimate={estimate} />
        <Field label="Name" hint="Shows on the bill and in Square.">
          <input
            className={inputClass}
            value={name}
            maxLength={DISCOUNT_NAME_MAX}
            autoComplete="off"
            autoCapitalize="sentences"
            placeholder={DEFAULT_DISCOUNT_NAME}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
    </ActionDialog>
  );
}
