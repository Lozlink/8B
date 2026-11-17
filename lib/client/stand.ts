"use client";

import { useCallback, useSyncExternalStore } from "react";

const KEY = "tt_pos_cash_stand";
const EVENT = "tt-stand-change";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/**
 * Whether THIS iPad is the one on the Square Stand, so cash goes through Square POS and opens the
 * drawer. Kept on the device (localStorage), off by default.
 */
export function useStandDevice(): readonly [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => {
    try {
      if (next) window.localStorage.setItem(KEY, "1");
      else window.localStorage.removeItem(KEY);
    } catch {
      // private mode or storage full: the switch just won't stick
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [on, set];
}
