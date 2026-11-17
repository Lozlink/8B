import { describe, expect, it } from "vitest";
import { billTotals, cashDueCents, itemCents, itemsCents } from "./bill";

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
    expect(billTotals(0, [{ unitCents: 300, quantity: 2, taxed: false }])).toEqual({ tableCents: 0, itemsCents: 600, totalCents: 600, gstCents: 0 });
    expect(billTotals(2500, []).gstCents).toBe(227);
  });

  it("a bill with nothing on it is zero", () => {
    expect(billTotals(0, [])).toEqual({ tableCents: 0, itemsCents: 0, totalCents: 0, gstCents: 0 });
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
