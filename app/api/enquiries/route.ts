import { after } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/server/auth";
import { createEnquiry, notifyEnquiry } from "@/lib/server/enquiries";
import { AppError } from "@/lib/server/errors";
import { handler, ok, readJson } from "@/lib/server/http";

/** Far more than the form can produce (a full message is about 2 KB). */
const MAX_BYTES = 32_000;

/**
 * The public site's functions and contact forms. No sign-in: anyone can send one, so everything is
 * checked, and slowed down per sender, in lib/server/enquiries.ts. The email to the venue goes out
 * after the reply, so the sender isn't kept waiting on SES and a mail failure can't fail the send.
 */
export const POST = handler(async (req: Request) => {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) {
    throw new AppError(413, "too_large", "That's too much to send in one go. Shorten the message and try again.");
  }
  const body = await readJson(req, z.unknown());
  const result = await createEnquiry(body, await clientIp());
  if (result.stored) {
    const { enquiry } = result;
    after(() => notifyEnquiry(enquiry));
  }
  return ok({ ok: true as const });
});
