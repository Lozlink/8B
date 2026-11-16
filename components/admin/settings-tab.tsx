"use client";

import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import { TabHeader, type TabProps } from "./shared";

const WHOLE = /^\d+$/;

export function SettingsTab({ state, reload, onError }: TabProps) {
  const s = state.settings;
  const [rounding, setRounding] = useState(String(s.roundingMinutes));
  const [grace, setGrace] = useState(String(s.graceMinutes));
  const [minimum, setMinimum] = useState(String(s.minimumMinutes));
  const [dayStart, setDayStart] = useState(s.businessDayStart);
  const [open, setOpen] = useState(false);

  const valid =
    WHOLE.test(rounding) && Number(rounding) >= 1 && WHOLE.test(grace) && WHOLE.test(minimum) && /^([01]\d|2[0-3]):[0-5]\d$/.test(dayStart);
  const dirty =
    Number(rounding) !== s.roundingMinutes ||
    Number(grace) !== s.graceMinutes ||
    Number(minimum) !== s.minimumMinutes ||
    dayStart !== s.businessDayStart;

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <TabHeader title="Billing settings" />
      <p className="text-sm text-muted">Changes apply to bills stopped after saving. Time zone: {s.timezone}.</p>
      <Field label="Round up to (minutes)">
        <input className={inputClass} inputMode="numeric" value={rounding} onChange={(e) => setRounding(e.target.value)} />
      </Field>
      <Field label="Grace (minutes not billed)">
        <input className={inputClass} inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} />
      </Field>
      <Field label="Minimum charge (minutes)">
        <input className={inputClass} inputMode="numeric" value={minimum} onChange={(e) => setMinimum(e.target.value)} />
      </Field>
      <Field label="Business day starts" hint="Daily summary runs from this time to the same time next day.">
        <input className={inputClass} type="time" value={dayStart} onChange={(e) => setDayStart(e.target.value)} />
      </Field>
      <Button variant="primary" size="lg" disabled={!valid || !dirty} onClick={() => setOpen(true)}>
        Save settings
      </Button>
      {open ? (
        <ActionDialog
          title="Save settings"
          submitLabel="Save"
          onClose={() => setOpen(false)}
          onError={onError}
          onSubmit={async ({ reason }) => {
            await api.adminSettings({
              roundingMinutes: Number(rounding),
              graceMinutes: Number(grace),
              minimumMinutes: Number(minimum),
              businessDayStart: dayStart,
              reason,
            });
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}
