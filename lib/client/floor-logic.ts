import type { FloorDTO } from "@/lib/domain/types";

/**
 * A stable summary of everything on the floor payload that matters to the screen. `serverTime` is
 * different on every fetch, so it is left out; otherwise every poll would look like a change.
 */
export function floorFingerprint(floor: FloorDTO): string {
  const { serverTime, ...rest } = floor;
  void serverTime;
  return JSON.stringify(rest);
}

/** Realtime is the fast path. Until it is confirmed up, poll quickly. */
export const POLL_MS = 20_000;
export const POLL_UNSUBSCRIBED_MS = 5_000;
export const RETRY_MS = 3_000;

export function pollIntervalMs(failures: number, realtimeSubscribed: boolean): number {
  if (failures > 0) return RETRY_MS;
  return realtimeSubscribed ? POLL_MS : POLL_UNSUBSCRIBED_MS;
}

/** Consecutive failed floor fetches before we say the server is struggling / fully cover the screen. */
export const DEGRADED_AFTER = 2;
export const OFFLINE_AFTER = 5;

export type ConnectionState = "ok" | "degraded" | "offline";

/**
 * "offline" (full-screen) only when the device itself is offline or the server has been failing for a
 * good while. A short run of failures is "degraded": a banner, nothing covered.
 */
export function connectionState(browserOnline: boolean, failures: number): ConnectionState {
  if (!browserOnline || failures >= OFFLINE_AFTER) return "offline";
  if (failures >= DEGRADED_AFTER) return "degraded";
  return "ok";
}

/** A floor fetch that failed in a way worth counting: anything except an auth redirect (handled apart). */
export function countsAsFloorFailure(isAuthRedirect: boolean): boolean {
  return !isAuthRedirect;
}

export const MAX_TIME_RTT_MS = 2_000;

/**
 * Server clock offset (serverNow - localNow) from one /api/time round trip, or null if the round trip
 * was too slow to trust (error is up to half of it).
 */
export function timeOffsetSample(t0: number, t1: number, serverMs: number): number | null {
  if (!Number.isFinite(serverMs) || t1 < t0 || t1 - t0 > MAX_TIME_RTT_MS) return null;
  // Rounded: the midpoint of an odd-length round trip is half a millisecond, and a clock with a
  // fraction in it is no use to anything that counts in whole milliseconds (the pricing engine).
  return Math.round(serverMs - (t0 + t1) / 2);
}
