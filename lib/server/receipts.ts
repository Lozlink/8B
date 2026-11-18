import "server-only";
import { randomUUID } from "node:crypto";
import { assertCan, type SessionStatus } from "@/lib/domain/machine";
import type { Actor } from "./auth";
import { audit } from "./audit";
import { db } from "./db";
import { squareEnv } from "./env";
import { AppError, conflict, notFound } from "./errors";
import { findPayment, paymentsGateway, type NoPaymentReason, type PaymentLookup, type ResolvedPayment } from "./payment-ref";
import { getSettings } from "./repo";
import { pushCashRecords } from "./square-cash";
import { isSquareRejection, squareStatus } from "./square-errors";

/*
 * Receipt reprints on the Square Terminal.
 *
 * The app asks the Terminal to print the receipt of the payment that settled a bill (a Terminal
 * "RECEIPT" action, print only). A Terminal action is not a payment: nothing here holds a lock,
 * nothing is retried, and a failure only ever means "no paper came out", which staff can see for
 * themselves. So a failure answers with something they can act on and that is all.
 *
 * `ok` means Square accepted the request. The Terminal prints when it is free; if it is off or
 * busy for two minutes, Square drops the request and nobody is told.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long to give a cash sale that another request is sending to Square at this very moment. */
const IN_FLIGHT_WAITS_MS = [700, 1300] as const;

/** Why the Terminal can't print this bill's receipt, for staff. */
function cantPrint(why: NoPaymentReason, due: boolean): AppError {
  switch (why) {
    case "other_reader":
      return conflict("This card payment wasn't taken on the Terminal, so the Terminal can't print its receipt. Print it from Square.");
    case "card_unknown":
      return conflict("The app can't find this card payment in Square, so it can't print its receipt. Print it from Square.");
    case "cash_pending":
      return due
        ? conflict("This cash sale is still on its way to Square. Try again in a moment.")
        : conflict("Square hasn't taken this cash sale yet; the app keeps trying. Print the receipt once it has gone through.");
    case "cash_held":
      return conflict("This cash sale goes to Square a few minutes after it was sent to Square POS. Try again then.");
    case "cash_failed":
      return conflict(
        "This cash sale didn't go into Square, so the Terminal can't print its receipt. A manager can send it again in Admin → Items.",
      );
    case "cash_not_recorded":
      return conflict("This cash payment was never recorded in Square, so the Terminal can't print a receipt for it.");
    case "not_paid":
      return conflict("Only a paid bill has a receipt to print.");
  }
}

const sendingNow = (f: PaymentLookup) => f.kind === "none" && f.why === "cash_pending" && f.due === true;

/**
 * The payment to print. If the bill was paid in cash and its sale is due to go to Square but
 * hasn't yet, that sale is sent first: staff tap Print straight after Mark paid.
 */
async function paymentToPrint(sessionId: string): Promise<ResolvedPayment> {
  let found = await findPayment(sessionId);
  if (sendingNow(found)) {
    try {
      // Sends whatever is due, oldest first; this bill's sale is among it. No lock is held.
      await pushCashRecords({ limit: 3, budgetMs: 3_000 });
    } catch (e) {
      console.warn("[square] cash push before a receipt failed", sessionId, e instanceof Error ? e.message : e);
    }
    found = await findPayment(sessionId);
    // Still due and not sent by us: another request has it in hand (the push that follows Mark
    // paid). That takes a second or two.
    for (const ms of IN_FLIGHT_WAITS_MS) {
      if (!sendingNow(found)) break;
      await sleep(ms);
      found = await findPayment(sessionId);
    }
  }
  if (found.kind !== "found") throw cantPrint(found.why, found.due === true);
  return found.payment;
}

/** Whether this payment's receipt has been sent to the Terminal before. */
async function printedBefore(sessionId: string, paymentId: string): Promise<boolean> {
  const [seen] = await db()<{ id: string }[]>`
    select id::text as id from public.audit_log
    where entity = 'session' and entity_id = ${sessionId} and action = 'receipt.printed'
      and after->>'payment_id' = ${paymentId}
    limit 1`;
  return !!seen;
}

/**
 * Asks the Terminal to print the receipt for a paid bill. Any staff member.
 *
 * A card payment's receipt was already offered on the Terminal when the card was taken, so every
 * print from here is marked as a duplicate. A cash payment's first print is the original and later
 * ones are duplicates.
 */
export async function printReceipt(actor: Pick<Actor, "staffId" | "deviceLabel">, id: string): Promise<{ ok: true }> {
  if (!UUID_RE.test(id)) throw notFound("Session not found.");
  const q = db();
  const [s] = await q<{ status: SessionStatus; settled_cents: number | null }[]>`
    select status, settled_cents from public.sessions where id = ${id}`;
  if (!s) throw notFound("Session not found.");
  assertCan(s.status, "print_receipt");
  // A bill discounted to nothing is "paid" with no payment behind it, so Square has nothing to print.
  if (s.settled_cents === 0) throw conflict("Nothing was collected on this bill, so there is no receipt to print.");
  const { terminalDeviceId: deviceId } = await getSettings(q);
  if (!deviceId) {
    throw conflict("No Terminal is paired, so there is nothing to print on. A manager can pair one in Admin → Terminal.");
  }
  squareEnv(); // 503 with a staff-readable message when Square isn't set up

  const payment = await paymentToPrint(id);
  const isDuplicate = payment.method === "card" || (await printedBefore(id, payment.paymentId));
  const info = { payment_id: payment.paymentId, method: payment.method, is_duplicate: isDuplicate, device_id: deviceId };
  const who = { actorStaffId: actor.staffId, deviceLabel: actor.deviceLabel };

  let actionId: string;
  try {
    // A fresh key every time: each tap is its own print request.
    const action = await paymentsGateway().createReceiptAction({
      idempotencyKey: randomUUID(),
      deviceId,
      paymentId: payment.paymentId,
      isDuplicate,
    });
    actionId = action.id;
  } catch (e) {
    await audit(q, {
      ...who,
      action: "receipt.failed",
      entity: "session",
      entityId: id,
      after: { ...info, square: e instanceof AppError ? e.detail ?? null : null },
      reason: e instanceof AppError ? e.message : "Something went wrong while sending the receipt to the Terminal.",
    });
    // Square answered and said no: the device, or this payment's receipt. Square's own wording is in
    // the audit row; staff get something they can check. (A 401/403 is the access token, and reads
    // as the outage it is.)
    if (isSquareRejection(e) && squareStatus(e) !== 401 && squareStatus(e) !== 403) {
      throw conflict("The Terminal didn't accept the print request. Is it switched on?", { square: e.detail ?? null });
    }
    throw e;
  }

  await audit(q, {
    ...who,
    action: "receipt.printed",
    entity: "session",
    entityId: id,
    after: { ...info, action_id: actionId },
  });
  return { ok: true };
}
