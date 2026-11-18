import { describe, expect, it } from "vitest";
import {
  adjustmentsSummary,
  appliedWhat,
  billedSubtitle,
  itemsSoldKey,
  billCan,
  billName,
  billOf,
  discountRowLabel,
  discountWhat,
  groupItems,
  discountLockedReason,
  hasParts,
  isEmptyCounterSale,
  lineLabel,
  minus,
  sessionBill,
} from "./bill-view";
import { makeItem, makeSession } from "./session-fixture";
import { cashDueCents } from "@/lib/domain/bill";
import type { BillDiscountDTO, SessionDetailDTO } from "@/lib/domain/types";

const tenPercent: BillDiscountDTO = { discountId: "d1", name: "Staff", kind: "percent", value: 1000, cents: 0, byName: "Ana" };

describe("sessionBill: a stopped table bill", () => {
  it("with no discount or split reads as table time plus items", () => {
    const s = makeSession({ totalCents: 3000, itemsCents: 500, items: [makeItem()] });
    const b = sessionBill(s);
    expect(b).toMatchObject({ tableCents: 2500, itemsCents: 500, discountCents: 0, splitOffCents: 0, totalCents: 3000, estimate: false });
  });

  it("puts the discount back to find table time, and the total stays what the server stored", () => {
    // Table 2500 + items 500 = 3000, 10% off = 300 → stored total 2700.
    const s = makeSession({
      totalCents: 2700,
      itemsCents: 500,
      items: [makeItem()],
      discount: { ...tenPercent, cents: 300 },
    });
    const b = sessionBill(s);
    expect(b).toMatchObject({ tableCents: 2500, itemsCents: 500, discountCents: 300, splitOffCents: 0, totalCents: 2700 });
    expect(b?.discount?.name).toBe("Staff");
  });

  it("shows what was paid separately and leaves this bill's own amount", () => {
    // 3000 split three ways: this bill keeps 1000, parts total 2000.
    const s = makeSession({ totalCents: 1000, itemsCents: 500, items: [makeItem()], splitOffCents: 2000 });
    const b = sessionBill(s);
    expect(b).toMatchObject({ tableCents: 2500, itemsCents: 500, splitOffCents: 2000, totalCents: 1000, discountCents: 0 });
  });

  it("handles discount and split together", () => {
    // 3000 − 300 discount = 2700; 900 split off → 1800.
    const s = makeSession({
      totalCents: 1800,
      itemsCents: 500,
      items: [makeItem()],
      discount: { ...tenPercent, cents: 300 },
      splitOffCents: 900,
    });
    expect(sessionBill(s)).toMatchObject({ tableCents: 2500, discountCents: 300, splitOffCents: 900, totalCents: 1800 });
  });

  it("totals add up: table + items − discount − split = total", () => {
    const s = makeSession({
      totalCents: 1337,
      itemsCents: 700,
      items: [makeItem({ unitCents: 350, quantity: 2 })],
      discount: { ...tenPercent, cents: 250 },
      splitOffCents: 600,
    });
    const b = sessionBill(s);
    expect(b).not.toBeNull();
    if (b) expect(b.tableCents + b.itemsCents - b.discountCents - b.splitOffCents).toBe(b.totalCents);
  });
});

describe("sessionBill: counter sales and parts", () => {
  it("a counter sale has no table time", () => {
    const s = makeSession({
      kind: "counter",
      label: "Counter sale",
      currentTableId: null,
      intervals: [],
      billedMinutes: 0,
      totalCents: 800,
      itemsCents: 800,
      items: [makeItem({ unitCents: 400, quantity: 2 })],
    });
    expect(sessionBill(s)).toMatchObject({ tableCents: 0, itemsCents: 800, totalCents: 800 });
  });

  it("a counter sale with nothing on it is zero, not missing", () => {
    const s = makeSession({ kind: "counter", intervals: [], currentTableId: null, billedMinutes: 0, totalCents: 0, itemsCents: 0 });
    expect(sessionBill(s)).toMatchObject({ tableCents: 0, itemsCents: 0, totalCents: 0, gstCents: 0 });
  });

  it("a part is its one share line and nothing else", () => {
    const s = makeSession({
      kind: "part",
      label: "Table 3 · share",
      splitOfId: "s-0",
      intervals: [],
      currentTableId: null,
      totalCents: 3333,
      itemsCents: 3333,
      items: [makeItem({ kind: "split", productId: null, name: "Table 3 · share", unitCents: 3333 })],
    });
    expect(sessionBill(s)).toMatchObject({ tableCents: 0, itemsCents: 3333, totalCents: 3333 });
  });
});

describe("sessionBill: a running table", () => {
  const running = makeSession({ status: "running", totalCents: null, closedAt: null, billedMinutes: null, currentTableId: "t-1" });

  it("needs the live table figure", () => {
    expect(sessionBill(running)).toBeNull();
    expect(sessionBill(running, { liveTableCents: null })).toBeNull();
  });

  it("uses the live figure and is marked as an estimate", () => {
    const b = sessionBill({ ...running, itemsCents: 500, items: [makeItem()] }, { liveTableCents: 2500 });
    expect(b).toMatchObject({ tableCents: 2500, itemsCents: 500, totalCents: 3000, estimate: true });
  });

  it("works the discount out from the live figures, not the stored 0", () => {
    const s = { ...running, itemsCents: 500, items: [makeItem()], discount: { ...tenPercent, cents: 0 } };
    expect(sessionBill(s, { liveTableCents: 2500 })).toMatchObject({ discountCents: 300, totalCents: 2700, estimate: true });
    // The estimate follows the clock.
    expect(sessionBill(s, { liveTableCents: 5000 })).toMatchObject({ discountCents: 550, totalCents: 4950 });
  });

  it("caps an amount discount at the bill", () => {
    const s = { ...running, discount: { ...tenPercent, kind: "amount" as const, value: 10000, cents: 0 } };
    expect(sessionBill(s, { liveTableCents: 1250 })).toMatchObject({ discountCents: 1250, totalCents: 0 });
  });

  it("cash is worked from the final total, after the discount", () => {
    const s = { ...running, discount: { ...tenPercent, cents: 0 } };
    const b = sessionBill(s, { liveTableCents: 1457 });
    // 10% of 1457 = 145.7 → 146; 1457 − 146 = 1311 → cash 1310.
    expect(b?.totalCents).toBe(1311);
    expect(cashDueCents(b?.totalCents ?? 0)).toBe(1310);
  });
});

describe("billOf", () => {
  const detail = (over: Partial<SessionDetailDTO> = {}): SessionDetailDTO => ({
    session: makeSession(),
    checkouts: [],
    breakdown: null,
    removedItems: [],
    refunds: [],
    audit: [],
    ...over,
  });

  it("uses the stored total once stopped", () => {
    expect(billOf(detail())?.totalCents).toBe(2500);
  });

  it("falls back to the server's table time when there is no stored total", () => {
    const d = detail({
      session: makeSession({ status: "void", totalCents: null }),
      breakdown: { billedMinutes: 30, totalCents: 1250, gstCents: 114, actualMs: 0, lines: [] },
    });
    expect(billOf(d)?.totalCents).toBe(1250);
  });

  it("passes a live figure through for a running session", () => {
    const d = detail({ session: makeSession({ status: "running", totalCents: null }) });
    expect(billOf(d, 1800)).toMatchObject({ totalCents: 1800, estimate: true });
    expect(billOf(d, null)).toBeNull();
  });
});

describe("groupItems", () => {
  it("merges the same product at the same price", () => {
    const g = groupItems([makeItem({ id: "a" }), makeItem({ id: "b" })]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ quantity: 2, cents: 1000 });
  });

  it("keeps different custom charges apart and merges identical ones", () => {
    const custom = (id: string, name: string, unitCents: number) =>
      makeItem({ id, kind: "custom", productId: null, name, unitCents });
    const g = groupItems([custom("a", "Cue hire", 500), custom("b", "Glass", 500), custom("c", "Cue hire", 500)]);
    expect(g.map((x) => [x.name, x.quantity])).toEqual([
      ["Cue hire", 2],
      ["Glass", 1],
    ]);
  });
});

describe("words", () => {
  it("lines read like items, except a part's share", () => {
    expect(lineLabel({ kind: "product", quantity: 2, name: "Chips" })).toBe("2 × Chips");
    expect(lineLabel({ kind: "custom", quantity: 1, name: "Cue hire" })).toBe("1 × Cue hire");
    expect(lineLabel({ kind: "split", quantity: 1, name: "Table 3 · share" })).toBe("Table 3 · share");
  });

  it("describes catalogue discounts", () => {
    expect(discountWhat({ kind: "percent", value: 1000 })).toBe("10% off");
    expect(discountWhat({ kind: "percent", value: 1250 })).toBe("12.5% off");
    expect(discountWhat({ kind: "amount", value: 500 })).toBe("$5.00 off");
    expect(discountWhat({ kind: "variable_percent", value: null })).toBe("Any percent");
    expect(discountWhat({ kind: "variable_amount", value: null })).toBe("Any amount");
  });

  it("labels the discount row on a bill", () => {
    expect(discountRowLabel(tenPercent)).toBe("Discount — Staff (10%)");
    expect(discountRowLabel({ name: "Mates", kind: "amount", value: 500 })).toBe("Discount — Mates");
    expect(appliedWhat(tenPercent)).toBe("10%");
    expect(appliedWhat({ kind: "amount", value: 500 })).toBe("$5.00");
  });

  it("writes money off with a real minus sign", () => {
    expect(minus(250)).toBe("−$2.50");
  });

  it("summarises discount and split for small spaces", () => {
    expect(adjustmentsSummary({ discountCents: 0, splitOffCents: 0, estimate: false })).toBeNull();
    expect(adjustmentsSummary({ discountCents: 250, splitOffCents: 0, estimate: false })).toBe("Discount −$2.50");
    expect(adjustmentsSummary({ discountCents: 250, splitOffCents: 0, estimate: true })).toBe("Discount −$2.50 est.");
    expect(adjustmentsSummary({ discountCents: 0, splitOffCents: 2000, estimate: false })).toBe("−$20.00 paid separately");
    expect(adjustmentsSummary({ discountCents: 250, splitOffCents: 2000, estimate: false })).toBe(
      "Discount −$2.50 · −$20.00 paid separately",
    );
  });

  it("names a bill: tables for a table's bill, the label for the rest", () => {
    expect(billName(makeSession())).toBe("Table 1");
    expect(billName(makeSession({ kind: "counter", label: "Counter sale", intervals: [] }))).toBe("Counter sale");
    expect(billName(makeSession({ kind: "part", label: "Table 3 · share", intervals: [] }))).toBe("Table 3 · share");
    expect(billName(makeSession({ intervals: [], label: "Table 7" }))).toBe("Table 7");
  });
});

describe("billCan: what each kind of bill can do", () => {
  const table = makeSession({ status: "running" });
  const counter = makeSession({ kind: "counter", status: "awaiting_payment" });
  const part = makeSession({ kind: "part", status: "awaiting_payment" });

  it("a table can do what the state machine allows", () => {
    expect(billCan(table, "pause")).toBe(true);
    expect(billCan(table, "stop")).toBe(true);
    expect(billCan(table, "transfer")).toBe(true);
    expect(billCan(table, "edit_times")).toBe(true);
    expect(billCan(table, "add_item")).toBe(true);
    expect(billCan(table, "set_discount")).toBe(true);
    expect(billCan(table, "split")).toBe(false); // still running
    expect(billCan(table, "merge_back")).toBe(false);
    expect(billCan(table, "discard")).toBe(false);
  });

  it("a counter sale has no timer but takes items, a discount and a split", () => {
    for (const a of ["pause", "resume", "stop", "transfer", "edit_times", "release_table"] as const) {
      expect(billCan(counter, a), a).toBe(false);
    }
    for (const a of ["add_item", "remove_item", "set_discount", "remove_discount", "split", "discard", "charge_card"] as const) {
      expect(billCan(counter, a), a).toBe(true);
    }
    expect(billCan(counter, "merge_back")).toBe(false);
  });

  it("a part can be paid and merged back, and nothing else is changed on it", () => {
    for (const a of ["add_item", "remove_item", "set_discount", "remove_discount", "split", "edit_times", "transfer", "discard"] as const) {
      expect(billCan(part, a), a).toBe(false);
    }
    expect(billCan(part, "merge_back")).toBe(true);
    expect(billCan(part, "charge_card")).toBe(true);
    expect(billCan(part, "mark_paid")).toBe(true);
    expect(billCan(part, "void")).toBe(true);
  });

  it("a split bill is flagged so its discount can be locked", () => {
    expect(hasParts(makeSession())).toBe(false);
    expect(hasParts(makeSession({ splitOffCents: 500 }))).toBe(true);
    expect(hasParts(makeSession({ parts: [{ id: "p", amountCents: 500, status: "awaiting_payment", onTerminal: false }] }))).toBe(true);
  });

  it("only an empty counter sale with no card or cash started is thrown away", () => {
    expect(isEmptyCounterSale(counter)).toBe(true);
    expect(isEmptyCounterSale({ ...counter, itemsCents: 100 })).toBe(false);
    expect(isEmptyCounterSale(makeSession({ itemsCents: 0 }))).toBe(false); // a table's bill
    expect(isEmptyCounterSale({ ...counter, status: "paid" })).toBe(false);
    expect(
      isEmptyCounterSale({
        ...counter,
        checkout: { id: "c", attempt: 1, amountCents: 0, status: "CANCELED", cancelReason: null, createdAt: "", updatedAt: "" },
      }),
    ).toBe(false);
  });
});

describe("the day's Billed line", () => {
  it("is just GST included when there are no items or discounts", () => {
    expect(billedSubtitle({ tableCents: 5000, itemsCents: 0, discountCents: 0 })).toBe("GST included");
  });

  it("shows items, and discounts when there are any", () => {
    expect(billedSubtitle({ tableCents: 5000, itemsCents: 1200, discountCents: 0 })).toBe("Table $50.00 · Items $12.00 · GST included");
    expect(billedSubtitle({ tableCents: 5000, itemsCents: 1200, discountCents: 620 })).toBe(
      "Table $50.00 · Items $12.00 · Discounts −$6.20 · GST included",
    );
  });

  it("shows a discount even when there were no items", () => {
    expect(billedSubtitle({ tableCents: 5000, itemsCents: 0, discountCents: 500 })).toBe(
      "Table $50.00 · Items $0.00 · Discounts −$5.00 · GST included",
    );
  });
});

describe("items sold keys", () => {
  it("custom charges are keyed by name, products by id", () => {
    expect(itemsSoldKey({ productId: "p1", name: "Chips" })).toBe("p1");
    expect(itemsSoldKey({ productId: null, name: "Cue hire" })).toBe("custom:Cue hire");
    expect(itemsSoldKey({ productId: null, name: "Cue hire" })).not.toBe(itemsSoldKey({ productId: null, name: "Glass" }));
  });
});

describe("the day's Billed line with shares written off", () => {
  it("shows what a manager wrote off, so the parts add up to Billed", () => {
    expect(billedSubtitle({ tableCents: 5000, itemsCents: 1200, discountCents: 620, writtenOffCents: 1000 })).toBe(
      "Table $50.00 · Items $12.00 · Discounts −$6.20 · Written off −$10.00 · GST included",
    );
    expect(billedSubtitle({ tableCents: 5000, itemsCents: 0, discountCents: 0, writtenOffCents: 1000 })).toBe(
      "Table $50.00 · Items $0.00 · Written off −$10.00 · GST included",
    );
  });

  it("says nothing about it when there is none", () => {
    expect(billedSubtitle({ tableCents: 5000, itemsCents: 0, discountCents: 0, writtenOffCents: 0 })).toBe("GST included");
    expect(billedSubtitle({ tableCents: 5000, itemsCents: 1200, discountCents: 0 })).toBe("Table $50.00 · Items $12.00 · GST included");
  });
});

describe("discountLockedReason", () => {
  const part = (status: "awaiting_payment" | "paid" | "void") => ({ id: "p", amountCents: 500, status, onTerminal: false });

  it("a bill with no parts can change its discount", () => {
    expect(discountLockedReason(makeSession())).toBeNull();
  });

  it("unpaid parts: merge them back first", () => {
    const reason = discountLockedReason(makeSession({ splitOffCents: 1000, parts: [part("awaiting_payment"), part("awaiting_payment")] }));
    expect(reason).toBe("This bill has been split, so its discount can't change. Merge the parts back first.");
  });

  it("a paid or written-off share can't be merged back, so it doesn't say to", () => {
    const text = "A share of this bill has already been paid or written off, so its discount can't be changed.";
    expect(discountLockedReason(makeSession({ splitOffCents: 1000, parts: [part("awaiting_payment"), part("paid")] }))).toBe(text);
    expect(discountLockedReason(makeSession({ splitOffCents: 1000, parts: [part("void")] }))).toBe(text);
  });
});
