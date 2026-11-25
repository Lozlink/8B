/**
 * Typed client for every server route. THIS FILE IS THE CONTRACT between the UI and the API:
 * routes under app/api/** implement exactly these paths, bodies and responses.
 *
 * Errors: every non-2xx response has the body { error: { code, message, detail? } }.
 * `message` is written for staff and safe to show as-is. Notable codes:
 *   401 unauthorized          → staff session missing/expired → go to /login
 *   401 device_not_enrolled   → go to /enrol
 *   401 invalid_credentials   → wrong PIN at login; show the message, stay on the page
 *   403 manager_required      → admin elevation expired → ask for manager PIN again
 *   409 conflict / invalid_transition / pricing_*  → show message, refetch floor
 *   409 bill_changed          → the bill's total is no longer the `expectedTotalCents` that was sent:
 *                               another iPad changed it. Nothing was done. Refetch the bill, show the
 *                               new amount, and let staff tap again.
 *   429 too_many_attempts     → show message
 *   502 square_error          → Square unreachable/refused; show message (staff can fall back to Mark paid)
 *   503 square_not_configured → Square env not set on the server; show message (use Square POS + Mark paid)
 */
import type {
  AdminStateDTO,
  AuditEntryDTO,
  DayCloseDTO,
  DayCloseStateDTO,
  EnquiryDTO,
  FloorDTO,
  MarkPaidOutcome,
  MeDTO,
  PairingCodeDTO,
  ProfitReportDTO,
  RefundDTO,
  SessionDetailDTO,
  SessionDTO,
  SettledMethod,
  StaffRole,
  SummaryDTO,
} from "@/lib/domain/types";
import type { CheckoutStatus } from "@/lib/domain/machine";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function isErrorBody(v: unknown): v is { error: { code: string; message: string; detail?: Record<string, unknown> } } {
  if (!v || typeof v !== "object" || !("error" in v)) return false;
  const e = (v as { error: unknown }).error;
  return !!e && typeof e === "object" && "message" in e && "code" in e;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  // A hung request must not freeze the UI: GETs give up after 8 s, POSTs after 35 s. Most routes cap at
  // 30 s; session actions may run to 60 s when Square is slow, and the server finishes the work
  // even if we stop waiting.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), method === "GET" ? 8000 : 35000);
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    text = await res.text();
  } catch {
    // An action that timed out may still have gone through on the server (e.g. the charge reached
    // the Terminal, or the bill was marked paid). Don't invite a blind retry of a money action.
    if (method === "POST" && controller.signal.aborted) {
      throw new ApiError(
        0,
        "network",
        "The server didn't answer in time — it may still have gone through. Check the bill's status before trying again.",
      );
    }
    throw new ApiError(0, "network", "No connection. Check the Wi-Fi and try again.");
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (isErrorBody(json)) throw new ApiError(res.status, json.error.code, json.error.message, json.error.detail);
    throw new ApiError(res.status, "http_error", `Request failed (${res.status}).`);
  }
  return json as T;
}

const get = <T>(p: string) => call<T>("GET", p);
const post = <T>(p: string, body: unknown = {}) => call<T>("POST", p, body);
const enc = encodeURIComponent;

export type ChargeResult = { kind: "sent"; checkoutId: string; amountCents: number } | { kind: "already_paid_by_card" };
export type WithWarnings<T> = T & { warnings: string[] };
export interface IntervalEditInput {
  id: string;
  startedAt: string; // ISO
  endedAt: string | null; // ISO; null only for the currently running interval
}

export const api = {
  // --- time / device / auth -------------------------------------------------
  time: () => get<{ now: string }>("/api/time"),

  /** setupNeeded = no active manager exists yet (first run) → enrol form also asks for the first manager. */
  device: () => get<{ device: { id: string; label: string } | null; setupNeeded: boolean }>("/api/device"),
  enrol: (body: { code: string; label: string; firstManager?: { name: string; pin: string } }) =>
    post<{ device: { id: string; label: string } }>("/api/device/enrol", body),

  staffList: () => get<{ staff: { id: string; name: string; role: StaffRole }[] }>("/api/auth/staff"),
  login: (staffId: string, pin: string) => post<{ me: MeDTO }>("/api/auth/login", { staffId, pin }),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  me: () => get<{ me: MeDTO }>("/api/auth/me"),

  // --- floor & sessions -----------------------------------------------------
  floor: () => get<FloorDTO>("/api/floor"),
  /** `who` is optional: a name (up to 40 characters) and a note (up to 200) for the new bill. */
  start: (tableId: string, who?: { customerName?: string; note?: string }) =>
    post<{ sessionId: string }>("/api/sessions", { tableId, ...who }),
  /**
   * Sets who a bill belongs to and the note on it. Send only what the person changed: a string
   * sets it (trimmed; name up to 40 characters, note up to 200), null or "" clears it, and a field
   * left out is left as it is (so two iPads changing different fields don't undo each other). Any staff member,
   * on any kind of bill (a table, a counter sale, a share of a split bill) while it is running,
   * paused or awaiting payment. It never changes what is owed. 409 once the bill is paid or void.
   */
  setDetails: (id: string, details: { customerName?: string | null; note?: string | null }) =>
    post<{ ok: true }>(`/api/sessions/${enc(id)}/set-details`, details),
  unpaid: () => get<{ sessions: SessionDTO[]; timezone: string }>("/api/sessions/unpaid"),
  session: (id: string) => get<SessionDetailDTO>(`/api/sessions/${enc(id)}`),

  pause: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/pause`),
  resume: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/resume`),
  transfer: (id: string, tableId: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/transfer`, { tableId }),
  stop: (id: string) =>
    post<{ status: "awaiting_payment" | "void"; billedMinutes: number; totalCents: number }>(`/api/sessions/${enc(id)}/stop`),
  /**
   * "Keep playing": a stopped table (awaiting payment, still on its table) goes back to running.
   * Its items and discount stay; the bill is worked out again at the next stop.
   *   countGap true  — stopped by mistake: the time since the stop is charged.
   *   countGap false — the clock starts again now; the time in between is not charged.
   * 409 if the bill has left its table, has been split, or a card request or Square POS cash sale is live.
   */
  continueSession: (id: string, countGap: boolean) => post<{ ok: true }>(`/api/sessions/${enc(id)}/continue`, { countGap }),
  /** "Leave unpaid": frees the table, bill goes to the unpaid list. */
  release: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/release`),

  /**
   * `expectedTotalCents` on charge, resend, markPaid, cashHandoff and split: the bill's
   * `SessionDTO.totalCents` as the screen showed it when staff tapped (the bill's total, NOT the
   * 5c-rounded cash amount). If the bill has changed since, the server answers 409 `bill_changed`
   * and does nothing. Left out, the server acts on whatever the bill is now.
   */
  charge: (id: string, expectedTotalCents?: number) =>
    post<ChargeResult>(`/api/sessions/${enc(id)}/charge`, { expectedTotalCents }),
  /** A stale `expectedTotalCents` is refused before the request already on the Terminal is cancelled. */
  resend: (id: string, expectedTotalCents?: number) =>
    post<ChargeResult>(`/api/sessions/${enc(id)}/resend`, { expectedTotalCents }),
  cancelCheckout: (id: string) =>
    post<{ status: CheckoutStatus | null; paid: boolean; warnings: string[] }>(`/api/sessions/${enc(id)}/cancel-checkout`),
  /** Ask Square now (use while the "Sent to Terminal" panel is open, every ~5 s). */
  sync: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/sync`),

  /**
   * method "card" requires cardConfirmed: true (staff ticked "approved on Terminal/Square").
   * method "cash": the app records the sale in Square itself (in the background), for the bill
   * rounded to 5c. Staff must NOT also ring it into Square POS.
   * `expectedTotalCents` (see `charge`): 409 `bill_changed` if the bill is no longer that amount.
   */
  markPaid: (id: string, method: SettledMethod, cardConfirmed = false, expectedTotalCents?: number) =>
    post<WithWarnings<MarkPaidOutcome>>(`/api/sessions/${enc(id)}/mark-paid`, { method, cardConfirmed, expectedTotalCents }),

  /**
   * Cash through the Square POS app on this iPad, so the drawer on the Square Stand opens.
   * Returns the link that opens Square POS with the cash amount filled in. Square POS records the
   * sale (amount and a note, not itemised); the app must not also record it. 409 if a card request
   * is live; 503 if Square POS handoff isn't configured.
   * `expectedTotalCents` (see `charge`) is the bill's total, not the rounded cash amount returned here.
   */
  cashHandoff: (id: string, expectedTotalCents?: number) =>
    post<{ url: string; amountCents: number }>(`/api/sessions/${enc(id)}/cash-handoff`, { expectedTotalCents }),
  /**
   * Asks Square whether the cash sale handed to Square POS went through, and settles the bill if
   * so. Call when the app comes back to the front after a handoff, and before offering the manual
   * cash button again.
   */
  cashHandoffCheck: (id: string) =>
    post<{ paid: boolean }>(`/api/sessions/${enc(id)}/cash-handoff-check`),

  /**
   * Public (no cookies): sends Square POS's callback `data` (the raw JSON string from the return
   * link) to the server, which settles the bill if the sale went through.
   */
  posReturn: (data: string) =>
    post<{ result: "paid" | "canceled" | "pending" | "error"; message: string }>("/api/pos/return", { data }),

  /**
   * Puts `quantity` (1–99) of a product on the bill at the product's current price. Allowed while
   * running, paused or awaiting payment; 409 if a card request is live on the Terminal.
   */
  addItem: (id: string, productId: string, quantity = 1) =>
    post<{ ok: true }>(`/api/sessions/${enc(id)}/add-item`, { productId, quantity }),
  /** Takes one item line off the bill (the record is kept). Same rules as addItem. */
  removeItem: (id: string, itemId: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/remove-item`, { itemId }),
  /**
   * A custom charge: a name (1–60 characters) and a price (1c to $2,000) typed in by staff. Same
   * rules as addItem; taken off again with removeItem.
   */
  addCustomItem: (id: string, name: string, amountCents: number) =>
    post<{ ok: true }>(`/api/sessions/${enc(id)}/add-custom-item`, { name, amountCents }),

  /**
   * A sale with no table. Creates an empty bill awaiting payment (it shows in the Unpaid list as
   * "Counter sale"); put items on it and charge it like any bill.
   */
  counterSale: () => post<{ sessionId: string }>("/api/sessions/counter"),
  /** Throws away a counter sale that has nothing on it. No manager needed. 409 otherwise. */
  discard: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/discard`),

  /**
   * Puts a discount on the bill, replacing any already there. Allowed while running, paused or
   * awaiting payment; 409 if a card request is live, on a part, or once the bill has parts.
   *   { discountId }                       — a fixed discount from Square; any staff member
   *   { discountId, value, managerPin }    — a variable discount from Square; value = basis points or cents
   *   { custom, managerPin }               — typed in by a manager; value = basis points (percent) or cents (amount)
   */
  setDiscount: (
    id: string,
    body:
      | { discountId: string }
      | { discountId: string; value: number; managerPin: string }
      | { custom: { name: string; kind: "percent" | "amount"; value: number }; managerPin: string },
  ) => post<{ ok: true }>(`/api/sessions/${enc(id)}/set-discount`, body),
  removeDiscount: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/remove-discount`),

  /**
   * Splits a bill awaiting payment. `ways` (2–10) splits what is owed evenly, this bill keeping one
   * share and any odd cents; `amountCents` takes one share of that size out. Each share becomes its
   * own bill (kind "part") in the Unpaid list, paid like any other.
   * `expectedTotalCents` (see `charge`): what the screen showed as owed on this bill. Send it: two
   * iPads both tapping "Split 2 ways" on the same amount would otherwise split it twice.
   */
  split: (id: string, body: ({ ways: number } | { amountCents: number }) & { expectedTotalCents?: number }) =>
    post<{ partIds: string[] }>(`/api/sessions/${enc(id)}/split`, body),
  /** On a part that hasn't been paid: folds it back into the bill it came from. */
  mergeBack: (partId: string) => post<{ ok: true }>(`/api/sessions/${enc(partId)}/merge-back`),

  /**
   * Prints a receipt for a paid bill on the Square Terminal. Returns once Square has accepted the
   * request; the Terminal prints when it is free. 409 if the bill can't have one printed
   * (SessionDTO.canPrintReceipt says so beforehand).
   */
  printReceipt: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/print-receipt`),

  // Manager actions: manager PIN + reason travel with the request.
  /**
   * Refunds part or all of a paid bill through Square: back to the card, or (cash) recorded in
   * Square while staff hand the money back. amountCents ≤ SessionDTO.refundable.maxCents; cash must
   * be a multiple of 5c. Waits for Square's first answer: the refund comes back `completed`,
   * `pending` (Square is still processing; it is finished off in the background) — or the call
   * fails with Square's reason and nothing was refunded. A 4xx always means nothing was refunded;
   * a 5xx or no answer means it may have gone through.
   *
   * `requestId` is a UUID the screen makes ONCE for each refund the manager means to make, and
   * sends again unchanged on every retry of that same refund (lost answer, timeout, second tap).
   * The server makes one refund per request id: a repeat returns the refund the first request
   * made, as it stands now, instead of making another. A new refund needs a new id. The same id
   * with a different amount, or on a different bill, is a 409 and nothing is written.
   */
  refund: (id: string, managerPin: string, reason: string, amountCents: number, requestId: string) =>
    post<{ refund: RefundDTO }>(`/api/sessions/${enc(id)}/refund`, { managerPin, reason, amountCents, requestId }),
  /**
   * A manager who has looked at the payment in Square Dashboard says what happened to a refund the
   * app stopped trying (RefundDTO.needsCheck). `id` is the bill, `refundId` the refund on it.
   *   "refunded"     — it is in Square: the refund becomes `completed`; the bill's money is unchanged.
   *   "not_refunded" — it is not in Square: the refund becomes `failed` and its amount can be
   *                    refunded again. The server reads the payment from Square first (up to 8 s).
   * Answers with the refund as it now stands (needsCheck false). Refetch the bill and the summary
   * afterwards. Any 4xx means nothing was changed:
   *   409 `conflict`            — not a refund that needs checking any more (already settled, Square
   *                               has it, the app is still trying, or it isn't on this bill). That
   *                               includes a second identical call: it is not answered twice.
   *   409 `square_shows_refund` — "not_refunded" only: Square shows more refunded on the payment
   *                               than the app knows about, so the refund looks like it went through.
   */
  settleRefund: (id: string, managerPin: string, reason: string, refundId: string, outcome: "refunded" | "not_refunded") =>
    post<{ refund: RefundDTO }>(`/api/sessions/${enc(id)}/settle-refund`, { managerPin, reason, refundId, outcome }),
  void: (id: string, managerPin: string, reason: string) =>
    post<{ kind: "voided" } | { kind: "already_paid_by_card" }>(`/api/sessions/${enc(id)}/void`, { managerPin, reason }),
  reverse: (id: string, managerPin: string, reason: string) =>
    post<{ ok: true }>(`/api/sessions/${enc(id)}/reverse`, { managerPin, reason }),
  editTimes: (id: string, managerPin: string, reason: string, intervals: IntervalEditInput[]) =>
    post<{ totalCents: number | null }>(`/api/sessions/${enc(id)}/edit-times`, { managerPin, reason, intervals }),

  // --- reporting --------------------------------------------------------------
  /** date = local business date YYYY-MM-DD; omit for the current business day. */
  summary: (date?: string) => get<SummaryDTO>(`/api/summary${date ? `?date=${enc(date)}` : ""}`),

  /**
   * A manager marks a summary "Needs attention" entry (`AttentionEntryDTO.id`) as checked. It only
   * clears the notice. 409 if someone already has; refetch the summary either way.
   */
  checkAttention: (entryId: string, managerPin: string) =>
    post<{ ok: true }>("/api/summary/attention", { entryId, managerPin }),

  // --- end of day ---------------------------------------------------------------
  /** date = local business date YYYY-MM-DD; omit for the business day running now. */
  dayClose: (date?: string) => get<DayCloseStateDTO>(`/api/day-close${date ? `?date=${enc(date)}` : ""}`),
  /** The last 60 closes, newest first (one row per time a day was closed). */
  dayCloses: () => get<{ closes: DayCloseDTO[] }>("/api/day-close?history=1"),
  /**
   * Closes a business day: records the cash counted against the cash the app expects and keeps the
   * day's figures as they stand. Nothing is locked: bills can still be taken afterwards (the screen
   * then shows the day has moved since it was closed).
   *   date               — omit for the business day running now; a future date is refused.
   *   floatCents         — cash in the drawer before the first sale.
   *   countedCashCents   — what is in the drawer now, float included.
   *   cashCounts         — optional: face value in cents → how many. Must add up to countedCashCents.
   *   expectedTakingsCents — `DayCloseStateDTO.totals.takingsCents` as the screen showed it.
   *   expectedCashMovementCents — `DayCloseStateDTO.cashMovementCents` as the screen showed it.
   *                        Send both. If either has moved since, 409 `day_changed` and nothing is
   *                        written: reload and show the new figures.
   * Any staff member can make the first close of today or yesterday. `managerPin` and `reason` are
   * needed when `DayCloseStateDTO.needsManager` is true: the day is already closed (409
   * `already_closed` without them) or it is older than yesterday (409 `needs_manager`).
   * Sending the same close twice within two minutes (a lost answer, a second iPad) answers with
   * the close already made and writes nothing.
   *   409 `tables_running` — current day only: a table is still running or paused.
   */
  closeDay: (body: {
    date?: string;
    floatCents: number;
    countedCashCents: number;
    cashCounts?: Record<string, number>;
    note?: string;
    expectedTakingsCents?: number;
    expectedCashMovementCents?: number;
    managerPin?: string;
    reason?: string;
  }) => post<{ close: DayCloseDTO }>("/api/day-close", body),

  // --- admin (requires elevation cookie from adminElevate) -------------------
  adminElevate: (pin: string) =>
    post<{ manager: { id: string; name: string }; expiresInSeconds: number }>("/api/admin/elevate", { pin }),
  adminDrop: () => post<{ ok: true }>("/api/admin/drop"),
  adminState: () => get<AdminStateDTO>("/api/admin/state"),

  adminTable: (
    body:
      | { op: "create"; name: string; reason: string }
      | { op: "update"; id: string; name?: string; sortOrder?: number; active?: boolean; reason: string },
  ) => post<{ ok: true }>("/api/admin/tables", body),

  adminRateCard: (
    body:
      | {
          op: "create";
          name: string;
          centsPerHour: number;
          daysOfWeek: number[];
          startLocal: string;
          endLocal: string;
          priority: number;
          reason: string;
        }
      | {
          op: "update";
          id: string;
          name?: string;
          centsPerHour?: number;
          daysOfWeek?: number[];
          startLocal?: string;
          endLocal?: string;
          priority?: number;
          active?: boolean;
          reason: string;
        },
  ) => post<{ ok: true }>("/api/admin/rate-cards", body),

  adminSettings: (body: {
    roundingMinutes: number;
    graceMinutes: number;
    minimumMinutes: number;
    businessDayStart: string; // "HH:MM"
    reason: string;
  }) => post<{ ok: true }>("/api/admin/settings", body),

  adminStaff: (
    body:
      | { op: "create"; name: string; role: StaffRole; pin: string; reason: string }
      | { op: "update"; id: string; name?: string; role?: StaffRole; active?: boolean; pin?: string; reason: string },
  ) => post<{ ok: true }>("/api/admin/staff", body),

  /** Re-reads the item list from Square now. 502/503 if Square can't be reached or isn't configured. */
  adminSyncProducts: () => post<{ count: number }>("/api/admin/products", { op: "sync" }),
  /**
   * Re-sends every stock update Square refused or that kept failing, and anything still waiting.
   * Answers with what is still outstanding afterwards.
   */
  adminRetryStock: () => post<{ pending: number; failed: number }>("/api/admin/products", { op: "stock-retry" }),
  /**
   * Sets what products cost the venue, EX GST, in whole cents (0 to $10,000); null clears one.
   * Up to 500 at a time. Unknown product ids are a 400 and nothing is saved. Costs stay in the
   * app: Square is not told. `changed` is how many were different from what was there.
   */
  adminSetCosts: (costs: { productId: string; costCents: number | null }[]) =>
    post<{ changed: number }>("/api/admin/products", { op: "costs", costs }),
  /**
   * Profit on items sold between two business dates (YYYY-MM-DD, both included, at most 366 days).
   * Leave both out for the business day running now.
   */
  adminProfit: (from?: string, to?: string) =>
    get<ProfitReportDTO>(`/api/admin/profit${from && to ? `?from=${enc(from)}&to=${enc(to)}` : ""}`),
  /** Turns itemised Square charges on or off. */
  adminItemise: (enabled: boolean, reason: string) =>
    post<{ ok: true }>("/api/admin/products", { op: "itemise", enabled, reason }),

  /**
   * Sends every cash payment that isn't in Square yet, including ones that had failed. Returns what
   * is still outstanding afterwards. 503 if Square isn't configured.
   */
  adminRetrySquareCash: () => post<{ pending: number; failed: number; lastError: string | null }>("/api/admin/square-cash", { op: "retry" }),

  adminRevokeDevice: (id: string, reason: string) => post<{ ok: true }>("/api/admin/devices", { op: "revoke", id, reason }),

  /** Production only — Square's sandbox can't pair a real Terminal. Poll pairStatus every 3 s until PAIRED/EXPIRED. */
  pairTerminal: () => post<PairingCodeDTO>("/api/admin/terminal/pair"),
  pairStatus: (codeId: string) => get<PairingCodeDTO>(`/api/admin/terminal/pair?codeId=${enc(codeId)}`),
  unpairTerminal: (reason: string) => post<{ ok: true }>("/api/admin/terminal/unpair", { reason }),

  enquiries: () => get<{ enquiries: EnquiryDTO[] }>("/api/admin/enquiries"),
  setEnquiryHandled: (id: string, handled: boolean) => post<{ ok: true }>("/api/admin/enquiries", { id, handled }),

  audit: (q: { before?: string; entity?: string; entityId?: string; action?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
    const qs = params.toString();
    return get<{ entries: AuditEntryDTO[]; nextBefore: string | null }>(`/api/admin/audit${qs ? `?${qs}` : ""}`);
  },
};
