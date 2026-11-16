import { z } from "zod";
import { checkEnrolCode, setDeviceCookie } from "@/lib/server/auth";
import { enrolDevice } from "@/lib/server/admin";
import { handler, ok, readJson } from "@/lib/server/http";
import { name, pin } from "@/lib/server/schemas";

const body = z.object({
  code: z.string().min(1).max(200),
  label: z.string().trim().min(1).max(40),
  firstManager: z.object({ name, pin }).optional(),
});

export const POST = handler(async (req: Request) => {
  const b = await readJson(req, body);
  await checkEnrolCode(b.code);
  const device = await enrolDevice(b.label, b.firstManager);
  await setDeviceCookie(device.id, device.label);
  return ok({ device });
});
