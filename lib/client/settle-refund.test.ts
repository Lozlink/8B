import { describe, expect, it } from "vitest";
import { SETTLE_CHOICES, canOfferSettle, canSettle, settledMessage } from "./settle-refund";

const ok = { outcome: "refunded", reason: "Saw it in Square", pin: "1234", offline: false } as const;

describe("settledMessage", () => {
  it("says what happened for each answer", () => {
    expect(settledMessage("refunded")).toBe("Refund marked as done.");
    expect(settledMessage("not_refunded")).toBe("Refund cancelled. Nothing was refunded.");
  });
});

describe("canSettle", () => {
  it("is ready with an answer, a reason, a PIN and a connection", () => {
    expect(canSettle(ok)).toBe(true);
    expect(canSettle({ ...ok, outcome: "not_refunded" })).toBe(true);
  });
  it("needs an answer picked", () => {
    expect(canSettle({ ...ok, outcome: null })).toBe(false);
  });
  it("needs a real reason, not blanks", () => {
    expect(canSettle({ ...ok, reason: "   " })).toBe(false);
    expect(canSettle({ ...ok, reason: "ok" })).toBe(false);
    expect(canSettle({ ...ok, reason: "  yes  " })).toBe(true);
  });
  it("needs a PIN of at least four digits", () => {
    expect(canSettle({ ...ok, pin: "123" })).toBe(false);
  });
  it("waits for the connection", () => {
    expect(canSettle({ ...ok, offline: true })).toBe(false);
  });
});

describe("canOfferSettle", () => {
  it("only for rows that need a check, and not on stale data", () => {
    expect(canOfferSettle({ needsCheck: true }, false)).toBe(true);
    expect(canOfferSettle({ needsCheck: false }, false)).toBe(false);
    expect(canOfferSettle({ needsCheck: true }, true)).toBe(false);
  });
});

describe("SETTLE_CHOICES", () => {
  it("has the two answers, each with a one-line effect", () => {
    expect(SETTLE_CHOICES.map((c) => c.outcome)).toEqual(["refunded", "not_refunded"]);
    for (const c of SETTLE_CHOICES) expect(c.effect.split("\n")).toHaveLength(1);
  });
});
