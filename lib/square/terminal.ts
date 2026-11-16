import "server-only";
import { isCheckoutStatus, type CheckoutStatus } from "@/lib/domain/machine";
import { upstream } from "@/lib/server/errors";
import { square, toUpstreamError, isSquareStatus } from "./client";

export interface SquareCheckoutState {
  id: string;
  status: CheckoutStatus;
  cancelReason: string | null;
  amountCents: number;
}

interface SdkCheckout {
  id?: string;
  status?: string;
  cancelReason?: string | null;
  amountMoney?: { amount?: bigint | null } | null;
}

function toState(c: SdkCheckout | undefined, what: string): SquareCheckoutState {
  if (!c?.id || !isCheckoutStatus(c.status)) {
    throw upstream(`Square returned an unexpected response while trying to ${what}.`);
  }
  return {
    id: c.id,
    status: c.status,
    cancelReason: c.cancelReason ?? null,
    // Amounts come back as bigint; convert before anything tries to JSON.stringify them.
    amountCents: c.amountMoney?.amount != null ? Number(c.amountMoney.amount) : 0,
  };
}

export interface CreateCheckoutInput {
  /** `${sessionId}-a${attempt}` — ≤ 64 chars; stable until the attempt is committed. */
  idempotencyKey: string;
  amountCents: number;
  deviceId: string;
  /** Session id (≤ 40 chars). Lets the webhook find the session even before our row commits. */
  referenceId: string;
  /** Shown on the Terminal, ≤ 500 chars. */
  note: string;
  /** Itemised charge: the Square order this checkout pays. `amountCents` must equal the order total. */
  orderId?: string;
}

export async function createTerminalCheckout(input: CreateCheckoutInput): Promise<SquareCheckoutState> {
  const what = "send the charge to the Terminal";
  try {
    const res = await square().terminal.checkouts.create({
      idempotencyKey: input.idempotencyKey,
      checkout: {
        amountMoney: { amount: BigInt(input.amountCents), currency: "AUD" },
        referenceId: input.referenceId,
        note: input.note.slice(0, 500),
        ...(input.orderId ? { orderId: input.orderId } : {}),
        deviceOptions: {
          deviceId: input.deviceId,
          // No tipping on table hire; show the receipt screen (print/email/SMS on the Terminal).
          tipSettings: { allowTipping: false },
          skipReceiptScreen: false,
          // With an order attached, list its lines on the Terminal before the buyer pays.
          ...(input.orderId ? { showItemizedCart: true } : {}),
        },
      },
    });
    return toState(res.checkout, what);
  } catch (e) {
    throw toUpstreamError(e, what);
  }
}

export async function getTerminalCheckout(checkoutId: string): Promise<SquareCheckoutState> {
  const what = "check the card payment";
  try {
    const res = await square().terminal.checkouts.get({ checkoutId });
    return toState(res.checkout, what);
  } catch (e) {
    throw toUpstreamError(e, what);
  }
}

/**
 * Requests cancellation and returns Square's view afterwards. A PENDING checkout becomes CANCELED;
 * an IN_PROGRESS one becomes CANCEL_REQUESTED (not final — the buyer may still finish). Square
 * doesn't document what cancelling a COMPLETED checkout returns, so on a 4xx we re-read the
 * checkout and let the caller reconcile.
 */
export async function cancelTerminalCheckout(checkoutId: string): Promise<SquareCheckoutState> {
  const what = "cancel the card checkout";
  try {
    const res = await square().terminal.checkouts.cancel({ checkoutId });
    return toState(res.checkout, what);
  } catch (e) {
    if (isSquareStatus(e, 400) || isSquareStatus(e, 409)) {
      return getTerminalCheckout(checkoutId);
    }
    throw toUpstreamError(e, what);
  }
}

export interface DeviceCodeState {
  id: string;
  code: string | null;
  status: "UNKNOWN" | "UNPAIRED" | "PAIRED" | "EXPIRED";
  deviceId: string | null;
  pairBy: string | null;
}

interface SdkDeviceCode {
  id?: string;
  code?: string | null;
  status?: string;
  deviceId?: string | null;
  pairBy?: string | null;
}

function toDeviceCode(d: SdkDeviceCode | undefined): DeviceCodeState {
  const status = d?.status;
  if (!d?.id || (status !== "UNKNOWN" && status !== "UNPAIRED" && status !== "PAIRED" && status !== "EXPIRED")) {
    throw upstream("Square returned an unexpected device code.");
  }
  return { id: d.id, code: d.code ?? null, status, deviceId: d.deviceId ?? null, pairBy: d.pairBy ?? null };
}

/** Devices API — production only (the sandbox can't pair a real Terminal). Codes expire after 5 minutes. */
export async function createDeviceCode(locationId: string, name: string, idempotencyKey: string): Promise<DeviceCodeState> {
  try {
    const res = await square().devices.codes.create({
      idempotencyKey,
      deviceCode: { productType: "TERMINAL_API", locationId, name: name.slice(0, 128) },
    });
    return toDeviceCode(res.deviceCode);
  } catch (e) {
    throw toUpstreamError(e, "create a pairing code");
  }
}

export async function getDeviceCode(id: string): Promise<DeviceCodeState> {
  try {
    const res = await square().devices.codes.get({ id });
    return toDeviceCode(res.deviceCode);
  } catch (e) {
    throw toUpstreamError(e, "check the pairing code");
  }
}
