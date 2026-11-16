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
  /** Refetch the floor afterwards (default true). */
  refetch?: boolean;
  /** Called for errors before the default handling; return true if handled. */
  onError?: (e: unknown) => boolean;
}

/**
 * Wraps a server call: blocks double taps, routes auth errors, shows errors, refetches the floor.
 * Returns undefined when the call failed.
 */
export function useAction() {
  const router = useRouter();
  const toast = useToast();
  const floor = useFloorOptional();
  const refetch = floor?.refetch;
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, opts: RunOptions = {}): Promise<T | undefined> => {
      if (busy.current) return undefined;
      busy.current = true;
      setPending(true);
      try {
        const result = await fn();
        if (opts.refetch !== false) void refetch?.();
        return result;
      } catch (e) {
        if (opts.onError?.(e)) return undefined;
        const dest = authRedirect(e);
        if (dest) {
          router.replace(dest);
          return undefined;
        }
        if (opts.inline) opts.inline(errorMessage(e));
        else toast.show(errorMessage(e), "error");
        // State may have moved under us (another iPad): resync.
        if (e instanceof ApiError && e.status === 409) void refetch?.();
        return undefined;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [router, toast, refetch],
  );

  return { run, pending };
}
