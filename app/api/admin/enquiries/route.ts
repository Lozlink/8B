import { z } from "zod";
import { requireAdmin } from "@/lib/server/admin-route";
import { listEnquiries, setEnquiryHandled } from "@/lib/server/enquiries";
import { handler, ok, readJson } from "@/lib/server/http";
import { uuid } from "@/lib/server/schemas";

const body = z.object({ id: uuid, handled: z.boolean() });

/** Functions enquiries from the public site, open ones first. */
export const GET = handler(async () => {
  await requireAdmin();
  return ok({ enquiries: await listEnquiries() });
});

/** Mark one as dealt with, or put it back on the open list. */
export const POST = handler(async (req: Request) => {
  const { actor, manager } = await requireAdmin();
  const b = await readJson(req, body);
  await setEnquiryHandled(actor, manager, b.id, b.handled);
  return ok({ ok: true as const });
});
