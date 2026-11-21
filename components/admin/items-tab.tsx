"use client";

import { useMemo, useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useToast } from "@/components/toast";
import { Button, ProductImage, Notice, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import { discountWhat } from "@/lib/client/bill-view";
import { isManagerRequired } from "@/lib/client/errors";
import { ALL_CATEGORY, categoryOptions, filterProducts, stockTone } from "@/lib/client/item-picker";
import { useAction } from "@/lib/client/use-action";
import type { AdminProductDTO } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";
import { TabHeader, type TabProps } from "./shared";

type Gap = "no-barcode" | "untracked" | "low";

const GAPS: { key: Gap; label: string; test: (p: AdminProductDTO) => boolean }[] = [
  { key: "no-barcode", label: "No barcode", test: (p) => p.barcode === null },
  { key: "untracked", label: "Not tracked", test: (p) => !p.tracked },
  { key: "low", label: "Out or low", test: (p) => p.tracked && stockTone(p.stock) !== null },
];

const chipClass = (on: boolean) =>
  `flex min-h-11 shrink-0 select-none items-center gap-2 rounded-full border px-4 text-base font-semibold transition-colors ${
    on ? "border-brand bg-brand text-on-brand" : "border-line bg-surface-2 text-chalk active:bg-line"
  }`;

function StockText({ p }: { p: AdminProductDTO }) {
  if (!p.tracked) return <span className="text-muted">Stock not tracked</span>;
  if (p.stock === null) return <span className="text-muted">Not counted in Square yet</span>;
  const tone = stockTone(p.stock);
  if (tone === "out") return <span className="font-semibold text-danger-text">Out of stock{p.stock < 0 ? ` (${p.stock})` : ""}</span>;
  return <span className={`tabular-nums ${tone === "low" ? "font-semibold text-warn" : "text-muted"}`}>{p.stock} in stock</span>;
}

export function ItemsTab({ state, reload, onError }: TabProps) {
  const toast = useToast();
  const { run, pending } = useAction();
  const [switching, setSwitching] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORY);
  const [gap, setGap] = useState<Gap | null>(null);
  const { catalog, settings } = state;
  const on = settings.itemiseCharges;

  // Active items first, in the order the server gave them.
  const allProducts = useMemo(() => [...catalog.products].sort((a, b) => Number(b.active) - Number(a.active)), [catalog.products]);
  const categories = useMemo(() => categoryOptions(allProducts), [allProducts]);
  // Gaps are counted over what staff can sell now, not items gone from Square.
  const gapCounts = useMemo(() => {
    const active = allProducts.filter((p) => p.active);
    return GAPS.map((g) => ({ ...g, count: active.filter(g.test).length }));
  }, [allProducts]);
  const activeGap = gapCounts.find((g) => g.key === gap && g.count > 0) ?? null;
  const activeCategory = categories.some((c) => c.key === category) ? category : ALL_CATEGORY;
  const products = useMemo(() => {
    const found = filterProducts(allProducts, activeCategory, query);
    return activeGap ? found.filter((p) => p.active && activeGap.test(p)) : found;
  }, [allProducts, activeCategory, query, activeGap]);
  const filtering = query.trim() !== "" || activeCategory !== ALL_CATEGORY || activeGap !== null;
  const clearFilters = () => {
    setQuery("");
    setCategory(ALL_CATEGORY);
    setGap(null);
  };
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

  const st = catalog.stock;
  const sendStockNow = async () => {
    const r = await run(() => api.adminRetryStock(), {
      refetch: false,
      onError: (e) => (isManagerRequired(e) ? onError(e) : false),
    });
    if (!r) return;
    await reload();
    toast.show(
      r.pending + r.failed === 0 ? "All stock updates are in Square" : "Sent. Some stock updates are still not in Square",
      r.pending + r.failed === 0 ? "success" : "error",
    );
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
        Items, prices, barcodes and stock all come from Square. To change any of them, edit it in Square, then refresh here. Stock is
        counted and received in Square; this app takes sold items off it once a bill is paid. Bills that already have an item keep
        the price it was added at.
      </p>

      {catalog.taxWarning ? <Notice tone="warn">{catalog.taxWarning}</Notice> : null}

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

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">Stock in Square</p>
          <p className="text-lg font-semibold tabular-nums">
            {st.syncedAt ? `Counts read ${formatDateTime(st.syncedAt, settings.timezone)}` : "Counts not read yet"}
          </p>
          {st.pending === 0 && st.failed === 0 ? (
            <p className="mt-1 text-base text-muted">All sold items are off Square&rsquo;s stock</p>
          ) : (
            <>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {st.pending > 0 ? `${st.pending} sending` : ""}
                {st.pending > 0 && st.failed > 0 ? " · " : ""}
                {st.failed > 0 ? `${st.failed} failed` : ""}
              </p>
              {st.lastMoveError ? <p className="mt-1 break-words text-sm text-muted">{st.lastMoveError}</p> : null}
            </>
          )}
        </div>
        {st.pending > 0 || st.failed > 0 ? (
          <Button variant="primary" size="lg" disabled={pending} onClick={() => void sendStockNow()}>
            {pending ? "Sending…" : "Send now"}
          </Button>
        ) : null}
      </div>
      {st.lastError ? <Notice tone="warn">The last stock count from Square didn&rsquo;t work. {st.lastError}</Notice> : null}

      {allProducts.length === 0 ? (
        <p className="py-4 text-center text-muted">No items yet. Add them in Square, then tap Refresh from Square.</p>
      ) : (
        <>
          <input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Search items"
            placeholder="Search by name or barcode"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={inputClass}
          />
          {categories.length > 2 ? (
            <div role="group" aria-label="Category" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {categories.map((c) => (
                <button key={c.key} type="button" aria-pressed={c.key === activeCategory} onClick={() => setCategory(c.key)} className={chipClass(c.key === activeCategory)}>
                  {c.label}
                  <span className={`text-sm font-normal tabular-nums ${c.key === activeCategory ? "" : "text-muted"}`}>{c.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          {gapCounts.some((g) => g.count > 0) ? (
            <div role="group" aria-label="Items to fix in Square" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {gapCounts
                .filter((g) => g.count > 0)
                .map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    aria-pressed={activeGap?.key === g.key}
                    onClick={() => setGap(activeGap?.key === g.key ? null : g.key)}
                    className={chipClass(activeGap?.key === g.key)}
                  >
                    {g.label} ({g.count})
                  </button>
                ))}
            </div>
          ) : null}

          {products.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-2xl border border-line bg-surface p-4">
              <p className="text-muted">No items match.</p>
              {filtering ? <Button onClick={clearFilters}>Clear filters</Button> : null}
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {products.map((p) => (
                <li
                  key={p.id}
                  className={`flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 ${p.active ? "" : "opacity-60"}`}
                >
                  {p.imageUrl ? <ProductImage src={p.imageUrl} size={56} /> : null}
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-lg font-semibold">
                      <span className="min-w-0 break-words">{p.name}</span>
                      {!p.taxed ? (
                        <span className="inline-flex rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-sm font-semibold">
                          GST-free
                        </span>
                      ) : null}
                    </p>
                    <p className="text-sm text-muted">{p.active ? (p.category ?? "No category") : "No longer in Square"}</p>
                    {p.active ? (
                      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
                        {p.barcode ? <span className="tabular-nums">{p.barcode}</span> : <span className="text-muted">No barcode</span>}
                        <StockText p={p} />
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-lg font-semibold tabular-nums">{formatCents(p.priceCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
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
            on ? "justify-end border-brand bg-brand" : "justify-start border-line bg-surface-2"
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
