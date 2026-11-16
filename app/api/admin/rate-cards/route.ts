import { z } from "zod";
import { createRateCard, updateRateCard } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok, readJson } from "@/lib/server/http";
import { hhmm, name, reason, uuid } from "@/lib/server/schemas";

const fields = {
  name,
  centsPerHour: z.number().int().min(0).max(1_000_000),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startLocal: hhmm,
  endLocal: hhmm,
  priority: z.number().int().min(-1000).max(1000),
};

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), ...fields, reason }),
  z.object({
    op: z.literal("update"),
    id: uuid,
    name: fields.name.optional(),
    centsPerHour: fields.centsPerHour.optional(),
    daysOfWeek: fields.daysOfWeek.optional(),
    startLocal: fields.startLocal.optional(),
    endLocal: fields.endLocal.optional(),
    priority: fields.priority.optional(),
    active: z.boolean().optional(),
    reason,
  }),
]);

export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const b = await readJson(req, body);
  if (b.op === "create") {
    const { op: _op, reason: r, ...card } = b;
    await createRateCard(actor, manager, card, r);
  } else {
    const { op: _op, id, reason: r, ...patch } = b;
    await updateRateCard(actor, manager, id, patch, r);
  }
  return ok({ ok: true as const });
});
