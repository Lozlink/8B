import { z } from "zod";
import { setItemiseCharges } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { setCosts } from "@/lib/server/costs";
import { handler, ok, readJson } from "@/lib/server/http";
import { syncProducts } from "@/lib/server/items";
import { reason } from "@/lib/server/schemas";
import { refreshStock, retryStockMoves } from "@/lib/server/stock";

export const maxDuration = 30;

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("sync") }),
  z.object({ op: z.literal("stock-retry") }),
  z.object({ op: z.literal("itemise"), enabled: z.boolean(), reason }),
  // How many, and what a cost may be, are checked by setCosts, which says so in words.
  z.object({
    op: z.literal("costs"),
    costs: z.array(z.object({ productId: z.string().min(1).max(200), costCents: z.number().nullable() })).max(2000),
  }),
]);

export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const b = await readJson(req, body);
  if (b.op === "sync") {
    const count = await syncProducts();
    try {
      await refreshStock();
    } catch (e) {
      // The item list is saved. Why the counts weren't is on `catalog_state.stock_error`, which
      // Admin → Items shows.
      console.warn("[square] stock counts not read after a manual sync", e instanceof Error ? e.message : e);
    }
    return ok({ count });
  }
  if (b.op === "stock-retry") return ok(await retryStockMoves(actor, manager));
  if (b.op === "costs") return ok(await setCosts(actor, manager, b.costs));
  await setItemiseCharges(actor, manager, b.enabled, b.reason);
  return ok({ ok: true as const });
});
