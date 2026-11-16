import { z } from "zod";
import { createStaff, updateStaff } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok, readJson } from "@/lib/server/http";
import { name, pin, reason, role, uuid } from "@/lib/server/schemas";

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name, role, pin, reason }),
  z.object({
    op: z.literal("update"),
    id: uuid,
    name: name.optional(),
    role: role.optional(),
    active: z.boolean().optional(),
    pin: pin.optional(),
    reason,
  }),
]);

export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const b = await readJson(req, body);
  if (b.op === "create") await createStaff(actor, manager, { name: b.name, role: b.role, pin: b.pin }, b.reason);
  else await updateStaff(actor, manager, b.id, { name: b.name, role: b.role, active: b.active, pin: b.pin }, b.reason);
  return ok({ ok: true as const });
});
