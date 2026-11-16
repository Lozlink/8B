import { after } from "next/server";
import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { getFloor } from "@/lib/server/queries";
import { syncStaleCheckouts } from "@/lib/server/sessions";

export const maxDuration = 30;

export const GET = handler(async () => {
  await requireActor();
  const floor = await getFloor();
  // Safety net for lost/late Square webhooks: after responding, ask Square about any checkout
  // that has been live for a while (throttled per checkout). Never delays the floor view.
  if (floor.sessions.some((s) => s.checkout && ["PENDING", "IN_PROGRESS", "CANCEL_REQUESTED"].includes(s.checkout.status))) {
    after(async () => {
      try {
        await syncStaleCheckouts();
      } catch (e) {
        console.warn("[square] stale checkout sync skipped", e instanceof Error ? e.message : e);
      }
    });
  }
  return ok(floor);
});
