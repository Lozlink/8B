import { connection } from "next/server";
import { ok } from "@/lib/server/http";

/** Server clock for client offset correction. Unauthenticated: it reveals nothing but the time. */
export async function GET() {
  await connection();
  return ok({ now: new Date().toISOString() });
}
