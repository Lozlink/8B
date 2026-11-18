"use client";

import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { AdminRateCardDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";
import { ActiveTag, DAY_LABELS, RowActions, RowCard, TabHeader, type TabProps } from "./shared";

const TIME_START_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_END_RE = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

function daysSummary(days: number[]): string {
  const sorted = days.slice().sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  return sorted.map((d) => DAY_LABELS[d - 1]).join(", ");
}

export function RatesTab({ state, reload, onError }: TabProps) {
  const [editing, setEditing] = useState<AdminRateCardDTO | "new" | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <TabHeader title="Rate cards" action={<Button variant="primary" onClick={() => setEditing("new")}>Add rate card</Button>} />
      <p className="text-sm text-muted">Where windows overlap, the higher priority wins. Prices include GST.</p>
      <ul className="flex flex-col gap-3">
        {state.rateCards.map((c) => (
          <RowCard key={c.id}>
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-lg font-semibold">{c.name}</span>
                <ActiveTag active={c.active} />
              </div>
              <p className="text-base tabular-nums text-muted">
                {formatCents(c.centsPerHour)}/h · {daysSummary(c.daysOfWeek)} · {c.startLocal}–{c.endLocal} · priority {c.priority}
              </p>
            </div>
            <RowActions>
              <Button onClick={() => setEditing(c)}>Edit</Button>
            </RowActions>
          </RowCard>
        ))}
      </ul>
      {editing ? <RateDialog card={editing === "new" ? null : editing} onClose={() => setEditing(null)} reload={reload} onError={onError} /> : null}
    </div>
  );
}

function RateDialog({
  card,
  onClose,
  reload,
  onError,
}: {
  card: AdminRateCardDTO | null;
  onClose: () => void;
  reload: () => Promise<void>;
  onError: (e: unknown) => boolean;
}) {
  const [name, setName] = useState(card?.name ?? "");
  const [rate, setRate] = useState(card ? (card.centsPerHour / 100).toFixed(2) : "");
  const [days, setDays] = useState<number[]>(card?.daysOfWeek ?? [1, 2, 3, 4, 5, 6, 7]);
  const [start, setStart] = useState(card?.startLocal ?? "00:00");
  const [end, setEnd] = useState(card?.endLocal ?? "24:00");
  const [priority, setPriority] = useState(String(card?.priority ?? 0));
  const [active, setActive] = useState(card?.active ?? true);

  const rateOk = /^\d+(\.\d{1,2})?$/.test(rate.trim());
  const cents = rateOk ? Math.round(Number(rate) * 100) : NaN;
  const startOk = TIME_START_RE.test(start);
  const endOk = TIME_END_RE.test(end) && end !== start;
  const prioOk = /^-?\d+$/.test(priority.trim());
  const valid = name.trim().length > 0 && rateOk && days.length > 0 && startOk && endOk && prioOk;

  const toggleDay = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)));

  return (
    <ActionDialog
      title={card ? `Edit ${card.name}` : "Add rate card"}
      submitLabel="Save"
      canSubmit={valid}
      onClose={onClose}
      onError={onError}
      onSubmit={async ({ reason }) => {
        const body = {
          name: name.trim(),
          centsPerHour: cents,
          daysOfWeek: days,
          startLocal: start,
          endLocal: end,
          priority: Number(priority),
          reason,
        };
        if (card) await api.adminRateCard({ op: "update", id: card.id, ...body, active });
        else await api.adminRateCard({ op: "create", ...body });
        await reload();
      }}
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </Field>
        <Field label="Price per hour ($, GST included)" hint={rate && !rateOk ? "Enter dollars, e.g. 25 or 25.50." : undefined}>
          <input className={inputClass} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="25.00" />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-semibold text-muted">Days</legend>
          <div className="grid grid-cols-7 gap-1.5">
            {DAY_LABELS.map((label, i) => {
              const d = i + 1;
              const on = days.includes(d);
              return (
                <Button key={d} variant={on ? "primary" : "secondary"} aria-pressed={on} className="px-0" onClick={() => toggleDay(d)}>
                  {label}
                </Button>
              );
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts (HH:MM)" hint={start && !startOk ? "Use 24-hour HH:MM." : undefined}>
            <input className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} inputMode="numeric" placeholder="00:00" />
          </Field>
          <Field label="Ends (HH:MM, 24:00 = midnight)" hint={end && !endOk ? "Use HH:MM or 24:00, different from start." : undefined}>
            <input className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} inputMode="numeric" placeholder="24:00" />
          </Field>
        </div>
        <Field label="Priority" hint="Higher wins when windows overlap.">
          <input className={inputClass} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
        {card ? (
          <label className="flex min-h-12 items-center gap-3 text-base">
            <input type="checkbox" className="size-6 accent-[#f47b20]" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
        ) : null}
      </div>
    </ActionDialog>
  );
}
