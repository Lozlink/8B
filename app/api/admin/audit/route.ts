import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok } from "@/lib/server/http";
import { getAudit } from "@/lib/server/queries";

export const GET = handler(async (req: Request) => {
  await requireAdmin();
  const p = new URL(req.url).searchParams;
  const s = (k: string) => {
    const v = p.get(k);
    return v && v.length <= 100 ? v : undefined;
  };
  return ok(await getAudit({ before: s("before"), entity: s("entity"), entityId: s("entityId"), action: s("action") }));
});
