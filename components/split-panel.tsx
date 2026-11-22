"use client";

import { useState } from "react";
import { DetailsDialog } from "@/components/bill-details";
import { useToast } from "@/components/toast";
import { Button, Field, Notice, Sheet, inputClass } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { detailsOf, type BillDetails } from "@/lib/client/bill-details";
import { billCan } from "@/lib/client/bill-view";
import { errorMessage, isBillChanged } from "@/lib/client/errors";
import { parseCents } from "@/lib/client/money";
import { canOfferSplit, evenSplit, partIsOpen, partStatus, takeOut, WAYS, type NextBill, type PartTone } from "@/lib/client/split-view";
import { useAction } from "@/lib/client/use-action";
import type { PartDTO, SessionDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";

const TONE_CLASS: Record<PartTone, string> = {
  ok: "text-[#8fd8ae]",
  warn: "text-warn",
  info: "text-info",
  muted: "text-muted",
};

// ---------------------------------------------------------------------------
// Splitting a bill
// ---------------------------------------------------------------------------

interface SplitButtonProps {
  session: SessionDTO;
  /** Something else is going on (a request, a cash handoff, stale figures): don't open the split. */
  disabled: boolean;
  /** The bill was split: reload the sheet. (The floor is refreshed by the request itself.) */
  onSplit: () => Promise<void>;
  /** The bill's amount moved since the sheet showed it, so nothing was split. Gets the server's message. */
  onBillChanged: (message: string) => void;
}

/** "Split bill" on the charge sheet's choose step. Nothing when this bill can't be split. */
export function SplitButton({ session, disabled, onSplit, onBillChanged }: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  if (!canOfferSplit(session)) return null;
  return (
    <>
      <Button size="lg" disabled={disabled} onClick={() => setOpen(true)}>
        Split bill
      </Button>
      {open ? (
        <SplitSheet session={session} onClose={() => setOpen(false)} onSplit={onSplit} onBillChanged={onBillChanged} />
      ) : null}
    </>
  );
}

type Mode = "even" | "amount";

function SplitSheet({
  session,
  onClose,
  onSplit,
  onBillChanged,
}: {
  session: SessionDTO;
  onClose: () => void;
  onSplit: () => Promise<void>;
  onBillChanged: (message: string) => void;
}) {
  const toast = useToast();
  const { run, pending } = useAction();
  const total = session.totalCents ?? 0;
  const [mode, setMode] = useState<Mode>("even");
  const [ways, setWays] = useState(2);
  const [amountText, setAmountText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const even = evenSplit(total, ways);
  const amountCents = parseCents(amountText);
  const out = amountCents === null ? null : takeOut(total, amountCents);
  const amountProblem =
    amountText.trim() === ""
      ? null
      : amountCents === null
        ? "Type the amount in dollars, like 20.00."
        : amountCents <= 0
          ? "The amount has to be more than nothing."
          : amountCents >= total
            ? `It has to be less than the bill (${formatCents(total)}).`
            : null;

  // The total on screen goes with the request, so a bill that changed meanwhile is refused.
  const body =
    mode === "even"
      ? even
        ? { ways, expectedTotalCents: total }
        : null
      : out && amountCents !== null
        ? { amountCents, expectedTotalCents: total }
        : null;

  const submit = async () => {
    if (!body) return;
    setError(null);
    const done = await run(
      async () => {
        const r = await api.split(session.id, body);
        return r;
      },
      {
        inline: setError,
        onError: (e) => {
          // The amount moved under us: nothing was split. Close, reload, and say so on the charge sheet.
          if (isBillChanged(e)) {
            onBillChanged(errorMessage(e));
            onClose();
            void onSplit();
            return true;
          }
          // A timeout: it may still have gone through. Don't leave the sheet open for a second try.
          if (e instanceof ApiError && e.status === 0) {
            toast.show(errorMessage(e), "error");
            onClose();
            void onSplit();
            return true;
          }
          return false;
        },
      },
    );
    if (done) {
      toast.show(done.partIds.length === 1 ? "Part taken out" : `Split ${done.partIds.length + 1} ways`, "success");
      onClose();
      await onSplit();
    }
  };

  return (
    <Sheet title="Split bill" onClose={onClose} raised locked={pending}>
      <div className="flex flex-col gap-5">
        <p className="text-lg">
          This bill is <strong className="tabular-nums">{formatCents(total)}</strong>. Each part is paid on its own, by card or cash.
        </p>

        <div role="group" aria-label="How to split" className="grid grid-cols-2 gap-2">
          {(
            [
              ["even", "Evenly"],
              ["amount", "Take an amount out"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              disabled={pending}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`min-h-12 rounded-xl border px-3 text-base font-semibold transition-colors disabled:opacity-45 ${
                mode === m ? "border-brand bg-brand text-on-brand" : "border-line bg-surface-2 text-chalk active:bg-line"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "even" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold text-muted">How many ways?</p>
            <div role="group" aria-label="Number of ways" className="grid grid-cols-5 gap-2">
              {WAYS.map((n) => {
                const ok = evenSplit(total, n) !== null;
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={ways === n}
                    disabled={pending || !ok}
                    onClick={() => setWays(n)}
                    className={`min-h-14 rounded-xl border text-xl font-semibold tabular-nums transition-colors disabled:opacity-45 ${
                      ways === n ? "border-brand bg-brand text-on-brand" : "border-line bg-surface-2 text-chalk active:bg-line"
                    }`}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
            {even ? (
              <div className="rounded-xl border border-line bg-bg px-4 py-3">
                <p className="text-lg font-semibold">
                  {ways - 1} new part{ways - 1 === 1 ? "" : "s"} of <span className="tabular-nums">{formatCents(even.shareCents)}</span>
                </p>
                <p className="text-base text-muted">
                  This bill keeps <span className="tabular-nums">{formatCents(even.keepsCents)}</span>
                  {even.oddCents > 0 ? `, including the odd ${even.oddCents}c.` : "."}
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label="Amount to take out" hint={`Less than ${formatCents(total)}. It becomes its own bill.`}>
              <div className="relative">
                <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
                  $
                </span>
                <input
                  className={`${inputClass} pl-7 tabular-nums`}
                  value={amountText}
                  maxLength={10}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  disabled={pending}
                  onChange={(e) => {
                    setAmountText(e.target.value);
                    setError(null);
                  }}
                />
              </div>
            </Field>
            {amountProblem ? (
              <p role="alert" className="text-sm text-warn">
                {amountProblem}
              </p>
            ) : null}
            {out && amountCents !== null ? (
              <div className="rounded-xl border border-line bg-bg px-4 py-3">
                <p className="text-lg font-semibold">
                  New part of <span className="tabular-nums">{formatCents(amountCents)}</span>
                </p>
                <p className="text-base text-muted">
                  This bill keeps <span className="tabular-nums">{formatCents(out.keepsCents)}</span>.
                </p>
              </div>
            ) : null}
          </div>
        )}

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="lg" variant="primary" disabled={!body || pending} onClick={() => void submit()}>
            {pending ? "Splitting…" : mode === "even" ? `Split ${ways} ways` : "Take it out"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// The parts of a split bill
// ---------------------------------------------------------------------------

interface PartsPanelProps {
  session: SessionDTO;
  /** Something else is going on: don't open or merge parts meanwhile. */
  disabled?: boolean;
  /** Opens a part in its own charge sheet. Without it the list only shows where each part stands. */
  onOpen?: (id: string) => void;
  /** A part was merged back: reload the sheet. */
  onChanged?: () => Promise<void>;
}

/** What was split off this bill: each part's amount and where it stands. */
export function PartsPanel({ session, disabled = false, onOpen, onChanged }: PartsPanelProps) {
  const [merging, setMerging] = useState<PartDTO | null>(null);
  if (session.parts.length === 0) return null;
  return (
    <section aria-label="Parts" className="flex flex-col gap-2">
      <h3 className="text-lg font-semibold">Parts</h3>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {session.parts.map((p, i) => {
          const st = partStatus(p);
          const open = !!onOpen && !!onChanged && partIsOpen(p);
          return (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  Part {i + 1} · <span className="tabular-nums">{formatCents(p.amountCents)}</span>
                </p>
                <PartName part={p} number={i + 1} onChanged={onChanged} />
                <p className={`text-sm font-semibold ${TONE_CLASS[st.tone]}`}>{st.label}</p>
              </div>
              {open ? (
                <div className="flex shrink-0 gap-2">
                  <Button variant="primary" disabled={disabled} aria-label={`Charge part ${i + 1}, ${formatCents(p.amountCents)}`} onClick={() => onOpen?.(p.id)}>
                    Charge
                  </Button>
                  {session.status === "awaiting_payment" ? (
                    <Button disabled={disabled} aria-label={`Merge part ${i + 1} back, ${formatCents(p.amountCents)}`} onClick={() => setMerging(p)}>
                      Merge back
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {merging && onChanged ? (
        <MergeConfirm
          partId={merging.id}
          amountCents={merging.amountCents}
          backInto="this bill"
          onClose={() => setMerging(null)}
          onMerged={onChanged}
        />
      ) : null}
    </section>
  );
}

/**
 * A share's name. Staff can set it while the share is open. The list only knows the name, and saving
 * sends the note too, so the share is loaded first: its own note is then sent back as it is.
 */
function PartName({ part, number, onChanged }: { part: PartDTO; number: number; onChanged?: () => Promise<void> }) {
  const toast = useToast();
  const { run, pending } = useAction();
  const [editing, setEditing] = useState<BillDetails | null>(null);
  const name = part.customerName;
  if (!billCan({ kind: "part", status: part.status }, "set_details")) {
    return name ? <p className="break-words text-base">{name}</p> : null;
  }
  const open = async () => {
    const d = await run(() => api.session(part.id), { refetch: false });
    if (!d) return;
    if (!billCan(d.session, "set_details")) {
      toast.show("This share has been paid or closed, so its name can't change.", "error");
      return;
    }
    setEditing(detailsOf(d.session));
  };
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => void open()}
        aria-label={name ? `${name}. Change name for part ${number}` : `Add name to part ${number}`}
        className="-mx-2 flex min-h-12 max-w-full items-center rounded-lg px-2 text-left text-base disabled:opacity-45 active:bg-surface-2"
      >
        <span className={`block truncate ${name ? "font-semibold" : "text-muted"}`}>{pending ? "Loading…" : (name ?? "Add name")}</span>
      </button>
      {editing ? (
        <DetailsDialog
          sessionId={part.id}
          subject={`Part ${number}`}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      ) : null}
    </>
  );
}

function MergeConfirm({
  partId,
  amountCents,
  backInto,
  onClose,
  onMerged,
}: {
  partId: string;
  amountCents: number;
  backInto: string;
  onClose: () => void;
  onMerged: () => Promise<void>;
}) {
  const toast = useToast();
  const { run, pending } = useAction();
  const [error, setError] = useState<string | null>(null);
  const merge = async () => {
    setError(null);
    const done = await run(
      async () => {
        await api.mergeBack(partId);
        return true as const;
      },
      { inline: setError },
    );
    if (done) {
      toast.show("Merged back", "success");
      onClose();
      await onMerged();
    }
  };
  return (
    <Sheet title="Merge back?" onClose={onClose} raised locked={pending}>
      <div className="flex flex-col gap-5">
        <p className="text-lg">
          Put <span className="tabular-nums">{formatCents(amountCents)}</span> back onto {backInto}.
        </p>
        <p className="text-muted">The part is closed and won&apos;t be charged separately.</p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={onClose} disabled={pending}>
            Leave it
          </Button>
          <Button size="lg" variant="primary" disabled={pending} onClick={() => void merge()}>
            {pending ? "Merging…" : "Merge back"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// A part's own sheet
// ---------------------------------------------------------------------------

interface PartHeaderProps {
  session: SessionDTO;
  /** The bill this part was split from, when it is still unpaid (from the Unpaid list). */
  parent: SessionDTO | null;
  disabled: boolean;
  onOpen: (id: string) => void;
}

/** On a part's sheet: what it is a share of, a way back to that bill, and a way to fold it back in. */
export function PartHeader({ session, parent, disabled, onOpen }: PartHeaderProps) {
  const [merging, setMerging] = useState(false);
  if (session.kind !== "part") return null;
  const amount = session.totalCents ?? 0;
  const canMerge = session.status === "awaiting_payment" && parent !== null;
  return (
    <section aria-label="Split bill" className="flex flex-col gap-3 rounded-xl border border-line px-4 py-3">
      <p className="text-base">
        One share of a split bill: <strong>{session.label}</strong>
      </p>
      {parent ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={() => onOpen(parent.id)}>
            Open the bill
            {parent.totalCents !== null ? <span className="tabular-nums"> · {formatCents(parent.totalCents)} left</span> : null}
          </Button>
          {canMerge ? (
            <Button disabled={disabled} onClick={() => setMerging(true)}>
              Merge back
            </Button>
          ) : null}
        </div>
      ) : null}
      {merging && parent ? (
        <MergeConfirm
          partId={session.id}
          amountCents={amount}
          backInto="the bill it came from"
          onClose={() => setMerging(false)}
          onMerged={async () => onOpen(parent.id)}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// After paying
// ---------------------------------------------------------------------------

/** On a paid bill that was part of a split: straight on to the next share. */
export function NextBillButton({ next, disabled, onOpen }: { next: NextBill; disabled: boolean; onOpen: (id: string) => void }) {
  return (
    <Button variant="accent" size="lg" disabled={disabled} onClick={() => onOpen(next.id)}>
      {next.kind === "part" ? "Next part" : `Back to ${next.label}`}
      <span className="tabular-nums"> · {formatCents(next.amountCents)}</span>
    </Button>
  );
}
