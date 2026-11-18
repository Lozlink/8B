"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useFloorOptional } from "@/lib/client/floor-context";
import { RECEIPT_SENT } from "@/lib/client/refund-view";
import { useAction } from "@/lib/client/use-action";
import type { SessionDTO } from "@/lib/domain/types";

/** A second tap right after the first would print a second copy. */
const COOLDOWN_MS = 4000;
/**
 * A cash sale reaches Square a moment after the tap, so the Terminal can't print it for a second
 * or two. Look again twice, then leave it (the detail sheet shows the button once it is ready).
 */
const RECHECK_AT_MS = [1500, 4500] as const;

/** Sessions with a print request on the wire, so reopening the sheet can't start a second one. */
const inFlight = new Set<string>();

interface Props {
  session: Pick<SessionDTO, "id" | "canPrintReceipt">;
  /**
   * Reload the screen's copy of the session. When given and a receipt isn't printable yet, it is
   * called up to twice (not in a loop) so the button can appear on its own.
   */
  recheck?: () => Promise<void>;
  /** True while the request is out; lets a sheet that closes itself hold off. */
  onBusyChange?: (busy: boolean) => void;
  /** Called once Square has accepted a print request. */
  onSent?: () => void;
  size?: "md" | "lg";
  variant?: "primary" | "secondary" | "brass";
  className?: string;
}

/** "Print receipt": asks the Square Terminal to print this bill's receipt. Renders nothing when it can't. */
export function ReceiptButton({ session, recheck, onBusyChange, onSent, size = "lg", variant = "secondary", className }: Props) {
  const toast = useToast();
  const floor = useFloorOptional()?.floor;
  const terminalPaired = floor?.terminalPaired ?? false;
  const { run, pending } = useAction();
  const [cooling, setCooling] = useState(false);
  const coolTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recheckRef = useRef(recheck);
  const busyRef = useRef(onBusyChange);
  const sentRef = useRef(onSent);
  useEffect(() => {
    recheckRef.current = recheck;
    busyRef.current = onBusyChange;
    sentRef.current = onSent;
  });

  const canPrint = session.canPrintReceipt;
  const wantsRecheck = !!recheck && !canPrint && terminalPaired;

  useEffect(() => {
    if (!wantsRecheck) return;
    const timers = RECHECK_AT_MS.map((ms) => setTimeout(() => void recheckRef.current?.(), ms));
    return () => timers.forEach(clearTimeout);
  }, [wantsRecheck, session.id]);

  useEffect(() => () => clearTimeout(coolTimer.current), []);

  // Tell a sheet that would close itself to wait until the request is done.
  useEffect(() => {
    busyRef.current?.(pending);
    return () => busyRef.current?.(false);
  }, [pending]);

  const print = async () => {
    if (inFlight.has(session.id)) return;
    inFlight.add(session.id);
    try {
      const done = await run(
        async () => {
          await api.printReceipt(session.id);
          return true as const;
        },
        { refetch: false },
      );
      if (done) {
        toast.show(RECEIPT_SENT, "success");
        sentRef.current?.();
        setCooling(true);
        clearTimeout(coolTimer.current);
        coolTimer.current = setTimeout(() => setCooling(false), COOLDOWN_MS);
      }
    } finally {
      inFlight.delete(session.id);
    }
  };

  if (!canPrint && !pending && !cooling) return null;

  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={pending || cooling || !canPrint}
      onClick={() => void print()}
    >
      {pending ? "Sending…" : cooling ? "Sent to the Terminal" : "Print receipt"}
    </Button>
  );
}
