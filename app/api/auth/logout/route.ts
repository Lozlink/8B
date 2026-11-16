import { logout } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";

export const POST = handler(async () => {
  await logout();
  return ok({ ok: true as const });
});
