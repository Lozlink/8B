import { withTx } from "@/lib/server/db";
import { webhookEnv } from "@/lib/server/env";
import { applyDevicePaired } from "@/lib/server/admin";
import { applyWebhookCheckout } from "@/lib/server/sessions";
import { applyWebhookCounts } from "@/lib/server/stock";
import { deviceCodePayload, stockCountsFromWebhook, terminalCheckoutPayload, verifySquareSignature, webhookEnvelope } from "@/lib/square/webhook";

// Runs on the Node.js runtime (the default; `runtime` config isn't allowed with cacheComponents).
// Signature checking needs node:crypto, so never move this to the edge.
export const maxDuration = 30;

/**
 * Square webhook. Order of operations:
 *   1. Verify the HMAC over (notification URL + raw body). Bad signature → 401, nothing stored.
 *   2. In ONE transaction: record event_id (dedupe) and apply it. If applying fails the event row
 *      rolls back too and we return 500, so Square retries — no event is ever "seen but lost".
 *   3. Respond 200. The whole thing is a handful of queries, well inside Square's 10 s window.
 */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  const w = webhookEnv();
  // Not configured → 503, so Square keeps retrying (up to 24 h) instead of us dropping events.
  if (!w) return new Response("webhook not configured", { status: 503 });
  const signed = verifySquareSignature({
    rawBody: raw,
    signatureHeader: req.headers.get("x-square-hmacsha256-signature"),
    signatureKey: w.SQUARE_WEBHOOK_SIGNATURE_KEY,
    notificationUrl: w.SQUARE_WEBHOOK_URL,
  });
  if (!signed) return new Response("invalid signature", { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const env_ = webhookEnvelope.safeParse(json);
  if (!env_.success) return new Response("unexpected payload", { status: 400 });
  const event = env_.data;

  try {
    await withTx(async (tx) => {
      const [fresh] = await tx<{ event_id: string }[]>`
        insert into public.webhook_events (event_id, type) values (${event.event_id}, ${event.type})
        on conflict (event_id) do nothing
        returning event_id`;
      if (!fresh) return; // duplicate delivery

      const object = event.data?.object;
      if (event.type === "terminal.checkout.updated") {
        const p = terminalCheckoutPayload.safeParse(object);
        if (!p.success) {
          console.warn("[square] terminal.checkout.updated with unexpected shape", event.event_id);
          return;
        }
        const c = p.data.checkout;
        await applyWebhookCheckout(tx, {
          id: c.id,
          status: c.status,
          referenceId: c.reference_id ?? null,
          cancelReason: c.cancel_reason ?? null,
          amountCents: c.amount_money?.amount ?? null,
          orderId: c.order_id ?? null,
          paymentIds: c.payment_ids ?? null,
        });
      } else if (event.type === "device.code.paired") {
        const p = deviceCodePayload.safeParse(object);
        if (!p.success) return;
        const d = p.data.device_code;
        await applyDevicePaired(tx, {
          id: d.id,
          status: d.status,
          deviceId: d.device_id ?? null,
          locationId: d.location_id ?? event.location_id ?? null,
          productType: d.product_type,
        });
      } else if (event.type === "inventory.count.updated") {
        // Optional: stock is also read on a timer. Read from the environment directly, because
        // `squareEnv()` throws when Square isn't set up and this event must never 500 for that.
        const locationId = process.env.SQUARE_LOCATION_ID;
        const counts = locationId ? stockCountsFromWebhook(object, locationId) : [];
        if (!counts) {
          console.warn("[square] inventory.count.updated with unexpected shape", event.event_id);
          return;
        }
        await applyWebhookCounts(tx, counts);
      }
      // Other event types are recorded (deduped) and otherwise ignored.
    });
  } catch (err) {
    console.error("[square] webhook processing failed; Square will retry", event.event_id, err);
    return new Response("processing failed", { status: 500 });
  }
  return new Response(null, { status: 200 });
}
