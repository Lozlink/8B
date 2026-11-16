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
    amount_money: z.object({ amount: z.number().int().nonnegative().optional() }).partial().optional().nullable(),
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
