import { z } from "zod";
import { revokeDevice } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok, readJson } from "@/lib/server/http";
import { reason, uuid } from "@/lib/server/schemas";

const body = z.object({ op: z.literal("revoke"), id: uuid, reason });

export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const b = await readJson(req, body);
  await revokeDevice(actor, manager, b.id, b.reason);
  return ok({ ok: true as const });
});
