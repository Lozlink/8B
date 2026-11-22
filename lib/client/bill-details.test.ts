import { describe, expect, it } from "vitest";
import {
  NAME_MAX,
  NOTE_MAX,
  charsLeft,
  checkDetails,
  detailsOf,
  normaliseName,
  normaliseNote,
  savedMessage,
} from "./bill-details";

const none = { customerName: null, note: null };

describe("normaliseName and normaliseNote", () => {
  it("trim, and turn blank into nothing", () => {
    expect(normaliseName("  Sam  ")).toBe("Sam");
    expect(normaliseName("   ")).toBeNull();
    expect(normaliseName("")).toBeNull();
    expect(normaliseNote("\n  \n")).toBeNull();
  });

  it("make a name one line with single spaces", () => {
    expect(normaliseName("Sam   and\nJo")).toBe("Sam and Jo");
  });

  it("make a note one line but keep its words", () => {
    expect(normaliseNote("Birthday\r\nbring cake")).toBe("Birthday bring cake");
    expect(normaliseNote(" owes   $5 ")).toBe("owes   $5");
  });
});

describe("detailsOf", () => {
  it("reads the two fields off a bill", () => {
    expect(detailsOf({ customerName: "Sam", note: null })).toEqual({ customerName: "Sam", note: null });
  });
});

describe("checkDetails", () => {
  it("is unchanged when the fields match the bill", () => {
    const r = checkDetails("Sam", "Birthday", { customerName: "Sam", note: "Birthday" });
    expect(r).toEqual({ ok: true, details: { customerName: "Sam", note: "Birthday" }, changed: false, changes: {} });
  });

  it("ignores spaces around what is already there", () => {
    const r = checkDetails("  Sam ", "", { customerName: "Sam", note: null });
    expect(r).toMatchObject({ ok: true, changed: false });
  });

  it("clearing both fields sends nulls and counts as a change", () => {
    const r = checkDetails("", "  ", { customerName: "Sam", note: "x" });
    expect(r).toEqual({ ok: true, details: none, changed: true, changes: { customerName: null, note: null } });
  });

  it("changing only the note keeps the name", () => {
    const r = checkDetails("Sam", "New", { customerName: "Sam", note: "Old" });
    expect(r).toEqual({ ok: true, details: { customerName: "Sam", note: "New" }, changed: true, changes: { note: "New" } });
  });

  it("sends only the field that changed, so a name save leaves the note alone", () => {
    const r = checkDetails("Jo", "Old", { customerName: null, note: "Old" });
    expect(r).toMatchObject({ ok: true, changes: { customerName: "Jo" } });
    expect(r.ok && "note" in r.changes).toBe(false);
  });

  it("accepts text right at the limits", () => {
    expect(checkDetails("a".repeat(NAME_MAX), "b".repeat(NOTE_MAX), none)).toMatchObject({ ok: true, changed: true });
  });

  it("refuses a name or note past the limits", () => {
    expect(checkDetails("a".repeat(NAME_MAX + 1), "", none)).toEqual({ ok: false, error: "The name can be up to 40 characters." });
    expect(checkDetails("", "b".repeat(NOTE_MAX + 1), none)).toEqual({ ok: false, error: "The note can be up to 200 characters." });
  });
});

describe("charsLeft", () => {
  it("counts down, then says how far over", () => {
    expect(charsLeft(0, 40)).toBe("40 left");
    expect(charsLeft(40, 40)).toBe("0 left");
    expect(charsLeft(43, 40)).toBe("Over by 3");
  });
});

describe("savedMessage", () => {
  const sam = { customerName: "Sam", note: null };
  it("names what changed", () => {
    expect(savedMessage(none, sam)).toBe("Name saved");
    expect(savedMessage(sam, none)).toBe("Name removed");
    expect(savedMessage(none, { customerName: null, note: "x" })).toBe("Note saved");
    expect(savedMessage({ customerName: null, note: "x" }, none)).toBe("Note removed");
  });

  it("covers both at once", () => {
    expect(savedMessage(none, { customerName: "Sam", note: "x" })).toBe("Name and note saved");
    expect(savedMessage({ customerName: "Sam", note: "x" }, none)).toBe("Name and note removed");
    expect(savedMessage({ customerName: "Sam", note: null }, { customerName: null, note: "x" })).toBe("Name and note updated");
  });

  it("a rename counts as saved, and no change is just saved", () => {
    expect(savedMessage(sam, { customerName: "Jo", note: null })).toBe("Name saved");
    expect(savedMessage(sam, sam)).toBe("Saved");
  });
});
