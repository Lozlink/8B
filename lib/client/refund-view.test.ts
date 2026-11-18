import { describe, expect, it } from "vitest";
import type { SummaryDTO } from "@/lib/domain/types";
import {
  checkRefundAmount,
  attentionTitle,
  hasPendingRefund,
  isFiveCentStep,
  noRefundNote,
  outcomeUnknown,
  processingRefundCents,
  refundOutcome,
  refundStateLabel,
  saysNothingRefunded,
  settlesRefund,
  takingsAfterRefunds,
  whereTheMoneyGoes,
} from "./refund-view";

describe("what staff type (parsed by money.ts parseCents)", () => {
  const cents = (text: string) => {
    const r = checkRefundAmount({ mode: "part", text, maxCents: 999_999_900, method: "card" });
    return r.ok ? r.cents : null;
  };
  it("reads whole dollars and cents", () => {
    expect(cents("12")).toBe(1200);
    expect(cents("12.5")).toBe(1250);
    expect(cents("12.50")).toBe(1250);
    expect(cents("0.05")).toBe(5);
    expect(cents("0.5")).toBe(50);
  });
  it("accepts a trailing dot, a leading dot, a dollar sign and stray spaces", () => {
    expect(cents("5.")).toBe(500);
    expect(cents(".5")).toBe(50);
    expect(cents("$7.25")).toBe(725);
    expect(cents("  7.25  ")).toBe(725);
  });
  it("is exact where floats are not", () => {
    // 0.29 * 100 and 1.15 * 100 are off in floating point.
    expect(cents("0.29")).toBe(29);
    expect(cents("1.15")).toBe(115);
    expect(cents("4.35")).toBe(435);
  });
  it("never rounds, and rejects anything that is not a plain amount", () => {
    for (const bad of ["1.005", "19.999", "-5", "+5", "1,200", "12,50", "abc", "1e3", "5 0", "1..5", "12.5.0", "NaN", "Infinity", "99999999"]) {
      expect(cents(bad), bad).toBeNull();
    }
  });
});

describe("isFiveCentStep", () => {
  it("is true for multiples of 5", () => {
    expect(isFiveCentStep(0)).toBe(true);
    expect(isFiveCentStep(5)).toBe(true);
    expect(isFiveCentStep(1235)).toBe(true);
  });
  it("is false otherwise", () => {
    expect(isFiveCentStep(1)).toBe(false);
    expect(isFiveCentStep(1232)).toBe(false);
  });
});

describe("checkRefundAmount", () => {
  const part = (text: string, maxCents = 5000, method: "card" | "cash" = "card") =>
    checkRefundAmount({ mode: "part", text, maxCents, method });

  it("whole amount is the max", () => {
    expect(checkRefundAmount({ mode: "whole", text: "ignored", maxCents: 3850, method: "card" })).toEqual({ ok: true, cents: 3850 });
    expect(checkRefundAmount({ mode: "whole", text: "", maxCents: 3850, method: "cash" })).toEqual({ ok: true, cents: 3850 });
  });
  it("part: a good amount passes, in dollars and cents", () => {
    expect(part("12.50")).toEqual({ ok: true, cents: 1250 });
    expect(part("50")).toEqual({ ok: true, cents: 5000 });
    expect(part("0.01")).toEqual({ ok: true, cents: 1 });
  });
  it("part: an empty field is not ok but says nothing", () => {
    expect(part("")).toEqual({ ok: false, message: null });
    expect(part("   ")).toEqual({ ok: false, message: null });
  });
  it("part: rubbish gets a plain prompt", () => {
    expect(part("abc")).toEqual({ ok: false, message: "Enter dollars and cents, like 12.50." });
    expect(part("1.234")).toEqual({ ok: false, message: "Enter dollars and cents, like 12.50." });
  });
  it("part: zero is refused", () => {
    expect(part("0")).toEqual({ ok: false, message: "Enter more than $0." });
    expect(part("0.00")).toEqual({ ok: false, message: "Enter more than $0." });
  });
  it("part: more than is left is refused and says how much is left", () => {
    expect(part("50.01")).toEqual({ ok: false, message: "The most you can refund is $50.00." });
    expect(part("500")).toEqual({ ok: false, message: "The most you can refund is $50.00." });
  });
  it("a card refund can be any number of cents", () => {
    expect(part("12.52", 5000, "card")).toEqual({ ok: true, cents: 1252 });
  });
  it("cash must be a multiple of 5c and suggests the neighbours", () => {
    expect(part("12.50", 5000, "cash")).toEqual({ ok: true, cents: 1250 });
    expect(part("12.52", 5000, "cash")).toEqual({
      ok: false,
      message: "Cash is handed back in 5c steps. Try $12.50 or $12.55.",
    });
    expect(part("12.51", 5000, "cash")).toEqual({
      ok: false,
      message: "Cash is handed back in 5c steps. Try $12.50 or $12.55.",
    });
  });
  it("cash suggestions stay inside what is left", () => {
    // 4.99 → 4.95 or 5.00, but only $4.97 is left, so only the lower one.
    expect(part("4.96", 497, "cash")).toEqual({ ok: false, message: "Cash is handed back in 5c steps. Try $4.95." });
  });
  it("cash under 5c suggests only the next step up", () => {
    expect(part("0.03", 5000, "cash")).toEqual({ ok: false, message: "Cash is handed back in 5c steps. Try $0.05." });
  });
  it("the max check comes before the 5c check", () => {
    expect(part("50.03", 5000, "cash")).toEqual({ ok: false, message: "The most you can refund is $50.00." });
  });
  it("whole amount of cash that is not a 5c step points at Part", () => {
    expect(checkRefundAmount({ mode: "whole", text: "", maxCents: 1237, method: "cash" })).toEqual({
      ok: false,
      message: "Cash is handed back in 5c steps, so the whole amount won't work. Choose Part and enter $12.35.",
    });
  });
  it("nothing left is refused", () => {
    expect(checkRefundAmount({ mode: "whole", text: "", maxCents: 0, method: "card" })).toEqual({
      ok: false,
      message: "There is nothing left to refund.",
    });
  });
});

describe("refundOutcome", () => {
  it("completed card", () => {
    expect(refundOutcome({ state: "completed", method: "card", amountCents: 1250, error: null })).toEqual({
      kind: "success",
      message: "Refunded $12.50",
    });
  });
  it("completed cash reminds staff to hand the cash back", () => {
    expect(refundOutcome({ state: "completed", method: "cash", amountCents: 1250, error: null })).toEqual({
      kind: "success",
      message: "Refunded $12.50. Hand the cash back.",
    });
  });
  it("pending", () => {
    expect(refundOutcome({ state: "pending", method: "card", amountCents: 1250, error: null }).message).toBe(
      "Refund sent. Square is still processing it.",
    );
    expect(refundOutcome({ state: "pending", method: "cash", amountCents: 1250, error: null }).message).toBe(
      "Refund sent. Square is still processing it. Hand the cash back.",
    );
  });
  it("failed says nothing was refunded and gives the reason", () => {
    expect(refundOutcome({ state: "failed", method: "card", amountCents: 1250, error: "The card was closed." })).toEqual({
      kind: "error",
      message: "Nothing was refunded. The card was closed.",
    });
    expect(refundOutcome({ state: "failed", method: "card", amountCents: 1250, error: null }).message).toBe(
      "Nothing was refunded. Square didn't accept it.",
    );
  });
});

describe("outcomeUnknown", () => {
  it("is unknown for a timeout, a dropped connection and server errors", () => {
    expect(outcomeUnknown(0)).toBe(true);
    expect(outcomeUnknown(500)).toBe(true);
    expect(outcomeUnknown(502)).toBe(true);
    expect(outcomeUnknown(503)).toBe(true);
  });
  it("is a clear no for refusals", () => {
    for (const s of [400, 401, 403, 404, 409, 422, 429]) expect(outcomeUnknown(s), String(s)).toBe(false);
  });
});

describe("wording", () => {
  it("says where the money goes", () => {
    expect(whereTheMoneyGoes("card")).toBe("Goes back to the customer's card. It can take a few days to show.");
    expect(whereTheMoneyGoes("cash")).toBe("Hand the cash back. The app records the refund in Square.");
  });
  it("labels states", () => {
    expect(refundStateLabel("pending")).toBe("Processing");
    expect(refundStateLabel("completed")).toBe("Refunded");
    expect(refundStateLabel("failed")).toBe("Failed");
  });
});

describe("day totals", () => {
  const paid: SummaryDTO["paid"] = {
    card: { count: 4, cents: 25_000 },
    cash: { count: 3, cents: 9_000, roundingCents: -5 },
  };
  it("takings are card + cash − refunds", () => {
    expect(takingsAfterRefunds(paid, { cents: 0 })).toBe(34_000);
    expect(takingsAfterRefunds(paid, { cents: 1_250 })).toBe(32_750);
  });
  it("can go below zero when old bills are refunded on a quiet day", () => {
    expect(takingsAfterRefunds({ card: { count: 0, cents: 0 }, cash: { count: 0, cents: 0, roundingCents: 0 } }, { cents: 800 })).toBe(-800);
  });
  it("adds up only what is still processing", () => {
    expect(
      processingRefundCents([
        { state: "pending", amountCents: 500 },
        { state: "completed", amountCents: 1_000 },
        { state: "pending", amountCents: 250 },
        { state: "failed", amountCents: 9_999 },
      ]),
    ).toBe(750);
    expect(processingRefundCents([])).toBe(0);
  });
});

describe("noRefundNote", () => {
  const base = {
    status: "paid" as const,
    refundable: null,
    refundedCents: 0,
    settledMethod: "card" as const,
    settledVia: "staff" as const,
    squareCash: null,
  };
  it("card taken on another reader points at Square", () => {
    expect(noRefundNote(base)).toBe("Taken on another reader. Refund it in Square.");
  });
  it("a Terminal card payment we can't find says so", () => {
    expect(noRefundNote({ ...base, settledVia: "square_webhook" })).toBe(
      "This payment can't be refunded from here. Refund it in Square.",
    );
  });
  it("cash that is not in Square yet can be refunded once it is", () => {
    const cash = { ...base, settledMethod: "cash" as const, settledVia: "staff" as const };
    const note = "This cash sale isn't in Square yet. It can be refunded once it is.";
    expect(noRefundNote({ ...cash, squareCash: { state: "pending", amountCents: 500, error: null } })).toBe(note);
    expect(noRefundNote({ ...cash, squareCash: { state: "failed", amountCents: 500, error: "x" } })).toBe(note);
    expect(noRefundNote({ ...cash, squareCash: { state: "recorded", amountCents: 500, error: null } })).toBeNull();
  });
  it("says nothing when it can be refunded, was refunded, or isn't paid", () => {
    expect(noRefundNote({ ...base, refundable: { method: "card", maxCents: 100 } })).toBeNull();
    expect(noRefundNote({ ...base, refundedCents: 100 })).toBeNull();
    expect(noRefundNote({ ...base, status: "void" })).toBeNull();
  });
});

describe("server wording", () => {
  it("spots a refusal that already says nothing was refunded", () => {
    expect(saysNothingRefunded("Square didn't accept the refund: card closed. Nothing was refunded.")).toBe(true);
    expect(saysNothingRefunded("That isn't a manager PIN.")).toBe(false);
  });
  it("finds pending refunds", () => {
    expect(hasPendingRefund([{ state: "completed" }, { state: "pending" }])).toBe(true);
    expect(hasPendingRefund([{ state: "completed" }, { state: "failed" }])).toBe(false);
    expect(hasPendingRefund([])).toBe(false);
  });
  it("titles the refund attention entries and leaves the rest alone", () => {
    expect(attentionTitle("refund.failed")).toBe("Refund failed");
    expect(attentionTitle("refund.unconfirmed")).toBe("Refund not confirmed");
    expect(attentionTitle("cash.failed")).toBe("cash.failed");
  });
});

describe("settlesRefund", () => {
  it("is true only for Square's refusal of a recorded refund", () => {
    expect(settlesRefund({ status: 409, code: "refund_failed" })).toBe(true);
    expect(settlesRefund({ status: 409, code: "conflict" })).toBe(false);
    expect(settlesRefund({ status: 403, code: "forbidden" })).toBe(false);
    expect(settlesRefund({ status: 0, code: "network" })).toBe(false);
  });
});
