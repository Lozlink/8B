"use client";

import { useEffect, useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button, Notice } from "@/components/ui";
import { useAction } from "@/lib/client/use-action";
import { api } from "@/lib/client/api";
import { isManagerRequired } from "@/lib/client/errors";
import type { PairingCodeDTO } from "@/lib/domain/types";
import { TabHeader, type TabProps } from "./shared";

export function TerminalTab({ state, reload, onError }: TabProps) {
  const { run, pending } = useAction();
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
        .catch(() => {
          // keep polling; a transient error shouldn't kill the pairing screen
        });
    }, 3000);
    return () => clearInterval(id);
  }, [codeId, waiting, reload]);

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
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-brass bg-surface p-6 text-center">
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
              <p aria-live="polite" className="font-mono text-7xl font-bold tracking-[0.2em] text-brass sm:text-8xl">
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
