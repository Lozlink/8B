"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ActionDialog } from "@/components/action-dialog";
import { CashCountForm, useCloseForm } from "@/components/end-of-day/close-form";
import { CloseHistory } from "@/components/end-of-day/close-history";
import { CloseReport, closeByline } from "@/components/end-of-day/close-report";
import { DayFigures, MUTED } from "@/components/end-of-day/day-figures";
import { useToast } from "@/components/toast";
import { Button, Field, Notice, Spinner, inputClass } from "@/components/ui";
import { ApiError, api } from "@/lib/client/api";
import { describeDifference, differenceCents, expectedCashCents, formatBusinessDate, isBusinessDate, type CloseCheck } from "@/lib/client/day-close";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor } from "@/lib/client/floor-context";
import { useAction } from "@/lib/client/use-action";
import { useLoad } from "@/lib/client/use-load";
import type { DayCloseDTO, DayCloseStateDTO } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";

type Checked = Extract<CloseCheck, { ok: true }>;

export function EndOfDayView() {
  const router = useRouter();
  const { floor, version } = useFloor();
  const initial = useSearchParams().get("date");
  // null = the business day running now.
  const [date, setDate] = useState<string | null>(() => (isBusinessDate(initial) ? initial : null));
  const [state, setState] = useState<DayCloseStateDTO | null>(null);
  const [history, setHistory] = useState<DayCloseDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  // Whether the close form has something typed in it (set by the panel), and a move waiting on a yes.
  const dirty = useRef(false);
  const [leaving, setLeaving] = useState<{ to: string | null } | null>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const result = await api.dayClose(date ?? undefined);
      if (mine !== seq.current) return; // a newer request superseded this one
      setState(result);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else setError(errorMessage(e));
    }
  }, [date, router]);

  const loadHistory = useCallback(async () => {
    try {
      const result = await api.dayCloses();
      setHistory(result.closes);
    } catch (e) {
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else setHistory((h) => h ?? []);
    }
  }, [router]);

  // The floor moving (a table stopped, a bill paid) is the cue to look again.
  useLoad(load, version);
  useLoad(loadHistory);

  const tz = state?.timezone ?? floor?.pricing.settings.timezone ?? "Australia/Sydney";

  const go = (next: string | null) => {
    setState(null);
    setError(null);
    setDate(next);
    window.scrollTo({ top: 0 });
  };
  const pick = (next: string | null) => {
    if (next === date) return;
    if (dirty.current) setLeaving({ to: next });
    else go(next);
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 print:max-w-none print:gap-3 print:bg-white print:text-black">
      <div className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-bold">End of day</h1>
          {state ? (
            <p className="text-muted tabular-nums">
              {formatBusinessDate(state.businessDate)}
              {state.isCurrent ? " (today)" : ""} · {formatDateTime(state.from, tz)} to {formatDateTime(state.to, tz)}
            </p>
          ) : null}
        </div>
        <div className="flex items-end gap-2">
          <Field label="Business day">
            <input
              type="date"
              className={inputClass}
              value={date ?? state?.businessDate ?? ""}
              onChange={(e) => pick(isBusinessDate(e.target.value) ? e.target.value : null)}
            />
          </Field>
          <Button onClick={() => pick(null)} disabled={date === null}>
            Today
          </Button>
        </div>
      </div>

      {error ? (
        <div className="flex flex-col gap-2 print:hidden">
          <Notice tone="danger">{error}</Notice>
          <div>
            <Button onClick={() => void load()}>Try again</Button>
          </div>
        </div>
      ) : null}

      {!state ? (
        error ? null : <Spinner />
      ) : (
        <DayPanel
          key={state.businessDate}
          state={state}
          tz={tz}
          reload={load}
          onClosed={loadHistory}
          dirtyRef={dirty}
        />
      )}

      <CloseHistory closes={history} tz={tz} viewing={state?.businessDate ?? null} onOpen={(d) => pick(d)} />

      {leaving ? (
        <ActionDialog
          title="Leave this count?"
          description="You have started a count for this day. Going to another day throws it away."
          noReason
          danger
          submitLabel="Throw it away"
          onClose={() => setLeaving(null)}
          onSubmit={async () => {
            go(leaving.to);
          }}
        />
      ) : null}
    </div>
  );
}

interface PanelNotice {
  tone: "info" | "warn";
  text: string;
}

function DayPanel({
  state,
  tz,
  reload,
  onClosed,
  dirtyRef,
}: {
  dirtyRef: { current: boolean };
  state: DayCloseStateDTO;
  tz: string;
  reload: () => Promise<void>;
  onClosed: () => Promise<void>;
}) {
  const toast = useToast();
  const form = useCloseForm(state.suggestedFloatCents);
  const { run, pending } = useAction();
  const [notice, setNotice] = useState<PanelNotice | null>(null);
  // Closing a closed day again: the form shows up, then the manager dialog.
  const [reclosing, setReclosing] = useState(false);
  const [asking, setAsking] = useState<Checked | null>(null);

  useEffect(() => {
    dirtyRef.current = form.dirty;
    return () => {
      dirtyRef.current = false;
    };
  }, [dirtyRef, form.dirty]);

  const latest = state.closes[0] ?? null;
  const closed = latest !== null;
  const tablesRunning = state.running.length > 0;
  const showForm = !closed || reclosing;
  // A manager's PIN and a reason: the day is closed already, or too old for anyone to close.
  const needsManager = state.needsManager;

  /** The 409s that mean "look again": reload and say what happened. Everything else is the default. */
  const handleConflict = (e: unknown): boolean => {
    if (!(e instanceof ApiError) || e.status !== 409) return false;
    if (e.code === "day_changed") {
      void reload();
      setNotice({
        tone: "warn",
        text: "The day's figures moved while you were counting. Check them again, then close. What you typed is kept.",
      });
      return true;
    }
    if (e.code === "tables_running") {
      void reload();
      setNotice({ tone: "warn", text: "A table is running again. Stop it before closing. What you typed is kept." });
      return true;
    }
    if (e.code === "already_closed" || e.code === "needs_manager") {
      void reload();
      setReclosing(true);
      setNotice({
        tone: "warn",
        text:
          e.code === "already_closed"
            ? "This day has been closed since you opened it. Your count is kept. Closing it again needs a manager."
            : "Closing this day needs a manager. Your count is kept.",
      });
      return true;
    }
    return false;
  };

  const body = (c: Checked) => ({
    date: state.businessDate,
    floatCents: c.floatCents,
    countedCashCents: c.countedCashCents,
    expectedTakingsCents: state.totals.takingsCents,
    expectedCashMovementCents: state.cashMovementCents,
    ...(c.cashCounts ? { cashCounts: c.cashCounts } : {}),
    ...(c.note ? { note: c.note } : {}),
  });

  const finish = async (message: string) => {
    toast.show(message, "success");
    setNotice(null);
    setReclosing(false);
    form.reset();
    await Promise.all([reload(), onClosed()]);
  };

  const closeDay = async (c: Checked) => {
    const done = await run(
      async () => {
        await api.closeDay(body(c));
        return true as const;
      },
      { onError: handleConflict },
    );
    if (done) await finish("Day closed.");
  };

  return (
    <>
      {notice ? (
        <div className="print:hidden">
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      ) : null}

      {!closed && tablesRunning ? <RunningNotice running={state.running} /> : null}

      {state.warnings.length > 0 ? (
        <section aria-label="Before you close" className="print:hidden">
          <Notice tone="warn">
            <p className="font-semibold">Worth sorting out first</p>
            <ul className="mt-1 list-disc pl-5">
              {state.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Notice>
        </section>
      ) : null}

      {latest ? (
        <>
          <div className="print:hidden">
            <Notice tone={state.changedSinceClose ? "warn" : "success"} strong>
              {state.changedSinceClose
                ? "This day has changed since it was closed."
                : `This day is closed. ${describeDifference(latest.varianceCents)}.`}
            </Notice>
            {state.changedSinceClose ? (
              <p className={`mt-2 ${MUTED}`}>
                Bills have been taken or changed since {closeByline(latest, tz)}. The report below shows the figures as
                they were then. Close the day again to record the new ones.
              </p>
            ) : null}
          </div>

          <CloseReport
            close={latest}
            tz={tz}
            title={`End of day, ${formatBusinessDate(state.businessDate)}`}
            actions={
              <div className="flex flex-wrap gap-2 print:hidden">
                <Button onClick={() => window.print()}>Print</Button>
                {!reclosing ? <Button onClick={() => setReclosing(true)}>Close again</Button> : null}
              </div>
            }
          />

          {state.changedSinceClose ? (
            <details className="rounded-xl border border-line bg-surface print:hidden">
              <summary className="flex min-h-12 cursor-pointer select-none items-center px-4 py-2 text-base font-semibold">
                Figures now
              </summary>
              <div className="border-t border-line p-4">
                <DayFigures totals={state.totals} />
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <section aria-label="Figures" className="flex flex-col gap-2 print:hidden">
          <h2 className="text-xl font-semibold">{state.isCurrent ? "Today so far" : "The day"}</h2>
          <p className={`text-sm ${MUTED}`}>Set these against Square&rsquo;s end-of-day report.</p>
          <DayFigures totals={state.totals} />
        </section>
      )}

      {showForm ? (
        <section aria-label={closed ? "Close again" : "Close day"} className="flex flex-col gap-3 print:hidden">
          <h2 className="text-xl font-semibold">{closed ? "Close again" : "Count the cash"}</h2>
          {closed ? (
            <p className={MUTED}>
              Count the drawer as it is now. A manager has to approve, and the earlier close stays on record.
            </p>
          ) : needsManager ? (
            <p className={MUTED}>This day is too old for staff to close. A manager has to approve, with a reason.</p>
          ) : null}
          {closed && tablesRunning ? <RunningNotice running={state.running} /> : null}
          <CashCountForm
            form={form}
            cashMovementCents={state.cashMovementCents}
            tablesRunning={tablesRunning}
            submitLabel={closed ? "Close again" : needsManager ? "Close this day" : "Close day"}
            pending={pending}
            onSubmit={(c) => (needsManager ? setAsking(c) : void closeDay(c))}
            onCancel={closed ? () => setReclosing(false) : undefined}
          />
        </section>
      ) : null}

      {state.closes.length > 1 ? (
        <section aria-label="Earlier closes" className="flex flex-col gap-2 print:hidden">
          <h2 className="text-xl font-semibold">Earlier closes of this day</h2>
          <ul className="flex flex-col gap-2">
            {state.closes.slice(1).map((c) => (
              <li key={c.id}>
                <details className="rounded-xl border border-line bg-surface">
                  <summary className="flex min-h-14 cursor-pointer select-none flex-col justify-center px-4 py-2">
                    <span className="font-semibold">
                      Close {c.seq} · {describeDifference(c.varianceCents)}
                    </span>
                    <span className={`text-sm tabular-nums ${MUTED}`}>{closeByline(c, tz)}</span>
                  </summary>
                  <div className="border-t border-line p-4">
                    <CloseReport close={c} tz={tz} title={`Close ${c.seq}`} compact />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {asking ? (
        <ActionDialog
          title={closed ? "Close the day again" : "Close this day"}
          description={<AgainSummary c={asking} state={state} again={closed} />}
          requirePin
          submitLabel={closed ? "Close again" : "Close this day"}
          onClose={() => setAsking(null)}
          onError={(e) => {
            const handled = handleConflict(e);
            if (handled) setAsking(null);
            return handled;
          }}
          onSubmit={async ({ pin, reason }) => {
            await api.closeDay({ ...body(asking), managerPin: pin, reason });
            await finish(closed ? "Day closed again." : "Day closed.");
          }}
        />
      ) : null}
    </>
  );
}

function AgainSummary({ c, state, again }: { c: Checked; state: DayCloseStateDTO; again: boolean }) {
  const expected = expectedCashCents(c.floatCents, state.cashMovementCents);
  return (
    <div className="flex flex-col gap-1">
      <p>{again ? "Say why it is being closed again, then a manager enters their PIN." : "Say why it is being closed now, then a manager enters their PIN."}</p>
      <p className="tabular-nums">
        Float {formatCents(c.floatCents)} · counted {formatCents(c.countedCashCents)} · expected {formatCents(expected)}.{" "}
        <span className="font-semibold">{describeDifference(differenceCents(c.countedCashCents, expected))}.</span>
      </p>
    </div>
  );
}

function RunningNotice({ running }: { running: DayCloseStateDTO["running"] }) {
  return (
    <section aria-label="Running tables" className="print:hidden">
      <Notice tone="warn">
        <p className="font-semibold">
          {running.length === 1 ? "A table is still running." : `${running.length} tables are still running.`} Stop
          {running.length === 1 ? " it" : " them"} before closing the day.
        </p>
        <ul className="mt-1 list-disc pl-5">
          {running.map((r) => (
            <li key={r.sessionId}>
              {r.label}
              {r.customerName ? ` (${r.customerName})` : ""}
            </li>
          ))}
        </ul>
        <Link
          href="/"
          className="mt-3 inline-flex min-h-12 items-center justify-center rounded-xl border border-line bg-surface-2 px-4 font-semibold text-chalk active:bg-line"
        >
          Go to the floor
        </Link>
      </Notice>
    </section>
  );
}
