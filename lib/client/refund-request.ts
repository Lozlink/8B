/**
 * The id that makes a refund safe to send twice. One id belongs to one refund the manager means to
 * make: this bill, this amount. The server returns the refund it already made for an id it has seen,
 * so repeating the id after a lost answer can never refund twice.
 *
 *   - Lost answer (timeout, dropped connection, server error): keep the id. A retry of the same bill
 *     and amount sends it again.
 *   - Rejected before anything was done (wrong PIN, too many tries, amount checks): nothing was learned
 *     about this refund, so the id stays as it was.
 *   - Settled (the refund was made, or Square refused it): the id is spent. The next refund gets a new one.
 *   - Different bill or amount: a different refund, so a new id.
 */
export interface RefundAttempt {
  requestId: string;
  sessionId: string;
  amountCents: number;
}

/**
 * What the last call told us about THIS refund.
 *   unknown  — a timeout, a dropped connection or a 5xx: it may or may not have happened
 *   rejected — turned away before anything was done (wrong PIN, validation): nothing learned
 *   settled  — it was made (200), or Square refused it (409 refund_failed): the answer is final
 */
export type CallOutcome = "unknown" | "rejected" | "settled";

type RandomSource = Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** A random (version 4) UUID. `crypto.randomUUID` only exists on secure pages, so fall back to building one. */
export function newRequestId(source: RandomSource | undefined = globalThis.crypto): string {
  if (source && typeof source.randomUUID === "function") return source.randomUUID();
  const b = new Uint8Array(16);
  if (source && typeof source.getRandomValues === "function") source.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => HEX[x]!);
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
}

/** The attempt to send: the previous one if it is the same refund, otherwise a fresh one. */
export function attemptFor(
  prev: RefundAttempt | null,
  sessionId: string,
  amountCents: number,
  makeId: () => string = newRequestId,
): RefundAttempt {
  if (prev && prev.sessionId === sessionId && prev.amountCents === amountCents) return prev;
  return { requestId: makeId(), sessionId, amountCents };
}

/** What to keep once the call has answered: the attempt, until some answer settles it. */
export function attemptAfter(attempt: RefundAttempt, outcome: CallOutcome): RefundAttempt | null {
  return outcome === "settled" ? null : attempt;
}

// ---------------------------------------------------------------------------
// Remembering a lost answer
// ---------------------------------------------------------------------------

/** How long a lost answer is remembered. After this, the manager has long since looked at the bill. */
export const ATTEMPT_TTL_MS = 30 * 60_000;

export interface AttemptStore {
  /** The refund whose answer was lost on this bill, if there is one still worth guarding. */
  get(sessionId: string, now?: number): RefundAttempt | null;
  /** Remember one (answer lost), or forget it (null: some answer settled it). */
  set(sessionId: string, attempt: RefundAttempt | null, now?: number): void;
}

type Backing = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const keyOf = (sessionId: string) => `refund-attempt:${sessionId}`;

function isStored(v: unknown): v is { attempt: RefundAttempt; at: number } {
  if (!v || typeof v !== "object") return false;
  const { attempt, at } = v as { attempt?: Partial<RefundAttempt>; at?: unknown };
  return (
    typeof at === "number" &&
    !!attempt &&
    typeof attempt.requestId === "string" &&
    typeof attempt.sessionId === "string" &&
    typeof attempt.amountCents === "number"
  );
}

/**
 * Keeps the lost attempt across the dialog being closed and reopened (and the page reloading), so a
 * second try at the same amount reuses the id and can't refund twice. `backing` is sessionStorage in
 * the browser; if it is missing or throws (private mode), a plain in-memory map takes over.
 */
export function createAttemptStore(backing: Backing | null): AttemptStore {
  const memory = new Map<string, { attempt: RefundAttempt; at: number }>();
  return {
    get(sessionId, now = Date.now()) {
      let entry: { attempt: RefundAttempt; at: number } | undefined;
      try {
        const raw = backing?.getItem(keyOf(sessionId)) ?? null;
        const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
        if (isStored(parsed)) entry = parsed;
      } catch {
        // unreadable: fall back to memory
      }
      entry ??= memory.get(sessionId);
      if (!entry) return null;
      if (now - entry.at > ATTEMPT_TTL_MS || entry.attempt.sessionId !== sessionId) {
        this.set(sessionId, null);
        return null;
      }
      return entry.attempt;
    },
    set(sessionId, attempt, now = Date.now()) {
      if (attempt === null) {
        memory.delete(sessionId);
        try {
          backing?.removeItem(keyOf(sessionId));
        } catch {
          // nothing to clean up
        }
        return;
      }
      const entry = { attempt, at: now };
      memory.set(sessionId, entry);
      try {
        backing?.setItem(keyOf(sessionId), JSON.stringify(entry));
      } catch {
        // memory copy is enough for this page
      }
    },
  };
}

let browserStore: AttemptStore | null = null;

/** The store the dialog uses: sessionStorage where there is one. */
export function attemptStore(): AttemptStore {
  if (!browserStore) {
    let backing: Backing | null = null;
    try {
      backing = typeof sessionStorage === "undefined" ? null : sessionStorage;
    } catch {
      backing = null;
    }
    browserStore = createAttemptStore(backing);
  }
  return browserStore;
}
