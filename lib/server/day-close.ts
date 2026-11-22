import "server-only";
import { currentBusinessDate, formatYMD } from "@/lib/domain/business-day";
import { hasMoved, totalsOf } from "@/lib/domain/day-close";
import type { DayCloseDTO, DayCloseStateDTO, DayCloseTotals, SummaryDTO } from "@/lib/domain/types";
import { audit } from "./audit";
import type { Actor, Manager } from "./auth";
import { db, withTx, type Db } from "./db";
import { AppError, badRequest } from "./errors";
import { billLabelSql, getSummary, parseYMD } from "./queries";
import { getSettings } from "./repo";

/*
 * Closing the business day.
 *
 * A close is a record, not a lock: it keeps the cash staff counted against the cash the app
 * expected, and the day's figures as they stood. Bills can still be taken afterwards (a late
 * sale, an unpaid bill settled the next morning); the screen then says the day has moved since it
 * was closed, and a manager can close it again. Rows are append-only (see the migration).
 */

/** The float the form starts with when no day has been closed yet (the venue's Square float). */
export const DEFAULT_FLOAT_CENTS = 20_000;
const FLOAT_MAX_CENTS = 10_000_000;
const COUNT_MAX_CENTS = 100_000_000;
/** Australian notes and coins, in cents. */
export const DENOMINATIONS = [10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50, 20, 10, 5] as const;
const NOTE_MAX = 500;

export { hasMoved, totalsOf };

interface CloseRow {
  id: string;
  business_date: string;
  seq: number;
  closed_at: Date;
  closed_by_name: string;
  approved_by_name: string | null;
  device_label: string | null;
  float_cents: number;
  counted_cash_cents: number;
  expected_cash_cents: number;
  variance_cents: number;
  cash_counts: Record<string, number> | null;
  note: string | null;
  reason: string | null;
  totals: DayCloseTotals;
}

const closeDTO = (r: CloseRow): DayCloseDTO => ({
  id: r.id,
  businessDate: r.business_date,
  seq: r.seq,
  closedAt: r.closed_at.toISOString(),
  closedByName: r.closed_by_name,
  approvedByName: r.approved_by_name,
  deviceLabel: r.device_label,
  floatCents: r.float_cents,
  countedCashCents: r.counted_cash_cents,
  expectedCashCents: r.expected_cash_cents,
  varianceCents: r.variance_cents,
  cashCounts: r.cash_counts,
  note: r.note,
  reason: r.reason,
  totals: r.totals,
});

/** Closes, newest first: one day's (`date` set) or the latest `limit` of any day. */
async function loadCloses(q: Db, opts: { date?: string; limit: number }): Promise<DayCloseDTO[]> {
  const rows = await q<CloseRow[]>`
    select c.id, c.business_date::text as business_date, c.seq, c.closed_at, cb.name as closed_by_name,
           ab.name as approved_by_name, c.device_label, c.float_cents, c.counted_cash_cents,
           c.expected_cash_cents, c.variance_cents, c.cash_counts, c.note, c.reason, c.totals
    from public.day_closes c
    join public.staff cb on cb.id = c.closed_by
    left join public.staff ab on ab.id = c.approved_by
    where ${opts.date ? q`c.business_date = ${opts.date}::date` : q`true`}
    order by c.business_date desc, c.seq desc
    limit ${opts.limit}`;
  return rows.map(closeDTO);
}

export async function listDayCloses(): Promise<{ closes: DayCloseDTO[] }> {
  return { closes: await loadCloses(db(), { limit: 60 }) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function warningsOf(s: SummaryDTO, isCurrent: boolean, unclosedYesterday: boolean): string[] {
  const out: string[] = [];
  if (unclosedYesterday) {
    out.push("Yesterday had sales and hasn't been closed. If you are counting last night's drawer, go back a day and close that one.");
  }
  if (s.unpaid.count > 0) {
    out.push(`${plural(s.unpaid.count, "bill from this day is", "bills from this day are")} still unpaid (${dollars(s.unpaid.cents)}). ${s.unpaid.count === 1 ? "It stays" : "They stay"} on the Unpaid list.`);
  }
  if (isCurrent && s.outstandingOlder.count > 0) {
    out.push(`${plural(s.outstandingOlder.count, "bill from an earlier day is", "bills from earlier days are")} still unpaid (${dollars(s.outstandingOlder.cents)}).`);
  }
  if (s.squareCashOutstanding.count > 0) {
    const c = s.squareCashOutstanding;
    out.push(
      c.failed > 0
        ? `${plural(c.count, "cash payment isn't", "cash payments aren't")} in Square yet (${dollars(c.cents)}), and ${c.failed} failed. A manager can retry under Admin, Items. Square's cash total will be lower than the app's until then.`
        : `${plural(c.count, "cash payment isn't", "cash payments aren't")} in Square yet (${dollars(c.cents)}). They are sent in the background; Square's cash total will be lower than the app's until then.`,
    );
  }
  if (s.refundsOutstanding.count > 0) {
    out.push(`${plural(s.refundsOutstanding.count, "refund", "refunds")} couldn't be confirmed (${dollars(s.refundsOutstanding.cents)}). A manager needs to check Square: see the Summary.`);
  }
  const unchecked = s.attention.filter((a) => a.checked === null).length;
  if (unchecked > 0) out.push(`${plural(unchecked, "item", "items")} under Needs attention on the Summary ${unchecked === 1 ? "hasn't" : "haven't"} been checked.`);
  return out;
}

/** Everything the End of day screen shows for one business day. `dateParam` null = the day running now. */
export async function getDayCloseState(dateParam: string | null): Promise<DayCloseStateDTO> {
  const q = db();
  // The summary validates the date and works out the day's window; the close is built on its figures.
  const [summary, settings] = await Promise.all([getSummary(dateParam), getSettings(q)]);
  const current = formatYMD(currentBusinessDate(new Date(), settings.businessDayStartMinute, settings.timezone));
  const isCurrent = summary.businessDate === current;
  const totals = totalsOf(summary);

  const [y, m, d] = summary.businessDate.split("-").map(Number);
  const dayBefore = (n: number) => new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);

  const [closes, [last], running, [yesterday]] = await Promise.all([
    loadCloses(q, { date: summary.businessDate, limit: 20 }),
    q<{ float_cents: number }[]>`
      select float_cents from public.day_closes order by business_date desc, seq desc limit 1`,
    // Only the day running now can have tables still going. An earlier day's tables are long stopped.
    isCurrent
      ? q<{ id: string; label: string; customer_name: string | null }[]>`
          select s.id, ${billLabelSql(q)} as label, s.customer_name
          from public.sessions s
          where s.status in ('running', 'paused')
          order by s.opened_at, s.id`
      : Promise.resolve([] as { id: string; label: string; customer_name: string | null }[]),
    // Past 06:00 the screen opens on the new day. Whoever is counting last night's drawer the
    // morning after needs telling, before they close the wrong one. "Had sales" = a bill was
    // settled in yesterday's window (it ends where this day's begins).
    isCurrent
      ? q<{ unclosed: boolean }[]>`
          select not exists (select 1 from public.day_closes c where c.business_date = ${dayBefore(1)}::date)
                 and exists (select 1 from public.sessions s
                             where s.status = 'paid' and s.settled_at < ${summary.from}
                               and s.settled_at >= ${summary.from}::timestamptz - interval '25 hours') as unclosed`
      : Promise.resolve([{ unclosed: false }]),
  ]);
  // The business date running now, less one: both are YYYY-MM-DD, so they compare as text.
  const [cy, cm, cd] = current.split("-").map(Number);
  const yesterdayOfNow = new Date(Date.UTC(cy, cm - 1, cd - 1)).toISOString().slice(0, 10);

  return {
    businessDate: summary.businessDate,
    isCurrent,
    timezone: settings.timezone,
    from: summary.from,
    to: summary.to,
    totals,
    // Closing a day again starts from what was entered for it last time.
    suggestedFloatCents: closes[0]?.floatCents ?? last?.float_cents ?? DEFAULT_FLOAT_CENTS,
    cashMovementCents: totals.cashCents - totals.refundCashCents,
    running: running.map((r) => ({ sessionId: r.id, label: r.label, customerName: r.customer_name })),
    warnings: warningsOf(summary, isCurrent, yesterday?.unclosed === true),
    closes,
    needsManager: closes.length > 0 || summary.businessDate < yesterdayOfNow,
    changedSinceClose: closes[0] ? hasMoved(closes[0].totals, totals) : false,
  };
}

export interface CloseDayInput {
  /** YYYY-MM-DD; null = the business day running now. */
  date: string | null;
  floatCents: number;
  countedCashCents: number;
  cashCounts?: Record<string, number> | null;
  note?: string | null;
  /** The takings and the cash movement the screen showed. When sent and no longer true, nothing is written. */
  expectedTakingsCents?: number;
  expectedCashMovementCents?: number;
  reason?: string | null;
}

function checkCash(input: CloseDayInput): Record<string, number> | null {
  const whole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!whole(input.floatCents, FLOAT_MAX_CENTS)) throw badRequest("Enter the float as a dollar amount.");
  if (!whole(input.countedCashCents, COUNT_MAX_CENTS)) throw badRequest("Enter the cash counted as a dollar amount.");
  // The smallest coin is 5c, so anything else is a slip of the finger.
  if (input.floatCents % 5 !== 0) throw badRequest("The float has to end in 0 or 5 cents.");
  if (input.countedCashCents % 5 !== 0) throw badRequest("The cash counted has to end in 0 or 5 cents.");
  if (!input.cashCounts) return null;

  const counts: Record<string, number> = {};
  let sum = 0;
  for (const [face, n] of Object.entries(input.cashCounts)) {
    const cents = Number(face);
    // The key has to be the face value written plainly ("100"), so two spellings of one coin
    // ("100" and "0100") can't both be sent and one overwrite the other in what is kept.
    if (String(cents) !== face || !(DENOMINATIONS as readonly number[]).includes(cents)) {
      throw badRequest("That isn't an Australian note or coin.");
    }
    if (!Number.isInteger(n) || n < 0 || n > 100_000) throw badRequest("Enter how many of each note and coin as a whole number.");
    if (n === 0) continue;
    counts[String(cents)] = n;
    sum += cents * n;
  }
  if (sum !== input.countedCashCents) throw badRequest("The notes and coins don't add up to the cash counted. Check the count.");
  return counts;
}

/**
 * Closes a business day. Any staff member can make a day's first close; closing it again needs
 * `manager` (their PIN was checked by the route) and a reason.
 */
export async function closeDay(actor: Actor, manager: Manager | null, input: CloseDayInput): Promise<{ close: DayCloseDTO }> {
  const counts = checkCash(input);
  const note = (input.note ?? "").trim() || null;
  if (note && note.length > NOTE_MAX) throw badRequest(`A note can be ${NOTE_MAX} characters at most.`);
  const reason = (input.reason ?? "").trim() || null;

  const q = db();
  if (input.date) {
    const settings = await getSettings(q);
    const today = formatYMD(currentBusinessDate(new Date(), settings.businessDayStartMinute, settings.timezone));
    // Both are YYYY-MM-DD, so they compare as text.
    if (formatYMD(parseYMD(input.date)) > today) throw badRequest("That day hasn't started yet.");
  }

  const state = await getDayCloseState(input.date);
  if (state.running.length > 0) {
    const names = state.running.map((r) => r.label);
    throw new AppError(
      409,
      "tables_running",
      `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} ${names.length === 1 ? "is" : "are"} still running. Stop ${names.length === 1 ? "it" : "them"} before closing the day.`,
      { sessionIds: state.running.map((r) => r.sessionId) },
    );
  }
  const already = state.closes[0] ?? null;
  // The same close sent twice (the answer was lost, or a second iPad sent it too): answer with the
  // one already made. A close is permanent, so a retry must never add a second row.
  if (
    already &&
    Date.now() - Date.parse(already.closedAt) < 120_000 &&
    already.floatCents === input.floatCents &&
    already.countedCashCents === input.countedCashCents &&
    (already.note ?? null) === note &&
    !hasMoved(already.totals, state.totals)
  ) {
    return { close: already };
  }
  // Takings alone would miss a cash bill reopened and paid again by card: the takings are the
  // same, the cash that should be in the drawer is not.
  if (
    (input.expectedTakingsCents !== undefined && input.expectedTakingsCents !== state.totals.takingsCents) ||
    (input.expectedCashMovementCents !== undefined && input.expectedCashMovementCents !== state.cashMovementCents)
  ) {
    throw new AppError(409, "day_changed", "The day's figures have changed. Check them and close again.");
  }
  if (state.needsManager) {
    if (!manager) {
      throw already
        ? new AppError(409, "already_closed", "This day is already closed. A manager can close it again.")
        : new AppError(409, "needs_manager", "A day this far back needs a manager to close it.");
    }
    if (!reason || reason.length < 3) throw badRequest(already ? "Say why the day is being closed again." : "Say why this day is being closed now.");
  }

  const expected = input.floatCents + state.cashMovementCents;
  const variance = input.countedCashCents - expected;
  const seq = (already?.seq ?? 0) + 1;

  // Two people closing the same day at once: `unique (business_date, seq)` lets one through and
  // the other gets a 409 (see CONSTRAINT_MESSAGES in http.ts).
  const id = await withTx(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into public.day_closes
        (business_date, seq, closed_by, approved_by, device_label, float_cents, counted_cash_cents,
         expected_cash_cents, variance_cents, cash_counts, note, reason, totals)
      values (
        ${state.businessDate}::date, ${seq}, ${actor.staffId}, ${manager?.id ?? null}, ${actor.deviceLabel},
        ${input.floatCents}, ${input.countedCashCents}, ${expected}, ${variance},
        ${counts ? JSON.stringify(counts) : null}::text::jsonb, ${note}, ${state.needsManager ? reason : null},
        ${JSON.stringify(state.totals)}::text::jsonb
      )
      returning id`;
    await audit(tx, {
      actorStaffId: actor.staffId,
      approvedByStaffId: manager?.id ?? null,
      deviceLabel: actor.deviceLabel,
      action: already ? "day.close_again" : "day.close",
      entity: "day",
      entityId: state.businessDate,
      before: already ? { seq: already.seq, counted_cash_cents: already.countedCashCents, variance_cents: already.varianceCents } : undefined,
      after: {
        seq,
        float_cents: input.floatCents,
        counted_cash_cents: input.countedCashCents,
        expected_cash_cents: expected,
        variance_cents: variance,
        takings_cents: state.totals.takingsCents,
      },
      reason: state.needsManager ? reason : note,
    });
    return row.id;
  });

  const [close] = (await loadCloses(q, { date: state.businessDate, limit: 20 })).filter((c) => c.id === id);
  if (!close) throw new Error(`day close ${id} was written but can't be read back`);
  return { close };
}
