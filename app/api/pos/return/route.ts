import { z } from "zod";
import { badRequest } from "@/lib/server/errors";
import { handler, ok } from "@/lib/server/http";
import { handlePosReturn } from "@/lib/server/pos-cash";

// Two Square reads at 8 s each at most, then a few queries.
export const maxDuration = 30;

// Square POS's whole callback is a few hundred bytes plus our ~330-character state.
const MAX_BODY_BYTES = 8 * 1024;
const body = z.object({ data: z.string().min(2).max(4000) });

/**
 * PUBLIC: no device or staff cookie. Square POS returns to /pos/return in Safari, which shares no
 * cookies with the home-screen app, and that page posts the callback's `data` here.
 *
 * What makes this safe to leave open is the signed `state` inside `data`: without one we issued in
 * the last 30 minutes the request costs a JSON parse and an HMAC, touches neither the database nor
 * Square, and changes nothing. With one, the sale is still read back from Square before the bill
 * is settled.
 */
export const POST = handler(async (req: Request) => {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw badRequest("Request too large.");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw badRequest("Request too large.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  return ok(await handlePosReturn(body.parse(json).data));
});
