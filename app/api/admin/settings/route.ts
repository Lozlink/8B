import { z } from "zod";
import { updateSettings } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { handler, ok, readJson } from "@/lib/server/http";
import { hhmm, reason } from "@/lib/server/schemas";

const body = z.object({
  roundingMinutes: z.number().int().min(1).max(60),
  graceMinutes: z.number().int().min(0).max(60),
  minimumMinutes: z.number().int().min(0).max(600),
  businessDayStart: hhmm,
  reason,
});

export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const { reason: r, ...s } = await readJson(req, body);
  await updateSettings(actor, manager, s, r);
  return ok({ ok: true as const });
});
