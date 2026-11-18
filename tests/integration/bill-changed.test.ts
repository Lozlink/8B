import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { at, audits, auditActions, awaitingPayment, expectBillAddsUp, expectFamilyAddsUp, getCheckouts, getSession, seedDiscount, seedProduct } from "./helpers/util";
import { withTx } from "@/lib/server/db";
import { refreshProductsInBackground } from "@/lib/server/items";
import { markPaidCheckingPos, startCashHandoff } from "@/lib/server/pos-cash";
import { getFloor } from "@/lib/server/queries";
import { refundsInBackground } from "@/lib/server/refunds";
import {
  BILL_CHANGED_MESSAGE,
  addCustomItem,
  addItem,
  applyWebhookCheckout,
  cancelCheckout,
  chargeCard,
  discardCounterSale,
  markPaid,
  mergeBack,
  openCounterSale,
  reconcileInBackground,
  releaseTable,
  removeItem,
  resendCheckout,
  setDiscount,
  splitBill,
  startSession,
  voidSession,
} from "@/lib/server/sessions";
import { pushCashInBackground, type CashRecordRow } from "@/lib/server/square-cash";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  vi.restoreAllMocks();
  await seedProduct(h, { id: "VAR_COKE", name: "Coke", priceCents: 450 });
  await seedDiscount(h, { id: "D_10", name: "Members 10%", kind: "percent", value: 1000 });
});

/** What every one of these refusals looks like. */
const CHANGED = { status: 409, code: "bill_changed", message: "This bill has changed. Check the amount and try again." };
const records = (sessionId: string) =>
  h.sql<CashRecordRow[]>`select * from public.square_cash_records where session_id = ${sessionId} order by seq`;
const auditCount = async (id: string) => (await audits(h, id)).length;

/** A counter sale of exactly this much. */
async function billOf(cents: number): Promise<string> {
  const { sessionId } = await openCounterSale(h.staff.actor, at(1));
  await addCustomItem(h.staff.actor, sessionId, "Thing", cents);
  return sessionId;
}

// ---------------------------------------------------------------------------
// A money action is tied to the amount the screen showed
// ---------------------------------------------------------------------------

describe("H1. expectedTotalCents: the amount the screen showed", () => {
  it("the message is the one the screens are told to expect", () => {
    expect(BILL_CHANGED_MESSAGE).toBe(CHANGED.message);
  });

  it("Mark paid – cash for $60 after another iPad put a discount on: refused, nothing changes; then paid for the real amount", async () => {
    const { actor } = h.staff;
    const id = await billOf(6000); // this iPad shows $60.00
    await setDiscount(actor, null, id, { discountId: "D_10" }); // the other iPad: now $54.00
    const before = await auditCount(id);

    await expect(markPaidCheckingPos(actor, id, "cash", { cardConfirmed: false, expectedTotalCents: 6000 }, at(5))).rejects.toMatchObject(CHANGED);
    await expect(markPaid(actor, id, "cash", { cardConfirmed: false, expectedTotalCents: 6000 }, at(5))).rejects.toMatchObject(CHANGED);
    await expect(markPaid(actor, id, "card", { cardConfirmed: true, expectedTotalCents: 6000 }, at(5))).rejects.toMatchObject(CHANGED);
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", total_cents: 5400, settled_cents: null, settled_method: null });
    expect(await records(id)).toHaveLength(0);
    expect(await auditCount(id)).toBe(before);

    // The screen reloads, shows $54.00, staff tap again.
    const out = await markPaidCheckingPos(actor, id, "cash", { cardConfirmed: false, expectedTotalCents: 5400 }, at(6));
    expect(out).toMatchObject({ kind: "paid", method: "cash", amountCents: 5400 });
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_cents: 5400 });
    expect(await records(id)).toHaveLength(1);
  });

  it("Mark paid with a stale amount doesn't cancel the card request that is on the Terminal", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60); // 2500
    await chargeCard(actor, id);
    await expect(markPaid(actor, id, "cash", { cardConfirmed: false, expectedTotalCents: 2000 }, at(61))).rejects.toMatchObject(CHANGED);
    expect(h.gateway.cancels).toEqual([]);
    expect((await getCheckouts(h, id))[0].status).toBe("PENDING");
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    // with the right amount it goes ahead as it always has: cancel, then settle
    await markPaid(actor, id, "cash", { cardConfirmed: false, expectedTotalCents: 2500 }, at(62));
    expect(h.gateway.cancels).toEqual(["chk_1"]);
    expect((await getSession(h, id)).status).toBe("paid");
  });

  it("Mark paid with a stale amount after a Square POS handoff asks Square nothing and records nothing", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await startCashHandoff(actor, id);
    const before = await auditCount(id);
    await expect(markPaidCheckingPos(actor, id, "cash", { cardConfirmed: false, expectedTotalCents: 9999 }, at(61))).rejects.toMatchObject(CHANGED);
    expect(h.gateway.posReads).toEqual([]);
    expect(await auditCount(id)).toBe(before);
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    // right amount: the usual path (Square is asked, no sale found, marked paid by hand)
    expect(await markPaidCheckingPos(actor, id, "cash", { cardConfirmed: false, expectedTotalCents: 2500 }, at(62))).toMatchObject({ kind: "paid" });
    expect(h.gateway.posReads).toEqual(["list"]);
  });

  it("two iPads each tap \"Split 2 ways\" on the $60 they both see: the second is refused and nothing more is split", async () => {
    const { actor, managerActor } = h.staff;
    const id = await billOf(6000);
    const first = await splitBill(actor, id, { ways: 2, expectedTotalCents: 6000 }, at(2));
    expect(first.partIds).toHaveLength(1);
    const after = await getSession(h, id);
    expect(after).toMatchObject({ total_cents: 3000, split_off_cents: 3000 });
    const before = await auditCount(id);

    await expect(splitBill(managerActor, id, { ways: 2, expectedTotalCents: 6000 }, at(2))).rejects.toMatchObject(CHANGED);
    await expect(splitBill(managerActor, id, { amountCents: 1000, expectedTotalCents: 6000 }, at(2))).rejects.toMatchObject(CHANGED);
    expect(await h.sql`select id from public.sessions where split_of = ${id}`).toHaveLength(1);
    expect(await getSession(h, id)).toMatchObject({ total_cents: 3000, split_off_cents: 3000, checkout_attempt: after.checkout_attempt });
    expect(await auditCount(id)).toBe(before);
    await expectFamilyAddsUp(h, id);

    // Having seen the new amount, splitting what is left is a deliberate act and works.
    const again = await splitBill(managerActor, id, { ways: 2, expectedTotalCents: 3000 }, at(3));
    expect(again.partIds).toHaveLength(1);
    expect(await getSession(h, id)).toMatchObject({ total_cents: 1500, split_off_cents: 4500 });
    await expectFamilyAddsUp(h, id);
  });

  it("charge: sent when the amount matches; refused with nothing sent when it doesn't", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60); // 2500
    await addItem(actor, id, "VAR_COKE", 1); // another iPad: now 2950, attempt 1 skipped
    const before = await auditCount(id);

    await expect(chargeCard(actor, id, { expectedTotalCents: 2500 })).rejects.toMatchObject(CHANGED);
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.creates).toHaveLength(0);
    expect(await getCheckouts(h, id)).toHaveLength(0);
    expect(await getSession(h, id)).toMatchObject({ total_cents: 2950, checkout_attempt: 1, square_checkout_id: null });
    expect(await auditCount(id)).toBe(before);

    expect(await chargeCard(actor, id, { expectedTotalCents: 2950 })).toEqual({ kind: "sent", checkoutId: "chk_1", amountCents: 2950 });
    expect(h.gateway.creates[0]).toMatchObject({ idempotencyKey: `${id}-a2i`, amountCents: 2950 });
  });

  it("resend: a stale amount is refused BEFORE the request on the Terminal is cancelled", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await chargeCard(actor, id);
    await expect(resendCheckout(actor, id, { expectedTotalCents: 2000 })).rejects.toMatchObject(CHANGED);
    expect(h.gateway.cancels).toEqual([]);
    expect(h.gateway.creates).toHaveLength(1);
    expect((await getCheckouts(h, id)).map((c) => c.status)).toEqual(["PENDING"]);

    expect(await resendCheckout(actor, id, { expectedTotalCents: 2500 })).toEqual({ kind: "sent", checkoutId: "chk_2", amountCents: 2500 });
    expect(h.gateway.cancels).toEqual(["chk_1"]);
    expect((await getCheckouts(h, id)).map((c) => c.status)).toEqual(["CANCELED", "PENDING"]);
  });

  it("Square POS cash handoff: the expectation is the bill's total, not the rounded cash amount", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 85); // $35.42, cash is $35.40
    await expect(startCashHandoff(actor, id, { expectedTotalCents: 3540 })).rejects.toMatchObject(CHANGED);
    await expect(startCashHandoff(actor, id, { expectedTotalCents: 2500 })).rejects.toMatchObject(CHANGED);
    expect(await audits(h, id, "cash.handoff_started")).toHaveLength(0);
    // … so nothing is "in progress" and the bill can still be changed
    await setDiscount(actor, null, id, { discountId: "D_10" }); // 354 off → 3188
    const out = await startCashHandoff(actor, id, { expectedTotalCents: 3188 });
    expect(out.amountCents).toBe(3190);
    expect(await audits(h, id, "cash.handoff_started")).toHaveLength(1);
  });

  it("left out, every action goes ahead on whatever the bill is now (what the previous release's screens do)", async () => {
    const { actor } = h.staff;
    const a = await awaitingPayment(h, "Table 1", 60);
    expect(await chargeCard(actor, a)).toMatchObject({ kind: "sent", amountCents: 2500 });
    expect(await resendCheckout(actor, a)).toMatchObject({ kind: "sent", amountCents: 2500 });
    await cancelCheckout(actor, a);
    expect((await startCashHandoff(actor, a)).amountCents).toBe(2500);
    expect(await markPaidCheckingPos(actor, a, "cash", { cardConfirmed: false }, at(61))).toMatchObject({ kind: "paid", amountCents: 2500 });
    const b = await billOf(6000);
    expect((await splitBill(actor, b, { ways: 2 }, at(2))).partIds).toHaveLength(1);
    expect((await splitBill(actor, b, { ways: 2 }, at(3))).partIds).toHaveLength(1); // unguarded, as before
  });

  it("a $0 bill is marked paid when $0 is what the screen showed", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(managerActor, manager, id, { custom: { name: "On the house", kind: "percent", value: 10_000 } });
    await expect(markPaid(actor, id, "cash", { cardConfirmed: false, expectedTotalCents: 2500 }, at(61))).rejects.toMatchObject(CHANGED);
    expect(await markPaid(actor, id, "cash", { cardConfirmed: false, expectedTotalCents: 0 }, at(61))).toMatchObject({ kind: "paid", amountCents: 0 });
  });

  it("if the stored total itself was wrong, the refusal still keeps the correction, so the screen isn't shown the wrong amount for ever", async () => {
    // The screen can only show the stored total. If that was off (the release before this one,
    // mid-deploy) the re-pricing puts it right; were that rolled back with the refusal, every
    // later try would be refused the same way.
    const { actor } = h.staff;

    // charge
    const a = await awaitingPayment(h, "Table 1", 60);
    await setDiscount(actor, null, a, { discountId: "D_10" }); // truly 2250
    await h.sql`update public.sessions set total_cents = 2500 where id = ${a}`;
    await expect(chargeCard(actor, a, { expectedTotalCents: 2500 })).rejects.toMatchObject(CHANGED);
    expect(h.gateway.creates).toHaveLength(0);
    expect((await getSession(h, a)).total_cents).toBe(2250);
    expect(await audits(h, a, "session.repriced")).toHaveLength(1);
    expect(await chargeCard(actor, a, { expectedTotalCents: 2250 })).toMatchObject({ kind: "sent", amountCents: 2250 });
    await expectBillAddsUp(h, a);

    // split
    const b = await awaitingPayment(h, "Table 2", 60);
    await setDiscount(actor, null, b, { discountId: "D_10" });
    await h.sql`update public.sessions set total_cents = 2500 where id = ${b}`;
    await expect(splitBill(actor, b, { ways: 2, expectedTotalCents: 2500 }, at(61))).rejects.toMatchObject(CHANGED);
    expect(await h.sql`select id from public.sessions where split_of = ${b}`).toHaveLength(0);
    expect((await getSession(h, b)).total_cents).toBe(2250);
    expect((await splitBill(actor, b, { ways: 2, expectedTotalCents: 2250 }, at(62))).partIds).toHaveLength(1);
    await expectFamilyAddsUp(h, b);

    // Square POS handoff
    const c = await awaitingPayment(h, "Table 3", 60);
    await setDiscount(actor, null, c, { discountId: "D_10" });
    await h.sql`update public.sessions set total_cents = 2500 where id = ${c}`;
    await expect(startCashHandoff(actor, c, { expectedTotalCents: 2500 })).rejects.toMatchObject(CHANGED);
    expect(await audits(h, c, "cash.handoff_started")).toHaveLength(0);
    expect((await getSession(h, c)).total_cents).toBe(2250);
    expect((await startCashHandoff(actor, c, { expectedTotalCents: 2250 })).amountCents).toBe(2250);

    // resend: the stale request is cancelled (the amount staff saw was the stored one), nothing
    // new is sent for an amount they didn't see, and the correction is kept.
    const d = await awaitingPayment(h, "Table 4", 60);
    await setDiscount(actor, null, d, { discountId: "D_10" });
    await chargeCard(actor, d); // 2250 on the Terminal
    const sent = h.gateway.creates.length;
    await h.sql`update public.sessions set total_cents = 2500 where id = ${d}`;
    await expect(resendCheckout(actor, d, { expectedTotalCents: 2500 })).rejects.toMatchObject(CHANGED);
    expect(h.gateway.creates).toHaveLength(sent);
    expect((await getSession(h, d)).total_cents).toBe(2250);
    expect(await auditActions(h, d)).toContain("session.repriced");
    expect(await chargeCard(actor, d, { expectedTotalCents: 2250 })).toMatchObject({ kind: "sent", amountCents: 2250 });
  });
});

// ---------------------------------------------------------------------------
// The floor's stamp for bills that aren't on a table
// ---------------------------------------------------------------------------

describe("H2. FloorDTO.unpaidStamp", () => {
  const stamp = async () => (await getFloor()).unpaidStamp;

  it("is null when no bill is awaiting payment off a table, whatever is happening on the tables", async () => {
    const { actor } = h.staff;
    expect(await stamp()).toBeNull();
    await startSession(actor, h.tableId("Table 1"), at(0));
    const onTable = await awaitingPayment(h, "Table 2", 60); // a bill still on its table
    await addItem(actor, onTable, "VAR_COKE", 1);
    expect(await stamp()).toBeNull();
    expect((await getFloor()).unpaidOffTableCount).toBe(0);
  });

  it("moves on every real change to a bill that isn't on a table, and only then", async () => {
    const { actor, managerActor, manager } = h.staff;
    let last: string | null = null;
    /** The stamp must differ from the one before, and must not move again by itself. */
    const moved = async (what: string): Promise<string> => {
      const s = await stamp();
      expect(s, `${what}: a stamp`).toEqual(expect.any(String));
      expect(s, `${what}: the stamp moved`).not.toBe(last);
      last = s;
      expect(await stamp(), `${what}: and holds still`).toBe(s);
      return s as string;
    };

    const { sessionId: counter } = await openCounterSale(actor, at(1));
    await moved("a counter sale is opened");
    const { itemId } = await addItem(actor, counter, "VAR_COKE", 2);
    await moved("an item goes on it");
    await addCustomItem(actor, counter, "Chalk", 250);
    await moved("a custom charge goes on it");
    await removeItem(actor, counter, itemId, at(2));
    await moved("an item comes off it");
    await setDiscount(actor, null, counter, { discountId: "D_10" });
    await moved("a discount goes on it");

    await addCustomItem(actor, counter, "Cue", 6000);
    await moved("another line");
    const [part] = (await splitBill(actor, counter, { ways: 2 }, at(3))).partIds;
    await moved("it is split");
    await chargeCard(actor, part);
    await moved("a part is sent to the Terminal");
    // The Terminal cancels: only the checkout's status changes, no bill row is written.
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "CANCELED", referenceId: part, cancelReason: "BUYER_CANCELED", amountCents: null }));
    await moved("the card request is cancelled on the Terminal");
    await mergeBack(actor, part, at(4));
    const justTheCounterSale = await moved("the part is merged back");

    const released = await awaitingPayment(h, "Table 3", 60);
    expect(await stamp()).toBe(justTheCounterSale); // still on its table: not this stamp's business
    await releaseTable(actor, released);
    await moved("a table's bill is left unpaid");
    await markPaid(actor, released, "cash", { cardConfirmed: false }, at(70));
    await moved("it is paid");
    // It is a fingerprint of what is there, not a counter: with that bill gone, what is left is
    // exactly what was there before it arrived. (A screen compares one fetch with the next, and
    // both of those moves were seen.)
    expect(last).toBe(justTheCounterSale);
    await voidSession(managerActor, manager, counter, "Changed their mind", at(71));
    expect(await stamp()).toBeNull(); // nothing left off a table
    last = null;

    const { sessionId: empty } = await openCounterSale(actor, at(80));
    await moved("another counter sale");
    await discardCounterSale(actor, empty, at(81));
    expect(await stamp()).toBeNull();
  });

  it("does not move when the background checks run and find nothing to do", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { actor } = h.staff;
    // An off-table bill with a card request waiting on the Terminal, and a paid cash bill.
    const { sessionId: counter } = await openCounterSale(actor, at(1));
    await addCustomItem(actor, counter, "Cue", 3000);
    await chargeCard(actor, counter);
    const paid = await awaitingPayment(h, "Table 1", 60);
    await markPaid(actor, paid, "cash", { cardConfirmed: false }, at(61));
    await pushCashInBackground(); // the cash sale goes to Square: a paid bill, not this stamp's business
    const before = await stamp();
    expect(before).toEqual(expect.any(String));

    // Make the waiting card request due for its background check, twice over. Square says PENDING.
    for (let i = 0; i < 2; i++) {
      await h.raw(null, `update public.terminal_checkouts set created_at = now() - interval '1 minute', last_synced_at = null`);
      await reconcileInBackground();
    }
    expect(h.gateway.gets).toEqual(["chk_1", "chk_1"]); // it did run, and did ask Square
    const [co] = await getCheckouts(h, counter);
    expect(co.status).toBe("PENDING");
    expect(co.last_synced_at).toBeInstanceOf(Date); // and did stamp the row it checked

    await h.raw(null, `update public.catalog_state set synced_at = now() - interval '11 minutes'`);
    await refreshProductsInBackground(); // re-reads the catalogue (empty here): products go inactive, no bill is touched
    await pushCashInBackground();
    await refundsInBackground();

    expect(await stamp()).toBe(before);
    warn.mockRestore();

    // … and when the check DOES find something, it moves.
    h.gateway.getDefault = "CANCELED";
    await h.raw(null, `update public.terminal_checkouts set created_at = now() - interval '1 minute', last_synced_at = null`);
    await reconcileInBackground();
    expect((await getCheckouts(h, counter))[0].status).toBe("CANCELED");
    expect(await stamp()).not.toBe(before);
  });

  it("is the same on every iPad: it depends on the bills, not on who asks or when", async () => {
    const { actor } = h.staff;
    const { sessionId: a } = await openCounterSale(actor, at(1));
    const { sessionId: b } = await openCounterSale(actor, at(2));
    await addCustomItem(actor, a, "Cue", 3000);
    const s1 = await stamp();
    await h.sql`set timezone = 'America/New_York'`; // a pooled connection with another setting
    try {
      expect(await stamp()).toBe(s1);
    } finally {
      await h.sql`set timezone = 'UTC'`;
    }
    expect((await getFloor()).unpaidOffTableCount).toBe(2);
    expect(b).not.toBe(a);
  });
});
