import { describe, expect, it } from "vitest";
import { billTotals, itemCents, itemsCents } from "./bill";

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
});
