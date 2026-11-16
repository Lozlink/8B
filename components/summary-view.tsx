"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/action-dialog";
import { SessionDetailSheet } from "@/components/session-detail-sheet";
import { useToast } from "@/components/toast";
import { Button, Field, Notice, Spinner, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor } from "@/lib/client/floor-context";
import type { SummaryDTO, SummarySessionRow } from "@/lib/domain/types";
import { formatDateTime, formatTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";

type PaidItem = SummaryDTO["paidItems"][number];

export function SummaryView() {
  const router = useRouter();
  const toast = useToast();
  const { floor, version, refetch } = useFloor();
  const tz = floor?.pricing.settings.timezone ?? "Australia/Sydney";
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<SummaryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reversing, setReversing] = useState<PaidItem | null>(null);

  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const result = await api.summary(date ?? undefined);
      if (mine !== seq.current) return; // a newer request superseded this one
      setData(result);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else setError(errorMessage(e));
    }
  }, [date, router]);

  useLoad(load, version);

  const dur = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Daily summary</h1>
          {data ? (
            <p className="text-muted tabular-nums">
              {formatDateTime(data.from, tz)} to {formatDateTime(data.to, tz)}
            </p>
          ) : null}
        </div>
        <div className="flex items-end gap-2">
          <Field label="Business day">
            <input
              type="date"
              className={inputClass}
              value={date ?? data?.businessDate ?? ""}
              onChange={(e) => setDate(e.target.value || null)}
            />
          </Field>
          <Button onClick={() => setDate(null)} disabled={date === null}>
            Today
          </Button>
        </div>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!data ? (
        error ? null : <Spinner />
      ) : (
        <>
          <p className="text-sm text-muted">
            Paid figures count payments settled in this window. Sessions and billed totals count sessions closed in this
            window. Voids count sessions voided in this window.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Stat title="Sessions closed" big={String(data.sessions.count)} sub={`${data.sessions.billedMinutes} min (${dur(data.sessions.billedMinutes)}) billed`} />
            <Stat
              title="Billed"
              big={formatCents(data.sessions.billedCents)}
              sub={
                data.sessions.itemsCents > 0
                  ? `Table ${formatCents(data.sessions.tableCents)} · Items ${formatCents(data.sessions.itemsCents)} · GST included`
                  : "GST included"
              }
            />
            <Stat title="Paid by card" big={formatCents(data.paid.card.cents)} sub={`${data.paid.card.count} payment${data.paid.card.count === 1 ? "" : "s"}`} />
            <Stat title="Paid by cash" big={formatCents(data.paid.cash.cents)} sub={`${data.paid.cash.count} payment${data.paid.cash.count === 1 ? "" : "s"}`} />
            <Stat
              title="Unpaid"
              big={formatCents(data.unpaid.cents)}
              sub={`${data.unpaid.count} bill${data.unpaid.count === 1 ? "" : "s"}`}
              warn={data.unpaid.count > 0}
            />
            <Stat
              title="Older outstanding"
              big={formatCents(data.outstandingOlder.cents)}
              sub={`${data.outstandingOlder.count} bill${data.outstandingOlder.count === 1 ? "" : "s"} from earlier days`}
              warn={data.outstandingOlder.count > 0}
            />
          </div>

          {data.attention.length > 0 ? (
            <section aria-label="Needs attention" className="flex flex-col gap-2">
              <h2 className="text-xl font-semibold text-warn">Needs attention</h2>
              <ul className="flex flex-col gap-2">
                {data.attention.map((a) => (
                  <li key={a.id} className="rounded-xl border border-[#c18a22] bg-[#33260a] px-4 py-3">
                    <p className="font-semibold">{a.action}</p>
                    <p className="text-sm text-muted tabular-nums">
                      {formatDateTime(a.at, tz)}
                      {a.actorName ? ` · ${a.actorName}` : ""}
                      {a.deviceLabel ? ` · ${a.deviceLabel}` : ""}
                    </p>
                    {a.reason ? <p>{a.reason}</p> : null}
                    {a.entity === "session" && a.entityId ? (
                      <Button className="mt-2" onClick={() => setDetailId(a.entityId)}>
                        Open session
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <List title="Unpaid in this window" empty="None." rows={data.unpaid.items} tz={tz} onOpen={setDetailId} />

          {data.itemsSold.length > 0 ? (
            <section aria-label="Items sold" className="flex flex-col gap-2">
              <h2 className="text-xl font-semibold">Items sold</h2>
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {data.itemsSold.map((i) => (
                  <li key={i.productId} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="min-w-0 truncate font-semibold">{i.name}</span>
                    <span className="flex shrink-0 gap-4 tabular-nums">
                      <span className="text-muted">× {i.quantity}</span>
                      <span className="w-24 text-right">{formatCents(i.cents)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-label="Voids" className="flex flex-col gap-2">
            <h2 className="text-xl font-semibold">Voids ({data.voids.count})</h2>
            {data.voids.items.length === 0 ? (
              <p className="text-muted">None.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.voids.items.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => setDetailId(v.id)}
                      className="flex min-h-14 w-full flex-col gap-0.5 rounded-xl border border-line bg-surface px-4 py-3 text-left active:bg-surface-2"
                    >
                      <span className="flex justify-between gap-3">
                        <span className="font-semibold">{v.tableNames}</span>
                        <span className="tabular-nums">{v.totalCents !== null ? formatCents(v.totalCents) : "—"}</span>
                      </span>
                      <span className="text-sm text-muted">
                        {v.reason}
                        {v.voidedByName ? ` · by ${v.voidedByName}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Paid sessions" className="flex flex-col gap-2">
            <h2 className="text-xl font-semibold">Paid ({data.paidItems.length})</h2>
            {data.paidItems.length === 0 ? (
              <p className="text-muted">None.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.paidItems.map((p) => (
                  <li key={p.id} className="flex items-stretch gap-2">
                    <button
                      type="button"
                      onClick={() => setDetailId(p.id)}
                      className="flex min-h-14 flex-1 items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left active:bg-surface-2"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-semibold">{p.tableNames}</span>
                        <span className="text-sm text-muted tabular-nums">
                          {formatTime(p.settledAt, tz)} · {p.method}
                          {p.settledByName ? ` · ${p.settledByName}` : ""}
                        </span>
                      </span>
                      <span className="text-lg font-semibold tabular-nums">{p.totalCents !== null ? formatCents(p.totalCents) : "—"}</span>
                    </button>
                    <Button variant="secondary" onClick={() => setReversing(p)}>
                      Reverse
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {detailId ? <SessionDetailSheet sessionId={detailId} onClose={() => { setDetailId(null); void load(); }} /> : null}

      {reversing ? (
        <ActionDialog
          title={`Reverse ${reversing.tableNames}`}
          description="Puts the session back to awaiting payment. Refund any money through Square yourself. Needs a manager PIN."
          requirePin
          danger
          submitLabel="Reverse payment"
          onClose={() => setReversing(null)}
          onSubmit={async ({ pin, reason }) => {
            await api.reverse(reversing.id, pin, reason);
            toast.show("Payment reversed", "success");
            void refetch();
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function Stat({ title, big, sub, warn }: { title: string; big: string; sub: ReactNode; warn?: boolean }) {
  return (
    <div className={`rounded-2xl border bg-surface p-4 ${warn ? "border-[#c18a22]" : "border-line"}`}>
      <p className="text-sm font-semibold text-muted">{title}</p>
      <p className="mt-1 text-4xl font-bold tabular-nums">{big}</p>
      <p className="mt-1 text-base text-muted">{sub}</p>
    </div>
  );
}

function List({
  title,
  empty,
  rows,
  tz,
  onOpen,
}: {
  title: string;
  empty: string;
  rows: SummarySessionRow[];
  tz: string;
  onOpen: (id: string) => void;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="text-xl font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpen(r.id)}
                className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left active:bg-surface-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-semibold">{r.tableNames}</span>
                  <span className="text-sm text-muted tabular-nums">
                    {formatDateTime(r.openedAt, tz)}
                    {r.billedMinutes !== null ? ` · ${r.billedMinutes} min` : ""}
                  </span>
                </span>
                <span className="text-lg font-semibold tabular-nums">{r.totalCents !== null ? formatCents(r.totalCents) : "—"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
