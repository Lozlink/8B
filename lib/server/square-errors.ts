import "server-only";
import { AppError } from "./errors";

/** Square has this idempotency key on file against a different request body. */
export function isKeyReused(e: unknown): boolean {
  if (!(e instanceof AppError) || e.code !== "square_error") return false;
  const codes = e.detail?.codes;
  return Array.isArray(codes) && codes.includes("IDEMPOTENCY_KEY_REUSED");
}

/** The HTTP status Square answered with, when it answered at all. */
export function squareStatus(e: unknown): number | null {
  if (!(e instanceof AppError) || e.code !== "square_error") return null;
  const status = e.detail?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Square refused the request outright (a 4xx). Timeouts, network failures, 5xx and rate limiting
 * don't count: the request may still have gone through, or will if tried again.
 */
export function isSquareRejection(e: unknown): e is AppError {
  // A reused key means Square has already seen a different request for this attempt. That's not a
  // verdict on this one, and whatever the earlier request created may still be live.
  if (isKeyReused(e)) return false;
  const status = squareStatus(e);
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
