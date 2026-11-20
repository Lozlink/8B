import "server-only";
import { square, toUpstreamError } from "./client";

export interface StockCount {
  /** Square item variation id (our `products.id`). */
  variationId: string;
  /** Square's IN_STOCK count, rounded down to a whole unit. Can be negative. */
  quantity: number;
  /** When Square worked the count out. null = Square didn't say. */
  calculatedAt: Date | null;
}

/** The largest count the database column holds. */
export const MAX_COUNT = 2_147_483_647;

/** Square answers at most this many ids per request. */
const CHUNK = 100;

/** A quantity from Square is a decimal string ("3", "2.50000"). Whole units only: a part-unit doesn't sell. */
export function wholeUnits(quantity: string | number | null | undefined): number | null {
  if (quantity === null || quantity === undefined || (typeof quantity === "string" && quantity.trim() === "")) return null;
  const n = typeof quantity === "number" ? quantity : Number(quantity);
  // Past this the number can't be stored as a whole count (and isn't a real shelf count).
  return Number.isFinite(n) && Math.abs(n) <= MAX_COUNT ? Math.floor(n) : null;
}

/**
 * Reads the IN_STOCK count of each variation at one location. A variation Square has never counted
 * simply has no entry in the answer.
 */
export async function getStockCounts(input: { locationId: string; variationIds: string[] }): Promise<StockCount[]> {
  const what = "read stock levels";
  const out: StockCount[] = [];
  try {
    for (let i = 0; i < input.variationIds.length; i += CHUNK) {
      const page = await square().inventory.batchGetCounts({
        catalogObjectIds: input.variationIds.slice(i, i + CHUNK),
        locationIds: [input.locationId],
        // Square returns a count for every state (sold, waste, in transit…). Only this one is on the shelf.
        states: ["IN_STOCK"],
      });
      for await (const c of page) {
        // The request already says all of this; a count that says otherwise is not one we asked for.
        if (!c.catalogObjectId || c.state !== "IN_STOCK" || (c.locationId && c.locationId !== input.locationId)) continue;
        const quantity = wholeUnits(c.quantity);
        if (quantity === null) continue;
        const at = c.calculatedAt ? new Date(c.calculatedAt) : null;
        out.push({ variationId: c.catalogObjectId, quantity, calculatedAt: at && !Number.isNaN(at.getTime()) ? at : null });
      }
    }
    return out;
  } catch (e) {
    throw toUpstreamError(e, what, "Try again in a moment.");
  }
}

export interface ChangeStockInput {
  /** `${sessionId}-st${seq}`. Stable across retries of the same move. */
  idempotencyKey: string;
  locationId: string;
  /** sale: the items left stock (IN_STOCK → SOLD). restock: they came back (UNLINKED_RETURN → IN_STOCK). */
  kind: "sale" | "restock";
  lines: { variationId: string; quantity: number }[];
  /** Square refuses a time more than 24 h old or in the future. */
  occurredAt: Date;
}

/**
 * Tells Square about a sale it didn't see, or puts a reopened bill's items back, as one batch of
 * inventory adjustments. Square holds the whole batch or none of it.
 *
 * The SDK's adjustment has `from_location_id` / `to_location_id` (no single location): both are
 * our location, as nothing here moves stock between locations.
 */
export async function changeStock(input: ChangeStockInput): Promise<void> {
  const what = input.kind === "sale" ? "take the sold items off stock" : "put the items back in stock";
  const [from, to] = input.kind === "sale" ? (["IN_STOCK", "SOLD"] as const) : (["UNLINKED_RETURN", "IN_STOCK"] as const);
  try {
    await square().inventory.batchCreateChanges(
      {
        idempotencyKey: input.idempotencyKey,
        changes: input.lines.map((l) => ({
          type: "ADJUSTMENT" as const,
          adjustment: {
            catalogObjectId: l.variationId,
            fromState: from,
            toState: to,
            fromLocationId: input.locationId,
            toLocationId: input.locationId,
            quantity: String(l.quantity),
            occurredAt: input.occurredAt.toISOString(),
          },
        })),
        // A line Square already shows as the right number is not an error.
        ignoreUnchangedCounts: true,
      },
      // Sent from a background pass with no lock held; a timeout leaves the move pending and the
      // next try reuses the key.
      { timeoutInSeconds: 8, maxRetries: 0 },
    );
  } catch (e) {
    throw toUpstreamError(e, what, "It will be tried again.");
  }
}
