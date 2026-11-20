import { after } from "next/server";
import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { refreshProductsInBackground } from "@/lib/server/items";
import { getFloor } from "@/lib/server/queries";
import { refundsInBackground } from "@/lib/server/refunds";
import { reconcileInBackground } from "@/lib/server/sessions";
import { pushCashInBackground } from "@/lib/server/square-cash";
import { stockInBackground } from "@/lib/server/stock";

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
  // Finishes off refunds Square hasn't confirmed: reads back the ones it is still processing and
  // re-sends (same key) the ones it never answered. A read-only check when nothing is due. It
  // writes to `refunds`, which has no floor-broadcast trigger, and to `sessions` only when a refund
  // has really failed and the amount goes back on the bill.
  after(refundsInBackground);
  // Keeps Square's stock and ours in step: reads the counts (at most once every 2 minutes, however
  // many iPads are polling), tells Square about paid bills it didn't take the stock off for, and
  // puts items back for bills that were reopened. A few reads and no writes when there is nothing
  // to do; it writes only to tables with no floor-broadcast trigger.
  after(stockInBackground);
  return ok(floor);
});
