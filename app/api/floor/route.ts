import { after } from "next/server";
import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { getFloor } from "@/lib/server/queries";
import { reconcileInBackground } from "@/lib/server/sessions";

export const maxDuration = 30;

export const GET = handler(async () => {
  await requireActor();
  const floor = await getFloor();
  // Safety net for lost/late Square webhooks: after responding, ask Square about any checkout that
  // has been live for a while — including bills no longer on a table (Unpaid list). The query is
  // cheap, filters itself and throttles per checkout, so it runs on every poll. Never delays the
  // floor view.
  after(reconcileInBackground);
  return ok(floor);
});
