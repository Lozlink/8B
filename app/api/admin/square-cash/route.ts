import { z } from "zod";
import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok, readJson } from "@/lib/server/http";
import { retryCashRecords } from "@/lib/server/square-cash";

// A retry sends up to 25 records one after another: 10 s of starting new ones, plus the one in hand.
export const maxDuration = 60;

const body = z.object({ op: z.literal("retry") });

export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  await readJson(req, body);
  return ok(await retryCashRecords(actor, manager));
});
