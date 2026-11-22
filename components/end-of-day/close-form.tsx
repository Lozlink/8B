"use client";

import { useState } from "react";
import { MUTED } from "@/components/end-of-day/day-figures";
import { Button, Field, inputClass } from "@/components/ui";
import {
  DENOMINATIONS,
  NOTE_MAX,
  checkClose,
  countedCents,
  describeDifference,
  differenceCents,
  expectedCashCents,
  floatFieldText,
  hasTypedInput,
  parseFloat5c,
  parseQuantity,
  rowSubtotalCents,
  stepCount,
  sumCounts,
  type CloseCheck,
  type CountMode,
  type Counts,
} from "@/lib/client/day-close";
import { formatCents } from "@/lib/pricing";

/** What staff have typed so far. Lives above the form so a reload doesn't lose it. */
export function useCloseForm(suggestedFloatCents: number) {
  // null = untouched: follow the suggestion.
  const [floatTyped, setFloatTyped] = useState<string | null>(null);
  const [mode, setMode] = useState<CountMode>("notes");
  const [counts, setCounts] = useState<Counts>({});
  const [totalText, setTotalText] = useState("");
  const [note, setNote] = useState("");

  const floatText = floatTyped ?? floatFieldText(suggestedFloatCents);

  return {
    dirty: hasTypedInput({ floatTyped, counts, totalText, note }),
    floatText,
    mode,
    counts,
    totalText,
    note,
    setFloatText: setFloatTyped,
    setMode,
    setCounts,
    setTotalText,
    setNote,
    reset: () => {
      setFloatTyped(null);
      setMode("notes");
      setCounts({});
      setTotalText("");
      setNote("");
    },
  };
}

export type CloseFormState = ReturnType<typeof useCloseForm>;

export function CashCountForm({
  form,
  cashMovementCents,
  tablesRunning,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  form: CloseFormState;
  cashMovementCents: number;
  tablesRunning: boolean;
  submitLabel: string;
  pending: boolean;
  /** Called with the checked values. */
  onSubmit: (check: Extract<CloseCheck, { ok: true }>) => void;
  onCancel?: () => void;
}) {
  const { floatText, mode, counts, totalText, note } = form;
  const check = checkClose({ floatText, mode, counts, totalText, note, tablesRunning });

  const floatCents = parseFloat5c(floatText);
  const expected = floatCents === null ? null : expectedCashCents(floatCents, cashMovementCents);
  // Counting by note and coin: nothing counted yet reads as "not counted", not "$0.00".
  const counted = mode === "notes" ? (sumCounts(counts) > 0 ? sumCounts(counts) : null) : countedCents({ mode, counts, totalText });
  const diff = expected !== null && counted !== null ? differenceCents(counted, expected) : null;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div className="flex flex-col gap-5">
        <Field label="Float (cash in the drawer before the first sale)">
          <input
            className={`${inputClass} tabular-nums`}
            inputMode="decimal"
            autoComplete="off"
            value={floatText}
            onChange={(e) => form.setFloatText(e.target.value)}
            placeholder="200.00"
          />
        </Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold text-muted">How do you want to enter the cash?</legend>
          <div className="grid grid-cols-2 gap-2">
            <ModeButton active={mode === "notes"} onClick={() => form.setMode("notes")}>
              Count notes and coins
            </ModeButton>
            <ModeButton active={mode === "total"} onClick={() => form.setMode("total")}>
              Type one total
            </ModeButton>
          </div>

          {mode === "notes" ? (
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {DENOMINATIONS.map((d) => {
                const q = counts[d.cents] ?? 0;
                return (
                  <li key={d.cents} className="flex items-center gap-2 px-3 py-1.5 sm:gap-3">
                    <span className="w-12 shrink-0 text-lg font-semibold">{d.label}</span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        aria-label={`One fewer ${d.label}`}
                        className="w-12 px-0 text-2xl"
                        disabled={q <= 0}
                        onClick={() => form.setCounts(stepCount(counts, d.cents, -1))}
                      >
                        −
                      </Button>
                      <input
                        aria-label={`How many ${d.label}`}
                        className="min-h-12 w-16 rounded-xl border border-line bg-bg px-1 text-center text-lg tabular-nums placeholder:text-[#77716a]"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        autoComplete="off"
                        placeholder="0"
                        value={q === 0 ? "" : String(q)}
                        onChange={(e) => form.setCounts({ ...counts, [d.cents]: parseQuantity(e.target.value) })}
                      />
                      <Button
                        aria-label={`One more ${d.label}`}
                        className="w-12 px-0 text-2xl"
                        onClick={() => form.setCounts(stepCount(counts, d.cents, 1))}
                      >
                        +
                      </Button>
                    </div>
                    <span className="min-w-0 flex-1 text-right text-lg tabular-nums">
                      {formatCents(rowSubtotalCents(d.cents, q))}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Field label="Total in the drawer, float included" hint="Cash is counted in 5c steps.">
              <input
                className={`${inputClass} tabular-nums`}
                inputMode="decimal"
                autoComplete="off"
                value={totalText}
                onChange={(e) => form.setTotalText(e.target.value)}
                placeholder="0.00"
              />
            </Field>
          )}
        </fieldset>

        <Field label="Note (optional)" hint={`${note.length} of ${NOTE_MAX}`}>
          <textarea
            className={`${inputClass} min-h-24 py-2`}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => form.setNote(e.target.value)}
            placeholder="Anything the owner should know about the drawer or the day"
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3 lg:sticky lg:top-4">
        <section aria-label="Cash check" className="rounded-2xl border border-line bg-surface px-4 py-2">
          <dl className="divide-y divide-line">
            <Line label="Expected in drawer" value={expected === null ? "—" : formatCents(expected)} />
            <Line label="Counted" value={counted === null ? "—" : formatCents(counted)} />
            <div className="py-2" aria-live="polite">
              <dt className="text-sm text-muted">Difference</dt>
              <dd className="text-2xl font-bold tabular-nums">
                {diff === null ? <span className="text-lg font-semibold text-muted">Not counted yet</span> : describeDifference(diff)}
              </dd>
            </div>
          </dl>
          <p className="pb-2 text-sm text-muted">Expected is the float plus the cash taken, less cash refunded.</p>
        </section>

        {!check.ok && check.reason ? <p className={`text-sm ${MUTED}`}>{check.reason}</p> : null}
        <Button
          size="lg"
          variant="primary"
          full
          disabled={!check.ok || pending}
          onClick={() => {
            if (check.ok) onSubmit(check);
          }}
        >
          {pending ? "Working…" : submitLabel}
        </Button>
        {onCancel ? (
          <Button size="lg" full onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <Button
      variant={active ? "primary" : "secondary"}
      aria-pressed={active}
      onClick={onClick}
      className="h-full py-2 leading-tight"
    >
      {active ? `✓ ${children}` : children}
    </Button>
  );
}
