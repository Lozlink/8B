import { describe, expect, it } from "vitest";
import { ATTEMPT_TTL_MS, attemptAfter, attemptFor, createAttemptStore, newRequestId, type RefundAttempt } from "./refund-request";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newRequestId", () => {
  it("uses crypto.randomUUID when there is one", () => {
    const src = { randomUUID: () => "11111111-2222-4333-8444-555555555555" as `${string}-${string}-${string}-${string}-${string}`, getRandomValues: crypto.getRandomValues.bind(crypto) };
    expect(newRequestId(src)).toBe("11111111-2222-4333-8444-555555555555");
  });
  it("builds a v4 UUID from getRandomValues when randomUUID is missing (plain http, old browsers)", () => {
    const src = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    for (let i = 0; i < 50; i++) expect(newRequestId(src)).toMatch(UUID_V4);
  });
  it("still returns a v4-shaped id with no crypto at all", () => {
    expect(newRequestId(undefined as never)).toMatch(UUID_V4);
  });
  it("sets the version and variant bits whatever the random bytes are", () => {
    const allOnes = { getRandomValues: <T extends ArrayBufferView | null>(a: T): T => { (a as unknown as Uint8Array).fill(0xff); return a; } };
    const allZeros = { getRandomValues: <T extends ArrayBufferView | null>(a: T): T => { (a as unknown as Uint8Array).fill(0); return a; } };
    expect(newRequestId(allOnes)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(newRequestId(allZeros)).toBe("00000000-0000-4000-8000-000000000000");
  });
  it("gives different ids", () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe("attemptFor", () => {
  let n = 0;
  const make = () => `id-${++n}`;

  it("makes a new id for a new refund", () => {
    const a = attemptFor(null, "s1", 1250, make);
    expect(a).toEqual({ requestId: expect.stringMatching(/^id-/), sessionId: "s1", amountCents: 1250 });
  });
  it("keeps the id for the same bill and amount (a retry)", () => {
    const first = attemptFor(null, "s1", 1250, make);
    expect(attemptFor(first, "s1", 1250, make)).toBe(first);
  });
  it("makes a new id when the amount changes", () => {
    const first = attemptFor(null, "s1", 1250, make);
    const second = attemptFor(first, "s1", 1255, make);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.amountCents).toBe(1255);
  });
  it("makes a new id for a different bill", () => {
    const first = attemptFor(null, "s1", 1250, make);
    expect(attemptFor(first, "s2", 1250, make).requestId).not.toBe(first.requestId);
  });
  it("does not call the id maker when it keeps the attempt", () => {
    const first: RefundAttempt = { requestId: "kept", sessionId: "s1", amountCents: 500 };
    expect(attemptFor(first, "s1", 500, () => { throw new Error("should not be called"); })).toBe(first);
  });
});

describe("attemptAfter", () => {
  const a: RefundAttempt = { requestId: "x", sessionId: "s1", amountCents: 500 };
  it("keeps the attempt when the answer was lost", () => {
    expect(attemptAfter(a, "unknown")).toBe(a);
  });
  it("keeps it when the call was turned away before anything was done (wrong PIN)", () => {
    expect(attemptAfter(a, "rejected")).toBe(a);
  });
  it("drops it once the refund is settled, made or refused by Square", () => {
    expect(attemptAfter(a, "settled")).toBeNull();
  });
  it("a lost answer then a retry sends the same id; once settled the next refund gets a new one", () => {
    let n = 0;
    const make = () => `id-${++n}`;
    const first = attemptFor(null, "s1", 500, make);
    const afterLost = attemptAfter(first, "unknown");
    expect(attemptFor(afterLost, "s1", 500, make).requestId).toBe(first.requestId);
    const afterWrongPin = attemptAfter(first, "rejected");
    expect(attemptFor(afterWrongPin, "s1", 500, make).requestId).toBe(first.requestId);
    const afterSettled = attemptAfter(first, "settled");
    expect(attemptFor(afterSettled, "s1", 500, make).requestId).not.toBe(first.requestId);
  });
});

describe("attempt store", () => {
  const a: RefundAttempt = { requestId: "x", sessionId: "s1", amountCents: 500 };
  const fakeStorage = () => {
    const m = new Map<string, string>();
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };

  it("remembers a lost attempt per bill and forgets it when settled", () => {
    const store = createAttemptStore(fakeStorage());
    expect(store.get("s1")).toBeNull();
    store.set("s1", a);
    expect(store.get("s1")).toEqual(a);
    expect(store.get("s2")).toBeNull();
    store.set("s1", null);
    expect(store.get("s1")).toBeNull();
  });
  it("survives a new store on the same storage (the page was reloaded)", () => {
    const backing = fakeStorage();
    createAttemptStore(backing).set("s1", a);
    expect(createAttemptStore(backing).get("s1")).toEqual(a);
  });
  it("lets go after the time limit", () => {
    const store = createAttemptStore(fakeStorage());
    store.set("s1", a, 1_000);
    expect(store.get("s1", 1_000 + ATTEMPT_TTL_MS)).toEqual(a);
    expect(store.get("s1", 1_000 + ATTEMPT_TTL_MS + 1)).toBeNull();
    expect(store.get("s1", 1_000)).toBeNull();
  });
  it("works with no storage, or storage that throws", () => {
    const none = createAttemptStore(null);
    none.set("s1", a);
    expect(none.get("s1")).toEqual(a);
    const broken = createAttemptStore({
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    });
    broken.set("s1", a);
    expect(broken.get("s1")).toEqual(a);
    broken.set("s1", null);
    expect(broken.get("s1")).toBeNull();
  });
  it("ignores junk in storage", () => {
    const backing = fakeStorage();
    backing.m.set("refund-attempt:s1", "{not json");
    expect(createAttemptStore(backing).get("s1")).toBeNull();
    backing.m.set("refund-attempt:s1", JSON.stringify({ attempt: { requestId: 5 }, at: 1 }));
    expect(createAttemptStore(backing).get("s1")).toBeNull();
  });
  it("does not hand back an attempt stored under another bill's key", () => {
    const backing = fakeStorage();
    backing.m.set("refund-attempt:s2", JSON.stringify({ attempt: a, at: Date.now() }));
    expect(createAttemptStore(backing).get("s2")).toBeNull();
  });
});
