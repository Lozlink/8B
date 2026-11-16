import { z } from "zod";
import { requireActor } from "@/lib/server/auth";
import { handler, ok, readJson } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";
import { startSession } from "@/lib/server/sessions";

const body = z.object({ tableId: uuid });

export const POST = handler(async (req: Request) => {
  const actor = await requireActor();
  const b = await readJson(req, body);
  return ok(await startSession(actor, b.tableId));
});
