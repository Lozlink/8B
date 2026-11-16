import { requireDevice } from "@/lib/server/auth";
import { db } from "@/lib/server/db";
import { handler, ok } from "@/lib/server/http";
import type { StaffRole } from "@/lib/domain/types";

/** Names for the login screen — only shown to enrolled devices. */
export const GET = handler(async () => {
  await requireDevice();
  const staff = await db()<{ id: string; name: string; role: StaffRole }[]>`
    select id, name, role from public.staff where active order by name`;
  return ok({ staff });
});
