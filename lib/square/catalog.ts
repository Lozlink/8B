import "server-only";
import type { Square } from "square";
import { square, toUpstreamError } from "./client";

/** Reads every ITEM and CATEGORY object in the catalogue (all pages). Variations come nested in their item. */
export async function listCatalogObjects(): Promise<Square.CatalogObject[]> {
  try {
    const out: Square.CatalogObject[] = [];
    const page = await square().catalog.list({ types: "ITEM,CATEGORY" });
    for await (const obj of page) out.push(obj);
    return out;
  } catch (e) {
    throw toUpstreamError(e, "read the item list");
  }
}

/** A row for `products`: one fixed-price item variation sold at our location. */
export interface CatalogProduct {
  /** Square item variation id. */
  id: string;
  itemId: string;
  name: string;
  priceCents: number;
  taxed: boolean;
  category: string | null;
  sortOrder: number;
}

export interface CatalogMapping {
  products: CatalogProduct[];
  /** The variable-price variation of the "Table hire" item, if the catalogue has one. */
  tableHireVariationId: string | null;
}

const NAME_MAX = 120; // products.name / session_items.name check constraint
const PRICE_MAX = 1_000_000; // products.price_cents check constraint

interface Presence {
  presentAtAllLocations?: boolean;
  presentAtLocationIds?: string[];
  absentAtLocationIds?: string[];
}

function presentAt(o: Presence, locationId: string): boolean {
  if (o.presentAtLocationIds?.includes(locationId)) return true;
  return o.presentAtAllLocations === true && !o.absentAtLocationIds?.includes(locationId);
}

interface Variation {
  id: string;
  name: string;
  pricingType: string | undefined;
  priceCents: number | null;
  currency: string | undefined;
}

/** The item's variations that can be sold at this location, with any per-location price applied. */
function variationsAt(item: Square.CatalogObject.Item, locationId: string): Variation[] {
  const out: Variation[] = [];
  for (const v of item.itemData?.variations ?? []) {
    if (v.type !== "ITEM_VARIATION" || v.isDeleted || !presentAt(v, locationId)) continue;
    const d = v.itemVariationData;
    if (!d || d.sellable === false) continue;
    // A location can override the price (and whether it's fixed) for a variation.
    const override = d.locationOverrides?.find((o) => o.locationId === locationId);
    const money = override?.priceMoney ?? d.priceMoney;
    out.push({
      id: v.id,
      name: (d.name ?? "").trim(),
      pricingType: override?.pricingType ?? d.pricingType,
      // Amounts come back as bigint; convert before anything tries to JSON.stringify them.
      priceCents: money?.amount != null ? Number(money.amount) : null,
      currency: money?.currency,
    });
  }
  return out;
}

const byText = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Turns the catalogue into the list staff can sell from. Pure: no I/O.
 *
 * A product is one item variation where the item isn't archived or an appointments service, the
 * item and the variation are both present at the location, and the price is fixed and in AUD.
 * Variable-price variations can't go on a bill (there's no price to copy); the one on the
 * "Table hire" item is what table time is reported against.
 */
export function mapCatalog(objects: readonly Square.CatalogObject[], locationId: string): CatalogMapping {
  const categoryNames = new Map<string, string>();
  for (const o of objects) {
    if (o.type !== "CATEGORY" || !o.id) continue;
    const name = o.categoryData?.name?.trim();
    if (name) categoryNames.set(o.id, name);
  }

  const found: Omit<CatalogProduct, "sortOrder">[] = [];
  let tableHireVariationId: string | null = null;

  for (const o of objects) {
    if (o.type !== "ITEM" || o.isDeleted) continue;
    const item = o.itemData;
    if (!item || item.isArchived || item.productType === "APPOINTMENTS_SERVICE") continue;
    if (!presentAt(o, locationId)) continue;
    const itemName = (item.name ?? "").trim();
    if (!itemName) continue;

    const variations = variationsAt(o, locationId);

    if (!tableHireVariationId && itemName.toLowerCase() === "table hire") {
      tableHireVariationId = variations.find((v) => v.pricingType === "VARIABLE_PRICING")?.id ?? null;
    }

    const sellable = variations.filter(
      (v): v is Variation & { priceCents: number } =>
        v.pricingType === "FIXED_PRICING" &&
        v.currency === "AUD" &&
        v.priceCents !== null &&
        Number.isInteger(v.priceCents) &&
        v.priceCents >= 0 &&
        v.priceCents <= PRICE_MAX,
    );
    const categoryId = item.categories?.find((c) => c.id && categoryNames.has(c.id))?.id ?? item.categoryId ?? null;
    const category = categoryId ? categoryNames.get(categoryId) ?? null : null;
    const taxed = (item.taxIds?.length ?? 0) > 0;

    for (const v of sellable) {
      const name = sellable.length > 1 && v.name ? `${itemName} – ${v.name}` : itemName;
      found.push({ id: v.id, itemId: o.id, name: name.slice(0, NAME_MAX).trim(), priceCents: v.priceCents, taxed, category });
    }
  }

  // Display order: by category (uncategorised last), then name. The id breaks ties so the order
  // is the same on every sync and unchanged rows aren't rewritten.
  found.sort((a, b) => {
    if (a.category !== b.category) {
      if (a.category === null) return 1;
      if (b.category === null) return -1;
      return byText(a.category, b.category);
    }
    return byText(a.name, b.name) || byText(a.id, b.id);
  });

  return { products: found.map((p, i) => ({ ...p, sortOrder: i })), tableHireVariationId };
}
