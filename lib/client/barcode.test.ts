import { describe, expect, it } from "vitest";
import { cleanBarcode, findByBarcode, normaliseBarcode } from "./barcode";

describe("normaliseBarcode", () => {
  it("treats UPC-A, EAN-13 and GTIN-14 of one product as the same code", () => {
    const a = normaliseBarcode("012345678905");
    expect(a).toBe("12345678905");
    expect(normaliseBarcode("0012345678905")).toBe(a);
    expect(normaliseBarcode("00012345678905")).toBe(a);
  });

  it("trims and drops spaces and hyphens", () => {
    expect(normaliseBarcode("  9300-6330 12345 ")).toBe("93006330" + "12345");
  });

  it("rejects too short, too long and non-digit codes", () => {
    expect(normaliseBarcode("12345")).toBeNull();
    expect(normaliseBarcode("123456789012345")).toBeNull();
    expect(normaliseBarcode("12345a7890")).toBeNull();
    expect(normaliseBarcode("")).toBeNull();
  });

  it("rejects an all-zero code, which identifies nothing", () => {
    expect(normaliseBarcode("000000")).toBeNull();
    expect(normaliseBarcode("0000000000000")).toBeNull();
  });
});

describe("cleanBarcode", () => {
  it("keeps the padding so it can be shown back as scanned", () => {
    expect(cleanBarcode(" 0012-3456 78 ")).toBe("00123456" + "78");
    expect(cleanBarcode("123")).toBeNull();
  });
});

describe("findByBarcode", () => {
  const products = [
    { id: "a", barcode: "9300633123456" },
    { id: "b", barcode: "012345678905" },
    { id: "c", barcode: null },
    { id: "d", barcode: "12345678905" },
  ];

  it("matches across padding and returns every match", () => {
    expect(findByBarcode(products, "0012345678905").map((p) => p.id)).toEqual(["b", "d"]);
  });

  it("returns one match for a single item", () => {
    expect(findByBarcode(products, "9300633123456").map((p) => p.id)).toEqual(["a"]);
  });

  it("returns nothing for no match, an invalid code or an all-zero code", () => {
    expect(findByBarcode(products, "111111111111")).toEqual([]);
    expect(findByBarcode(products, "123")).toEqual([]);
    expect(findByBarcode([{ barcode: "000000" }], "000000")).toEqual([]);
  });
});
