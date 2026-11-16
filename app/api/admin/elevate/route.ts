import { z } from "zod";
import { elevate, requireActor } from "@/lib/server/auth";
import { handler, ok, readJson } from "@/lib/server/http";
import { pin } from "@/lib/server/schemas";

export const POST = handler(async (req: Request) => {
  const actor = await requireActor();
  const b = await readJson(req, z.object({ pin }));
  const manager = await elevate(actor, b.pin);
  return ok({ manager, expiresInSeconds: 600 });
});
