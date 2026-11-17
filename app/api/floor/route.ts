import { after } from "next/server";
import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { refreshProductsInBackground } from "@/lib/server/items";
import { getFloor } from "@/lib/server/queries";
import { reconcileInBackground } from "@/lib/server/sessions";
import { pushCashInBackground } from "@/lib/server/square-cash";

export const maxDuration = 30;

export const GET = handler(async () => {
  await requireActor();
  const floor = await getFloor();
  // Safety net for lost/late Square webhooks: after responding, ask Square about any checkout that
  // has been live for a while — including bills no longer on a table (Unpaid list). The query is
  // cheap, filters itself and throttles per checkout, so it runs on every poll. Never delays the
  // floor view.
  after(reconcileInBackground);
  // Keeps the item list in step with Square: at most one catalogue read every 10 minutes, however
  // many iPads are polling. It writes only to tables with no floor-broadcast trigger.
  after(refreshProductsInBackground);
  // Retry safety net for cash sales that haven't reached Square yet. A read-only check when nothing
  // is due, and it writes only to tables with no floor-broadcast trigger.
  after(pushCashInBackground);
  return ok(floor);
});
