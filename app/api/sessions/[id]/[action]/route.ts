import { after } from "next/server";
import { z } from "zod";
import { requireActor, verifyManagerPin } from "@/lib/server/auth";
import { badRequest, notFound } from "@/lib/server/errors";
import { handler, ok, readJson } from "@/lib/server/http";
import { managerAction, pin, uuid } from "@/lib/server/schemas";
import {
  addCustomItem,
  addItem,
  cancelCheckout,
  chargeCard,
  discardCounterSale,
  editTimes,
  mergeBack,
  pauseSession,
  releaseTable,
  removeDiscount,
  removeItem,
  resendCheckout,
  resumeSession,
  reversePaid,
  setDiscount,
  splitBill,
  stopSession,
  syncCheckout,
  transferSession,
  voidSession,
} from "@/lib/server/sessions";
import { checkCashHandoff, markPaidCheckingPos, startCashHandoff } from "@/lib/server/pos-cash";
import { pushCashInBackground } from "@/lib/server/square-cash";
import { printReceipt } from "@/lib/server/receipts";
import { refundSession, refundsInBackground, settleRefund } from "@/lib/server/refunds";

// A resend can make three Square calls in a row under the bill's lock (cancel, order, checkout).
// Each has its own timeout; 60 s leaves room for all three to run slow and still answer.
export const maxDuration = 60;

const transferBody = z.object({ tableId: uuid });
// What the screen showed as the bill's total when staff tapped. Optional: the release before this
// one doesn't send it, and then the action goes ahead on whatever the bill is now. When it is sent
// and the bill is no longer that amount, the action answers 409 `bill_changed` and does nothing.
const expectedTotal = z.number().int("expectedTotalCents must be whole cents").min(0).optional();
const expectedBody = z.object({ expectedTotalCents: expectedTotal });
const markPaidBody = z.object({
  method: z.enum(["card", "cash"]),
  cardConfirmed: z.boolean().default(false),
  expectedTotalCents: expectedTotal,
});
const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const editBody = managerAction.extend({
  intervals: z
    .array(z.object({ id: uuid, startedAt: isoDate, endedAt: isoDate.nullable() }))
    .min(1)
    .max(50),
});
const addItemBody = z.object({ productId: z.string().min(1).max(200), quantity: z.number().int().min(1).max(99).default(1) });
const removeItemBody = z.object({ itemId: uuid });
// The limits (name 1–60 characters, 1c–$2,000, percentages up to 100%, 2–10 ways) are checked by
// the functions these feed, which answer in words staff can act on; here it is shape only.
const customItemBody = z.object({ name: z.string().max(200), amountCents: z.number() });
const discountBody = z.object({
  discountId: z.string().min(1).max(200).optional(),
  value: z.number().optional(),
  custom: z.object({ name: z.string().max(200), kind: z.enum(["percent", "amount"]), value: z.number() }).optional(),
  managerPin: pin.optional(),
});
const splitBody = z.object({ ways: z.number().optional(), amountCents: z.number().optional(), expectedTotalCents: expectedTotal });
const refundBody = managerAction.extend({
  amountCents: z.number().int("Enter the amount in whole cents").positive("Enter the amount to refund"),
  // Made by the screen once per refund the manager means to make, and sent again on any retry.
  // Optional only so a screen loaded before this existed still works; it then gets no protection.
  requestId: uuid.optional(),
});
const settleRefundBody = managerAction.extend({ refundId: uuid, outcome: z.enum(["refunded", "not_refunded"]) });

const OK = { ok: true as const };

export const POST = handler(async (req: Request, ctx: RouteContext<"/api/sessions/[id]/[action]">) => {
  const actor = await requireActor();
  const { id, action } = await ctx.params;

  switch (action) {
    case "pause":
      await pauseSession(actor, id);
      return ok(OK);
    case "resume":
      await resumeSession(actor, id);
      return ok(OK);
    case "transfer": {
      const b = await readJson(req, transferBody);
      await transferSession(actor, id, b.tableId);
      return ok(OK);
    }
    case "stop":
      return ok(await stopSession(actor, id));
    case "release":
      await releaseTable(actor, id);
      return ok(OK);
    case "charge": {
      const b = await readJson(req, expectedBody);
      return ok(await chargeCard(actor, id, { expectedTotalCents: b.expectedTotalCents }));
    }
    case "resend": {
      const b = await readJson(req, expectedBody);
      return ok(await resendCheckout(actor, id, { expectedTotalCents: b.expectedTotalCents }));
    }
    case "cancel-checkout":
      return ok(await cancelCheckout(actor, id));
    case "sync":
      await syncCheckout(actor, id);
      return ok(OK);
    case "mark-paid": {
      const b = await readJson(req, markPaidBody);
      // If this bill was just handed to Square POS, this first asks Square whether POS took the cash.
      const out = await markPaidCheckingPos(actor, id, b.method, {
        cardConfirmed: b.cardConfirmed,
        expectedTotalCents: b.expectedTotalCents,
      });
      // A cash sale is put into Square after the response, so the tap comes straight back.
      if (b.method === "cash") after(pushCashInBackground);
      return ok(out);
    }
    case "cash-handoff": {
      const b = await readJson(req, expectedBody);
      return ok(await startCashHandoff(actor, id, { expectedTotalCents: b.expectedTotalCents }));
    }
    case "cash-handoff-check":
      return ok(await checkCashHandoff(actor, id));
    case "add-item": {
      const b = await readJson(req, addItemBody);
      await addItem(actor, id, b.productId, b.quantity);
      return ok(OK);
    }
    case "remove-item": {
      const b = await readJson(req, removeItemBody);
      await removeItem(actor, id, b.itemId);
      return ok(OK);
    }
    case "add-custom-item": {
      const b = await readJson(req, customItemBody);
      await addCustomItem(actor, id, b.name, b.amountCents);
      return ok(OK);
    }
    case "discard":
      await discardCounterSale(actor, id);
      return ok(OK);
    case "set-discount": {
      const b = await readJson(req, discountBody);
      if ((b.discountId === undefined) === (b.custom === undefined)) {
        throw badRequest("Pick a discount from the list, or type one in.");
      }
      // A fixed discount from Square needs no PIN. When one is sent it is checked here, outside the
      // bill's lock, exactly as void's is; whether this discount needed it is decided under the lock.
      const manager = b.managerPin ? await verifyManagerPin(actor, b.managerPin) : null;
      await setDiscount(actor, manager, id, b.custom ? { custom: b.custom } : { discountId: b.discountId ?? "", value: b.value });
      return ok(OK);
    }
    case "remove-discount":
      await removeDiscount(actor, id);
      return ok(OK);
    case "split": {
      const b = await readJson(req, splitBody);
      if ((b.ways === undefined) === (b.amountCents === undefined)) {
        throw badRequest("Say how many ways to split the bill, or how much to split off.");
      }
      const how = b.ways !== undefined ? { ways: b.ways } : { amountCents: b.amountCents ?? 0 };
      return ok(await splitBill(actor, id, { ...how, expectedTotalCents: b.expectedTotalCents }));
    }
    case "merge-back":
      await mergeBack(actor, id);
      return ok(OK);
    case "void": {
      const b = await readJson(req, managerAction);
      const manager = await verifyManagerPin(actor, b.managerPin);
      return ok(await voidSession(actor, manager, id, b.reason));
    }
    case "reverse": {
      const b = await readJson(req, managerAction);
      const manager = await verifyManagerPin(actor, b.managerPin);
      await reversePaid(actor, manager, id, b.reason);
      // If the bill was paid in cash, its sale in Square is refunded in the background.
      after(pushCashInBackground);
      return ok(OK);
    }
    case "edit-times": {
      const b = await readJson(req, editBody);
      const manager = await verifyManagerPin(actor, b.managerPin);
      return ok(await editTimes(actor, manager, id, b.reason, b.intervals));
    }
    case "refund": {
      const b = await readJson(req, refundBody);
      const manager = await verifyManagerPin(actor, b.managerPin);
      // Registered before the refund is made, so it runs whether the refund answers or throws: it
      // finishes off anything Square hasn't confirmed yet (this refund included, once it is due).
      after(refundsInBackground);
      // Waits for Square's first answer. Throws 409 `refund_failed` if Square refused it. A repeat
      // of a request id that already made its refund answers with that refund and makes nothing new.
      return ok(await refundSession(actor, manager, id, b.reason, b.amountCents, b.requestId ?? null));
    }
    case "settle-refund": {
      // A manager says what Square shows for a refund the app stopped trying. "not_refunded" reads
      // the payment from Square once (8 s) before anything is written; 409 if it can't be settled.
      const b = await readJson(req, settleRefundBody);
      const manager = await verifyManagerPin(actor, b.managerPin);
      return ok(await settleRefund(actor, manager, id, b.reason, b.refundId, b.outcome));
    }
    case "print-receipt":
      return ok(await printReceipt(actor, id));
    default:
      throw notFound("Unknown action.");
  }
});
