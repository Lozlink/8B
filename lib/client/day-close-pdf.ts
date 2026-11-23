/**
 * The End of day report as a PDF, made in the browser.
 *
 * Why not `window.print()`: an iPad web app opened from its Home Screen icon ignores it. A PDF
 * handed to the share sheet can be printed (AirPrint), saved to Files, AirDropped or emailed.
 */
import type { DayCloseDTO } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";
import { countRows, describeDifference } from "./day-close";

export interface ReportRow {
  label: string;
  /** A quieter second line under the label. */
  detail?: string;
  value: string;
  strong?: boolean;
}

export interface ReportSection {
  title: string;
  rows: ReportRow[];
  /** Free text under the rows (the note). */
  text?: string;
}

export interface CloseReportContent {
  heading: string;
  /** Lines under the heading: who closed it and when, and why if it was closed again. */
  lead: string[];
  sections: ReportSection[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the report says, in order. The same figures and wording as the report on screen. */
export function closeReportContent(c: DayCloseDTO, tz: string, heading: string): CloseReportContent {
  const t = c.totals;
  const lead = [`Closed ${formatDateTime(c.closedAt, tz)} by ${c.closedByName}${c.deviceLabel ? ` on ${c.deviceLabel}` : ""}`];
  if (c.seq > 1) lead.push(`Closed again (close ${c.seq})${c.approvedByName ? `, approved by ${c.approvedByName}` : ""}`);
  else if (c.approvedByName) lead.push(`Approved by ${c.approvedByName}`);
  if (c.reason) lead.push(`Reason: ${c.reason}`);

  const counted = countRows(c.cashCounts);
  const sections: ReportSection[] = [
    {
      title: "Cash drawer",
      rows: [
        { label: "Float", value: formatCents(c.floatCents) },
        { label: "Expected in drawer", value: formatCents(c.expectedCashCents) },
        { label: "Counted", value: formatCents(c.countedCashCents) },
        { label: "Difference", value: describeDifference(c.varianceCents), strong: true },
      ],
    },
    counted.length > 0
      ? {
          title: "Counted by note and coin",
          rows: counted.map((r) => ({ label: `${r.label} x ${r.quantity}`, value: formatCents(r.subtotalCents) })),
        }
      : { title: "Count", rows: [], text: "Typed as one total." },
  ];
  if (c.note) sections.push({ title: "Note", rows: [], text: c.note });
  sections.push(
    {
      title: "Billed",
      rows: [
        { label: "Billed", detail: `${plural(t.sessionCount, "bill")}, ${t.billedMinutes} min`, value: formatCents(t.billedCents), strong: true },
        { label: "Table time", value: formatCents(t.tableCents) },
        { label: "Items", value: formatCents(t.itemsCents) },
        { label: "Discounts", value: formatCents(t.discountCents) },
        { label: "Written off", value: formatCents(t.writtenOffCents) },
      ],
    },
    {
      title: "Paid",
      rows: [
        { label: "Card", detail: plural(t.cardCount, "payment"), value: formatCents(t.cardCents) },
        {
          label: "Cash",
          detail:
            plural(t.cashCount, "payment") +
            (t.cashRoundingCents !== 0 ? `, ${t.cashRoundingCents > 0 ? "+" : "-"}${formatCents(Math.abs(t.cashRoundingCents))} rounding` : ""),
          value: formatCents(t.cashCents),
        },
        {
          label: "Refunds",
          detail:
            t.refundCount === 0
              ? "None"
              : `${plural(t.refundCount, "refund")}: card ${formatCents(t.refundCardCents)}, cash ${formatCents(t.refundCashCents)}`,
          value: formatCents(t.refundCents),
        },
        { label: "Takings", detail: "Card plus cash, less refunds", value: formatCents(t.takingsCents), strong: true },
      ],
    },
    {
      title: "Still open",
      rows: [
        { label: "Unpaid", detail: plural(t.unpaidCount, "bill"), value: formatCents(t.unpaidCents) },
        { label: "Earlier unpaid", detail: `${plural(t.olderUnpaidCount, "bill")} from earlier days`, value: formatCents(t.olderUnpaidCents) },
        { label: "Voids", value: String(t.voidCount) },
      ],
    },
  );
  return { heading, lead, sections };
}

const SWAPS: Record<string, string> = {
  "−": "-", // minus sign
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  " ": " ",
  "đ": "d",
  "Đ": "D",
};

/**
 * Text the PDF's built-in font can draw. It only has Western European letters: anything else
 * would stop the whole file being made. Accented letters outside that set lose their accents
 * ("Nguyễn" becomes "Nguyen"); a letter with no plain form becomes "?". Line breaks become spaces.
 */
export function pdfSafe(text: string): string {
  let out = "";
  for (const ch of text.replace(/\s+/g, " ")) {
    const swapped = SWAPS[ch] ?? ch;
    if ([...swapped].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 255 && !(c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 160))) {
      out += swapped;
      continue;
    }
    const plain = swapped.normalize("NFD").replace(/[̀-ͯ]/g, "");
    out += plain !== "" && [...plain].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127) ? plain : "?";
  }
  return out.trim();
}

/** "end-of-day-2026-11-23.pdf", or with "-close-2" when the day was closed again. */
export function closeReportFilename(c: Pick<DayCloseDTO, "businessDate" | "seq">): string {
  return `end-of-day-${c.businessDate}${c.seq > 1 ? `-close-${c.seq}` : ""}.pdf`;
}

/** Breaks text into lines no wider than `max`, measuring with `width`. A word longer than a line is cut. */
export function wrapText(text: string, max: number, width: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
    let w = word;
    while (width(w) > max && w.length > 1) {
      let cut = w.length - 1;
      while (cut > 1 && width(w.slice(0, cut)) > max) cut -= 1;
      if (line) lines.push(line);
      lines.push(w.slice(0, cut));
      line = "";
      w = w.slice(cut);
    }
    const next = line ? `${line} ${w}` : w;
    if (width(next) <= max) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The report as an A4 PDF. The library is loaded only when someone asks for the file. */
export async function buildCloseReportPdf(c: DayCloseDTO, tz: string, heading: string, venue = "8 Ball Lounge"): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const content = closeReportContent(c, tz, heading);
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${venue}: ${heading}`));
  doc.setCreationDate(new Date(c.closedAt));
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28;
  const H = 841.89;
  const M = 40;
  const right = W - M;
  const black = rgb(0, 0, 0);
  const grey = rgb(0.38, 0.38, 0.38);
  const rule = rgb(0.8, 0.8, 0.8);

  let page = doc.addPage([W, H]);
  let y = H - M;
  /** Makes sure `need` points are left on the page, starting a new one if not. */
  const room = (need: number) => {
    if (y - need >= M) return;
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const text = (s: string, x: number, size: number, font = regular, color = black) => page.drawText(s, { x, y, size, font, color });
  const textRight = (s: string, size: number, font = regular) => page.drawText(s, { x: right - font.widthOfTextAtSize(s, size), y, size, font, color: black });
  const paragraph = (s: string, size: number, color = black) => {
    for (const line of wrapText(pdfSafe(s), right - M, (v) => regular.widthOfTextAtSize(v, size))) {
      room(size + 5);
      text(line, M, size, regular, color);
      y -= size + 5;
    }
  };

  text(pdfSafe(venue), M, 11, bold, grey);
  y -= 26;
  for (const line of wrapText(pdfSafe(content.heading), right - M, (v) => bold.widthOfTextAtSize(v, 20))) {
    text(line, M, 20, bold);
    y -= 26;
  }
  y += 6;
  for (const l of content.lead) paragraph(l, 10.5, grey);

  for (const section of content.sections) {
    room(60);
    y -= 24;
    text(pdfSafe(section.title), M, 12, bold);
    y -= 7;
    page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 1, color: black });
    y -= 4;
    for (const row of section.rows) {
      const height = row.detail ? 28 : 18;
      room(height + 2);
      y -= 13.5;
      const font = row.strong ? bold : regular;
      const size = row.strong ? 12 : 11;
      text(pdfSafe(row.label), M, size, font);
      textRight(pdfSafe(row.value), size, row.strong ? bold : regular);
      if (row.detail) {
        y -= 10.5;
        text(pdfSafe(row.detail), M, 8.5, regular, grey);
      }
      y -= 4.5;
      page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 0.5, color: rule });
    }
    if (section.text) {
      y -= 16;
      paragraph(section.text, 11);
      y += 6;
    }
  }
  return doc.save();
}

/**
 * Hands the PDF to the device: the share sheet where there is one (iPad: Print, Save to Files,
 * AirDrop, Mail), otherwise a normal download. Resolves "cancelled" when the sheet was dismissed.
 */
export async function sharePdf(bytes: Uint8Array, filename: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const file = new File([blob], filename, { type: "application/pdf" });
  if (typeof navigator.share === "function" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (e) {
      // Closing the sheet without choosing anything is not a failure.
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      throw e;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}
