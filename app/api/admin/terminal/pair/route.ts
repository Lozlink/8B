import { pairingStatus, startPairing } from "@/lib/server/admin";
import { requireAdmin } from "@/lib/server/admin-route";
import { badRequest } from "@/lib/server/errors";
import { handler, ok } from "@/lib/server/http";

export const maxDuration = 30;

export const POST = handler(async () => {
  const { actor, manager } = await requireAdmin();
  return ok(await startPairing(actor, manager));
});

export const GET = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const codeId = new URL(req.url).searchParams.get("codeId");
  if (!codeId || codeId.length > 100) throw badRequest("codeId is required.");
  return ok(await pairingStatus(actor, manager, codeId));
});
