import { dropElevation } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";

export const POST = handler(async () => {
  await dropElevation();
  return ok({ ok: true as const });
});
