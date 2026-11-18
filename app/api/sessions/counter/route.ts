import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { openCounterSale } from "@/lib/server/sessions";

/** A sale with no table: opens an empty bill that is already awaiting payment. */
export const POST = handler(async () => {
  const actor = await requireActor();
  return ok(await openCounterSale(actor));
});
