import { requireActor } from "@/lib/server/auth";
import { handler, ok } from "@/lib/server/http";
import { getSummary } from "@/lib/server/queries";

export const GET = handler(async (req: Request) => {
  await requireActor();
  const date = new URL(req.url).searchParams.get("date");
  return ok(await getSummary(date));
});
