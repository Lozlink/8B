import { describe, expect, it } from "vitest";
import { billTotals, cashDueCents, discountCentsFor, itemCents, itemsCents } from "./bill";

describe("bill arithmetic", () => {
  it("an item line is unit price times quantity", () => {
    expect(itemCents({ unitCents: 450, quantity: 3 })).toBe(1350);
    expect(itemsCents([])).toBe(0);
    expect(
      itemsCents([
        { unitCents: 450, quantity: 3, taxed: true },
        { unitCents: 300, quantity: 1, taxed: false },
      ]),
    ).toBe(1650);
  });

  it("the total is table time plus items", () => {
    const t = billTotals(2500, [
      { unitCents: 450, quantity: 2, taxed: true },
      { unitCents: 300, quantity: 1, taxed: false },
    ]);
    expect(t).toMatchObject({ tableCents: 2500, itemsCents: 1200, totalCents: 3700 });
  });

  it("GST is one eleventh of the taxed part only", () => {
    // Table 2500 + taxed 900 = 3400 → 309.09 → 309. The GST-free 300 adds nothing.
    expect(billTotals(2500, [{ unitCents: 450, quantity: 2, taxed: true }, { unitCents: 300, quantity: 1, taxed: false }]).gstCents).toBe(309);
    expect(billTotals(0, [{ unitCents: 300, quantity: 2, taxed: false }])).toEqual({
      tableCents: 0,
      itemsCents: 600,
      discountCents: 0,
      splitOffCents: 0,
      totalCents: 600,
      gstCents: 0,
    });
    expect(billTotals(2500, []).gstCents).toBe(227);
  });

  it("a bill with nothing on it is zero", () => {
    expect(billTotals(0, [])).toEqual({ tableCents: 0, itemsCents: 0, discountCents: 0, splitOffCents: 0, totalCents: 0, gstCents: 0 });
    // … and stays zero whatever is asked to come off it
    expect(billTotals(0, [], { discountCents: 500, splitOffCents: 300 })).toEqual({
      tableCents: 0,
      itemsCents: 0,
      discountCents: 0,
      splitOffCents: 0,
      totalCents: 0,
      gstCents: 0,
    });
  });

  it("cash is collected to the nearest 5c: 1 and 2 go down, 3 and 4 go up", () => {
    expect([1455, 1456, 1457, 1458, 1459, 1460].map(cashDueCents)).toEqual([1455, 1455, 1455, 1460, 1460, 1460]);
    // Square's sandbox: $14.58 is paid with $14.60, $14.57 with $14.55.
    expect(cashDueCents(1458)).toBe(1460);
    expect(cashDueCents(1457)).toBe(1455);
    expect(cashDueCents(3542)).toBe(3540);
    expect(cashDueCents(0)).toBe(0);
    // A bill of 1c or 2c rounds to nothing to collect.
    expect([1, 2, 3, 4].map(cashDueCents)).toEqual([0, 0, 5, 5]);
  });

  it("the cash amount is always a multiple of 5c and never more than 2c from the bill", () => {
    for (let cents = 0; cents <= 2000; cents++) {
      const due = cashDueCents(cents);
      expect(due % 5).toBe(0);
      expect(Math.abs(due - cents)).toBeLessThanOrEqual(2);
    }
  });
});

/** A small repeatable random source, so a failure can be run again exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("discountCentsFor", () => {
  it("a percentage is basis points of the bill", () => {
    expect(discountCentsFor(2500, "percent", 1000)).toBe(250); // 10% of $25.00
    expect(discountCentsFor(3700, "percent", 2000)).toBe(740); // 20% of $37.00
    expect(discountCentsFor(2500, "percent", 1250)).toBe(313); // 12.5% of $25.00 = 312.5 → 313
    expect(discountCentsFor(2083, "percent", 1500)).toBe(312); // 312.45 → 312
    expect(discountCentsFor(1, "percent", 1)).toBe(0); // 0.01% of 1c
  });

  it("rounds an exact half cent up, and anything under it down", () => {
    // 50% of an odd number of cents is always exactly half a cent over.
    expect(discountCentsFor(1, "percent", 5000)).toBe(1);
    expect(discountCentsFor(3, "percent", 5000)).toBe(2);
    expect(discountCentsFor(1005, "percent", 5000)).toBe(503);
    expect(discountCentsFor(2501, "percent", 5000)).toBe(1251);
    // 10% of $x.x5 lands on a half cent
    expect(discountCentsFor(335, "percent", 1000)).toBe(34); // 33.5
    expect(discountCentsFor(345, "percent", 1000)).toBe(35); // 34.5: half up, not half to even
    expect(discountCentsFor(5, "percent", 1000)).toBe(1); // 0.5
    // 12.5% of 4c = 0.5c; of 12c = 1.5c
    expect(discountCentsFor(4, "percent", 1250)).toBe(1);
    expect(discountCentsFor(12, "percent", 1250)).toBe(2);
    // just either side of the half
    expect(discountCentsFor(334, "percent", 1000)).toBe(33); // 33.4
    expect(discountCentsFor(336, "percent", 1000)).toBe(34); // 33.6
    expect(discountCentsFor(4999, "percent", 1)).toBe(0); // 0.4999
    expect(discountCentsFor(5000, "percent", 1)).toBe(1); // 0.5 exactly
    expect(discountCentsFor(5001, "percent", 1)).toBe(1); // 0.5001
  });

  it("agrees with exact integer arithmetic for every half-up case over a wide range", () => {
    const next = rng(20261119);
    for (let i = 0; i < 20_000; i++) {
      const base = Math.floor(next() * 10_000_000);
      const bp = 1 + Math.floor(next() * 10_000);
      const exact = Number((BigInt(base) * BigInt(bp) * 2n + 10_000n) / 20_000n); // round half up, no floats
      expect(discountCentsFor(base, "percent", bp), `${base} at ${bp}bp`).toBe(exact);
    }
    // and exhaustively at the percentages staff will actually use, cent by cent
    for (const bp of [500, 1000, 1250, 1500, 2000, 2500, 3333, 5000, 7500, 10_000]) {
      for (let base = 0; base <= 3000; base++) {
        const exact = Number((BigInt(base) * BigInt(bp) * 2n + 10_000n) / 20_000n);
        expect(discountCentsFor(base, "percent", bp), `${base} at ${bp}bp`).toBe(exact);
      }
    }
  });

  it("100% takes the whole bill and nothing takes more than the bill", () => {
    expect(discountCentsFor(3700, "percent", 10_000)).toBe(3700);
    expect(discountCentsFor(1, "percent", 10_000)).toBe(1);
    expect(discountCentsFor(3700, "percent", 25_000)).toBe(3700); // a value past 100% is capped, never negative
    expect(discountCentsFor(3700, "amount", 3700)).toBe(3700);
    expect(discountCentsFor(3700, "amount", 5000)).toBe(3700);
    expect(discountCentsFor(3700, "amount", 1)).toBe(1);
  });

  it("an amount is that many cents, capped at the bill", () => {
    expect(discountCentsFor(2500, "amount", 500)).toBe(500);
    expect(discountCentsFor(400, "amount", 500)).toBe(400);
  });

  it("nothing comes off an empty bill, and a zero or negative value takes nothing", () => {
    for (const kind of ["percent", "amount"] as const) {
      expect(discountCentsFor(0, kind, 1000)).toBe(0);
      expect(discountCentsFor(-50, kind, 1000)).toBe(0);
      expect(discountCentsFor(2500, kind, 0)).toBe(0);
      expect(discountCentsFor(2500, kind, -100)).toBe(0);
    }
  });

  it("is always a whole number of cents between 0 and the bill", () => {
    const next = rng(7);
    for (let i = 0; i < 5000; i++) {
      const base = Math.floor(next() * 500_000);
      const kind = next() < 0.5 ? "percent" : "amount";
      const value = Math.floor(next() * (kind === "percent" ? 12_000 : 600_000));
      const d = discountCentsFor(base, kind, value);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(base);
    }
  });
});

describe("billTotals with a discount and a split", () => {
  const coke = { unitCents: 450, quantity: 2, taxed: true }; // 900
  const water = { unitCents: 300, quantity: 1, taxed: false }; // 300, GST-free

  it("total = table time + items − discount − split off", () => {
    expect(billTotals(2500, [coke, water], { discountCents: 370, splitOffCents: 1000 })).toMatchObject({
      tableCents: 2500,
      itemsCents: 1200,
      discountCents: 370,
      splitOffCents: 1000,
      totalCents: 2330,
    });
    expect(billTotals(2500, [], { discountCents: 250 }).totalCents).toBe(2250);
    expect(billTotals(2500, [], { splitOffCents: 833 }).totalCents).toBe(1667);
    expect(billTotals(2500, [coke]).totalCents).toBe(3400); // no adjustments: as before
  });

  it("a discount can't be more than the bill, and a split can't be more than what the discount left", () => {
    expect(billTotals(2500, [], { discountCents: 9999 })).toMatchObject({ discountCents: 2500, totalCents: 0, gstCents: 0 });
    expect(billTotals(2500, [], { splitOffCents: 9999 })).toMatchObject({ splitOffCents: 2500, totalCents: 0 });
    expect(billTotals(2500, [], { discountCents: 2000, splitOffCents: 2000 })).toMatchObject({
      discountCents: 2000,
      splitOffCents: 500,
      totalCents: 0,
    });
    // exactly used up is fine and is zero, not negative
    expect(billTotals(2500, [coke], { discountCents: 400, splitOffCents: 3000 }).totalCents).toBe(0);
  });

  it("when everything is taxed, GST is one eleventh of what is left to pay", () => {
    // 3400 less 10% (340) = 3060 → 278.18 → 278
    expect(billTotals(2500, [coke], { discountCents: 340 }).gstCents).toBe(278);
    // 3400, half split off = 1700 → 154.54 → 155
    expect(billTotals(2500, [coke], { splitOffCents: 1700 }).gstCents).toBe(155);
    // both: 3400 − 340 − 1530 = 1530 → 139.09 → 139
    expect(billTotals(2500, [coke], { discountCents: 340, splitOffCents: 1530 }).gstCents).toBe(139);
    // an exact half: 5.5c of GST on 60.5c can't happen, but 0.5 can: total 5 → 5/11 = 0.45 → 0; total 6 → 0.545 → 1
    expect(billTotals(5, []).gstCents).toBe(0);
    expect(billTotals(6, []).gstCents).toBe(1);
    // 11 × n + 5.5 is never a whole number of cents, so check the nearest: 16 → 1.45 → 1, 17 → 1.545 → 2
    expect(billTotals(16, []).gstCents).toBe(1);
    expect(billTotals(17, []).gstCents).toBe(2);
  });

  it("with GST-free items, the discount and the split come off taxed and GST-free lines in proportion", () => {
    // Base 3700, of which 3400 is taxed. 10% off = 370 → 3330 to pay. Taxed share = 3330 × 3400/3700 = 3060 → GST 278.
    const t = billTotals(2500, [coke, water], { discountCents: 370 });
    expect(t.totalCents).toBe(3330);
    expect(t.gstCents).toBe(278);
    // The same bill with nothing off it: 3400 taxed → 309 (unchanged from before discounts existed).
    expect(billTotals(2500, [coke, water]).gstCents).toBe(309);
    // Half split off: 1850 to pay, taxed share 1700 → 154.54 → 155.
    expect(billTotals(2500, [coke, water], { splitOffCents: 1850 }).gstCents).toBe(155);
    // Taxed share landing on an exact half cent rounds up: base 4 (2 taxed), 1 off → 3 × 2/4 = 1.5 → 2 → GST 0.18 → 0.
    expect(billTotals(2, [{ unitCents: 2, quantity: 1, taxed: false }], { discountCents: 1 })).toMatchObject({ totalCents: 3, gstCents: 0 });
    // … and one where the half matters: base 220 (110 taxed), 1 off → 219 × 110/220 = 109.5 → 110 → GST 10.
    expect(billTotals(110, [{ unitCents: 110, quantity: 1, taxed: false }], { discountCents: 1 })).toMatchObject({ totalCents: 219, gstCents: 10 });
    // … and further down: 12 off → 208 × 110/220 = 104 → 9.45 → GST 9.
    expect(billTotals(110, [{ unitCents: 110, quantity: 1, taxed: false }], { discountCents: 12 }).gstCents).toBe(9);
  });

  it("a bill of GST-free items only has no GST however it is discounted or split", () => {
    expect(billTotals(0, [water, water], { discountCents: 100, splitOffCents: 200 })).toMatchObject({ totalCents: 300, gstCents: 0 });
  });

  it("a fully discounted bill owes nothing and carries no GST", () => {
    expect(billTotals(2500, [coke, water], { discountCents: 3700 })).toMatchObject({ totalCents: 0, gstCents: 0 });
  });

  it("the identity holds, and GST never exceeds a full eleventh of the total, for any bill", () => {
    const next = rng(42);
    for (let i = 0; i < 5000; i++) {
      const table = Math.floor(next() * 20_000);
      const items = Array.from({ length: Math.floor(next() * 5) }, () => ({
        unitCents: Math.floor(next() * 2000),
        quantity: 1 + Math.floor(next() * 4),
        taxed: next() < 0.7,
      }));
      const base = table + itemsCents(items);
      const discountIn = Math.floor(next() * (base + 500));
      const splitIn = Math.floor(next() * (base + 500));
      const t = billTotals(table, items, { discountCents: discountIn, splitOffCents: splitIn });

      expect(t.totalCents).toBe(t.tableCents + t.itemsCents - t.discountCents - t.splitOffCents);
      expect(t.totalCents).toBeGreaterThanOrEqual(0);
      expect(t.discountCents).toBe(Math.min(discountIn, base));
      expect(t.splitOffCents).toBe(Math.min(splitIn, base - t.discountCents));
      expect(Number.isInteger(t.gstCents)).toBe(true);
      expect(t.gstCents).toBeGreaterThanOrEqual(0);
      // one eleventh of the whole total, rounded half up, is the most GST there can be
      expect(t.gstCents).toBeLessThanOrEqual(Math.floor((t.totalCents * 2 + 11) / 22));
      if (items.every((x) => x.taxed)) expect(t.gstCents).toBe(Math.floor((t.totalCents * 2 + 11) / 22));
      if (table === 0 && items.every((x) => !x.taxed)) expect(t.gstCents).toBe(0);
    }
  });

  it("the server's rule and the screen's estimate are the same sum: discountCentsFor on the base, then billTotals", () => {
    // 12.5% on $37.00 → 462.5 → 463 off
    const base = 2500 + itemsCents([coke, water]);
    const d = discountCentsFor(base, "percent", 1250);
    expect(d).toBe(463);
    expect(billTotals(2500, [coke, water], { discountCents: d }).totalCents).toBe(3237);
  });
});
