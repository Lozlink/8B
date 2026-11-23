import { describe, expect, it } from "vitest";
import type { DayCloseDTO, DayCloseTotals } from "@/lib/domain/types";
import { buildCloseReportPdf, closeReportContent, closeReportFilename, pdfSafe, wrapText } from "./day-close-pdf";

const totals: DayCloseTotals = {
  sessionCount: 12, billedMinutes: 840, billedCents: 41250, tableCents: 35000, itemsCents: 7250, discountCents: 1000, writtenOffCents: 0,
  cardCount: 8, cardCents: 28750, cashCount: 4, cashCents: 12500, cashRoundingCents: -5,
  refundCount: 1, refundCents: 2500, refundCardCents: 0, refundCashCents: 2500, takingsCents: 38750,
  unpaidCount: 1, unpaidCents: 2500, olderUnpaidCount: 0, olderUnpaidCents: 0, voidCount: 2,
};
const close = (over: Partial<DayCloseDTO> = {}): DayCloseDTO => ({
  id: "c1", businessDate: "2026-11-23", seq: 1, closedAt: "2026-11-23T13:02:00.000Z", closedByName: "Sam", approvedByName: null,
  deviceLabel: "Counter", floatCents: 20000, countedCashCents: 29550, expectedCashCents: 30000, varianceCents: -450,
  cashCounts: { "5000": 4, "2000": 4, "1000": 1, "500": 1, "50": 1 }, note: null, reason: null, totals, ...over,
});
const TZ = "Australia/Sydney";

describe("closeReportContent", () => {
  it("says who closed it, the cash against what was expected, and the day's figures", () => {
    const r = closeReportContent(close(), TZ, "End of day, Mon 23 Nov");
    expect(r.lead[0]).toMatch(/^Closed .* by Sam on Counter$/);
    const cash = r.sections.find((s) => s.title === "Cash drawer");
    expect(cash?.rows.map((x) => x.value)).toEqual(["$200.00", "$300.00", "$295.50", "$4.50 short"]);
    expect(r.sections.find((s) => s.title === "Counted by note and coin")?.rows).toHaveLength(5);
    expect(r.sections.find((s) => s.title === "Paid")?.rows.at(-1)).toMatchObject({ label: "Takings", value: "$387.50", strong: true });
  });
  it("a total typed in has no note-and-coin list", () => {
    const r = closeReportContent(close({ cashCounts: null }), TZ, "x");
    expect(r.sections.find((s) => s.title === "Count")?.text).toBe("Typed as one total.");
  });
  it("a second close says so, with who approved it and why", () => {
    const r = closeReportContent(close({ seq: 2, approvedByName: "Mark", reason: "Late sale" }), TZ, "x");
    expect(r.lead).toContain("Closed again (close 2), approved by Mark");
    expect(r.lead).toContain("Reason: Late sale");
  });
  it("the note gets its own section", () => {
    expect(closeReportContent(close({ note: "Till jammed" }), TZ, "x").sections.find((s) => s.title === "Note")?.text).toBe("Till jammed");
  });
});

describe("pdfSafe", () => {
  it("leaves ordinary text and Western accents alone", () => {
    expect(pdfSafe("José paid $12.50")).toBe("José paid $12.50");
  });
  it("turns typographic marks into plain ones", () => {
    expect(pdfSafe("−$4.50 – “late”…")).toBe('-$4.50 - "late"...');
  });
  it("drops accents the font doesn't have and marks what it can't write", () => {
    expect(pdfSafe("Nguyễn Đức")).toBe("Nguyen Duc");
    expect(pdfSafe("سام ok")).toBe("??? ok");
  });
  it("makes one line of text with line breaks in it", () => {
    expect(pdfSafe("a\nb\t c")).toBe("a b c");
  });
});

describe("wrapText", () => {
  const w = (s: string) => s.length;
  it("breaks between words", () => {
    expect(wrapText("one two three four", 9, w)).toEqual(["one two", "three", "four"]);
  });
  it("cuts a word that is longer than a line", () => {
    expect(wrapText("abcdefghij kl", 4, w)).toEqual(["abcd", "efgh", "ij", "kl"]);
  });
});

describe("closeReportFilename", () => {
  it("is named for the day, and for the close when there was more than one", () => {
    expect(closeReportFilename({ businessDate: "2026-11-23", seq: 1 })).toBe("end-of-day-2026-11-23.pdf");
    expect(closeReportFilename({ businessDate: "2026-11-23", seq: 3 })).toBe("end-of-day-2026-11-23-close-3.pdf");
  });
});

describe("buildCloseReportPdf", () => {
  const header = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, 5));
  it("makes a PDF", async () => {
    const bytes = await buildCloseReportPdf(close(), TZ, "End of day, Mon 23 Nov");
    expect(header(bytes)).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1500);
  });
  it("still makes one when names and notes hold letters the font can't draw", async () => {
    const bytes = await buildCloseReportPdf(
      close({ closedByName: "Nguyễn سام", note: "你好 − drawer 😀 stuck\nsecond line", deviceLabel: "Floor ①" }),
      TZ,
      "End of day — Mon",
    );
    expect(header(bytes)).toBe("%PDF-");
  });
  it("runs onto a second page rather than off the first", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const bytes = await buildCloseReportPdf(close({ note: "word ".repeat(100).repeat(40).slice(0, 500) + " x".repeat(2500) }), TZ, "x");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });
});
