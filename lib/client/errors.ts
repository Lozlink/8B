import { ApiError } from "./api";

/** Where to send the user for an auth failure, or null if the error isn't one. */
export function authRedirect(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 401) return null;
  if (e.code === "device_not_enrolled") return "/enrol";
  if (e.code === "unauthorized") return "/login";
  return null;
}

export function isManagerRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403 && e.code === "manager_required";
}

/**
 * 409 `bill_changed`: the bill's amount moved (another iPad, or an item or discount change) between
 * the screen showing it and the tap. Nothing was done; reload the bill and let staff read it again.
 */
export function isBillChanged(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && e.code === "bill_changed";
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong. Try again.";
}
