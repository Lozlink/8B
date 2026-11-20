import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Square webhook signature: base64( HMAC-SHA256( key = signature key, msg = notificationUrl + rawBody ) ),
 * sent in `x-square-hmacsha256-signature`. We verify it ourselves with a constant-time compare.
 * (The SDK's WebhooksHelper.verifySignature is async — calling it without `await` accepts
 * everything — and compares with `===`.)
 */
export function verifySquareSignature(args: {
  rawBody: string;
  signatureHeader: string | null;
  signatureKey: string;
  notificationUrl: string;
}): boolean {
  if (!args.signatureHeader || !args.signatureKey || !args.notificationUrl) return false;
  const expected = createHmac("sha256", args.signatureKey)
    .update(args.notificationUrl + args.rawBody, "utf8")
    .digest();
  let given: Buffer;
  try {
    given = Buffer.from(args.signatureHeader, "base64");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Raw wire format is snake_case. Unknown keys are allowed; we only read what we need.

export const webhookEnvelope = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  location_id: z.string().optional(),
  data: z.object({ object: z.record(z.string(), z.unknown()).optional() }).passthrough().optional(),
});

export const terminalCheckoutPayload = z.object({
  checkout: z.object({
    id: z.string().min(1),
    status: z.string(),
    reference_id: z.string().optional().nullable(),
    cancel_reason: z.string().optional().nullable(),
    // Present when the checkout was sent against an itemised order.
    order_id: z.string().optional().nullable(),
    amount_money: z.object({ amount: z.number().int().nonnegative().optional() }).partial().optional().nullable(),
    // The payment(s) a COMPLETED checkout made: one id for a normal sale. Kept so the payment can be
    // refunded or its receipt reprinted. Anything that isn't a list of strings is ignored rather
    // than failing the whole event.
    payment_ids: z.array(z.string().min(1)).optional().nullable().catch(undefined),
    updated_at: z.string().optional(),
  }),
});

export const deviceCodePayload = z.object({
  device_code: z.object({
    id: z.string().min(1),
    status: z.string(),
    device_id: z.string().optional().nullable(),
    location_id: z.string().optional().nullable(),
    product_type: z.string().optional(),
  }),
});

/**
 * `inventory.count.updated`: `data.object.inventory_counts[]`, one entry per state Square counts
 * (in stock, sold, waste…). Only the shape of the list is checked here; each entry is read on its
 * own so one odd entry never costs us the others.
 */
export const inventoryCountsPayload = z.object({ inventory_counts: z.array(z.unknown()) });

const inventoryCount = z.object({
  catalog_object_id: z.string().min(1),
  catalog_object_type: z.string().optional().nullable(),
  location_id: z.string().optional().nullable(),
  quantity: z.union([z.string(), z.number()]).optional().nullable(),
  state: z.string().optional().nullable(),
  calculated_at: z.string().optional().nullable(),
});

export interface WebhookStockCount {
  variationId: string;
  quantity: number;
  calculatedAt: Date | null;
}

/**
 * The shelf counts in an `inventory.count.updated` payload for our location: IN_STOCK entries for
 * an item variation, quantity rounded down to a whole unit. null = the payload isn't the shape we
 * expect (the caller logs it and carries on).
 */
export function stockCountsFromWebhook(object: unknown, locationId: string): WebhookStockCount[] | null {
  const p = inventoryCountsPayload.safeParse(object);
  if (!p.success) return null;
  const out: WebhookStockCount[] = [];
  for (const raw of p.data.inventory_counts) {
    const c = inventoryCount.safeParse(raw);
    if (!c.success) continue;
    const { catalog_object_id, catalog_object_type, location_id, quantity, state, calculated_at } = c.data;
    if (state !== "IN_STOCK" || location_id !== locationId) continue;
    if (catalog_object_type && catalog_object_type !== "ITEM_VARIATION") continue;
    const n = typeof quantity === "number" ? quantity : quantity ? Number(quantity) : NaN;
    // A count too big for the database column is not a real shelf count; one of those must never fail the event.
    if (!Number.isFinite(n) || Math.abs(n) > 2_147_483_647) continue;
    const at = calculated_at ? new Date(calculated_at) : null;
    out.push({
      variationId: catalog_object_id,
      quantity: Math.floor(n),
      calculatedAt: at && !Number.isNaN(at.getTime()) ? at : null,
    });
  }
  return out;
}
