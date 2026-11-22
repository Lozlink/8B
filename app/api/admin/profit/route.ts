import { requireAdmin } from "@/lib/server/admin-route";
import { getProfitReport } from "@/lib/server/costs";
import { handler, ok } from "@/lib/server/http";

export const GET = handler(async (req: Request) => {
  await requireAdmin();
  const p = new URL(req.url).searchParams;
  return ok(await getProfitReport(p.get("from"), p.get("to")));
});
