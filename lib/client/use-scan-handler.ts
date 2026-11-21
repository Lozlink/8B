"use client";

import { useEffect, useRef } from "react";
import { EMPTY_SCAN, SCAN_IDLE_MS, isTrailingSuffix, scanIdle, scanStep, type ScanState } from "./scanner";

interface Entry {
  current: (code: string) => void;
}

/** Registered handlers, oldest first. Only the last one hears a scan: a sheet opened over the floor wins. */
const stack: Entry[] = [];
let state: ScanState = EMPTY_SCAN;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
/** When (on the event clock) the last scan finished by going quiet, so its late Enter can be swallowed. */
let idleScanAt: number | null = null;

function reset() {
  clearTimeout(idleTimer);
  state = EMPTY_SCAN;
}

/** The digits stopped with no Enter after them: a scanner set up to send no suffix, or a slow one. */
function onIdle() {
  const code = scanIdle(state);
  state = EMPTY_SCAN;
  const top = stack[stack.length - 1];
  if (code === null || !top) return;
  idleScanAt = performance.now(); // the same clock as KeyboardEvent.timeStamp
  top.current(code);
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  // The search box takes scans too (and handles its own Enter).
  if (t.hasAttribute("data-scan-field")) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

/** Only a finished scan is ever passed on. Nothing typed is stored beyond the short burst buffer or logged. */
function onKeyDown(e: KeyboardEvent) {
  if (isTrailingSuffix({ key: e.key, timeMs: e.timeStamp }, idleScanAt)) {
    // Left alone, this Enter would press whatever button has the focus.
    idleScanAt = null;
    e.preventDefault();
    return;
  }
  if (e.isComposing || isTypingTarget(e.target)) {
    reset();
    return;
  }
  clearTimeout(idleTimer);
  const step = scanStep(state, {
    key: e.key,
    timeMs: e.timeStamp,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    alt: e.altKey,
    repeat: e.repeat,
  });
  state = step.state;
  if (state.buffer !== "") idleTimer = setTimeout(onIdle, SCAN_IDLE_MS);
  const top = stack[stack.length - 1];
  if (step.code === null || !top) return;
  if (step.consume) e.preventDefault();
  top.current(step.code);
}

function register(entry: Entry): () => void {
  if (stack.length === 0) window.addEventListener("keydown", onKeyDown, true);
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0) {
      window.removeEventListener("keydown", onKeyDown, true);
      reset();
      idleScanAt = null;
    }
  };
}

/**
 * Calls `handler` with the digits of each barcode scanned while this is the most recently registered
 * enabled handler. The latest `handler` is always used; changing it doesn't move it in the stack.
 */
export function useScanHandler(handler: (code: string) => void, enabled: boolean): void {
  const entry = useRef<Entry>({ current: handler });
  useEffect(() => {
    entry.current.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    return register(entry.current);
  }, [enabled]);
}
