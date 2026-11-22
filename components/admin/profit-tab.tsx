"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button, Field, Notice, Spinner, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import {
  PRESETS,
  buildProfitCsv,
  checkRange,
  formatDateLabel,
  formatMarginBps,
  formatSignedCents,
  presetFor,
  presetRange,
  profitCsvFilename,
  type DateRange,
} from "@/lib/client/costs";
import { errorMessage } from "@/lib/client/errors";
import { useLoad } from "@/lib/client/use-load";
import type { ProfitLineDTO, ProfitReportDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";
import { TabHeader, type TabProps } from "./shared";

const chipClass = (on: boolean) =>
  `flex min-h-12 shrink-0 select-none items-center rounded-full border px-4 text-base font-semibold transition-colors ${
    on ? "border-brand bg-brand text-on-brand" : "border-line bg-surface-2 text-chalk active:bg-line"
  }`;

const money = (c: number) => formatSignedCents(c, formatCents);

function Stat({ label, value, note, bad }: { label: string; value: string; note?: string; bad?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${bad ? "text-danger-text" : ""}`}>{value}</p>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
    </div>
  );
}

function Num({ children, bad }: { children: ReactNode; bad?: boolean }) {
  return <td className={`whitespace-nowrap px-3 py-3 text-right tabular-nums ${bad ? "font-semibold text-danger-text" : ""}`}>{children}</td>;
}

function LineRow({ l }: { l: ProfitLineDTO }) {
  const none = l.uncostedQuantity >= l.quantity;
  return (
    <tr className="border-t border-line align-top">
      <td className="px-3 py-3">
        <span className="block min-w-40 break-words font-semibold">{l.name}</span>
        {l.uncostedQuantity > 0 ? (
          <span className="mt-1 inline-flex rounded-full border border-[#c18a22] bg-[#33260a] px-2.5 py-0.5 text-xs font-semibold">
            {none ? "No cost" : `${l.uncostedQuantity} of ${l.quantity} have no cost`}
          </span>
        ) : null}
      </td>
      <Num>{l.quantity}</Num>
      <Num>{formatCents(l.salesExGstCents)}</Num>
      <Num>{none ? "-" : formatCents(l.costCents)}</Num>
      <Num bad={!none && l.profitCents < 0}>{none ? "-" : money(l.profitCents)}</Num>
      <Num bad={l.marginBps !== null && l.marginBps < 0}>{formatMarginBps(l.marginBps)}</Num>
    </tr>
  );
}

function downloadCsv(report: ProfitReportDTO) {
  // The byte order mark makes Excel read the file as UTF-8.
  const blob = new Blob(["﻿", buildProfitCsv(report)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = profitCsvFilename(report);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ProfitTab({ onError }: TabProps) {
  const [report, setReport] = useState<ProfitReportDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The dates being shown (or asked for), and the custom fields.
  const [range, setRange] = useState<DateRange | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const latest = useRef(0);
  // What was last asked for, so "Try again" retries that and not the last range that worked.
  const asked = useRef<DateRange | undefined>(undefined);

  /** Loads a range, or the business day running now when none is given. Only the newest request lands. */
  const fetchReport = useCallback(
    async (r?: DateRange) => {
      const id = ++latest.current;
      asked.current = r;
      setLoading(true);
      setError(null);
      try {
        const res = await api.adminProfit(r?.from, r?.to);
        if (id !== latest.current) return;
        setReport(res);
        setRange({ from: res.from, to: res.to });
        setFrom(res.from);
        setTo(res.to);
      } catch (e) {
        if (id !== latest.current) return;
        if (!onError(e)) setError(errorMessage(e));
      } finally {
        if (id === latest.current) setLoading(false);
      }
    },
    [onError],
  );

  const first = useCallback(() => fetchReport(), [fetchReport]);
  useLoad(first);

  const today = report?.today ?? null;
  const activePreset = range && today ? presetFor(range, today) : null;

  const showCustom = () => {
    const c = checkRange(from, to);
    if (!c.ok) {
      setRangeError(c.error);
      return;
    }
    setRangeError(null);
    void fetchReport({ from, to });
  };

  const items = report?.items;

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="Profit"
        action={
          report ? (
            <Button disabled={loading} onClick={() => downloadCsv(report)}>
              Download CSV
            </Button>
          ) : null
        }
      />
      <p className="max-w-2xl text-base text-muted">
        Profit on items sold, worked out from the costs you enter on the Items tab. Costs and profit are ex GST and stay in this app;
        Square never sees them.
      </p>

      <div role="group" aria-label="Dates" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={activePreset === p.key}
            disabled={today === null || loading}
            onClick={() => today && void fetchReport(presetRange(p.key, today))}
            className={`${chipClass(activePreset === p.key)} disabled:opacity-50`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          showCustom();
        }}
      >
        <div className="w-40">
          <Field label="From">
            <input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        </div>
        <div className="w-40">
          <Field label="To">
            <input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" disabled={loading || today === null}>
          Show these dates
        </Button>
      </form>
      {rangeError ? <Notice tone="danger">{rangeError}</Notice> : null}
      {error ? (
        <div className="flex flex-col items-start gap-3">
          <Notice tone="danger">{error}</Notice>
          <Button onClick={() => void fetchReport(asked.current)}>Try again</Button>
        </div>
      ) : null}

      {!report ? (
        loading ? (
          <Spinner />
        ) : null
      ) : (
        <div className={`flex flex-col gap-4 transition-opacity ${loading ? "opacity-50" : ""}`} aria-busy={loading}>
          <h3 className="text-lg font-semibold">
            {report.from === report.to ? formatDateLabel(report.from) : `${formatDateLabel(report.from)} to ${formatDateLabel(report.to)}`}
          </h3>

          {items && items.uncostedQuantity > 0 ? (
            <Notice tone="warn">
              <strong>
                {items.uncostedQuantity} item{items.uncostedQuantity === 1 ? "" : "s"} sold {items.uncostedQuantity === 1 ? "has" : "have"} no
                cost, worth {formatCents(items.uncostedSalesExGstCents)} ex GST.
              </strong>{" "}
              They are left out of profit. Add their costs on the Items tab.
            </Notice>
          ) : null}

          <p className="text-sm text-muted">
            Profit is on what was put on bills. Refunds, written-off shares and bills never paid are not taken off. A discount comes off the
            bill, not off an item, so an item given away free still shows its full profit.
          </p>

          {items ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Item sales ex GST" value={formatCents(items.salesExGstCents)} note={`${items.quantity} sold`} />
              <Stat label="Cost" value={formatCents(items.costCents)} />
              <Stat label="Profit" value={money(items.profitCents)} bad={items.profitCents < 0} />
              <Stat label="Margin" value={formatMarginBps(items.marginBps)} bad={items.marginBps !== null && items.marginBps < 0} />
            </div>
          ) : null}

          {report.lines.length === 0 ? (
            <p className="rounded-2xl border border-line bg-surface p-4 text-muted">No items sold in these dates.</p>
          ) : (
            <div className="overflow-x-auto overscroll-x-contain rounded-2xl border border-line bg-surface">
              <table className="w-full min-w-[34rem] border-collapse text-base">
                <caption className="sr-only">Items sold, with cost and profit, amounts ex GST</caption>
                <thead>
                  <tr className="text-sm text-muted">
                    <th scope="col" className="px-3 py-3 text-left font-semibold">
                      Item
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-semibold">
                      Qty
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-semibold">
                      Sales ex GST
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-semibold">
                      Cost
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-semibold">
                      Profit
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-semibold">
                      Margin
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.lines.map((l) => (
                    <LineRow key={l.productId ?? `custom:${l.name}`} l={l} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 text-base">
            <p>
              <span className="font-semibold">Table time: {formatCents(report.table.cents)}</span> ({formatCents(report.table.exGstCents)} ex
              GST). Nothing is set against it, so it is not in the profit above.
            </p>
            <p>
              <span className="font-semibold">Discounts: {formatCents(report.discountCents)} GST included.</span> They come off the whole bill, not off any
              one item, so the profit above is before them.
            </p>
            <p className="text-muted">
              Stock Square counts is worth {formatCents(report.stock.costCents)} at cost right now
              {report.stock.uncostedProducts > 0 ? `, not counting ${report.stock.uncostedProducts} tracked items with no cost` : ""}.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
