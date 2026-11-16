import { useSyncExternalStore } from "react";

/** One shared 1 s timer for every clock on screen. */
let last = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick() {
  last = Date.now();
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) {
    last = Date.now();
    timer = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  if (last === 0) last = Date.now();
  return last;
}

/** Local epoch ms, refreshed every second. 0 during server render. */
export function useLocalTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
