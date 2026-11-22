import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Square } from "square";
import { bootHarness, type Harness } from "./helpers/harness";
import { at, audits, awaitingPayment, getItems, seedDiscount, seedProduct } from "./helpers/util";
import { getAdminState } from "@/lib/server/admin";
import { getProfitReport, setCosts } from "@/lib/server/costs";
import { syncProducts } from "@/lib/server/items";
import { getFloor, getSessionDetail, getSummary, getUnpaid } from "@/lib/server/queries";
import {
  addCustomItem,
  addItem,
  markPaid,
  openCounterSale,
  removeItem,
  setDiscount,
  splitBill,
  startSession,
  stopSession,
  voidSession,
} from "@/lib/server/sessions";
import type { ProfitReportDTO } from "@/lib/domain/types";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  await seedProduct(h, { id: "BEER", name: "Beer", priceCents: 1100 }); // taxed, GST 100
  await seedProduct(h, { id: "COKE", name: "Coke", priceCents: 450 });
  await seedProduct(h, { id: "WATER", name: "Water", priceCents: 300, taxed: false });
  await seedProduct(h, { id: "SMALL", name: "Small", priceCents: 150 });
});
afterEach(() => {
  vi.useRealTimers();
});

const DAY = "2026-11-20"; // T0 = 10:00 Sydney on this business day (06:00 -> 06:00, UTC+11)
const A = () => h.staff.actor;
const syd = (iso: string) => new Date(`${iso}+11:00`);

const cost = (productId: string, costCents: number | null) => setCosts(A(), h.staff.manager, [{ productId, costCents }]);
const dbCost = async (id: string) => (await h.sql<{ cost_cents: number | null }[]>`select cost_cents from public.products where id = ${id}`)[0].cost_cents;
const report = (from: string | null = DAY, to: string | null = from) => getProfitReport(from, to);
const line = (r: ProfitReportDTO, productId: string | null, name?: string) => {
  const l = r.lines.find((x) => x.productId === productId && (name === undefined || x.name === name));
  if (!l) throw new Error(`no line for ${productId ?? name} in ${JSON.stringify(r.lines.map((x) => x.name))}`);
  return l;
};

type Line = { p: string; qty?: number } | { custom: string; cents: number };
/** A counter sale closed at `when` (counter sales close the moment they open) with the given lines. Left awaiting payment. */
async function sell(lines: Line[], when: Date = at(0)): Promise<{ id: string; itemIds: string[] }> {
  const { sessionId: id } = await openCounterSale(A(), when);
  const itemIds: string[] = [];
  for (const l of lines) {
    const out = "p" in l ? await addItem(A(), id, l.p, l.qty ?? 1) : await addCustomItem(A(), id, l.custom, l.cents);
    itemIds.push(out.itemId);
  }
  return { id, itemIds };
}

/** The numbers every report must satisfy whatever the data: totals are the sum of the lines, and each line is self-consistent. */
function expectConsistent(r: ProfitReportDTO): void {
  const sum = (pick: (l: ProfitReportDTO["lines"][number]) => number) => r.lines.reduce((a, l) => a + pick(l), 0);
  expect(r.items.quantity).toBe(sum((l) => l.quantity));
  expect(r.items.salesCents).toBe(sum((l) => l.salesCents));
  expect(r.items.salesExGstCents).toBe(sum((l) => l.salesExGstCents));
  expect(r.items.uncostedQuantity).toBe(sum((l) => l.uncostedQuantity));
  expect(r.items.costCents).toBe(sum((l) => l.costCents));
  expect(r.items.profitCents).toBe(sum((l) => l.profitCents));
  const costedEx = sum((l) => l.profitCents + l.costCents);
  expect(r.items.uncostedSalesExGstCents).toBe(r.items.salesExGstCents - costedEx);
  expect(r.items.marginBps).toBe(costedEx > 0 ? Math.round((r.items.profitCents * 10_000) / costedEx) : null);
  for (const l of r.lines) {
    expect(l.uncostedQuantity).toBeGreaterThanOrEqual(0);
    expect(l.uncostedQuantity).toBeLessThanOrEqual(l.quantity);
    expect(l.salesExGstCents).toBeLessThanOrEqual(l.salesCents);
    const lineCostedEx = l.profitCents + l.costCents;
    expect(l.marginBps).toBe(lineCostedEx > 0 ? Math.round((l.profitCents * 10_000) / lineCostedEx) : null);
    if (l.uncostedQuantity === l.quantity) expect([l.costCents, l.profitCents, l.marginBps]).toEqual([0, 0, null]);
  }
}

// ---------------------------------------------------------------------------
// setCosts
// ---------------------------------------------------------------------------

describe("setCosts", () => {
  it("sets costs, counts only the ones that changed, and audits each change with before/after and the approving manager", async () => {
    const { actor, manager } = h.staff;
    const out = await setCosts(actor, manager, [
      { productId: "BEER", costCents: 400 },
      { productId: "COKE", costCents: 150 },
      { productId: "WATER", costCents: null }, // already null: no change
    ]);
    expect(out).toEqual({ changed: 2 });
    expect([await dbCost("BEER"), await dbCost("COKE"), await dbCost("WATER")]).toEqual([400, 150, null]);

    const [row] = await audits(h, "BEER", "product.cost");
    expect(row).toMatchObject({
      actor_staff_id: actor.staffId,
      approved_by_staff_id: manager.id,
      entity: "product",
      before: { name: "Beer", cost_cents: null },
      after: { cost_cents: 400 },
    });
    expect(await audits(h, "WATER", "product.cost")).toHaveLength(0);

    // Saving the same numbers again changes nothing and writes nothing.
    const [stamp] = await h.sql<{ cost_updated_at: Date; cost_updated_by: string }[]>`select cost_updated_at, cost_updated_by from public.products where id = 'BEER'`;
    expect(stamp.cost_updated_by).toBe(manager.id);
    expect(await setCosts(actor, manager, [{ productId: "BEER", costCents: 400 }, { productId: "COKE", costCents: 150 }])).toEqual({ changed: 0 });
    const [stamp2] = await h.sql<{ cost_updated_at: Date }[]>`select cost_updated_at from public.products where id = 'BEER'`;
    expect(stamp2.cost_updated_at).toEqual(stamp.cost_updated_at);
    expect(await audits(h, "BEER", "product.cost")).toHaveLength(1);
    expect(await audits(h, "COKE", "product.cost")).toHaveLength(1);
  });

  it("changing and clearing: the audit trail is the cost history, and a cost row that never changed has no stamp", async () => {
    await cost("BEER", 400);
    await cost("BEER", 500);
    await cost("BEER", null);
    await cost("BEER", null); // clearing a cleared cost is not a change
    const rows = await audits(h, "BEER", "product.cost");
    expect(rows.map((r) => [(r.before as { cost_cents: number | null }).cost_cents, (r.after as { cost_cents: number | null }).cost_cents])).toEqual([
      [null, 400],
      [400, 500],
      [500, null],
    ]);
    const [w] = await h.sql<{ cost_updated_at: Date | null; cost_updated_by: string | null }[]>`select cost_updated_at, cost_updated_by from public.products where id = 'WATER'`;
    expect(w).toEqual({ cost_updated_at: null, cost_updated_by: null });
  });

  it("zero is a real cost; $10,000 is the most; null clears", async () => {
    await cost("BEER", 0);
    expect(await dbCost("BEER")).toBe(0);
    await cost("BEER", 1_000_000);
    expect(await dbCost("BEER")).toBe(1_000_000);
    await cost("BEER", null);
    expect(await dbCost("BEER")).toBeNull();
  });

  it("refuses a bad cost (400), and a bad one anywhere in the list saves nothing at all", async () => {
    for (const bad of [-1, 1_000_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(setCosts(A(), h.staff.manager, [{ productId: "BEER", costCents: 100 }, { productId: "COKE", costCents: bad }])).rejects.toMatchObject({ status: 400 });
    }
    expect(await dbCost("BEER")).toBeNull();
    expect(await h.sql`select 1 from public.audit_log where action = 'product.cost'`).toHaveLength(0);
  });

  it("an id that isn't a product refuses the whole save with a 400 and writes nothing", async () => {
    await expect(
      setCosts(A(), h.staff.manager, [{ productId: "BEER", costCents: 100 }, { productId: "NOPE", costCents: 100 }, { productId: "ALSO_NOPE", costCents: 5 }]),
    ).rejects.toMatchObject({ status: 400 });
    expect(await dbCost("BEER")).toBeNull();
    expect(await h.sql`select 1 from public.audit_log where action = 'product.cost'`).toHaveLength(0);
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from public.products where cost_updated_at is not null`;
    expect(n).toBe(0);
  });

  it("an empty list, a repeated product and more than 500 at a time are refused", async () => {
    await expect(setCosts(A(), h.staff.manager, [])).rejects.toMatchObject({ status: 400 });
    await expect(setCosts(A(), h.staff.manager, [{ productId: "BEER", costCents: 1 }, { productId: "BEER", costCents: 2 }])).rejects.toMatchObject({ status: 400 });
    const many = Array.from({ length: 501 }, (_, i) => ({ productId: `P${i}`, costCents: 1 }));
    await expect(setCosts(A(), h.staff.manager, many)).rejects.toMatchObject({ status: 400 });
    expect(await dbCost("BEER")).toBeNull();
  });

  it("500 at once is fine", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `BULK${i}`, item_id: `ITEM_BULK${i}`, name: `Bulk ${i}`, price_cents: 100 }));
    await h.sql`insert into public.products ${h.sql(rows, "id", "item_id", "name", "price_cents")}`;
    const out = await setCosts(A(), h.staff.manager, rows.map((r) => ({ productId: r.id, costCents: 7 })));
    expect(out).toEqual({ changed: 500 });
  });

  it("an inactive product can still be given a cost", async () => {
    await h.sql`update public.products set active = false where id = 'COKE'`;
    await expect(cost("COKE", 100)).resolves.toEqual({ changed: 1 });
  });

  it("a catalogue refresh never touches the cost (or its stamp), including when the item is dropped from Square", async () => {
    const variation = (id: string, cents: number): Square.CatalogObject.ItemVariation => ({
      type: "ITEM_VARIATION",
      id,
      presentAtAllLocations: true,
      itemVariationData: { name: "Regular", pricingType: "FIXED_PRICING", priceMoney: { amount: BigInt(cents), currency: "AUD" } },
    });
    const item = (id: string, name: string, v: Square.CatalogObject.ItemVariation): Square.CatalogObject.Item => ({
      type: "ITEM",
      id,
      presentAtAllLocations: true,
      itemData: { name, productType: "REGULAR", taxIds: [], categories: [], variations: [v] },
    });
    const hire: Square.CatalogObject.Item = item("I_HIRE", "Table hire", {
      ...variation("V_HIRE", 0),
      itemVariationData: { name: "Regular", pricingType: "VARIABLE_PRICING" },
    });
    h.catalog.objects = [item("I_SYNC", "Synced", variation("V_SYNC", 450)), hire];
    await syncProducts();
    await cost("V_SYNC", 123);
    const [before] = await h.sql<{ cost_updated_at: Date }[]>`select cost_updated_at from public.products where id = 'V_SYNC'`;

    h.catalog.objects = [item("I_SYNC", "Synced renamed", variation("V_SYNC", 480)), hire];
    await syncProducts();
    const [after] = await h.sql<{ name: string; price_cents: number; cost_cents: number | null; cost_updated_at: Date }[]>`
      select name, price_cents, cost_cents, cost_updated_at from public.products where id = 'V_SYNC'`;
    expect(after).toMatchObject({ name: "Synced renamed", price_cents: 480, cost_cents: 123 });
    expect(after.cost_updated_at).toEqual(before.cost_updated_at);

    h.catalog.objects = [hire]; // gone from Square: deactivated, not deleted
    await syncProducts();
    const [gone] = await h.sql<{ active: boolean; cost_cents: number | null }[]>`select active, cost_cents from public.products where id = 'V_SYNC'`;
    expect(gone).toEqual({ active: false, cost_cents: 123 });
  });
});

// ---------------------------------------------------------------------------
// The cost copied onto a line
// ---------------------------------------------------------------------------

describe("what a bill line keeps of the cost", () => {
  it("addItem copies the product's cost; a product with no cost and a custom charge copy null", async () => {
    await cost("BEER", 400);
    const { id } = await sell([{ p: "BEER", qty: 2 }, { p: "COKE" }, { custom: "Chalk", cents: 250 }]);
    const items = await getItems(h, id);
    const byName = Object.fromEntries(
      (await h.sql<{ name: string; unit_cost_cents: number | null }[]>`select name, unit_cost_cents from public.session_items where session_id = ${id}`).map((r) => [r.name, r.unit_cost_cents]),
    );
    expect(items).toHaveLength(3);
    expect(byName).toEqual({ Beer: 400, Coke: null, Chalk: null });
  });

  it("a cost of zero is copied as zero, not null", async () => {
    await cost("BEER", 0);
    const { id } = await sell([{ p: "BEER" }]);
    const [r] = await h.sql<{ unit_cost_cents: number | null }[]>`select unit_cost_cents from public.session_items where session_id = ${id}`;
    expect(r.unit_cost_cents).toBe(0);
  });

  it("changing the product's price or cost later doesn't touch lines already on a bill", async () => {
    await cost("BEER", 400);
    const { id } = await sell([{ p: "BEER" }]);
    await cost("BEER", 900);
    await cost("BEER", null);
    const [r] = await h.sql<{ unit_cost_cents: number | null }[]>`select unit_cost_cents from public.session_items where session_id = ${id}`;
    expect(r.unit_cost_cents).toBe(400);
  });

  it("the database refuses a negative or over-limit cost on a product or a line, and a cost-less product row stays null", async () => {
    await expect(h.sql`update public.products set cost_cents = -1 where id = 'BEER'`).rejects.toMatchObject({ code: "23514" });
    await expect(h.sql`update public.products set cost_cents = 1000001 where id = 'BEER'`).rejects.toMatchObject({ code: "23514" });
    const { id } = await sell([{ p: "BEER" }]);
    await expect(h.sql`update public.session_items set unit_cost_cents = -1 where session_id = ${id}`).rejects.toMatchObject({ code: "23514" });
    await expect(h.sql`update public.session_items set unit_cost_cents = 1000001 where session_id = ${id}`).rejects.toMatchObject({ code: "23514" });
  });
});

// ---------------------------------------------------------------------------
// Profit arithmetic
// ---------------------------------------------------------------------------

describe("profit arithmetic", () => {
  it("a taxed line: GST comes out (10/11), cost is per unit times quantity", async () => {
    await cost("BEER", 400);
    await sell([{ p: "BEER", qty: 2 }]);
    const r = await report();
    expect(line(r, "BEER")).toEqual({
      productId: "BEER",
      name: "Beer",
      quantity: 2,
      salesCents: 2200,
      salesExGstCents: 2000,
      uncostedQuantity: 0,
      costCents: 800,
      profitCents: 1200,
      marginBps: 6000,
    });
    expect(r.items).toEqual({
      quantity: 2,
      salesCents: 2200,
      salesExGstCents: 2000,
      uncostedQuantity: 0,
      uncostedSalesExGstCents: 0,
      costCents: 800,
      profitCents: 1200,
      marginBps: 6000,
    });
    expectConsistent(r);
  });

  it("a GST-free line has nothing taken out", async () => {
    await cost("WATER", 100);
    await sell([{ p: "WATER", qty: 3 }]);
    expect(line(await report(), "WATER")).toMatchObject({ salesCents: 900, salesExGstCents: 900, costCents: 300, profitCents: 600, marginBps: 6667 });
  });

  it("GST is worked out line by line, not on the product's total (two $1.50 lines: 136 + 136, not 273)", async () => {
    await cost("SMALL", 50);
    await sell([{ p: "SMALL" }]);
    await sell([{ p: "SMALL" }]);
    const l = line(await report(), "SMALL");
    expect(l).toMatchObject({ quantity: 2, salesCents: 300, salesExGstCents: 272, costCents: 100, profitCents: 172, marginBps: 6324 });
  });

  it("a quantity is one line: 3 x $1.50 is GST on $4.50 (409), not three times 136", async () => {
    await sell([{ p: "SMALL", qty: 3 }]);
    expect(line(await report(), "SMALL").salesExGstCents).toBe(409);
  });

  it("the same product sold taxed and later GST-free keeps each line's own GST treatment", async () => {
    await cost("BEER", 400);
    await sell([{ p: "BEER" }]); // taxed: ex 1000
    await h.sql`update public.products set taxed = false where id = 'BEER'`;
    await sell([{ p: "BEER" }]); // GST-free: ex 1100
    const l = line(await report(), "BEER");
    expect(l).toMatchObject({ quantity: 2, salesCents: 2200, salesExGstCents: 2100, costCents: 800, profitCents: 1300 });
  });

  it("custom charges are always taxed (GST on 1500 = 1364) and never costed", async () => {
    await sell([{ custom: "Cue repair", cents: 1500 }]);
    const l = line(await report(), null, "Cue repair");
    expect(l).toMatchObject({ quantity: 1, salesCents: 1500, salesExGstCents: 1364, uncostedQuantity: 1, costCents: 0, profitCents: 0, marginBps: null });
  });

  it("changing a product's cost after a sale does not change that sale's profit (the line carried a cost)", async () => {
    await cost("BEER", 400);
    await sell([{ p: "BEER" }]);
    const before = line(await report(), "BEER");
    await cost("BEER", 900);
    expect(line(await report(), "BEER")).toEqual(before);
    await cost("BEER", null);
    expect(line(await report(), "BEER")).toEqual(before);
    await cost("BEER", 0);
    expect(line(await report(), "BEER")).toEqual(before);
    expect(before).toMatchObject({ costCents: 400, profitCents: 600, uncostedQuantity: 0 });
  });

  it("each sale keeps the cost it had: 400 then 900 gives cost 1300 for two", async () => {
    await cost("BEER", 400);
    await sell([{ p: "BEER" }]);
    await cost("BEER", 900);
    await sell([{ p: "BEER" }]);
    expect(line(await report(), "BEER")).toMatchObject({ quantity: 2, costCents: 1300, profitCents: 2000 - 1300, uncostedQuantity: 0 });
  });

  it("a line sold before any cost existed falls back to the product's cost now, and follows it", async () => {
    await sell([{ p: "BEER", qty: 2 }]);
    let l = line(await report(), "BEER");
    expect(l).toMatchObject({ uncostedQuantity: 2, costCents: 0, profitCents: 0, marginBps: null, salesExGstCents: 2000 });
    await cost("BEER", 400);
    l = line(await report(), "BEER");
    expect(l).toMatchObject({ uncostedQuantity: 0, costCents: 800, profitCents: 1200, marginBps: 6000 });
    await cost("BEER", 500);
    expect(line(await report(), "BEER")).toMatchObject({ costCents: 1000, profitCents: 1000 });
    await cost("BEER", null);
    expect(line(await report(), "BEER")).toMatchObject({ uncostedQuantity: 2, costCents: 0, profitCents: 0 });
  });

  it("uncosted units still count in sales, but not in cost, profit or the margin's base", async () => {
    await cost("BEER", 400);
    await sell([{ p: "BEER" }]); // costed (copied 400)
    await cost("BEER", null);
    await sell([{ p: "BEER" }]); // no cost on the line, none on the product: uncosted
    const r = await report();
    expect(line(r, "BEER")).toMatchObject({
      quantity: 2,
      salesCents: 2200,
      salesExGstCents: 2000,
      uncostedQuantity: 1,
      costCents: 400,
      profitCents: 600, // 1000 ex GST of the costed one less 400, nothing from the uncosted one
      marginBps: 6000,
    });
    expect(r.items).toMatchObject({ uncostedQuantity: 1, uncostedSalesExGstCents: 1000, salesExGstCents: 2000, costCents: 400, profitCents: 600, marginBps: 6000 });
    expectConsistent(r);
  });

  it("a zero-cost item is costed: its whole ex-GST price is profit, 100% margin", async () => {
    await cost("WATER", 0);
    await sell([{ p: "WATER" }]);
    expect(line(await report(), "WATER")).toMatchObject({ uncostedQuantity: 0, costCents: 0, profitCents: 300, marginBps: 10000 });
  });

  it("a loss is negative profit and a negative margin", async () => {
    await cost("BEER", 1500);
    await sell([{ p: "BEER" }]);
    expect(line(await report(), "BEER")).toMatchObject({ costCents: 1500, profitCents: 1000 - 1500, marginBps: -5000 });
  });

  it("lines are ordered biggest profit first, then uncosted ones by sales, biggest seller first", async () => {
    await cost("BEER", 900); // profit 100
    await cost("WATER", 50); // profit 250
    await sell([{ p: "BEER" }, { p: "WATER" }, { p: "COKE", qty: 1 }, { custom: "Chalk", cents: 5000 }, { custom: "Tape", cents: 100 }]);
    const r = await report();
    expect(r.lines.map((l) => l.name)).toEqual(["Water", "Beer", "Chalk", "Coke", "Tape"]);
    expectConsistent(r);
  });

  it("custom charges are grouped by name, ignoring case and stray spaces, and kept apart from a product of the same name", async () => {
    await cost("COKE", 100);
    await sell([{ custom: "Cue repair", cents: 1500 }, { custom: "Chalk", cents: 250 }]);
    await sell([{ custom: "cue REPAIR", cents: 1000 }, { custom: "Coke", cents: 450 }, { p: "COKE" }]);
    const r = await report();
    const repair = r.lines.filter((l) => l.productId === null && l.name.toLowerCase() === "cue repair");
    expect(repair).toHaveLength(1);
    expect(repair[0]).toMatchObject({ quantity: 2, salesCents: 2500, salesExGstCents: 1364 + 909 });
    expect(r.lines.filter((l) => l.productId === null).map((l) => l.name.toLowerCase()).sort()).toEqual(["chalk", "coke", "cue repair"]);
    expect(line(r, "COKE")).toMatchObject({ quantity: 1, costCents: 100 });
    expectConsistent(r);
  });

  it("a product's line shows the latest name used", async () => {
    await sell([{ p: "BEER" }], at(0));
    await h.sql`update public.products set name = 'Craft beer' where id = 'BEER'`;
    await sell([{ p: "BEER" }], at(30));
    expect(line(await report(), "BEER").name).toBe("Craft beer");
  });

  it("with nothing sold: an empty report, nulls for margins, zeros elsewhere", async () => {
    const r = await report();
    expect(r.lines).toEqual([]);
    expect(r.items).toEqual({ quantity: 0, salesCents: 0, salesExGstCents: 0, uncostedQuantity: 0, uncostedSalesExGstCents: 0, costCents: 0, profitCents: 0, marginBps: null });
    expect(r.table).toEqual({ cents: 0, exGstCents: 0 });
    expect(r.discountCents).toBe(0);
    expect(r.stock).toEqual({ costCents: 0, units: 0, uncostedProducts: 0 });
    expect([r.from, r.to]).toEqual([DAY, DAY]);
  });
});

// ---------------------------------------------------------------------------
// Which lines count
// ---------------------------------------------------------------------------

describe("which lines count", () => {
  it("removed lines are left out of quantity, sales, cost and profit", async () => {
    await cost("BEER", 400);
    const { id, itemIds } = await sell([{ p: "BEER", qty: 2 }, { p: "BEER", qty: 5 }, { custom: "Chalk", cents: 250 }]);
    await removeItem(A(), id, itemIds[1], at(1));
    await removeItem(A(), id, itemIds[2], at(1));
    const r = await report();
    expect(r.lines).toHaveLength(1);
    expect(line(r, "BEER")).toMatchObject({ quantity: 2, salesCents: 2200, costCents: 800 });
  });

  it("void bills are left out entirely; a paid bill is in; so is one still awaiting payment", async () => {
    await cost("BEER", 400);
    const voided = await sell([{ p: "BEER", qty: 4 }, { custom: "Gone", cents: 999 }]);
    await voidSession(A(), h.staff.manager, voided.id, "Rung up by mistake", at(5));
    const paid = await sell([{ p: "BEER" }]);
    await markPaid(A(), paid.id, "cash", { cardConfirmed: false }, at(6));
    await sell([{ p: "BEER" }]);
    const r = await report();
    expect(line(r, "BEER").quantity).toBe(2);
    expect(r.lines.map((l) => l.name)).toEqual(["Beer"]);
  });

  it("a table still running has no closing date yet: its items are not in the report", async () => {
    const { sessionId } = await startSession(A(), h.tableId("Table 1"), at(0));
    await addItem(A(), sessionId, "COKE", 2);
    expect((await report()).lines).toEqual([]);
    await stopSession(A(), sessionId, at(60));
    expect(line(await report(), "COKE").quantity).toBe(2);
  });

  it("a table bill's items count, with its table time reported separately", async () => {
    await cost("COKE", 100);
    const id = await awaitingPayment(h, "Table 1", 60);
    await addItem(A(), id, "COKE", 2);
    const r = await report();
    expect(line(r, "COKE")).toMatchObject({ quantity: 2, salesCents: 900, salesExGstCents: 818, costCents: 200, profitCents: 618 });
    expect(r.table).toEqual({ cents: 2500, exGstCents: 2273 });
  });

  it("a split bill's items are counted once, and the shares' single 'split' lines never appear", async () => {
    await cost("COKE", 100);
    const id = await awaitingPayment(h, "Table 1", 60);
    await addItem(A(), id, "COKE", 2); // bill: 2500 + 900 = 3400
    const { partIds } = await splitBill(A(), id, { ways: 2 }, at(61));
    for (const p of partIds) await markPaid(A(), p, "cash", { cardConfirmed: false }, at(62));
    await markPaid(A(), id, "cash", { cardConfirmed: false }, at(62));

    const r = await report();
    expect(r.lines.map((l) => l.name)).toEqual(["Coke"]);
    expect(line(r, "COKE")).toMatchObject({ quantity: 2, salesCents: 900 });
    expect(r.items.quantity).toBe(2);
    // table time = what was billed (3400, parts included) less the items
    expect(r.table).toEqual({ cents: 2500, exGstCents: 2273 });
    expectConsistent(r);
  });

  it("a bill split before its items were all added still counts each line once", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await splitBill(A(), id, { amountCents: 1000 }, at(61));
    await addItem(A(), id, "COKE", 1);
    const r = await report();
    expect(r.items.quantity).toBe(1);
    expect(r.items.salesCents).toBe(450);
  });

  it("agrees with the daily summary's items sold, line for line", async () => {
    await cost("BEER", 400);
    await sell([{ p: "BEER", qty: 2 }, { p: "COKE" }, { custom: "Chalk", cents: 250 }]);
    const b = await sell([{ p: "WATER", qty: 3 }, { custom: " chalk ", cents: 100 }]);
    await voidSession(A(), h.staff.manager, (await sell([{ p: "BEER" }])).id, "Rung up wrong", at(5));
    const t = await awaitingPayment(h, "Table 3", 60);
    await addItem(A(), t, "COKE", 1);
    await splitBill(A(), t, { ways: 2 }, at(61));
    void b;

    const r = await report();
    const s = await getSummary(DAY);
    expect(r.items.quantity).toBe(s.itemsSold.reduce((a, i) => a + i.quantity, 0));
    expect(r.items.salesCents).toBe(s.itemsSold.reduce((a, i) => a + i.cents, 0));
    for (const i of s.itemsSold) {
      const l = r.lines.find((x) => x.productId === i.productId && (i.productId !== null || x.name.toLowerCase() === i.name.toLowerCase()));
      expect(l, `line for ${i.name}`).toMatchObject({ quantity: i.quantity, salesCents: i.cents });
    }
    expect(r.lines).toHaveLength(s.itemsSold.length);
    expectConsistent(r);
  });
});

// ---------------------------------------------------------------------------
// Table time and discounts
// ---------------------------------------------------------------------------

describe("table time and discounts", () => {
  it("table time is billed less items plus discount, and the discount is reported on its own, not taken off any item", async () => {
    await seedDiscount(h, { id: "D10", name: "Ten off", kind: "percent", value: 1000 });
    await cost("COKE", 100);
    const id = await awaitingPayment(h, "Table 1", 60); // 2500
    await addItem(A(), id, "COKE", 1); // +450 = 2950
    await setDiscount(A(), h.staff.manager, id, { discountId: "D10" }); // 10% = 295
    const r = await report();
    expect(r.discountCents).toBe(295);
    expect(r.table).toEqual({ cents: 2500, exGstCents: 2273 });
    // the item is reported at its full price
    expect(line(r, "COKE")).toMatchObject({ salesCents: 450, salesExGstCents: 409, costCents: 100, profitCents: 309 });
    const s = await getSummary(DAY);
    expect(r.table.cents).toBe(s.sessions.tableCents);
    expect(r.discountCents).toBe(s.sessions.discountCents);
  });

  it("matches the summary's table and discount figures over several days, split bills included", async () => {
    await seedDiscount(h, { id: "D10", name: "Ten off", kind: "percent", value: 1000 });
    const mk = async (table: string, day: string, mins: number) => {
      const { sessionId } = await startSession(A(), h.tableId(table), syd(`${day}T10:00:00`));
      await stopSession(A(), sessionId, new Date(syd(`${day}T10:00:00`).getTime() + mins * 60_000));
      return sessionId;
    };
    const a = await mk("Table 1", "2026-11-20", 60);
    await setDiscount(A(), h.staff.manager, a, { discountId: "D10" });
    const b = await mk("Table 2", "2026-11-21", 90);
    await addItem(A(), b, "BEER", 1);
    await splitBill(A(), b, { ways: 3 }, syd("2026-11-21T12:00:00"));

    const r = await report("2026-11-20", "2026-11-21");
    const [s1, s2] = [await getSummary("2026-11-20"), await getSummary("2026-11-21")];
    expect(r.table.cents).toBe(s1.sessions.tableCents + s2.sessions.tableCents);
    expect(r.discountCents).toBe(s1.sessions.discountCents + s2.sessions.discountCents);
    expect(r.table.cents).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

describe("date ranges cover whole business days", () => {
  const sells = async () => {
    // one distinguishable custom charge per instant
    const at1 = async (iso: string, cents: number) => sell([{ custom: `c${cents}`, cents }], syd(iso));
    await at1("2026-11-20T05:59:59.999", 100); // still the 19th
    await at1("2026-11-20T06:00:00", 200); // the 20th starts
    await at1("2026-11-21T01:00:00", 300); // still the 20th
    await at1("2026-11-21T05:59:59.999", 400); // last moment of the 20th
    await at1("2026-11-21T06:00:00", 500); // the 21st
  };
  const sales = async (from: string, to: string) => (await report(from, to)).items.salesCents;

  it("the day runs 06:00 to 06:00: a 01:00 sale belongs to the previous date", async () => {
    await sells();
    expect(await sales("2026-11-19", "2026-11-19")).toBe(100);
    expect(await sales("2026-11-20", "2026-11-20")).toBe(200 + 300 + 400);
    expect(await sales("2026-11-21", "2026-11-21")).toBe(500);
  });

  it("a range includes both end dates and is the sum of its days", async () => {
    await sells();
    expect(await sales("2026-11-19", "2026-11-21")).toBe(1500);
    expect(await sales("2026-11-20", "2026-11-21")).toBe(1400);
    expect(await sales("2026-11-19", "2026-11-20")).toBe(1000);
    expect(await sales("2026-11-22", "2026-11-30")).toBe(0);
    const r = await report("2026-11-19", "2026-11-21");
    expect([r.from, r.to]).toEqual(["2026-11-19", "2026-11-21"]);
  });

  it("the hand-over is right on the days the clocks change", async () => {
    // Sydney springs forward on Sun 4 Oct 2026 (02:00 -> 03:00): the business day of the 3rd is 23 hours long.
    await sell([{ custom: "a", cents: 100 }], new Date("2026-10-03T18:59:00Z")); // 05:59 on the 4th: still the 3rd
    await sell([{ custom: "b", cents: 200 }], new Date("2026-10-03T19:00:00Z")); // 06:00 on the 4th: the 4th
    expect(await sales("2026-10-03", "2026-10-03")).toBe(100);
    expect(await sales("2026-10-04", "2026-10-04")).toBe(200);
    // Sydney falls back on Sun 5 Apr 2026 (03:00 -> 02:00): the business day of the 4th is 25 hours long.
    await sell([{ custom: "c", cents: 1000 }], new Date("2026-04-04T19:59:00Z")); // 05:59 on the 5th: still the 4th
    await sell([{ custom: "d", cents: 2000 }], new Date("2026-04-04T20:00:00Z")); // 06:00 on the 5th: the 5th
    await sell([{ custom: "e", cents: 4000 }], new Date("2026-04-04T18:30:00Z")); // 04:30 on the 5th (first pass): the 4th
    expect(await sales("2026-04-04", "2026-04-04")).toBe(5000);
    expect(await sales("2026-04-05", "2026-04-05")).toBe(2000);
  });

  it("no dates means the business day running now: before 06:00 that is still yesterday", async () => {
    await sell([{ custom: "late", cents: 700 }], syd("2026-11-20T23:00:00"));
    await sell([{ custom: "next", cents: 900 }], syd("2026-11-21T07:00:00"));
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(syd("2026-11-21T02:00:00"));
    let r = await getProfitReport(null, null);
    expect([r.today, r.from, r.to]).toEqual(["2026-11-20", "2026-11-20", "2026-11-20"]);
    expect(r.items.salesCents).toBe(700);

    vi.setSystemTime(syd("2026-11-21T06:00:00"));
    r = await getProfitReport(null, null);
    expect([r.today, r.from, r.to]).toEqual(["2026-11-21", "2026-11-21", "2026-11-21"]);
    expect(r.items.salesCents).toBe(900);

    // `today` is the venue's date even when asking for another range
    r = await getProfitReport("2026-11-20", "2026-11-20");
    expect(r.today).toBe("2026-11-21");
  });

  it("a single-day range of one date is a valid range; so is 366 days; 367 is not", async () => {
    await expect(report("2026-11-20", "2026-11-20")).resolves.toBeTruthy();
    await expect(report("2025-11-23", "2026-11-23")).resolves.toBeTruthy(); // 366 dates
    await expect(report("2025-11-22", "2026-11-23")).rejects.toMatchObject({ status: 400 }); // 367 dates
    await expect(report("2000-01-01", "2026-11-23")).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a range that is back to front, half given, malformed or not a real date (all 400)", async () => {
    const bad: [string | null, string | null][] = [
      ["2026-11-21", "2026-11-20"],
      ["2026-11-20", null],
      [null, "2026-11-20"],
      ["2026-02-31", "2026-03-01"],
      ["2026-11-20", "2026-02-30"],
      ["2026-13-01", "2026-13-02"],
      ["2026-00-10", "2026-00-11"],
      ["2026-11-00", "2026-11-01"],
      ["2025-02-29", "2025-03-01"], // not a leap year
      ["2026-1-5", "2026-1-6"],
      ["20-11-2026", "21-11-2026"],
      ["2026-11-20T00:00:00Z", "2026-11-21"],
    ];
    for (const [from, to] of bad) {
      await expect(getProfitReport(from, to), `${from} → ${to}`).rejects.toMatchObject({ status: 400 });
    }
    // a real leap day is fine
    await expect(getProfitReport("2028-02-29", "2028-02-29")).resolves.toBeTruthy();
  });

  // The route passes searchParams.get() straight through, so `?from=2026-11-01&to=` arrives as "".
  it("a half-given range with an empty date is refused too, not read as 'up to today'", async () => {
    await expect(getProfitReport("2026-11-01", "")).rejects.toMatchObject({ status: 400 });
    await expect(getProfitReport("", "2026-11-20")).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// Stock on hand, at cost
// ---------------------------------------------------------------------------

describe("stock at cost", () => {
  const track = (id: string, count: number | null, tracked = true) =>
    h.sql`update public.products set tracked = ${tracked}, stock_count = ${count}, tracked_since = '2000-01-01' where id = ${id}`;

  it("sums on-hand units times cost over tracked, counted, costed products; uncosted ones are only counted", async () => {
    await cost("BEER", 400);
    await cost("COKE", 100);
    await track("BEER", 10);
    await track("COKE", 3);
    await track("WATER", 6); // no cost: counted as an uncosted product, adds no units or dollars
    await track("SMALL", null); // never counted in Square
    await cost("SMALL", 10);
    const r = await report();
    expect(r.stock).toEqual({ costCents: 10 * 400 + 3 * 100, units: 13, uncostedProducts: 1 });
  });

  it("an untracked product's old count is ignored, and a count of zero is nothing at all (not an uncosted product)", async () => {
    await cost("BEER", 400);
    await track("BEER", 10, false);
    await track("COKE", 0); // no cost, but nothing on the shelf either
    expect((await report()).stock).toEqual({ costCents: 0, units: 0, uncostedProducts: 0 });
  });

  it("units already on open bills come off the count, and never below zero", async () => {
    await cost("BEER", 400);
    await track("BEER", 10);
    await sell([{ p: "BEER", qty: 3 }]);
    expect((await report()).stock).toEqual({ costCents: 7 * 400, units: 7, uncostedProducts: 0 });

    await track("BEER", 2); // Square says 2, the bills hold 3
    expect((await report()).stock).toEqual({ costCents: 0, units: 0, uncostedProducts: 0 });
  });

  it("is a snapshot of now, not of the dates asked for", async () => {
    await cost("BEER", 400);
    await track("BEER", 5);
    const old = await report("2020-01-01", "2020-01-31");
    expect(old.stock).toEqual({ costCents: 2000, units: 5, uncostedProducts: 0 });
  });
});

// ---------------------------------------------------------------------------
// Who gets to see a cost
// ---------------------------------------------------------------------------

describe("costs are for managers only", () => {
  const costKey = /"[A-Za-z_]*cost[A-Za-z_]*"\s*:/i;

  it("the admin item list carries costCents (null when unset)", async () => {
    await cost("BEER", 400);
    const { catalog } = await getAdminState(h.staff.manager);
    const byId = Object.fromEntries(catalog.products.map((p) => [p.id, p.costCents]));
    expect(byId).toEqual({ BEER: 400, COKE: null, WATER: null, SMALL: null });
  });

  it("the floor's products, which every staff member can load, never carry a cost", async () => {
    await cost("BEER", 400);
    await cost("WATER", 0);
    const f = await getFloor();
    expect(f.products.map((p) => p.id).sort()).toEqual(["BEER", "COKE", "SMALL", "WATER"]);
    expect(JSON.stringify(f.products)).not.toMatch(costKey);
    for (const p of f.products) expect(Object.keys(p)).not.toContain("costCents");
  });

  it("nor do bills with items on them: the floor, the unpaid list, a bill's detail, the summary", async () => {
    await cost("BEER", 400);
    const { id } = await sell([{ p: "BEER" }, { custom: "Chalk", cents: 100 }]);
    const t = await startSession(A(), h.tableId("Table 1"), at(0));
    await addItem(A(), t.sessionId, "BEER", 1);
    const detail = await getSessionDetail(id);
    await removeItem(A(), id, (await getItems(h, id))[1].id, at(1));
    for (const payload of [await getFloor(), await getUnpaid(), detail, await getSessionDetail(id), await getSummary(DAY)]) {
      expect(JSON.stringify(payload)).not.toMatch(costKey);
    }
  });
});
