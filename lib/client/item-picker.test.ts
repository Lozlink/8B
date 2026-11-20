import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORY,
  LOW_STOCK_THRESHOLD,
  OTHER_CATEGORY,
  brandSections,
  categoryOptions,
  filterProducts,
  itemSections,
  stockLabel,
  stockTone,
} from "./item-picker";

const p = (name: string, category: string | null, barcode: string | null = null) => ({ name, category, barcode });

const products = [
  p("Smith's Original Chips", "Chips", "9300000000011"),
  p("Doritos Nacho Cheese", "Chips"),
  p("Cadbury Dairy Milk", "Chocolate", "9300000000028"),
  p("Coca-Cola 375ml", "Drinks", "9300000000035"),
  p("Mystery Item", null),
];

describe("stockLabel", () => {
  it("says nothing when not tracked or comfortably in stock", () => {
    expect(stockLabel(null)).toBeNull();
    expect(stockLabel(LOW_STOCK_THRESHOLD + 1)).toBeNull();
    expect(stockLabel(97)).toBeNull();
  });

  it("flags low from 1 up to the threshold", () => {
    expect(stockLabel(1)).toEqual({ text: "1 left", tone: "low" });
    expect(stockLabel(LOW_STOCK_THRESHOLD)).toEqual({ text: `${LOW_STOCK_THRESHOLD} left`, tone: "low" });
  });

  it("flags out at zero and below", () => {
    expect(stockLabel(0)).toEqual({ text: "Out of stock", tone: "out" });
    expect(stockLabel(-3)).toEqual({ text: "Out of stock", tone: "out" });
    expect(stockTone(-3)).toBe("out");
  });
});

describe("categoryOptions", () => {
  it("lists All first with counts, categories in order, Other last", () => {
    expect(categoryOptions(products)).toEqual([
      { key: ALL_CATEGORY, label: "All", count: 5 },
      { key: "Chips", label: "Chips", count: 2 },
      { key: "Chocolate", label: "Chocolate", count: 1 },
      { key: "Drinks", label: "Drinks", count: 1 },
      { key: OTHER_CATEGORY, label: "Other", count: 1 },
    ]);
  });

  it("puts Other last even when uncategorised items come first", () => {
    const opts = categoryOptions([p("x", null), p("y", "Drinks")]);
    expect(opts.map((o) => o.label)).toEqual(["All", "Drinks", "Other"]);
  });

  it("treats a blank category as Other and has only All when there is nothing", () => {
    expect(categoryOptions([p("x", "  ")]).map((o) => o.label)).toEqual(["All", "Other"]);
    expect(categoryOptions([])).toEqual([{ key: ALL_CATEGORY, label: "All", count: 0 }]);
  });
});

describe("filterProducts", () => {
  it("returns everything with no filter", () => {
    expect(filterProducts(products, ALL_CATEGORY, "  ")).toHaveLength(5);
  });

  it("filters by category, including Other", () => {
    expect(filterProducts(products, "Chips", "").map((x) => x.name)).toEqual(["Smith's Original Chips", "Doritos Nacho Cheese"]);
    expect(filterProducts(products, OTHER_CATEGORY, "").map((x) => x.name)).toEqual(["Mystery Item"]);
  });

  it("matches every term anywhere in the name, any case", () => {
    expect(filterProducts(products, ALL_CATEGORY, "CHEESE nacho").map((x) => x.name)).toEqual(["Doritos Nacho Cheese"]);
    expect(filterProducts(products, ALL_CATEGORY, "cola 375").map((x) => x.name)).toEqual(["Coca-Cola 375ml"]);
    expect(filterProducts(products, ALL_CATEGORY, "cheese milk")).toEqual([]);
  });

  it("combines category and text", () => {
    expect(filterProducts(products, "Drinks", "chips")).toEqual([]);
  });

  it("matches by barcode when the query is a whole barcode, ignoring padding", () => {
    expect(filterProducts(products, ALL_CATEGORY, "09300000000028").map((x) => x.name)).toEqual(["Cadbury Dairy Milk"]);
  });

  it("does not match short digit strings against barcodes", () => {
    expect(filterProducts(products, ALL_CATEGORY, "9300")).toEqual([]);
  });
});

describe("brandSections", () => {
  const n = (...names: string[]) => names.map((name) => ({ name, category: "Biscuits" }));
  const view = (s: ReturnType<typeof brandSections<{ name: string }>>) => s.map((x) => [x.heading, x.items.map((i) => i.label)]);

  it("groups by leading word, heads each group with the words it shares, and shortens the buttons", () => {
    const s = brandSections(
      n("Cadbury Breakaway", "Fun Sticks Choc", "Fun Sticks Vanilla", "Jatz Original", "Oreo Double Stuff", "Oreo Double Stuff Mint", "Oreo Original", "Tim Tam Double Coat", "Tim Tam Original"),
    );
    expect(view(s)).toEqual([
      ["Fun Sticks", ["Choc", "Vanilla"]],
      ["Oreo", ["Double Stuff", "Double Stuff Mint", "Original"]],
      ["Tim Tam", ["Double Coat", "Original"]],
      ["More", ["Cadbury Breakaway", "Jatz Original"]],
    ]);
    // The product itself is untouched: the full name is still there for the bill and for screen readers.
    expect(s[0].items[0].product.name).toBe("Fun Sticks Choc");
  });

  it("an item that is only the brand keeps its name", () => {
    expect(view(brandSections(n("Pepsi", "Pepsi Max", "Red Bull", "Red Bull Sugarfree")))).toEqual([
      ["Pepsi", ["Pepsi", "Max"]],
      ["Red Bull", ["Red Bull", "Sugarfree"]],
    ]);
  });

  it("matches the brand whatever the capitals, and stops at the first word that differs", () => {
    expect(view(brandSections(n("McVitie's Tops Lemon", "MCVITIE'S Dutch Shortcake Speculaas", "McVitie's Tops Raspberry")))).toEqual([
      ["McVitie's", ["Tops Lemon", "Dutch Shortcake Speculaas", "Tops Raspberry"]],
    ]);
  });

  it("no heading at all when nothing shares a brand, and nothing for an empty list", () => {
    expect(view(brandSections(n("KitKat", "Mars", "Twix")))).toEqual([[null, ["KitKat", "Mars", "Twix"]]]);
    expect(brandSections([])).toEqual([]);
  });
});

describe("itemSections", () => {
  const list = [p("Doritos Nacho Cheese", "Chips"), p("Doritos Mexicana", "Chips"), p("Mars", "Chocolate"), p("Mystery Item", null)];
  const view = (s: ReturnType<typeof itemSections<(typeof list)[number]>>) => s.map((x) => [x.heading, x.items.map((i) => i.label)]);

  it("All: a block per category with full names, Other last", () => {
    expect(view(itemSections(list, ALL_CATEGORY, ""))).toEqual([
      ["Chips", ["Doritos Nacho Cheese", "Doritos Mexicana"]],
      ["Chocolate", ["Mars"]],
      ["Other", ["Mystery Item"]],
    ]);
  });

  it("one category: a block per brand", () => {
    expect(view(itemSections(filterProducts(list, "Chips", ""), "Chips", ""))).toEqual([["Doritos", ["Nacho Cheese", "Mexicana"]]]);
  });

  it("searching: one flat list of full names, whatever the category", () => {
    expect(view(itemSections(filterProducts(list, "Chips", "dor"), "Chips", "dor"))).toEqual([[null, ["Doritos Nacho Cheese", "Doritos Mexicana"]]]);
    expect(itemSections([], "Chips", "zzz")).toEqual([]);
  });

  it("All with a single category has no heading", () => {
    expect(view(itemSections([p("Mars", "Chocolate"), p("Twix", "Chocolate")], ALL_CATEGORY, ""))).toEqual([[null, ["Mars", "Twix"]]]);
  });
});
