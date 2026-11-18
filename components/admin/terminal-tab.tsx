"use client";

import { useEffect, useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button, Notice } from "@/components/ui";
import { useAction } from "@/lib/client/use-action";
import { api } from "@/lib/client/api";
import { isManagerRequired } from "@/lib/client/errors";
import { useFloor } from "@/lib/client/floor-context";
import { useStandDevice } from "@/lib/client/stand";
import type { PairingCodeDTO } from "@/lib/domain/types";
import { TabHeader, type TabProps } from "./shared";

export function TerminalTab({ state, reload, onError }: TabProps) {
  const { run, pending } = useAction();
  const { floor } = useFloor();
  const [onStand, setOnStand] = useStandDevice();
  const [pairing, setPairing] = useState<PairingCodeDTO | null>(null);
  const [unpairing, setUnpairing] = useState(false);
  const deviceId = state.settings.terminalDeviceId;
  const sandbox = state.squareEnvironment === "sandbox";

  const codeId = pairing?.codeId ?? null;
  const waiting = pairing !== null && (pairing.status === "UNPAIRED" || pairing.status === "UNKNOWN");

  // Poll every 3 s until the Terminal pairs or the code expires.
  useEffect(() => {
    if (!codeId || !waiting) return;
    const id = setInterval(() => {
      api
        .pairStatus(codeId)
        .then((next) => {
          setPairing(next);
          if (next.status === "PAIRED") void reload();
        })
        .catch((e: unknown) => {
          // Elevation expired: onError re-prompts for the PIN. Anything else is transient, keep polling.
          onError(e);
        });
    }, 3000);
    return () => clearInterval(id);
  }, [codeId, waiting, reload, onError]);

  const startPairing = async () => {
    const code = await run(() => api.pairTerminal(), { refetch: false, onError: (e) => (isManagerRequired(e) ? onError(e) : false) });
    if (code) setPairing(code);
  };

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <TabHeader title="Square Terminal" />
      {state.squareEnvironment === null ? (
        <Notice tone="warn">
          Square isn&rsquo;t configured on the server, so Charge card and pairing are off. Staff can still ring up in
          Square POS and use Mark paid.
        </Notice>
      ) : null}
      {sandbox ? (
        <Notice tone="warn">Square is in sandbox mode. Pairing a real Terminal only works in production.</Notice>
      ) : null}

      <div className="rounded-2xl border border-line bg-surface p-4">
        <p className="text-sm font-semibold text-muted">Paired device</p>
        <p className="mt-1 break-all text-xl font-semibold">{deviceId ?? "None paired"}</p>
      </div>

      {pairing ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-accent bg-surface p-6 text-center">
          {pairing.status === "PAIRED" ? (
            <>
              <p className="text-2xl font-bold text-chalk">Terminal paired</p>
              <Button size="lg" onClick={() => setPairing(null)}>
                Done
              </Button>
            </>
          ) : pairing.status === "EXPIRED" ? (
            <>
              <p className="text-xl font-semibold text-warn">Code expired</p>
              <Button variant="primary" size="lg" disabled={pending} onClick={() => void startPairing()}>
                Get a new code
              </Button>
            </>
          ) : (
            <>
              <p className="text-lg text-muted">On the Terminal, choose Sign in, then enter this code</p>
              <p aria-live="polite" className="font-mono text-7xl font-bold tracking-[0.2em] text-accent sm:text-8xl">
                {pairing.code}
              </p>
              <p className="text-muted">Waiting for the Terminal… the code lasts 5 minutes.</p>
              <Button onClick={() => setPairing(null)}>Stop waiting</Button>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" size="lg" disabled={pending} onClick={() => void startPairing()}>
            {deviceId ? "Pair a different Terminal" : "Pair Terminal"}
          </Button>
          {deviceId ? (
            <Button variant="danger" size="lg" onClick={() => setUnpairing(true)}>
              Unpair
            </Button>
          ) : null}
        </div>
      )}

      {floor?.posCashAvailable ? (
        <div className="flex items-start justify-between gap-4 rounded-2xl border border-line bg-surface p-4">
          <div className="min-w-0">
            <p id="stand-label" className="text-lg font-semibold">
              This iPad is on the Square Stand
            </p>
            <p className="mt-1 text-base text-muted">
              {onStand
                ? "On: cash opens Square POS with the amount filled in, and the drawer opens there."
                : "Off: Mark paid – cash only records the sale. Turn this on for the iPad that sits on the Stand. It only affects this iPad."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={onStand}
            aria-labelledby="stand-label"
            onClick={() => setOnStand(!onStand)}
            className={`flex h-12 w-20 shrink-0 items-center rounded-full border px-1 transition-colors ${
              onStand ? "justify-end border-brand bg-brand" : "justify-start border-line bg-surface-2"
            }`}
          >
            <span aria-hidden className="size-9 rounded-full bg-white shadow" />
          </button>
        </div>
      ) : null}

      {unpairing ? (
        <ActionDialog
          title="Unpair Terminal"
          description="Card checkouts stop working until a Terminal is paired again. Staff can still use Square POS and Mark paid."
          submitLabel="Unpair"
          danger
          onClose={() => setUnpairing(false)}
          onError={onError}
          onSubmit={async ({ reason }) => {
            await api.unpairTerminal(reason);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}
