import { z } from "zod";
import { unpairTerminal } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok, readJson } from "@/lib/server/http";
import { reason } from "@/lib/server/schemas";

export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const b = await readJson(req, z.object({ reason }));
  await unpairTerminal(actor, manager, b.reason);
  return ok({ ok: true as const });
});
