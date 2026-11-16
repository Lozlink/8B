import { after } from "next/server";
import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { getUnpaid } from "@/lib/server/queries";
import { reconcileInBackground } from "@/lib/server/sessions";

export const maxDuration = 30;

export const GET = handler(async () => {
  await requireActor();
  const unpaid = await getUnpaid();
  after(reconcileInBackground);
  return ok(unpaid);
});
