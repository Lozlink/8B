"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/action-dialog";
import { AdjustmentRows } from "@/components/bill-rows";
import { DiscountPanel } from "@/components/discount-panel";
import { EditTimesDialog } from "@/components/edit-times-dialog";
import { ItemsPanel } from "@/components/items-panel";
import { PaidBillActions, RefundsSection } from "@/components/paid-bill-actions";
import { PartsPanel } from "@/components/split-panel";
import { useToast } from "@/components/toast";
import { Badge, Button, Notice, Sheet, Spinner, type Tone } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor, useServerNow } from "@/lib/client/floor-context";
import { billCan, billName, billOf, discountBase, groupItems, lineLabel } from "@/lib/client/bill-view";
import {
  HAS_REFUNDS_NOTE,
  REOPENED_TOAST,
  REOPEN_BUTTON,
  REOPEN_SUBMIT,
  REOPEN_TITLE,
  reopenBlurb,
} from "@/lib/client/refund-view";
import { checkoutLabel, estimate } from "@/lib/client/session-view";
import { can, STATUS_LABEL } from "@/lib/domain/machine";
import type { SessionDetailDTO } from "@/lib/domain/types";
import { formatDateTime, formatTime } from "@/lib/format";
import { itemCents } from "@/lib/domain/bill";
import { formatCents } from "@/lib/pricing";

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
  const { floor, refetch, version } = useFloor();
  const nowMs = useServerNow();
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [alreadyCard, setAlreadyCard] = useState(false);

  const tz = floor?.pricing.settings.timezone ?? "Australia/Sydney";

  // Only the newest detail request may apply, so an older reply can't overwrite a newer one.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await api.session(sessionId);
      if (mine !== seq.current) return;
      setDetail(d);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else setError(errorMessage(e));
    }
  }, [sessionId, router]);

  // Reload on open and whenever the floor refreshes (another iPad or a manager may have changed it).
  useLoad(load, version);

  const changed = async () => {
    await load();
    void refetch();
  };

  const s = detail?.session ?? null;

  // What a discount would come off: table time (live estimate while running) plus items.
  const running = !!s && (s.status === "running" || s.status === "paused");
  const liveEst = detail && s && running && floor ? estimate(s, floor.pricing, nowMs) : null;
  const billNow = detail ? billOf(detail, running ? (liveEst ? liveEst.totalCents : null) : undefined) : null;

  return (
    <Sheet title={s ? billName(s) : "Session"} onClose={onClose} size="lg">
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
          {error ? (
            <Notice tone="warn">
              <span className="block">Couldn&apos;t refresh, so this may be out of date. {error}</span>
              <Button className="mt-2" onClick={() => void load()}>
                Retry
              </Button>
            </Notice>
          ) : null}
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
            {s.closedAt && s.kind === "table" ? <Fact label="Closed" value={formatDateTime(s.closedAt, tz)} /> : null}
            {s.settledAt ? (
              <Fact
                label="Settled"
                value={`${formatDateTime(s.settledAt, tz)} · ${s.settledMethod ?? "—"}${s.settledByName ? ` · ${s.settledByName}` : ""}${s.settledVia ? ` (${viaLabel(s.settledVia, s.settledMethod)})` : ""}`}
              />
            ) : null}
            {s.settledAt && s.settledCents !== null && s.settledCents > 0 && s.settledMethod === "cash" ? (
              <Fact label="Cash collected" value={formatCents(s.settledCents)} />
            ) : null}
            {s.settledAt && s.settledCents !== null && s.settledMethod === "card" && s.totalCents !== null && s.settledCents !== s.totalCents ? (
              <>
                <Fact label="Bill" value={formatCents(s.totalCents)} />
                <Fact label="Card charged" value={formatCents(s.settledCents)} />
              </>
            ) : null}
            {s.settledMethod === "cash" && s.squareCash ? <SquareCashFact cash={s.squareCash} /> : null}
            {s.voidReason ? <Fact label="Void reason" value={s.voidReason} /> : null}
            {s.note ? <Fact label="Note" value={s.note} /> : null}
          </dl>

          <PaidBillActions session={s} onChanged={changed} stale={error !== null} />

          {s.kind === "table" ? (
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
          ) : null}

          <ItemsPanel session={s} reload={load} />

          <DiscountPanel session={s} baseCents={billNow ? discountBase(billNow) : null} reload={load} />

          <PartsPanel session={s} />

          <Breakdown detail={detail} nowMs={nowMs} />

          <RefundsSection detail={detail} tz={tz} reload={load} stale={error !== null} />

          {detail.removedItems.length > 0 ? (
            <Section title="Removed items">
              <ul className="divide-y divide-line rounded-xl border border-line">
                {detail.removedItems.map((i) => (
                  <li key={i.id} className="px-4 py-3">
                    <p className="flex flex-wrap justify-between gap-x-3">
                      <span className="text-muted line-through">
                        {i.quantity} × {i.name}
                      </span>
                      <span className="tabular-nums text-muted line-through">{formatCents(itemCents(i))}</span>
                    </p>
                    <p className="text-sm text-muted">
                      Added by {i.addedByName} at {formatTime(i.addedAt, tz)}
                      {i.removedAt ? ` · removed ${i.removedByName ? `by ${i.removedByName} ` : ""}at ${formatTime(i.removedAt, tz)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

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
              <Button variant="accent" size="lg" onClick={onCharge}>
                Charge
              </Button>
            ) : null}
            {billCan(s, "edit_times") ? (
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
              s.refundedCents > 0 ? (
                <p className="text-sm text-muted">{HAS_REFUNDS_NOTE}</p>
              ) : (
                <Button variant="danger" size="lg" disabled={error !== null} onClick={() => setDialog("reverse")}>
                  {REOPEN_BUTTON}
                </Button>
              )
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
          title={REOPEN_TITLE}
          description={reopenBlurb(s.settledMethod)}
          requirePin
          danger
          submitLabel={REOPEN_SUBMIT}
          onClose={() => setDialog(null)}
          onSubmit={async ({ pin, reason }) => {
            await api.reverse(s.id, pin, reason);
            toast.show(REOPENED_TOAST, "success");
            await changed();
          }}
        />
      ) : null}
    </Sheet>
  );
}

function viaLabel(via: string, method: string | null): string {
  if (method === "cash" && via === "square_api") return "Square POS";
  if (via === "square_webhook") return "Square webhook";
  if (via === "square_api") return "Square check";
  return "staff";
}

function SquareCashFact({ cash }: { cash: NonNullable<SessionDetailDTO["session"]["squareCash"]> }) {
  if (cash.state === "skipped") return null;
  const text =
    cash.state === "recorded"
      ? "In Square"
      : cash.state === "pending"
        ? "Sending to Square"
        : cash.state === "refunded"
          ? "Reversed. Refund recorded in Square"
          : "Not in Square yet. A manager can retry in Admin → Items.";
  return (
    <div>
      <dt className="text-sm font-semibold text-muted">Square</dt>
      <dd className={cash.state === "failed" ? "text-warn" : ""}>
        {text}
        {cash.state === "failed" && cash.error ? <span className="block text-sm text-muted">{cash.error}</span> : null}
      </dd>
    </div>
  );
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
  // Running/paused: the server price is a snapshot from fetch time, so show the live client estimate.
  const est = live && floor ? estimate(s, floor.pricing, nowMs) : null;
  const b = detail.breakdown;
  // Table time only. Closed: the stored bill (minus items) is authoritative.
  const bill = live ? (est ? billOf(detail, est.totalCents) : null) : billOf(detail);
  const minutes = live ? (est ? est.billedMinutes : null) : (s.billedMinutes ?? b?.billedMinutes ?? null);
  const lines = live ? (est?.lines ?? []) : b && bill && b.totalCents === bill.tableCents ? b.lines : [];
  const isEstimate = live;
  const hasItems = s.items.length > 0;
  // Table time, items, then what comes off (discount, the part paid separately), then the total.
  const isTable = s.kind === "table";
  const adjusted = !!bill && (!!bill.discount || bill.splitOffCents > 0);
  return (
    <Section title={isEstimate ? "Price (estimate)" : "Price"}>
      {!bill ? (
        <p className="text-muted">No price yet.</p>
      ) : (
        <div className="rounded-xl border border-line">
          {lines.length > 0 || hasItems || adjusted ? (
            <ul className="divide-y divide-line">
              {lines.map((l) => (
                <li key={l.rateCardId} className="flex justify-between gap-3 px-4 py-3">
                  <span>
                    {l.rateCardName} <span className="text-muted">· {l.minutes} min @ {formatCents(l.centsPerHour)}/h</span>
                  </span>
                  <span className="tabular-nums">{formatCents(l.cents)}</span>
                </li>
              ))}
              {isTable && lines.length === 0 && (hasItems || adjusted) ? (
                <li className="flex justify-between gap-3 px-4 py-3">
                  <span>Table time</span>
                  <span className="tabular-nums">{formatCents(bill.tableCents)}</span>
                </li>
              ) : null}
              {hasItems && s.kind === "part"
                ? groupItems(s.items).map((g) => (
                    <li key={g.key} className="flex justify-between gap-3 px-4 py-3">
                      <span>{lineLabel(g)}</span>
                      <span className="tabular-nums">{formatCents(g.cents)}</span>
                    </li>
                  ))
                : hasItems ? (
                    <li className="flex justify-between gap-3 px-4 py-3">
                      <span>Items</span>
                      <span className="tabular-nums">{formatCents(bill.itemsCents)}</span>
                    </li>
                  ) : null}
              <AdjustmentRows bill={bill} rowClass="flex justify-between gap-3 px-4 py-3" />
            </ul>
          ) : null}
          <div className="flex justify-between gap-3 border-t border-line bg-bg px-4 py-3 text-lg font-semibold first:border-t-0">
            <span>
              {bill.splitOffCents > 0 ? "To pay on this bill" : "Total"}
              {isEstimate ? " est." : ""}
              {isTable && minutes !== null ? <span className="font-normal text-muted"> · {minutes} min</span> : null}
            </span>
            <span className="tabular-nums">{formatCents(bill.totalCents)}</span>
          </div>
          <p className="px-4 pb-3 text-sm text-muted">
            Includes GST of <span className="tabular-nums">{formatCents(bill.gstCents)}</span>
          </p>
        </div>
      )}
    </Section>
  );
}
