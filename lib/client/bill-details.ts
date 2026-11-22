import type { SessionDTO } from "@/lib/domain/types";

/** Longest customer name and note the server accepts. */
export const NAME_MAX = 40;
export const NOTE_MAX = 200;

/** What staff typed about a bill: who it is for and anything to remember. Null = nothing. */
export interface BillDetails {
  customerName: string | null;
  note: string | null;
}

/** The name and note a bill (or a share) has now. */
export function detailsOf(s: Pick<SessionDTO, "customerName" | "note">): BillDetails {
  return { customerName: s.customerName ?? null, note: s.note ?? null };
}

/** A name as it is saved: trimmed, runs of spaces and line breaks made into one space. Empty = none. */
export function normaliseName(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

/** A note as it is saved: trimmed, line breaks made into spaces (it is shown on one line). Empty = none. */
export function normaliseNote(text: string): string | null {
  const t = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return t === "" ? null : t;
}

export type DetailsCheck =
  | { ok: true; details: BillDetails; changed: boolean; changes: Partial<BillDetails> }
  | { ok: false; error: string };

/**
 * What the two fields would save, and whether that is different from what the bill has now.
 * Too long is an error (the fields also stop typing at the limit, so this is for pasted text).
 */
export function checkDetails(nameText: string, noteText: string, current: BillDetails): DetailsCheck {
  const customerName = normaliseName(nameText);
  const note = normaliseNote(noteText);
  if (customerName !== null && customerName.length > NAME_MAX) {
    return { ok: false, error: `The name can be up to ${NAME_MAX} characters.` };
  }
  if (note !== null && note.length > NOTE_MAX) {
    return { ok: false, error: `The note can be up to ${NOTE_MAX} characters.` };
  }
  // Only what was changed is sent, so another iPad's edit to the other field isn't undone.
  const changes: Partial<BillDetails> = {};
  if (customerName !== current.customerName) changes.customerName = customerName;
  if (note !== current.note) changes.note = note;
  const changed = "customerName" in changes || "note" in changes;
  return { ok: true, details: { customerName, note }, changed, changes };
}

/** "12 left", or "Over by 3" if text got past the limit. */
export function charsLeft(length: number, max: number): string {
  const left = max - length;
  return left >= 0 ? `${left} left` : `Over by ${-left}`;
}

/** What to tell staff after a save: says what happened to the name and the note. */
export function savedMessage(before: BillDetails, after: BillDetails): string {
  const change = (a: string | null, b: string | null): "set" | "cleared" | null => (a === b ? null : b ? "set" : "cleared");
  const name = change(before.customerName, after.customerName);
  const note = change(before.note, after.note);
  if (name && note) {
    if (name !== note) return "Name and note updated";
    return name === "set" ? "Name and note saved" : "Name and note removed";
  }
  if (name) return name === "set" ? "Name saved" : "Name removed";
  if (note) return note === "set" ? "Note saved" : "Note removed";
  return "Saved";
}
