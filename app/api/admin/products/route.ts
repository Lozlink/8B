import { z } from "zod";
import { setItemiseCharges } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok, readJson } from "@/lib/server/http";
import { syncProducts } from "@/lib/server/items";
import { reason } from "@/lib/server/schemas";

export const maxDuration = 30;

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("sync") }),
  z.object({ op: z.literal("itemise"), enabled: z.boolean(), reason }),
]);

export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const b = await readJson(req, body);
  if (b.op === "sync") return ok({ count: await syncProducts() });
  await setItemiseCharges(actor, manager, b.enabled, b.reason);
  return ok({ ok: true as const });
});
