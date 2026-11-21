import { z } from "zod";
import { checkAttention } from "@/lib/server/attention";
import { requireActor, verifyManagerPin } from "@/lib/server/auth";
import { handler, ok, readJson } from "@/lib/server/http";
import { pin } from "@/lib/server/schemas";

const body = z.object({ entryId: z.string().regex(/^\d{1,18}$/, "Invalid entry"), managerPin: pin });

/** A manager marks a "Needs attention" entry on the summary as checked. */
export const POST = handler(async (req: Request) => {
  const actor = await requireActor();
  const b = await readJson(req, body);
  const manager = await verifyManagerPin(actor, b.managerPin);
  await checkAttention(actor, manager, b.entryId);
  return ok({ ok: true as const });
});
