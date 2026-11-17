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
import { api } from "./api";
import { authRedirect } from "./errors";
import { useLocalTick } from "./ticker";
import { useLoad } from "./use-load";
import {
  connectionState,
  countsAsFloorFailure,
  floorFingerprint,
  pollIntervalMs,
  timeOffsetSample,
} from "./floor-logic";

interface FloorContextValue {
  floor: FloorDTO | null;
  me: MeDTO | null;
  /** serverNow - localNow, ms. */
  offsetMs: number;
  /** True when the screen should be covered: the device is offline or the server has been down a while. */
  offline: boolean;
  /** True when the server is struggling but not for long enough to cover the screen: show a banner. */
  degraded: boolean;
  /** Increments when a floor fetch brings a real change (lets other views refresh alongside). */
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

const BROADCAST_MIN_GAP_MS = 1_000;
const TIME_SYNC_MS = 5 * 60_000;
const TIME_RETRY_MS = 5_000;

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
  const fingerprint = useRef<string | null>(null);
  const realtimeUp = useRef(false);
  const syncTimeRef = useRef<() => Promise<void>>(async () => {});
  const timeRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
          // serverTime differs on every fetch; only a real change replaces the floor and bumps
          // `version`, so open sheets and pages don't reload for nothing.
          const fp = floorFingerprint(data);
          if (fp !== fingerprint.current) {
            fingerprint.current = fp;
            setFloor(data);
            setVersion((v) => v + 1);
          }
        } catch (e) {
          const dest = authRedirect(e);
          if (dest) {
            router.replace(dest);
          } else if (countsAsFloorFailure(false)) {
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
    clearTimeout(timeRetry.current);
    const t0 = Date.now();
    let offset: number | null = null;
    try {
      const { now } = await api.time();
      offset = timeOffsetSample(t0, Date.now(), Date.parse(now));
    } catch {
      // fall through to the retry
    }
    if (offset !== null) setOffsetMs(offset);
    else timeRetry.current = setTimeout(() => void syncTimeRef.current(), TIME_RETRY_MS); // keep the previous offset meanwhile
  }, []);
  useEffect(() => {
    syncTimeRef.current = syncTime;
    return () => clearTimeout(timeRetry.current);
  }, [syncTime]);

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
      const wait = pollIntervalMs(failuresRef.current, realtimeUp.current);
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
    if (!url || !key || !/^https?:\/\//.test(url)) {
      console.warn("[realtime] skipped: Supabase URL/key missing or not decrypted. Falling back to polling every 5 s.");
      return;
    }
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
        // While not subscribed the poll runs every 5 s instead of 20 s. The client reconnects by
        // itself; we only watch the status and never rebuild the channel.
        const up = status === "SUBSCRIBED";
        if (up !== realtimeUp.current) {
          if (!up) console.warn("[realtime] not connected:", status);
          realtimeUp.current = up;
        }
        // Catch up on anything missed while (re)connecting.
        if (up) void refetch();
      });
    return () => {
      realtimeUp.current = false;
      clearTimeout(debounce);
      void sb.removeChannel(channel);
    };
  }, [refetch]);

  const unpaidCount = useMemo(() => {
    if (!floor) return 0;
    return floor.sessions.filter((s) => s.status === "awaiting_payment").length + floor.unpaidOffTableCount;
  }, [floor]);

  const conn = connectionState(online, failures);
  const offline = conn === "offline";
  const degraded = conn === "degraded";

  const value = useMemo<FloorContextValue>(
    () => ({ floor, me, offsetMs, offline, degraded, version, unpaidCount, refetch }),
    [floor, me, offsetMs, offline, degraded, version, unpaidCount, refetch],
  );

  return <FloorContext.Provider value={value}>{children}</FloorContext.Provider>;
}
