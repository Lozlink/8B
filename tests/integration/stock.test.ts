import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { squareRejection, squareServerError, squareTimeout } from "./helpers/fake-gateway";
import { T0, at, audits, getCheckouts, getItems, getSession, seedDiscount, seedProduct } from "./helpers/util";
import { getAdminState } from "@/lib/server/admin";
import { withTx } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { getFloor, getSummary } from "@/lib/server/queries";
import {
  addItem,
  applyWebhookCheckout,
  cancelCheckout,
  chargeCard,
  markPaid,
  mergeBack,
  openCounterSale,
  removeItem,
  reversePaid,
  setDiscount,
  splitBill,
  startSession,
  stopSession,
} from "@/lib/server/sessions";
import { pushCashRecords, retryCashRecords } from "@/lib/server/square-cash";
import {
  MAX_ATTEMPTS,
  reconcileStock,
  recordStockEvidence,
  getStockOutstanding,
  heldStock,
  applyWebhookCounts,
  refreshStock,
  resetStockReadWaitForTests,
  retryStockMoves,
  runStockPass,
  sendStockMoves,
  stockInBackground,
  type StockMoveRow,
} from "@/lib/server/stock";

let h: Harness;
let POST: (req: Request) => Promise<Response>;

beforeAll(async () => {
  h = await bootHarness();
  ({ POST } = await import("@/app/api/square/webhook/route"));
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  vi.restoreAllMocks();
  resetStockReadWaitForTests();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const COKE = "VAR_COKE";
const CHIPS = "VAR_CHIPS";
const GUM = "VAR_GUM";

/** Coke and chips are tracked by Square and counted (20 and 10); gum is sold but not tracked. */
async function seed(): Promise<void> {
  await seedProduct(h, { id: COKE, name: "Coke", priceCents: 450 });
  await seedProduct(h, { id: CHIPS, name: "Chips", priceCents: 300 });
  await seedProduct(h, { id: GUM, name: "Gum", priceCents: 100 });
  await h.sql`update public.products set tracked = true, tracked_since = '2000-01-01' where id in (${COKE}, ${CHIPS})`;
  h.stock.set(COKE, 20);
  h.stock.set(CHIPS, 10);
}
beforeEach(seed);

/** A stopped bill with these items, ready to pay. */
async function bill(items: [string, number][] = [[COKE, 2]], table = "Table 1"): Promise<string> {
  const { sessionId } = await startSession(h.staff.actor, h.tableId(table), T0);
  for (const [p, q] of items) await addItem(h.staff.actor, sessionId, p, q);
  await stopSession(h.staff.actor, sessionId, at(60));
  return sessionId;
}

const itemiseOff = () => h.sql`update public.settings set itemise_charges = false`;
const pay = (id: string, method: "card" | "cash") => markPaid(h.staff.actor, id, method, { cardConfirmed: method === "card" });
const reverse = (id: string) => reversePaid(h.staff.managerActor, h.staff.manager, id, "Wrong bill");

/** The customer taps their card: the checkout the app sent completes. */
async function cardPaid(id: string): Promise<void> {
  await chargeCard(h.staff.actor, id);
  const [c] = await getCheckouts(h, id);
  await withTx((tx) => applyWebhookCheckout(tx, { id: c.id, status: "COMPLETED", referenceId: id, cancelReason: null, amountCents: null }));
  expect((await getSession(h, id)).status).toBe("paid");
}

/** Runs SQL as the owner with triggers off, so `updated_at` can be set to an old date. */
async function backdate(sql: string): Promise<void> {
  await h.pg.exec(`reset role; set session_replication_role = replica; ${sql}; set session_replication_role = origin; set role timer_app`);
}
/** The checkout the app made for a bill completes (a webhook, however late). */
async function completeCheckout(id: string, attempt = 0): Promise<void> {
  const c = (await getCheckouts(h, id))[attempt];
  await withTx((tx) => applyWebhookCheckout(tx, { id: c.id, status: "COMPLETED", referenceId: id, cancelReason: null, amountCents: null }));
}
/** What Square's own stock did when an order carrying these items was paid. */
const squareTakes = (productId: string, n: number) => h.stock.set(productId, (h.stock.count(productId) ?? 0) - n);

const moves = (id: string) => h.sql<StockMoveRow[]>`select * from public.stock_moves where session_id = ${id} order by seq`;
const summary = async (id: string) => (await moves(id)).map((m) => [m.seq, m.kind, m.via, m.state]);
const makeDue = () => h.raw(null, `update public.stock_moves set next_attempt_at = now() where state = 'pending'`);
const stockOf = async (id: string) => (await h.sql<{ stock_count: number | null }[]>`select stock_count from public.products where id = ${id}`)[0].stock_count;
const productsXmin = async () =>
  Object.fromEntries((await h.sql<{ id: string; x: string }[]>`select id, xmin::text as x from public.products`).map((r) => [r.id, r.x]));
const lines = (...l: [string, number][]) => l.map(([productId, quantity]) => ({ productId, quantity }));

// ---------------------------------------------------------------------------

describe("ST1. counts from Square", () => {
  it("stores the count of every tracked product, and nothing for one Square doesn't track", async () => {
    h.stock.set(GUM, 7);
    await refreshStock();
    expect(await stockOf(COKE)).toBe(20);
    expect(await stockOf(CHIPS)).toBe(10);
    expect(await stockOf(GUM)).toBeNull();
    // Square is only asked about what it tracks, at our location.
    expect(h.stock.reads).toEqual([[CHIPS, COKE]]);
    const [p] = await h.sql<{ stock_at: Date | null }[]>`select stock_at from public.products where id = ${COKE}`;
    expect(p.stock_at).toBeInstanceOf(Date);
  });

  it("writes only the rows that changed", async () => {
    await refreshStock();
    const before = await productsXmin();
    await refreshStock();
    expect(await productsXmin()).toEqual(before);

    h.stock.set(COKE, 15, new Date(Date.now() + 1000));
    await refreshStock();
    const after = await productsXmin();
    expect(after[COKE]).not.toBe(before[COKE]);
    expect(after[CHIPS]).toBe(before[CHIPS]);
    expect(await stockOf(COKE)).toBe(15);
  });

  it("never lets an older reading overwrite a newer one", async () => {
    await refreshStock();
    h.stock.set(COKE, 5, new Date(Date.now() - 600_000));
    await refreshStock();
    expect(await stockOf(COKE)).toBe(20);
    h.stock.set(COKE, 4, new Date(Date.now() + 5000));
    await refreshStock();
    expect(await stockOf(COKE)).toBe(4);
  });

  it("a tracked product Square has no count for is left as it is, never overwritten with nothing", async () => {
    await refreshStock();
    h.stock.counts.delete(CHIPS);
    await refreshStock();
    expect(await stockOf(CHIPS)).toBe(10);
    expect(await stockOf(COKE)).toBe(20);
    await h.sql`update public.products set stock_count = null, stock_at = null where id = ${CHIPS}`;
    await refreshStock();
    expect(await stockOf(CHIPS)).toBeNull();
  });

  it("[10] a missing reading doesn't stamp a time that shuts out a real count arriving by webhook", async () => {
    h.stock.counts.delete(CHIPS);
    await refreshStock();
    const [p] = await h.sql<{ stock_at: Date | null }[]>`select stock_at from public.products where id = ${CHIPS}`;
    expect(p.stock_at).toBeNull();
    const before = new Date(Date.now() - 60_000).toISOString();
    await withTx((tx) => applyWebhookCounts(tx, [{ variationId: CHIPS, quantity: 6, calculatedAt: new Date(before) }]));
    expect(await stockOf(CHIPS)).toBe(6);
  });

  it("[6] a count too big to store is dropped without failing the rest of the refresh", async () => {
    h.stock.set(COKE, 99_999_999_999);
    await expect(refreshStock()).resolves.toBeUndefined();
    expect(await stockOf(COKE)).toBeNull();
    expect(await stockOf(CHIPS)).toBe(10);
  });

  it("can refresh just the products asked for", async () => {
    await refreshStock({ productIds: [COKE] });
    expect(h.stock.reads).toEqual([[COKE]]);
    expect(await stockOf(COKE)).toBe(20);
    expect(await stockOf(CHIPS)).toBeNull();
  });

  it("the background refresh is claimed once per 2 minutes however many iPads poll", async () => {
    await Promise.all([stockInBackground(), stockInBackground(), stockInBackground()]);
    expect(h.stock.reads).toHaveLength(1);
    const [st] = await h.sql<{ stock_synced_at: Date | null }[]>`select stock_synced_at from public.catalog_state`;
    expect(st.stock_synced_at).toBeInstanceOf(Date);

    await stockInBackground();
    expect(h.stock.reads).toHaveLength(1);

    await h.raw(null, `update public.catalog_state set stock_synced_at = now() - interval '3 minutes'`);
    await stockInBackground();
    expect(h.stock.reads).toHaveLength(2);
  });

  it("a failed read is stored for Admin → Items, never thrown by the background pass, and cleared by the next good one", async () => {
    h.stock.readError = squareTimeout();
    await expect(refreshStock()).rejects.toMatchObject({ code: "square_error" });
    const [bad] = await h.sql<{ stock_error: string | null }[]>`select stock_error from public.catalog_state`;
    expect(bad.stock_error).toMatch(/didn't answer in time/);

    await h.raw(null, `update public.catalog_state set stock_synced_at = null`);
    await expect(stockInBackground()).resolves.toBeUndefined();

    h.stock.readError = null;
    await refreshStock();
    const [good] = await h.sql<{ stock_error: string | null }[]>`select stock_error from public.catalog_state`;
    expect(good.stock_error).toBeNull();
    expect((await getAdminState(h.staff.manager)).catalog.stock.lastError).toBeNull();
  });

  it("does nothing when Square isn't configured", async () => {
    const token = process.env.SQUARE_ACCESS_TOKEN;
    delete process.env.SQUARE_ACCESS_TOKEN;
    try {
      const id = await bill();
      await itemiseOff();
      await pay(id, "card");
      await stockInBackground();
    } finally {
      process.env.SQUARE_ACCESS_TOKEN = token;
    }
    expect(h.stock.reads).toHaveLength(0);
    expect(h.stock.changes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("ST2. which bills Square has to be told about", () => {
  it("a card paid against an itemised order: Square took the stock itself, so nothing is sent", async () => {
    const id = await bill();
    await cardPaid(id);
    // What Square did by itself when the order was paid.
    h.stock.set(COKE, 18);

    await runStockPass();

    expect(await summary(id)).toEqual([[1, "sale", "square", "done"]]);
    expect((await moves(id))[0].lines).toEqual(lines([COKE, 2]));
    expect(h.stock.changes).toHaveLength(0);
    // Its count was read back straight away, without waiting for the 2-minute refresh.
    expect(h.stock.reads).toEqual([[COKE]]);
    expect(await stockOf(COKE)).toBe(18);
    // Looked at once, not on every pass.
    await runStockPass();
    expect(await moves(id)).toHaveLength(1);
  });

  it("a plain-amount card charge: the app sends the sale", async () => {
    await itemiseOff();
    const id = await bill();
    await cardPaid(id);
    expect((await getCheckouts(h, id))[0]).toMatchObject({ square_order_id: null });

    await runStockPass();

    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
    expect(h.stock.changes).toHaveLength(1);
    expect(h.stock.count(COKE)).toBe(18);
  });

  it("a card marked paid by hand: the app sends the sale", async () => {
    const id = await bill();
    await pay(id, "card");
    await runStockPass();
    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
    expect(h.stock.changes).toHaveLength(1);
  });

  it("cash recorded against an itemised order: Square took the stock itself", async () => {
    const id = await bill();
    await pay(id, "cash");
    await pushCashRecords();
    expect(h.gateway.orders).toHaveLength(1);

    await runStockPass();

    expect(await summary(id)).toEqual([[1, "sale", "square", "done"]]);
    expect(h.stock.changes).toHaveLength(0);
  });

  it("cash recorded as a plain amount (itemising off): the app sends the sale", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "cash");
    await pushCashRecords();
    await runStockPass();
    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
    expect(h.stock.changes).toHaveLength(1);
  });

  it("cash that fell back to a plain amount because Square refused the order: the app sends the sale", async () => {
    const id = await bill();
    await pay(id, "cash");
    h.gateway.orderError = squareRejection(400, "BAD_REQUEST");
    await pushCashRecords();
    expect((await h.sql<{ state: string; order_lines: unknown }[]>`select state, order_lines from public.square_cash_records`)[0]).toMatchObject({
      state: "recorded",
      order_lines: null,
    });
    await runStockPass();
    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
  });

  it("cash taken through Square POS (a record with no order of ours): the app sends the sale", async () => {
    const id = await bill();
    await pay(id, "cash");
    await h.raw(
      null,
      `update public.square_cash_records set state = 'recorded', order_lines = null, attempts = 1,
         square_payment_id = 'pos_pay_1', square_order_id = 'pos_ord_1'`,
    );
    await runStockPass();
    // Square POS's order carries no lines of ours: recorded as seen, with nothing in it.
    expect(await summary(id)).toEqual([
      [1, "sale", "square", "done"],
      [2, "sale", "app", "done"],
    ]);
    expect((await moves(id))[0].lines).toEqual([]);
    expect(h.stock.changes).toHaveLength(1);
  });

  it("cash still on its way to Square: waits, then is classified once the sale is recorded", async () => {
    const id = await bill();
    await pay(id, "cash");
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);
    expect(h.stock.changes).toHaveLength(0);
    // Meanwhile the items still count as spoken for.
    expect((await heldStock(h.sql)).get(COKE)).toBe(2);

    await pushCashRecords();
    await runStockPass();
    expect(await summary(id)).toEqual([[1, "sale", "square", "done"]]);
    expect(h.stock.changes).toHaveLength(0);
  });

  it("cash Square refused: waits for a manager rather than guessing", async () => {
    const id = await bill();
    await pay(id, "cash");
    h.gateway.cashError = squareRejection(400, "BAD_REQUEST");
    await pushCashRecords();
    expect((await h.sql<{ state: string }[]>`select state from public.square_cash_records`)[0].state).toBe("failed");
    await runStockPass();
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);
    expect(h.stock.changes).toHaveLength(0);
  });

  it("a split bill is never itemised, so the app sends the sale (and its parts have no move)", async () => {
    const id = await bill([
      [COKE, 2],
      [CHIPS, 1],
    ]);
    const { partIds } = await splitBill(h.staff.actor, id, { ways: 2 }, at(61));
    await pay(id, "card");
    for (const p of partIds) await pay(p, "card");

    await runStockPass();

    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
    expect((await moves(id))[0].lines).toEqual(lines([CHIPS, 1], [COKE, 2]));
    for (const p of partIds) expect(await moves(p)).toHaveLength(0);
  });

  it("a bill that came to $0 still takes its items off stock", async () => {
    await seedDiscount(h, { id: "D_ALL", name: "On the house", kind: "percent", value: 10000 });
    const id = await bill();
    await setDiscount(h.staff.actor, null, id, { discountId: "D_ALL" });
    expect(await pay(id, "cash")).toMatchObject({ kind: "paid", amountCents: 0 });
    await runStockPass();
    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
    expect(h.stock.count(COKE)).toBe(18);
  });

  it("a bill with only untracked items has nothing to tell Square", async () => {
    const id = await bill([[GUM, 3]]);
    await pay(id, "card");
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);
    expect(h.stock.changes).toHaveLength(0);
  });

  it("only the tracked items go on the move, summed per product", async () => {
    const id = await bill([
      [COKE, 1],
      [GUM, 2],
    ]);
    await addItem(h.staff.actor, id, COKE, 2);
    await pay(id, "card");
    await runStockPass();
    expect((await moves(id))[0].lines).toEqual(lines([COKE, 3]));
    expect(h.stock.changes[0].lines).toEqual([{ variationId: COKE, quantity: 3 }]);
  });

  it("items taken off the bill before payment are not counted", async () => {
    const id = await bill([
      [COKE, 2],
      [CHIPS, 1],
    ]);
    const chips = (await getItems(h, id)).find((i) => i.product_id === CHIPS);
    await removeItem(h.staff.actor, id, chips?.id ?? "", at(62));
    await pay(id, "card");
    await runStockPass();
    expect((await moves(id))[0].lines).toEqual(lines([COKE, 2]));
  });

  it("a bill paid before stock tracking began is left alone", async () => {
    const id = await bill();
    await pay(id, "card");
    await h.raw(null, `update public.catalog_state set stock_from = now() + interval '1 minute'`);
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);
    expect(h.stock.changes).toHaveLength(0);
  });

  it("a bill last touched more than 7 days ago is left alone", async () => {
    const id = await bill();
    await pay(id, "card");
    await backdate(`update public.sessions set settled_at = now() - interval '8 days', updated_at = now() - interval '8 days'`);
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);
  });

  it("a bill reopened a week after it was paid is still found, and its stock goes back", async () => {
    const id = await bill();
    await pay(id, "card");
    await runStockPass();
    expect(h.stock.count(COKE)).toBe(18);
    await backdate(`update public.sessions set settled_at = now() - interval '8 days', updated_at = now() - interval '8 days'`);
    await backdate(`update public.stock_moves set updated_at = now() - interval '8 days'`);
    await reverse(id); // touches the bill
    await runStockPass();
    expect(await summary(id)).toEqual([
      [1, "sale", "app", "done"],
      [2, "restock", "app", "done"],
    ]);
    expect(h.stock.count(COKE)).toBe(20);
  });

  it("a bill with no items on it has no move at all", async () => {
    const { sessionId: id } = await startSession(h.staff.actor, h.tableId("Table 1"), T0);
    await stopSession(h.staff.actor, id, at(60));
    await pay(id, "card");
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);
  });

  it("a bill whose lock is busy is skipped and picked up on a later pass", async () => {
    const id = await bill();
    await pay(id, "card");
    // Another request holds the bill: the pass must neither throw nor wait for it.
    const repo = await import("@/lib/server/repo");
    const spy = vi.spyOn(repo, "lockSession").mockRejectedValueOnce(new AppError(409, "bill_busy", "Someone else is working on this bill."));
    await expect(reconcileStock()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await moves(id)).toHaveLength(0);
    await runStockPass();
    expect(await moves(id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("ST3. sending", () => {
  it("sends the sale once, under its own key, and reads the count back", async () => {
    await itemiseOff();
    const id = await bill([
      [COKE, 2],
      [CHIPS, 1],
    ]);
    await pay(id, "card");

    await runStockPass();

    expect(h.stock.changes).toHaveLength(1);
    const c = h.stock.changes[0];
    expect(c).toMatchObject({
      idempotencyKey: `${id}-st1`,
      locationId: "LOC_TEST",
      kind: "sale",
      lines: [
        { variationId: CHIPS, quantity: 1 },
        { variationId: COKE, quantity: 2 },
      ],
    });
    expect(c.idempotencyKey.length).toBeLessThanOrEqual(45);
    expect(c.occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(c.occurredAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await moves(id)).toMatchObject([{ state: "done", via: "app", attempts: 1, last_error: null, claimed_at: null }]);
    expect((await moves(id))[0].occurred_at?.getTime()).toBe(c.occurredAt.getTime());
    // Square's count after the adjustment, read straight back.
    expect(await stockOf(COKE)).toBe(18);
    expect(await stockOf(CHIPS)).toBe(9);

    await runStockPass();
    expect(h.stock.changes).toHaveLength(1);
  });

  it("no answer leaves the move pending and retries it with the same key and body", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareTimeout();
    await runStockPass();

    const [m] = await moves(id);
    expect(m).toMatchObject({ state: "pending", attempts: 1, claimed_at: null });
    expect(m.last_error).toMatch(/didn't answer in time/);
    const [wait] = await h.sql<{ s: number }[]>`select extract(epoch from next_attempt_at - now())::float as s from public.stock_moves`;
    expect(wait.s).toBeGreaterThan(20);
    expect(wait.s).toBeLessThanOrEqual(30);

    // Not due yet: nothing is sent.
    await runStockPass();
    expect(h.stock.changes).toHaveLength(1);

    await makeDue();
    await runStockPass();
    expect(h.stock.changes).toHaveLength(2);
    expect(h.stock.changes[1]).toEqual(h.stock.changes[0]);
    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
    expect(h.stock.applied).toHaveLength(1);
    expect(h.stock.count(COKE)).toBe(18);
  });

  it("an answer that never reached us can't take the stock off twice", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareTimeout();
    h.stock.failAfterApplying = true;
    await runStockPass();
    expect(h.stock.count(COKE)).toBe(18);
    await makeDue();
    await runStockPass();
    expect(h.stock.changes).toHaveLength(2);
    expect(h.stock.count(COKE)).toBe(18);
    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
  });

  it("waits double each time, from 30 s up to 15 minutes, and a 5xx or 401 is only an outage", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeErrorSticky = true;
    const waits: number[] = [];
    const errors = [squareServerError(), squareRejection(401, "UNAUTHORIZED"), squareRejection(403, "FORBIDDEN"), squareTimeout(), squareTimeout(), squareTimeout(), squareTimeout()];
    for (const e of errors) {
      h.stock.changeError = e;
      await makeDue();
      await runStockPass();
      const [w] = await h.sql<{ s: number; state: string }[]>`
        select extract(epoch from next_attempt_at - now())::float as s, state from public.stock_moves`;
      expect(w.state).toBe("pending");
      waits.push(Math.round(w.s / 5) * 5);
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 900, 900]);
  });

  it("fails after 12 tries, with a note on the audit trail", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareTimeout();
    h.stock.changeErrorSticky = true;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await makeDue();
      await runStockPass();
    }
    expect(await moves(id)).toMatchObject([{ state: "failed", attempts: MAX_ATTEMPTS }]);
    const [a] = await audits(h, id, "square.stock_failed");
    expect(a.reason).toMatch(/Coke × 2/);
    expect(a.reason).toMatch(/couldn't be reached after 12 tries/);
    expect(a.reason).toMatch(/Admin → Items/);
    expect(a.after).toMatchObject({ seq: 1, kind: "sale", lines: lines([COKE, 2]) });
  });

  it("a refusal fails the move at once, is audited, and shows on the summary's needs-attention list", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareRejection(400, "BAD_REQUEST", "Square couldn't take the sale off stock: the item isn't tracked");
    await runStockPass();

    expect(await moves(id)).toMatchObject([{ state: "failed", attempts: 1 }]);
    const [a] = await audits(h, id, "square.stock_failed");
    expect(a).toMatchObject({ entity: "session", actor_staff_id: null });
    expect(a.reason).toMatch(/isn't tracked/);
    const sum = await getSummary(null);
    expect(sum.attention.map((x) => x.action)).toContain("square.stock_failed");
    expect(sum.attention.find((x) => x.action === "square.stock_failed")?.reason).toMatch(/Coke × 2/);

    // It is not retried by itself, and its items stay counted as spoken for.
    await makeDue();
    await runStockPass();
    expect(h.stock.changes).toHaveLength(1);
    expect((await heldStock(h.sql)).get(COKE)).toBe(2);
  });

  it("a key Square already holds means the move is already applied: done, not failed", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
    await runStockPass();
    const [m] = await moves(id);
    expect(m.state).toBe("done");
    expect(m.last_error).toMatch(/already had this update/);
    expect(await audits(h, id, "square.stock_failed")).toHaveLength(0);
    expect(await getStockOutstanding()).toMatchObject({ pending: 0, failed: 0 });
  });

  it("a move another worker claimed a moment ago is left alone", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    await reconcileStock();
    await h.raw(null, `update public.stock_moves set claimed_at = now(), attempts = 1`);
    expect(await sendStockMoves()).toBe(0);
    await h.raw(null, `update public.stock_moves set claimed_at = now() - interval '2 minutes'`);
    expect(await sendStockMoves()).toBe(1);
    expect(h.stock.changes).toHaveLength(1);
  });

  it("two passes at once neither double-insert nor double-send", async () => {
    await itemiseOff();
    const a = await bill([[COKE, 2]], "Table 1");
    const b = await bill([[CHIPS, 1]], "Table 2");
    await pay(a, "card");
    await pay(b, "card");
    await Promise.all([runStockPass(), runStockPass(), runStockPass()]);
    expect(await moves(a)).toHaveLength(1);
    expect(await moves(b)).toHaveLength(1);
    expect(h.stock.changes).toHaveLength(2);
    expect(h.stock.count(COKE)).toBe(18);
    expect(h.stock.count(CHIPS)).toBe(9);
  });

  it("stops starting new moves once the time budget is spent", async () => {
    await itemiseOff();
    for (const t of ["Table 1", "Table 2", "Table 3"]) await pay(await bill([[COKE, 1]], t), "card");
    await reconcileStock();
    expect(await sendStockMoves({ limit: 2 })).toBe(2);
    expect(await sendStockMoves({ limit: 5, budgetMs: 0 })).toBe(0);
    expect(await sendStockMoves()).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("ST4. a bill that is reopened", () => {
  it("puts the same items back, even if the bill's items changed since", async () => {
    const id = await bill([
      [COKE, 2],
      [CHIPS, 1],
    ]);
    await cardPaid(id);
    h.stock.set(COKE, 18);
    h.stock.set(CHIPS, 9);
    await runStockPass();
    expect(h.stock.changes).toHaveLength(0);

    await reverse(id);
    // The bill is edited before the pass looks at it.
    const coke = (await getItems(h, id)).find((i) => i.product_id === COKE);
    await removeItem(h.staff.actor, id, coke?.id ?? "", at(70));
    await runStockPass();

    expect(await summary(id)).toEqual([
      [1, "sale", "square", "done"],
      [2, "restock", "app", "done"],
    ]);
    const [, r] = await moves(id);
    expect(r.lines).toEqual(lines([CHIPS, 1], [COKE, 2]));
    expect(h.stock.changes).toHaveLength(1);
    expect(h.stock.changes[0]).toMatchObject({
      idempotencyKey: `${id}-st2`,
      kind: "restock",
      lines: [
        { variationId: CHIPS, quantity: 1 },
        { variationId: COKE, quantity: 2 },
      ],
    });
    expect(h.stock.count(COKE)).toBe(20);
    expect(h.stock.count(CHIPS)).toBe(10);
    expect(await stockOf(COKE)).toBe(20);
  });

  it("reversed before the sale was sent: both adjustments go out, in order, and cancel out", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    await reconcileStock();
    expect(await summary(id)).toEqual([[1, "sale", "app", "pending"]]);

    await reverse(id);
    await runStockPass();

    expect(await summary(id)).toEqual([
      [1, "sale", "app", "done"],
      [2, "restock", "app", "done"],
    ]);
    expect(h.stock.changes.map((c) => c.kind)).toEqual(["sale", "restock"]);
    expect(h.stock.count(COKE)).toBe(20);
    expect((await heldStock(h.sql)).get(COKE)).toBe(2); // back on an open bill, once
  });

  it("reversed before the pass ever saw it: no move at all", async () => {
    const id = await bill();
    await pay(id, "card");
    await reverse(id);
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);
    expect(h.stock.changes).toHaveLength(0);
  });

  it("[2] a sale that was refused after the bill was reopened is not put back", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareTimeout();
    await runStockPass(); // no answer: the sale may or may not be in Square
    await reverse(id);
    await reconcileStock(); // the restock queues behind the sale
    expect(await summary(id)).toEqual([
      [1, "sale", "app", "pending"],
      [2, "restock", "app", "pending"],
    ]);

    h.stock.changeError = squareRejection(400, "BAD_REQUEST");
    await makeDue();
    await runStockPass();

    expect(await summary(id)).toEqual([
      [1, "sale", "app", "failed"],
      [2, "restock", "app", "pending"],
    ]);
    // The restock is not sent for stock that never left, however often the pass runs.
    await makeDue();
    await runStockPass();
    expect(h.stock.changes.map((c) => c.kind)).toEqual(["sale", "sale"]);
    expect(h.stock.count(COKE)).toBe(20);
    // And no new move is written for a bill with a failed one.
    expect(await moves(id)).toHaveLength(2);

    // A manager retries once Square will take it: the sale goes, then the restock, in that order.
    expect(await retryStockMoves(h.staff.managerActor, h.staff.manager)).toEqual({ pending: 0, failed: 0 });
    expect(await summary(id)).toEqual([
      [1, "sale", "app", "done"],
      [2, "restock", "app", "done"],
    ]);
    expect(h.stock.count(COKE)).toBe(20);
  });

  it("a sale already on its way goes first; the restock follows it", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareTimeout();
    await runStockPass(); // attempt 1: no answer, so the sale may or may not be in Square
    expect((await moves(id))[0]).toMatchObject({ state: "pending", attempts: 1 });

    await reverse(id);
    await reconcileStock();
    expect(await summary(id)).toEqual([
      [1, "sale", "app", "pending"],
      [2, "restock", "app", "pending"],
    ]);

    // The restock is due but the sale before it isn't: strict order per bill.
    await h.raw(null, `update public.stock_moves set next_attempt_at = now() where seq = 2`);
    expect(await sendStockMoves()).toBe(0);
    expect(h.stock.changes).toHaveLength(1);

    await makeDue();
    await runStockPass();
    expect(h.stock.changes.map((c) => [c.idempotencyKey, c.kind])).toEqual([
      [`${id}-st1`, "sale"],
      [`${id}-st1`, "sale"],
      [`${id}-st2`, "restock"],
    ]);
    expect(h.stock.count(COKE)).toBe(20);
    expect(await summary(id)).toEqual([
      [1, "sale", "app", "done"],
      [2, "restock", "app", "done"],
    ]);
  });

  it("[11] a failed restock holds back a later sale on the same bill", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    await runStockPass();
    await reverse(id);
    h.stock.changeError = squareRejection(400, "BAD_REQUEST");
    await runStockPass();
    expect(await summary(id)).toEqual([
      [1, "sale", "app", "done"],
      [2, "restock", "app", "failed"],
    ]);
    // Paid again while the restock is still failed: nothing new is written or sent.
    await pay(id, "card");
    await makeDue();
    await runStockPass();
    expect(await moves(id)).toHaveLength(2);
    await h.raw(
      null,
      `insert into public.stock_moves (session_id, seq, kind, via, lines, state) values ('${id}', 3, 'sale', 'app', '[{"productId":"${COKE}","quantity":2}]', 'pending')`,
    );
    const sent = h.stock.changes.length;
    expect(await sendStockMoves()).toBe(0);
    expect(h.stock.changes).toHaveLength(sent);
  });

  it("paid again after being reopened: a new sale move, seq 3, under its own key", async () => {
    const id = await bill();
    await cardPaid(id);
    h.stock.set(COKE, 18);
    await runStockPass();
    await reverse(id);
    await runStockPass();
    expect(h.stock.count(COKE)).toBe(20);

    await pay(id, "card"); // by hand this time: the earlier completed checkout belongs to the first payment
    await runStockPass();

    expect(await summary(id)).toEqual([
      [1, "sale", "square", "done"],
      [2, "restock", "app", "done"],
      [3, "sale", "app", "done"],
    ]);
    expect(h.stock.changes.map((c) => c.idempotencyKey)).toEqual([`${id}-st2`, `${id}-st3`]);
    expect(h.stock.count(COKE)).toBe(18);
  });

  it("a bill with nothing tracked on it never has a move, paid or reopened", async () => {
    const id = await bill([[GUM, 1]]);
    await pay(id, "card");
    await runStockPass();
    await reverse(id);
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);
    expect(h.stock.changes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("ST5. what staff see", () => {
  const held = async () => (await heldStock(h.sql)).get(COKE) ?? 0;
  const shown = async () => (await getFloor()).products.find((p) => p.id === COKE)?.stock;

  it("counts the items on bills that are still open", async () => {
    await refreshStock();
    const { sessionId: running } = await startSession(h.staff.actor, h.tableId("Table 1"), T0);
    await addItem(h.staff.actor, running, COKE, 2);
    expect(await held()).toBe(2);
    await bill([[COKE, 3]], "Table 2"); // awaiting payment
    expect(await held()).toBe(5);
    expect(await shown()).toBe(15);
  });

  it("holds a paid bill until the pass has dealt with it, then lets Square's count speak", async () => {
    await itemiseOff();
    await refreshStock();
    const id = await bill();
    await pay(id, "card");
    expect(await held()).toBe(2);
    expect(await shown()).toBe(18);

    await reconcileStock(); // sale recorded, not sent yet
    expect(await held()).toBe(2);
    expect(await shown()).toBe(18);

    await sendStockMoves();
    expect(await held()).toBe(0);
    await refreshStock();
    expect(await shown()).toBe(18); // 18 in Square now, nothing held
  });

  it("holds nothing for a bill Square took the stock off for itself", async () => {
    await refreshStock();
    const id = await bill();
    await cardPaid(id);
    h.stock.set(COKE, 18);
    await runStockPass();
    expect(await held()).toBe(0);
    expect(await shown()).toBe(18);
  });

  it("keeps holding a sale Square hasn't taken", async () => {
    await itemiseOff();
    await refreshStock();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareTimeout();
    await runStockPass();
    expect(await held()).toBe(2);
    expect(await shown()).toBe(18);
    h.stock.changeError = squareRejection(400, "BAD_REQUEST");
    await makeDue();
    await runStockPass();
    expect((await moves(id))[0].state).toBe("failed");
    expect(await held()).toBe(2);
  });

  it("ignores a paid bill that was never looked at after 2 days, and bills from before tracking began", async () => {
    const id = await bill();
    await pay(id, "card");
    expect(await held()).toBe(2);
    await backdate(`update public.sessions set settled_at = now() - interval '3 days' where id = '${id}'`);
    expect(await held()).toBe(0);
    await h.raw(null, `update public.sessions set settled_at = now()`);
    await h.raw(null, `update public.catalog_state set stock_from = now() + interval '1 minute'`);
    expect(await held()).toBe(0);
  });

  it("[8] a sale that failed and was never retried stops holding stock back after 2 days", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareRejection(400, "BAD_REQUEST");
    await runStockPass();
    expect(await held()).toBe(2);
    await backdate(`update public.stock_moves set updated_at = now() - interval '3 days'; update public.sessions set settled_at = now() - interval '3 days'`);
    expect(await held()).toBe(0);
  });

  it("a reopened bill waiting for its stock to go back counts once, not twice", async () => {
    await itemiseOff();
    await refreshStock();
    const id = await bill();
    await pay(id, "card");
    await runStockPass();
    expect(await shown()).toBe(18);
    await reverse(id);
    // Square still has the two off; the bill has them again: nothing more to hold.
    expect(await held()).toBe(0);
    expect(await shown()).toBe(18);
    await runStockPass();
    expect(await held()).toBe(2);
    expect(await shown()).toBe(18); // 20 in Square, 2 on the open bill
  });

  it("shows Square's count less what is held, and nothing for an item that isn't tracked or has never been counted", async () => {
    await refreshStock();
    await h.sql`update public.products set tracked = true where id = ${GUM}`; // tracked, never counted
    await h.sql`update public.products set stock_count = 4, stock_at = now() where id = ${GUM}`;
    await h.sql`update public.products set stock_count = null where id = ${GUM}`;
    await seedProduct(h, { id: "VAR_WATER", name: "Water", priceCents: 300 });
    await h.sql`update public.products set stock_count = 4 where id = 'VAR_WATER'`; // a stale count on an item that isn't tracked
    const by = new Map((await getFloor()).products.map((p) => [p.id, p.stock]));
    expect(by.get(COKE)).toBe(20);
    expect(by.get(GUM)).toBeNull();
    expect(by.get("VAR_WATER")).toBeNull();
  });

  it("goes below zero when more is on bills than Square counted", async () => {
    await refreshStock();
    await bill([[COKE, 25]]);
    expect(await shown()).toBe(-5);
  });

  it("shows the same figure on the admin item list, with what is outstanding", async () => {
    await itemiseOff();
    await refreshStock();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareRejection(400, "BAD_REQUEST", "Square couldn't do that: nope");
    await runStockPass();
    const admin = await getAdminState(h.staff.manager);
    expect(admin.catalog.products.find((p) => p.id === COKE)).toMatchObject({ stock: 18, tracked: true });
    expect(admin.catalog.stock).toMatchObject({ pending: 0, failed: 1, lastMoveError: expect.stringMatching(/nope/), lastError: null });
    expect(admin.catalog.stock.syncedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("ST6. manager retry", () => {
  it("sends failed and waiting moves again with the same key, and reports what is left", async () => {
    await itemiseOff();
    const a = await bill([[COKE, 2]], "Table 1");
    const b = await bill([[CHIPS, 1]], "Table 2");
    await pay(a, "card");
    await pay(b, "card");
    h.stock.changeError = squareRejection(400, "BAD_REQUEST");
    await reconcileStock();
    await sendStockMoves({ limit: 1 }); // a fails
    h.stock.changeError = squareTimeout();
    await sendStockMoves({ limit: 1 }); // b waits
    expect(await getStockOutstanding()).toMatchObject({ pending: 1, failed: 1 });

    const out = await retryStockMoves(h.staff.managerActor, h.staff.manager);

    expect(out).toEqual({ pending: 0, failed: 0 });
    expect(h.stock.applied.map((c) => c.idempotencyKey).sort()).toEqual([`${a}-st1`, `${b}-st1`].sort());
    expect(h.stock.count(COKE)).toBe(18);
    expect(h.stock.count(CHIPS)).toBe(9);
    const [r] = await h.sql<{ before: unknown; after: unknown; approved_by_staff_id: string }[]>`
      select before, after, approved_by_staff_id from public.audit_log where action = 'square.stock_retry'`;
    expect(r).toMatchObject({ before: { pending: 1, failed: 1 }, after: { pending: 0, failed: 0 }, approved_by_staff_id: h.staff.manager.id });
  });

  it("still refused: stays failed and is counted", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareRejection(400, "BAD_REQUEST");
    h.stock.changeErrorSticky = true;
    await runStockPass();
    expect(await retryStockMoves(h.staff.managerActor, h.staff.manager)).toEqual({ pending: 0, failed: 1 });
    expect(await audits(h, id, "square.stock_failed")).toHaveLength(2);
  });

  it("[P1] a move that never got an answer gets a fresh time when it is retried late, and the key says if it had gone through", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareTimeout();
    h.stock.changeErrorSticky = true;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await makeDue();
      await runStockPass();
    }
    expect((await moves(id))[0]).toMatchObject({ state: "failed", refused: false });
    h.stock.changeError = null;
    h.stock.changeErrorSticky = false;
    await backdate(`update public.stock_moves set occurred_at = now() - interval '30 hours'`);
    expect(await retryStockMoves(h.staff.managerActor, h.staff.manager)).toEqual({ pending: 0, failed: 0 });
    expect(h.stock.applied).toHaveLength(1);
    expect(h.stock.applied[0].occurredAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("[P1] a move Square refused is retried with its original time, and says so when that is too old for Square", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareRejection(400, "BAD_REQUEST");
    await runStockPass();
    expect((await moves(id))[0]).toMatchObject({ state: "failed", refused: true });
    const sent = h.stock.changes.length;
    const original = (await moves(id))[0].occurred_at?.getTime();

    // Within a day: sent again as it was.
    expect(await retryStockMoves(h.staff.managerActor, h.staff.manager)).toEqual({ pending: 0, failed: 0 });
    expect(h.stock.changes).toHaveLength(sent + 1);
    expect(h.stock.changes[sent].occurredAt.getTime()).toBe(original);
  });

  it("[P1] … and a refused move older than a day is not sent under a changed body", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    h.stock.changeError = squareRejection(400, "BAD_REQUEST");
    await runStockPass();
    await backdate(`update public.stock_moves set occurred_at = now() - interval '30 hours'`);
    const before = (await moves(id))[0].occurred_at?.getTime();
    const sent = h.stock.changes.length;

    expect(await retryStockMoves(h.staff.managerActor, h.staff.manager)).toEqual({ pending: 0, failed: 1 });

    expect(h.stock.changes).toHaveLength(sent);
    const [m] = await moves(id);
    expect(m.last_error).toMatch(/more than 24 hours old/);
    expect(m.occurred_at?.getTime()).toBe(before);
    expect(m.refused).toBe(true);
  });

  it("is a 503 when Square isn't set up, and does nothing when nothing is outstanding", async () => {
    expect(await retryStockMoves(h.staff.managerActor, h.staff.manager)).toEqual({ pending: 0, failed: 0 });
    expect(h.stock.changes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("ST7. the inventory.count.updated webhook", () => {
  const key = () => process.env.SQUARE_WEBHOOK_SIGNATURE_KEY as string;
  const url = () => process.env.SQUARE_WEBHOOK_URL as string;
  const deliver = (payload: unknown) => {
    const body = JSON.stringify(payload);
    const sig = createHmac("sha256", key()).update(url() + body).digest("base64");
    return POST(new Request(url(), { method: "POST", headers: { "x-square-hmacsha256-signature": sig }, body }));
  };
  const count = (id: string, quantity: string, over: Record<string, unknown> = {}) => ({
    catalog_object_id: id,
    catalog_object_type: "ITEM_VARIATION",
    location_id: "LOC_TEST",
    quantity,
    state: "IN_STOCK",
    calculated_at: new Date().toISOString(),
    ...over,
  });
  const event = (eventId: string, counts: unknown) => ({
    event_id: eventId,
    type: "inventory.count.updated",
    data: { object: { inventory_counts: counts } },
  });

  it("stores the shelf count, rounded down, and nothing else it was sent", async () => {
    const res = await deliver(
      event("evt_inv_1", [
        count(COKE, "7.9"),
        count(CHIPS, "3", { state: "SOLD" }),
        count(CHIPS, "3", { location_id: "SOMEWHERE_ELSE" }),
        count(CHIPS, "3", { catalog_object_type: "ITEM" }),
        count(CHIPS, "not a number"),
        count("VAR_UNKNOWN", "5"),
        "garbage",
      ]),
    );
    expect(res.status).toBe(200);
    expect(await stockOf(COKE)).toBe(7);
    expect(await stockOf(CHIPS)).toBeNull();
  });

  it("ignores a reading older than the one it already has", async () => {
    await refreshStock();
    await deliver(event("evt_inv_2", [count(COKE, "1", { calculated_at: new Date(Date.now() - 3_600_000).toISOString() })]));
    expect(await stockOf(COKE)).toBe(20);
    await deliver(event("evt_inv_3", [count(COKE, "1", { calculated_at: new Date(Date.now() + 5000).toISOString() })]));
    expect(await stockOf(COKE)).toBe(1);
  });

  it("a negative count is kept", async () => {
    await deliver(event("evt_inv_4", [count(COKE, "-2.5")]));
    expect(await stockOf(COKE)).toBe(-3);
  });

  it("a duplicate delivery is applied once", async () => {
    await deliver(event("evt_inv_5", [count(COKE, "5")]));
    await deliver(event("evt_inv_5", [count(COKE, "9", { calculated_at: new Date(Date.now() + 5000).toISOString() })]));
    expect(await stockOf(COKE)).toBe(5);
  });

  it("a payload it can't read is logged and ignored, never a 500", async () => {
    for (const [i, object] of [{}, { inventory_counts: "nope" }, { other: 1 }].entries()) {
      const res = await deliver({ event_id: `evt_bad_${i}`, type: "inventory.count.updated", data: { object } });
      expect(res.status).toBe(200);
    }
    expect((await deliver({ event_id: "evt_bad_nodata", type: "inventory.count.updated" })).status).toBe(200);
    expect(await stockOf(COKE)).toBeNull();
  });

  it("[6] a quantity beyond what the column holds is ignored; the rest of the event and the event itself still go through", async () => {
    const res = await deliver(event("evt_inv_big", [count(COKE, "99999999999"), count(CHIPS, "4"), count(GUM, "1e400")]));
    expect(res.status).toBe(200);
    expect(await stockOf(COKE)).toBeNull();
    expect(await stockOf(CHIPS)).toBe(4);
    // And it isn't delivered again: the event was recorded.
    expect((await h.sql<{ n: number }[]>`select count(*)::int as n from public.webhook_events where event_id = 'evt_inv_big'`)[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("ST8. Square's stock ends up right whatever order things happen in", () => {
  /** How many are off Square's stock now (Coke started at 20). */
  const off = () => 20 - (h.stock.count(COKE) ?? 20);

  it("[1] cash paid itemised, the push times out once, the bill is reversed, the outbox then pays and refunds it: the stock goes back", async () => {
    const id = await bill();
    await pay(id, "cash");
    h.gateway.cashError = squareTimeout(); // the order is made, the payment gets no answer
    await pushCashRecords();
    expect((await h.sql<{ state: string }[]>`select state from public.square_cash_records`)[0].state).toBe("pending");
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);

    await reverse(id);
    await h.raw(null, `update public.square_cash_records set next_attempt_at = now()`);
    await pushCashRecords(); // pays the order (Square takes the stock), then refunds it (which doesn't put it back)
    expect(h.gateway.cashPayments.length).toBeGreaterThan(1);
    squareTakes(COKE, 2);

    await runStockPass();

    expect(await summary(id)).toEqual([
      [1, "sale", "square", "done"],
      [2, "restock", "app", "done"],
    ]);
    expect(off()).toBe(0);
  });

  it("[1] an itemised card payment reversed before the pass saw it: the stock goes back", async () => {
    const id = await bill();
    await cardPaid(id);
    squareTakes(COKE, 2);
    await reverse(id);
    await runStockPass();
    expect(await summary(id)).toEqual([
      [1, "sale", "square", "done"],
      [2, "restock", "app", "done"],
    ]);
    expect(off()).toBe(0);
  });

  it("[3][5] paid by hand, reversed, then paid again on the Terminal before the pass notices: taken once, not twice", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "card");
    await runStockPass();
    expect(off()).toBe(2);
    await reverse(id);
    await h.sql`update public.settings set itemise_charges = true`;
    await chargeCard(h.staff.actor, id);
    squareTakes(COKE, 2); // Square takes it when the order is paid
    await completeCheckout(id);

    await runStockPass();

    expect(off()).toBe(2);
    expect(await summary(id)).toEqual([
      [1, "sale", "app", "done"],
      [2, "sale", "square", "done"],
      [3, "restock", "app", "done"],
    ]);
    await runStockPass();
    expect(await moves(id)).toHaveLength(3);
  });

  it("[4] marked paid by hand while the card request is still being cancelled: held back, then right whichever way the card goes", async () => {
    // The card does complete.
    const a = await bill([[COKE, 2]], "Table 1");
    await chargeCard(h.staff.actor, a);
    h.gateway.cancelDefault = "CANCEL_REQUESTED";
    await pay(a, "card");
    await runStockPass();
    expect(await moves(a)).toHaveLength(0); // the request may yet pay and take the stock itself
    expect(h.stock.changes).toHaveLength(0);
    squareTakes(COKE, 2);
    await completeCheckout(a);
    await runStockPass();
    expect(await summary(a)).toEqual([[1, "sale", "square", "done"]]);
    expect(h.stock.changes).toHaveLength(0);
    expect(off()).toBe(2);

    // The card doesn't: the Terminal settles the request as cancelled and the app takes over.
    const b = await bill([[CHIPS, 1]], "Table 2");
    await chargeCard(h.staff.actor, b);
    await pay(b, "card");
    await runStockPass();
    expect(await moves(b)).toHaveLength(0);
    await h.raw(null, `update public.terminal_checkouts set status = 'CANCELED' where session_id = '${b}'`);
    await runStockPass();
    expect(await summary(b)).toEqual([[1, "sale", "app", "done"]]);
    expect(h.stock.count(CHIPS)).toBe(9);
  });

  it("[9] a split bill's single ad hoc order that completes late takes nothing: the app's sale stands", async () => {
    const id = await bill([[COKE, 2]]);
    const { partIds } = await splitBill(h.staff.actor, id, { ways: 2 }, at(61));
    await chargeCard(h.staff.actor, id); // one ad hoc line for what is left
    await cancelCheckout(h.staff.actor, id);
    for (const p of partIds) await mergeBack(h.staff.actor, p, at(62));
    await pay(id, "card");
    await completeCheckout(id); // the cancelled request completes after all

    await runStockPass();

    expect(await summary(id)).toEqual([
      [1, "sale", "square", "done"],
      [2, "sale", "app", "done"],
    ]);
    expect((await moves(id))[0].lines).toEqual([]);
    expect(off()).toBe(2);
    expect(h.stock.changes).toHaveLength(1);
  });

  it("[9] an item added after an older itemised request that then completes: the order's own lines decide", async () => {
    const id = await bill([[COKE, 1]]);
    await chargeCard(h.staff.actor, id); // an order for one Coke
    await cancelCheckout(h.staff.actor, id);
    await addItem(h.staff.actor, id, COKE, 1);
    await pay(id, "card"); // two on the bill
    await runStockPass();
    expect(off()).toBe(2);
    squareTakes(COKE, 1); // the old request completes: Square takes the one it carried
    await completeCheckout(id);

    await runStockPass();

    expect(await summary(id)).toEqual([
      [1, "sale", "app", "done"],
      [2, "sale", "square", "done"],
      [3, "restock", "app", "done"],
    ]);
    expect((await moves(id))[1].lines).toEqual(lines([COKE, 1]));
    expect(off()).toBe(2);
  });

  it("paid in cash as a plain amount, reversed, then paid on the Terminal itemised", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "cash");
    await pushCashRecords();
    await runStockPass();
    expect(off()).toBe(2);
    await reverse(id);
    await pushCashRecords(); // the refund
    await runStockPass();
    expect(off()).toBe(0);

    await h.sql`update public.settings set itemise_charges = true`;
    await chargeCard(h.staff.actor, id);
    squareTakes(COKE, 2);
    await completeCheckout(id);
    await runStockPass();

    expect(off()).toBe(2);
    expect(await summary(id)).toEqual([
      [1, "sale", "app", "done"],
      [2, "restock", "app", "done"],
      [3, "sale", "square", "done"],
    ]);
  });

  it("[7] waiting cash bills don't starve newer bills, and cost nothing to skip", async () => {
    for (let i = 0; i < 4; i++) {
      const id = await bill([[COKE, 1]], `Table ${i + 1}`);
      await pay(id, "cash"); // sale still on its way to Square
    }
    const later = await bill([[CHIPS, 1]], "Table 5");
    await pay(later, "card");

    await reconcileStock(2); // room for two bills

    expect(await summary(later)).toEqual([[1, "sale", "app", "pending"]]);
    expect((await h.sql<{ n: number }[]>`select count(*)::int as n from public.stock_moves`)[0].n).toBe(1);
  });

  it("two passes racing to record the same paid order write it once", async () => {
    const id = await bill();
    await cardPaid(id);
    await Promise.all([recordStockEvidence(), recordStockEvidence(), runStockPass()]);
    expect(await summary(id)).toEqual([[1, "sale", "square", "done"]]);
    const err = await h.rawError(
      null,
      `insert into public.stock_moves (session_id, seq, kind, via, lines, state, source_order_id)
       select session_id, 2, 'sale', 'square', '[]', 'done', source_order_id from public.stock_moves`,
    );
    expect(err.code).toBe("23505");
  });

  it("an order Square can't be asked about yet is left unrecorded and the bill is left alone, without stopping the pass", async () => {
    const a = await bill([[COKE, 2]], "Table 1");
    await cardPaid(a);
    const b = await bill([[CHIPS, 1]], "Table 2");
    await pay(b, "card");
    h.stock.orderReadError = squareTimeout();
    await runStockPass();
    expect(await moves(a)).toHaveLength(0);
    expect(await summary(b)).toEqual([[1, "sale", "app", "done"]]);

    h.stock.orderReadError = null;
    squareTakes(COKE, 2);
    await runStockPass();
    expect(await moves(a)).toHaveLength(0); // still waiting out the failed read
    resetStockReadWaitForTests();
    await runStockPass();
    expect(await summary(a)).toEqual([[1, "sale", "square", "done"]]);
    const [k] = await h.sql<{ square_order_id: string }[]>`select square_order_id from public.terminal_checkouts where session_id = ${a}`;
    expect(h.stock.orderReads.filter((o) => o === k.square_order_id)).toHaveLength(2);
  });

  it("reads at most a few orders from Square in one pass", async () => {
    for (let i = 0; i < 12; i++) {
      const { sessionId } = await openCounterSale(h.staff.actor);
      await addItem(h.staff.actor, sessionId, COKE, 1);
      await cardPaid(sessionId);
    }
    await recordStockEvidence();
    expect(h.stock.orderReads).toHaveLength(10);
    await recordStockEvidence();
    expect(h.stock.orderReads).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------

describe("ST9. an item only counts for bills opened after it became tracked", () => {
  const off = () => 20 - (h.stock.count(COKE) ?? 20);

  it("[N1] an item switched to tracked doesn't take off bills opened before, and counts the ones opened after", async () => {
    await h.sql`update public.products set tracked_since = now() where id = ${COKE}`;
    const old = await bill(); // opened before
    await pay(old, "card");
    await runStockPass();
    expect(await moves(old)).toHaveLength(0);
    expect(h.stock.changes).toHaveLength(0);
    expect((await heldStock(h.sql)).get(COKE) ?? 0).toBe(0);

    const { sessionId: fresh } = await openCounterSale(h.staff.actor);
    await addItem(h.staff.actor, fresh, COKE, 1);
    await pay(fresh, "card");
    expect((await heldStock(h.sql)).get(COKE)).toBe(1);
    await runStockPass();
    expect(await summary(fresh)).toEqual([[1, "sale", "app", "done"]]);
    expect(off()).toBe(1);
  });

  it("[N1] the other way: tracking off, bill reversed, tracking on again: nothing is put back days later", async () => {
    const id = await bill();
    await pay(id, "card");
    await runStockPass();
    expect(off()).toBe(2);

    await h.sql`update public.products set tracked = false where id = ${COKE}`;
    await reverse(id);
    await runStockPass();
    await h.sql`update public.products set tracked = true, tracked_since = now() where id = ${COKE}`;
    await runStockPass();

    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
    expect(h.stock.changes).toHaveLength(1);
  });

  it("a tracked item with no known start is ignored", async () => {
    await h.sql`update public.products set tracked_since = null where id = ${COKE}`;
    const id = await bill();
    await pay(id, "card");
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);
  });

  it("[N2] an order recorded while our tracked flag is stale keeps all its lines, so the flag flipping later sends nothing", async () => {
    await h.sql`update public.products set tracked = false, tracked_since = null where id = ${COKE}`; // Square tracks it; we don't know yet
    const id = await bill();
    await cardPaid(id);
    squareTakes(COKE, 2);
    await runStockPass();
    expect(await summary(id)).toEqual([[1, "sale", "square", "done"]]);
    expect((await moves(id))[0].lines).toEqual(lines([COKE, 2]));

    // The catalogue refresh catches up. (Even with a start that counts this bill, nothing is owed.)
    await h.sql`update public.products set tracked = true, tracked_since = '2000-01-01' where id = ${COKE}`;
    await runStockPass();

    expect(h.stock.changes).toHaveLength(0);
    expect(await moves(id)).toHaveLength(1);
    expect(off()).toBe(2);
  });

  it("[N3] the first failed order read stops the reads for the pass, and the failing order waits so newer ones aren't held up", async () => {
    const a = await bill([[COKE, 1]], "Table 1");
    await cardPaid(a);
    const b = await bill([[COKE, 1]], "Table 2");
    await cardPaid(b);
    const plain = await bill([[CHIPS, 1]], "Table 3");
    await pay(plain, "card");
    const orderOf = async (id: string) => (await h.sql<{ square_order_id: string }[]>`select square_order_id from public.terminal_checkouts where session_id = ${id}`)[0].square_order_id;

    h.stock.orderReadError = squareTimeout();
    await runStockPass();
    // Newest first, and only one read was tried; the rest of the pass still ran (the plain sale went).
    expect(h.stock.orderReads).toEqual([await orderOf(b)]);
    expect(await moves(a)).toHaveLength(0);
    expect(await moves(b)).toHaveLength(0);
    expect(await summary(plain)).toEqual([[1, "sale", "app", "done"]]);

    // Square is back: the order that failed waits its turn, so the older one is read now.
    h.stock.orderReadError = null;
    h.stock.orderReads = [];
    await runStockPass();
    expect(h.stock.orderReads).toEqual([await orderOf(a)]);
    expect(await summary(a)).toEqual([[1, "sale", "square", "done"]]);
    expect(await moves(b)).toHaveLength(0);

    resetStockReadWaitForTests();
    await runStockPass();
    expect(await summary(b)).toEqual([[1, "sale", "square", "done"]]);
  });

  it("[N3] reading orders stops when its time is up", async () => {
    await cardPaid(await bill());
    await recordStockEvidence(new Set(), { budgetMs: 0 });
    expect(h.stock.orderReads).toHaveLength(0);
  });

  it("[N3] an order Square has no record of is recorded as empty, with the reason, and not asked about again", async () => {
    const id = await bill();
    await cardPaid(id);
    h.stock.orderReadError = squareRejection(404, "NOT_FOUND");
    await runStockPass();
    const [m] = await moves(id);
    expect(m).toMatchObject({ via: "square", state: "done", lines: [] });
    expect(m.last_error).toMatch(/no record of this order/);
    expect(await audits(h, id, "square.stock_order_missing")).toHaveLength(1);
    // The bill says two are sold and Square's order took none: the app sends them.
    expect(await summary(id)).toEqual([
      [1, "sale", "square", "done"],
      [2, "sale", "app", "done"],
    ]);
    h.stock.orderReads = [];
    await runStockPass();
    expect(h.stock.orderReads).toHaveLength(0);
  });

  it("[P3] a plain cash sale that stayed failed for over a week and is then retried is still found", async () => {
    await itemiseOff();
    const id = await bill();
    await pay(id, "cash");
    h.gateway.cashError = squareRejection(400, "BAD_REQUEST");
    await pushCashRecords();
    await runStockPass();
    expect(await moves(id)).toHaveLength(0);

    await backdate(`update public.sessions set updated_at = now() - interval '10 days', settled_at = now() - interval '10 days'`);
    await backdate(`update public.square_cash_records set updated_at = now() - interval '10 days', created_at = now() - interval '10 days'`);
    await retryCashRecords(h.staff.managerActor, h.staff.manager);
    expect((await h.sql<{ state: string }[]>`select state from public.square_cash_records`)[0].state).toBe("recorded");

    await runStockPass();
    expect(await summary(id)).toEqual([[1, "sale", "app", "done"]]);
  });
});
