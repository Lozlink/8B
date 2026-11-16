import { z } from "zod";
import { login } from "@/lib/server/auth";
import { handler, ok, readJson } from "@/lib/server/http";
import { pin, uuid } from "@/lib/server/schemas";

const body = z.object({ staffId: uuid, pin });

export const POST = handler(async (req: Request) => {
  const b = await readJson(req, body);
  const a = await login(b.staffId, b.pin);
  return ok({
    me: { staff: { id: a.staffId, name: a.name, role: a.role }, device: { id: a.deviceId, label: a.deviceLabel } },
  });
});
