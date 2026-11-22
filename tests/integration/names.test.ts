import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { squareTimeout } from "./helpers/fake-gateway";
import { at, audits, awaitingPayment, getSession, seedProduct } from "./helpers/util";
import { TransitionError } from "@/lib/domain/machine";
import { startCashHandoff } from "@/lib/server/pos-cash";
import { getFloor, getSessionDetail, getSummary, getUnpaid } from "@/lib/server/queries";
import {
  addCustomItem,
  addItem,
  chargeCard,
  discardCounterSale,
  markPaid,
  openCounterSale,
  pauseSession,
  resumeSession,
  setDetails,
  splitBill,
  startSession,
  stopSession,
  transferSession,
  voidSession,
} from "@/lib/server/sessions";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  await seedProduct(h, { id: "VAR_COKE", name: "Coke", priceCents: 450 });
});

const DAY = "2026-11-20"; // T0 is 10:00 Sydney on this business day
const PREFIX = "square-commerce-v1://payment/create?data=";
const linkNotes = (url: string) => (JSON.parse(decodeURIComponent(url.slice(PREFIX.length))) as { notes: string }).notes;

const start = (table = "Table 1", who: { customerName?: string | null; note?: string | null } = {}) =>
  startSession(h.staff.actor, h.tableId(table), at(0), who).then((r) => r.sessionId);
const set = (id: string, customerName: string | null, note: string | null = null) =>
  setDetails(h.staff.actor, id, { customerName, note });
const stored = async (id: string) => {
  const s = await getSession(h, id);
  return { name: s.customer_name, note: s.note };
};
const detailAudits = (id: string) => audits(h, id, "session.details");
const rejects400 = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ status: 400 });

describe("cleaning what staff typed", () => {
  it("trims, collapses runs of whitespace and line breaks to one space", async () => {
    const id = await start("Table 1", { customerName: "  Sam \t\n  Smith  ", note: "  birthday\r\n party   booked " });
    expect(await stored(id)).toEqual({ name: "Sam Smith", note: "birthday party booked" });
    await set(id, "  Pat  Jones \n", "x\u0007y");
    expect(await stored(id)).toEqual({ name: "Pat Jones", note: "x y" });
  });

  it("whitespace-only or control-characters-only is nothing at all (null), not an empty string", async () => {
    const id = await start("Table 1", { customerName: "   ", note: "\n\t" });
    expect(await stored(id)).toEqual({ name: null, note: null });
    await set(id, "Sam", "n");
    await set(id, " \u0001 ", "\u0000");
    expect(await stored(id)).toEqual({ name: null, note: null });
  });

  it("a name that only fits once its inner whitespace is collapsed is accepted", async () => {
    const id = await start();
    await set(id, `a${" ".repeat(60)}b`);
    expect((await stored(id)).name).toBe("a b");
  });
});

describe("limits: 40 for a name, 200 for a note, refused and never cut", () => {
  it("exactly 40 / 200 is kept whole; ends that are only spaces don't count", async () => {
    const name = "n".repeat(40);
    const note = "m".repeat(200);
    const id = await start("Table 1", { customerName: ` ${name} `, note: ` ${note} ` });
    expect(await stored(id)).toEqual({ name, note });
  });

  it("41 / 201 on start is a 400 and nothing is written: no bill, the table stays free", async () => {
    await rejects400(startSession(h.staff.actor, h.tableId("Table 1"), at(0), { customerName: "n".repeat(41) }));
    await rejects400(startSession(h.staff.actor, h.tableId("Table 1"), at(0), { note: "m".repeat(201) }));
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from public.sessions`;
    expect(n).toBe(0);
    const [{ a }] = await h.sql<{ a: number }[]>`select count(*)::int as a from public.audit_log where action = 'session.start'`;
    expect(a).toBe(0);
    await expect(start()).resolves.toBeTruthy();
  });

  it("41 / 201 on setDetails is a 400 and leaves what was there, with no audit row", async () => {
    const id = await start("Table 1", { customerName: "Sam", note: "keep" });
    await rejects400(set(id, "n".repeat(41), "keep"));
    await rejects400(set(id, "Sam", "m".repeat(201)));
    expect(await stored(id)).toEqual({ name: "Sam", note: "keep" });
    expect(await detailAudits(id)).toHaveLength(0);
  });
});

describe("setDetails", () => {
  it("sets, changes and clears; null and an empty string both clear; each change is one audit row with before and after", async () => {
    const { actor } = h.staff;
    const id = await start();
    await set(id, "Sam", "first");
    expect(await stored(id)).toEqual({ name: "Sam", note: "first" });

    await set(id, "Pat", "first"); // only the name changes
    await set(id, "", "first"); // "" clears the name
    expect(await stored(id)).toEqual({ name: null, note: "first" });
    await set(id, "Pat", null); // null clears the note
    expect(await stored(id)).toEqual({ name: "Pat", note: null });
    await set(id, null, "");
    expect(await stored(id)).toEqual({ name: null, note: null });

    const rows = await detailAudits(id);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ actor_staff_id: actor.staffId, entity: "session", before: { customer_name: null, note: null }, after: { customer_name: "Sam", note: "first" } });
    expect(rows[2]).toMatchObject({ before: { customer_name: "Pat", note: "first" }, after: { customer_name: null, note: "first" } });
    expect(rows[4]).toMatchObject({ before: { customer_name: "Pat", note: null }, after: { customer_name: null, note: null } });
  });

  it("saving unchanged values (even if typed differently) writes nothing: no audit row, updated_at doesn't move", async () => {
    const id = await start("Table 1", { customerName: "Sam Smith", note: "hello" });
    const stamp = async (sid: string) => (await h.sql<{ updated_at: Date }[]>`select updated_at from public.sessions where id = ${sid}`)[0].updated_at;
    const before = await stamp(id);
    await set(id, "Sam Smith", "hello");
    await set(id, "  Sam   Smith ", " hello\n");
    const nothing = await start("Table 2");
    const n0 = await stamp(nothing);
    await set(nothing, "", "  ");
    await set(nothing, null, null);
    expect(await detailAudits(id)).toHaveLength(0);
    expect(await detailAudits(nothing)).toHaveLength(0);
    expect(await stamp(id)).toEqual(before);
    expect(await stamp(nothing)).toEqual(n0);
  });

  it("an unknown bill is a 404", async () => {
    await expect(set("00000000-0000-4000-8000-0000000000ff", "x")).rejects.toMatchObject({ status: 404 });
  });

  it("a field left out is left as it is; only what is sent changes", async () => {
    const id = await start("Table 1", { customerName: "Sam", note: "keep me" });
    await setDetails(h.staff.actor, id, { customerName: "Pat" });
    expect(await stored(id)).toEqual({ name: "Pat", note: "keep me" });
    await setDetails(h.staff.actor, id, { note: "new note" });
    expect(await stored(id)).toEqual({ name: "Pat", note: "new note" });
    await setDetails(h.staff.actor, id, { note: null });
    expect(await stored(id)).toEqual({ name: "Pat", note: null });
    await setDetails(h.staff.actor, id, { customerName: "" });
    expect(await stored(id)).toEqual({ name: null, note: null });

    await setDetails(h.staff.actor, id, {}); // nothing sent: nothing written
    const before = (await detailAudits(id)).length;
    await setDetails(h.staff.actor, id, { customerName: undefined, note: undefined });
    expect(await detailAudits(id)).toHaveLength(before);
    // a refused value in one field changes neither
    await setDetails(h.staff.actor, id, { customerName: "Sam", note: "n" });
    await rejects400(setDetails(h.staff.actor, id, { note: "m".repeat(201) }));
    await rejects400(setDetails(h.staff.actor, id, { customerName: "n".repeat(41), note: "other" }));
    expect(await stored(id)).toEqual({ name: "Sam", note: "n" });
  });

  it("two iPads changing different fields don't undo each other", async () => {
    const id = await start("Table 1", { customerName: "Sam", note: "n1" });
    await Promise.all([setDetails(h.staff.actor, id, { customerName: "Pat" }), setDetails(h.staff.actor, id, { note: "n2" })]);
    expect(await stored(id)).toEqual({ name: "Pat", note: "n2" });
  });

  it("a new name on a totalled bill skips a checkout attempt (a note alone, or a running bill, does not)", async () => {
    const id = await start();
    await set(id, "Running"); // running: nothing to skip
    expect((await getSession(h, id)).checkout_attempt).toBe(0);
    await pauseSession(h.staff.actor, id, at(10));
    await resumeSession(h.staff.actor, id, at(11));
    await stopSession(h.staff.actor, id, at(60));
    await setDetails(h.staff.actor, id, { note: "just a note" });
    expect((await getSession(h, id)).checkout_attempt).toBe(0);
    await setDetails(h.staff.actor, id, { customerName: "Renamed" });
    expect((await getSession(h, id)).checkout_attempt).toBe(1);
    await setDetails(h.staff.actor, id, { customerName: "Renamed" }); // unchanged
    expect((await getSession(h, id)).checkout_attempt).toBe(1);
    await setDetails(h.staff.actor, id, { customerName: null });
    expect((await getSession(h, id)).checkout_attempt).toBe(2);
  });

  it("renaming after a card request timed out doesn't make the retry collide with the request Square may already hold", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await set(id, "First name");
    h.gateway.createError = squareTimeout();
    h.gateway.failAfterCreating = true; // Square carried it out, then the answer was lost
    await expect(chargeCard(h.staff.actor, id)).rejects.toBeTruthy();
    h.gateway.failAfterCreating = false;
    await set(id, "Second name");
    const retry = await chargeCard(h.staff.actor, id);
    expect(retry.kind).toBe("sent");
    const [sent] = await audits(h, id, "checkout.sent");
    expect((sent.after as { note: string }).note.startsWith("Second name · ")).toBe(true);
  });

  it("is allowed while running, paused and awaiting payment, and never changes what is owed", async () => {
    const id = await start();
    await set(id, "Running");
    await pauseSession(h.staff.actor, id, at(10));
    await set(id, "Paused");
    await resumeSession(h.staff.actor, id, at(20));
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    await stopSession(h.staff.actor, id, at(60));
    const owed = await getSession(h, id);
    await set(id, "Awaiting", "note");
    const after = await getSession(h, id);
    expect(after).toMatchObject({ status: "awaiting_payment", customer_name: "Awaiting", note: "note" });
    expect(after.total_cents).toBe(owed.total_cents);
    expect(after.items_cents).toBe(owed.items_cents);
  });

  it("is refused (409, nothing changes) once the bill is paid or void", async () => {
    const paid = await awaitingPayment(h, "Table 1", 60);
    await set(paid, "Before");
    await markPaid(h.staff.actor, paid, "cash", { cardConfirmed: false }, at(61));
    await expect(set(paid, "After", "x")).rejects.toBeInstanceOf(TransitionError);
    expect((await stored(paid)).name).toBe("Before");

    const voided = await awaitingPayment(h, "Table 2", 60);
    await set(voided, "Before");
    await voidSession(h.staff.actor, h.staff.manager, voided, "Mistake", at(62));
    await expect(set(voided, null, null)).rejects.toBeInstanceOf(TransitionError);
    expect((await stored(voided)).name).toBe("Before");

    const running = await start("Table 3");
    await voidSession(h.staff.actor, h.staff.manager, running, "Mistake", at(62));
    await expect(set(running, "x")).rejects.toBeInstanceOf(TransitionError);
    expect(await detailAudits(paid)).toHaveLength(1);
  });

  it("works on a counter sale", async () => {
    const { sessionId } = await openCounterSale(h.staff.actor, at(5));
    await set(sessionId, "Walk-in Wendy", "pays cash");
    const { session } = await getSessionDetail(sessionId);
    expect(session).toMatchObject({ kind: "counter", customerName: "Walk-in Wendy", note: "pays cash" });
  });

  it("works on a share of a split bill, and the parent's parts list shows it", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    const { partIds } = await splitBill(h.staff.actor, id, { ways: 2 }, at(61));
    await set(id, "Whole table");
    await set(partIds[0], "Dana", "owes half");
    const part = (await getSessionDetail(partIds[0])).session;
    expect(part).toMatchObject({ kind: "part", customerName: "Dana" });
    const parent = (await getUnpaid()).sessions.find((s) => s.id === id);
    expect(parent?.customerName).toBe("Whole table");
    expect(parent?.parts).toEqual([expect.objectContaining({ id: partIds[0], customerName: "Dana" })]);
    // the share's money is untouched
    expect(part.totalCents).toBe(1250);
    await markPaid(h.staff.actor, partIds[0], "cash", { cardConfirmed: false }, at(62));
    await expect(set(partIds[0], "Late")).rejects.toBeInstanceOf(TransitionError);
  });

  it("is allowed with a card request live on the Terminal, and the request already sent keeps the name it went with", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await set(id, "Before");
    const out = await chargeCard(h.staff.actor, id);
    expect(out.kind).toBe("sent");
    await set(id, "After");
    expect((await getSession(h, id)).customer_name).toBe("After");
    const [sent] = await audits(h, id, "checkout.sent");
    expect((sent.after as { note: string }).note.startsWith("Before · ")).toBe(true);
  });
});

describe("the name travels with the bill", () => {
  it("survives a transfer (running and paused) and shows on the floor", async () => {
    const id = await start("Table 1", { customerName: "Sam" });
    await transferSession(h.staff.actor, id, h.tableId("Table 2"), at(10));
    let f = await getFloor();
    expect(f.sessions.find((s) => s.id === id)).toMatchObject({ customerName: "Sam", currentTableId: h.tableId("Table 2") });
    await pauseSession(h.staff.actor, id, at(20));
    await transferSession(h.staff.actor, id, h.tableId("Table 3"), at(25));
    f = await getFloor();
    expect(f.sessions.find((s) => s.id === id)).toMatchObject({ customerName: "Sam", currentTableId: h.tableId("Table 3") });
    expect(await stored(id)).toEqual({ name: "Sam", note: null });
  });

  it("every summary list carries the name and note of the right bill, and null for an unnamed one", async () => {
    const { actor, manager } = h.staff;
    const paid = await start("Table 1", { customerName: "Paid Pat", note: "paid note" });
    await stopSession(actor, paid, at(60));
    await markPaid(actor, paid, "cash", { cardConfirmed: false }, at(61));

    const unpaid = await start("Table 2", { customerName: "Unpaid Una", note: "unpaid note" });
    await stopSession(actor, unpaid, at(60));

    const voided = await start("Table 3", { customerName: "Void Vic", note: "void note" });
    await stopSession(actor, voided, at(60));
    await voidSession(actor, manager, voided, "Wrong table", at(62));

    const plain = await awaitingPayment(h, "Table 4", 60);
    await markPaid(actor, plain, "cash", { cardConfirmed: false }, at(61));
    const plainUnpaid = await awaitingPayment(h, "Table 5", 60);

    const s = await getSummary(DAY);
    const p = s.paidItems.find((r) => r.id === paid);
    expect(p).toMatchObject({ customerName: "Paid Pat", note: "paid note", tableNames: "Table 1" });
    expect(s.paidItems.find((r) => r.id === plain)).toMatchObject({ customerName: null, note: null });
    expect(s.unpaid.items.find((r) => r.id === unpaid)).toMatchObject({ customerName: "Unpaid Una", note: "unpaid note", tableNames: "Table 2" });
    expect(s.unpaid.items.find((r) => r.id === plainUnpaid)).toMatchObject({ customerName: null, note: null });
    expect(s.voids.items.find((r) => r.id === voided)).toMatchObject({ customerName: "Void Vic", note: "void note", tableNames: "Table 3" });
    // no row picked up someone else's name
    const names = [...s.paidItems, ...s.unpaid.items, ...s.voids.items].map((r) => r.customerName).sort();
    expect(names).toEqual([null, null, "Paid Pat", "Unpaid Una", "Void Vic"].sort());
  });

  it("a name added after the bill was stopped shows on the unpaid summary row", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await set(id, "Late Lou", "added later");
    const row = (await getSummary(DAY)).unpaid.items.find((r) => r.id === id);
    expect(row).toMatchObject({ customerName: "Late Lou", note: "added later" });
    expect((await getUnpaid()).sessions[0]).toMatchObject({ id, customerName: "Late Lou" });
  });
});

describe("the name leads the Square note", () => {
  const cashNote = async (id: string) => {
    const [r] = await h.sql<{ note: string }[]>`select note from public.square_cash_records where session_id = ${id} order by seq desc limit 1`;
    return r.note;
  };

  it("cash record: `<name> · <the note without a name>`; an unnamed bill's note is unchanged", async () => {
    const plain = await awaitingPayment(h, "Table 1", 60);
    await markPaid(h.staff.actor, plain, "cash", { cardConfirmed: false }, at(61));
    const base = await cashNote(plain);
    expect(base.startsWith("Table 1")).toBe(true);

    const named = await awaitingPayment(h, "Table 2", 60);
    await set(named, "Sam Smith", "a long free-text note that must not leak into Square");
    await markPaid(h.staff.actor, named, "cash", { cardConfirmed: false }, at(61));
    expect(await cashNote(named)).toBe(`Sam Smith · ${base.replace("Table 1", "Table 2")}`);
  });

  it("card request on the Terminal and the order line", async () => {
    const plain = await awaitingPayment(h, "Table 1", 60);
    const base = (await chargeCard(h.staff.actor, plain), (await audits(h, plain, "checkout.sent"))[0].after as { note: string }).note;

    const named = await awaitingPayment(h, "Table 2", 60);
    await set(named, "Sam Smith");
    await chargeCard(h.staff.actor, named);
    const note = ((await audits(h, named, "checkout.sent"))[0].after as { note: string }).note;
    expect(note).toBe(`Sam Smith · ${base.replace("Table 1", "Table 2")}`);
    const tableLine = h.gateway.orders.at(-1)?.lines.find((l) => l.uid === "table");
    expect(tableLine?.note).toBe(note);
  });

  it("counter sale: `<name> · Counter sale · 10:05`, and the Square POS hand-off link", async () => {
    const { sessionId: id } = await openCounterSale(h.staff.actor, at(5));
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    await set(id, "Wendy");
    const out = await startCashHandoff(h.staff.actor, id);
    expect(linkNotes(out.url)).toBe(`Wendy · Counter sale · 10:05 · ref ${id.slice(0, 8)}`);
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(6));
    expect(await cashNote(id)).toBe("Wendy · Counter sale · 10:05");
  });

  it("a share of a split bill carries its own name, not the parent's", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await set(id, "Parent");
    const { partIds } = await splitBill(h.staff.actor, id, { ways: 2 }, at(61));
    await set(partIds[0], "Dana");
    await markPaid(h.staff.actor, partIds[0], "cash", { cardConfirmed: false }, at(62));
    const note = await cashNote(partIds[0]);
    expect(note.startsWith("Dana · ")).toBe(true);
    expect(note).not.toContain("Parent");
  });

  it("the name is not a custom charge or an item: the bill's amounts are identical with and without", async () => {
    const a = await awaitingPayment(h, "Table 1", 60);
    await addCustomItem(h.staff.actor, a, "Chalk", 250);
    const b = await awaitingPayment(h, "Table 2", 60);
    await addCustomItem(h.staff.actor, b, "Chalk", 250);
    await set(b, "Someone");
    const [x, y] = [await getSession(h, a), await getSession(h, b)];
    expect([y.total_cents, y.items_cents, y.billed_minutes]).toEqual([x.total_cents, x.items_cents, x.billed_minutes]);
  });
});

describe("a discarded counter sale and the name", () => {
  it("a named but empty counter sale can still be discarded by staff", async () => {
    const { sessionId } = await openCounterSale(h.staff.actor, at(5));
    await set(sessionId, "Oops");
    await discardCounterSale(h.staff.actor, sessionId, at(6));
    expect((await getSession(h, sessionId)).status).toBe("void");
  });
});

describe("the database backs the rules up", () => {
  it("refuses a blank, whitespace-only or over-long name even if the app didn't", async () => {
    const id = await start();
    for (const bad of ["", "   ", "n".repeat(41)]) {
      await expect(h.sql`update public.sessions set customer_name = ${bad} where id = ${id}`).rejects.toMatchObject({ code: "23514" });
    }
    await h.sql`update public.sessions set customer_name = ${"n".repeat(40)} where id = ${id}`;
    await h.sql`update public.sessions set customer_name = null where id = ${id}`;
  });
});
