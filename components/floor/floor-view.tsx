"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DetailsDialog } from "@/components/bill-details";
import { ChargeSheet } from "@/components/charge-sheet";
import { SessionDetailSheet } from "@/components/session-detail-sheet";
import { Button, Sheet, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/client/api";
import { detailsOf } from "@/lib/client/bill-details";
import { withName } from "@/lib/client/bill-view";
import { findByBarcode } from "@/lib/client/barcode";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor, useServerNow } from "@/lib/client/floor-context";
import { useKeyedAction } from "@/lib/client/use-action";
import { useScanHandler } from "@/lib/client/use-scan-handler";
import type { SessionDTO, TableDTO } from "@/lib/domain/types";
import { formatClock } from "@/lib/format";
import { formatCents } from "@/lib/pricing";
import { estimate } from "@/lib/client/session-view";
import { TableCard, type CardActions } from "./table-card";

type Overlay =
  | { kind: "detail"; sessionId: string }
  /** `created`: the charge sheet of a counter sale just made here, which throws it away if closed empty. */
  | { kind: "charge"; sessionId: string; created?: boolean }
  | { kind: "transfer"; session: SessionDTO }
  | { kind: "stop"; session: SessionDTO }
  /** The session as it was when the dialog opened: the fields are filled from it once. */
  | { kind: "details"; session: SessionDTO }
  | null;

export function FloorView() {
  const { floor, offline } = useFloor();
  const router = useRouter();
  const nowMs = useServerNow();
  const toast = useToast();
  const { run, inFlight, busy } = useKeyedAction();
  const [overlay, setOverlay] = useState<Overlay>(null);

  const bySession = useMemo(() => {
    const map = new Map<string, SessionDTO>();
    if (!floor) return map;
    for (const s of floor.sessions) if (s.currentTableId) map.set(s.currentTableId, s);
    return map;
  }, [floor]);

  const actions: CardActions = useMemo(
    () => ({
      start: (t) => void run(t.id, () => api.start(t.id)),
      pause: (s) => void run(keyOf(s), () => api.pause(s.id)),
      resume: (s) => void run(keyOf(s), () => api.resume(s.id)),
      transfer: (s) => setOverlay({ kind: "transfer", session: s }),
      stop: (s) => setOverlay({ kind: "stop", session: s }),
      charge: (s) => setOverlay({ kind: "charge", sessionId: s.id }),
      detail: (s) => setOverlay({ kind: "detail", sessionId: s.id }),
      details: (s) => setOverlay({ kind: "details", session: s }),
    }),
    [run],
  );

  // Scanning with no bill open: one item starts a counter sale with it already on. Sheets register their
  // own handlers, which take over while they are open.
  const scanToCounterSale = (code: string) => {
    if (offline) {
      toast.show("No connection. Wait for it to come back before starting a sale.", "error");
      return;
    }
    const matches = findByBarcode(floor?.products ?? [], code);
    if (matches.length === 0) {
      toast.show(`No item has the barcode ${code}. Add it to the item in Square, then refresh under Admin → Items.`, "error");
      return;
    }
    if (matches.length > 1) {
      toast.show(`More than one item has the barcode ${code}. Start a counter sale and pick the item there.`, "error");
      return;
    }
    const item = matches[0];
    void run(COUNTER_KEY, async () => {
      const sale = await api.counterSale();
      try {
        await api.addItem(sale.sessionId, item.id, 1);
        toast.show(`${item.name} added, ${formatCents(item.priceCents)}`, "success");
      } catch (e) {
        // The sale exists; open it anyway (an empty one is thrown away when its sheet closes).
        const dest = authRedirect(e);
        if (dest) router.replace(dest);
        else toast.show(errorMessage(e), "error");
      }
      setOverlay({ kind: "charge", sessionId: sale.sessionId, created: true });
      return sale;
    });
  };
  useScanHandler(scanToCounterSale, overlay === null && !offline && !busy(COUNTER_KEY) && !!floor);

  if (!floor) return <Spinner label="Loading tables" />;

  const tables = floor.tables
    .filter((t) => t.active || bySession.has(t.id))
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const freeTables = tables.filter((t) => t.active && !bySession.has(t.id));

  const doStop = async (s: SessionDTO) => {
    const result = await run(keyOf(s), () => api.stop(s.id));
    if (!result) return;
    if (result.status === "void") {
      toast.show("No charge", "success");
      setOverlay(null);
    } else {
      setOverlay({ kind: "charge", sessionId: s.id });
    }
  };

  // A sale with no table (drinks, snacks, a quick charge). It opens straight in the charge sheet;
  // if the sheet is closed with nothing on it, the sheet throws the empty bill away.
  const startCounterSale = async () => {
    const r = await run(COUNTER_KEY, () => api.counterSale());
    if (r) setOverlay({ kind: "charge", sessionId: r.sessionId, created: true });
  };

  const doTransfer = async (s: SessionDTO, table: TableDTO) => {
    const ok = await run(keyOf(s), () => api.transfer(s.id, table.id));
    if (ok) {
      toast.show(withName(`Moved to ${table.name}`, s.customerName), "success");
      setOverlay(null);
    }
  };

  return (
    <>
      {/* Up here, well away from the Start buttons at the foot of each card. */}
      <div className="mb-4 flex justify-end">
        <Button disabled={busy(COUNTER_KEY)} onClick={() => void startCounterSale()}>
          {inFlight(COUNTER_KEY) ? "Opening…" : "Counter sale"}
        </Button>
      </div>

      {tables.length === 0 ? (
        <p className="py-16 text-center text-lg text-muted">No tables set up. A manager can add them under Admin.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tables.map((t) => (
            <li key={t.id} className="flex">
              <TableCard
                table={t}
                session={bySession.get(t.id) ?? null}
                pricing={floor.pricing}
                nowMs={nowMs}
                busy={busy(t.id)}
                actions={actions}
              />
            </li>
          ))}
        </ul>
      )}

      {overlay?.kind === "detail" ? (
        <SessionDetailSheet
          sessionId={overlay.sessionId}
          onClose={() => setOverlay(null)}
          onCharge={() => setOverlay({ kind: "charge", sessionId: overlay.sessionId })}
        />
      ) : null}

      {overlay?.kind === "charge" ? (
        <ChargeSheet sessionId={overlay.sessionId} discardIfEmpty={overlay.created === true} onClose={() => setOverlay(null)} />
      ) : null}

      {overlay?.kind === "transfer" ? (
        <Sheet title={withName(`Transfer from ${tableName(floor.tables, overlay.session.currentTableId)}`, overlay.session.customerName)} onClose={() => setOverlay(null)} locked={inFlight(keyOf(overlay.session))}>
          {freeTables.length === 0 ? (
            <p className="py-6 text-center text-lg text-muted">No free tables to move to.</p>
          ) : (
            <>
              <p className="mb-3 text-muted">Pick a free table. The clock keeps running; billing follows the session.</p>
              <ul className="grid grid-cols-2 gap-3">
                {freeTables.map((t) => (
                  <li key={t.id}>
                    <Button size="lg" full disabled={busy(keyOf(overlay.session))} onClick={() => void doTransfer(overlay.session, t)}>
                      {t.name}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Sheet>
      ) : null}

      {overlay?.kind === "details" ? (
        <DetailsDialog
          sessionId={overlay.session.id}
          subject={tableName(floor.tables, overlay.session.currentTableId)}
          initial={detailsOf(overlay.session)}
          onClose={() => setOverlay(null)}
        />
      ) : null}

      {overlay?.kind === "stop" ? (
        <StopConfirm
          session={overlay.session}
          tableLabel={tableName(floor.tables, overlay.session.currentTableId)}
          pending={inFlight(keyOf(overlay.session))}
          onCancel={() => setOverlay(null)}
          onConfirm={() => void doStop(overlay.session)}
        />
      ) : null}
    </>
  );
}

/** Busy key for the Counter sale button. */
const COUNTER_KEY = "counter-sale";

/** Busy key for a session's actions: its table (so the card disables), else the session. */
function keyOf(s: SessionDTO): string {
  return s.currentTableId ?? s.id;
}

function tableName(tables: TableDTO[], id: string | null): string {
  return tables.find((t) => t.id === id)?.name ?? "table";
}

function StopConfirm({
  session,
  tableLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  session: SessionDTO;
  tableLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { floor } = useFloor();
  const nowMs = useServerNow();
  const est = floor ? estimate(session, floor.pricing, nowMs) : null;
  return (
    <Sheet title={`Stop ${withName(tableLabel, session.customerName)}?`} onClose={onCancel} locked={pending}>
      <div className="flex flex-col gap-5">
        <p className="text-lg">
          Played so far: <strong className="tabular-nums">{est ? formatClock(est.actualMs) : "—"}</strong>
        </p>
        <p className="text-muted">This stops the clock and moves to payment.</p>
        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={onCancel} disabled={pending}>
            Keep playing
          </Button>
          <Button size="lg" variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? "Stopping…" : "Stop and charge"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
