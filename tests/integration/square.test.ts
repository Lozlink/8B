import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import {
  applyWebhookCheckout,
  cancelCheckout,
  chargeCard,
  markPaid,
  resendCheckout,
  startSession,
  stopSession,
  syncCheckout,
} from "@/lib/server/sessions";
import { withTx } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { T0, at, audits, auditActions, awaitingPayment, getCheckouts, getSession, occupiedTables } from "./helpers/util";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
});

const webhook = (id: string, status: string, referenceId: string | null) =>
  withTx((tx) => applyWebhookCheckout(tx, { id, status, referenceId, cancelReason: null, amountCents: null }));

describe("11. chargeCard", () => {
  it("sends the exact amount with a stable idempotency key and records the checkout", async () => {
    const id = await awaitingPayment(h, "Table 1", 60); // 60 min x $25 = 2500 c
    const out = await chargeCard(h.staff.actor, id);
    expect(out).toEqual({ kind: "sent", checkoutId: "chk_1", amountCents: 2500 });

    expect(h.gateway.creates).toHaveLength(1);
    expect(h.gateway.creates[0]).toMatchObject({
      idempotencyKey: `${id}-a1i`,
      amountCents: 2500,
      deviceId: "DEVICE_TEST",
      referenceId: id,
    });
    expect(h.gateway.creates[0].note).toMatch(/Table 1/);
    expect(h.gateway.creates[0].idempotencyKey.length).toBeLessThanOrEqual(64);

    const s = await getSession(h, id);
    expect(s.total_cents).toBe(2500);
    expect(s.square_checkout_id).toBe("chk_1");
    expect(s.checkout_attempt).toBe(1);
    expect(s.status).toBe("awaiting_payment");

    const cos = await getCheckouts(h, id);
    expect(cos).toHaveLength(1);
    expect(cos[0]).toMatchObject({ id: "chk_1", attempt: 1, amount_cents: 2500, status: "PENDING" });

    const [row] = await audits(h, id, "checkout.sent");
    expect(row.actor_staff_id).toBe(h.staff.actor.staffId);
    expect(row.after).toMatchObject({ checkout_id: "chk_1", attempt: 1, amount_cents: 2500 });
  });

  it("a second charge while one is live conflicts and sends nothing", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(h.gateway.creates).toHaveLength(1);
    expect(await getCheckouts(h, id)).toHaveLength(1);
  });

  it("refuses when no Terminal is paired", async () => {
    await h.sql`update public.settings set terminal_device_id = null`;
    const id = await awaitingPayment(h);
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.creates).toHaveLength(0);
  });
});

describe("12. Square failure rolls back", () => {
  it("leaves no checkout row, keeps checkout_attempt, and the retry reuses the same key", async () => {
    const id = await awaitingPayment(h);
    h.gateway.createError = new AppError(502, "square_error", "Square is down");
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 502, code: "square_error" });

    expect(await getCheckouts(h, id)).toHaveLength(0);
    const s = await getSession(h, id);
    expect(s.checkout_attempt).toBe(0);
    expect(s.square_checkout_id).toBeNull();
    expect(await auditActions(h, id)).not.toContain("checkout.sent");

    const retry = await chargeCard(h.staff.actor, id);
    expect(retry.kind).toBe("sent");
    expect(h.gateway.creates).toHaveLength(2);
    expect(h.gateway.creates[1].idempotencyKey).toBe(h.gateway.creates[0].idempotencyKey);
    expect(h.gateway.creates[1].idempotencyKey).toBe(`${id}-a1i`);
    expect((await getSession(h, id)).checkout_attempt).toBe(1);
  });
});

describe("13. webhook completion", () => {
  it("COMPLETED marks the session paid by card via the webhook and frees the table", async () => {
    const id = await awaitingPayment(h, "Table 4", 60);
    await chargeCard(h.staff.actor, id);
    expect(await webhook("chk_1", "COMPLETED", id)).toBe("applied");

    const s = await getSession(h, id);
    expect(s).toMatchObject({ status: "paid", settled_method: "card", settled_via: "square_webhook", settled_by: null });
    expect(s.settled_at).toBeInstanceOf(Date);
    expect(s.current_table_id).toBeNull();
    expect(await occupiedTables(h)).toEqual([]);
    expect((await getCheckouts(h, id))[0].status).toBe("COMPLETED");

    const [row] = await audits(h, id, "session.paid");
    expect(row.actor_staff_id).toBeNull();
    expect(row.device_label).toBe("Square webhook");
    expect(row.after).toMatchObject({ settled_via: "square_webhook", settled_method: "card", amount_cents: 2500 });
  });

  it("an out-of-order IN_PROGRESS afterwards leaves the checkout COMPLETED and the session paid", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await webhook("chk_1", "COMPLETED", id);
    expect(await webhook("chk_1", "IN_PROGRESS", id)).toBe("applied");
    expect(await webhook("chk_1", "PENDING", id)).toBe("applied");
    expect((await getCheckouts(h, id))[0].status).toBe("COMPLETED");
    expect((await getSession(h, id)).status).toBe("paid");
    expect(await audits(h, id, "session.paid")).toHaveLength(1);
  });

  it("a replayed COMPLETED does not double-record the payment", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await webhook("chk_1", "COMPLETED", id);
    await webhook("chk_1", "COMPLETED", id);
    expect(await audits(h, id, "session.paid")).toHaveLength(1);
    expect(await audits(h, id, "payment.conflict")).toHaveLength(0);
  });

  it("IN_PROGRESS then CANCELED keeps the session awaiting payment and records the cancel", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await webhook("chk_1", "IN_PROGRESS", id);
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "CANCELED", referenceId: id, cancelReason: "BUYER_CANCELED", amountCents: null }));
    const [co] = await getCheckouts(h, id);
    expect(co).toMatchObject({ status: "CANCELED", cancel_reason: "BUYER_CANCELED" });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    expect(await auditActions(h, id)).toContain("checkout.canceled");
    // and the bill can be charged again with a fresh attempt
    const again = await chargeCard(h.staff.actor, id);
    expect(again.kind).toBe("sent");
    expect(h.gateway.creates[1].idempotencyKey).toBe(`${id}-a2i`);
  });

  it("an unrecognised status is ignored", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    expect(await webhook("chk_1", "WHATEVER", id)).toBe("ignored");
  });
});

describe("14. markPaid with a live checkout", () => {
  it("cancels the checkout first, then records cash", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelDefault = "CANCELED";
    const out = await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(70));
    expect(h.gateway.cancels).toEqual(["chk_1"]);
    expect(out).toMatchObject({ kind: "paid", method: "cash", via: "staff" });
    expect((await getCheckouts(h, id))[0].status).toBe("CANCELED");
    expect((await getSession(h, id)).settled_method).toBe("cash");
  });

  it("if the cancel reveals COMPLETED the bill is paid by card via the API and no cash is recorded", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelFor.set("chk_1", "COMPLETED");
    const out = await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(70));
    expect(out.kind).toBe("already_paid_by_card");
    expect(h.gateway.cancels).toEqual(["chk_1"]);

    const s = await getSession(h, id);
    expect(s).toMatchObject({ status: "paid", settled_method: "card", settled_via: "square_api" });
    expect(await audits(h, id, "session.mark_paid")).toHaveLength(0);
    expect(await audits(h, id, "session.paid")).toHaveLength(1);
    expect((await getCheckouts(h, id))[0].status).toBe("COMPLETED");
  });

  it("markPaid after a card was already settled by Square reports already_paid_by_card", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await webhook("chk_1", "COMPLETED", id);
    const out = await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(70));
    expect(out.kind).toBe("already_paid_by_card");
    expect((await getSession(h, id)).settled_method).toBe("card");
  });

  it("if Square can't be reached the cancel failure is audited and surfaced as a warning", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelFor.set("chk_1", new AppError(502, "square_error", "Square is down"));
    const out = await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(70));
    expect(out.kind).toBe("paid");
    expect(out.warnings.join(" ")).toMatch(/Terminal by hand/);
    expect(await auditActions(h, id)).toContain("checkout.cancel_failed");
  });
});

describe("15. webhook after staff settlement", () => {
  it("COMPLETED after staff marked paid by card while the Terminal was still cancelling is a payment.conflict (R2)", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    // Terminal says the cancel is still pending (card may be tapped at the same instant).
    h.gateway.cancelFor.set("chk_1", "CANCEL_REQUESTED");
    await markPaid(h.staff.actor, id, "card", { cardConfirmed: true }, at(70));
    expect((await getSession(h, id)).settled_via).toBe("staff");

    await webhook("chk_1", "COMPLETED", id);
    const s = await getSession(h, id);
    expect(s).toMatchObject({ status: "paid", settled_method: "card", settled_via: "staff" });
    expect(await audits(h, id, "payment.conflict")).toHaveLength(1);
    expect(await audits(h, id, "payment.confirmed_by_square")).toHaveLength(0);
  });

  it("COMPLETED after staff marked paid in cash raises a payment.conflict", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelFor.set("chk_1", "CANCELED");
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(70));

    await webhook("chk_1", "COMPLETED", id);
    const s = await getSession(h, id);
    expect(s).toMatchObject({ status: "paid", settled_method: "cash", settled_via: "staff" });
    const [c] = await audits(h, id, "payment.conflict");
    expect(c).toBeDefined();
    expect(c.reason).toMatch(/cash/i);
    expect(await audits(h, id, "payment.confirmed_by_square")).toHaveLength(0);
  });
});

describe("16. unknown checkout in a webhook", () => {
  it("returns unknown and audits it (no session reference)", async () => {
    expect(await webhook("chk_nope", "COMPLETED", null)).toBe("unknown");
    const rows = await audits(h, "chk_nope", "webhook.unknown_checkout");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_staff_id).toBeNull();
    expect(rows[0].entity).toBe("square_checkout");
  });

  it("adopts an unrecognised checkout whose reference is a real awaiting session (R3)", async () => {
    const id = await awaitingPayment(h);
    expect(await webhook("chk_stranger", "COMPLETED", id)).toBe("applied");
    const [co] = await getCheckouts(h, id);
    expect(co).toMatchObject({ id: "chk_stranger", attempt: 1 });
    expect(await getSession(h, id)).toMatchObject({ status: "paid", checkout_attempt: 1, square_checkout_id: "chk_stranger" });
    expect(await audits(h, id, "checkout.adopted")).toHaveLength(1);
    expect(await audits(h, "chk_stranger", "webhook.unknown_checkout")).toHaveLength(0);
  });

  it("a reference to a session that doesn't exist is unknown and audited on the square_checkout", async () => {
    expect(await webhook("chk_stranger", "COMPLETED", "00000000-0000-4000-8000-0000000000ff")).toBe("unknown");
    expect(await audits(h, "chk_stranger", "webhook.unknown_checkout")).toHaveLength(1);
  });

  it("returns unknown for a malformed reference id", async () => {
    expect(await webhook("chk_x", "COMPLETED", "not-a-uuid")).toBe("unknown");
  });
});

describe("17. resendCheckout", () => {
  it("cancels the live checkout then sends attempt 2", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelDefault = "CANCELED";
    const out = await resendCheckout(h.staff.actor, id);
    expect(out).toMatchObject({ kind: "sent", checkoutId: "chk_2", amountCents: 2500 });
    expect(h.gateway.cancels).toEqual(["chk_1"]);
    expect(h.gateway.creates.map((c) => c.idempotencyKey)).toEqual([`${id}-a1i`, `${id}-a2i`]);
    const cos = await getCheckouts(h, id);
    expect(cos.map((c) => [c.attempt, c.status])).toEqual([
      [1, "CANCELED"],
      [2, "PENDING"],
    ]);
    const s = await getSession(h, id);
    expect(s.square_checkout_id).toBe("chk_2");
    expect(s.checkout_attempt).toBe(2);
  });

  it("CANCEL_REQUESTED -> conflict, no new checkout, attempt unchanged", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelDefault = "CANCEL_REQUESTED";
    await expect(resendCheckout(h.staff.actor, id)).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(h.gateway.creates).toHaveLength(1);
    const cos = await getCheckouts(h, id);
    expect(cos).toHaveLength(1);
    expect((await getSession(h, id)).checkout_attempt).toBe(1);
  });

  it("if the cancel reveals the card already went through, no new checkout and the bill is paid", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelDefault = "COMPLETED";
    const out = await resendCheckout(h.staff.actor, id);
    expect(out.kind).toBe("already_paid_by_card");
    expect(h.gateway.creates).toHaveLength(1);
    expect((await getSession(h, id)).status).toBe("paid");
  });

  it("if Square is unreachable on cancel, nothing new is sent", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelDefault = new AppError(502, "square_error", "down");
    await expect(resendCheckout(h.staff.actor, id)).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.creates).toHaveLength(1);
  });
});

describe("cancelCheckout and syncCheckout", () => {
  it("cancelCheckout moves a live checkout to CANCELED and keeps the bill unpaid", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    const r = await cancelCheckout(h.staff.actor, id);
    expect(r).toMatchObject({ status: "CANCELED", paid: false });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
  });

  it("cancelCheckout with nothing live conflicts", async () => {
    const id = await awaitingPayment(h);
    await expect(cancelCheckout(h.staff.actor, id)).rejects.toMatchObject({ status: 409 });
  });

  it("syncCheckout picks up a COMPLETED payment when the webhook never arrived", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.getFor.set("chk_1", "COMPLETED");
    await syncCheckout(h.staff.actor, id);
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "card", settled_via: "square_api" });
  });

  it("charge replayed by Square as already COMPLETED pays the bill immediately", async () => {
    const id = await awaitingPayment(h);
    h.gateway.createStatus = "COMPLETED";
    const out = await chargeCard(h.staff.actor, id);
    expect(out.kind).toBe("already_paid_by_card");
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_via: "square_api" });
  });
});

describe("single-connection sanity", () => {
  it("startSession/stopSession with T0 is deterministic across resets", async () => {
    const a = await startSession(h.staff.actor, h.tableId("Table 6"), T0);
    const r = await stopSession(h.staff.actor, a.sessionId, at(30));
    expect(r.totalCents).toBe(1250);
  });
});
