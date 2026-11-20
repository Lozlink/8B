import type { ProductDTO } from "@/lib/domain/types";

const MIN_DIGITS = 6;
const MAX_DIGITS = 14;

/**
 * The digits of a scanned or typed code with spaces and hyphens dropped, or null if it isn't 6 to 14
 * digits. Padding is kept, so this is what to show back to staff.
 */
export function cleanBarcode(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, "");
  return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS && /^\d+$/.test(digits) ? digits : null;
}

/**
 * A key for comparing barcodes. A UPC-A (12 digits), EAN-13 and GTIN-14 for the same product differ only
 * in leading zeros, and scanners and Square pad differently, so the zeros are stripped.
 *
 * Returns null for anything that isn't 6 to 14 digits (before stripping) and for all-zero codes, which
 * identify nothing and must never match an item.
 */
export function normaliseBarcode(raw: string): string | null {
  const digits = cleanBarcode(raw);
  if (!digits) return null;
  const stripped = digits.replace(/^0+/, "");
  return stripped === "" ? null : stripped;
}

/** Every product whose barcode is the same code once padding is ignored. Square allows duplicates. */
export function findByBarcode<T extends Pick<ProductDTO, "barcode">>(products: readonly T[], raw: string): T[] {
  const key = normaliseBarcode(raw);
  if (!key) return [];
  return products.filter((p) => p.barcode !== null && normaliseBarcode(p.barcode) === key);
}
