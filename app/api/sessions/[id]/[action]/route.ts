import { z } from "zod";
import { requireActor, verifyManagerPin } from "@/lib/server/auth";
import { notFound } from "@/lib/server/errors";
import { handler, ok, readJson } from "@/lib/server/http";
import { managerAction, uuid } from "@/lib/server/schemas";
import {
  cancelCheckout,
  chargeCard,
  editTimes,
  markPaid,
  pauseSession,
  releaseTable,
  resendCheckout,
  resumeSession,
  reversePaid,
  stopSession,
  syncCheckout,
  transferSession,
  voidSession,
} from "@/lib/server/sessions";

export const maxDuration = 30;

const transferBody = z.object({ tableId: uuid });
const markPaidBody = z.object({ method: z.enum(["card", "cash"]), cardConfirmed: z.boolean().default(false) });
const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const editBody = managerAction.extend({
  intervals: z
    .array(z.object({ id: uuid, startedAt: isoDate, endedAt: isoDate.nullable() }))
    .min(1)
    .max(50),
});

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
