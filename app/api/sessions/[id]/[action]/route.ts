import { z } from "zod";
import { requireActor, verifyManagerPin } from "@/lib/server/auth";
import { notFound } from "@/lib/server/errors";
import { handler, ok, readJson } from "@/lib/server/http";
import { managerAction, uuid } from "@/lib/server/schemas";
import {
  addItem,
  cancelCheckout,
  chargeCard,
  editTimes,
  markPaid,
  pauseSession,
  releaseTable,
  removeItem,
  resendCheckout,
  resumeSession,
  reversePaid,
  stopSession,
  syncCheckout,
  transferSession,
  voidSession,
} from "@/lib/server/sessions";

// A resend can make three Square calls in a row under the bill's lock (cancel, order, checkout).
// Each has its own timeout; 60 s leaves room for all three to run slow and still answer.
export const maxDuration = 60;

const transferBody = z.object({ tableId: uuid });
const markPaidBody = z.object({ method: z.enum(["card", "cash"]), cardConfirmed: z.boolean().default(false) });
const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const editBody = managerAction.extend({
  intervals: z
    .array(z.object({ id: uuid, startedAt: isoDate, endedAt: isoDate.nullable() }))
    .min(1)
    .max(50),
});
const addItemBody = z.object({ productId: z.string().min(1).max(200), quantity: z.number().int().min(1).max(99).default(1) });
const removeItemBody = z.object({ itemId: uuid });

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
    case "charge":
      return ok(await chargeCard(actor, id));
    case "resend":
      return ok(await resendCheckout(actor, id));
    case "cancel-checkout":
      return ok(await cancelCheckout(actor, id));
    case "sync":
      await syncCheckout(actor, id);
      return ok(OK);
    case "mark-paid": {
      const b = await readJson(req, markPaidBody);
      return ok(await markPaid(actor, id, b.method, { cardConfirmed: b.cardConfirmed }));
    }
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
    case "void": {
      const b = await readJson(req, managerAction);
      const manager = await verifyManagerPin(actor, b.managerPin);
      return ok(await voidSession(actor, manager, id, b.reason));
    }
    case "reverse": {
      const b = await readJson(req, managerAction);
      const manager = await verifyManagerPin(actor, b.managerPin);
      await reversePaid(actor, manager, id, b.reason);
      return ok(OK);
    }
    case "edit-times": {
      const b = await readJson(req, editBody);
      const manager = await verifyManagerPin(actor, b.managerPin);
      return ok(await editTimes(actor, manager, id, b.reason, b.intervals));
    }
    default:
      throw notFound("Unknown action.");
  }
});
