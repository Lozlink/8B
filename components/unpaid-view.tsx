"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ChargeSheet } from "@/components/charge-sheet";
import { Notice, Spinner } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor } from "@/lib/client/floor-context";
import { adjustmentsSummary, billName, itemCount, itemsLabel, sessionBill } from "@/lib/client/bill-view";
import { checkoutLabel, sessionSpan } from "@/lib/client/session-view";
import type { SessionDTO } from "@/lib/domain/types";
import { formatDateTime, formatTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";

export function UnpaidView() {
  const router = useRouter();
  const { version } = useFloor();
  const [sessions, setSessions] = useState<SessionDTO[] | null>(null);
  const [tz, setTz] = useState("Australia/Sydney");
  const [error, setError] = useState<string | null>(null);
  const [chargeId, setChargeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.unpaid();
      setSessions(r.sessions);
      setTz(r.timezone);
      setError(null);
    } catch (e) {
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else setError(errorMessage(e));
    }
  }, [router]);

  // Reload on mount and whenever the floor refreshes (changes anywhere trigger a floor refetch).
  useLoad(load, version);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-bold">Unpaid</h1>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!sessions ? (
        error ? null : <Spinner />
      ) : sessions.length === 0 ? (
        <p className="py-16 text-center text-lg text-muted">Nothing unpaid. All bills are settled.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sessions.map((s) => {
            // A counter sale or a part has no table time, so it shows when it was opened.
            const span = s.kind === "table" ? sessionSpan(s) : { start: s.openedAt, end: null };
            const sub = checkoutLabel(s);
            const bill = sessionBill(s);
            const adjustments = bill ? adjustmentsSummary(bill) : null;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setChargeId(s.id)}
                  className="flex min-h-20 w-full items-center justify-between gap-4 rounded-2xl border-2 border-[#c18a22] bg-surface p-4 text-left active:bg-surface-2"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-xl font-bold">{billName(s)}</span>
                    <span className="text-base text-muted tabular-nums">
                      {span.start ? formatDateTime(span.start, tz) : "—"}
                      {span.end ? ` – ${formatTime(span.end, tz)}` : ""}
                      {s.kind === "table" && s.billedMinutes !== null ? ` · ${s.billedMinutes} min` : ""}
                      {s.kind !== "part" && s.items.length > 0 ? ` · ${itemsLabel(itemCount(s.items))}` : ""}
                    </span>
                    {adjustments ? <span className="text-base text-muted">{adjustments}</span> : null}
                    <span
                      className={`text-base font-semibold ${sub.tone === "warn" ? "text-warn" : sub.tone === "info" ? "text-info" : "text-muted"}`}
                    >
                      {sub.label}
                    </span>
                  </span>
                  <span className="text-3xl font-bold tabular-nums">{s.totalCents !== null ? formatCents(s.totalCents) : "—"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {chargeId ? (
        <ChargeSheet
          sessionId={chargeId}
          onClose={() => {
            setChargeId(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
