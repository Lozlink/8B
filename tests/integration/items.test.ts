import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { squareRejection, squareTimeout } from "./helpers/fake-gateway";
import {
  addItem,
  applyWebhookCheckout,
  cancelCheckout,
  chargeCard,
  editTimes,
  markPaid,
  pauseSession,
  removeItem,
  resendCheckout,
  startSession,
  stopSession,
  voidSession,
} from "@/lib/server/sessions";
import { withTx } from "@/lib/server/db";
import { TransitionError } from "@/lib/domain/machine";
import {
  at,
  audits,
  auditActions,
  awaitingPayment,
  getCheckouts,
  getIntervals,
  getItems,
  getSession,
  occupiedTables,
  seedProduct,
} from "./helpers/util";

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
  await seedProduct(h, { id: "VAR_CHIPS", name: "Chips", priceCents: 600 });
  await seedProduct(h, { id: "VAR_WATER", name: "Water", priceCents: 300, taxed: false });
});

const INSUFFICIENT_PRIVILEGE = "42501";
const LIVE = /Cancel the card request on the Terminal before changing the bill/;

const running = async (table = "Table 1") => (await startSession(h.staff.actor, h.tableId(table), at(0))).sessionId;
const orderOf = async (checkoutId: string) =>
  (await h.sql<{ square_order_id: string | null }[]>`select square_order_id from public.terminal_checkouts where id = ${checkoutId}`)[0]
    ?.square_order_id;

describe("I1. schema: bill items are kept and locked down", () => {
  for (const role of [null, "timer_app", "service_role", "anon", "authenticated"]) {
    const label = role ?? "superuser";
    it(`${label}: DELETE/TRUNCATE on session_items fail`, async () => {
      const id = await running();
      await addItem(h.staff.actor, id, "VAR_COKE", 1);
      for (const stmt of ["delete from public.session_items", "truncate public.session_items", "truncate public.session_items cascade"]) {
        const e = await h.rawError(role, stmt);
        expect(e.code, `${label}: ${stmt}`).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect(await getItems(h, id)).toHaveLength(1);
    });
  }

  it("superuser failure comes from the trigger", async () => {
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    expect((await h.rawError(null, "delete from public.session_items")).message).toMatch(/never deleted/);
    expect((await h.rawError(null, "truncate public.session_items")).message).toMatch(/never deleted/);
  });

  for (const role of ["anon", "authenticated"]) {
    for (const t of ["products", "catalog_state", "session_items"]) {
      it(`${role} cannot SELECT/UPDATE ${t}`, async () => {
        for (const stmt of [`select * from public.${t}`, `update public.${t} set updated_at = now()`]) {
          const e = await h.rawError(role, stmt);
          expect(e.code, `${role}: ${stmt}`).toBe(INSUFFICIENT_PRIVILEGE);
        }
      });
    }
  }

  it("RLS alone denies anon even if a table grant leaked", async () => {
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    await h.pg.exec("reset role");
    await h.pg.exec("grant select on public.products, public.catalog_state, public.session_items to anon");
    try {
      for (const t of ["products", "catalog_state", "session_items"]) {
        expect(await h.raw("anon", `select * from public.${t}`), t).toHaveLength(0);
      }
    } finally {
      await h.pg.exec("reset role");
      await h.pg.exec("revoke select on public.products, public.catalog_state, public.session_items from anon");
      await h.pg.exec("set role timer_app");
    }
  });

  it("timer_app can read and write what it needs, and nothing more", async () => {
    // select / insert / update on products and session_items (the app's own writes prove it)
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    await h.sql`update public.products set price_cents = 500 where id = 'VAR_COKE'`;
    // catalog_state: read and update only — the single row can't be added to or removed
    await h.sql`update public.catalog_state set last_error = null`;
    for (const stmt of [
      "delete from public.products",
      "delete from public.catalog_state",
      "insert into public.catalog_state (id) values (true)",
      "delete from public.session_items",
    ]) {
      const e = await h.rawError("timer_app", stmt);
      expect(e.code, stmt).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("constraints: quantity 1–99, price not negative, a removal names who and when, one catalog_state row", async () => {
    const id = await running();
    const staff = h.staff.actor.staffId;
    const insert = (qty: number, unit: number) =>
      h.sql`insert into public.session_items (session_id, product_id, name, unit_cents, quantity, taxed, added_by)
            values (${id}, 'VAR_COKE', 'Coke', ${unit}, ${qty}, true, ${staff})`;
    await expect(insert(0, 450)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(100, 450)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(1, -1)).rejects.toMatchObject({ code: "23514" });
    await insert(1, 450);
    await expect(h.sql`update public.session_items set removed_at = now()`).rejects.toMatchObject({
      code: "23514",
      constraint_name: "session_items_removal_complete",
    });
    // an item must point at a real product and a real session
    await expect(
      h.sql`insert into public.session_items (session_id, product_id, name, unit_cents, quantity, taxed, added_by)
            values (${id}, 'NOPE', 'x', 1, 1, true, ${staff})`,
    ).rejects.toMatchObject({ code: "23503" });
    // items_cents can never be negative, and neither can a total
    await expect(h.sql`update public.sessions set items_cents = -1 where id = ${id}`).rejects.toMatchObject({ code: "23514" });
    const closed = await awaitingPayment(h, "Table 2", 60);
    await expect(h.sql`update public.sessions set total_cents = -1 where id = ${closed}`).rejects.toMatchObject({ code: "23514" });
    // "total covers items" is gone on purpose (20261119000000_bill_extras.sql): with a discount or
    // a split, what is owed can be less than the items on the bill. The app keeps the identity now.
    const [gone] = await h.raw<{ n: number }>(
      null,
      `select count(*)::int as n from pg_constraint where conname = 'sessions_total_covers_items'`,
    );
    expect(gone.n).toBe(0);
    await h.sql`update public.sessions set items_cents = 9999 where id = ${closed}`;
    await h.sql`update public.sessions set items_cents = 0 where id = ${closed}`;
    expect((await h.rawError(null, "insert into public.catalog_state (id) values (false)")).code).toBe("23514");
    expect((await h.rawError(null, "insert into public.catalog_state (id) values (true)")).code).toBe("23505");
  });

  it("new columns default sensibly", async () => {
    const id = await running();
    expect((await getSession(h, id)).items_cents).toBe(0);
    const [s] = await h.sql<{ itemise_charges: boolean }[]>`select itemise_charges from public.settings`;
    expect(s.itemise_charges).toBe(true);
  });
});

describe("I2. addItem", () => {
  it("running: copies name, price and GST flag from the product and adds to items_cents only", async () => {
    const id = await running();
    const { itemId } = await addItem(h.staff.actor, id, "VAR_COKE", 2);
    await addItem(h.staff.actor, id, "VAR_WATER", 1);

    const items = await getItems(h, id);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: itemId,
      product_id: "VAR_COKE",
      name: "Coke",
      unit_cents: 450,
      quantity: 2,
      taxed: true,
      added_by: h.staff.actor.staffId,
      removed_at: null,
      removed_by: null,
    });
    expect(items[1]).toMatchObject({ product_id: "VAR_WATER", unit_cents: 300, taxed: false });

    const s = await getSession(h, id);
    expect(s.items_cents).toBe(1200);
    expect(s.total_cents).toBeNull();
    expect(s.checkout_attempt).toBe(0);
    expect(s.status).toBe("running");

    const [row] = await audits(h, id, "session.add_item");
    expect(row.entity).toBe("session");
    expect(row.actor_staff_id).toBe(h.staff.actor.staffId);
    expect(row.before).toMatchObject({ items_cents: 0, total_cents: null });
    expect(row.after).toMatchObject({
      item_id: itemId,
      product_id: "VAR_COKE",
      name: "Coke",
      unit_cents: 450,
      quantity: 2,
      items_cents: 900,
      total_cents: null,
    });
  });

  it("paused: allowed", async () => {
    const id = await running();
    await pauseSession(h.staff.actor, id, at(10));
    await addItem(h.staff.actor, id, "VAR_CHIPS", 1);
    expect((await getSession(h, id)).items_cents).toBe(600);
  });

  it("awaiting payment: the total moves with it and the attempt number is skipped", async () => {
    const id = await awaitingPayment(h, "Table 1", 60); // 2500
    await addItem(h.staff.actor, id, "VAR_COKE", 2);
    const s = await getSession(h, id);
    expect(s).toMatchObject({ items_cents: 900, total_cents: 3400, billed_minutes: 60, checkout_attempt: 1, status: "awaiting_payment" });
    const [row] = await audits(h, id, "session.add_item");
    expect(row.before).toMatchObject({ items_cents: 0, total_cents: 2500 });
    expect(row.after).toMatchObject({ items_cents: 900, total_cents: 3400 });

    // The next charge is for the new total under a key Square has never seen.
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 3400 });
    expect(h.gateway.creates[0].idempotencyKey).toBe(`${id}-a2i`);
    expect(await auditActions(h, id)).not.toContain("session.repriced");
  });

  it("a later price change in the catalogue doesn't touch what's already on the bill", async () => {
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    await h.sql`update public.products set price_cents = 999, name = 'Coke 600ml' where id = 'VAR_COKE'`;
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    const items = await getItems(h, id);
    expect(items.map((i) => [i.name, i.unit_cents])).toEqual([["Coke", 450], ["Coke 600ml", 999]]);
    expect((await getSession(h, id)).items_cents).toBe(1449);
  });

  it("refuses a paid or void bill", async () => {
    const paid = await awaitingPayment(h, "Table 1", 60);
    await markPaid(h.staff.actor, paid, "cash", { cardConfirmed: false }, at(61));
    await expect(addItem(h.staff.actor, paid, "VAR_COKE", 1)).rejects.toBeInstanceOf(TransitionError);

    const voided = await running("Table 2");
    await voidSession(h.staff.managerActor, h.staff.manager, voided, "Opened by mistake", at(5));
    await expect(addItem(h.staff.actor, voided, "VAR_COKE", 1)).rejects.toBeInstanceOf(TransitionError);

    expect(await getItems(h, paid)).toHaveLength(0);
    expect(await getItems(h, voided)).toHaveLength(0);
  });

  it("refuses while a card request is live, and works again once it's cancelled", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await expect(addItem(h.staff.actor, id, "VAR_COKE", 1)).rejects.toMatchObject({ status: 409, code: "conflict", message: expect.stringMatching(LIVE) });
    expect(await getItems(h, id)).toHaveLength(0);
    expect((await getSession(h, id)).total_cents).toBe(2500);

    await cancelCheckout(h.staff.actor, id);
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    expect((await getSession(h, id)).total_cents).toBe(2950);
  });

  it("CANCEL_REQUESTED still counts as live", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelDefault = "CANCEL_REQUESTED";
    await cancelCheckout(h.staff.actor, id);
    await expect(addItem(h.staff.actor, id, "VAR_COKE", 1)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses unknown and inactive products, bad quantities and unknown sessions", async () => {
    const id = await running();
    await seedProduct(h, { id: "VAR_OLD", name: "Old pie", priceCents: 500, active: false });
    await expect(addItem(h.staff.actor, id, "VAR_NOPE", 1)).rejects.toMatchObject({ status: 404 });
    await expect(addItem(h.staff.actor, id, "VAR_OLD", 1)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Old pie/) });
    for (const q of [0, -1, 100, 1.5, Number.NaN]) {
      await expect(addItem(h.staff.actor, id, "VAR_COKE", q), String(q)).rejects.toMatchObject({ status: 400 });
    }
    await expect(addItem(h.staff.actor, "00000000-0000-4000-8000-0000000000ff", "VAR_COKE", 1)).rejects.toMatchObject({ status: 404 });
    await expect(addItem(h.staff.actor, "not-a-uuid", "VAR_COKE", 1)).rejects.toMatchObject({ status: 404 });
    expect(await getItems(h, id)).toHaveLength(0);
    expect(await auditActions(h, id)).toEqual(["session.start"]);
  });

  it("caps a bill at 100 live lines (removed lines don't count)", async () => {
    const id = await running();
    const staff = h.staff.actor.staffId;
    await h.sql`
      insert into public.session_items (session_id, product_id, name, unit_cents, quantity, taxed, added_by)
      select ${id}, 'VAR_COKE', 'Coke', 450, 1, true, ${staff} from generate_series(1, 99)`;
    await h.sql`update public.sessions set items_cents = ${99 * 450} where id = ${id}`;
    const { itemId } = await addItem(h.staff.actor, id, "VAR_COKE", 1); // the 100th
    await expect(addItem(h.staff.actor, id, "VAR_COKE", 1)).rejects.toMatchObject({ status: 409, code: "conflict" });
    await removeItem(h.staff.actor, id, itemId);
    await addItem(h.staff.actor, id, "VAR_CHIPS", 1);
    expect((await getSession(h, id)).items_cents).toBe(99 * 450 + 600);
  });
});

describe("I3. removeItem", () => {
  it("running: keeps the row, stamps who and when, and takes it off items_cents", async () => {
    const id = await running();
    const { itemId } = await addItem(h.staff.actor, id, "VAR_COKE", 2);
    await addItem(h.staff.actor, id, "VAR_CHIPS", 1);
    await removeItem(h.staff.managerActor, id, itemId, at(15));

    const items = await getItems(h, id);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: itemId, removed_by: h.staff.managerActor.staffId });
    expect(items[0].removed_at).toEqual(at(15));
    expect(items[1].removed_at).toBeNull();
    expect((await getSession(h, id)).items_cents).toBe(600);

    const [row] = await audits(h, id, "session.remove_item");
    expect(row.actor_staff_id).toBe(h.staff.managerActor.staffId);
    expect(row.before).toMatchObject({ item_id: itemId, name: "Coke", unit_cents: 450, quantity: 2, items_cents: 1500, total_cents: null });
    expect(row.after).toMatchObject({ item_id: itemId, items_cents: 600, total_cents: null });
  });

  it("paused: allowed", async () => {
    const id = await running();
    const { itemId } = await addItem(h.staff.actor, id, "VAR_COKE", 1);
    await pauseSession(h.staff.actor, id, at(10));
    await removeItem(h.staff.actor, id, itemId);
    expect((await getSession(h, id)).items_cents).toBe(0);
  });

  it("awaiting payment: the total drops and the attempt number is skipped", async () => {
    const id = await running();
    const { itemId } = await addItem(h.staff.actor, id, "VAR_COKE", 2);
    await stopSession(h.staff.actor, id, at(60)); // 2500 + 900
    await removeItem(h.staff.actor, id, itemId);
    const s = await getSession(h, id);
    expect(s).toMatchObject({ items_cents: 0, total_cents: 2500, billed_minutes: 60, checkout_attempt: 1 });
    const [row] = await audits(h, id, "session.remove_item");
    expect(row.before).toMatchObject({ items_cents: 900, total_cents: 3400 });
    expect(row.after).toMatchObject({ items_cents: 0, total_cents: 2500 });
  });

  it("won't leave an awaiting-payment bill at $0", async () => {
    const id = await running();
    const { itemId } = await addItem(h.staff.actor, id, "VAR_COKE", 1);
    await stopSession(h.staff.actor, id, at(0)); // no table time: the bill is the Coke
    await expect(removeItem(h.staff.actor, id, itemId)).rejects.toMatchObject({
      status: 409,
      message: "That would leave nothing on the bill. Ask a manager to void it instead.",
    });
    expect((await getItems(h, id))[0].removed_at).toBeNull();
    expect((await getSession(h, id)).total_cents).toBe(450);
  });

  it("refuses an item from another bill, an unknown item and a second removal", async () => {
    const a = await running("Table 1");
    const b = await running("Table 2");
    const { itemId } = await addItem(h.staff.actor, a, "VAR_COKE", 1);
    await expect(removeItem(h.staff.actor, b, itemId)).rejects.toMatchObject({ status: 404 });
    await expect(removeItem(h.staff.actor, a, "00000000-0000-4000-8000-0000000000ff")).rejects.toMatchObject({ status: 404 });
    await expect(removeItem(h.staff.actor, a, "nonsense")).rejects.toMatchObject({ status: 404 });
    await removeItem(h.staff.actor, a, itemId);
    await expect(removeItem(h.staff.actor, a, itemId)).rejects.toMatchObject({ status: 409 });
    expect((await getSession(h, a)).items_cents).toBe(0);
    expect(await audits(h, a, "session.remove_item")).toHaveLength(1);
  });

  it("refuses a paid or void bill, and while a card request is live", async () => {
    const paid = await running("Table 1");
    const p = await addItem(h.staff.actor, paid, "VAR_COKE", 1);
    await stopSession(h.staff.actor, paid, at(60));
    await markPaid(h.staff.actor, paid, "cash", { cardConfirmed: false }, at(61));
    await expect(removeItem(h.staff.actor, paid, p.itemId)).rejects.toBeInstanceOf(TransitionError);

    const voided = await running("Table 2");
    const v = await addItem(h.staff.actor, voided, "VAR_COKE", 1);
    await voidSession(h.staff.managerActor, h.staff.manager, voided, "Opened by mistake", at(5));
    await expect(removeItem(h.staff.actor, voided, v.itemId)).rejects.toBeInstanceOf(TransitionError);

    const live = await running("Table 3");
    const l = await addItem(h.staff.actor, live, "VAR_COKE", 1);
    await stopSession(h.staff.actor, live, at(60));
    await chargeCard(h.staff.actor, live);
    await expect(removeItem(h.staff.actor, live, l.itemId)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(LIVE) });

    for (const id of [paid, voided, live]) expect((await getItems(h, id))[0].removed_at, id).toBeNull();
    expect((await getSession(h, paid)).total_cents).toBe(2950);
  });
});

describe("I4. stop and edit times with items", () => {
  it("stop: the total is table time plus items; billed minutes stay table time", async () => {
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_COKE", 2);
    await addItem(h.staff.actor, id, "VAR_WATER", 1);
    const r = await stopSession(h.staff.actor, id, at(60));
    expect(r).toEqual({ status: "awaiting_payment", billedMinutes: 60, totalCents: 3700 });
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", total_cents: 3700, items_cents: 1200, billed_minutes: 60 });
    const [row] = await audits(h, id, "session.stop");
    expect(row.after).toMatchObject({ total_cents: 3700, items_cents: 1200, table_cents: 2500, billed_minutes: 60 });
  });

  it("zero time WITH items becomes a bill for the items", async () => {
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_CHIPS", 1);
    const r = await stopSession(h.staff.actor, id, at(0));
    expect(r).toEqual({ status: "awaiting_payment", billedMinutes: 0, totalCents: 600 });
    const s = await getSession(h, id);
    expect(s).toMatchObject({ status: "awaiting_payment", total_cents: 600, items_cents: 600, billed_minutes: 0, void_reason: null });
    expect(s.current_table_id).toBe(h.tableId("Table 1"));
    expect(await auditActions(h, id)).toEqual(["session.start", "session.add_item", "session.stop"]);
  });

  it("zero time with every item taken off again still voids as no charge", async () => {
    const id = await running();
    const { itemId } = await addItem(h.staff.actor, id, "VAR_CHIPS", 1);
    await removeItem(h.staff.actor, id, itemId);
    const r = await stopSession(h.staff.actor, id, at(0));
    expect(r).toEqual({ status: "void", billedMinutes: 0, totalCents: 0 });
    expect(await getSession(h, id)).toMatchObject({ status: "void", total_cents: 0, items_cents: 0 });
    expect(await occupiedTables(h)).toEqual([]);
  });

  it("zero time without items voids exactly as before", async () => {
    const id = await running();
    expect(await stopSession(h.staff.actor, id, at(0))).toEqual({ status: "void", billedMinutes: 0, totalCents: 0 });
    expect((await getSession(h, id)).void_reason).toMatch(/No charge/);
  });

  it("editTimes re-prices the table time and keeps the items", async () => {
    const { managerActor, manager } = h.staff;
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_COKE", 2);
    await stopSession(h.staff.actor, id, at(60)); // 2500 + 900
    const [iv] = await getIntervals(h, id);
    const r = await editTimes(managerActor, manager, id, "Timer left running", [{ id: iv.id, startedAt: at(0), endedAt: at(30) }], at(120));
    expect(r.totalCents).toBe(1250 + 900);
    expect(await getSession(h, id)).toMatchObject({ total_cents: 2150, items_cents: 900, billed_minutes: 30, checkout_attempt: 1 });
    const [row] = await audits(h, id, "session.edit_times");
    expect(row.before).toMatchObject({ total_cents: 3400, billed_minutes: 60 });
    expect(row.after).toMatchObject({ total_cents: 2150, billed_minutes: 30 });

    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 2150 });
    expect(await auditActions(h, id)).not.toContain("session.repriced");
  });

  it("editTimes on a running session leaves items alone", async () => {
    const { managerActor, manager } = h.staff;
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    const [iv] = await getIntervals(h, id);
    const r = await editTimes(managerActor, manager, id, "Started late", [{ id: iv.id, startedAt: at(-10), endedAt: null }], at(20));
    expect(r.totalCents).toBeNull();
    expect(await getSession(h, id)).toMatchObject({ items_cents: 450, total_cents: null });
  });

  it("mark paid and the webhook settle the whole total", async () => {
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_COKE", 2);
    await stopSession(h.staff.actor, id, at(60));
    await chargeCard(h.staff.actor, id);
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "COMPLETED", referenceId: id, cancelReason: null, amountCents: 3400 }));
    expect(await getSession(h, id)).toMatchObject({ status: "paid", total_cents: 3400, items_cents: 900, settled_method: "card" });
    const [row] = await audits(h, id, "session.paid");
    expect(row.after).toMatchObject({ amount_cents: 3400 });
  });
});

describe("I5. itemised charge", () => {
  async function billWithItems(): Promise<{ id: string; coke: string; water: string }> {
    const id = await running();
    const coke = (await addItem(h.staff.actor, id, "VAR_COKE", 2)).itemId;
    const water = (await addItem(h.staff.actor, id, "VAR_WATER", 1)).itemId;
    await stopSession(h.staff.actor, id, at(60)); // 2500 + 900 + 300 = 3700
    return { id, coke, water };
  }

  it("creates the order with a table line and one line per item, then charges against it", async () => {
    await h.sql`update public.catalog_state set table_hire_variation_id = 'VAR_TABLE_HIRE'`;
    const { id, coke, water } = await billWithItems();
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toEqual({ kind: "sent", checkoutId: "chk_1", amountCents: 3700 });

    expect(h.gateway.orders).toHaveLength(1);
    const order = h.gateway.orders[0];
    expect(order.idempotencyKey).toBe(`${id}-o1`);
    expect(order.idempotencyKey.length).toBeLessThanOrEqual(64);
    expect(order.locationId).toBe("LOC_TEST");
    expect(order.referenceId).toBe(id);
    expect(order.lines).toEqual([
      { uid: "table", catalogObjectId: "VAR_TABLE_HIRE", name: null, quantity: 1, basePriceCents: 2500, note: expect.stringMatching(/Table 1 · 1h/) },
      { uid: coke, catalogObjectId: "VAR_COKE", name: null, quantity: 2, basePriceCents: 450, note: null },
      { uid: water, catalogObjectId: "VAR_WATER", name: null, quantity: 1, basePriceCents: 300, note: null },
    ]);

    expect(h.gateway.creates).toHaveLength(1);
    expect(h.gateway.creates[0]).toMatchObject({
      idempotencyKey: `${id}-a1i`,
      amountCents: 3700,
      orderId: "ord_1",
      deviceId: "DEVICE_TEST",
      referenceId: id,
    });
    // the Terminal note is the same text as the table line's note
    expect(h.gateway.creates[0].note).toBe(order.lines[0].note);

    const [co] = await getCheckouts(h, id);
    expect(co).toMatchObject({ id: "chk_1", attempt: 1, amount_cents: 3700, status: "PENDING", square_order_id: "ord_1" });
    const [sent] = await audits(h, id, "checkout.sent");
    expect(sent.after).toMatchObject({ checkout_id: "chk_1", attempt: 1, amount_cents: 3700, order_id: "ord_1" });
    expect(await auditActions(h, id)).not.toContain("checkout.itemise_failed");
  });

  it("without a Table hire item in Square the table line is ad hoc", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await chargeCard(h.staff.actor, id);
    expect(h.gateway.orders[0].lines).toEqual([
      { uid: "table", catalogObjectId: null, name: "Table hire", quantity: 1, basePriceCents: 2500, note: expect.stringMatching(/Table 1/) },
    ]);
  });

  it("an items-only bill has no table line; removed items aren't sent", async () => {
    const id = await running();
    const coke = (await addItem(h.staff.actor, id, "VAR_COKE", 1)).itemId;
    const chips = (await addItem(h.staff.actor, id, "VAR_CHIPS", 1)).itemId;
    await removeItem(h.staff.actor, id, chips);
    await stopSession(h.staff.actor, id, at(0));
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 450 });
    expect(h.gateway.orders[0].lines.map((l) => l.uid)).toEqual([coke]);
  });

  it("charges the price on the bill, not today's catalogue price", async () => {
    const { id } = await billWithItems();
    await h.sql`update public.products set price_cents = 9999 where id = 'VAR_COKE'`;
    await chargeCard(h.staff.actor, id);
    expect(h.gateway.orders[0].lines[1]).toMatchObject({ catalogObjectId: "VAR_COKE", basePriceCents: 450 });
    expect(h.gateway.creates[0].amountCents).toBe(3700);
  });

  it("refuses and charges nothing when Square's order total differs from ours", async () => {
    const { id } = await billWithItems();
    h.gateway.orderTotalSkewCents = 30;
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      message: expect.stringMatching(/doesn't match ours.*Admin → Items.*Square POS/),
    });
    expect(h.gateway.orders).toHaveLength(1);
    expect(h.gateway.creates).toHaveLength(0);
    expect(await getCheckouts(h, id)).toHaveLength(0);
    expect(await getSession(h, id)).toMatchObject({ checkout_attempt: 0, square_checkout_id: null, status: "awaiting_payment" });
    expect(await auditActions(h, id)).not.toContain("checkout.sent");
  });

  it("order refused by Square (4xx): falls back to a plain amount and audits why", async () => {
    const { id } = await billWithItems();
    h.gateway.orderError = squareRejection(400, "INVALID_VALUE", "Square couldn't itemise the bill: item not found");
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toEqual({ kind: "sent", checkoutId: "chk_1", amountCents: 3700 });

    expect(h.gateway.creates).toHaveLength(1);
    expect(h.gateway.creates[0]).toMatchObject({ idempotencyKey: `${id}-a1p`, amountCents: 3700 });
    expect(h.gateway.creates[0].orderId).toBeUndefined();
    expect(h.gateway.creates[0].idempotencyKey.length).toBeLessThanOrEqual(64);
    expect(await orderOf("chk_1")).toBeNull();

    const [failed] = await audits(h, id, "checkout.itemise_failed");
    expect(failed.actor_staff_id).toBe(h.staff.actor.staffId);
    expect(failed.reason).toMatch(/item not found/);
    expect(failed.after).toMatchObject({ attempt: 1, stage: "order", order_id: null, amount_cents: 3700, square: { status: 400, codes: ["INVALID_VALUE"] } });
    const [sent] = await audits(h, id, "checkout.sent");
    expect(sent.after).toMatchObject({ checkout_id: "chk_1", amount_cents: 3700, order_id: null });
    expect((await getSession(h, id)).checkout_attempt).toBe(1);
  });

  it("order-linked checkout refused (4xx): retries plain under a different key", async () => {
    const { id } = await billWithItems();
    h.gateway.orderCheckoutError = squareRejection(400, "BAD_REQUEST", "Square couldn't send the charge to the Terminal: order not supported");
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 3700 });

    expect(h.gateway.orders).toHaveLength(1);
    expect(h.gateway.creates.map((c) => [c.idempotencyKey, c.orderId])).toEqual([
      [`${id}-a1i`, "ord_1"],
      [`${id}-a1p`, undefined],
    ]);
    expect(await orderOf("chk_1")).toBeNull();
    const [failed] = await audits(h, id, "checkout.itemise_failed");
    expect(failed.after).toMatchObject({ stage: "checkout", order_id: "ord_1" });
    expect(await getCheckouts(h, id)).toHaveLength(1);
  });

  it("order timeout: no fallback, nothing recorded, and the retry reuses the same keys", async () => {
    const { id } = await billWithItems();
    h.gateway.orderError = squareTimeout();
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 502, code: "square_error" });
    expect(h.gateway.creates).toHaveLength(0);
    expect(await getCheckouts(h, id)).toHaveLength(0);
    expect((await getSession(h, id)).checkout_attempt).toBe(0);
    expect(await auditActions(h, id)).not.toContain("checkout.itemise_failed");

    const retry = await chargeCard(h.staff.actor, id);
    expect(retry.kind).toBe("sent");
    expect(h.gateway.orders.map((o) => o.idempotencyKey)).toEqual([`${id}-o1`, `${id}-o1`]);
    expect(h.gateway.creates[0]).toMatchObject({ idempotencyKey: `${id}-a1i`, orderId: "ord_1" });
    expect((await getSession(h, id)).checkout_attempt).toBe(1);
  });

  it("checkout timeout after the order was made: no fallback; the retry gets the same order and key", async () => {
    const { id } = await billWithItems();
    h.gateway.orderCheckoutError = squareTimeout();
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 502 });
    expect(h.gateway.creates).toHaveLength(1);
    expect(await getCheckouts(h, id)).toHaveLength(0);
    expect((await getSession(h, id)).checkout_attempt).toBe(0);

    await chargeCard(h.staff.actor, id);
    expect(h.gateway.orders.map((o) => o.idempotencyKey)).toEqual([`${id}-o1`, `${id}-o1`]);
    expect(h.gateway.creates.map((c) => [c.idempotencyKey, c.orderId])).toEqual([
      [`${id}-a1i`, "ord_1"],
      [`${id}-a1i`, "ord_1"],
    ]);
    expect(await orderOf("chk_1")).toBe("ord_1");
  });

  it("5xx and rate limiting are not rejections: no fallback", async () => {
    const { id } = await billWithItems();
    for (const status of [500, 503, 429, 408]) {
      h.gateway.orderError = squareRejection(status, "ERR");
      await expect(chargeCard(h.staff.actor, id), String(status)).rejects.toMatchObject({ status: 502 });
    }
    expect(h.gateway.creates).toHaveLength(0);
    expect(await auditActions(h, id)).not.toContain("checkout.itemise_failed");
  });

  it("if the plain fallback fails too, nothing is recorded and the attempt isn't consumed", async () => {
    const { id } = await billWithItems();
    h.gateway.orderError = squareRejection();
    h.gateway.createError = squareTimeout();
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 502 });
    expect(await getCheckouts(h, id)).toHaveLength(0);
    expect((await getSession(h, id)).checkout_attempt).toBe(0);
  });

  it("itemise off: exactly a plain amount for the whole total, no order", async () => {
    await h.sql`update public.settings set itemise_charges = false`;
    const { id } = await billWithItems();
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toEqual({ kind: "sent", checkoutId: "chk_1", amountCents: 3700 });
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.creates).toHaveLength(1);
    expect(h.gateway.creates[0]).toEqual({
      idempotencyKey: `${id}-a1`,
      amountCents: 3700,
      deviceId: "DEVICE_TEST",
      referenceId: id,
      note: expect.stringMatching(/Table 1/),
    });
    expect(await orderOf("chk_1")).toBeNull();
    const [sent] = await audits(h, id, "checkout.sent");
    expect(sent.after).toMatchObject({ order_id: null, amount_cents: 3700 });
  });

  it("resend after a cancel makes a fresh order and checkout", async () => {
    const { id } = await billWithItems();
    await chargeCard(h.staff.actor, id);
    const out = await resendCheckout(h.staff.actor, id);
    expect(out).toEqual({ kind: "sent", checkoutId: "chk_2", amountCents: 3700 });
    expect(h.gateway.cancels).toEqual(["chk_1"]);
    expect(h.gateway.orders.map((o) => o.idempotencyKey)).toEqual([`${id}-o1`, `${id}-o2`]);
    expect(h.gateway.creates.map((c) => [c.idempotencyKey, c.orderId])).toEqual([
      [`${id}-a1i`, "ord_1"],
      [`${id}-a2i`, "ord_2"],
    ]);
    const cos = await getCheckouts(h, id);
    expect(cos.map((c) => [c.id, c.status, c.square_order_id])).toEqual([
      ["chk_1", "CANCELED", "ord_1"],
      ["chk_2", "PENDING", "ord_2"],
    ]);
  });

  it("changing the bill after a cancelled charge sends a new order under new keys", async () => {
    const { id, water } = await billWithItems();
    await chargeCard(h.staff.actor, id);
    await cancelCheckout(h.staff.actor, id);
    await removeItem(h.staff.actor, id, water); // attempt 1 used, 2 skipped
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 3400 });
    expect(h.gateway.orders[1].idempotencyKey).toBe(`${id}-o3`);
    expect(h.gateway.orders[1].lines.map((l) => l.catalogObjectId)).toEqual([null, "VAR_COKE"]);
    expect(h.gateway.creates[1]).toMatchObject({ idempotencyKey: `${id}-a3i`, amountCents: 3400, orderId: "ord_2" });
  });
});

describe("I6. idempotency keys say which kind of request it was", () => {
  const KEY_MESSAGE = /Square already has a card request for this bill that the app didn't record/;
  const liveCount = async (id: string) => (await getCheckouts(h, id)).filter((c) => c.status !== "CANCELED" && c.status !== "COMPLETED").length;

  async function bill(): Promise<string> {
    const id = await running();
    await addItem(h.staff.actor, id, "VAR_COKE", 2);
    await stopSession(h.staff.actor, id, at(60)); // 2500 + 900
    return id;
  }

  /** The charge reaches Square and is created there, but the answer never comes back. */
  async function chargeThatTimesOutAfterSquareCreatedIt(id: string): Promise<void> {
    h.gateway.failAfterCreating = true;
    h.gateway.createError = squareTimeout();
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 502 });
    h.gateway.failAfterCreating = false;
    expect(await getCheckouts(h, id)).toHaveLength(0);
    expect((await getSession(h, id)).checkout_attempt).toBe(0);
  }

  it("itemised, plain and fallback checkouts never share a key", async () => {
    const a = await bill();
    await chargeCard(h.staff.actor, a);
    expect(h.gateway.creates[0].idempotencyKey).toBe(`${a}-a1i`);

    await h.sql`update public.settings set itemise_charges = false`;
    const b = await awaitingPayment(h, "Table 2", 60);
    await chargeCard(h.staff.actor, b);
    expect(h.gateway.creates[1].idempotencyKey).toBe(`${b}-a1`);

    await h.sql`update public.settings set itemise_charges = true`;
    const c = await awaitingPayment(h, "Table 3", 60);
    h.gateway.orderError = squareRejection();
    await chargeCard(h.staff.actor, c);
    expect(h.gateway.creates[2].idempotencyKey).toBe(`${c}-a1p`);
    for (const k of h.gateway.creates.map((x) => x.idempotencyKey)) expect(k.length).toBeLessThanOrEqual(64);
  });

  it("itemise switched ON between a timed-out plain charge and its retry: itemised under its own key, no fallback", async () => {
    await h.sql`update public.settings set itemise_charges = false`;
    const id = await bill();
    await chargeThatTimesOutAfterSquareCreatedIt(id);
    await h.sql`update public.settings set itemise_charges = true`;

    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 3400 });
    expect(h.gateway.creates.map((c) => [c.idempotencyKey, c.orderId])).toEqual([
      [`${id}-a1`, undefined],
      [`${id}-a1i`, "ord_1"],
    ]);
    const actions = await auditActions(h, id);
    expect(actions).not.toContain("checkout.itemise_failed");
    expect(actions).not.toContain("checkout.key_conflict");
    expect(await liveCount(id)).toBe(1);
  });

  it("itemise switched OFF between a timed-out itemised charge and its retry: plain under its own key, no fallback", async () => {
    const id = await bill();
    await chargeThatTimesOutAfterSquareCreatedIt(id);
    await h.sql`update public.settings set itemise_charges = false`;

    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 3400 });
    expect(h.gateway.creates.map((c) => [c.idempotencyKey, c.orderId])).toEqual([
      [`${id}-a1i`, "ord_1"],
      [`${id}-a1`, undefined],
    ]);
    const actions = await auditActions(h, id);
    expect(actions).not.toContain("checkout.itemise_failed");
    expect(actions).not.toContain("checkout.key_conflict");
    expect(await liveCount(id)).toBe(1);
  });

  it("the order changing between retries (Table hire linked by a sync) sends nothing, skips the attempt, and the next charge works", async () => {
    const id = await bill();
    await chargeThatTimesOutAfterSquareCreatedIt(id); // order o1 exists with an ad hoc table line
    await h.sql`update public.catalog_state set table_hire_variation_id = 'VAR_TABLE_HIRE'`;

    const before = h.gateway.creates.length;
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 409, code: "conflict", message: expect.stringMatching(KEY_MESSAGE) });
    // nothing further went to the Terminal — in particular, no plain fallback
    expect(h.gateway.creates).toHaveLength(before);
    expect(await getCheckouts(h, id)).toHaveLength(0);

    // the skipped attempt and its audit row were committed even though the call failed
    const s = await getSession(h, id);
    expect(s).toMatchObject({ checkout_attempt: 1, square_checkout_id: null, status: "awaiting_payment", total_cents: 3400 });
    const [row] = await audits(h, id, "checkout.key_conflict");
    expect(row.actor_staff_id).toBe(h.staff.actor.staffId);
    expect(row.after).toMatchObject({ attempt: 1, stage: "order", amount_cents: 3400 });
    expect(await auditActions(h, id)).not.toContain("checkout.itemise_failed");

    // not stuck: the next try uses fresh keys and goes through itemised
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", amountCents: 3400 });
    expect(h.gateway.orders.at(-1)).toMatchObject({ idempotencyKey: `${id}-o2` });
    expect(h.gateway.orders.at(-1)?.lines[0]).toMatchObject({ uid: "table", catalogObjectId: "VAR_TABLE_HIRE" });
    expect(h.gateway.creates.at(-1)).toMatchObject({ idempotencyKey: `${id}-a2i`, orderId: "ord_2" });
    expect(await liveCount(id)).toBe(1);
  });

  for (const [stage, arm] of [
    ["order", () => (h.gateway.orderError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED"))],
    ["checkout", () => (h.gateway.orderCheckoutError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED"))],
  ] as const) {
    it(`a reused key at the ${stage} stage is never treated as "Square refused the itemised version"`, async () => {
      const id = await bill();
      arm();
      await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(KEY_MESSAGE) });
      expect(h.gateway.creates.filter((c) => !c.orderId)).toHaveLength(0);
      expect(h.gateway.creates.some((c) => c.idempotencyKey.endsWith("p"))).toBe(false);
      expect(await getCheckouts(h, id)).toHaveLength(0);
      expect((await getSession(h, id)).checkout_attempt).toBe(1);
      const [row] = await audits(h, id, "checkout.key_conflict");
      expect(row.after).toMatchObject({ attempt: 1, stage });
      expect(await auditActions(h, id)).not.toContain("checkout.itemise_failed");
      expect((await chargeCard(h.staff.actor, id)).kind).toBe("sent");
    });
  }

  it("a reused key on a plain charge (itemise off) is handled the same way", async () => {
    await h.sql`update public.settings set itemise_charges = false`;
    const id = await bill();
    h.gateway.createError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(KEY_MESSAGE) });
    expect(h.gateway.creates).toHaveLength(1);
    expect((await getSession(h, id)).checkout_attempt).toBe(1);
    expect((await audits(h, id, "checkout.key_conflict"))[0].after).toMatchObject({ attempt: 1, stage: "plain" });
    await chargeCard(h.staff.actor, id);
    expect(h.gateway.creates[1].idempotencyKey).toBe(`${id}-a2`);
  });

  it("a reused key on the plain fallback stops there: one refusal audit, one key-conflict audit, nothing live", async () => {
    const id = await bill();
    h.gateway.orderError = squareRejection(400, "INVALID_VALUE");
    h.gateway.createError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(KEY_MESSAGE) });
    expect(h.gateway.creates.map((c) => c.idempotencyKey)).toEqual([`${id}-a1p`]);
    expect(await audits(h, id, "checkout.itemise_failed")).toHaveLength(1);
    expect((await audits(h, id, "checkout.key_conflict"))[0].after).toMatchObject({ stage: "plain" });
    expect(await getCheckouts(h, id)).toHaveLength(0);
  });

  it("resend: the cancel is kept, nothing new is sent, and the attempt is skipped", async () => {
    const id = await bill();
    await chargeCard(h.staff.actor, id);
    h.gateway.orderError = squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
    await expect(resendCheckout(h.staff.actor, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(KEY_MESSAGE) });
    const cos = await getCheckouts(h, id);
    expect(cos.map((c) => [c.id, c.status])).toEqual([["chk_1", "CANCELED"]]);
    expect(h.gateway.creates).toHaveLength(1);
    expect((await getSession(h, id)).checkout_attempt).toBe(2);
    expect((await audits(h, id, "checkout.key_conflict"))[0].after).toMatchObject({ attempt: 2, stage: "order" });

    const out = await chargeCard(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", checkoutId: "chk_2" });
    expect(h.gateway.creates[1].idempotencyKey).toBe(`${id}-a3i`);
  });
});

describe("I7. a card payment for a different amount from the bill is flagged", () => {
  const webhook = (cid: string, status: string, sid: string, amountCents: number | null, orderId: string | null = null) =>
    withTx((tx) => applyWebhookCheckout(tx, { id: cid, status, referenceId: sid, cancelReason: null, amountCents, orderId }));

  it("adoption: a request the app never recorded is paid after an item was added", async () => {
    // $25 charge reaches the Terminal but the answer is lost; staff add a Coke; the customer taps the $25 request.
    const id = await awaitingPayment(h, "Table 1", 60);
    await addItem(h.staff.actor, id, "VAR_COKE", 1); // allowed: no live checkout on record → 2950
    expect(await webhook("chk_orphan", "COMPLETED", id, 2500)).toBe("applied");

    // the money was taken, so the bill is settled …
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "card", settled_via: "square_webhook", total_cents: 2950 });
    expect(await audits(h, id, "session.paid")).toHaveLength(1);
    // … and the shortfall is flagged
    const [c] = await audits(h, id, "payment.conflict");
    expect(c.entity).toBe("session");
    expect(c.device_label).toBe("Square webhook");
    expect(c.after).toMatchObject({ checkout_id: "chk_orphan", amount_cents: 2500, total_cents: 2950, difference_cents: 450 });
    expect(c.reason).toBe("The card payment was for $25.00 but the bill is $29.50. Collect the other $4.50 from the customer.");
  });

  it("a cancelled attempt that completes anyway, after the bill went up", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await chargeCard(h.staff.actor, id); // chk_1 for 2500
    await cancelCheckout(h.staff.actor, id); // CANCELED (a timed-out cancel isn't final)
    await addItem(h.staff.actor, id, "VAR_CHIPS", 1); // 3100
    expect(await webhook("chk_1", "COMPLETED", id, 2500)).toBe("applied");

    expect(await getSession(h, id)).toMatchObject({ status: "paid", total_cents: 3100 });
    const [c] = await audits(h, id, "payment.conflict");
    expect(c.after).toMatchObject({ checkout_id: "chk_1", attempt: 1, amount_cents: 2500, total_cents: 3100, difference_cents: 600 });
    expect(c.reason).toMatch(/was for \$25\.00 but the bill is \$31\.00\. Collect the other \$6\.00/);
  });

  it("an overpayment says to refund the difference", async () => {
    const id = await running();
    const { itemId } = await addItem(h.staff.actor, id, "VAR_COKE", 2);
    await stopSession(h.staff.actor, id, at(60)); // 3400
    await chargeCard(h.staff.actor, id);
    await cancelCheckout(h.staff.actor, id);
    await removeItem(h.staff.actor, id, itemId); // 2500
    await webhook("chk_1", "COMPLETED", id, 3400);
    const [c] = await audits(h, id, "payment.conflict");
    expect(c.after).toMatchObject({ amount_cents: 3400, total_cents: 2500, difference_cents: -900 });
    expect(c.reason).toBe("The card payment was for $34.00 but the bill is $25.00. Refund $9.00 in Square.");
  });

  it("shows under Needs attention in the summary", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    await webhook("chk_orphan", "COMPLETED", id, 2500);
    const rows = await h.sql<{ action: string }[]>`
      select action from public.audit_log where entity_id = ${id} and action = any(${["payment.conflict", "session.reverse_paid", "checkout.cancel_failed"]}::text[])`;
    expect(rows.map((r) => r.action)).toEqual(["payment.conflict"]);
  });

  it("a payment for the right amount is not flagged (webhook, replay, and manual sync paths)", async () => {
    const a = await running("Table 1");
    await addItem(h.staff.actor, a, "VAR_COKE", 1);
    await stopSession(h.staff.actor, a, at(60));
    await chargeCard(h.staff.actor, a);
    await webhook("chk_1", "COMPLETED", a, 2950);
    expect(await audits(h, a, "payment.conflict")).toHaveLength(0);

    // an orphan whose webhook carries no amount is recorded at the bill total
    const b = await awaitingPayment(h, "Table 2", 60);
    await webhook("chk_orphan", "COMPLETED", b, null);
    expect(await audits(h, b, "payment.conflict")).toHaveLength(0);
    expect((await getSession(h, b)).status).toBe("paid");
  });

  it("an adopted checkout keeps its order link when the webhook carries one", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await webhook("chk_orphan", "PENDING", id, 2500, "ord_from_square");
    expect(await orderOf("chk_orphan")).toBe("ord_from_square");
    const [row] = await audits(h, id, "checkout.adopted");
    expect(row.after).toMatchObject({ checkout_id: "chk_orphan", order_id: "ord_from_square" });

    const other = await awaitingPayment(h, "Table 2", 60);
    await webhook("chk_plain", "PENDING", other, 2500);
    expect(await orderOf("chk_plain")).toBeNull();
  });
});

