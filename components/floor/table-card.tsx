"use client";

import { Badge, Button, type Tone } from "@/components/ui";
import { STATUS_LABEL } from "@/lib/domain/machine";
import type { PricingConfigDTO, SessionDTO, TableDTO } from "@/lib/domain/types";
import { formatClock } from "@/lib/format";
import { adjustmentsSummary, billCan, itemCount, itemsLabel, sessionBill } from "@/lib/client/bill-view";
import { checkoutLabel, estimate } from "@/lib/client/session-view";
import { formatCents } from "@/lib/pricing";

export interface CardActions {
  start: (table: TableDTO) => void;
  pause: (s: SessionDTO) => void;
  resume: (s: SessionDTO) => void;
  transfer: (s: SessionDTO) => void;
  stop: (s: SessionDTO) => void;
  charge: (s: SessionDTO) => void;
  detail: (s: SessionDTO) => void;
}

interface Props {
  table: TableDTO;
  session: SessionDTO | null;
  pricing: PricingConfigDTO;
  nowMs: number;
  busy: boolean;
  actions: CardActions;
}

const TONE_BORDER: Record<string, string> = {
  free: "border-line",
  running: "border-[#2f9265]",
  paused: "border-[#3a77b0]",
  awaiting: "border-[#c18a22]",
};

const SUB_TONE = { info: "text-info", warn: "text-warn", muted: "text-muted" } as const;

export function TableCard({ table, session, pricing, nowMs, busy, actions }: Props) {
  const status = session?.status ?? null;
  const tone: Tone = !session ? "free" : status === "running" ? "running" : status === "paused" ? "paused" : "awaiting";
  const label = !session ? "Free" : STATUS_LABEL[session.status];

  let body: React.ReactNode;
  if (!session) {
    body = (
      <div className="flex flex-1 flex-col justify-center py-4">
        <p className="text-2xl font-semibold text-muted">Ready</p>
      </div>
    );
  } else if (status === "running" || status === "paused") {
    const est = estimate(session, pricing, nowMs);
    // Table time so far plus items, less the discount worked out on those same live figures.
    const bill = est ? sessionBill(session, { liveTableCents: est.totalCents }) : null;
    const adjustments = bill ? adjustmentsSummary(bill) : null;
    body = (
      <button
        type="button"
        onClick={() => actions.detail(session)}
        aria-label={`${table.name} details`}
        className="-mx-1 flex flex-1 flex-col items-start rounded-xl px-1 py-3 text-left active:bg-surface-2"
      >
        <span className="text-5xl font-semibold leading-none tabular-nums">{est ? formatClock(est.actualMs) : "—"}</span>
        <span className="mt-2 text-lg text-muted">
          <span className="tabular-nums">{bill ? formatCents(bill.totalCents) : "—"}</span> est.
          {status === "paused" ? <span className="ml-2 font-semibold text-info">Clock stopped</span> : null}
        </span>
        {session.items.length > 0 ? (
          <span className="mt-0.5 text-base text-muted">incl. {itemsLabel(itemCount(session.items))}</span>
        ) : null}
        {adjustments ? <span className="mt-0.5 text-base text-muted">{adjustments}</span> : null}
      </button>
    );
  } else {
    const sub = checkoutLabel(session);
    const bill = sessionBill(session);
    const adjustments = bill ? adjustmentsSummary(bill) : null;
    body = (
      <button
        type="button"
        onClick={() => actions.detail(session)}
        aria-label={`${table.name} details`}
        className="-mx-1 flex flex-1 flex-col items-start rounded-xl px-1 py-3 text-left active:bg-surface-2"
      >
        <span className="text-5xl font-semibold leading-none tabular-nums">
          {session.totalCents !== null ? formatCents(session.totalCents) : "—"}
        </span>
        <span className="mt-2 text-lg text-muted">
          {session.billedMinutes !== null ? `${session.billedMinutes} min billed` : "Total pending"}
          {session.items.length > 0 ? ` · ${itemsLabel(itemCount(session.items))}` : ""}
        </span>
        {adjustments ? <span className="mt-0.5 text-base text-muted">{adjustments}</span> : null}
        <span className={`mt-1 text-base font-semibold ${SUB_TONE[sub.tone]}`}>{sub.label}</span>
      </button>
    );
  }

  return (
    <article
      aria-label={`${table.name}, ${label}`}
      className={`flex min-h-64 w-full flex-col rounded-2xl border-2 bg-surface p-4 ${TONE_BORDER[tone]}`}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="truncate text-2xl font-bold">{table.name}</h2>
        <Badge tone={tone}>{label}</Badge>
      </header>
      {body}
      <div className="mt-2">
        {!session ? (
          <Button variant="primary" size="lg" full disabled={busy} onClick={() => actions.start(table)}>
            Start
          </Button>
        ) : status === "awaiting_payment" ? (
          <Button variant="brass" size="lg" full disabled={busy} onClick={() => actions.charge(session)}>
            Charge
          </Button>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {billCan(session, "pause") ? (
              <Button size="lg" className="px-1" disabled={busy} onClick={() => actions.pause(session)}>
                Pause
              </Button>
            ) : (
              <Button variant="primary" size="lg" className="px-1" disabled={busy} onClick={() => actions.resume(session)}>
                Resume
              </Button>
            )}
            <Button size="lg" className="px-1" disabled={busy || !billCan(session, "transfer")} onClick={() => actions.transfer(session)}>
              Transfer
            </Button>
            <Button variant="danger" size="lg" className="px-1" disabled={busy || !billCan(session, "stop")} onClick={() => actions.stop(session)}>
              Stop
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
