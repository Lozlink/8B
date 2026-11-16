"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import type { FloorDTO, MeDTO } from "@/lib/domain/types";
import { api, ApiError } from "./api";
import { authRedirect } from "./errors";
import { useLocalTick } from "./ticker";
import { useLoad } from "./use-load";

interface FloorContextValue {
  floor: FloorDTO | null;
  me: MeDTO | null;
  /** serverNow - localNow, ms. */
  offsetMs: number;
  offline: boolean;
  /** Increments on every successful floor fetch (lets other views refresh alongside). */
  version: number;
  /** awaiting_payment sessions on the floor + bills already off the table. */
  unpaidCount: number;
  refetch: () => Promise<void>;
}

const FloorContext = createContext<FloorContextValue | null>(null);

export function useFloorOptional(): FloorContextValue | null {
  return useContext(FloorContext);
}

export function useFloor(): FloorContextValue {
  const ctx = useContext(FloorContext);
  if (!ctx) throw new Error("useFloor must be used inside <FloorProvider>");
  return ctx;
}

/** Server-corrected "now" in epoch ms, ticking every second. 0 until hydrated. */
export function useServerNow(): number {
  const tick = useLocalTick();
  const ctx = useContext(FloorContext);
  return tick === 0 ? 0 : tick + (ctx?.offsetMs ?? 0);
}

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

const POLL_MS = 20_000;
const RETRY_MS = 3_000;
const BROADCAST_MIN_GAP_MS = 1_000;
const TIME_SYNC_MS = 5 * 60_000;

export function FloorProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [floor, setFloor] = useState<FloorDTO | null>(null);
  const [me, setMe] = useState<MeDTO | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [failures, setFailures] = useState(0);
  const [version, setVersion] = useState(0);
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );

  const inflight = useRef<Promise<void> | null>(null);
  const queued = useRef(false);
  const failuresRef = useRef(0);
  const lastAttempt = useRef(0);

  const refetch = useCallback((): Promise<void> => {
    if (inflight.current) {
      queued.current = true;
      return inflight.current;
    }
    const run = (async () => {
      do {
        queued.current = false;
        lastAttempt.current = Date.now();
        try {
          const data = await api.floor();
          failuresRef.current = 0;
          setFailures(0);
          setFloor(data);
          setVersion((v) => v + 1);
        } catch (e) {
          const dest = authRedirect(e);
          if (dest) {
            router.replace(dest);
          } else if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
            failuresRef.current += 1;
            setFailures(failuresRef.current);
          }
        }
      } while (queued.current);
      inflight.current = null;
    })();
    inflight.current = run;
    return run;
  }, [router]);

  const syncTime = useCallback(async () => {
    const t0 = Date.now();
    try {
      const { now } = await api.time();
      const t1 = Date.now();
      setOffsetMs(Date.parse(now) - (t0 + t1) / 2);
    } catch {
      // keep the previous offset
    }
  }, []);

  // Initial load + who am I.
  useLoad(refetch);
  useLoad(syncTime);
  const meLoaded = me !== null;
  useEffect(() => {
    if (meLoaded) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      api
        .me()
        .then((r) => {
          if (!cancelled) setMe(r.me);
        })
        .catch((e: unknown) => {
          const dest = authRedirect(e);
          if (dest) router.replace(dest);
          else if (!cancelled) retry = setTimeout(attempt, 4000);
        });
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [router, meLoaded]);

  // Server clock offset every 5 minutes.
  useEffect(() => {
    const id = setInterval(() => void syncTime(), TIME_SYNC_MS);
    return () => clearInterval(id);
  }, [syncTime]);

  // Fallback poll (faster while failing so recovery is quick) + wake-up triggers.
  useEffect(() => {
    const id = setInterval(() => {
      const wait = failuresRef.current > 0 ? RETRY_MS : POLL_MS;
      if (Date.now() - lastAttempt.current >= wait - 250) void refetch();
    }, 1000);
    const wake = () => {
      if (document.visibilityState === "visible") {
        void refetch();
        void syncTime();
      }
    };
    const onOnline = () => {
      void refetch();
      void syncTime();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", wake);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", wake);
    };
  }, [refetch, syncTime]);

  // Supabase Realtime: a public "changed" broadcast that carries no data, just "refetch".
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    // Misconfigured (missing or still-encrypted) values must not take the floor down: skip Realtime
    // and rely on polling instead.
    if (!url || !key || !/^https?:\/\//.test(url)) return;
    let sb: ReturnType<typeof createClient>;
    try {
      sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch (e) {
      console.warn("[realtime] disabled:", e instanceof Error ? e.message : e);
      return;
    }
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const channel = sb
      .channel("floor")
      .on("broadcast", { event: "changed" }, () => {
        // Coalesce bursts, and never refetch more than about once a second because of pings:
        // each floor refetch also reloads whatever sheet or page is open, so a broadcast storm
        // must not turn into a request storm.
        clearTimeout(debounce);
        const sinceLast = Date.now() - lastAttempt.current;
        debounce = setTimeout(() => void refetch(), Math.max(150, BROADCAST_MIN_GAP_MS - sinceLast));
      })
      .subscribe((status) => {
        // Catch up on anything missed while (re)connecting.
        if (status === "SUBSCRIBED") void refetch();
      });
    return () => {
      clearTimeout(debounce);
      void sb.removeChannel(channel);
    };
  }, [refetch]);

  const unpaidCount = useMemo(() => {
    if (!floor) return 0;
    return floor.sessions.filter((s) => s.status === "awaiting_payment").length + floor.unpaidOffTableCount;
  }, [floor]);

  const offline = !online || failures >= 2;

  const value = useMemo<FloorContextValue>(
    () => ({ floor, me, offsetMs, offline, version, unpaidCount, refetch }),
    [floor, me, offsetMs, offline, version, unpaidCount, refetch],
  );

  return <FloorContext.Provider value={value}>{children}</FloorContext.Provider>;
}
