import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { getUnpaid } from "@/lib/server/queries";

export const GET = handler(async () => {
  await requireActor();
  return ok(await getUnpaid());
});
