import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";

export const GET = handler(async () => {
  const a = await requireActor();
  return ok({
    me: { staff: { id: a.staffId, name: a.name, role: a.role }, device: { id: a.deviceId, label: a.deviceLabel } },
  });
});
