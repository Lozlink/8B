import { z } from "zod";
import { createTable, updateTable } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok, readJson } from "@/lib/server/http";
import { reason, uuid } from "@/lib/server/schemas";

const tableName = z.string().trim().min(1).max(40);
const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: tableName, reason }),
  z.object({
    op: z.literal("update"),
    id: uuid,
    name: tableName.optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional(),
    reason,
  }),
]);

export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const b = await readJson(req, body);
  if (b.op === "create") await createTable(actor, manager, b.name, b.reason);
  else await updateTable(actor, manager, b.id, { name: b.name, sortOrder: b.sortOrder, active: b.active }, b.reason);
  return ok({ ok: true as const });
});
