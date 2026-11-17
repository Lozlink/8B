/**
 * Square Point of Sale API, mobile web, iOS. Everything the app assumes about it is in this file.
 *
 * Sources: Square's "Build on mobile web" guide and "Mobile web technical reference"
 * (developer.squareup.com/docs/pos-api/build-mobile-web, .../web-technical-reference), read on
 * 18 Nov 2026. NONE of it has been run against a real iPad with Square POS. What is assumed:
 *
 *   1. The link is `square-commerce-v1://payment/create?data=<percent-encoded JSON>`.
 *   2. `amount_money.amount` is a STRING of cents in the guide's web example ("500"); the reference
 *      types it as Money. We send the string, as the web example does.
 *   3. `version` is "1.3" and `options.supported_tender_types: ["CASH"]` limits POS to cash.
 *   4. `location_id` makes POS refuse (`user_id_mismatch`) if it is signed in to another location.
 *   5. `options.auto_return: true` makes POS come back by itself after the sale.
 *   6. `state` comes back unchanged in the callback. No length limit is documented; ours is a
 *      signed token of roughly 330 characters.
 *   7. `notes` is saved with the sale and printed on receipts. Whether it shows up as the `note`
 *      of the Payments API payment is NOT documented (the reference speaks of the old v1 payment).
 *   8. POS opens `callback_url` with one query parameter, `data`, holding JSON with `status`
 *      ("ok" / "error"), `error_code`, `transaction_id` (absent for an offline sale),
 *      `client_transaction_id` and `state`.
 *   9. `transaction_id` is treated as an Orders API order id, with a fallback to a payment id
 *      (see pos-cash.ts). The reference only names the retired Transactions API.
 *  10. Default taxes set up in Square POS are applied to the sale (we don't set
 *      `clear_default_fees`). With inclusive GST the total stays what we asked for; a tax that adds
 *      to the price would change the total, and the sale would then not match the bill.
 */

export const POS_API_VERSION = "1.3";

export interface PosCashLinkInput {
  amountCents: number;
  callbackUrl: string;
  applicationId: string;
  locationId: string;
  /** Saved on the sale in Square and printed on the receipt. */
  notes: string;
  /** Opaque; POS hands it back in the callback. */
  state: string;
}

/** The JSON Square POS reads from the link's `data` parameter. */
export function posCashRequest(input: PosCashLinkInput) {
  return {
    amount_money: { amount: String(input.amountCents), currency_code: "AUD" },
    callback_url: input.callbackUrl,
    client_id: input.applicationId,
    version: POS_API_VERSION,
    location_id: input.locationId,
    notes: input.notes.slice(0, 500),
    state: input.state,
    options: { supported_tender_types: ["CASH"], auto_return: true },
  };
}

/** The link that opens Square POS on the iPad with a cash sale for this amount. */
export function posCashLink(input: PosCashLinkInput): string {
  return `square-commerce-v1://payment/create?data=${encodeURIComponent(JSON.stringify(posCashRequest(input)))}`;
}

export interface PosCallback {
  status: "ok" | "error";
  errorCode: string | null;
  /** Absent when POS took the sale offline. */
  transactionId: string | null;
  clientTransactionId: string | null;
  state: string | null;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** Reads the callback's `data` JSON. null when it isn't the shape POS sends. Never throws. */
export function parsePosCallback(raw: string): PosCallback | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const errorCode = str(o.error_code, 100);
  // The guide's own callback code decides on `error_code` being present; `status` is belt and braces.
  const status = o.status === "error" || errorCode ? "error" : o.status === "ok" ? "ok" : null;
  if (!status) return null;
  return {
    status,
    errorCode,
    transactionId: str(o.transaction_id, 255),
    clientTransactionId: str(o.client_transaction_id, 255),
    state: str(o.state, 2000),
  };
}

/** What to tell staff for each documented iOS error code. */
export function posErrorMessage(code: string | null): { canceled: boolean; message: string } {
  switch (code) {
    case "payment_canceled":
      return { canceled: true, message: "The cash sale was cancelled in Square. Nothing was taken and the bill is still unpaid." };
    case "not_logged_in":
      return { canceled: false, message: "Square POS isn't signed in on this iPad. Sign in, then take the cash again." };
    case "user_id_mismatch":
      return { canceled: false, message: "Square POS on this iPad is signed in to a different location. Nothing was taken." };
    case "could_not_perform":
      return { canceled: false, message: "Square POS has an unfinished sale open. Finish or clear it there, then take the cash again." };
    case "no_network_connection":
      return { canceled: false, message: "Square POS has no internet connection. Nothing was taken." };
    case "unsupported_api_version":
      return { canceled: false, message: "Square POS on this iPad needs updating before it can take cash from the table timer." };
    default:
      return { canceled: false, message: `Square POS couldn't take the sale${code ? ` (${code})` : ""}. The bill is still unpaid.` };
  }
}
