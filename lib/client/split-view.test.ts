import { describe, expect, it } from "vitest";
import { canOfferSplit, evenSplit, inSplit, nextUnpaidBill, partIsOpen, partStatus, takeOut, WAYS } from "./split-view";
import { makeSession } from "./session-fixture";
import type { CheckoutDTO, PartDTO, SessionDTO } from "@/lib/domain/types";

const checkout = (status: CheckoutDTO["status"]): CheckoutDTO => ({
  id: "c1",
  attempt: 1,
  amountCents: 1000,
  status,
  cancelReason: null,
  createdAt: "",
  updatedAt: "",
});

describe("evenSplit", () => {
  it("ways 2 to 10", () => {
    expect(WAYS).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("splits what divides evenly", () => {
    expect(evenSplit(9000, 3)).toEqual({ shareCents: 3000, keepsCents: 3000, oddCents: 0 });
    expect(evenSplit(5000, 2)).toEqual({ shareCents: 2500, keepsCents: 2500, oddCents: 0 });
  });

  it("this bill keeps the odd cents", () => {
    // $100.00 three ways: parts of $33.33, this bill keeps $33.34.
    expect(evenSplit(10000, 3)).toEqual({ shareCents: 3333, keepsCents: 3334, oddCents: 1 });
    // $50.00 seven ways: floor(5000/7) = 714; 6 parts = 4284; keeps 716.
    expect(evenSplit(5000, 7)).toEqual({ shareCents: 714, keepsCents: 716, oddCents: 2 });
  });

  it("parts plus what is kept always add back to the total", () => {
    for (let total = 1; total <= 400; total++) {
      for (const ways of WAYS) {
        const r = evenSplit(total, ways);
        if (!r) continue;
        expect(r.shareCents * (ways - 1) + r.keepsCents).toBe(total);
        expect(r.keepsCents).toBeGreaterThanOrEqual(r.shareCents);
        expect(r.oddCents).toBeLessThan(ways);
      }
    }
  });

  it("refuses what the server would", () => {
    expect(evenSplit(1000, 1)).toBeNull();
    expect(evenSplit(1000, 11)).toBeNull();
    expect(evenSplit(1000, 2.5)).toBeNull();
    expect(evenSplit(0, 3)).toBeNull();
    expect(evenSplit(-100, 3)).toBeNull();
    // A share would come to nothing.
    expect(evenSplit(5, 10)).toBeNull();
    expect(evenSplit(10, 10)).toEqual({ shareCents: 1, keepsCents: 1, oddCents: 0 });
  });
});

describe("takeOut", () => {
  it("leaves the rest on the bill", () => {
    expect(takeOut(9000, 3000)).toEqual({ keepsCents: 6000 });
    expect(takeOut(9000, 1)).toEqual({ keepsCents: 8999 });
    expect(takeOut(9000, 8999)).toEqual({ keepsCents: 1 });
  });

  it("is less than the total and more than nothing", () => {
    expect(takeOut(9000, 9000)).toBeNull();
    expect(takeOut(9000, 9001)).toBeNull();
    expect(takeOut(9000, 0)).toBeNull();
    expect(takeOut(9000, -5)).toBeNull();
    expect(takeOut(9000, 10.5)).toBeNull();
  });
});

describe("canOfferSplit", () => {
  const counter = (over: Partial<SessionDTO> = {}) =>
    makeSession({ kind: "counter", intervals: [], currentTableId: null, totalCents: 1500, ...over });

  it("offers it on an unpaid table bill or counter sale with something to pay", () => {
    expect(canOfferSplit(makeSession())).toBe(true);
    expect(canOfferSplit(counter())).toBe(true);
  });

  it("not on a part, a paid bill, a running table, or nothing to pay", () => {
    expect(canOfferSplit(makeSession({ kind: "part", splitOfId: "x" }))).toBe(false);
    expect(canOfferSplit(makeSession({ status: "paid" }))).toBe(false);
    expect(canOfferSplit(makeSession({ status: "running", totalCents: null }))).toBe(false);
    expect(canOfferSplit(counter({ totalCents: 0 }))).toBe(false);
  });

  it("not while a card request is live, but fine after one was cancelled", () => {
    expect(canOfferSplit(makeSession({ checkout: checkout("IN_PROGRESS") }))).toBe(false);
    expect(canOfferSplit(makeSession({ checkout: checkout("PENDING") }))).toBe(false);
    expect(canOfferSplit(makeSession({ checkout: checkout("CANCEL_REQUESTED") }))).toBe(false);
    expect(canOfferSplit(makeSession({ checkout: checkout("CANCELED") }))).toBe(true);
  });
});

describe("partStatus", () => {
  const part = (over: Partial<PartDTO> = {}): PartDTO => ({ id: "p", amountCents: 1000, customerName: null, status: "awaiting_payment", onTerminal: false, ...over });

  it("paid and void are plain", () => {
    expect(partStatus(part({ status: "paid" }))).toEqual({ label: "Paid", tone: "ok" });
    expect(partStatus(part({ status: "void" }))).toEqual({ label: "Void", tone: "muted" });
  });

  it("unpaid reads Unpaid, or On the Terminal when a card request is live", () => {
    expect(partStatus(part()).label).toBe("Unpaid");
    expect(partStatus(part({ onTerminal: true })).label).toBe("On the Terminal");
  });

  it("only an unpaid part off the Terminal can be opened to pay or merged back", () => {
    expect(partIsOpen(part())).toBe(true);
    expect(partIsOpen(part({ onTerminal: true }))).toBe(false);
    expect(partIsOpen(part({ status: "paid" }))).toBe(false);
    expect(partIsOpen(part({ status: "void" }))).toBe(false);
  });
});

describe("nextUnpaidBill: three mates, two by card, one in cash", () => {
  const p = (id: string, over: Partial<PartDTO> = {}): PartDTO => ({ id, amountCents: 3000, customerName: null, status: "awaiting_payment", onTerminal: false, ...over });
  const root = (parts: PartDTO[], over: Partial<SessionDTO> = {}) =>
    makeSession({ id: "root", label: "Table 3", totalCents: 3000, splitOffCents: 6000, parts, ...over });
  const partBill = (id: string) =>
    makeSession({ id, kind: "part", label: "Table 3 · share", splitOfId: "root", totalCents: 3000, intervals: [], currentTableId: null });

  it("from the bill: the oldest unpaid part", () => {
    const r = root([p("a"), p("b")], { status: "paid" });
    expect(nextUnpaidBill(r, r)).toEqual({ id: "a", kind: "part", label: "Table 3 · share", amountCents: 3000 });
  });

  it("then the next one, once the first is paid", () => {
    const r = root([p("a", { status: "paid" }), p("b")], { status: "paid" });
    expect(nextUnpaidBill(partBill("a"), r)).toEqual({ id: "b", kind: "part", label: "Table 3 · share", amountCents: 3000 });
  });

  it("nothing is left after the last", () => {
    const r = root([p("a", { status: "paid" }), p("b", { status: "paid" })], { status: "paid" });
    expect(nextUnpaidBill(partBill("b"), r)).toBeNull();
    expect(nextUnpaidBill(r, r)).toBeNull();
    expect(nextUnpaidBill(partBill("b"), null)).toBeNull();
  });

  it("from a part opened first: other parts come before the original bill", () => {
    const r = root([p("a"), p("b")]);
    expect(nextUnpaidBill(partBill("a"), r)?.id).toBe("b");
    const r2 = root([p("a"), p("b", { status: "paid" })]);
    expect(nextUnpaidBill(partBill("a"), r2)).toEqual({ id: "root", kind: "table", label: "Table 3", amountCents: 3000 });
  });

  it("skips the bill being paid, parts on the Terminal, written-off parts, and a root on the Terminal", () => {
    expect(nextUnpaidBill(partBill("a"), root([p("a"), p("b", { onTerminal: true })], { status: "paid" }))).toBeNull();
    expect(nextUnpaidBill(partBill("a"), root([p("a"), p("b", { status: "void" })], { status: "paid" }))).toBeNull();
    expect(nextUnpaidBill(partBill("a"), root([p("a")], { checkout: checkout("IN_PROGRESS") }))).toBeNull();
  });
});

describe("inSplit", () => {
  it("is true for a part and for a bill that has parts", () => {
    expect(inSplit(makeSession())).toBe(false);
    expect(inSplit(makeSession({ kind: "part", splitOfId: "x" }))).toBe(true);
    expect(inSplit(makeSession({ splitOffCents: 100 }))).toBe(true);
    expect(inSplit(makeSession({ parts: [{ id: "p", amountCents: 1, customerName: null, status: "void", onTerminal: false }] }))).toBe(true);
  });
});
