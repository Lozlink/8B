import "server-only";
import { upstream } from "@/lib/server/errors";
import { square, toUpstreamError } from "./client";

export interface OrderLineInput {
  /** "table" for table time, otherwise the session_items id. ≤ 60 chars. */
  uid: string;
  /** Square item variation id. Null = an ad hoc line, which then needs `name`. */
  catalogObjectId: string | null;
  name: string | null;
  quantity: number;
  /** GST-inclusive price for one unit, as stored on the bill. */
  basePriceCents: number;
  note: string | null;
}

/**
 * A discount off the whole order. Always an amount the app worked out itself (never a percentage,
 * never a catalogue discount id): Square takes exactly this much off, and the app's total and
 * Square's can't drift apart on rounding.
 */
export interface OrderDiscountInput {
  /** ≤ 60 chars. */
  uid: string;
  /** Shown on the receipt and in Square's reports. */
  name: string;
  amountCents: number;
}

export interface CreateOrderInput {
  /** `${sessionId}-o${attempt}` — ≤ 64 chars; stable until the attempt is committed. */
  idempotencyKey: string;
  locationId: string;
  /** Session id (≤ 40 chars). */
  referenceId: string;
  lines: OrderLineInput[];
  /** Left out or null = no discount. */
  discount?: OrderDiscountInput | null;
}

const ORDER_TIMEOUT_SECONDS = 6;

export interface SquareOrderState {
  id: string;
  /** What Square will charge for the order, taxes included. */
  totalCents: number;
}

/**
 * Creates the open order a Terminal checkout is itemised against. The order stays invisible in
 * Square (no fulfilment, no payment) until the checkout pays it.
 *
 * `auto_apply_taxes` makes Square attach the catalogue's taxes to each line. GST is inclusive, so
 * the order total is the sum of the lines; the caller still checks that before charging.
 */
export async function createOrder(input: CreateOrderInput): Promise<SquareOrderState> {
  const what = "itemise the bill";
  try {
    const res = await square().orders.create(
      {
        idempotencyKey: input.idempotencyKey,
        order: {
          locationId: input.locationId,
          referenceId: input.referenceId,
          pricingOptions: { autoApplyTaxes: true },
          lineItems: input.lines.map((l) => ({
            uid: l.uid,
            ...(l.catalogObjectId ? { catalogObjectId: l.catalogObjectId } : { name: (l.name ?? "Item").slice(0, 512) }),
            quantity: String(l.quantity),
            basePriceMoney: { amount: BigInt(l.basePriceCents), currency: "AUD" as const },
            ...(l.note ? { note: l.note.slice(0, 2000) } : {}),
          })),
          // Only present when there is a discount, so an order without one is byte for byte the
          // request it has always been (a retry under an old key must carry the same body).
          ...(input.discount && input.discount.amountCents > 0
            ? {
                discounts: [
                  {
                    uid: input.discount.uid,
                    name: (input.discount.name.trim() || "Discount").slice(0, 255),
                    // Checked on the sandbox with and without `type`: same answer either way
                    // (total = lines − amount). Sent explicitly, as Square's reference asks.
                    type: "FIXED_AMOUNT" as const,
                    amountMoney: { amount: BigInt(input.discount.amountCents), currency: "AUD" as const },
                    scope: "ORDER" as const,
                  },
                ],
              }
            : {}),
        },
      },
      // The order is only the first of up to three Square calls made under the bill's lock (cancel,
      // order, checkout), so it gets a short timeout and no SDK retry. A timeout here fails the
      // charge; trying again reuses the same key and gets the same order back.
      { timeoutInSeconds: ORDER_TIMEOUT_SECONDS, maxRetries: 0 },
    );
    const order = res.order;
    if (!order?.id || order.totalMoney?.amount == null) {
      throw upstream(`Square returned an unexpected response while trying to ${what}.`);
    }
    // Amounts come back as bigint; convert before anything tries to JSON.stringify them.
    return { id: order.id, totalCents: Number(order.totalMoney.amount) };
  } catch (e) {
    throw toUpstreamError(e, what);
  }
}

export interface SquareOrderTender {
  type: string;
  /** The Payments API id of this tender. */
  paymentId: string | null;
  amountCents: number | null;
}

export interface SquareOrderDetail {
  id: string;
  locationId: string;
  tenders: SquareOrderTender[];
}

/** Reads an order and how it was paid. Used to find the cash payment behind a Square POS sale. */
export async function getOrder(orderId: string): Promise<SquareOrderDetail> {
  const what = "look up the cash sale";
  try {
    const res = await square().orders.get({ orderId }, { timeoutInSeconds: 8, maxRetries: 0 });
    const order = res.order;
    if (!order?.id) throw upstream(`Square returned an unexpected response while trying to ${what}.`);
    return {
      id: order.id,
      locationId: order.locationId,
      tenders: (order.tenders ?? []).map((t) => ({
        type: t.type,
        // For Payments-era sales the tender id is the payment id; `payment_id` says so explicitly.
        paymentId: t.paymentId ?? t.id ?? null,
        amountCents: t.amountMoney?.amount != null ? Number(t.amountMoney.amount) : null,
      })),
    };
  } catch (e) {
    throw toUpstreamError(e, what, "Try again in a moment.");
  }
}

export interface SquareOrderItems {
  state: string | null;
  /** Lines tied to a catalogue item, quantity as a whole number. Ad hoc lines are left out. */
  items: { catalogObjectId: string; quantity: number }[];
}

/**
 * Reads what a paid order actually carried, so stock is judged on what Square holds and not on
 * what the app remembers sending.
 */
export async function getOrderItems(orderId: string): Promise<SquareOrderItems> {
  const what = "read the items on an order";
  try {
    const res = await square().orders.get({ orderId }, { timeoutInSeconds: 8, maxRetries: 0 });
    const order = res.order;
    if (!order?.id) throw upstream(`Square returned an unexpected response while trying to ${what}.`);
    const items: SquareOrderItems["items"] = [];
    for (const l of order.lineItems ?? []) {
      if (!l.catalogObjectId) continue;
      const n = Math.floor(Number(l.quantity));
      if (Number.isFinite(n) && n >= 1 && n <= 2_147_483_647) items.push({ catalogObjectId: l.catalogObjectId, quantity: n });
    }
    return { state: order.state ?? null, items };
  } catch (e) {
    throw toUpstreamError(e, what, "Try again in a moment.");
  }
}
