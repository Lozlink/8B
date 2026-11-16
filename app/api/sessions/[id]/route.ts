import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { getSessionDetail } from "@/lib/server/queries";

export const GET = handler(async (_req: Request, ctx: RouteContext<"/api/sessions/[id]">) => {
  await requireActor();
  const { id } = await ctx.params;
  return ok(await getSessionDetail(id));
});
