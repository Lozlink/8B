"use client";

import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useToast } from "@/components/toast";
import { Button, Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import { discountWhat } from "@/lib/client/bill-view";
import { isManagerRequired } from "@/lib/client/errors";
import { useAction } from "@/lib/client/use-action";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";
import { TabHeader, type TabProps } from "./shared";

export function ItemsTab({ state, reload, onError }: TabProps) {
  const toast = useToast();
  const { run, pending } = useAction();
  const [switching, setSwitching] = useState(false);
  const { catalog, settings } = state;
  const on = settings.itemiseCharges;

  // Active items first, in the order the server gave them.
  const products = [...catalog.products].sort((a, b) => Number(b.active) - Number(a.active));
  const discounts = [...catalog.discounts].sort((a, b) => Number(b.active) - Number(a.active));

  const sq = state.squareCash;
  const sendNow = async () => {
    const r = await run(() => api.adminRetrySquareCash(), {
      refetch: false,
      onError: (e) => (isManagerRequired(e) ? onError(e) : false),
    });
    if (!r) return;
    await reload();
    toast.show(r.pending + r.failed === 0 ? "All cash sales are in Square" : "Sent. Some are still not in Square", r.pending + r.failed === 0 ? "success" : "error");
  };

  const refresh = async () => {
    const r = await run(() => api.adminSyncProducts(), {
      refetch: true,
      onError: (e) => (isManagerRequired(e) ? onError(e) : false),
    });
    if (!r) return;
    await reload();
    toast.show(`${r.count} item${r.count === 1 ? "" : "s"} from Square`, "success");
  };

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <TabHeader title="Items" />
      <p className="text-base text-muted">
        Items and prices come from Square. To change one, edit it in Square, then refresh here. Bills that already have an item keep
        the price it was added at.
      </p>

      {catalog.lastError ? (
        <Notice tone="warn">The last refresh from Square didn&rsquo;t work. {catalog.lastError}</Notice>
      ) : null}
      {!catalog.tableHireLinked ? (
        <Notice tone="info">
          Table time shows in Square as an unnamed &lsquo;Table hire&rsquo; line. To name it, create a variable-price item called
          &lsquo;Table hire&rsquo; in Square, then refresh.
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
        <div>
          <p className="text-sm font-semibold text-muted">Last updated from Square</p>
          <p className="text-lg font-semibold tabular-nums">
            {catalog.syncedAt ? formatDateTime(catalog.syncedAt, settings.timezone) : "Never"}
          </p>
        </div>
        <Button variant="primary" size="lg" disabled={pending} onClick={() => void refresh()}>
          {pending ? "Refreshing…" : "Refresh from Square"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">Cash sales in Square</p>
          {sq.pending === 0 && sq.failed === 0 ? (
            <p className="text-lg font-semibold">All cash sales are in Square</p>
          ) : (
            <>
              <p className="text-lg font-semibold tabular-nums">
                {sq.pending > 0 ? `${sq.pending} sending` : ""}
                {sq.pending > 0 && sq.failed > 0 ? " · " : ""}
                {sq.failed > 0 ? `${sq.failed} failed` : ""}
              </p>
              {sq.lastError ? <p className="mt-1 break-words text-sm text-muted">{sq.lastError}</p> : null}
            </>
          )}
        </div>
        {sq.pending > 0 || sq.failed > 0 ? (
          <Button variant="primary" size="lg" disabled={pending} onClick={() => void sendNow()}>
            {pending ? "Sending…" : "Send now"}
          </Button>
        ) : null}
      </div>

      {products.length === 0 ? (
        <p className="py-4 text-center text-muted">No items yet. Add them in Square, then tap Refresh from Square.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {products.map((p) => (
            <li
              key={p.id}
              className={`flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4 ${p.active ? "" : "opacity-60"}`}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-lg font-semibold">
                  <span className="min-w-0 break-words">{p.name}</span>
                  {!p.taxed ? (
                    <span className="inline-flex rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-sm font-semibold">
                      GST-free
                    </span>
                  ) : null}
                </p>
                <p className="text-sm text-muted">
                  {p.active ? (p.category ?? "No category") : "No longer in Square"}
                </p>
              </div>
              <span className="shrink-0 text-lg font-semibold tabular-nums">{formatCents(p.priceCents)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold">Discounts</h3>
        {discounts.length === 0 ? (
          <p className="rounded-2xl border border-line bg-surface p-4 text-base text-muted">
            No discounts in Square yet. Set them up in Square and they show here after a refresh. Staff can add them to a bill.
          </p>
        ) : (
          <>
            <p className="text-base text-muted">From Square. Staff pick these when they add a discount to a bill.</p>
            <ul className="flex flex-col gap-3">
              {discounts.map((d) => (
                <li
                  key={d.id}
                  className={`flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4 ${d.active ? "" : "opacity-60"}`}
                >
                  <div className="min-w-0">
                    <p className="break-words text-lg font-semibold">{d.name}</p>
                    <p className="text-sm text-muted">
                      {d.active
                        ? d.kind === "variable_percent" || d.kind === "variable_amount"
                          ? "Typed in when used. Needs a manager PIN."
                          : "Fixed in Square"
                        : "No longer in Square"}
                    </p>
                  </div>
                  <span className="shrink-0 text-lg font-semibold tabular-nums">{discountWhat(d)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="flex items-start justify-between gap-4 rounded-2xl border border-line bg-surface p-4">
        <div className="min-w-0">
          <p id="itemise-label" className="text-lg font-semibold">
            Itemised charges
          </p>
          <p className="mt-1 text-base text-muted">
            {on
              ? "On: each charge shows its items on the Terminal and in Square’s reports."
              : "Off: each charge is sent as one amount. Turn this on to show items on the Terminal and in Square’s reports."}
          </p>
          <p className="mt-1 text-sm text-muted">Turn it off if the Terminal has trouble with itemised charges.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="itemise-label"
          onClick={() => setSwitching(true)}
          className={`flex h-12 w-20 shrink-0 items-center rounded-full border px-1 transition-colors ${
            on ? "justify-end border-[#2f9265] bg-felt" : "justify-start border-line bg-surface-2"
          }`}
        >
          <span aria-hidden className="size-9 rounded-full bg-white shadow" />
        </button>
      </div>

      {switching ? (
        <ActionDialog
          title={on ? "Turn off itemised charges" : "Turn on itemised charges"}
          description={
            on
              ? "Charges sent from now on go to Square as one amount. Items are still on the bill here."
              : "Charges sent from now on list their items on the Terminal and in Square’s reports."
          }
          submitLabel={on ? "Turn off" : "Turn on"}
          onClose={() => setSwitching(false)}
          onError={onError}
          onSubmit={async ({ reason }) => {
            await api.adminItemise(!on, reason);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}
