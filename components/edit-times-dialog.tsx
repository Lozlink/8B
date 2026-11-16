"use client";

import { useMemo, useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Field, inputClass } from "@/components/ui";
import { api, type IntervalEditInput } from "@/lib/client/api";
import { isoToLocalInput, localInputToIso } from "@/lib/client/local-time";
import type { SessionDTO } from "@/lib/domain/types";

interface Props {
  session: SessionDTO;
  timeZone: string;
  onClose: () => void;
  onDone: () => void;
}

interface Row {
  id: string;
  tableName: string;
  start: string;
  end: string | null; // null = running interval, no end field
  originalStart: string;
  originalEnd: string | null;
  originalStartIso: string;
  originalEndIso: string | null;
}

export function EditTimesDialog({ session, timeZone, onClose, onDone }: Props) {
  const initial = useMemo<Row[]>(
    () =>
      session.intervals
        .slice()
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
        .map((i) => {
          const start = isoToLocalInput(i.startedAt, timeZone);
          const end = i.endedAt ? isoToLocalInput(i.endedAt, timeZone) : null;
          return {
            id: i.id,
            tableName: i.tableName,
            start,
            end,
            originalStart: start,
            originalEnd: end,
            originalStartIso: i.startedAt,
            originalEndIso: i.endedAt,
          };
        }),
    [session.intervals, timeZone],
  );
  const [rows, setRows] = useState(initial);

  const update = (id: string, patch: Partial<Pick<Row, "start" | "end">>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const problems = rows.map((r) => {
    if (!r.start) return "Start time is required.";
    if (r.end !== null && !r.end) return "End time is required.";
    if (r.end !== null && r.end <= r.start) return "End must be after start.";
    return null;
  });
  const changed = rows.some((r) => r.start !== r.originalStart || r.end !== r.originalEnd);
  const valid = problems.every((p) => p === null) && changed;

  const submit = async ({ pin, reason }: { pin: string; reason: string }) => {
    const intervals: IntervalEditInput[] = rows.map((r) => {
      // Untouched fields keep their exact original instant (seconds included).
      const startedAt = r.start === r.originalStart ? r.originalStartIso : localInputToIso(r.start, timeZone);
      const endedAt =
        r.end === null ? null : r.end === r.originalEnd ? r.originalEndIso : localInputToIso(r.end, timeZone);
      if (!startedAt || (r.end !== null && !endedAt)) throw new Error("One of the times isn't valid.");
      return { id: r.id, startedAt, endedAt };
    });
    await api.editTimes(session.id, pin, reason, intervals);
    onDone();
  };

  return (
    <ActionDialog
      title="Edit times"
      description={`Times are in ${timeZone}. A manager PIN and a reason are required, and the change is recorded.`}
      requirePin
      submitLabel="Save times"
      canSubmit={valid}
      onSubmit={submit}
      onClose={onClose}
    >
      <ul className="flex flex-col gap-4">
        {rows.map((r, idx) => (
          <li key={r.id} className="flex flex-col gap-3 rounded-xl border border-line p-3">
            <p className="font-semibold">
              {r.tableName}
              {r.end === null ? <span className="ml-2 text-sm font-normal text-muted">(running, no end)</span> : null}
            </p>
            <Field label="Start">
              <input
                type="datetime-local"
                className={inputClass}
                value={r.start}
                onChange={(e) => update(r.id, { start: e.target.value })}
              />
            </Field>
            {r.end !== null ? (
              <Field label="End">
                <input
                  type="datetime-local"
                  className={inputClass}
                  value={r.end}
                  onChange={(e) => update(r.id, { end: e.target.value })}
                />
              </Field>
            ) : null}
            {problems[idx] ? <p className="text-sm text-danger-text">{problems[idx]}</p> : null}
          </li>
        ))}
      </ul>
    </ActionDialog>
  );
}
