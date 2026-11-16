import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import {
  applyWebhookCheckout,
  chargeCard,
  markPaid,
  pauseSession,
  resumeSession,
  startSession,
  stopSession,
  transferSession,
} from "@/lib/server/sessions";
import { withTx } from "@/lib/server/db";
import { getSessionDetail, getSummary } from "@/lib/server/queries";
import { at, audits, auditActions, getSession, occupiedTables } from "./helpers/util";

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
afterEach(() => {
  vi.useRealTimers();
});

/** The brief's pause + transfer scenario: 40 + 25 on Table 2, 20 on Table 5 = 85 min = $35.42. */
async function playSession(): Promise<string> {
  const { actor } = h.staff;
  const { sessionId } = await startSession(actor, h.tableId("Table 2"), at(0));
  await pauseSession(actor, sessionId, at(40));
  await resumeSession(actor, sessionId, at(50));
  await transferSession(actor, sessionId, h.tableId("Table 5"), at(75));
  const r = await stopSession(actor, sessionId, at(95));
  expect(r).toEqual({ status: "awaiting_payment", billedMinutes: 85, totalCents: 3542 });
  return sessionId;
}

const freeze = (d: Date) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(d);
};

describe("section 10 acceptance", () => {
  it("card: charge puts the exact amount on the Terminal, the webhook pays it, the summary shows card", async () => {
    const id = await playSession();
    await chargeCard(h.staff.actor, id);
    expect(h.gateway.creates).toHaveLength(1);
    expect(h.gateway.creates[0]).toMatchObject({ amountCents: 3542, deviceId: "DEVICE_TEST", referenceId: id });

    freeze(at(100)); // webhook arrives 5 min after the stop
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "COMPLETED", referenceId: id, cancelReason: null, amountCents: null }));

    const s = await getSession(h, id);
    expect(s).toMatchObject({ status: "paid", settled_method: "card", settled_via: "square_webhook", settled_by: null });
    expect(await occupiedTables(h)).toEqual([]);

    const sum = await getSummary(null);
    expect(sum.businessDate).toBe("2026-11-20");
    expect(sum.paid.card).toEqual({ count: 1, cents: 3542 });
    expect(sum.paid.cash).toEqual({ count: 0, cents: 0 });
    expect(sum.sessions).toEqual({ count: 1, billedMinutes: 85, billedCents: 3542, tableCents: 3542, itemsCents: 0 });
    expect(sum.unpaid.count).toBe(0);
    expect(sum.paidItems[0]).toMatchObject({ id, method: "card", via: "square_webhook", tableNames: "Table 2 → Table 5", totalCents: 3542 });

    const d = await getSessionDetail(id);
    expect(d.breakdown).toMatchObject({ billedMinutes: 85, totalCents: 3542 });
    expect(d.audit.map((a) => a.action)).toEqual([
      "session.start", "session.pause", "session.resume", "session.transfer", "session.stop", "checkout.sent", "session.paid",
    ]);
  });

  it("webhooks disabled: staff mark-paid settles it and the audit log shows who did it", async () => {
    const id = await playSession();
    await chargeCard(h.staff.actor, id);
    // No webhook ever arrives. Staff confirm on the Terminal and tap Mark paid - card.
    h.gateway.cancelDefault = "CANCELED";
    await markPaid(h.staff.actor, id, "card", { cardConfirmed: true }, at(100));
    const s = await getSession(h, id);
    expect(s).toMatchObject({ status: "paid", settled_method: "card", settled_via: "staff", settled_by: h.staff.actor.staffId });
    const [row] = await audits(h, id, "session.mark_paid");
    expect(row.actor_staff_id).toBe(h.staff.actor.staffId);
    expect(row.device_label).toBe("Counter");
    freeze(at(101));
    expect((await getSummary(null)).paid.card).toEqual({ count: 1, cents: 3542 });
  });

  it("cash: stop, mark paid in the app, the summary shows it under cash (and never reaches the Terminal)", async () => {
    const id = await playSession();
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(100));
    expect(h.gateway.creates).toHaveLength(0);
    expect(h.gateway.cancels).toHaveLength(0);

    freeze(at(105));
    const sum = await getSummary(null);
    expect(sum.paid.cash).toEqual({ count: 1, cents: 3542 });
    expect(sum.paid.card).toEqual({ count: 0, cents: 0 });
    expect(sum.paidItems).toHaveLength(1);
    expect(sum.paidItems[0]).toMatchObject({ method: "cash", via: "staff", settledByName: "Sam Staff" });
    expect(await auditActions(h, id)).toEqual([
      "session.start", "session.pause", "session.resume", "session.transfer", "session.stop", "session.mark_paid",
    ]);
  });
});
