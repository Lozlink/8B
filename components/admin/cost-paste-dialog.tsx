"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Button, Notice, Sheet, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import { COSTS_PER_CALL, chunk, costsToSave, previewPaste, type PasteProblem } from "@/lib/client/costs";
import { isManagerRequired } from "@/lib/client/errors";
import { useAction } from "@/lib/client/use-action";
import type { AdminProductDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";

interface Props {
  products: readonly AdminProductDTO[];
  reload: () => Promise<void>;
  onError: (e: unknown) => boolean;
  onClose: () => void;
}

function Problems({ title, tone, rows }: { title: string; tone: "warn" | "danger"; rows: PasteProblem[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className={`text-base font-semibold ${tone === "danger" ? "text-danger-text" : "text-warn"}`}>
        {title} ({rows.length})
      </h3>
      <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto overscroll-contain rounded-xl border border-line bg-bg p-3">
        {rows.map((r) => (
          <li key={`${r.line}-${r.text}`} className="text-sm">
            <span className="break-words font-semibold">{r.text}</span>
            <span className="block text-muted">
              Line {r.line}. {r.reason}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-line bg-surface-2 px-3 py-1 text-sm font-semibold">{children}</span>;
}

/**
 * Paste two columns from a spreadsheet (item, cost ex GST). Shows what each row would do before
 * anything is saved. Costs are sent in chunks the server accepts.
 */
export function CostPasteDialog({ products, reload, onError, onClose }: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const { run, pending } = useAction();

  const preview = useMemo(() => previewPaste(text, products), [text, products]);
  const toSave = useMemo(() => costsToSave(preview), [preview]);
  const hasText = text.trim() !== "";
  const unchanged = preview.matched.length - toSave.length;
  const problems = preview.unmatched.length + preview.ambiguous.length + preview.badCost.length;

  const save = async () => {
    if (toSave.length === 0) return;
    setError(null);
    let done = 0;
    const ok = await run(
      async () => {
        for (const part of chunk(toSave, COSTS_PER_CALL)) {
          await api.adminSetCosts(part);
          done += part.length;
        }
        return true as const;
      },
      {
        refetch: false,
        inline: (m) => setError(done > 0 ? `${m} ${done} of ${toSave.length} costs were saved before it stopped. Paste again to do the rest.` : m),
        onError: (e) => (isManagerRequired(e) ? onError(e) : false),
      },
    );
    if (done > 0) await reload();
    if (ok) setSaved(done);
  };

  if (saved !== null) {
    return (
      <Sheet title="Paste costs" onClose={onClose} size="lg">
        <div className="flex flex-col gap-4">
          <Notice tone="success" strong>
            {saved} cost{saved === 1 ? "" : "s"} saved.
          </Notice>
          <Button size="lg" variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Paste costs" onClose={onClose} size="lg" locked={pending}>
      <div className="flex flex-col gap-4">
        <p className="text-base text-muted">
          Copy two columns from your sheet and paste them here: the item, then what one costs ex GST. The item can be the Square ID,
          barcode, SKU or name. A row of column titles is fine. Nothing is saved until you tap Save.
        </p>
        <textarea
          aria-label="Pasted costs"
          className={`${inputClass} min-h-40 py-2 font-mono text-sm`}
          placeholder={"Coke 330ml\t1.10\nChips\t1.85"}
          value={text}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={pending}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />

        {hasText ? (
          <>
            <div className="flex flex-wrap gap-2" aria-live="polite">
              <Stat>{toSave.length} to save</Stat>
              {unchanged > 0 ? <Stat>{unchanged} already the same</Stat> : null}
              {preview.unmatched.length > 0 ? <Stat>{preview.unmatched.length} not found</Stat> : null}
              {preview.ambiguous.length > 0 ? <Stat>{preview.ambiguous.length} match several</Stat> : null}
              {preview.badCost.length > 0 ? <Stat>{preview.badCost.length} cost unreadable</Stat> : null}
              {preview.repeated.length > 0 ? <Stat>{preview.repeated.length} listed twice</Stat> : null}
            </div>
            {preview.headerSkipped ? <p className="text-sm text-muted">The first row looked like column titles, so it was left out.</p> : null}

            {preview.matched.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-base font-semibold">Will be saved ({toSave.length})</h3>
                <ul className="flex max-h-72 flex-col divide-y divide-line overflow-y-auto overscroll-contain rounded-xl border border-line bg-bg">
                  {preview.matched.map((m) => (
                    <li key={m.product.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 break-words font-semibold">{m.product.name}</span>
                      <span className={`shrink-0 tabular-nums ${m.changed ? "" : "text-muted"}`}>
                        {m.oldCents === null ? "no cost" : formatCents(m.oldCents)} {"->"} {formatCents(m.newCents)}
                        {m.changed ? "" : " (same)"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <Problems title="Cost not readable" tone="danger" rows={preview.badCost} />
            <Problems title="Matches more than one item" tone="danger" rows={preview.ambiguous} />
            <Problems title="Not found" tone="warn" rows={preview.unmatched} />
            <Problems title="Listed twice" tone="warn" rows={preview.repeated} />

            {problems > 0 ? (
              <p className="text-sm text-muted">
                Rows with a problem are left out. Fix them in the sheet and paste again, or save the rest now.
              </p>
            ) : null}
          </>
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="lg" variant="primary" disabled={toSave.length === 0 || pending} onClick={() => void save()}>
            {pending ? "Saving…" : toSave.length === 0 ? "Save" : `Save ${toSave.length} cost${toSave.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
