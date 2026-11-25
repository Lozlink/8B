"use client";

import { useCallback, useState } from "react";
import { useToast } from "@/components/toast";
import { Button, Notice, Spinner } from "@/components/ui";
import { api } from "@/lib/client/api";
import { errorMessage } from "@/lib/client/errors";
import { useLoad } from "@/lib/client/use-load";
import type { EnquiryDTO } from "@/lib/domain/types";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { TabHeader, type TabProps } from "./shared";

const linkClass = "break-all text-info underline underline-offset-4";

export function EnquiriesTab({ state, reload, onError }: TabProps) {
  const tz = state.settings.timezone;
  const toast = useToast();
  const [enquiries, setEnquiries] = useState<EnquiryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.enquiries();
      setEnquiries(r.enquiries);
      setError(null);
    } catch (e) {
      if (!onError(e)) setError(errorMessage(e));
    }
  }, [onError]);
  useLoad(load);

  const setHandled = async (id: string, handled: boolean) => {
    setBusyId(id);
    try {
      await api.setEnquiryHandled(id, handled);
      toast.show(handled ? "Marked as dealt with." : "Back on the open list.", "success");
    } catch (e) {
      if (!onError(e)) toast.show(errorMessage(e), "error");
    } finally {
      // Either way, show what's there now: another manager may have got to it first.
      await Promise.all([load(), reload()]);
      setBusyId(null);
    }
  };

  const open = enquiries?.filter((e) => !e.handled) ?? [];
  const done = enquiries?.filter((e) => e.handled) ?? [];
  const card = (e: EnquiryDTO) => (
    <EnquiryCard key={e.id} e={e} tz={tz} busy={busyId !== null} onToggle={() => void setHandled(e.id, !e.handled)} />
  );

  return (
    <div className="flex flex-col gap-4">
      <TabHeader title="Enquiries" />
      <p className="text-muted">From the functions and contact forms on the website. Reply by email or phone, then mark it as dealt with.</p>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {enquiries === null && !error ? <Spinner /> : null}
      {enquiries?.length === 0 ? <p className="text-muted">None yet.</p> : null}

      {open.length > 0 ? <ul className="flex flex-col gap-3">{open.map(card)}</ul> : null}
      {enquiries && enquiries.length > 0 && open.length === 0 ? <p className="text-muted">Nothing open.</p> : null}

      {done.length > 0 ? (
        <section className="mt-4 flex flex-col gap-3" aria-labelledby="enquiries-done">
          <h3 id="enquiries-done" className="text-lg font-semibold text-muted">
            Dealt with
          </h3>
          <ul className="flex flex-col gap-3">{done.map(card)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function EnquiryCard({ e, tz, busy, onToggle }: { e: EnquiryDTO; tz: string; busy: boolean; onToggle: () => void }) {
  const when = [
    e.preferredDate ? formatCalendarDate(e.preferredDate) : null,
    e.groupSize ? `${e.groupSize} ${e.groupSize === 1 ? "person" : "people"}` : null,
  ].filter(Boolean);
  return (
    <li className={`flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 ${e.handled ? "opacity-75" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex flex-wrap items-center gap-x-2 text-lg font-semibold">
          <span
            className={`inline-flex rounded-full border px-2.5 py-0.5 text-sm font-semibold ${
              e.kind === "functions" ? "border-brand/60 bg-brand/15 text-accent" : "border-line bg-surface-2 text-muted"
            }`}
          >
            {e.kind === "functions" ? "Functions" : "Contact"}
          </span>
          <span>
            {e.name}
            {e.company ? <span className="font-normal text-muted"> · {e.company}</span> : null}
          </span>
        </p>
        <p className="text-sm tabular-nums text-muted">Sent {formatDateTime(e.createdAt, tz)}</p>
      </div>

      {e.kind === "functions" ? (
        when.length > 0 ? (
          <p className="text-base">{when.join(" · ")}</p>
        ) : (
          <p className="text-base text-muted">No date or numbers given</p>
        )
      ) : null}

      <p className="flex flex-wrap gap-x-5 gap-y-1">
        <a href={`mailto:${e.email}`} className={linkClass}>
          {e.email}
        </a>
        {e.phone ? (
          <a href={`tel:${e.phone.replace(/[^\d+]/g, "")}`} className={linkClass}>
            {e.phone}
          </a>
        ) : null}
      </p>

      {e.message ? <p className="whitespace-pre-wrap break-words rounded-xl bg-bg p-3">{e.message}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted">
          {e.handled ? `Dealt with ${formatDateTime(e.handled.at, tz)}${e.handled.byName ? ` by ${e.handled.byName}` : ""}` : ""}
        </span>
        <Button variant={e.handled ? "secondary" : "primary"} disabled={busy} onClick={onToggle}>
          {e.handled ? "Reopen" : "Mark dealt with"}
        </Button>
      </div>
    </li>
  );
}
