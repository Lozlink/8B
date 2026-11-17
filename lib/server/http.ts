import "server-only";
import { NextResponse, connection } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { ZodError, type ZodType } from "zod";
import { TransitionError } from "@/lib/domain/machine";
import { isPricingError } from "@/lib/pricing";
import { AppError, badRequest } from "./errors";
import { PG, pgCode, pgConstraint } from "./db";

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: Record<string, unknown> };
}

const CONSTRAINT_MESSAGES: Record<string, string> = {
  sessions_one_per_table: "That table already has a session.",
  session_intervals_one_open_per_table: "That table is already running.",
  session_intervals_one_open_per_session: "This session is already running on a table.",
  session_intervals_no_table_overlap: "Those times overlap another session on the same table.",
  session_intervals_no_session_overlap: "Those times overlap each other.",
  staff_active_name_uniq: "Someone with that name already exists.",
  tables_name_uniq: "A table with that name already exists.",
};

export function errorResponse(e: unknown): NextResponse<ApiErrorBody> {
  if (e instanceof AppError) {
    return NextResponse.json({ error: { code: e.code, message: e.message, detail: e.detail } }, { status: e.status });
  }
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return NextResponse.json(
      { error: { code: "bad_request", message: `${where}${first?.message ?? "Invalid request"}` } },
      { status: 400 },
    );
  }
  if (e instanceof TransitionError) {
    return NextResponse.json({ error: { code: "invalid_transition", message: e.message } }, { status: 409 });
  }
  if (isPricingError(e)) {
    return NextResponse.json({ error: { code: `pricing_${e.code.toLowerCase()}`, message: e.message, detail: e.detail } }, { status: 409 });
  }
  const code = pgCode(e);
  if (code === PG.LOCK_NOT_AVAILABLE) {
    // A lock wait ran out (see lockSession: every bill action caps its lock waits). The bill's own
    // lock is reported by lockSession; this is any other row the same transaction waited on.
    return NextResponse.json(
      { error: { code: "busy", message: "Someone else is changing this right now. Give it a few seconds and try again." } },
      { status: 409 },
    );
  }
  if (code === PG.UNIQUE || code === PG.EXCLUSION || code === PG.CHECK) {
    const constraint = pgConstraint(e);
    const message = (constraint && CONSTRAINT_MESSAGES[constraint]) ?? "That change conflicts with the current state. Refresh and try again.";
    return NextResponse.json({ error: { code: "conflict", message, detail: constraint ? { constraint } : undefined } }, { status: 409 });
  }
  console.error("[api] unhandled error", e);
  return NextResponse.json({ error: { code: "internal", message: "Something went wrong. Try again." } }, { status: 500 });
}

/**
 * Wraps a route handler so thrown errors become JSON responses with sensible status codes.
 * Every API route is request-time by nature: `connection()` declares that up front (outside the
 * try), so Next's prerender bail-out never reaches our catch. Any other framework-internal error
 * (redirect/notFound/dynamic bail-out) is rethrown rather than reported as a crash.
 */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    await connection();
    try {
      return await fn(...args);
    } catch (e) {
      unstable_rethrow(e);
      return errorResponse(e);
    }
  };
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  return schema.parse(body);
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, { ...init, headers: { "cache-control": "no-store", ...init?.headers } });
}
