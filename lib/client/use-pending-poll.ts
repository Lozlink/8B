import { useEffect, useRef } from "react";

/**
 * While `active`, calls `reload` every `everyMs`, at most `times` times, then stops. For things that
 * change on the server without a floor broadcast (a refund Square is still processing). The count
 * restarts each time `active` goes from false to true. Skips a tick while the page is hidden.
 */
export function usePendingPoll(active: boolean, reload: () => Promise<unknown> | void, everyMs: number, times: number): void {
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    if (!active) return;
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      if (n > times) {
        clearInterval(id);
        return;
      }
      if (document.visibilityState === "visible") void reloadRef.current();
    }, everyMs);
    return () => clearInterval(id);
  }, [active, everyMs, times]);
}
