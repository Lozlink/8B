"use client";

import { useState } from "react";
import { Button, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import { checkCostField, formatMarginBps, formatSignedCents, marginFor } from "@/lib/client/costs";
import { isManagerRequired } from "@/lib/client/errors";
import { centsToField } from "@/lib/client/money";
import { useAction } from "@/lib/client/use-action";
import type { AdminProductDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";

interface CostLineProps {
  product: AdminProductDTO;
  reload: () => Promise<void>;
  onError: (e: unknown) => boolean;
}

/** One item's cost and margin, with a small inline editor. Costs are ex GST and stay in this app. */
export function CostLine({ product: p, reload, onError }: CostLineProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { run, pending } = useAction();

  const open = () => {
    setText(p.costCents === null ? "" : centsToField(p.costCents));
    setError(null);
    setEditing(true);
  };

  const check = checkCostField(text);
  const clearing = check.ok && check.costCents === null;
  const unchanged = check.ok && check.costCents === p.costCents;

  const save = async () => {
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (unchanged) {
      setEditing(false);
      return;
    }
    setError(null);
    const done = await run(() => api.adminSetCosts([{ productId: p.id, costCents: check.costCents }]), {
      refetch: false,
      inline: setError,
      onError: (e) => (isManagerRequired(e) ? onError(e) : false),
    });
    if (!done) return;
    setEditing(false);
    await reload();
  };

  if (editing) {
    return (
      <form
        className="mt-2 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-muted">Cost of one, ex GST</span>
          <span className="flex items-center gap-2">
            <span aria-hidden className="text-lg text-muted">
              $
            </span>
            <input
              type="text"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              aria-label={`Cost of ${p.name}, ex GST`}
              aria-invalid={error !== null}
              placeholder="0.00"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              className={`${inputClass} max-w-40 tabular-nums`}
            />
          </span>
        </label>
        {error ? (
          <p role="alert" className="text-sm font-semibold text-danger-text">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={pending || (clearing && p.costCents === null)}>
            {pending ? "Saving…" : clearing ? "Remove cost" : "Save"}
          </Button>
          <Button disabled={pending} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  const margin = p.costCents === null ? null : marginFor(p.priceCents, p.taxed, p.costCents);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {margin === null || p.costCents === null ? (
        <span className="font-semibold text-warn">No cost yet</span>
      ) : (
        <>
          <span className="tabular-nums">
            Cost <span className="font-semibold">{formatCents(p.costCents)}</span> ex GST
          </span>
          <span className={`tabular-nums ${margin.profitCents < 0 ? "font-semibold text-danger-text" : "text-muted"}`}>
            Margin {formatSignedCents(margin.profitCents, formatCents)} ({formatMarginBps(margin.bps)})
          </span>
        </>
      )}
      {p.active ? (
        <Button onClick={open} aria-label={`${p.costCents === null ? "Add" : "Edit"} cost of ${p.name}`}>
          {p.costCents === null ? "Add cost" : "Edit cost"}
        </Button>
      ) : null}
    </div>
  );
}
