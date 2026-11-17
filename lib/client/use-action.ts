"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { ApiError } from "./api";
import { authRedirect, errorMessage } from "./errors";
import { useFloorOptional } from "./floor-context";

interface RunOptions {
  /** Show the message inline instead of as a toast (dialogs). */
  inline?: (message: string) => void;
  /** Refetch the floor afterwards, in the background (default true). */
  refetch?: boolean;
  /** Called for errors before the default handling; return true if handled. */
  onError?: (e: unknown) => boolean;
}

/** How long a card stays disabled after its action while the fresh floor is on its way. */
const SETTLE_MAX_MS = 3000;

function useExecutor() {
  const router = useRouter();
  const toast = useToast();
  const floor = useFloorOptional();
  const refetch = floor?.refetch;

  /**
   * Runs the call and resolves as soon as it settles. The floor refresh is NOT awaited here, so a slow
   * refresh can never hold buttons or a sheet. Returns the refresh promise via `settled` for callers
   * that want to keep one card disabled until it lands.
   */
  const execute = useCallback(
    async <T,>(fn: () => Promise<T>, opts: RunOptions): Promise<{ result: T | undefined; settled: Promise<void> }> => {
      const done = Promise.resolve();
      try {
        const result = await fn();
        return { result, settled: opts.refetch !== false && refetch ? refetch() : done };
      } catch (e) {
        if (opts.onError?.(e)) return { result: undefined, settled: done };
        const dest = authRedirect(e);
        if (dest) {
          router.replace(dest);
          return { result: undefined, settled: done };
        }
        if (opts.inline) opts.inline(errorMessage(e));
        else toast.show(errorMessage(e), "error");
        // State may have moved under us (another iPad): resync.
        return { result: undefined, settled: e instanceof ApiError && e.status === 409 && refetch ? refetch() : done };
      }
    },
    [router, toast, refetch],
  );
  return execute;
}

/**
 * Wraps a server call: blocks double taps, routes auth errors, shows errors, refreshes the floor in
 * the background. `pending` covers the call only. Returns undefined when the call failed.
 */
export function useAction() {
  const execute = useExecutor();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, opts: RunOptions = {}): Promise<T | undefined> => {
      if (busy.current) return undefined;
      busy.current = true;
      setPending(true);
      try {
        const { result } = await execute(fn, opts);
        return result;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [execute],
  );

  return { run, pending };
}

/**
 * Like `useAction`, but busy per key (a table), so one table's slow call doesn't disable the others.
 * `inFlight(key)`: the call itself is running (use for sheet locks).
 * `busy(key)`: the call is running or its fresh floor is still arriving (use to disable that card;
 * capped at a few seconds).
 */
export function useKeyedAction() {
  const execute = useExecutor();
  const [inflight, setInflight] = useState<ReadonlySet<string>>(new Set());
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const active = useRef(new Set<string>());

  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, opts: RunOptions = {}): Promise<T | undefined> => {
      if (active.current.has(key)) return undefined;
      active.current.add(key);
      setInflight((s) => new Set(s).add(key));
      const { result, settled } = await execute(fn, opts);
      setSettling((s) => new Set(s).add(key));
      setInflight((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
      void Promise.race([settled, new Promise<void>((r) => setTimeout(r, SETTLE_MAX_MS))]).then(() => {
        active.current.delete(key);
        setSettling((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      });
      return result;
    },
    [execute],
  );

  const inFlight = useCallback((key: string) => inflight.has(key), [inflight]);
  const busy = useCallback((key: string) => inflight.has(key) || settling.has(key), [inflight, settling]);
  return { run, inFlight, busy };
}
