import { getAdminState } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok } from "@/lib/server/http";

export const GET = handler(async () => {
  const { manager } = await requireAdmin();
  return ok(await getAdminState(manager));
});
