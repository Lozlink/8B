import { describe, expect, it } from "vitest";
import type { ProfitReportDTO } from "@/lib/domain/types";
import {
  addDays,
  buildProfitCsv,
  checkCostField,
  checkRange,
  chunk,
  costsToSave,
  csvField,
  daysInRange,
  dollarsField,
  exGstCents,
  formatMarginBps,
  marginFor,
  noCostCount,
  presetFor,
  presetRange,
  previewPaste,
  profitCsvFilename,
  stockAtCost,
  type PasteProduct,
} from "./costs";

const prod = (over: Partial<PasteProduct> & { id: string; name: string }): PasteProduct => ({
  barcode: null,
  sku: null,
  costCents: null,
  active: true,
  ...over,
});

const PRODUCTS: PasteProduct[] = [
  prod({ id: "SQ1", name: "Coke 330ml", barcode: "9300675024235", sku: "COKE330" }),
  prod({ id: "SQ2", name: "Chips, salted", barcode: "0012345678905", sku: "CHIPS", costCents: 150 }),
  prod({ id: "SQ3", name: "Water", barcode: null, sku: null }),
  prod({ id: "SQ4", name: "Mars Bar", barcode: "9300000000001" }),
  prod({ id: "SQ5", name: "Mars  bar", barcode: "9300000000002" }),
  prod({ id: "SQ6", name: "Old Item", active: false }),
];

describe("exGstCents and marginFor", () => {
  it("takes the GST out of taxed prices and leaves GST-free ones", () => {
    expect(exGstCents(1100, true)).toBe(1000);
    expect(exGstCents(500, true)).toBe(455); // 454.54...
    expect(exGstCents(450, true)).toBe(409); // 409.09...
    expect(exGstCents(300, true)).toBe(273); // 272.72...
    expect(exGstCents(1, true)).toBe(1); // 0.909 rounds up
    expect(exGstCents(0, true)).toBe(0);
    expect(exGstCents(500, false)).toBe(500);
  });

  it("works out profit and margin in basis points", () => {
    expect(marginFor(1100, true, 600)).toEqual({ exGstCents: 1000, profitCents: 400, bps: 4000 });
    expect(marginFor(500, false, 200)).toEqual({ exGstCents: 500, profitCents: 300, bps: 6000 });
    expect(marginFor(1100, true, 1200).bps).toBe(-2000);
    expect(marginFor(0, true, 0).bps).toBeNull();
  });

  it("formats margins to one decimal", () => {
    expect(formatMarginBps(6250)).toBe("62.5%");
    expect(formatMarginBps(4000)).toBe("40.0%");
    expect(formatMarginBps(-500)).toBe("-5.0%");
    expect(formatMarginBps(0)).toBe("0.0%");
    expect(formatMarginBps(null)).toBe("n/a");
  });
});

describe("stockAtCost", () => {
  it("adds stock x cost over costed tracked items and counts the rest", () => {
    const r = stockAtCost([
      { active: true, tracked: true, stock: 10, costCents: 150 },
      { active: true, tracked: true, stock: 4, costCents: 200 },
      { active: true, tracked: true, stock: 7, costCents: null },
      { active: true, tracked: true, stock: null, costCents: 100 },
      { active: true, tracked: true, stock: -3, costCents: 100 },
      { active: true, tracked: false, stock: null, costCents: null },
      { active: false, tracked: true, stock: 5, costCents: 100 },
    ]);
    expect(r).toEqual({ costCents: 2300, units: 14, uncostedProducts: 1 });
  });

  it("counts items with no cost among those staff can sell", () => {
    expect(noCostCount(PRODUCTS)).toBe(4);
  });
});

describe("checkCostField", () => {
  it("accepts dollars, clears on empty and refuses the rest", () => {
    expect(checkCostField("1.20")).toEqual({ ok: true, costCents: 120 });
    expect(checkCostField("$3")).toEqual({ ok: true, costCents: 300 });
    expect(checkCostField("1.2000")).toEqual({ ok: true, costCents: 120 });
    expect(checkCostField("0")).toEqual({ ok: true, costCents: 0 });
    expect(checkCostField("  ")).toEqual({ ok: true, costCents: null });
    expect(checkCostField("1.234").ok).toBe(false);
    expect(checkCostField("-1").ok).toBe(false);
    expect(checkCostField("abc").ok).toBe(false);
    expect(checkCostField("10000")).toEqual({ ok: true, costCents: 1_000_000 });
    expect(checkCostField("10000.01").ok).toBe(false);
  });
});

describe("previewPaste", () => {
  it("matches by Square id, barcode, SKU, then name", () => {
    const p = previewPaste("SQ1\t1.00\n9300675024235\t2.00\nCHIPS\t3.00\nwater\t4.00", PRODUCTS);
    // Rows 1 and 2 are the same product: the last one wins and the first is reported as repeated.
    expect(p.repeated).toHaveLength(1);
    expect(p.matched.map((m) => m.product.id)).toEqual(["SQ1", "SQ2", "SQ3"]);
    expect(p.matched.find((m) => m.product.id === "SQ1")?.newCents).toBe(200);
  });

  it("tries the id before the barcode before the SKU", () => {
    const products = [
      prod({ id: "A", name: "A item", barcode: "111111", sku: "B" }),
      prod({ id: "B", name: "B item" }),
      prod({ id: "C", name: "C item", sku: "111111" }),
    ];
    expect(previewPaste("B\t1", products).matched[0]?.product.id).toBe("B");
    expect(previewPaste("111111\t1", products).matched[0]?.product.id).toBe("A");
  });

  it("shows old and new cost and whether it changed", () => {
    const p = previewPaste("Chips, salted\t1.50\nCoke 330ml\t1.10", PRODUCTS);
    expect(p.matched[0]).toMatchObject({ oldCents: 150, newCents: 150, changed: false });
    expect(p.matched[1]).toMatchObject({ oldCents: null, newCents: 110, changed: true });
    expect(costsToSave(p)).toEqual([{ productId: "SQ1", costCents: 110 }]);
  });

  it("ignores case and extra spaces in names", () => {
    expect(previewPaste("  COKE   330ML \t1", PRODUCTS).matched[0]?.product.id).toBe("SQ1");
  });

  it("skips a header row and blank lines", () => {
    const p = previewPaste("Item\tCost\n\nCoke 330ml\t1.10\n\n", PRODUCTS);
    expect(p.headerSkipped).toBe(true);
    expect(p.matched).toHaveLength(1);
    expect(p.badCost).toHaveLength(0);
  });

  it("skips a header that says Square ID and Cost ex GST, with comma or tab", () => {
    expect(previewPaste("Square ID,Cost ex GST\nSQ3,2", PRODUCTS).headerSkipped).toBe(true);
    expect(previewPaste("Barcode\tUnit cost\nSQ3\t2", PRODUCTS).headerSkipped).toBe(true);
  });

  it("does not mistake a first data row for a header", () => {
    const p = previewPaste("Coke 330ml\t1.10", PRODUCTS);
    expect(p.headerSkipped).toBe(false);
    expect(p.matched).toHaveLength(1);
  });

  it("accepts commas, and a comma inside the name", () => {
    const p = previewPaste("SQ3,2.10\n\"Chips, salted\",1.60\nChips, salted,1.70", PRODUCTS);
    expect(p.matched.find((m) => m.product.id === "SQ3")?.newCents).toBe(210);
    expect(p.matched.find((m) => m.product.id === "SQ2")?.newCents).toBe(170);
    expect(p.repeated).toHaveLength(1);
  });

  it("lets a tab win over commas on the same row", () => {
    const p = previewPaste("Chips, salted\t1.60", PRODUCTS);
    expect(p.matched[0]?.newCents).toBe(160);
  });

  it("reads a thousands comma in a tab row but flags it in a comma row", () => {
    expect(previewPaste("SQ3\t1,234.50", PRODUCTS).matched[0]?.newCents).toBe(123450);
    const p = previewPaste("SQ3,1,234.50", PRODUCTS);
    expect(p.matched).toHaveLength(0);
    expect(p.badCost[0]?.reason).toMatch(/comma/i);
  });

  it("takes dollar signs and trailing zeros", () => {
    expect(previewPaste("SQ3\t$2.5", PRODUCTS).matched[0]?.newCents).toBe(250);
    expect(previewPaste("SQ3\t2.5000", PRODUCTS).matched[0]?.newCents).toBe(250);
  });

  it("reports costs that do not parse, and rows with no cost", () => {
    const p = previewPaste("SQ3\tabc\nSQ4\t-1\nSQ1\t\nSQ3\t1.234\nWater", PRODUCTS);
    expect(p.badCost).toHaveLength(5);
    expect(p.matched).toHaveLength(0);
  });

  it("puts a cost over $10,000 in the unreadable group", () => {
    const p = previewPaste("SQ3\t10000.01\nSQ4\t10000", PRODUCTS);
    expect(p.badCost).toHaveLength(1);
    expect(p.matched.map((m) => m.product.id)).toEqual(["SQ4"]);
  });

  it("reports rows that match nothing", () => {
    const p = previewPaste("Nope\t1\nSQ99\t2", PRODUCTS);
    expect(p.unmatched.map((u) => u.line)).toEqual([1, 2]);
  });

  it("reports rows that match more than one product and names them", () => {
    const p = previewPaste("mars bar\t1", PRODUCTS);
    expect(p.ambiguous).toHaveLength(1);
    expect(p.ambiguous[0]?.reason).toContain("Mars Bar");
    expect(p.matched).toHaveLength(0);
  });

  it("reads barcodes that arrive with a trailing .0", () => {
    expect(previewPaste("9300675024235.0\t1", PRODUCTS).matched[0]?.product.id).toBe("SQ1");
    expect(previewPaste("9300675024235.00\t1", PRODUCTS).matched[0]?.product.id).toBe("SQ1");
  });

  it("matches a barcode that lost its leading zero", () => {
    expect(previewPaste("12345678905\t1", PRODUCTS).matched[0]?.product.id).toBe("SQ2");
  });

  it("flags a barcode in scientific notation instead of guessing", () => {
    const p = previewPaste("9.30E+12\t1", PRODUCTS);
    expect(p.matched).toHaveLength(0);
    expect(p.unmatched[0]?.reason).toMatch(/rounded/i);
  });

  it("prefers items still in Square, but can reach one that is gone", () => {
    expect(previewPaste("Old Item\t1", PRODUCTS).matched[0]?.product.id).toBe("SQ6");
    const twin = [...PRODUCTS, prod({ id: "SQ7", name: "Water", active: false })];
    expect(previewPaste("Water\t1", twin).matched[0]?.product.id).toBe("SQ3");
  });

  it("handles Windows line endings and quoted cells", () => {
    const p = previewPaste('"SQ3"\t"2.00"\r\n"SQ1"\t"1.00"\r\n', PRODUCTS);
    expect(p.matched.map((m) => m.newCents)).toEqual([200, 100]);
  });

  it("keeps the line number of each problem", () => {
    const p = previewPaste("Item\tCost\nNope\t1\n\nSQ3\tx", PRODUCTS);
    expect(p.unmatched[0]?.line).toBe(2);
    expect(p.badCost[0]?.line).toBe(4);
  });
});

describe("chunk", () => {
  it("cuts a list into pieces", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 500)).toEqual([]);
    expect(chunk(Array.from({ length: 1001 }, (_, i) => i), 500).map((c) => c.length)).toEqual([500, 500, 1]);
  });
});

describe("dates", () => {
  it("does plain calendar arithmetic", () => {
    expect(addDays("2026-11-23", -1)).toBe("2026-11-22");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(() => addDays("2026-02-30", 1)).toThrow();
  });

  it("counts days with both ends", () => {
    expect(daysInRange("2026-11-23", "2026-11-23")).toBe(1);
    expect(daysInRange("2026-11-17", "2026-11-23")).toBe(7);
    expect(daysInRange("2026-01-01", "2026-12-31")).toBe(365);
  });

  it("works the presets out from the business date", () => {
    const today = "2026-11-23";
    expect(presetRange("today", today)).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(presetRange("yesterday", today)).toEqual({ from: "2026-11-22", to: "2026-11-22" });
    expect(presetRange("last7", today)).toEqual({ from: "2026-11-17", to: "2026-11-23" });
    expect(presetRange("thisMonth", today)).toEqual({ from: "2026-11-01", to: "2026-11-23" });
    expect(presetRange("lastMonth", today)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("handles month and year edges", () => {
    expect(presetRange("yesterday", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    expect(presetRange("yesterday", "2028-03-01")).toEqual({ from: "2028-02-29", to: "2028-02-29" });
    expect(presetRange("lastMonth", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("lastMonth", "2026-03-01")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("last7", "2026-01-03")).toEqual({ from: "2025-12-28", to: "2026-01-03" });
    expect(presetRange("thisMonth", "2026-12-01")).toEqual({ from: "2026-12-01", to: "2026-12-01" });
  });

  it("says which preset a range is", () => {
    expect(presetFor({ from: "2026-11-22", to: "2026-11-22" }, "2026-11-23")).toBe("yesterday");
    expect(presetFor({ from: "2026-11-01", to: "2026-11-22" }, "2026-11-23")).toBeNull();
  });

  it("checks a custom range", () => {
    expect(checkRange("2026-11-01", "2026-11-23").ok).toBe(true);
    expect(checkRange("2026-11-23", "2026-11-01").ok).toBe(false);
    expect(checkRange("", "2026-11-01").ok).toBe(false);
    expect(checkRange("2026-02-30", "2026-03-01").ok).toBe(false);
  });

  it("allows 366 days and refuses 367", () => {
    expect(checkRange("2025-11-23", "2026-11-23").ok).toBe(true); // 366 days
    expect(checkRange("2024-01-01", "2024-12-31").ok).toBe(true); // 366 days
    expect(checkRange("2024-01-01", "2025-01-01").ok).toBe(false); // 367 days
  });
});

describe("csv", () => {
  it("quotes fields that need it", () => {
    expect(csvField("Cola")).toBe("Cola");
    expect(csvField("Chips, salted")).toBe('"Chips, salted"');
    expect(csvField('The "big" one')).toBe('"The ""big"" one"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(12)).toBe("12");
  });

  it("stops names from running as formulas", () => {
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvField("@home")).toBe("'@home");
  });

  it("writes signed dollars from integer cents", () => {
    expect(dollarsField(1999)).toBe("19.99");
    expect(dollarsField(5)).toBe("0.05");
    expect(dollarsField(-250)).toBe("-2.50");
    expect(dollarsField(0)).toBe("0.00");
  });

  const report: ProfitReportDTO = {
    today: "2026-11-23",
    from: "2026-11-17",
    to: "2026-11-23",
    lines: [
      { productId: "SQ1", name: "Chips, salted", quantity: 4, salesCents: 1100, salesExGstCents: 1000, uncostedQuantity: 0, costCents: 600, profitCents: 400, marginBps: 4000 },
      { productId: "SQ2", name: "Loss leader", quantity: 1, salesCents: 110, salesExGstCents: 100, uncostedQuantity: 0, costCents: 150, profitCents: -50, marginBps: -5000 },
      { productId: null, name: 'Custom "thing"', quantity: 2, salesCents: 550, salesExGstCents: 500, uncostedQuantity: 2, costCents: 0, profitCents: 0, marginBps: null },
    ],
    items: { quantity: 7, salesCents: 1760, salesExGstCents: 1600, uncostedQuantity: 2, uncostedSalesExGstCents: 500, costCents: 750, profitCents: 350, marginBps: 3182 },
    table: { cents: 0, exGstCents: 0 },
    discountCents: 0,
    stock: { costCents: 0, units: 0, uncostedProducts: 0 },
  };

  it("builds the file with a header, a row per line and a total", () => {
    expect(buildProfitCsv(report).split("\r\n")).toEqual([
      "Item,Quantity sold,Sales ex GST,Cost,Profit,Margin %,Quantity with no cost",
      '"Chips, salted",4,10.00,6.00,4.00,40.0,0',
      "Loss leader,1,1.00,1.50,-0.50,-50.0,0",
      '"Custom ""thing""",2,5.00,0.00,0.00,,2',
      "Total,7,16.00,7.50,3.50,31.8,2",
      "",
    ]);
  });

  it("names the file by its dates", () => {
    expect(profitCsvFilename(report)).toBe("profit-2026-11-17-to-2026-11-23.csv");
    expect(profitCsvFilename({ from: "2026-11-23", to: "2026-11-23" })).toBe("profit-2026-11-23.csv");
  });
});
