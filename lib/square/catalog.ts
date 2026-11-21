import "server-only";
import type { Square } from "square";
import { square, toUpstreamError } from "./client";

/** Reads every ITEM, CATEGORY, DISCOUNT, TAX and IMAGE object in the catalogue (all pages). Variations come nested in their item. */
export async function listCatalogObjects(): Promise<Square.CatalogObject[]> {
  try {
    const out: Square.CatalogObject[] = [];
    const page = await square().catalog.list({ types: "ITEM,CATEGORY,DISCOUNT,TAX,IMAGE" });
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
  /**
   * What a scanner reads off the pack, digits only: the variation's GTIN (Square's `upc`), else its
   * SKU when that is a barcode. Square's GTIN field takes 12 to 14 digits, so a short code (an
   * 8-digit EAN-8) can only be kept in the SKU. Null if neither is a barcode.
   */
  barcode: string | null;
  sku: string | null;
  /** Square tracks stock for this variation at our location. */
  tracked: boolean;
  /** The variation's own picture in Square, else the item's first one. Null if it has none. */
  imageUrl: string | null;
  sortOrder: number;
}

/** A row for `discounts`: one discount staff can put on a bill at our location. */
export interface CatalogDiscount {
  /** Square catalogue discount id. */
  id: string;
  name: string;
  /** percent / amount are fixed in Square; the variable kinds have their value typed in when applied. */
  kind: "percent" | "amount" | "variable_percent" | "variable_amount";
  /** Basis points (1250 = 12.5%) or cents; null for the variable kinds. */
  value: number | null;
}

export interface CatalogMapping {
  products: CatalogProduct[];
  /** The variable-price variation of the "Table hire" item, if the catalogue has one. */
  tableHireVariationId: string | null;
  /** By name. Empty when the catalogue has none. */
  discounts: CatalogDiscount[];
  /**
   * Set when something sold here has a tax that Square adds on top of the price. The app's prices
   * include GST, so such an item makes Square's total differ from the bill and an itemised charge
   * is refused. Null when every tax is included in the price.
   */
  taxWarning: string | null;
}

const NAME_MAX = 120; // products.name / session_items.name check constraint
const PRICE_MAX = 1_000_000; // products.price_cents check constraint
const DISCOUNT_NAME_MAX = 60; // discounts.name / sessions.discount_name check constraint
const DISCOUNT_AMOUNT_MAX = 1_000_000; // $10,000: more than any bill here; keeps the integer column safe
const SKU_MAX = 120; // products.sku check constraint
const IMAGE_URL_MAX = 500; // products.image_url check constraint

/**
 * Where Square keeps catalogue pictures. next.config.ts allows the same hosts for image resizing;
 * a URL from anywhere else is left out rather than shown as a broken picture.
 */
const IMAGE_URL_RE = /^https:\/\/items-images-(?:production|sandbox)\.s3\.us-west-2\.amazonaws\.com\/[\w\-./]+$/;

/** An IMAGE object's URL if it is one the app can show, else null. */
export function toImageUrl(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  return u.length <= IMAGE_URL_MAX && IMAGE_URL_RE.test(u) ? u : null;
}

/**
 * Square's `upc` as a barcode staff can scan: spaces and hyphens dropped, 6 to 14 digits (the
 * products.barcode check constraint). Anything else (letters, a too-long value set through the
 * API) is not a barcode and is left out rather than failing the refresh.
 */
export function toBarcode(upc: string | null | undefined): string | null {
  const digits = (upc ?? "").replace(/[\s-]/g, "");
  return /^\d{6,14}$/.test(digits) ? digits : null;
}

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
  barcode: string | null;
  sku: string | null;
  tracked: boolean;
  imageIds: readonly string[];
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
      barcode: toBarcode(d.upc) ?? toBarcode(d.sku),
      sku: (d.sku ?? "").trim().slice(0, SKU_MAX).trim() || null,
      // The location's own setting wins; unset at both levels means stock isn't tracked.
      tracked: (override?.trackInventory ?? d.trackInventory) === true,
      imageIds: d.imageIds ?? [],
    });
  }
  return out;
}

const byText = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Square's percentage string ("10", "12.5", "7.25") as basis points, or null if it isn't a plain
 * decimal, is finer than a hundredth of a percent, or is outside 0–100%. Worked out on the digits,
 * not with floating point: "12.5" must be exactly 1250.
 */
export function percentageToBasisPoints(percentage: string | null | undefined): number | null {
  const m = /^(\d{1,3})(?:\.(\d+))?$/.exec((percentage ?? "").trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  // Anything past two decimal places must be zeros ("12.500" is fine, "33.333" is not).
  if (!/^0*$/.test(frac.slice(2))) return null;
  const bp = Number(m[1]) * 100 + Number(frac.slice(0, 2).padEnd(2, "0"));
  return bp >= 1 && bp <= 10_000 ? bp : null;
}

/**
 * One DISCOUNT object as a row for `discounts`, or null if staff can't use it here: deleted, not
 * at this location, unnamed, PIN-protected in Square (the app can't ask for a Square PIN), capped
 * at a maximum amount (the app has no way to apply the cap), not in AUD, or with a value that
 * can't be read. Never throws: one odd discount must not stop the item list refreshing.
 */
function mapDiscount(o: Square.CatalogObject, locationId: string): CatalogDiscount | null {
  try {
    if (o.type !== "DISCOUNT" || !o.id || o.isDeleted || !presentAt(o, locationId)) return null;
    const d = o.discountData;
    if (!d || d.pinRequired === true) return null;
    const name = (d.name ?? "").trim().slice(0, DISCOUNT_NAME_MAX).trim();
    if (!name) return null;

    switch (d.discountType) {
      case "FIXED_PERCENTAGE": {
        if (d.maximumAmountMoney?.amount != null) return null;
        const value = percentageToBasisPoints(d.percentage);
        return value === null ? null : { id: o.id, name, kind: "percent", value };
      }
      case "FIXED_AMOUNT": {
        const money = d.amountMoney;
        if (money?.amount == null || money.currency !== "AUD") return null;
        // Amounts come back as bigint; convert before anything tries to JSON.stringify them.
        const value = Number(money.amount);
        if (!Number.isInteger(value) || value < 1 || value > DISCOUNT_AMOUNT_MAX) return null;
        return { id: o.id, name, kind: "amount", value };
      }
      case "VARIABLE_PERCENTAGE":
        return d.maximumAmountMoney?.amount != null ? null : { id: o.id, name, kind: "variable_percent", value: null };
      case "VARIABLE_AMOUNT":
        return { id: o.id, name, kind: "variable_amount", value: null };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const TAX_WARNING_MAX = 300;

/** One staff-readable sentence naming the first few items whose tax is added on top of the price. */
function taxWarningFor(addedOnTop: readonly { item: string; tax: string }[]): string | null {
  if (addedOnTop.length === 0) return null;
  const sorted = [...addedOnTop].sort((a, b) => byText(a.item, b.item));
  const shown = sorted.slice(0, 3).map((x) => x.item.slice(0, 40));
  const more = sorted.length - shown.length;
  const which = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
  const n = sorted.length;
  return `${n} item${n === 1 ? " has" : "s have"} ${sorted[0].tax} added on top of the price in Square: ${which}. Prices here include GST, so a bill with one of these on it can't be charged item by item. In Square, set the tax to be included in the item price, then refresh.`.slice(
    0,
    TAX_WARNING_MAX,
  );
}

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

  const imageUrls = new Map<string, string>();
  for (const o of objects) {
    if (o.type !== "IMAGE" || !o.id || o.isDeleted) continue;
    const url = toImageUrl(o.imageData?.url);
    if (url) imageUrls.set(o.id, url);
  }
  // The first picture that still exists: Square POS shows the first one on an item too.
  const firstImage = (ids: readonly string[] | null | undefined): string | null => {
    for (const id of ids ?? []) {
      const url = imageUrls.get(id);
      if (url) return url;
    }
    return null;
  };

  // Taxes that are added on top of the price here. GST in Australia is set up as included in the
  // price; one of these on an item means Square would charge more than the bill says.
  const additiveTaxes = new Map<string, string>();
  for (const o of objects) {
    if (o.type !== "TAX" || !o.id || o.isDeleted || !presentAt(o, locationId)) continue;
    const t = o.taxData;
    if (!t || t.enabled === false || t.inclusionType !== "ADDITIVE") continue;
    additiveTaxes.set(o.id, (t.name ?? "").trim() || "a tax");
  }
  const addedOnTop: { item: string; tax: string }[] = [];

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
    // An item can sit in several categories (a menu such as "Pool Hall" as well as "Drinks"). The
    // reporting category is the one Square files its sales under, so that is the one staff see.
    const reportingId = item.reportingCategory?.id;
    const categoryId =
      (reportingId && categoryNames.has(reportingId) ? reportingId : null) ??
      item.categories?.find((c) => c.id && categoryNames.has(c.id))?.id ??
      item.categoryId ??
      null;
    const category = categoryId ? categoryNames.get(categoryId) ?? null : null;
    const taxed = (item.taxIds?.length ?? 0) > 0;

    // Only items the app charges for: something on the list, or the table hire item itself.
    const additive = item.taxIds?.find((id) => additiveTaxes.has(id));
    if (additive && (sellable.length > 0 || itemName.toLowerCase() === "table hire")) {
      addedOnTop.push({ item: itemName, tax: additiveTaxes.get(additive) ?? "a tax" });
    }

    for (const v of sellable) {
      const name = sellable.length > 1 && v.name ? `${itemName} – ${v.name}` : itemName;
      found.push({
        id: v.id,
        itemId: o.id,
        name: name.slice(0, NAME_MAX).trim(),
        priceCents: v.priceCents,
        taxed,
        category,
        barcode: v.barcode,
        sku: v.sku,
        tracked: v.tracked,
        imageUrl: firstImage(v.imageIds) ?? firstImage(item.imageIds),
      });
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

  // Discounts are read after, and apart from, the items: nothing about a discount can change
  // which products were found above.
  const discounts: CatalogDiscount[] = [];
  const seen = new Set<string>();
  for (const o of objects) {
    const d = mapDiscount(o, locationId);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    discounts.push(d);
  }
  discounts.sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id));

  return {
    products: found.map((p, i) => ({ ...p, sortOrder: i })),
    tableHireVariationId,
    discounts,
    taxWarning: taxWarningFor(addedOnTop),
  };
}
