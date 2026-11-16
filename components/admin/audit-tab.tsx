"use client";

import { useCallback, useState } from "react";
import { Button, Field, Notice, Spinner, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { errorMessage } from "@/lib/client/errors";
import type { AuditEntryDTO } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/format";
import { TabHeader, type TabProps } from "./shared";

function pretty(v: unknown): string {
  if (v === null || v === undefined) return "—";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function AuditTab({ state, onError }: TabProps) {
  const tz = state.settings.timezone;
  const [entityInput, setEntityInput] = useState("");
  const [actionInput, setActionInput] = useState("");
  const [filters, setFilters] = useState({ entity: "", action: "" });
  const [entries, setEntries] = useState<AuditEntryDTO[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (before: string | undefined, replace: boolean) => {
      setLoading(true);
      try {
        const r = await api.audit({ before, entity: filters.entity.trim(), action: filters.action.trim() });
        setEntries((prev) => (replace ? r.entries : [...prev, ...r.entries]));
        setNextBefore(r.nextBefore);
        setError(null);
      } catch (e) {
        if (!onError(e)) setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [filters, onError],
  );

  const firstPage = useCallback(() => fetchPage(undefined, true), [fetchPage]);
  useLoad(firstPage);

  return (
    <div className="flex flex-col gap-4">
      <TabHeader title="Audit log" />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ entity: entityInput, action: actionInput });
        }}
      >
        <Field label="Entity (e.g. session)">
          <input className={inputClass} value={entityInput} onChange={(e) => setEntityInput(e.target.value)} autoCapitalize="none" />
        </Field>
        <Field label="Action">
          <input className={inputClass} value={actionInput} onChange={(e) => setActionInput(e.target.value)} autoCapitalize="none" />
        </Field>
        <Button type="submit" variant="primary">
          Filter
        </Button>
        <Button
          onClick={() => {
            setEntityInput("");
            setActionInput("");
            setFilters({ entity: "", action: "" });
          }}
        >
          Clear
        </Button>
      </form>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <ul className="flex flex-col gap-2">
        {entries.map((a) => {
          const isOpen = open === a.id;
          return (
            <li key={a.id} className="rounded-xl border border-line bg-surface">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : a.id)}
                className="flex min-h-14 w-full flex-col gap-0.5 px-4 py-3 text-left active:bg-surface-2"
              >
                <span className="flex flex-wrap justify-between gap-x-3">
                  <span className="font-semibold">
                    {a.action} <span className="font-normal text-muted">· {a.entity}</span>
                  </span>
                  <span className="tabular-nums text-muted">{formatDateTime(a.at, tz)}</span>
                </span>
                <span className="text-sm text-muted">
                  {a.actorName ?? "System"}
                  {a.approvedByName ? ` · approved by ${a.approvedByName}` : ""}
                  {a.deviceLabel ? ` · ${a.deviceLabel}` : ""}
                </span>
                {a.reason ? <span className="text-sm">Reason: {a.reason}</span> : null}
              </button>
              {isOpen ? (
                <div className="grid grid-cols-1 gap-3 border-t border-line p-4 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-sm font-semibold text-muted">Before</p>
                    <pre className="max-h-72 overflow-auto rounded-lg bg-bg p-3 text-sm">{pretty(a.before)}</pre>
                  </div>
                  <div>
                    <p className="mb-1 text-sm font-semibold text-muted">After</p>
                    <pre className="max-h-72 overflow-auto rounded-lg bg-bg p-3 text-sm">{pretty(a.after)}</pre>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {loading ? <Spinner /> : null}
      {!loading && entries.length === 0 && !error ? <p className="text-muted">No entries.</p> : null}
      {!loading && nextBefore ? (
        <Button size="lg" onClick={() => void fetchPage(nextBefore, false)}>
          Load older
        </Button>
      ) : null}
    </div>
  );
}
