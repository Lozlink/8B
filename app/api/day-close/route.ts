import { z } from "zod";
import { requireActor, verifyManagerPin } from "@/lib/server/auth";
import { closeDay, getDayCloseState, listDayCloses } from "@/lib/server/day-close";
import { handler, ok, readJson } from "@/lib/server/http";
import { pin } from "@/lib/server/schemas";

export const GET = handler(async (req: Request) => {
  await requireActor();
  const p = new URL(req.url).searchParams;
  if (p.get("history")) return ok(await listDayCloses());
  return ok(await getDayCloseState(p.get("date")));
});

// Ranges, the 5c rule and whether the notes and coins add up are checked by closeDay, which
// answers in words staff can act on; here it is shape only.
const body = z.object({
  date: z.string().max(10).optional(),
  floatCents: z.number(),
  countedCashCents: z.number(),
  cashCounts: z.record(z.string().max(8), z.number()).optional(),
  note: z.string().max(2000).optional(),
  expectedTakingsCents: z.number().int().optional(),
  expectedCashMovementCents: z.number().int().optional(),
  managerPin: pin.optional(),
  reason: z.string().max(2000).optional(),
});

export const POST = handler(async (req: Request) => {
  const actor = await requireActor();
  const b = await readJson(req, body);
  // Only closing a day again needs a manager; when a PIN is sent it is always checked.
  const manager = b.managerPin ? await verifyManagerPin(actor, b.managerPin) : null;
  return ok(
    await closeDay(actor, manager, {
      date: b.date ?? null,
      floatCents: b.floatCents,
      countedCashCents: b.countedCashCents,
      cashCounts: b.cashCounts ?? null,
      note: b.note ?? null,
      expectedTakingsCents: b.expectedTakingsCents,
      expectedCashMovementCents: b.expectedCashMovementCents,
      reason: b.reason ?? null,
    }),
  );
});
