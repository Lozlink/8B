import { currentDevice } from "@/lib/server/auth";
import { needsFirstManager } from "@/lib/server/admin";
import { handler, ok } from "@/lib/server/http";

export const GET = handler(async () => {
  const [device, setupNeeded] = await Promise.all([currentDevice(), needsFirstManager()]);
  return ok({ device, setupNeeded });
});
