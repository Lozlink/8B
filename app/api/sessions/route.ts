import { z } from "zod";
import { requireActor } from "@/lib/server/auth";
import { handler, ok, readJson } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";
import { startSession } from "@/lib/server/sessions";

// Lengths are checked by startSession, which answers in words staff can act on; here it is shape only.
const body = z.object({ tableId: uuid, customerName: z.string().max(500).optional(), note: z.string().max(2000).optional() });

export const POST = handler(async (req: Request) => {
  const actor = await requireActor();
  const b = await readJson(req, body);
  return ok(await startSession(actor, b.tableId, new Date(), { customerName: b.customerName, note: b.note }));
});
