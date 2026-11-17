import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { squareServerError, squareTimeout } from "./helpers/fake-gateway";
import { T0, at, audits, awaitingPayment, getCheckouts, getSession, seedProduct } from "./helpers/util";
import { signToken, verifyToken } from "@/lib/server/auth";
import { withTx, type Db } from "@/lib/server/db";
import { TransitionError } from "@/lib/domain/machine";
import { checkCashHandoff, handlePosReturn, markPaidCheckingPos, posCashAvailable, startCashHandoff } from "@/lib/server/pos-cash";
import { getFloor, getSummary } from "@/lib/server/queries";
import { addItem, applyWebhookCheckout, chargeCard, reversePaid, startSession, stopSession } from "@/lib/server/sessions";
import { getCashOutstanding, pushCashRecords, retryCashRecords, type CashRecordRow } from "@/lib/server/square-cash";
import { parsePosCallback } from "@/lib/square/pos";

// For the route test at the bottom: `handler` waits on Next's connection(), which only exists
// inside a real request.
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => undefined }));

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
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const records = (sessionId: string) =>
  h.sql<CashRecordRow[]>`select * from public.square_cash_records where session_id = ${sessionId} order by seq`;

/** 85 minutes at $25/h = $35.42; cash collects $35.40. */
const oddBill = (table = "Table 1") => awaitingPayment(h, table, 85);

interface LinkData {
  amount_money: { amount: string; currency_code: string };
  callback_url: string;
  client_id: string;
  version: string;
  location_id: string;
  notes: string;
  state: string;
  options: { supported_tender_types: string[]; auto_return: boolean };
}

const PREFIX = "square-commerce-v1://payment/create?data=";
const linkData = (url: string): LinkData => JSON.parse(decodeURIComponent(url.slice(PREFIX.length))) as LinkData;

/** Hands the bill to Square POS and returns what the link carried. */
async function handoff(id: string): Promise<LinkData & { amountCents: number }> {
  const out = await startCashHandoff(h.staff.actor, id);
  return { ...linkData(out.url), amountCents: out.amountCents };
}

/** What Square POS opens the callback URL with (the `data` query parameter). */
const callback = (fields: Record<string, unknown>) => JSON.stringify(fields);
const okCallback = (state: string, transactionId?: string) =>
  callback({ status: "ok", client_transaction_id: "client-1", ...(transactionId ? { transaction_id: transactionId } : {}), state });

const payManually = (id: string) => markPaidCheckingPos(h.staff.actor, id, "cash", { cardConfirmed: false }, at(100));
const reverse = (id: string) => reversePaid(h.staff.managerActor, h.staff.manager, id, "Wrong bill");

describe("P1. handing a cash bill to Square POS", () => {
  it("builds the Square POS link for the rounded cash amount, with a note staff can read and a signed state", async () => {
    const id = await oddBill();
    const out = await startCashHandoff(h.staff.actor, id);
    expect(out.amountCents).toBe(3540);
    expect(out.url.startsWith(PREFIX)).toBe(true);

    const data = linkData(out.url);
    expect(data).toMatchObject({
      amount_money: { amount: "3540", currency_code: "AUD" },
      callback_url: "https://example.test/pos/return",
      client_id: "sq0idp-test-app",
      version: "1.3",
      location_id: "LOC_TEST",
      options: { supported_tender_types: ["CASH"], auto_return: true },
    });
    expect(data.notes).toMatch(/^Table 1 · /);
    expect(data.notes.endsWith(`· ref ${id.slice(0, 8)}`)).toBe(true);

    // The state is ours, says which bill, who and how much, and runs out in 30 minutes.
    const payload = await verifyToken(data.state, "pos-cash");
    expect(payload).toMatchObject({ sub: id, u: h.staff.actor.staffId, d: "Counter", a: 3540 });
    expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(30 * 60);
    expect(await verifyToken(data.state, "staff")).toBeNull(); // can't be used as a login
    expect(out.url.length).toBeLessThan(2000);

    // Nothing about the bill changes, and nothing goes to Square.
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", settled_cents: null });
    expect(await records(id)).toHaveLength(0);
    expect(h.gateway.posReads).toEqual([]);
    const [a] = await audits(h, id, "cash.handoff_started");
    expect(a.actor_staff_id).toBe(h.staff.actor.staffId);
    expect(a.after).toMatchObject({ amount_cents: 3540, total_cents: 3542, ref: id.slice(0, 8) });
  });

  it("refuses while a card request is live, for a bill that isn't awaiting payment, and when there is nothing to collect", async () => {
    const id = await oddBill();
    await chargeCard(h.staff.actor, id);
    await expect(startCashHandoff(h.staff.actor, id)).rejects.toMatchObject({ status: 409, message: "This bill is already on the Terminal. Cancel it or use Resend." });

    const { sessionId: running } = await startSession(h.staff.actor, h.tableId("Table 2"), T0);
    await expect(startCashHandoff(h.staff.actor, running)).rejects.toBeInstanceOf(TransitionError);
    await expect(startCashHandoff(h.staff.actor, "nope")).rejects.toMatchObject({ status: 404 });

    // A 2c bill rounds to nothing in cash.
    await seedProduct(h, { id: "VAR_LOLLY", name: "Lolly", priceCents: 2 });
    const { sessionId: tiny } = await startSession(h.staff.actor, h.tableId("Table 3"), T0);
    await addItem(h.staff.actor, tiny, "VAR_LOLLY", 1);
    await h.sql`update public.settings set minimum_minutes = 0, grace_minutes = 5`;
    await stopSession(h.staff.actor, tiny, at(1));
    expect((await getSession(h, tiny)).total_cents).toBe(2);
    await expect(startCashHandoff(h.staff.actor, tiny)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nothing to collect/) });
  });

  it("is only on offer when the application id is set", async () => {
    expect(posCashAvailable()).toBe(true);
    expect((await getFloor()).posCashAvailable).toBe(true);
    const id = await oddBill();
    const appId = process.env.SQUARE_APPLICATION_ID;
    delete process.env.SQUARE_APPLICATION_ID;
    try {
      expect((await getFloor()).posCashAvailable).toBe(false);
      await expect(startCashHandoff(h.staff.actor, id)).rejects.toMatchObject({ status: 503, code: "pos_cash_not_configured" });
    } finally {
      process.env.SQUARE_APPLICATION_ID = appId;
    }
  });

  it("APP_ORIGIN, when set, decides the callback address", async () => {
    process.env.APP_ORIGIN = "https://timer.example.com";
    try {
      const id = await oddBill();
      expect((await handoff(id)).callback_url).toBe("https://timer.example.com/pos/return");
    } finally {
      delete process.env.APP_ORIGIN;
    }
  });
});

describe("P2. Square POS comes back: the sale went through", () => {
  it("marks the bill paid from the sale Square holds and records it as already in Square", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });

    const out = await handlePosReturn(okCallback(link.state, sale.orderId));
    expect(out).toEqual({ result: "paid", message: "$35.40 cash recorded." });
    // The callback was not taken at its word: the order and the payment were read from Square.
    expect(h.gateway.posReads).toEqual([`order:${sale.orderId}`, `payment:${sale.paymentId}`]);

    expect(await getSession(h, id)).toMatchObject({
      status: "paid",
      settled_method: "cash",
      settled_via: "square_api",
      settled_by: h.staff.actor.staffId,
      settled_cents: 3540,
      current_table_id: null,
    });
    const rows = await records(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: 1,
      state: "recorded",
      want: "recorded",
      attempts: 1,
      amount_cents: 3540,
      bill_cents: 3542,
      order_lines: null,
      square_payment_id: sale.paymentId,
      square_order_id: sale.orderId,
    });
    const [paid] = await audits(h, id, "session.paid");
    expect(paid.actor_staff_id).toBe(h.staff.actor.staffId);
    expect(paid.reason).toBe("Cash taken in Square POS.");
    expect(paid.after).toMatchObject({ settled_via: "square_api", settled_cents: 3540, square_payment_id: sale.paymentId, matched_by: "transaction", source: "callback" });
    expect(await audits(h, id, "payment.conflict")).toHaveLength(0);

    // The app records nothing of its own: Square has the sale once.
    await pushCashRecords();
    expect(h.gateway.cashPayments).toHaveLength(0);
    expect(h.gateway.orders).toHaveLength(0);
    expect(h.gateway.payments.size).toBe(1);
  });

  it("the same callback again changes nothing", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    const data = okCallback(link.state, sale.orderId);
    await handlePosReturn(data);
    const before = (await h.sql<{ n: number }[]>`select count(*)::int as n from public.audit_log`)[0].n;

    expect(await handlePosReturn(data)).toMatchObject({ result: "paid" });
    expect(await handlePosReturn(data)).toMatchObject({ result: "paid" });
    expect(await records(id)).toHaveLength(1);
    expect(await audits(h, id, "session.paid")).toHaveLength(1);
    expect((await h.sql<{ n: number }[]>`select count(*)::int as n from public.audit_log`)[0].n).toBe(before);
  });

  it("shows in the summary as cash collected, already in Square", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    await handlePosReturn(okCallback(link.state, sale.orderId));
    const settledAt = (await getSession(h, id)).settled_at as Date;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(settledAt);
    try {
      const sum = await getSummary(null);
      expect(sum.paid.cash).toEqual({ count: 1, cents: 3540, roundingCents: -2 });
      expect(sum.squareCashOutstanding).toEqual({ count: 0, cents: 0, failed: 0 });
      expect(sum.paidItems[0]).toMatchObject({ method: "cash", via: "square_api", settledByName: "Sam Staff", squareCash: { state: "recorded" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an id Square doesn't know as an order is tried as a payment id", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    expect(await handlePosReturn(okCallback(link.state, sale.paymentId))).toMatchObject({ result: "paid" });
    expect((await records(id))[0].square_payment_id).toBe(sale.paymentId);
  });

  it("an id Square doesn't know at all falls back to looking for the sale", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    expect(await handlePosReturn(okCallback(link.state, "SOMETHING_ELSE"))).toMatchObject({ result: "paid" });
    expect((await records(id))[0].square_payment_id).toBe(sale.paymentId);
    expect((await audits(h, id, "session.paid"))[0].after).toMatchObject({ matched_by: "note" });
  });

  it("cancels a card request that went on the Terminal after the handoff", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    await chargeCard(h.staff.actor, id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    expect(await handlePosReturn(okCallback(link.state, sale.orderId))).toMatchObject({ result: "paid" });
    expect(h.gateway.cancels).toEqual(["chk_1"]);
    expect((await getCheckouts(h, id))[0].status).toBe("CANCELED");
  });

  it("the bill changed after it was handed over: settled for what was taken, and the difference is flagged", async () => {
    await seedProduct(h, { id: "VAR_COKE", name: "Coke", priceCents: 450 });
    const id = await oddBill();
    const link = await handoff(id);
    await addItem(h.staff.actor, id, "VAR_COKE", 1); // bill is now $39.92 → $39.90 cash
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    expect(await handlePosReturn(okCallback(link.state, sale.orderId))).toMatchObject({ result: "paid" });
    expect(await getSession(h, id)).toMatchObject({ status: "paid", total_cents: 3992, settled_cents: 3540 });
    const [c] = await audits(h, id, "payment.conflict");
    expect(c.reason).toMatch(/\$35\.40 cash was taken in Square POS but the bill is now \$39\.90\. Collect the other \$4\.50/);
  });
});

describe("P3. Square POS comes back: nothing to settle", () => {
  it("a tampered, expired, foreign or missing state does no work at all", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    const auditCount = async () => (await h.sql<{ n: number }[]>`select count(*)::int as n from public.audit_log`)[0].n;
    const before = await auditCount();

    const flipped = link.state.slice(0, -3) + (link.state.endsWith("AAA") ? "BBB" : "AAA");
    const [head, body, sig] = link.state.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), a: 5 })).toString("base64url");
    const expired = await signToken({ sub: id, u: h.staff.actor.staffId, d: "Counter", a: 3540 }, -60, "pos-cash");
    const wrongKind = await signToken({ sub: id, u: h.staff.actor.staffId, d: "Counter", a: 3540 }, 600, "staff");
    const badShape = await signToken({ sub: "not-a-uuid", u: h.staff.actor.staffId, d: "Counter", a: 3540 }, 600, "pos-cash");

    const attempts = [
      okCallback(flipped, sale.orderId),
      okCallback(`${head}.${forgedBody}.${sig}`, sale.orderId),
      okCallback(expired, sale.orderId),
      okCallback(wrongKind, sale.orderId),
      okCallback(badShape, sale.orderId),
      callback({ status: "ok", transaction_id: sale.orderId }), // no state
      callback({ status: "error", error_code: "payment_canceled", state: flipped }),
      "not json",
      "[]",
      "{}",
      callback({ status: "maybe", state: link.state }),
    ];
    for (const data of attempts) {
      const out = await handlePosReturn(data);
      expect(out.result).toBe("error");
    }
    expect(h.gateway.posReads).toEqual([]);
    expect(await auditCount()).toBe(before);
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    expect(await records(id)).toHaveLength(0);
  });

  it("cancelled in Square POS: the bill stays unpaid and it is noted once", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const data = callback({ status: "error", error_code: "payment_canceled", state: link.state });
    expect(await handlePosReturn(data)).toEqual({
      result: "canceled",
      message: "The cash sale was cancelled in Square. Nothing was taken and the bill is still unpaid.",
    });
    await handlePosReturn(data);
    const rows = await audits(h, id, "cash.handoff_canceled");
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toMatchObject({ error_code: "payment_canceled", amount_cents: 3540 });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    expect(h.gateway.posReads).toEqual([]);
  });

  it("other Square POS errors are reported in plain words", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const out = await handlePosReturn(callback({ status: "error", error_code: "not_logged_in", state: link.state }));
    expect(out).toEqual({ result: "error", message: "Square POS isn't signed in on this iPad. Sign in, then take the cash again." });
    // `error_code` alone is enough, as in Square's own sample.
    expect(parsePosCallback(callback({ error_code: "could_not_perform", state: "x" }))).toMatchObject({ status: "error", errorCode: "could_not_perform" });
    expect((await handlePosReturn(callback({ status: "error", error_code: "something_new", state: link.state }))).message).toMatch(/something_new/);
  });

  it("Square took a different amount: not settled, and flagged once", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3500, note: link.notes });
    const data = okCallback(link.state, sale.orderId);
    const out = await handlePosReturn(data);
    expect(out.result).toBe("error");
    expect(out.message).toMatch(/took \$35\.00 in cash for this bill, but \$35\.40 was asked for/);
    await handlePosReturn(data);

    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    expect(await records(id)).toHaveLength(0);
    const flagged = await audits(h, id, "payment.conflict");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].after).toMatchObject({ square_payment_id: sale.paymentId, square_amount_cents: 3500, handed_off_cents: 3540 });
  });

  it("a sale that isn't completed cash at this location is not accepted", async () => {
    for (const odd of [{ status: "FAILED" }, { sourceType: "CARD" }, { locationId: "LOC_OTHER" }]) {
      const id = await oddBill();
      const link = await handoff(id);
      const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes, ...odd });
      const out = await handlePosReturn(okCallback(link.state, odd.sourceType ? sale.paymentId : sale.orderId));
      expect(out.result).toBe("error");
      expect((await getSession(h, id)).status).toBe("awaiting_payment");
      expect(await records(id)).toHaveLength(0);
      await h.reset();
    }
  });

  it("taken offline (no transaction id): can't be confirmed yet, then the check settles it once Square has it", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const data = okCallback(link.state);
    expect(await handlePosReturn(data)).toMatchObject({ result: "pending" });
    await handlePosReturn(data);
    const noted = await audits(h, id, "cash.handoff_unconfirmed");
    expect(noted).toHaveLength(1);
    expect(noted[0].after).toMatchObject({ offline: true });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");

    expect(await checkCashHandoff(h.staff.actor, id)).toEqual({ paid: false });
    // The iPad comes back online and sends the sale to Square.
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    expect(await checkCashHandoff(h.staff.actor, id)).toEqual({ paid: true });
    expect((await records(id))[0]).toMatchObject({ state: "recorded", square_payment_id: sale.paymentId });
    expect((await audits(h, id, "session.paid"))[0].after).toMatchObject({ source: "check", matched_by: "note" });
  });

  it("Square can't be reached: pending, nothing settled, nothing lost", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    h.gateway.posError = squareTimeout();
    expect(await handlePosReturn(okCallback(link.state, sale.orderId))).toMatchObject({ result: "pending" });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");

    h.gateway.posError = null;
    expect(await handlePosReturn(okCallback(link.state, sale.orderId))).toMatchObject({ result: "paid" });
  });
});

describe("P4. the check from the app", () => {
  it("does nothing, and asks Square nothing, unless the bill was handed over and is still unpaid", async () => {
    const id = await oddBill();
    h.gateway.posSale({ amountCents: 3540 });
    expect(await checkCashHandoff(h.staff.actor, id)).toEqual({ paid: false });
    expect(h.gateway.posReads).toEqual([]);
    await expect(checkCashHandoff(h.staff.actor, "nope")).rejects.toMatchObject({ status: 404 });

    // A handoff more than 30 minutes ago no longer counts.
    await handoff(id);
    await h.raw(null, `alter table public.audit_log disable trigger audit_log_no_update`);
    await h.raw(null, `update public.audit_log set at = now() - interval '31 minutes' where action = 'cash.handoff_started'`);
    await h.raw(null, `alter table public.audit_log enable trigger audit_log_no_update`);
    expect(await checkCashHandoff(h.staff.actor, id)).toEqual({ paid: false });
    expect(h.gateway.posReads).toEqual([]);
  });

  it("finds the sale by the reference in its note among others for the same amount", async () => {
    const a = await oddBill("Table 1");
    const b = await oddBill("Table 2");
    const linkA = await handoff(a);
    const linkB = await handoff(b);
    const saleB = h.gateway.posSale({ amountCents: 3540, note: linkB.notes });
    const saleA = h.gateway.posSale({ amountCents: 3540, note: linkA.notes });
    h.gateway.posSale({ amountCents: 3540, note: "Drinks" }); // someone else's sale

    expect(await checkCashHandoff(h.staff.actor, a)).toEqual({ paid: true });
    expect((await records(a))[0].square_payment_id).toBe(saleA.paymentId);
    expect(await checkCashHandoff(h.staff.actor, b)).toEqual({ paid: true });
    expect((await records(b))[0].square_payment_id).toBe(saleB.paymentId);
  });

  it("without a reference: a lone sale for the exact amount is taken, and the audit says how it was matched", async () => {
    const id = await oddBill();
    await handoff(id);
    h.gateway.posSale({ amountCents: 3500 }); // wrong amount
    h.gateway.posSale({ amountCents: 3540, createdAt: new Date(Date.now() - 10 * 60_000) }); // before the handoff
    const sale = h.gateway.posSale({ amountCents: 3540 });
    expect(await checkCashHandoff(h.staff.actor, id)).toEqual({ paid: true });
    expect((await records(id))[0].square_payment_id).toBe(sale.paymentId);
    const [paid] = await audits(h, id, "session.paid");
    expect(paid.after).toMatchObject({ matched_by: "amount" });
    expect(paid.reason).toMatch(/Matched to this bill by amount and time/);
  });

  it("without a reference, two candidates is a guess, so neither is taken", async () => {
    const id = await oddBill();
    await handoff(id);
    h.gateway.posSale({ amountCents: 3540 });
    h.gateway.posSale({ amountCents: 3540 });
    expect(await checkCashHandoff(h.staff.actor, id)).toEqual({ paid: false });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
  });

  it("ignores a sale already tied to another bill, and sales the app recorded itself", async () => {
    const a = await oddBill("Table 1");
    const b = await oddBill("Table 2");
    const c = await oddBill("Table 3");
    const linkA = await handoff(a);
    const saleA = h.gateway.posSale({ amountCents: 3540 });
    await handlePosReturn(okCallback(linkA.state, saleA.orderId)); // a is settled by saleA

    // c is paid by hand with no handoff; the outbox puts its $35.40 in Square.
    await payManually(c);
    await pushCashRecords();
    expect(h.gateway.cashPayments).toHaveLength(1);

    await handoff(b);
    expect(await checkCashHandoff(h.staff.actor, b)).toEqual({ paid: false });
    expect((await getSession(h, b)).status).toBe("awaiting_payment");
  });

  it("Square unreachable is a 502, and the bill is untouched", async () => {
    const id = await oddBill();
    await handoff(id);
    h.gateway.posError = squareServerError();
    await expect(checkCashHandoff(h.staff.actor, id)).rejects.toMatchObject({ status: 502, code: "square_error" });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
  });

  it("says paid for a bill that is already paid", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    await handlePosReturn(okCallback(link.state, sale.orderId));
    expect(await checkCashHandoff(h.staff.actor, id)).toEqual({ paid: true });
  });
});

describe("P5. marking paid by hand after a handoff", () => {
  it("Square POS had taken the sale: settled from it, and no second sale is recorded", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });

    const out = await payManually(id);
    expect(out).toEqual({ kind: "paid", method: "cash", via: "square_api", amountCents: 3540, warnings: [] });
    const rows = await records(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "recorded", square_payment_id: sale.paymentId, attempts: 1 });
    expect(await audits(h, id, "session.mark_paid")).toHaveLength(0);
    expect((await audits(h, id, "session.paid"))[0].after).toMatchObject({ source: "mark_paid" });

    await pushCashRecords();
    expect(h.gateway.cashPayments).toHaveLength(0);
    expect(h.gateway.payments.size).toBe(1);
  });

  it("no sale in Square: paid by hand as usual, but its sale waits five minutes before going to Square", async () => {
    const id = await oddBill();
    await handoff(id);
    const out = await payManually(id);
    expect(out).toMatchObject({ kind: "paid", method: "cash", via: "staff", amountCents: 3540 });
    const [r] = await records(id);
    expect(r).toMatchObject({ state: "pending", attempts: 0 });
    const wait = r.next_attempt_at.getTime() - r.created_at.getTime();
    expect(wait).toBeGreaterThan(4.9 * 60_000);
    expect(wait).toBeLessThan(5.1 * 60_000);

    await pushCashRecords();
    expect(h.gateway.cashPayments).toHaveLength(0);
  });

  it("…and if Square POS reports the sale in that time, the waiting copy is never sent", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    await payManually(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });

    expect(await handlePosReturn(okCallback(link.state, sale.orderId))).toMatchObject({ result: "paid" });
    const rows = await records(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "recorded", attempts: 1, square_payment_id: sale.paymentId, order_lines: null });
    expect(await audits(h, id, "square.cash_from_pos")).toHaveLength(1);
    expect(await audits(h, id, "payment.conflict")).toHaveLength(0);
    // Still attributed to the person who marked it paid.
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_via: "staff" });

    await h.raw(null, `update public.square_cash_records set next_attempt_at = now()`);
    await pushCashRecords();
    expect(h.gateway.cashPayments).toHaveLength(0);
    expect(h.gateway.payments.size).toBe(1);
  });

  it("…but if the app's copy has already gone to Square, the double sale is flagged for a person", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    await payManually(id);
    await h.raw(null, `update public.square_cash_records set next_attempt_at = now()`);
    await pushCashRecords();
    expect(h.gateway.cashPayments).toHaveLength(1);

    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    const out = await handlePosReturn(okCallback(link.state, sale.orderId));
    expect(out.result).toBe("error");
    expect(out.message).toMatch(/may be in Square twice/);
    await handlePosReturn(okCallback(link.state, sale.orderId));
    expect(await audits(h, id, "payment.conflict")).toHaveLength(1);
    expect(await records(id)).toHaveLength(1);
  });

  it("Square can't be asked: staff can still mark it paid, and the skipped check is on record", async () => {
    const id = await oddBill();
    await handoff(id);
    h.gateway.posError = squareTimeout();
    const out = await payManually(id);
    expect(out).toMatchObject({ kind: "paid", method: "cash", via: "staff" });
    expect((await getSession(h, id)).status).toBe("paid");
    const [skipped] = await audits(h, id, "cash.handoff_check_skipped");
    expect(skipped.reason).toMatch(/^Cash for this bill was sent to Square POS at \d{1,2}:\d{2}.*marked paid by hand, and Square couldn't be reached.*Check Square for two cash sales of \$35\.40 around then and refund one if so\.$/);
    expect((await getSummary(null)).attention.map((x) => x.action)).toContain("cash.handoff_check_skipped");
    const [r] = await records(id);
    expect(r.next_attempt_at.getTime() - r.created_at.getTime()).toBeGreaterThan(4.9 * 60_000);
  });

  it("with no handoff, or for a card, nothing is asked of Square and nothing waits", async () => {
    const a = await oddBill("Table 1");
    await payManually(a);
    const [r] = await records(a);
    expect(r.next_attempt_at.getTime() - r.created_at.getTime()).toBeLessThan(1000);

    const b = await oddBill("Table 2");
    await handoff(b);
    const out = await markPaidCheckingPos(h.staff.actor, b, "card", { cardConfirmed: true }, at(100));
    expect(out).toMatchObject({ kind: "paid", method: "card", via: "staff", amountCents: 3542 });
    expect(h.gateway.posReads).toEqual([]);
  });
});

describe("P6. after a Square POS cash sale", () => {
  it("reversing the payment refunds that sale through the outbox", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    await handlePosReturn(okCallback(link.state, sale.orderId));

    await reverse(id);
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", settled_cents: null });
    expect((await records(id))[0]).toMatchObject({ state: "pending", want: "refunded" });
    await pushCashRecords();

    expect(h.gateway.cashPayments).toHaveLength(0); // nothing re-sent
    expect(h.gateway.refunds).toEqual([
      { idempotencyKey: `${id}-cr1`, paymentId: sale.paymentId, amountCents: 3540, reason: "Payment reversed in the table timer" },
    ]);
    expect((await records(id))[0]).toMatchObject({ state: "refunded", square_refund_id: "ref_1" });

    // The old callback can't pay the bill a second time.
    const again = await handlePosReturn(okCallback(link.state, sale.orderId));
    expect(again.result).toBe("error");
    expect((await getSession(h, id)).status).toBe("awaiting_payment");

    // Paid again by hand: a new record with its own keys.
    await h.raw(null, `alter table public.audit_log disable trigger audit_log_no_update`);
    await h.raw(null, `update public.audit_log set at = now() - interval '31 minutes' where action = 'cash.handoff_started'`);
    await h.raw(null, `alter table public.audit_log enable trigger audit_log_no_update`);
    await payManually(id);
    await pushCashRecords();
    expect(h.gateway.cashPayments.map((p) => p.idempotencyKey)).toEqual([`${id}-cp2`]);
  });

  it("a card payment completing afterwards is flagged as a second payment, not as a confirmation", async () => {
    const id = await oddBill();
    await chargeCard(h.staff.actor, id);
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "CANCELED", referenceId: id, cancelReason: "SELLER_CANCELED", amountCents: null }));
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    await handlePosReturn(okCallback(link.state, sale.orderId));

    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "COMPLETED", referenceId: id, cancelReason: null, amountCents: null }));
    expect(await audits(h, id, "payment.confirmed_by_square")).toHaveLength(0);
    const [c] = await audits(h, id, "payment.conflict");
    expect(c.reason).toMatch(/after this session was paid in cash/);
  });
});

describe("P8. one bill's cash can't pay another bill", () => {
  it("a lone sale carrying another bill's reference is never taken by amount", async () => {
    // Two $35.40 bills. A's cash is taken in Square POS but A isn't settled yet (its callback
    // came back pending). B is handed over and cancelled in POS.
    const a = await oddBill("Table 1");
    const b = await oddBill("Table 2");
    const linkA = await handoff(a);
    const saleA = h.gateway.posSale({ amountCents: 3540, note: linkA.notes });
    await handoff(b);

    expect(await checkCashHandoff(h.staff.actor, b)).toEqual({ paid: false });
    expect((await getSession(h, b)).status).toBe("awaiting_payment");
    // Marking B paid by hand doesn't take A's sale either.
    expect(await payManually(b)).toMatchObject({ kind: "paid", via: "staff" });
    expect((await records(b))[0]).toMatchObject({ state: "pending", square_payment_id: null });

    // A still gets its own sale.
    expect(await checkCashHandoff(h.staff.actor, a)).toEqual({ paid: true });
    expect((await records(a))[0].square_payment_id).toBe(saleA.paymentId);
  });

  it("an unmarked sale is still taken when the only other candidates belong to other bills", async () => {
    const a = await oddBill("Table 1");
    const b = await oddBill("Table 2");
    const linkA = await handoff(a);
    h.gateway.posSale({ amountCents: 3540, note: linkA.notes });
    await handoff(b);
    const saleB = h.gateway.posSale({ amountCents: 3540 }); // B's own sale, note lost
    expect(await checkCashHandoff(h.staff.actor, b)).toEqual({ paid: true });
    expect((await records(b))[0].square_payment_id).toBe(saleB.paymentId);
  });

  it("if this bill's sale has been put against another bill, staff are told and it is flagged once", async () => {
    const a = await oddBill("Table 1");
    const b = await oddBill("Table 2");
    const linkA = await handoff(a);
    const saleA = h.gateway.posSale({ amountCents: 3540, note: linkA.notes });
    // However it happened, A's sale is on B.
    await h.raw(
      null,
      `insert into public.square_cash_records (session_id, seq, amount_cents, bill_cents, state, attempts, square_payment_id)
       values ('${b}', 1, 3540, 3542, 'recorded', 1, '${saleA.paymentId}')`,
    );

    for (let i = 0; i < 2; i++) {
      await expect(checkCashHandoff(h.staff.actor, a)).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/\$35\.40 cash sale Square POS took for this bill has been put against a different bill/),
      });
    }
    const out = await handlePosReturn(okCallback(linkA.state, saleA.orderId));
    expect(out.result).toBe("error");
    expect(out.message).toMatch(/put against a different bill/);

    expect((await getSession(h, a)).status).toBe("awaiting_payment");
    expect(await records(a)).toHaveLength(0);
    const flagged = await audits(h, a, "payment.conflict");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].after).toMatchObject({ square_payment_id: saleA.paymentId, other_session_id: b });
    expect((await getSummary(null)).attention.some((x) => x.action === "payment.conflict" && x.entityId === a)).toBe(true);
  });

  it("the database refuses one Square payment on two records", async () => {
    const a = await oddBill("Table 1");
    const b = await oddBill("Table 2");
    const row = (sid: string) =>
      `insert into public.square_cash_records (session_id, seq, amount_cents, bill_cents, state, attempts, square_payment_id)
       values ('${sid}', 1, 3540, 3542, 'recorded', 1, 'pay_same')`;
    await h.raw(null, row(a));
    const e = await h.rawError(null, row(b));
    expect(e.code).toBe("23505");
    expect(e.message).toMatch(/square_cash_records_payment_uniq/);
    // Rows with no payment yet don't collide.
    await payManually(b);
    const c = await oddBill("Table 3");
    await payManually(c);
  });

  it("two bills reaching for the same sale at once: the loser is flagged, not a 500", async () => {
    const a = await oddBill("Table 1");
    const b = await oddBill("Table 2");
    await handoff(a);
    const linkB = await handoff(b);
    const sale = h.gateway.posSale({ amountCents: 3540 });
    // A wins the race.
    await h.raw(
      null,
      `insert into public.square_cash_records (session_id, seq, amount_cents, bill_cents, state, attempts, square_payment_id)
       values ('${a}', 1, 3540, 3542, 'recorded', 1, '${sale.paymentId}')`,
    );
    // B's transaction started before A committed: its own "is this sale taken?" read saw nothing.
    let blind = true;
    const real = h.sql.begin.bind(h.sql);
    vi.spyOn(h.sql, "begin").mockImplementation(((fn: (tx: Db) => Promise<unknown>) =>
      real((tx) => {
        const wrapped = new Proxy(tx, {
          apply(target, thisArg, args: unknown[]) {
            const first = args[0];
            if (blind && Array.isArray(first) && first.join("").includes("select session_id from public.square_cash_records where square_payment_id")) {
              blind = false;
              return Promise.resolve([]);
            }
            return Reflect.apply(target, thisArg, args) as unknown;
          },
        });
        return fn(wrapped as unknown as Db);
      })) as typeof h.sql.begin);

    const out = await handlePosReturn(okCallback(linkB.state, sale.orderId));
    expect(blind).toBe(false);
    expect(out.result).toBe("error");
    expect(out.message).toMatch(/put against a different bill/);
    expect((await getSession(h, b)).status).toBe("awaiting_payment");
    expect(await records(b)).toHaveLength(0);
    expect(await audits(h, b, "payment.conflict")).toHaveLength(1);
  });
});

describe("P9. the five-minute hold and what a manager sees", () => {
  it("a manager's retry does not release a held sale", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    await payManually(id);
    const [held] = await records(id);

    const left = await retryCashRecords(h.staff.managerActor, h.staff.manager);
    expect(h.gateway.cashPayments).toHaveLength(0);
    // Still counted: it isn't in Square yet.
    expect(left).toMatchObject({ pending: 1, failed: 0 });
    expect(await getCashOutstanding()).toMatchObject({ pending: 1 });
    const [after] = await records(id);
    expect(after).toMatchObject({ state: "pending", attempts: 0 });
    expect(after.next_attempt_at.getTime()).toBe(held.next_attempt_at.getTime());

    // So Square POS's own sale can still claim it, and Square has the sale once.
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    expect(await handlePosReturn(okCallback(link.state, sale.orderId))).toMatchObject({ result: "paid" });
    expect(h.gateway.payments.size).toBe(1);
  });

  it("retry still releases a sale that is waiting because Square was down", async () => {
    const id = await oddBill();
    await payManually(id); // no handoff
    h.gateway.cashError = squareTimeout();
    await pushCashRecords(); // attempts 1, backed off
    await retryCashRecords(h.staff.managerActor, h.staff.manager);
    expect((await records(id))[0].state).toBe("recorded");
  });

  it("handed to Square POS, never confirmed, then marked paid by hand: on Needs attention with what to do", async () => {
    const id = await oddBill();
    await handoff(id);
    await payManually(id);

    const rows = await audits(h, id, "cash.handoff_unconfirmed");
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(
      /^Cash for this bill was sent to Square POS at \d{1,2}:\d{2}.*\. It was never confirmed, and the bill was then marked paid by hand\. Check Square for two cash sales of \$35\.40 around then and refund one if so\.$/,
    );
    const attention = (await getSummary(null)).attention.filter((x) => x.entityId === id);
    expect(attention.map((x) => x.action)).toContain("cash.handoff_unconfirmed");
  });

  it("an offline sale the callback couldn't confirm is on Needs attention too", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    await handlePosReturn(okCallback(link.state));
    const [row] = await audits(h, id, "cash.handoff_unconfirmed");
    expect(row.reason).toMatch(/Square POS said it took the cash \(offline\), but Square didn't show the sale\. If the bill ends up marked paid by hand, check Square for two cash sales of \$35\.40/);
    expect((await getSummary(null)).attention.map((x) => x.action)).toContain("cash.handoff_unconfirmed");
  });

  it("no flag when Square POS's sale was found, or when there was no handoff", async () => {
    const a = await oddBill("Table 1");
    const link = await handoff(a);
    h.gateway.posSale({ amountCents: 3540, note: link.notes });
    await payManually(a);
    const b = await oddBill("Table 2");
    await payManually(b);
    expect(await audits(h, a, "cash.handoff_unconfirmed")).toHaveLength(0);
    expect(await audits(h, b, "cash.handoff_unconfirmed")).toHaveLength(0);
  });
});

describe("P7. the public return route", () => {
  const post = async (body: string, headers: Record<string, string> = {}) => {
    const { POST } = await import("@/app/api/pos/return/route");
    return POST(new Request("https://example.test/api/pos/return", { method: "POST", headers, body }));
  };

  it("needs no cookies: a good callback settles the bill", async () => {
    const id = await oddBill();
    const link = await handoff(id);
    const sale = h.gateway.posSale({ amountCents: 3540, note: link.notes });
    const res = await post(JSON.stringify({ data: okCallback(link.state, sale.orderId) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "paid", message: "$35.40 cash recorded." });
    expect((await getSession(h, id)).status).toBe("paid");
  });

  it("garbage gets a quick answer and touches nothing", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ nope: 1 }))).status).toBe(400);
    expect((await post(JSON.stringify({ data: "x".repeat(5000) }))).status).toBe(400);
    expect((await post("x".repeat(9000))).status).toBe(400);
    expect((await post("{}", { "content-length": "999999" })).status).toBe(400);
    const res = await post(JSON.stringify({ data: JSON.stringify({ status: "ok", transaction_id: "abc", state: "forged" }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("error");
    expect(h.gateway.posReads).toEqual([]);
  });
});
