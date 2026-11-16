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
 *   429 too_many_attempts     → show message
 *   502 square_error          → Square unreachable/refused; show message (staff can fall back to Mark paid)
 *   503 square_not_configured → Square env not set on the server; show message (use Square POS + Mark paid)
 */
import type {
  AdminStateDTO,
  AuditEntryDTO,
  FloorDTO,
  MarkPaidOutcome,
  MeDTO,
  PairingCodeDTO,
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
  // A hung request must not freeze the UI: GETs give up after 8 s, POSTs after 35 s (routes cap at 30 s).
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
  start: (tableId: string) => post<{ sessionId: string }>("/api/sessions", { tableId }),
  unpaid: () => get<{ sessions: SessionDTO[]; timezone: string }>("/api/sessions/unpaid"),
  session: (id: string) => get<SessionDetailDTO>(`/api/sessions/${enc(id)}`),

  pause: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/pause`),
  resume: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/resume`),
  transfer: (id: string, tableId: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/transfer`, { tableId }),
  stop: (id: string) =>
    post<{ status: "awaiting_payment" | "void"; billedMinutes: number; totalCents: number }>(`/api/sessions/${enc(id)}/stop`),
  /** "Leave unpaid": frees the table, bill goes to the unpaid list. */
  release: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/release`),

  charge: (id: string) => post<ChargeResult>(`/api/sessions/${enc(id)}/charge`),
  resend: (id: string) => post<ChargeResult>(`/api/sessions/${enc(id)}/resend`),
  cancelCheckout: (id: string) =>
    post<{ status: CheckoutStatus | null; paid: boolean; warnings: string[] }>(`/api/sessions/${enc(id)}/cancel-checkout`),
  /** Ask Square now (use while the "Sent to Terminal" panel is open, every ~5 s). */
  sync: (id: string) => post<{ ok: true }>(`/api/sessions/${enc(id)}/sync`),

  /** method "card" requires cardConfirmed: true (staff ticked "approved on Terminal/Square"). */
  markPaid: (id: string, method: SettledMethod, cardConfirmed = false) =>
    post<WithWarnings<MarkPaidOutcome>>(`/api/sessions/${enc(id)}/mark-paid`, { method, cardConfirmed }),

  // Manager actions: manager PIN + reason travel with the request.
  void: (id: string, managerPin: string, reason: string) =>
    post<{ kind: "voided" } | { kind: "already_paid_by_card" }>(`/api/sessions/${enc(id)}/void`, { managerPin, reason }),
  reverse: (id: string, managerPin: string, reason: string) =>
    post<{ ok: true }>(`/api/sessions/${enc(id)}/reverse`, { managerPin, reason }),
  editTimes: (id: string, managerPin: string, reason: string, intervals: IntervalEditInput[]) =>
    post<{ totalCents: number | null }>(`/api/sessions/${enc(id)}/edit-times`, { managerPin, reason, intervals }),

  // --- reporting --------------------------------------------------------------
  /** date = local business date YYYY-MM-DD; omit for the current business day. */
  summary: (date?: string) => get<SummaryDTO>(`/api/summary${date ? `?date=${enc(date)}` : ""}`),

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

  adminRevokeDevice: (id: string, reason: string) => post<{ ok: true }>("/api/admin/devices", { op: "revoke", id, reason }),

  /** Production only — Square's sandbox can't pair a real Terminal. Poll pairStatus every 3 s until PAIRED/EXPIRED. */
  pairTerminal: () => post<PairingCodeDTO>("/api/admin/terminal/pair"),
  pairStatus: (codeId: string) => get<PairingCodeDTO>(`/api/admin/terminal/pair?codeId=${enc(codeId)}`),
  unpairTerminal: (reason: string) => post<{ ok: true }>("/api/admin/terminal/unpair", { reason }),

  audit: (q: { before?: string; entity?: string; entityId?: string; action?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
    const qs = params.toString();
    return get<{ entries: AuditEntryDTO[]; nextBefore: string | null }>(`/api/admin/audit${qs ? `?${qs}` : ""}`);
  },
};
