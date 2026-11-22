import { describe, expect, it } from "vitest";
import {
  DENOMINATIONS,
  cashCountsPayload,
  checkClose,
  clampQuantity,
  countRows,
  countedCents,
  describeDifference,
  differenceCents,
  expectedCashCents,
  formatBusinessDate,
  hasTypedInput,
  isBusinessDate,
  parseQuantity,
  rowSubtotalCents,
  stepCount,
  sumCounts,
  type CloseInput,
} from "./day-close";

const base: CloseInput = {
  floatText: "200.00",
  mode: "total",
  counts: {},
  totalText: "412.50",
  note: "",
  tablesRunning: false,
};

describe("denominations", () => {
  it("are all multiples of 5c, biggest first", () => {
    const cents = DENOMINATIONS.map((d) => d.cents);
    expect(cents.every((c) => c % 5 === 0)).toBe(true);
    expect([...cents].sort((a, b) => b - a)).toEqual(cents);
  });
});

describe("sumCounts", () => {
  it("adds face value times quantity", () => {
    expect(sumCounts({})).toBe(0);
    expect(sumCounts({ 10_000: 1, 2_000: 3, 100: 2, 5: 7 })).toBe(10_000 + 6_000 + 200 + 35);
    expect(sumCounts({ 50: 1, 20: 1, 10: 1, 5: 1 })).toBe(85);
  });
  it("ignores values that are not a note or coin", () => {
    expect(sumCounts({ 7: 10, 100: 1 })).toBe(100);
  });
  it("never goes negative or fractional", () => {
    expect(sumCounts({ 100: -3 })).toBe(0);
    expect(sumCounts({ 100: 2.9 })).toBe(200);
  });
});

describe("quantities", () => {
  it("clamps to 0..999 whole numbers", () => {
    expect(clampQuantity(-1)).toBe(0);
    expect(clampQuantity(5.7)).toBe(5);
    expect(clampQuantity(5000)).toBe(999);
    expect(clampQuantity(Number.NaN)).toBe(0);
  });
  it("reads typed digits only", () => {
    expect(parseQuantity("")).toBe(0);
    expect(parseQuantity("12")).toBe(12);
    expect(parseQuantity("1a2")).toBe(12);
    expect(parseQuantity("-4")).toBe(4);
    expect(parseQuantity("99999")).toBe(999);
  });
  it("steps up and down but not below zero", () => {
    expect(stepCount({}, 100, 1)).toEqual({ 100: 1 });
    expect(stepCount({ 100: 1 }, 100, -1)).toEqual({ 100: 0 });
    expect(stepCount({}, 100, -1)).toEqual({ 100: 0 });
    expect(stepCount({ 100: 999 }, 100, 1)).toEqual({ 100: 999 });
  });
  it("gives a row's subtotal", () => {
    expect(rowSubtotalCents(2_000, 3)).toBe(6_000);
  });
});

describe("cashCountsPayload", () => {
  it("keys by cents and drops empty rows", () => {
    expect(cashCountsPayload({ 10_000: 2, 50: 0, 5: 4 })).toEqual({ "10000": 2, "5": 4 });
  });
  it("is null when nothing was counted", () => {
    expect(cashCountsPayload({})).toBeNull();
    expect(cashCountsPayload({ 100: 0 })).toBeNull();
  });
  it("adds up to the sum, as the server requires", () => {
    const counts = { 5_000: 2, 1_000: 1, 200: 3, 10: 5 };
    const payload = cashCountsPayload(counts);
    const total = Object.entries(payload ?? {}).reduce((s, [k, q]) => s + Number(k) * q, 0);
    expect(total).toBe(sumCounts(counts));
  });
});

describe("expected cash and difference", () => {
  it("expected is the float plus cash movement", () => {
    expect(expectedCashCents(20_000, 15_550)).toBe(35_550);
    expect(expectedCashCents(20_000, -500)).toBe(19_500);
    expect(expectedCashCents(0, 0)).toBe(0);
  });
  it("difference is counted less expected", () => {
    expect(differenceCents(35_100, 35_550)).toBe(-450);
    expect(differenceCents(35_750, 35_550)).toBe(200);
    expect(differenceCents(100, 100)).toBe(0);
  });
  it("puts the difference in words", () => {
    expect(describeDifference(0)).toBe("Balanced");
    expect(describeDifference(-450)).toBe("$4.50 short");
    expect(describeDifference(200)).toBe("$2.00 over");
    expect(describeDifference(5)).toBe("$0.05 over");
    expect(describeDifference(-123_456)).toBe("$1,234.56 short");
  });
});

describe("countedCents", () => {
  it("sums the rows in notes mode", () => {
    expect(countedCents({ mode: "notes", counts: { 2_000: 2 }, totalText: "999" })).toBe(4_000);
  });
  it("reads the typed total in total mode", () => {
    expect(countedCents({ mode: "total", counts: {}, totalText: "12.55" })).toBe(1_255);
    expect(countedCents({ mode: "total", counts: {}, totalText: "" })).toBeNull();
    expect(countedCents({ mode: "total", counts: {}, totalText: "12.52" })).toBeNull();
  });
});

describe("checkClose", () => {
  it("accepts a typed total", () => {
    expect(checkClose(base)).toEqual({
      ok: true,
      floatCents: 20_000,
      countedCashCents: 41_250,
      cashCounts: null,
      note: null,
    });
  });
  it("accepts a count by note and coin and sends it", () => {
    const r = checkClose({ ...base, mode: "notes", counts: { 10_000: 4, 1_000: 1, 5: 2 }, totalText: "" });
    expect(r).toEqual({
      ok: true,
      floatCents: 20_000,
      countedCashCents: 41_010,
      cashCounts: { "10000": 4, "1000": 1, "5": 2 },
      note: null,
    });
  });
  it("ignores a stale typed total when counting by note and coin, and the reverse", () => {
    const notes = checkClose({ ...base, mode: "notes", counts: { 100: 1 }, totalText: "999" });
    expect(notes.ok && notes.countedCashCents).toBe(100);
    const total = checkClose({ ...base, mode: "total", counts: { 100: 1 }, totalText: "5" });
    expect(total.ok && total.cashCounts).toBeNull();
  });
  it("refuses while tables are running", () => {
    expect(checkClose({ ...base, tablesRunning: true })).toEqual({ ok: false, reason: "Stop the running tables first." });
  });
  it("allows a float of $0 but not a blank one", () => {
    const zero = checkClose({ ...base, floatText: "0" });
    expect(zero.ok && zero.floatCents).toBe(0);
    expect(checkClose({ ...base, floatText: " " }).ok).toBe(false);
  });
  it("refuses a float or total that is not a multiple of 5c", () => {
    expect(checkClose({ ...base, floatText: "200.02" }).ok).toBe(false);
    expect(checkClose({ ...base, totalText: "412.51" }).ok).toBe(false);
    expect(checkClose({ ...base, totalText: "412.55" }).ok).toBe(true);
  });
  it("refuses text that is not money", () => {
    expect(checkClose({ ...base, floatText: "2,00" }).ok).toBe(false);
    expect(checkClose({ ...base, totalText: "-5" }).ok).toBe(false);
    expect(checkClose({ ...base, totalText: "abc" }).ok).toBe(false);
  });
  it("refuses an empty count in either mode, but accepts a typed $0", () => {
    expect(checkClose({ ...base, mode: "notes", counts: {} }).ok).toBe(false);
    expect(checkClose({ ...base, totalText: "" }).ok).toBe(false);
    expect(checkClose({ ...base, floatText: "0", totalText: "0" }).ok).toBe(true);
  });
  it("trims the note and holds it to 500 characters", () => {
    const r = checkClose({ ...base, note: "  note for the owner  " });
    expect(r.ok && r.note).toBe("note for the owner");
    expect(checkClose({ ...base, note: "x".repeat(500) }).ok).toBe(true);
    expect(checkClose({ ...base, note: "x".repeat(501) }).ok).toBe(false);
  });
});

describe("countRows", () => {
  it("lists a saved count biggest first with subtotals", () => {
    expect(countRows({ "5": 4, "10000": 2, "200": 1 })).toEqual([
      { cents: 10_000, label: "$100", quantity: 2, subtotalCents: 20_000 },
      { cents: 200, label: "$2", quantity: 1, subtotalCents: 200 },
      { cents: 5, label: "5c", quantity: 4, subtotalCents: 20 },
    ]);
  });
  it("copes with nothing and with junk", () => {
    expect(countRows(null)).toEqual([]);
    expect(countRows({ x: 1, "100": 0, "-5": 2 })).toEqual([]);
  });
  it("keeps a value it does not know", () => {
    expect(countRows({ "2500": 1 })).toEqual([{ cents: 2_500, label: "$25.00", quantity: 1, subtotalCents: 2_500 }]);
  });
});

describe("dates", () => {
  it("recognises real business dates only", () => {
    expect(isBusinessDate("2026-11-23")).toBe(true);
    expect(isBusinessDate("2026-02-30")).toBe(false);
    expect(isBusinessDate("23/11/2026")).toBe(false);
    expect(isBusinessDate(null)).toBe(false);
    expect(isBusinessDate("")).toBe(false);
  });
  it("writes one out without any time zone shift", () => {
    expect(formatBusinessDate("2026-11-21")).toBe("Sat 21 Nov 2026");
    expect(formatBusinessDate("2026-01-01")).toBe("Thu 1 Jan 2026");
    expect(formatBusinessDate("nonsense")).toBe("nonsense");
  });
});

describe("hasTypedInput", () => {
  const none = { floatTyped: null, counts: {}, totalText: "", note: "" };
  it("is false for an untouched form", () => {
    expect(hasTypedInput(none)).toBe(false);
    expect(hasTypedInput({ ...none, counts: { 100: 0 }, totalText: "  ", note: " " })).toBe(false);
  });
  it("is true once anything is typed", () => {
    expect(hasTypedInput({ ...none, floatTyped: "150" })).toBe(true);
    expect(hasTypedInput({ ...none, floatTyped: "" })).toBe(true);
    expect(hasTypedInput({ ...none, counts: { 100: 1 } })).toBe(true);
    expect(hasTypedInput({ ...none, totalText: "5" })).toBe(true);
    expect(hasTypedInput({ ...none, note: "x" })).toBe(true);
  });
});
