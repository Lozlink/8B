import { useEffect, useRef } from "react";

/**
 * Runs an async loader on mount, whenever `load` changes identity, and whenever `trigger` changes.
 * The loader is invoked through a ref so state it sets after awaiting isn't mistaken for a synchronous
 * setState inside the effect body.
 */
export function useLoad(load: () => Promise<unknown>, trigger?: unknown): void {
  const ref = useRef(load);
  useEffect(() => {
    ref.current = load;
  }, [load]);
  useEffect(() => {
    void ref.current();
  }, [load, trigger]);
}
