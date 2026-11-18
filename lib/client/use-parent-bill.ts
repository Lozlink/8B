"use client";

import { useCallback, useRef, useState } from "react";
import { api } from "./api";
import { useLoad } from "./use-load";
import type { SessionDTO } from "@/lib/domain/types";

export interface ParentBill {
  /** The bill a part was split from, as it stands now. Null if it couldn't be read. */
  bill: SessionDTO | null;
  /** false until the first read has come back (or failed). */
  ready: boolean;
}

/**
 * For a part's sheet: the bill it was split from, read when `parentId` is set and again whenever
 * `refreshKey` changes. That bill lists all its parts, which is how a paid part finds the next one
 * to take payment for. A failed read leaves `bill` as it was (or null) and `ready` true, so the
 * sheet never waits on it.
 */
export function useParentBill(parentId: string | null, refreshKey: unknown): ParentBill {
  const [state, setState] = useState<{ id: string; bill: SessionDTO | null } | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!parentId) return;
    const mine = ++seq.current;
    try {
      const d = await api.session(parentId);
      if (mine === seq.current) setState({ id: parentId, bill: d.session });
    } catch {
      if (mine === seq.current) setState((prev) => (prev && prev.id === parentId ? prev : { id: parentId, bill: null }));
    }
  }, [parentId]);
  useLoad(load, refreshKey);
  if (!parentId || !state || state.id !== parentId) return { bill: null, ready: !parentId };
  return { bill: state.bill, ready: true };
}
