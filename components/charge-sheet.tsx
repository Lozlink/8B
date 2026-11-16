"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/action-dialog";
import { Badge, Button, Notice, Sheet, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor } from "@/lib/client/floor-context";
import { useAction } from "@/lib/client/use-action";
import { isCheckoutLive } from "@/lib/domain/machine";
import type { SessionDetailDTO } from "@/lib/domain/types";
import { formatCents, gstOf } from "@/lib/pricing";
import { checkoutLabel, sessionTableNames } from "@/lib/client/session-view";

const ALREADY_PAID = "Card payment already went through — this bill is paid. Don't take cash.";
const SYNC_MS = 5000;

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function ChargeSheet({ sessionId, onClose }: Props) {
  const router = useRouter();
  const toast = useToast();
  const { floor, refetch } = useFloor();
  const { run, pending } = useAction();
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"choose" | "cash">("choose");
  const [confirmCard, setConfirmCard] = useState(false);
  const [alreadyCard, setAlreadyCard] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setDetail(await api.session(sessionId));
      setLoadError(null);
    } catch (e) {
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else setLoadError(errorMessage(e));
    }
  }, [sessionId, router]);

  useLoad(load);

  const session = detail?.session ?? null;
  const live = !!session && session.status === "awaiting_payment" && isCheckoutLive(session.checkout?.status);

  // While the "Sent to Terminal" panel is open, ask Square every 5 s (the webhook also reconciles).
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      void (async () => {
        try {
          await api.sync(sessionId);
        } catch {
          // transient; the next tick or the webhook will catch up
        }
        await load();
        void refetch();
      })();
    }, SYNC_MS);
    return () => clearInterval(id);
  }, [live, sessionId, load, refetch]);

  const paid = session?.status === "paid";
  const quietPaid = paid && warnings.length === 0 && !alreadyCard;
  useEffect(() => {
    if (!quietPaid) return;
    const id = setTimeout(onClose, 2500);
    return () => clearTimeout(id);
  }, [quietPaid, onClose]);

  const act = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    const result = await run(fn);
    await load();
    return result;
  };

  const handleCharge = async (kind: "charge" | "resend") => {
    const r = await act(() => (kind === "charge" ? api.charge(sessionId) : api.resend(sessionId)));
    if (r?.kind === "already_paid_by_card") setAlreadyCard(true);
  };

  const handleCancel = async () => {
    const r = await act(() => api.cancelCheckout(sessionId));
    if (!r) return;
    if (r.warnings.length) setWarnings(r.warnings);
    if (r.paid) setAlreadyCard(true);
  };

  const handleMarkPaid = async (method: "card" | "cash") => {
    const r = await act(() => api.markPaid(sessionId, method, method === "card"));
    if (!r) return;
    if (r.warnings.length) setWarnings(r.warnings);
    if (r.kind === "already_paid_by_card") setAlreadyCard(true);
  };

  const handleRelease = async () => {
    const r = await run(() => api.release(sessionId));
    if (r) {
      toast.show("Table freed. Bill is on the Unpaid list.", "success");
      onClose();
    }
  };

  const title = session ? `Charge ${sessionTableNames(session)}` : "Charge";

  return (
    <Sheet title={title} onClose={onClose} locked={pending}>
      {!detail ? (
        loadError ? (
          <div className="flex flex-col gap-3">
            <Notice tone="danger">{loadError}</Notice>
            <Button size="lg" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <Spinner />
        )
      ) : (
        <div className="flex flex-col gap-5">
          {alreadyCard ? (
            <Notice tone="danger" strong>
              {ALREADY_PAID}
            </Notice>
          ) : null}
          {warnings.length > 0 ? (
            <Notice tone="warn">
              <ul className="list-disc pl-5">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <Total detail={detail} />

          {session && session.status === "paid" ? (
            <PaidPanel detail={detail} onClose={onClose} />
          ) : session && session.status === "void" ? (
            <>
              <Notice tone="warn">This bill was voided{session.voidReason ? `: ${session.voidReason}` : "."}</Notice>
              <Button size="lg" onClick={onClose}>
                Close
              </Button>
            </>
          ) : session && session.status !== "awaiting_payment" ? (
            <>
              <Notice tone="warn">This session is still {session.status}. Stop it from the floor first.</Notice>
              <Button size="lg" onClick={onClose}>
                Close
              </Button>
            </>
          ) : live && session ? (
            <TerminalPanel
              detail={detail}
              pending={pending}
              onCancel={() => void handleCancel()}
              onResend={() => void handleCharge("resend")}
              onMarkPaid={() => setConfirmCard(true)}
            />
          ) : mode === "cash" ? (
            <div className="flex flex-col gap-4">
              <Notice tone="info" strong>
                Ring &lsquo;Table hire&rsquo; for {formatCents(session?.totalCents ?? detail.breakdown?.totalCents ?? 0)} as Cash in
                Square POS — the drawer will open. Then tap Mark paid – cash.
              </Notice>
              <Button variant="primary" size="lg" disabled={pending} onClick={() => void handleMarkPaid("cash")}>
                {pending ? "Saving…" : "Mark paid – cash"}
              </Button>
              <Button size="lg" disabled={pending} onClick={() => setMode("choose")}>
                Back
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {session?.checkout?.status === "CANCELED" ? <Notice tone="warn">Card not completed. Charge again or take another payment.</Notice> : null}
              {session?.checkout?.status === "COMPLETED" ? <Notice tone="info">Card approved. Confirming with Square…</Notice> : null}
              {floor && !floor.terminalPaired ? (
                <Notice tone="warn">No Terminal is paired. Ring it up in Square POS, then tap Mark paid – card.</Notice>
              ) : null}
              <Button
                variant="primary"
                size="lg"
                disabled={pending || !floor || !floor.terminalPaired}
                onClick={() => void handleCharge("charge")}
              >
                {pending ? "Sending…" : "Charge card"}
              </Button>
              <Button size="lg" disabled={pending} onClick={() => setMode("cash")}>
                Cash
              </Button>
              {session?.currentTableId ? (
                <Button size="lg" disabled={pending} onClick={() => void handleRelease()}>
                  Leave unpaid
                </Button>
              ) : null}
              <Button variant="ghost" disabled={pending} onClick={() => setConfirmCard(true)}>
                Mark paid – card
              </Button>
            </div>
          )}
        </div>
      )}

      {confirmCard ? (
        <CardConfirmDialog
          onClose={() => setConfirmCard(false)}
          onConfirm={async () => {
            const r = await api.markPaid(sessionId, "card", true);
            if (r.warnings.length) setWarnings(r.warnings);
            if (r.kind === "already_paid_by_card") setAlreadyCard(true);
            await load();
            void refetch();
          }}
        />
      ) : null}
    </Sheet>
  );
}

function Total({ detail }: { detail: SessionDetailDTO }) {
  const s = detail.session;
  const b = detail.breakdown;
  // The stored bill is authoritative once stopped; the breakdown is only a fallback while running.
  const total = s.totalCents ?? b?.totalCents ?? null;
  const minutes = s.billedMinutes ?? b?.billedMinutes ?? null;
  return (
    <section aria-label="Bill" className="rounded-2xl border border-line bg-bg p-4 text-center">
      <p className="text-6xl font-bold tabular-nums">{total !== null ? formatCents(total) : "—"}</p>
      <p className="mt-2 text-lg text-muted">
        {minutes !== null ? `${minutes} min billed` : "Minutes pending"}
        {total !== null ? ` · GST incl. ${formatCents(b?.gstCents ?? gstOf(total))}` : ""}
      </p>
      {b && b.lines.length > 0 ? (
        <ul className="mt-3 divide-y divide-line border-t border-line text-left text-base">
          {b.lines.map((l) => (
            <li key={l.rateCardId} className="flex justify-between gap-3 py-2">
              <span>
                {l.rateCardName} <span className="text-muted">· {l.minutes} min @ {formatCents(l.centsPerHour)}/h</span>
              </span>
              <span className="tabular-nums">{formatCents(l.cents)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function TerminalPanel({
  detail,
  pending,
  onCancel,
  onResend,
  onMarkPaid,
}: {
  detail: SessionDetailDTO;
  pending: boolean;
  onCancel: () => void;
  onResend: () => void;
  onMarkPaid: () => void;
}) {
  const sub = checkoutLabel(detail.session);
  const cancelling = detail.session.checkout?.status === "CANCEL_REQUESTED";
  return (
    <section aria-label="Card payment" className="flex flex-col gap-3 rounded-2xl border-2 border-[#3a77b0] bg-[#12263a] p-4">
      <div className="flex items-center gap-3">
        <span aria-hidden className="size-4 animate-pulse rounded-full bg-info" />
        <h3 className="text-2xl font-bold">{sub.label}</h3>
      </div>
      <p className="text-muted">
        {cancelling
          ? "Waiting for the Terminal to confirm the cancel. If the customer has already tapped, it will count as paid."
          : "Customer pays on the Terminal. This screen updates by itself."}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Button size="lg" disabled={pending || cancelling} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="lg" disabled={pending || cancelling} onClick={onResend}>
          Resend
        </Button>
        <Button size="lg" variant="brass" disabled={pending} onClick={onMarkPaid}>
          Mark paid – card
        </Button>
      </div>
    </section>
  );
}

function PaidPanel({ detail, onClose }: { detail: SessionDetailDTO; onClose: () => void }) {
  const s = detail.session;
  return (
    <section className="flex flex-col gap-3 text-center">
      <div>
        <Badge tone="paid">Paid</Badge>
      </div>
      <p className="text-xl font-semibold">
        Paid by {s.settledMethod ?? "—"}
        {s.settledByName ? ` · ${s.settledByName}` : ""}
      </p>
      <Button variant="primary" size="lg" onClick={onClose}>
        Done
      </Button>
    </section>
  );
}

function CardConfirmDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => Promise<void> }) {
  const [checked, setChecked] = useState(false);
  return (
    <ActionDialog
      title="Mark paid – card"
      noReason
      submitLabel="Mark paid"
      canSubmit={checked}
      description="The card payment must already show as APPROVED on the Terminal or in Square."
      onSubmit={onConfirm}
      onClose={onClose}
    >
      <label className="flex min-h-14 items-center gap-3 rounded-xl border border-line bg-bg px-4 text-lg">
        <input
          type="checkbox"
          className="size-7 accent-[#2c7a55]"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        <span>I&apos;ve seen it approved</span>
      </label>
    </ActionDialog>
  );
}
