"use client";

import { useEffect, useRef } from "react";
import { EMPTY_SCAN, scanStep, type ScanState } from "./scanner";

interface Entry {
  current: (code: string) => void;
}

/** Registered handlers, oldest first. Only the last one hears a scan: a sheet opened over the floor wins. */
const stack: Entry[] = [];
let state: ScanState = EMPTY_SCAN;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  // The search box takes scans too (and handles its own Enter).
  if (t.hasAttribute("data-scan-field")) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

/** Only a finished scan is ever passed on. Nothing typed is stored beyond the short burst buffer or logged. */
function onKeyDown(e: KeyboardEvent) {
  if (e.isComposing || isTypingTarget(e.target)) {
    state = EMPTY_SCAN;
    return;
  }
  const step = scanStep(state, {
    key: e.key,
    timeMs: e.timeStamp,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    alt: e.altKey,
    repeat: e.repeat,
  });
  state = step.state;
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
      state = EMPTY_SCAN;
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
