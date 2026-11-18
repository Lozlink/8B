import { after } from "next/server";
import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { getSessionDetail } from "@/lib/server/queries";
import { refundsInBackground } from "@/lib/server/refunds";

export const maxDuration = 30;

export const GET = handler(async (_req: Request, ctx: RouteContext<"/api/sessions/[id]">) => {
  await requireActor();
  const { id } = await ctx.params;
  const detail = await getSessionDetail(id);
  // A refund going from "processing" to "refunded" wakes no iPad (`refunds` has no broadcast
  // trigger), so the sheet showing one re-fetches this route. Each fetch asks Square about refunds
  // that are due a look, after responding; the next fetch shows the answer. A read-only check when
  // nothing is due.
  after(refundsInBackground);
  return ok(detail);
});
