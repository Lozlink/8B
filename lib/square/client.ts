import "server-only";
import { SquareClient, SquareEnvironment, SquareError, SquareTimeoutError } from "square";
import { env } from "@/lib/server/env";
import { upstream } from "@/lib/server/errors";

let client: SquareClient | null = null;

/**
 * Square SDK v46 (API version 2026-09-16, pinned by the SDK release).
 * The environment is set explicitly: the SDK defaults to Production, which would make a
 * sandbox token fail with 401.
 */
export function square(): SquareClient {
  if (!client) {
    const e = env();
    client = new SquareClient({
      token: e.SQUARE_ACCESS_TOKEN,
      environment: e.SQUARE_ENVIRONMENT === "production" ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
      // Stay well inside the route's maxDuration. The SDK retries 408/429/5xx with the same
      // idempotency key, so a retry can't create a second checkout.
      timeoutInSeconds: 12,
      maxRetries: 1,
    });
  }
  return client;
}

export function squareErrorCodes(e: unknown): string[] {
  return e instanceof SquareError ? e.errors.map((x) => x.code) : [];
}

export function isSquareStatus(e: unknown, status: number): boolean {
  return e instanceof SquareError && e.statusCode === status;
}

/** Converts SDK errors into a message staff can act on. */
export function toUpstreamError(e: unknown, what: string) {
  if (e instanceof SquareTimeoutError) {
    return upstream(`Square didn't answer in time while trying to ${what}. Check the Terminal, then try again.`);
  }
  if (e instanceof SquareError) {
    const first = e.errors[0];
    const detail = first?.detail ?? e.message;
    return upstream(`Square couldn't ${what}: ${detail}`, {
      status: e.statusCode ?? null,
      codes: e.errors.map((x) => x.code),
    });
  }
  return upstream(`Couldn't reach Square to ${what}. Check the internet connection and try again.`);
}
