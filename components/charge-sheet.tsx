"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/action-dialog";
import { ItemsPanel } from "@/components/items-panel";
import { Badge, Button, Notice, Sheet, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor } from "@/lib/client/floor-context";
import { useStandDevice } from "@/lib/client/stand";
import { useAction } from "@/lib/client/use-action";
import { isCheckoutLive } from "@/lib/domain/machine";
import type { SessionDetailDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";
import { billOf, groupItems } from "@/lib/client/bill-view";
import { cashDueCents } from "@/lib/domain/bill";
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
  const { floor, refetch, version } = useFloor();
  const { run, pending } = useAction();
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"choose" | "cash">("choose");
  const [confirmCard, setConfirmCard] = useState(false);
  const [alreadyCard, setAlreadyCard] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [onStand] = useStandDevice();
  // Cash through Square POS (the drawer opens there): idle, waiting for the sale, or gave up waiting.
  const [handoff, setHandoff] = useState<"idle" | "waiting" | "gave_up">("idle");
  const [notOpened, setNotOpened] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedNotPaid, setCheckedNotPaid] = useState(false);
  const checkBusy = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Only the newest detail request may apply, so an older reply can't flip the sheet back.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await api.session(sessionId);
      if (mine !== seq.current) return;
      setDetail(d);
      setLoadError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else setLoadError(errorMessage(e));
    }
  }, [sessionId, router]);

  // Reload on open and whenever the floor refreshes (another iPad may have changed this bill).
  useLoad(load, version);

  const session = detail?.session ?? null;
  const live = !!session && session.status === "awaiting_payment" && isCheckoutLive(session.checkout?.status);
  // Stale data must not be paid against: block money actions until a refresh succeeds.
  const stale = loadError !== null;

  // While the "Sent to Terminal" panel is open, ask Square every ~5 s. One request at a time, and
  // paused while an action is running or the confirm dialog is open (sync holds the session lock).
  const paused = pending || confirmCard;
  useEffect(() => {
    if (!live || paused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await api.sync(sessionId);
      } catch {
        // transient; the next tick or the webhook will catch up
      }
      if (cancelled) return;
      // The floor refetch only reloads this sheet again if the floor really changed.
      void refetch();
      await load();
      if (cancelled) return;
      timer = setTimeout(() => void tick(), SYNC_MS);
    };
    timer = setTimeout(() => void tick(), SYNC_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, paused, sessionId, load, refetch]);

  const paid = session?.status === "paid";
  const quietPaid = paid && warnings.length === 0 && !alreadyCard;
  useEffect(() => {
    if (!quietPaid) return;
    const id = setTimeout(() => onCloseRef.current(), 2500);
    return () => clearTimeout(id);
  }, [quietPaid]);

  /** Runs a server call, applies its outcome flags, THEN reloads, all before buttons re-enable. */
  const act = async <T,>(fn: () => Promise<T>, onResult: (r: T) => void): Promise<T | undefined> =>
    run(async () => {
      const r = await fn();
      onResult(r);
      await load();
      return r;
    });

  const handleCharge = (kind: "charge" | "resend") =>
    act(
      () => (kind === "charge" ? api.charge(sessionId) : api.resend(sessionId)),
      (r) => {
        if (r.kind === "already_paid_by_card") setAlreadyCard(true);
      },
    );

  const handleCancel = () =>
    act(
      () => api.cancelCheckout(sessionId),
      (r) => {
        if (r.paid) setAlreadyCard(true);
        if (r.warnings.length) setWarnings(r.warnings);
      },
    );

  const handleCash = () =>
    act(
      () => api.markPaid(sessionId, "cash", false),
      (r) => {
        if (r.kind === "already_paid_by_card") setAlreadyCard(true);
        if (r.warnings.length) setWarnings(r.warnings);
      },
    );

  const posCash = !!floor?.posCashAvailable && onStand;

  /** Asks Square whether the cash sale went through. Says whether the bill is now paid, not paid, or the check itself failed. */
  const checkHandoff = useCallback(async (quiet = false): Promise<"paid" | "not_paid" | "failed"> => {
    if (checkBusy.current) return "failed";
    checkBusy.current = true;
    setChecking(true);
    try {
      const r = await api.cashHandoffCheck(sessionId);
      if (r.paid) {
        setHandoff("idle");
        await load();
        void refetch();
      } else {
        setCheckedNotPaid(true);
      }
      return r.paid ? "paid" : "not_paid";
    } catch (e) {
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else if (!quiet) toast.show(errorMessage(e), "error");
      return "failed";
    } finally {
      checkBusy.current = false;
      setChecking(false);
    }
  }, [sessionId, load, refetch, router, toast]);

  const startHandoff = async () => {
    const r = await run(() => api.cashHandoff(sessionId), { refetch: false });
    if (!r) return;
    setHandoff("waiting");
    setNotOpened(false);
    setCheckedNotPaid(false);
    window.location.href = r.url;
  };

  // While waiting: when this page comes back to the front, ask Square. If Square POS never took over
  // (not installed or signed out) the page stays visible, so say so after a few seconds. Stop
  // waiting after a while.
  useEffect(() => {
    if (handoff !== "waiting" || paid) return;
    const back = () => {
      if (document.visibilityState === "visible") void checkHandoff();
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) back();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    window.addEventListener("pageshow", onShow);
    const notOpenedTimer = setTimeout(() => {
      if (document.visibilityState === "visible") setNotOpened(true);
    }, 4000);
    const giveUp = setTimeout(() => setHandoff("gave_up"), 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
      window.removeEventListener("pageshow", onShow);
      clearTimeout(notOpenedTimer);
      clearTimeout(giveUp);
    };
  }, [handoff, paid, checkHandoff]);

  /** The manual path. On the Stand iPad ask Square first, so a sale it already has isn't recorded twice. */
  const handleManualCash = async () => {
    if (posCash) {
      // Square being down must never stop cash. If the check fails, carry on: the server checks
      // again and holds the record so a late POS answer can claim it.
      const r = await checkHandoff(true);
      if (r === "paid") return;
    }
    await handleCash();
  };

  /** Refresh first: the cash amount shown must be for the current bill. */
  const goCash = async () => {
    const d = await run(async () => {
      const mine = ++seq.current;
      const fresh = await api.session(sessionId);
      if (mine === seq.current) {
        setDetail(fresh);
        setLoadError(null);
      }
      return fresh;
    });
    if (d && d.session.status === "awaiting_payment" && !isCheckoutLive(d.session.checkout?.status)) setMode("cash");
  };

  const handleRelease = async () => {
    const r = await run(() => api.release(sessionId));
    if (r) {
      toast.show("Table freed. Bill is on the Unpaid list.", "success");
      onClose();
    }
  };

  const bill = detail ? billOf(detail) : null;
  const cashLabelCents = bill && cashDueCents(bill.totalCents) !== bill.totalCents ? cashDueCents(bill.totalCents) : null;
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
          {stale ? (
            <Notice tone="warn">
              <span className="block">Couldn&apos;t refresh this bill, so the figures may be out of date. {loadError}</span>
              <Button className="mt-2" onClick={() => void load()}>
                Retry
              </Button>
            </Notice>
          ) : null}
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

          <Total detail={detail} cash={mode === "cash" && session?.status === "awaiting_payment"} />

          {session && session.status === "awaiting_payment" && mode === "choose" ? <ItemsPanel session={session} reload={load} busy={pending} /> : null}

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
              {posCash ? (
                <>
                  {handoff !== "idle" ? (
                    <Notice tone="info" strong>
                      {handoff === "waiting"
                        ? "Finish the cash sale in Square, then come back here."
                        : "Haven't heard back from Square. Check again, or take the cash another way."}
                    </Notice>
                  ) : null}
                  {handoff === "waiting" && notOpened ? (
                    <Notice tone="warn">Square didn&apos;t open on this iPad. Is Square POS installed and signed in?</Notice>
                  ) : null}
                  {handoff !== "idle" && checkedNotPaid && !checking ? (
                    <Notice tone="warn">Square doesn&apos;t show this sale yet.</Notice>
                  ) : null}
                  {handoff === "idle" ? (
                    <Button variant="primary" size="lg" disabled={pending || stale} onClick={() => void startHandoff()}>
                      {pending ? "Opening…" : "Take cash in Square"}
                    </Button>
                  ) : (
                    <>
                      <Button variant="primary" size="lg" disabled={checking || pending} onClick={() => void checkHandoff()}>
                        {checking ? "Checking…" : "Check again"}
                      </Button>
                      <Button size="lg" disabled={pending || checking || stale} onClick={() => void startHandoff()}>
                        Open Square again
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" disabled={pending || checking || stale} onClick={() => void handleManualCash()}>
                    Mark paid – cash (drawer won&apos;t open)
                  </Button>
                </>
              ) : (
                <Button variant="primary" size="lg" disabled={pending || stale} onClick={() => void handleCash()}>
                  {pending ? "Saving…" : "Mark paid – cash"}
                </Button>
              )}
              <Button size="lg" disabled={pending || checking} onClick={() => setMode("choose")}>
                Back
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {session?.checkout?.status === "CANCELED" ? <Notice tone="warn">Card not completed. Charge again or take another payment.</Notice> : null}
              {session?.checkout?.status === "COMPLETED" ? (
                <Notice tone="warn">Card payment was reversed — take payment again.</Notice>
              ) : null}
              {floor && !floor.terminalPaired ? (
                <Notice tone="warn">
                  No Terminal is paired. {session && session.items.length > 0
                    ? `Ring up ${(billOf(detail)?.tableCents ?? 0) > 0 ? "Table hire and " : ""}the items in Square POS`
                    : "Ring it up in Square POS"}, then tap
                  Mark paid – card.
                </Notice>
              ) : null}
              <Button
                variant="primary"
                size="lg"
                disabled={pending || stale || !floor || !floor.terminalPaired}
                onClick={() => void handleCharge("charge")}
              >
                {pending ? "Sending…" : "Charge card"}
              </Button>
              <Button size="lg" disabled={pending || stale} onClick={() => void goCash()}>
                Cash
                {cashLabelCents !== null ? <span className="tabular-nums"> · {formatCents(cashLabelCents)}</span> : null}
              </Button>
              {session?.currentTableId ? (
                <Button size="lg" disabled={pending} onClick={() => void handleRelease()}>
                  Leave unpaid
                </Button>
              ) : null}
              <Button variant="ghost" disabled={pending || stale} onClick={() => setConfirmCard(true)}>
                Mark paid – card
              </Button>
            </div>
          )}
        </div>
      )}

      {confirmCard ? (
        <CardConfirmDialog
          hasItems={(session?.items.length ?? 0) > 0}
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

function Total({ detail, cash }: { detail: SessionDetailDTO; cash: boolean }) {
  const s = detail.session;
  const b = detail.breakdown;
  // The stored bill is authoritative once stopped; the breakdown (table time only) is a fallback.
  const bill = billOf(detail);
  const minutes = s.billedMinutes ?? b?.billedMinutes ?? null;
  const lines = b && bill && b.totalCents === bill.tableCents ? b.lines : [];
  const groups = groupItems(s.items);
  return (
    <section aria-label="Bill" className="rounded-2xl border border-line bg-bg p-4 text-center">
      {cash && bill ? <p className="text-lg font-semibold text-muted">Cash to collect</p> : null}
      <p className="text-6xl font-bold tabular-nums">
        {bill ? formatCents(cash ? cashDueCents(bill.totalCents) : bill.totalCents) : "—"}
      </p>
      {cash && bill && cashDueCents(bill.totalCents) !== bill.totalCents ? (
        <p className="mt-1 text-base text-muted">
          Bill is <span className="tabular-nums">{formatCents(bill.totalCents)}</span>. Cash rounds to the nearest 5c.
        </p>
      ) : null}
      <p className="mt-2 text-lg text-muted">
        {minutes !== null ? `${minutes} min billed` : "Minutes pending"}
        {bill ? ` · GST incl. ${formatCents(bill.gstCents)}` : ""}
      </p>
      {bill && groups.length > 0 ? (
        <p className="mt-1 text-lg text-muted">
          Table <span className="tabular-nums">{formatCents(bill.tableCents)}</span> · Items{" "}
          <span className="tabular-nums">{formatCents(bill.itemsCents)}</span>
        </p>
      ) : null}
      {lines.length > 0 || groups.length > 0 ? (
        <ul className="mt-3 divide-y divide-line border-t border-line text-left text-base">
          {lines.map((l) => (
            <li key={l.rateCardId} className="flex justify-between gap-3 py-2">
              <span>
                {l.rateCardName} <span className="text-muted">· {l.minutes} min @ {formatCents(l.centsPerHour)}/h</span>
              </span>
              <span className="tabular-nums">{formatCents(l.cents)}</span>
            </li>
          ))}
          {groups.map((g) => (
            <li key={g.key} className="flex justify-between gap-3 py-2">
              <span>
                {g.quantity} × {g.name}
                {!g.taxed ? <span className="text-muted"> · GST-free</span> : null}
              </span>
              <span className="tabular-nums">{formatCents(g.cents)}</span>
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
      {s.settledMethod === "cash" && s.settledCents !== null ? (
        <p className="text-lg text-muted">
          Cash taken <span className="tabular-nums">{formatCents(s.settledCents)}</span>
        </p>
      ) : null}
      {s.settledMethod === "cash" && s.squareCash?.state === "failed" ? (
        <Notice tone="warn">Not in Square yet. A manager can retry in Admin → Items.</Notice>
      ) : null}
      <Button variant="primary" size="lg" onClick={onClose}>
        Done
      </Button>
    </section>
  );
}

function CardConfirmDialog({
  hasItems,
  onClose,
  onConfirm,
}: {
  hasItems: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <ActionDialog
      title="Mark paid – card"
      noReason
      submitLabel="Mark paid"
      canSubmit={checked}
      description={
        hasItems
          ? "The card payment must already show as APPROVED on the Terminal or in Square. If it was rung up in Square POS, the items must be on it too."
          : "The card payment must already show as APPROVED on the Terminal or in Square."
      }
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
