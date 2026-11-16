"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/action-dialog";
import { EditTimesDialog } from "@/components/edit-times-dialog";
import { useToast } from "@/components/toast";
import { Badge, Button, Notice, Sheet, Spinner, type Tone } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor, useServerNow } from "@/lib/client/floor-context";
import { checkoutLabel, estimate, sessionTableNames } from "@/lib/client/session-view";
import { can, STATUS_LABEL } from "@/lib/domain/machine";
import type { SessionDetailDTO } from "@/lib/domain/types";
import { formatDateTime, formatTime } from "@/lib/format";
import { formatCents, gstOf } from "@/lib/pricing";

const STATUS_TONE: Record<string, Tone> = {
  running: "running",
  paused: "paused",
  awaiting_payment: "awaiting",
  paid: "paid",
  void: "void",
};

interface Props {
  sessionId: string;
  onClose: () => void;
  /** Open the charge sheet (awaiting sessions). */
  onCharge?: () => void;
}

type Dialog = "edit" | "void" | "reverse" | null;

export function SessionDetailSheet({ sessionId, onClose, onCharge }: Props) {
  const router = useRouter();
  const toast = useToast();
  const { floor, refetch } = useFloor();
  const nowMs = useServerNow();
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [alreadyCard, setAlreadyCard] = useState(false);

  const tz = floor?.pricing.settings.timezone ?? "Australia/Sydney";

  const load = useCallback(async () => {
    try {
      setDetail(await api.session(sessionId));
      setError(null);
    } catch (e) {
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else setError(errorMessage(e));
    }
  }, [sessionId, router]);

  useLoad(load);

  const changed = async () => {
    await load();
    void refetch();
  };

  const s = detail?.session ?? null;

  return (
    <Sheet title={s ? sessionTableNames(s) : "Session"} onClose={onClose} size="lg">
      {!detail || !s ? (
        error ? (
          <div className="flex flex-col gap-3">
            <Notice tone="danger">{error}</Notice>
            <Button size="lg" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <Spinner />
        )
      ) : (
        <div className="flex flex-col gap-6">
          {alreadyCard ? (
            <Notice tone="danger" strong>
              Card payment already went through — this bill is paid. Don&apos;t take cash.
            </Notice>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{STATUS_LABEL[s.status]}</Badge>
            {s.status === "awaiting_payment" ? <span className="font-semibold text-warn">{checkoutLabel(s).label}</span> : null}
          </div>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-base sm:grid-cols-2">
            <Fact label="Opened" value={`${formatDateTime(s.openedAt, tz)} by ${s.openedByName}`} />
            {s.closedAt ? <Fact label="Closed" value={formatDateTime(s.closedAt, tz)} /> : null}
            {s.settledAt ? (
              <Fact
                label="Settled"
                value={`${formatDateTime(s.settledAt, tz)} · ${s.settledMethod ?? "—"}${s.settledByName ? ` · ${s.settledByName}` : ""}${s.settledVia ? ` (${viaLabel(s.settledVia)})` : ""}`}
              />
            ) : null}
            {s.voidReason ? <Fact label="Void reason" value={s.voidReason} /> : null}
            {s.note ? <Fact label="Note" value={s.note} /> : null}
          </dl>

          <Section title="Table time">
            <ul className="divide-y divide-line rounded-xl border border-line">
              {s.intervals
                .slice()
                .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
                .map((i) => (
                  <li key={i.id} className="flex justify-between gap-3 px-4 py-3">
                    <span className="font-semibold">{i.tableName}</span>
                    <span className="tabular-nums text-muted">
                      {formatTime(i.startedAt, tz)} – {i.endedAt ? formatTime(i.endedAt, tz) : "now"}
                    </span>
                  </li>
                ))}
            </ul>
          </Section>

          <Breakdown detail={detail} nowMs={nowMs} />

          {detail.checkouts.length > 0 ? (
            <Section title="Card attempts">
              <ul className="divide-y divide-line rounded-xl border border-line">
                {detail.checkouts.map((c) => (
                  <li key={c.id} className="flex flex-wrap justify-between gap-x-3 px-4 py-3">
                    <span>
                      #{c.attempt} · <span className="tabular-nums">{formatCents(c.amountCents)}</span> · {c.status}
                      {c.cancelReason ? <span className="text-muted"> ({c.cancelReason})</span> : null}
                    </span>
                    <span className="tabular-nums text-muted">{formatDateTime(c.createdAt, tz)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="Audit trail">
            {detail.audit.length === 0 ? (
              <p className="text-muted">Nothing recorded yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {detail.audit.map((a) => (
                  <li key={a.id} className="px-4 py-3">
                    <p className="flex flex-wrap justify-between gap-x-3">
                      <span className="font-semibold">{a.action}</span>
                      <span className="tabular-nums text-muted">{formatDateTime(a.at, tz)}</span>
                    </p>
                    <p className="text-sm text-muted">
                      {a.actorName ?? "System"}
                      {a.approvedByName ? ` · approved by ${a.approvedByName}` : ""}
                      {a.deviceLabel ? ` · ${a.deviceLabel}` : ""}
                    </p>
                    {a.reason ? <p className="text-sm">Reason: {a.reason}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <div className="flex flex-col gap-3 border-t border-line pt-4">
            {s.status === "awaiting_payment" && onCharge ? (
              <Button variant="brass" size="lg" onClick={onCharge}>
                Charge
              </Button>
            ) : null}
            {can(s.status, "edit_times") ? (
              <Button size="lg" onClick={() => setDialog("edit")}>
                Edit times (manager)
              </Button>
            ) : null}
            {can(s.status, "void") ? (
              <Button variant="danger" size="lg" onClick={() => setDialog("void")}>
                Void (manager)
              </Button>
            ) : null}
            {can(s.status, "reverse_paid") ? (
              <Button variant="danger" size="lg" onClick={() => setDialog("reverse")}>
                Reverse payment (manager)
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {dialog === "edit" && s ? (
        <EditTimesDialog
          session={s}
          timeZone={tz}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast.show("Times updated", "success");
            void changed();
          }}
        />
      ) : null}

      {dialog === "void" && s ? (
        <ActionDialog
          title="Void this session"
          description="The record is kept with the reason. Needs a manager PIN."
          requirePin
          danger
          submitLabel="Void session"
          onClose={() => setDialog(null)}
          onSubmit={async ({ pin, reason }) => {
            const r = await api.void(s.id, pin, reason);
            if (r.kind === "already_paid_by_card") setAlreadyCard(true);
            else toast.show("Session voided", "success");
            await changed();
          }}
        />
      ) : null}

      {dialog === "reverse" && s ? (
        <ActionDialog
          title="Reverse payment"
          description="Puts the session back to awaiting payment. Refund any money through Square yourself. Needs a manager PIN."
          requirePin
          danger
          submitLabel="Reverse payment"
          onClose={() => setDialog(null)}
          onSubmit={async ({ pin, reason }) => {
            await api.reverse(s.id, pin, reason);
            toast.show("Payment reversed", "success");
            await changed();
          }}
        />
      ) : null}
    </Sheet>
  );
}

function viaLabel(via: string): string {
  if (via === "square_webhook") return "Square webhook";
  if (via === "square_api") return "Square check";
  return "staff";
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm font-semibold text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-lg font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Breakdown({ detail, nowMs }: { detail: SessionDetailDTO; nowMs: number }) {
  const { floor } = useFloor();
  const s = detail.session;
  const live = s.status === "running" || s.status === "paused";
  const est = live && floor ? estimate(s, floor.pricing, nowMs) : null;
  const b = detail.breakdown;
  const lines = b?.lines ?? est?.lines ?? [];
  const total = b ? b.totalCents : est ? est.totalCents : s.totalCents;
  const minutes = b ? b.billedMinutes : est ? est.billedMinutes : s.billedMinutes;
  const gst = b ? b.gstCents : est ? est.gstCents : total !== null ? gstOf(total) : null;
  const isEstimate = !b && !!est;
  return (
    <Section title={isEstimate ? "Price (estimate)" : "Price"}>
      {lines.length === 0 && total === null ? (
        <p className="text-muted">No price yet.</p>
      ) : (
        <div className="rounded-xl border border-line">
          <ul className="divide-y divide-line">
            {lines.map((l) => (
              <li key={l.rateCardId} className="flex justify-between gap-3 px-4 py-3">
                <span>
                  {l.rateCardName} <span className="text-muted">· {l.minutes} min @ {formatCents(l.centsPerHour)}/h</span>
                </span>
                <span className="tabular-nums">{formatCents(l.cents)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between gap-3 border-t border-line bg-bg px-4 py-3 text-lg font-semibold">
            <span>
              Total{isEstimate ? " est." : ""}
              {minutes !== null ? <span className="font-normal text-muted"> · {minutes} min</span> : null}
            </span>
            <span className="tabular-nums">{total !== null ? formatCents(total) : "—"}</span>
          </div>
          {gst !== null ? (
            <p className="px-4 pb-3 text-sm text-muted">
              Includes GST of <span className="tabular-nums">{formatCents(gst)}</span>
            </p>
          ) : null}
        </div>
      )}
    </Section>
  );
}
