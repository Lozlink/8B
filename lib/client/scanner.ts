import { cleanBarcode, normaliseBarcode } from "./barcode";

/**
 * Hardware scanners paired to an iPad type like a keyboard: the digits arrive a few milliseconds apart,
 * then Enter. A person never types 6 keys with gaps this short. This module is the timing logic only
 * (fed key events, it says when a scan finished); the listener lives in use-scan-handler.ts.
 */

/** Keys closer together than this count as one burst. */
export const SCAN_GAP_MS = 60;
export const MIN_SCAN_LENGTH = 6;
/** A burst longer than any barcode can't be one; stop collecting it. */
const MAX_BUFFER = 32;

export interface KeyInput {
  key: string;
  timeMs: number;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  repeat?: boolean;
}

export interface ScanState {
  buffer: string;
  lastMs: number;
}

export const EMPTY_SCAN: ScanState = { buffer: "", lastMs: 0 };

export interface ScanStep {
  state: ScanState;
  /** The digits of a finished scan (padding kept), else null. */
  code: string | null;
  /** The key was the scanner's Enter: stop it doing anything else. */
  consume: boolean;
}

/** Keys that change what the next one means without being typing; they don't break a burst. */
const IGNORED = new Set(["Shift", "CapsLock"]);

export function scanStep(state: ScanState, ev: KeyInput): ScanStep {
  const reset: ScanStep = { state: EMPTY_SCAN, code: null, consume: false };
  if (ev.ctrl || ev.meta || ev.alt || ev.repeat) return reset;
  if (IGNORED.has(ev.key)) return { state, code: null, consume: false };

  const fast = state.buffer !== "" && ev.timeMs - state.lastMs >= 0 && ev.timeMs - state.lastMs < SCAN_GAP_MS;

  if (ev.key.length === 1) {
    // Past the cap, stop growing but keep the burst alive, so its Enter can't pass as a short scan.
    const buffer = fast && state.buffer.length > MAX_BUFFER ? state.buffer : (fast ? state.buffer : "") + ev.key;
    return { state: { buffer, lastMs: ev.timeMs }, code: null, consume: false };
  }

  if (ev.key === "Enter" && fast && state.buffer.length >= MIN_SCAN_LENGTH && normaliseBarcode(state.buffer) !== null) {
    return { state: EMPTY_SCAN, code: cleanBarcode(state.buffer), consume: true };
  }
  return reset;
}
