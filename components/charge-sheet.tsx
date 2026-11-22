"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ActionDialog } from "@/components/action-dialog";
import { AdjustmentRows } from "@/components/bill-rows";
import { DiscountPanel } from "@/components/discount-panel";
import { ItemsPanel } from "@/components/items-panel";
import { BillDetailsSection } from "@/components/bill-details";
import { NextBillButton, PartHeader, PartsPanel, SplitButton } from "@/components/split-panel";
import { ReceiptButton } from "@/components/receipt-button";
import { Badge, Button, Notice, Sheet, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { authRedirect, errorMessage, isBillChanged } from "@/lib/client/errors";
import { useFloor } from "@/lib/client/floor-context";
import { useStandDevice } from "@/lib/client/stand";
import { useAction } from "@/lib/client/use-action";
import { isCheckoutLive } from "@/lib/domain/machine";
import type { SessionDetailDTO } from "@/lib/domain/types";
import { formatCents } from "@/lib/pricing";
import { billOf, billTitle, canContinue, discountBase, groupItems, isEmptyCounterSale, lineLabel } from "@/lib/client/bill-view";
import { cashDueCents } from "@/lib/domain/bill";
import { checkoutLabel } from "@/lib/client/session-view";
import { inSplit, nextUnpaidBill, type NextBill } from "@/lib/client/split-view";
import { useParentBill } from "@/lib/client/use-parent-bill";

/** Hands the iPad over to another app's link (Square POS). Kept out of the component on purpose. */
function leaveFor(url: string): void {
  window.location.assign(url);
}

const ALREADY_PAID = "Card payment already went through — this bill is paid. Don't take cash.";
const SYNC_MS = 5000;

interface Props {
  sessionId: string;
  onClose: () => void;
  /**
   * Set only by the sheet that just made a counter sale: closing it with nothing on the bill throws
   * the bill away. A sheet opened on an empty counter sale from the Unpaid list does not do this
   * (another iPad may be about to add to it) and offers a Discard button instead.
   */
  discardIfEmpty?: boolean;
}

/**
 * The charge sheet for one bill. A split bill's parts, and the bill they came from, open in this
 * same sheet (`openId`), so paying one share and moving on to the next never goes back through the
 * Unpaid list.
 */
export function ChargeSheet({ sessionId, onClose, discardIfEmpty = false }: Props) {
  const [openId, setOpenId] = useState(sessionId);
  const [fromProp, setFromProp] = useState(sessionId);
  if (fromProp !== sessionId) {
    setFromProp(sessionId);
    setOpenId(sessionId);
  }
  return (
    <ChargeSheetBody
      key={openId}
      sessionId={openId}
      onClose={onClose}
      onOpenBill={setOpenId}
      discardIfEmpty={discardIfEmpty && openId === sessionId}
    />
  );
}

function ChargeSheetBody({
  sessionId,
  onClose,
  onOpenBill,
  discardIfEmpty = false,
}: Props & { onOpenBill: (id: string) => void }) {
  const router = useRouter();
  const toast = useToast();
  const { floor, refetch, version } = useFloor();
  const { run, pending } = useAction();
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"choose" | "cash">("choose");
  const [confirmCard, setConfirmCard] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [alreadyCard, setAlreadyCard] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [printing, setPrinting] = useState(false);
  // The server said the amount on screen is no longer the bill's: shown until staff act again.
  const [changedNote, setChangedNote] = useState<string | null>(null);
  const [receiptsSent, setReceiptsSent] = useState(0);
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
  const bill = detail ? billOf(detail) : null;
  // What the sheet is showing right now. Every money action sends it, so a bill that moved under us
  // (another iPad, a discount) is refused instead of charged at the new figure.
  const shownTotal = bill ? bill.totalCents : undefined;
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
  // A cash customer may want a receipt, so a cash sale on a paired Terminal stays up for 8 s instead
  // of 2.5 s. A card payment closes as before (the Terminal offers its own receipt). Never mid-print;
  // after one is sent, a short moment more. A receipt can always be printed later from the bill.
  const receiptWindow = session?.settledMethod === "cash" && !!floor?.terminalPaired && session.settledCents !== 0;

  // A split bill. A paid share needs to know what to take payment for next; a bill's own parts say
  // so on the bill itself, and a part reads the bill it came from. `next` is undefined while that
  // read is on its way, so the sheet stays open rather than closing on someone with shares left.
  const related = !!session && inSplit(session);
  const isPart = session?.kind === "part";
  const parent = useParentBill(isPart ? (session?.splitOfId ?? null) : null, detail);
  // The bill a part came from, when it can still be paid from here (awaiting payment, no card request live).
  const parentBill =
    parent.bill && parent.bill.status === "awaiting_payment" && !isCheckoutLive(parent.bill.checkout?.status) ? parent.bill : null;
  const next: NextBill | null | undefined =
    session && session.status === "paid" && related
      ? isPart && !parent.ready
        ? undefined
        : nextUnpaidBill(session, isPart ? parent.bill : session)
      : null;

  const quietPaid = paid && warnings.length === 0 && !alreadyCard && !printing && next === null;
  useEffect(() => {
    if (!quietPaid) return;
    const ms = receiptsSent === 0 && receiptWindow ? 8000 : 2500;
    const id = setTimeout(() => onCloseRef.current(), ms);
    return () => clearTimeout(id);
  }, [quietPaid, receiptWindow, receiptsSent]);

  /**
   * `bill_changed`: the amount on screen was not the bill's any more, so nothing was done. Reload,
   * stay here, and say so; staff read the new amount and tap again. Never retried for them.
   */
  const onBillChanged = (e: unknown): boolean => {
    if (!isBillChanged(e)) return false;
    setChangedNote(errorMessage(e));
    void load();
    return true;
  };

  /** Runs a server call, applies its outcome flags, THEN reloads, all before buttons re-enable. */
  const act = async <T,>(fn: () => Promise<T>, onResult: (r: T) => void): Promise<T | undefined> => {
    setChangedNote(null);
    return run(
      async () => {
        const r = await fn();
        onResult(r);
        await load();
        return r;
      },
      { onError: onBillChanged },
    );
  };

  const handleCharge = (kind: "charge" | "resend") =>
    act(
      () => (kind === "charge" ? api.charge(sessionId, shownTotal) : api.resend(sessionId, shownTotal)),
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
      () => api.markPaid(sessionId, "cash", false, shownTotal),
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
    setChangedNote(null);
    const r = await run(() => api.cashHandoff(sessionId, shownTotal), { refetch: false, onError: onBillChanged });
    if (!r) return;
    setHandoff("waiting");
    setNotOpened(false);
    setCheckedNotPaid(false);
    leaveFor(r.url);
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

  /** Back to running. `countGap`: charge the time since it was stopped (a stop by mistake) or not. */
  const handleContinue = async (countGap: boolean) => {
    const r = await run(() => api.continueSession(sessionId, countGap));
    if (r) {
      toast.show(`${session ? billTitle(session) : "Table"} is running again.`, "success");
      onClose();
    } else {
      // Refused: the bill has moved on (paid, split, on the Terminal). Show it as it is now.
      setContinuing(false);
      await load();
    }
  };

  const handleRelease = async () => {
    const r = await run(() => api.release(sessionId));
    if (r) {
      toast.show("Table freed. Bill is on the Unpaid list.", "success");
      onClose();
    }
  };

  const cashLabelCents = bill && cashDueCents(bill.totalCents) !== bill.totalCents ? cashDueCents(bill.totalCents) : null;
  // A table's bill is "Charge Table 3"; a counter sale or a part has no table, so it goes by its label.
  const title = session ? (session.kind === "table" ? `Charge ${billTitle(session)}` : billTitle(session)) : "Charge";
  const nothingToPay = !!bill && bill.totalCents <= 0;
  // A counter sale with nothing on it isn't a comped bill: it just hasn't been rung up yet.
  const emptySale = session?.kind === "counter" && session.itemsCents === 0;
  const busy = pending || stale || handoff !== "idle";

  // Closing the sheet that made a counter sale, with nothing on the bill, throws the bill away, so
  // empty bills don't pile up in the Unpaid list. It's quiet: if the server says no, the bill just
  // stays there, which is harmless. Only the sheet that made it does this.
  const close = () => {
    if (discardIfEmpty && session && isEmptyCounterSale(session)) {
      void api
        .discard(session.id)
        .then(() => refetch())
        .catch(() => undefined);
    }
    onClose();
  };

  // An empty counter sale opened from the Unpaid list: thrown away only when staff say so.
  const canDiscard = !discardIfEmpty && !!session && isEmptyCounterSale(session);
  const handleDiscard = async () => {
    const r = await run(() => api.discard(sessionId));
    if (r) {
      toast.show("Sale discarded", "success");
      onClose();
    }
  };

  return (
    <Sheet title={title} onClose={close} locked={pending}>
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
          {changedNote ? (
            <Notice tone="warn" strong>
              {changedNote}
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

          {session && !(session.status === "awaiting_payment" && (mode === "cash" || live)) ? (
            <BillDetailsSection session={session} onSaved={load} disabled={pending} />
          ) : null}

          {session && session.status === "awaiting_payment" && mode === "choose" ? (
            <>
              <PartHeader session={session} parent={parentBill} disabled={pending} onOpen={onOpenBill} />
              <PartsPanel session={session} disabled={pending || live} onOpen={onOpenBill} onChanged={load} />
              <ItemsPanel session={session} reload={load} busy={pending} />
              <DiscountPanel session={session} baseCents={bill ? discountBase(bill) : null} reload={load} busy={pending} />
            </>
          ) : null}

          {session && session.status === "paid" ? (
            <>
              <PaidPanel
                detail={detail}
                onClose={onClose}
                reload={load}
                onPrinting={setPrinting}
                onSent={() => setReceiptsSent((n) => n + 1)}
                extra={next ? <NextBillButton next={next} disabled={pending} onOpen={onOpenBill} /> : null}
              />
              <PartsPanel session={session} disabled={pending} onOpen={onOpenBill} onChanged={load} />
            </>
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
          ) : nothingToPay ? (
            <div className="flex flex-col gap-3">
              {emptySale ? (
                <>
                  <Notice tone="info">Add something to the sale, then take payment.</Notice>
                  {canDiscard ? (
                    <Button size="lg" disabled={pending} onClick={() => void handleDiscard()}>
                      Discard sale
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  {/* Settled with no card and no Square call, so no Charge, Cash or card buttons here. */}
                  <Button variant="primary" size="lg" disabled={pending || stale} onClick={() => void handleCash()}>
                    {pending ? "Closing…" : "Nothing to pay. Close bill"}
                  </Button>
                </>
              )}
              {session && canContinue(session) ? (
                <Button size="lg" disabled={busy} onClick={() => setContinuing(true)}>
                  Keep playing
                </Button>
              ) : null}
              {session?.currentTableId ? (
                <Button size="lg" disabled={pending} onClick={() => void handleRelease()}>
                  Leave unpaid
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {session?.checkout?.status === "CANCELED" ? <Notice tone="warn">Card not completed. Charge again or take another payment.</Notice> : null}
              {session?.checkout?.status === "COMPLETED" ? (
                <Notice tone="warn">Card payment was reversed — take payment again.</Notice>
              ) : null}
              {floor && !floor.terminalPaired ? (
                <Notice tone="warn">
                  No Terminal is paired.{" "}
                  {bill && (bill.discountCents > 0 || bill.splitOffCents > 0 || session?.kind === "part")
                    ? `Ring up ${formatCents(bill.totalCents)} in Square POS`
                    : session && session.items.length > 0
                      ? `Ring up ${(billOf(detail)?.tableCents ?? 0) > 0 ? "Table hire and " : ""}the items in Square POS`
                      : "Ring it up in Square POS"}
                  , then tap Mark paid – card.
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
              {session ? <SplitButton session={session} disabled={busy} onSplit={load} onBillChanged={setChangedNote} /> : null}
              {session && canContinue(session) ? (
                <Button size="lg" disabled={busy} onClick={() => setContinuing(true)}>
                  Keep playing
                </Button>
              ) : null}
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

      {continuing && session ? (
        <Sheet title={`Keep playing on ${billTitle(session)}?`} onClose={() => setContinuing(false)} raised locked={pending}>
          <div className="flex flex-col gap-4">
            <p className="text-base text-muted">
              The table goes back to running and this bill is worked out again when it is next stopped. Items and any discount stay on it.
            </p>
            <Button variant="primary" size="lg" className="h-auto min-h-16 flex-col gap-0.5 py-3" disabled={pending} onClick={() => void handleContinue(true)}>
              <span>Stopped by mistake</span>
              <span className="text-sm font-medium">The time since it was stopped is charged</span>
            </Button>
            <Button size="lg" className="h-auto min-h-16 flex-col gap-0.5 py-3" disabled={pending} onClick={() => void handleContinue(false)}>
              <span>Start the clock from now</span>
              <span className="text-sm font-medium text-muted">The time since it was stopped is not charged</span>
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setContinuing(false)}>
              Cancel
            </Button>
          </div>
        </Sheet>
      ) : null}

      {confirmCard ? (
        <CardConfirmDialog
          hasItems={(session?.items.length ?? 0) > 0}
          onClose={() => setConfirmCard(false)}
          onError={(e) => {
            // The amount moved: close this, reload, and say so on the sheet.
            if (!isBillChanged(e)) return false;
            setConfirmCard(false);
            return onBillChanged(e);
          }}
          onConfirm={async () => {
            setChangedNote(null);
            const r = await api.markPaid(sessionId, "card", true, shownTotal);
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
  const hasTable = s.kind === "table";
  const adjusted = !!bill && (!!bill.discount || bill.splitOffCents > 0);
  return (
    <section aria-label="Bill" className="rounded-2xl border border-line bg-bg p-4 text-center">
      {cash && bill ? (
        <p className="text-lg font-semibold text-muted">Cash to collect</p>
      ) : bill && bill.splitOffCents > 0 && s.status === "awaiting_payment" ? (
        <p className="text-lg font-semibold text-muted">Left to pay on this bill</p>
      ) : null}
      <p className="text-6xl font-bold tabular-nums">
        {bill ? formatCents(cash ? cashDueCents(bill.totalCents) : bill.totalCents) : "—"}
      </p>
      {cash && bill && cashDueCents(bill.totalCents) !== bill.totalCents ? (
        <p className="mt-1 text-base text-muted">
          Bill is <span className="tabular-nums">{formatCents(bill.totalCents)}</span>. Cash rounds to the nearest 5c.
        </p>
      ) : null}
      <p className="mt-2 text-lg text-muted">
        {hasTable ? (minutes !== null ? `${minutes} min billed` : "Minutes pending") : ""}
        {bill ? `${hasTable ? " · " : ""}GST incl. ${formatCents(bill.gstCents)}` : ""}
      </p>
      {bill && hasTable && groups.length > 0 ? (
        <p className="mt-1 text-lg text-muted">
          Table <span className="tabular-nums">{formatCents(bill.tableCents)}</span> · Items{" "}
          <span className="tabular-nums">{formatCents(bill.itemsCents)}</span>
        </p>
      ) : null}
      {lines.length > 0 || groups.length > 0 || adjusted ? (
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
                {lineLabel(g)}
                {!g.taxed ? <span className="text-muted"> · GST-free</span> : null}
              </span>
              <span className="tabular-nums">{formatCents(g.cents)}</span>
            </li>
          ))}
          {bill ? <AdjustmentRows bill={bill} rowClass="flex justify-between gap-3 py-2" /> : null}
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
        <Button size="lg" variant="accent" disabled={pending} onClick={onMarkPaid}>
          Mark paid – card
        </Button>
      </div>
    </section>
  );
}

function PaidPanel({
  detail,
  onClose,
  reload,
  onPrinting,
  onSent,
  extra,
}: {
  detail: SessionDetailDTO;
  onClose: () => void;
  reload: () => Promise<void>;
  onPrinting: (busy: boolean) => void;
  onSent: () => void;
  /** Shown above Done: on a split bill, the way on to the next share. */
  extra?: ReactNode;
}) {
  const s = detail.session;
  // A bill with nothing left to pay (a discount covered it) is closed with no payment at all.
  const nothingPaid = s.settledCents === 0;
  return (
    <section className="flex flex-col gap-3 text-center">
      <div>
        <Badge tone="paid">Paid</Badge>
      </div>
      {nothingPaid ? (
        <p className="text-xl font-semibold">
          Closed. Nothing to pay.
          {s.settledByName ? <span className="block text-base font-normal text-muted">{s.settledByName}</span> : null}
        </p>
      ) : (
        <p className="text-xl font-semibold">
          Paid by {s.settledMethod ?? "—"}
          {s.settledByName ? ` · ${s.settledByName}` : ""}
        </p>
      )}
      {!nothingPaid && s.settledMethod === "cash" && s.settledCents !== null ? (
        <p className="text-lg text-muted">
          Cash taken <span className="tabular-nums">{formatCents(s.settledCents)}</span>
        </p>
      ) : null}
      {s.settledMethod === "cash" && s.squareCash?.state === "failed" ? (
        <Notice tone="warn">Not in Square yet. A manager can retry in Admin → Items.</Notice>
      ) : null}
      <ReceiptButton session={s} recheck={reload} onBusyChange={onPrinting} onSent={onSent} />
      {extra}
      <Button variant={extra ? "secondary" : "primary"} size="lg" onClick={onClose}>
        Done
      </Button>
    </section>
  );
}

function CardConfirmDialog({
  hasItems,
  onClose,
  onConfirm,
  onError,
}: {
  hasItems: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  /** Errors the sheet wants to handle itself (the bill's amount moved). Return true if handled. */
  onError: (e: unknown) => boolean;
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
      onError={onError}
    >
      <label className="flex min-h-14 items-center gap-3 rounded-xl border border-line bg-bg px-4 text-lg">
        <input
          type="checkbox"
          className="size-7 accent-[#f47b20]"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        <span>I&apos;ve seen it approved</span>
      </label>
    </ActionDialog>
  );
}
