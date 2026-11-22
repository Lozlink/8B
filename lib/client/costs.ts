/**
 * Unit costs and the profit report: ex-GST prices, margins, reading pasted cost rows, date presets and
 * the CSV. Pure: no I/O, no clock, no time zones. Money is integer cents and margins are integer basis
 * points; nothing here goes through a float that is then stored.
 */
import type { AdminProductDTO, ProfitReportDTO } from "@/lib/domain/types";
import { normaliseBarcode } from "./barcode";
import { parseCents } from "./money";

// ---------------------------------------------------------------------------
// Prices and margins
// ---------------------------------------------------------------------------

/** What a price is without its GST: `price x 10/11` rounded to the cent for a taxed item, the price itself otherwise. */
export function exGstCents(priceCents: number, taxed: boolean): number {
  // round(10p / 11) = floor((20p + 11) / 22) in whole numbers. A tie (x.5) can't happen, 11 is prime.
  return taxed ? Math.floor((priceCents * 20 + 11) / 22) : priceCents;
}

export interface Margin {
  /** The price with GST taken out, the number a cost is set against. */
  exGstCents: number;
  /** Ex-GST price less cost. Negative when the item sells below cost. */
  profitCents: number;
  /** Profit as a share of the ex-GST price, in basis points. Null when the ex-GST price is 0. */
  bps: number | null;
}

export function marginFor(priceCents: number, taxed: boolean, costCents: number): Margin {
  const ex = exGstCents(priceCents, taxed);
  const profit = ex - costCents;
  return { exGstCents: ex, profitCents: profit, bps: ex > 0 ? Math.round((profit * 10_000) / ex) : null };
}

/** 6250 -> "62.5%", -500 -> "-5.0%". Null (nothing to divide by) -> "n/a". */
export function formatMarginBps(bps: number | null): string {
  if (bps === null) return "n/a";
  const tenths = Math.round(bps / 10);
  const sign = tenths < 0 ? "-" : "";
  const abs = Math.abs(tenths);
  return `${sign}${Math.floor(abs / 10)}.${abs % 10}%`;
}

/** Cents with a sign, for money that can be negative (profit): -250 -> "-$2.50". */
export function formatSignedCents(cents: number, format: (c: number) => string): string {
  return cents < 0 ? `-${format(-cents)}` : format(cents);
}

type CostFields = Pick<AdminProductDTO, "active" | "tracked" | "stock" | "costCents">;

/** What the counted stock is worth at cost, and how many tracked items can't be counted for want of a cost. */
export function stockAtCost(products: readonly CostFields[]): { costCents: number; units: number; uncostedProducts: number } {
  let costCents = 0;
  let units = 0;
  let uncostedProducts = 0;
  for (const p of products) {
    if (!p.active || !p.tracked) continue;
    if (p.costCents === null) {
      uncostedProducts += 1;
      continue;
    }
    // Stock can go below zero in Square; that isn't a negative asset.
    if (p.stock !== null && p.stock > 0) {
      costCents += p.stock * p.costCents;
      units += p.stock;
    }
  }
  return { costCents, units, uncostedProducts };
}

/** Items staff can sell now that have no cost yet. */
export function noCostCount(products: readonly Pick<AdminProductDTO, "active" | "costCents">[]): number {
  return products.filter((p) => p.active && p.costCents === null).length;
}

// ---------------------------------------------------------------------------
// Typed cost
// ---------------------------------------------------------------------------

export type CostFieldCheck = { ok: true; costCents: number | null } | { ok: false; error: string };

/** A typed cost field: empty clears the cost, otherwise dollars like "1.20". */
export function checkCostField(text: string): CostFieldCheck {
  if (text.trim() === "") return { ok: true, costCents: null };
  const cents = parseCostText(text);
  if (cents === null) return { ok: false, error: "Type the cost in dollars, like 1.20." };
  if (cents > COST_MAX_CENTS) return { ok: false, error: OVER_CAP };
  return { ok: true, costCents: cents };
}

/**
 * "1.2", "$1.20", "1.2000" -> cents. A cost with more than two decimals is fine when the extra ones
 * are zeros (spreadsheets do that); anything else parseCents refuses is null.
 */
function parseCostText(text: string): number | null {
  const t = text.trim().replace(/^(\$?\s*\d*\.\d{2})0+$/, "$1");
  return parseCents(t);
}

/** The most one unit can cost; the server refuses more. */
export const COST_MAX_CENTS = 1_000_000;
const OVER_CAP = "The most a cost can be is $10,000.";

// ---------------------------------------------------------------------------
// Pasted rows
// ---------------------------------------------------------------------------

export type PasteProduct = Pick<AdminProductDTO, "id" | "name" | "barcode" | "sku" | "costCents" | "active">;

export interface PasteMatch<P extends PasteProduct = PasteProduct> {
  /** 1-based line in what was pasted. */
  line: number;
  product: P;
  oldCents: number | null;
  newCents: number;
  /** false when the pasted cost is what the product already has. */
  changed: boolean;
}

export interface PasteProblem {
  line: number;
  /** What was in the row, trimmed, for the owner to find it in the sheet. */
  text: string;
  /** Short reason in plain words. */
  reason: string;
}

export interface PastePreview<P extends PasteProduct = PasteProduct> {
  /** One per product. A product listed twice keeps its last row. */
  matched: PasteMatch<P>[];
  unmatched: PasteProblem[];
  /** Rows whose identifier fits more than one product. `reason` names them. */
  ambiguous: PasteProblem[];
  badCost: PasteProblem[];
  /** Earlier rows for a product that a later row replaces. */
  repeated: PasteProblem[];
  /** true when a first row that looked like column titles was left out. */
  headerSkipped: boolean;
}

/** Rows to send: the matched ones whose cost differs from what is saved. */
export function costsToSave(preview: PastePreview): { productId: string; costCents: number }[] {
  return preview.matched.filter((m) => m.changed).map((m) => ({ productId: m.product.id, costCents: m.newCents }));
}

/** A list cut into pieces of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Most the server takes in one call. */
export const COSTS_PER_CALL = 500;

const HEADER_WORDS = /\b(cost|price|item|name|sku|barcode|id|product|gtin|category)\b/i;
const THOUSANDS = /^\$?\d{1,3}(,\d{3})+(\.\d+)?$/;

function unquote(cell: string): string {
  const t = cell.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"').trim();
  return t;
}

/** Splits on commas that aren't inside double quotes. */
function splitCommas(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '""';
        i += 1;
        continue;
      }
      quoted = !quoted;
      cur += ch;
    } else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

type SplitRow = { id: string; cost: string; viaTab: boolean; commaInCost: boolean };

/**
 * One row to identifier and cost. A tab wins when the row has one (the first two columns are used);
 * otherwise a comma separates them, and the cost is whatever follows the last comma, so a name with a
 * comma in it still works. A comma row can't tell "Cola,1,234.50" from "Cola, 1" and "234.50" so it is
 * flagged instead of guessed.
 */
function splitRow(line: string): SplitRow {
  if (line.includes("\t")) {
    const cells = line.split("\t");
    return { id: unquote(cells[0] ?? ""), cost: unquote(cells[1] ?? ""), viaTab: true, commaInCost: false };
  }
  const cells = splitCommas(line);
  if (cells.length === 1) return { id: unquote(cells[0] ?? ""), cost: "", viaTab: false, commaInCost: false };
  const cost = unquote(cells[cells.length - 1] ?? "");
  const before = cells.slice(0, -1).map(unquote);
  const prev = before[before.length - 1] ?? "";
  const commaInCost = before.length >= 1 && /^\d{3}(\.\d*)?$/.test(cost) && /^\$?\d{1,3}$/.test(prev) && cells.length >= 3;
  return { id: before.join(", "), cost, viaTab: false, commaInCost };
}

const collapse = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** "9.31E+12": a number a spreadsheet has already rounded. The digits are gone, so it can't be matched. */
const SCIENTIFIC = /^\d(\.\d+)?e[+-]?\d+$/i;

function costFromCell(cell: string, viaTab: boolean): number | null {
  let t = cell.trim();
  // A tab row has the whole cell, so "1,234.50" is unambiguous there.
  if (viaTab && THOUSANDS.test(t)) t = t.replace(/,/g, "");
  return parseCostText(t);
}

function looksLikeHeader(row: SplitRow): boolean {
  if (costFromCell(row.cost, row.viaTab) !== null) return false;
  return HEADER_WORDS.test(row.id) || HEADER_WORDS.test(row.cost);
}

/**
 * Reads pasted rows (identifier, cost) against the products. An identifier is tried as the Square id,
 * then the barcode, then the SKU, then the name (case and extra spaces ignored); the first of those
 * that finds anything decides, and finding more than one product there is a problem, not a pick.
 * Items still in Square win over ones that aren't. Nothing is saved from here.
 */
export function previewPaste<P extends PasteProduct>(text: string, products: readonly P[]): PastePreview<P> {
  const preview: PastePreview<P> = { matched: [], unmatched: [], ambiguous: [], badCost: [], repeated: [], headerSkipped: false };
  const live = products.filter((p) => p.active);
  const lines = text.split(/\r\n|\r|\n/);
  const byProduct = new Map<string, PasteMatch<P>>();
  let seenRow = false;

  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === "") return;
    const row = splitRow(raw);
    const shown = raw.trim().replace(/\t/g, "  ").slice(0, 120);
    if (!seenRow) {
      seenRow = true;
      if (looksLikeHeader(row)) {
        preview.headerSkipped = true;
        return;
      }
    }
    if (row.id === "") {
      preview.unmatched.push({ line, text: shown, reason: "No item on this row." });
      return;
    }
    if (row.commaInCost) {
      preview.badCost.push({ line, text: shown, reason: "A comma inside the cost. Paste with tabs, or leave the comma out." });
      return;
    }
    if (row.cost === "") {
      preview.badCost.push({ line, text: shown, reason: row.viaTab ? "No cost on this row." : "No cost on this row. Put a tab or comma before it." });
      return;
    }
    const cents = costFromCell(row.cost, row.viaTab);
    if (cents === null) {
      preview.badCost.push({ line, text: shown, reason: `"${row.cost.slice(0, 30)}" is not a cost in dollars.` });
      return;
    }
    if (cents > COST_MAX_CENTS) {
      preview.badCost.push({ line, text: shown, reason: OVER_CAP });
      return;
    }

    let found = findProducts(live, row.id);
    if (found.hits.length === 0) found = findProducts(products, row.id);
    if (found.hits.length === 0) {
      preview.unmatched.push({
        line,
        text: shown,
        reason: SCIENTIFIC.test(row.id) ? "The barcode came through as a rounded number. Format the column as text in the sheet." : "Nothing here has this id, barcode, SKU or name.",
      });
      return;
    }
    if (found.hits.length > 1) {
      preview.ambiguous.push({ line, text: shown, reason: `Matches ${found.hits.length} items: ${found.hits.map((p) => p.name).join(", ")}` });
      return;
    }
    const product = found.hits[0]!;
    const earlier = byProduct.get(product.id);
    if (earlier) {
      preview.repeated.push({ line: earlier.line, text: product.name, reason: `Listed again on line ${line}. The last row is used.` });
    }
    byProduct.set(product.id, { line, product, oldCents: product.costCents, newCents: cents, changed: product.costCents !== cents });
  });

  preview.matched = [...byProduct.values()].sort((a, b) => a.line - b.line);
  return preview;
}

function findProducts<P extends PasteProduct>(products: readonly P[], id: string): { hits: P[] } {
  const keys = [id.trim()];
  // A spreadsheet number cell pastes as "9310072001234.0".
  const whole = /^(\d+)\.0+$/.exec(id.trim());
  if (whole?.[1]) keys.push(whole[1]);

  for (const key of keys) {
    const lower = key.toLowerCase();
    const bySquareId = products.filter((p) => p.id.toLowerCase() === lower);
    if (bySquareId.length > 0) return { hits: bySquareId };
  }
  for (const key of keys) {
    const want = normaliseBarcode(key);
    if (want === null) continue;
    const byBarcode = products.filter((p) => p.barcode !== null && normaliseBarcode(p.barcode) === want);
    if (byBarcode.length > 0) return { hits: byBarcode };
  }
  for (const key of keys) {
    const lower = key.toLowerCase();
    const bySku = products.filter((p) => p.sku !== null && p.sku.trim().toLowerCase() === lower);
    if (bySku.length > 0) return { hits: bySku };
  }
  const name = collapse(id);
  return { hits: products.filter((p) => collapse(p.name) === name) };
}

// ---------------------------------------------------------------------------
// Dates (business dates, YYYY-MM-DD, plain calendar arithmetic)
// ---------------------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The most days a report covers, both ends included. The server refuses more. */
export const MAX_RANGE_DAYS = 366;

function toUtcDay(date: string): number | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // Date.UTC rolls 31 Feb into March; a real date reads back the same.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / 86_400_000);
}

function fromUtcDay(day: number): string {
  const d = new Date(day * 86_400_000);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function isDateString(date: string): boolean {
  return toUtcDay(date) !== null;
}

/** `date` moved by whole days (negative = earlier). Throws on text that isn't a real date. */
export function addDays(date: string, days: number): string {
  const d = toUtcDay(date);
  if (d === null) throw new Error(`Not a date: ${date}`);
  return fromUtcDay(d + days);
}

/** Days from `from` to `to`, both included. */
export function daysInRange(from: string, to: string): number {
  const a = toUtcDay(from);
  const b = toUtcDay(to);
  if (a === null || b === null) return 0;
  return b - a + 1;
}

export interface DateRange {
  from: string;
  to: string;
}

export type PresetKey = "today" | "yesterday" | "last7" | "thisMonth" | "lastMonth";

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
  { key: "thisMonth", label: "This month" },
  { key: "lastMonth", label: "Last month" },
];

/** The dates a preset means, worked out from the venue's business date (`today`). */
export function presetRange(key: PresetKey, today: string): DateRange {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "thisMonth":
      return { from: monthStart, to: today };
    case "lastMonth": {
      const lastDay = addDays(monthStart, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
  }
}

/** The preset a range equals, if any. */
export function presetFor(range: DateRange, today: string): PresetKey | null {
  return PRESETS.find((p) => {
    const r = presetRange(p.key, today);
    return r.from === range.from && r.to === range.to;
  })?.key ?? null;
}

export type RangeCheck = { ok: true } | { ok: false; error: string };

export function checkRange(from: string, to: string): RangeCheck {
  if (!isDateString(from) || !isDateString(to)) return { ok: false, error: "Pick both dates." };
  if (from > to) return { ok: false, error: "The first date has to be on or before the last." };
  if (daysInRange(from, to) > MAX_RANGE_DAYS) return { ok: false, error: `Pick at most ${MAX_RANGE_DAYS} days.` };
  return { ok: true };
}

/** "2026-11-23" -> "23 Nov 2026". */
export function formatDateLabel(date: string): string {
  const m = DATE.exec(date);
  if (!m) return date;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${names[Number(m[2]) - 1] ?? ""} ${m[1]}`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * One CSV field. Quoted when it holds a comma, quote or line break (quotes doubled). Text that a
 * spreadsheet would run as a formula (starts with = + - @) gets a leading apostrophe.
 */
export function csvField(value: string | number): string {
  let s = typeof value === "number" ? String(value) : value;
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Cents as dollars with a sign: -250 -> "-2.50". */
export function dollarsField(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function percentField(bps: number | null): string {
  if (bps === null) return "";
  const tenths = Math.round(bps / 10);
  const abs = Math.abs(tenths);
  return `${tenths < 0 ? "-" : ""}${Math.floor(abs / 10)}.${abs % 10}`;
}

export const PROFIT_CSV_HEADER = [
  "Item",
  "Quantity sold",
  "Sales ex GST",
  "Cost",
  "Profit",
  "Margin %",
  "Quantity with no cost",
] as const;

/** The report's lines and a total row. Dollars ex GST. Rows end with CRLF. */
export function buildProfitCsv(report: ProfitReportDTO): string {
  const rows: string[][] = [[...PROFIT_CSV_HEADER]];
  for (const l of report.lines) {
    rows.push([
      l.name,
      String(l.quantity),
      dollarsField(l.salesExGstCents),
      dollarsField(l.costCents),
      dollarsField(l.profitCents),
      percentField(l.marginBps),
      String(l.uncostedQuantity),
    ]);
  }
  const t = report.items;
  rows.push([
    "Total",
    String(t.quantity),
    dollarsField(t.salesExGstCents),
    dollarsField(t.costCents),
    dollarsField(t.profitCents),
    percentField(t.marginBps),
    String(t.uncostedQuantity),
  ]);
  // Only the name can need quoting. The rest are numbers, and "-2.50" must not be mistaken for a formula.
  return rows.map(([name, ...rest]) => [csvField(name ?? ""), ...rest].join(",")).join("\r\n") + "\r\n";
}

export function profitCsvFilename(report: Pick<ProfitReportDTO, "from" | "to">): string {
  return report.from === report.to ? `profit-${report.from}.csv` : `profit-${report.from}-to-${report.to}.csv`;
}
