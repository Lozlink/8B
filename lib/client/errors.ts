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

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong. Try again.";
}
