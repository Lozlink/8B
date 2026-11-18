import { describe, expect, it } from "vitest";
import {
  centsToField,
  checkCustomCharge,
  checkDiscountValue,
  discountNameOrDefault,
  formatBps,
  parseCents,
  parsePercentBps,
} from "./money";

describe("parseCents", () => {
  it("reads dollars and cents into integer cents", () => {
    expect(parseCents("12")).toBe(1200);
    expect(parseCents("12.5")).toBe(1250);
    expect(parseCents("12.50")).toBe(1250);
    expect(parseCents("12.05")).toBe(1205);
    expect(parseCents("0.01")).toBe(1);
    expect(parseCents(".5")).toBe(50);
    expect(parseCents("12.")).toBe(1200);
    expect(parseCents("$12.50")).toBe(1250);
    expect(parseCents("  7.25 ")).toBe(725);
    expect(parseCents("2000")).toBe(200000);
  });

  it("has no float error on awkward amounts", () => {
    // 19.99 * 100 is 1998.9999999999998 in floating point.
    expect(parseCents("19.99")).toBe(1999);
    expect(parseCents("1.15")).toBe(115);
    expect(parseCents("0.29")).toBe(29);
    expect(parseCents("4.35")).toBe(435);
  });

  it("refuses anything that is not plain dollars and cents", () => {
    for (const bad of ["", " ", ".", "$", "abc", "1.234", "-5", "1,50", "1,000", "1.2.3", "12 50", "1e3", "99999999"]) {
      expect(parseCents(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("parsePercentBps", () => {
  it("reads whole and half percents as basis points", () => {
    expect(parsePercentBps("10")).toBe(1000);
    expect(parsePercentBps("10%")).toBe(1000);
    expect(parsePercentBps("12.5")).toBe(1250);
    expect(parsePercentBps("12.50")).toBe(1250);
    expect(parsePercentBps("0.5")).toBe(50);
    expect(parsePercentBps("100")).toBe(10000);
    expect(parsePercentBps("7.0")).toBe(700);
  });

  it("refuses zero, more than 100, and anything finer than a half", () => {
    for (const bad of ["", "0", "0.0", "100.5", "101", "1000", "12.25", "12.3", "7.75", "-5", "ten", "5,5", "5%%"]) {
      expect(parsePercentBps(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("formatBps", () => {
  it("shows whole percents plainly and keeps the half", () => {
    expect(formatBps(1000)).toBe("10%");
    expect(formatBps(1250)).toBe("12.5%");
    expect(formatBps(50)).toBe("0.5%");
    expect(formatBps(10000)).toBe("100%");
    expect(formatBps(825)).toBe("8.25%");
  });
});

describe("centsToField", () => {
  it("fills a field from cents", () => {
    expect(centsToField(1250)).toBe("12.50");
    expect(centsToField(5)).toBe("0.05");
    expect(centsToField(0)).toBe("0.00");
    expect(parseCents(centsToField(1999))).toBe(1999);
  });
});

describe("checkCustomCharge", () => {
  it("accepts a name and a price in range", () => {
    expect(checkCustomCharge("  Cue hire ", "5")).toEqual({ ok: true, name: "Cue hire", amountCents: 500 });
    expect(checkCustomCharge("Fee", "0.01")).toEqual({ ok: true, name: "Fee", amountCents: 1 });
    expect(checkCustomCharge("Deposit", "2000.00")).toEqual({ ok: true, name: "Deposit", amountCents: 200000 });
  });

  it("refuses an empty name or one over 60 characters", () => {
    expect(checkCustomCharge("   ", "5").ok).toBe(false);
    expect(checkCustomCharge("x".repeat(60), "5").ok).toBe(true);
    const long = checkCustomCharge("x".repeat(61), "5");
    expect(long.ok).toBe(false);
  });

  it("refuses a price that is missing, nothing, or over $2,000", () => {
    expect(checkCustomCharge("Fee", "").ok).toBe(false);
    expect(checkCustomCharge("Fee", "0").ok).toBe(false);
    expect(checkCustomCharge("Fee", "0.00").ok).toBe(false);
    expect(checkCustomCharge("Fee", "abc").ok).toBe(false);
    const over = checkCustomCharge("Fee", "2000.01");
    expect(over).toEqual({ ok: false, error: "The most is $2,000.00." });
  });
});

describe("checkDiscountValue", () => {
  it("percent: whole or half, up to 100, with what it takes off", () => {
    expect(checkDiscountValue("percent", "10", 5000)).toEqual({ ok: true, value: 1000, takesCents: 500 });
    expect(checkDiscountValue("percent", "12.5", 1000)).toEqual({ ok: true, value: 1250, takesCents: 125 });
    expect(checkDiscountValue("percent", "100", 4321)).toEqual({ ok: true, value: 10000, takesCents: 4321 });
    expect(checkDiscountValue("percent", "10", null)).toEqual({ ok: true, value: 1000, takesCents: null });
  });

  it("percent: says nothing while empty, and complains about a bad value", () => {
    expect(checkDiscountValue("percent", "", 5000)).toEqual({ ok: false, error: null });
    const bad = checkDiscountValue("percent", "12.3", 5000);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toBeNull();
    expect(checkDiscountValue("percent", "101", 5000).ok).toBe(false);
  });

  it("amount: never more than the bill", () => {
    expect(checkDiscountValue("amount", "5", 5000)).toEqual({ ok: true, value: 500, takesCents: 500 });
    expect(checkDiscountValue("amount", "50.00", 5000)).toEqual({ ok: true, value: 5000, takesCents: 5000 });
    const over = checkDiscountValue("amount", "50.01", 5000);
    expect(over).toEqual({ ok: false, error: "That's more than the bill ($50.00)." });
    expect(checkDiscountValue("amount", "0", 5000).ok).toBe(false);
    expect(checkDiscountValue("amount", "", 5000)).toEqual({ ok: false, error: null });
  });

  it("amount: with the bill's size unknown, the server decides", () => {
    expect(checkDiscountValue("amount", "500", null)).toEqual({ ok: true, value: 50000, takesCents: null });
  });
});

describe("discountNameOrDefault", () => {
  it("falls back to Discount and caps at 60 characters", () => {
    expect(discountNameOrDefault("")).toBe("Discount");
    expect(discountNameOrDefault("   ")).toBe("Discount");
    expect(discountNameOrDefault(" Mates rate ")).toBe("Mates rate");
    expect(discountNameOrDefault("x".repeat(80))).toHaveLength(60);
  });
});
