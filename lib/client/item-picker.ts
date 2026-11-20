import type { ProductDTO } from "@/lib/domain/types";
import { normaliseBarcode } from "./barcode";

/** At or below this many left (and above zero) an item is shown as running low. */
export const LOW_STOCK_THRESHOLD = 5;

export type StockTone = "low" | "out";

export interface StockLabel {
  text: string;
  tone: StockTone;
}

/** null = nothing worth flagging: not tracked, not counted, or comfortably in stock. */
export function stockTone(stock: number | null): StockTone | null {
  if (stock === null) return null;
  if (stock <= 0) return "out";
  return stock <= LOW_STOCK_THRESHOLD ? "low" : null;
}

export function stockLabel(stock: number | null): StockLabel | null {
  const tone = stockTone(stock);
  if (tone === null || stock === null) return null;
  return tone === "out" ? { text: "Out of stock", tone } : { text: `${stock} left`, tone };
}

export const ALL_CATEGORY = "__all__";
export const OTHER_CATEGORY = "__other__";

export interface CategoryOption {
  key: string;
  label: string;
  count: number;
}

type Pickable = Pick<ProductDTO, "name" | "category" | "barcode">;

export function categoryKey(p: Pick<ProductDTO, "category">): string {
  const c = p.category?.trim();
  return c ? c : OTHER_CATEGORY;
}

/**
 * "All" first, then each category in the order it first appears, then "Other" (no category) last.
 * Only "All" is returned when nothing has a category name worth a chip of its own.
 */
export function categoryOptions(products: readonly Pick<ProductDTO, "category">[]): CategoryOption[] {
  const counts = new Map<string, number>();
  for (const p of products) {
    const k = categoryKey(p);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const named = [...counts.keys()].filter((k) => k !== OTHER_CATEGORY);
  const out: CategoryOption[] = [{ key: ALL_CATEGORY, label: "All", count: products.length }];
  for (const k of named) out.push({ key: k, label: k, count: counts.get(k) ?? 0 });
  const other = counts.get(OTHER_CATEGORY);
  if (other) out.push({ key: OTHER_CATEGORY, label: "Other", count: other });
  return out;
}

/** True when the text is a whole barcode (6 to 14 digits), not part of a name. */
export function isBarcodeQuery(query: string): boolean {
  return normaliseBarcode(query) !== null;
}

/**
 * Narrows by category, then by text: every whitespace-separated term must appear somewhere in the name
 * (any case). A query that is a whole barcode also matches the item with that barcode.
 */
export function filterProducts<T extends Pickable>(products: readonly T[], category: string, query: string): T[] {
  const byCategory = category === ALL_CATEGORY ? products : products.filter((p) => categoryKey(p) === category);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return byCategory.slice();
  const code = normaliseBarcode(query);
  return byCategory.filter((p) => {
    const name = p.name.toLowerCase();
    if (terms.every((t) => name.includes(t))) return true;
    return code !== null && p.barcode !== null && normaliseBarcode(p.barcode) === code;
  });
}

/** One block of the item grid: a heading (a brand, or a category) and the buttons under it. */
export interface ItemSection<T> {
  key: string;
  /** null = no heading (there is only one block, so a heading would say nothing). */
  heading: string | null;
  items: { product: T; /** What the button says: the name without the heading it sits under. */ label: string }[];
}

const words = (name: string) => name.trim().split(/\s+/).filter(Boolean);

/** The leading words every name shares, e.g. "Grain Waves" for Grain Waves Sea Salt / Sweet Chilli. */
function sharedLead(names: readonly string[]): string[] {
  const [first, ...rest] = names.map(words);
  let n = first.length;
  for (const w of rest) {
    let i = 0;
    while (i < n && i < w.length && w[i].toLowerCase() === first[i].toLowerCase()) i++;
    n = i;
  }
  return first.slice(0, n);
}

/** Shown over the items that share a brand with nothing else in the list. */
export const SINGLES_HEADING = "More";

/**
 * Groups a list by brand, taken from the names: items whose names start with the same word belong
 * together ("Oreo Original", "Oreo Dunked"), under the words they all share, and each button then
 * only needs to say the rest ("Original", "Dunked"). Items that share a first word with nothing
 * else come last under "More". Order within the list is kept.
 *
 * Square has no brand field, so this is read off the names. A name that doesn't lead with its
 * brand simply ends up under "More" with its full name.
 */
export function brandSections<T extends Pick<ProductDTO, "name">>(products: readonly T[]): ItemSection<T>[] {
  const byLead = new Map<string, T[]>();
  for (const p of products) {
    const lead = (words(p.name)[0] ?? "").toLowerCase();
    const group = byLead.get(lead);
    if (group) group.push(p);
    else byLead.set(lead, [p]);
  }
  const brands: ItemSection<T>[] = [];
  const singles: ItemSection<T>["items"] = [];
  for (const [lead, group] of byLead) {
    if (group.length < 2 || lead === "") {
      for (const p of group) singles.push({ product: p, label: p.name });
      continue;
    }
    const shared = sharedLead(group.map((p) => p.name));
    const heading = shared.join(" ");
    brands.push({
      key: `brand:${lead}`,
      heading,
      // An item that is nothing but the brand ("Pepsi" beside "Pepsi Max") keeps its name.
      items: group.map((p) => ({ product: p, label: words(p.name).slice(shared.length).join(" ") || p.name })),
    });
  }
  if (brands.length === 0) return singles.length ? [{ key: "all", heading: null, items: singles }] : [];
  if (singles.length) brands.push({ key: "singles", heading: SINGLES_HEADING, items: singles });
  return brands;
}

/**
 * How the grid is laid out for what is being shown:
 *   - while searching: one flat list of full names (the matches can come from anywhere);
 *   - "All": a block per category, full names;
 *   - one category: a block per brand.
 */
export function itemSections<T extends Pick<ProductDTO, "name" | "category">>(
  shown: readonly T[],
  category: string,
  query: string,
): ItemSection<T>[] {
  if (shown.length === 0) return [];
  const flat = (key: string, heading: string | null, list: readonly T[]): ItemSection<T> => ({
    key,
    heading,
    items: list.map((p) => ({ product: p, label: p.name })),
  });
  if (query.trim() !== "") return [flat("results", null, shown)];
  if (category !== ALL_CATEGORY) return brandSections(shown);
  const byCategory = new Map<string, T[]>();
  for (const p of shown) {
    const k = categoryKey(p);
    const group = byCategory.get(k);
    if (group) group.push(p);
    else byCategory.set(k, [p]);
  }
  if (byCategory.size === 1) return [flat("all", null, shown)];
  const keys = [...byCategory.keys()].filter((k) => k !== OTHER_CATEGORY);
  if (byCategory.has(OTHER_CATEGORY)) keys.push(OTHER_CATEGORY);
  return keys.map((k) => flat(`category:${k}`, k === OTHER_CATEGORY ? "Other" : k, byCategory.get(k) ?? []));
}
