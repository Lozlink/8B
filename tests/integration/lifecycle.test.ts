import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import {
  markPaid,
  pauseSession,
  releaseTable,
  resumeSession,
  startSession,
  stopSession,
  transferSession,
  voidSession,
  chargeCard,
} from "@/lib/server/sessions";
import { TransitionError } from "@/lib/domain/machine";
import { getPricingConfig, pricingSettingsOf } from "@/lib/server/repo";
import { makeSnapshot, price } from "@/lib/pricing";
import {
  at,
  audits,
  auditActions,
  awaitingPayment,
  getIntervals,
  getSession,
  occupiedTables,
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
});

describe("6. start -> pause -> resume -> transfer -> stop", () => {
  it("bills exactly the hand-calculated amount", async () => {
    const { actor } = h.staff;
    const t2 = h.tableId("Table 2");
    const t5 = h.tableId("Table 5");

    // Table 2: 40 min, 10 min paused, 25 min more, then Table 5 for 20 min = 85 min billed.
    // 85 min is a multiple of 5 and above the 30 min minimum: 85/60 h x $25.00 = $35.4166.. -> 3542 c.
    const { sessionId } = await startSession(actor, t2, at(0));
    await pauseSession(actor, sessionId, at(40));
    expect((await getSession(h, sessionId)).status).toBe("paused");
    await resumeSession(actor, sessionId, at(50));
    await transferSession(actor, sessionId, t5, at(75));
    const result = await stopSession(actor, sessionId, at(95));

    expect(result).toEqual({ status: "awaiting_payment", billedMinutes: 85, totalCents: 3542 });

    const s = await getSession(h, sessionId);
    expect(s.status).toBe("awaiting_payment");
    expect(s.billed_minutes).toBe(85);
    expect(s.total_cents).toBe(3542);
    expect(s.closed_at).toEqual(at(95));
    expect(s.closed_by).toBe(actor.staffId);
    expect(s.opened_by).toBe(actor.staffId);
    // The bill stays on Table 5 until paid / released.
    expect(s.current_table_id).toBe(t5);

    // Intervals: all closed, on the right tables, at the right instants.
    const intervals = await getIntervals(h, sessionId);
    expect(intervals.map((i) => [i.table_name, i.started_at, i.ended_at])).toEqual([
      ["Table 2", at(0), at(40)],
      ["Table 2", at(50), at(75)],
      ["Table 5", at(75), at(95)],
    ]);

    // Rate snapshot stored and agrees with the pricing engine.
    expect(s.rate_snapshot).not.toBeNull();
    expect(s.rate_snapshot?.rateCards).toHaveLength(1);
    expect(s.rate_snapshot?.rateCards[0].centsPerHour).toBe(2500);
    expect(s.rate_snapshot?.settings).toMatchObject({ roundingMinutes: 5, graceMinutes: 0, minimumMinutes: 30 });
    const cfg = await getPricingConfig(h.sql);
    const expected = price({
      intervals: intervals.map((i) => ({ startedAt: i.started_at, endedAt: i.ended_at })),
      rateCards: cfg.rateCards,
      settings: pricingSettingsOf(cfg.settings),
      now: at(95),
    });
    expect(expected.totalCents).toBe(3542);
    expect(makeSnapshot(cfg.rateCards, pricingSettingsOf(cfg.settings), at(95)).settings).toEqual(s.rate_snapshot?.settings);

    // Audit trail: one row per step, each carrying who and from which device.
    const rows = await audits(h, sessionId);
    expect(rows.map((r) => r.action)).toEqual([
      "session.start",
      "session.pause",
      "session.resume",
      "session.transfer",
      "session.stop",
    ]);
    for (const r of rows) {
      expect(r.actor_staff_id).toBe(actor.staffId);
      expect(r.device_label).toBe("Counter");
      expect(r.entity).toBe("session");
    }
    expect(rows[3].after).toMatchObject({ table: "Table 5" });
    expect(rows[4].after).toMatchObject({ billed_minutes: 85, total_cents: 3542 });

    // Table 2 was freed by the transfer; Table 5 is held by the unpaid bill.
    expect(await occupiedTables(h)).toEqual(["Table 5"]);
  });

  it("transfer while paused only moves the table; the next resume bills the new table", async () => {
    const { actor } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    await pauseSession(actor, sessionId, at(10));
    await transferSession(actor, sessionId, h.tableId("Table 4"), at(15));
    await resumeSession(actor, sessionId, at(20));
    await stopSession(actor, sessionId, at(50));
    const iv = await getIntervals(h, sessionId);
    expect(iv.map((i) => i.table_name)).toEqual(["Table 1", "Table 4"]);
  });
});

describe("7. table occupancy", () => {
  it("a second session on an occupied table conflicts", async () => {
    const { actor } = h.staff;
    await startSession(actor, h.tableId("Table 1"), at(0));
    await expect(startSession(actor, h.tableId("Table 1"), at(1))).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(await occupiedTables(h)).toEqual(["Table 1"]);
  });

  it("an awaiting-payment bill still holds its table", async () => {
    const { actor } = h.staff;
    await awaitingPayment(h, "Table 1", 60);
    await expect(startSession(actor, h.tableId("Table 1"), at(61))).rejects.toMatchObject({ status: 409 });
  });

  it("transfer to an occupied table conflicts and changes nothing", async () => {
    const { actor } = h.staff;
    const a = await startSession(actor, h.tableId("Table 1"), at(0));
    await startSession(actor, h.tableId("Table 2"), at(0));
    await expect(transferSession(actor, a.sessionId, h.tableId("Table 2"), at(10))).rejects.toMatchObject({ status: 409 });
    const iv = await getIntervals(h, a.sessionId);
    expect(iv).toHaveLength(1);
    expect(iv[0].ended_at).toBeNull();
    expect((await getSession(h, a.sessionId)).current_table_id).toBe(h.tableId("Table 1"));
  });

  it("transfer to the same table is rejected", async () => {
    const a = await startSession(h.staff.actor, h.tableId("Table 1"), at(0));
    await expect(transferSession(h.staff.actor, a.sessionId, h.tableId("Table 1"), at(5))).rejects.toMatchObject({ status: 400 });
  });

  it("an inactive table can't be started", async () => {
    await h.sql`update public.tables set active = false where name = 'Table 7'`;
    await expect(startSession(h.staff.actor, h.tableId("Table 7"), at(0))).rejects.toMatchObject({ status: 409 });
  });

  it("table is freed after mark paid", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(61));
    expect(await occupiedTables(h)).toEqual([]);
    await expect(startSession(h.staff.actor, h.tableId("Table 1"), at(62))).resolves.toBeDefined();
  });

  it("table is freed after releaseTable, and the bill stays awaiting payment", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await releaseTable(h.staff.actor, id);
    expect(await occupiedTables(h)).toEqual([]);
    const s = await getSession(h, id);
    expect(s.status).toBe("awaiting_payment");
    expect(s.total_cents).toBe(2500);
    expect(await auditActions(h, id)).toContain("session.move_to_unpaid");
    // releasing again is a no-op
    await releaseTable(h.staff.actor, id);
    expect((await audits(h, id, "session.move_to_unpaid")).length).toBe(1);
    await expect(startSession(h.staff.actor, h.tableId("Table 1"), at(62))).resolves.toBeDefined();
  });

  it("table is freed after void", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    await voidSession(h.staff.managerActor, h.staff.manager, id, "Customer dispute", at(61));
    expect(await occupiedTables(h)).toEqual([]);
  });
});

describe("8. illegal transitions", () => {
  it("pause twice", async () => {
    const { actor } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    await pauseSession(actor, sessionId, at(5));
    await expect(pauseSession(actor, sessionId, at(6))).rejects.toBeInstanceOf(TransitionError);
  });

  it("resume while running", async () => {
    const { actor } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    await expect(resumeSession(actor, sessionId, at(6))).rejects.toBeInstanceOf(TransitionError);
  });

  it("mark paid while running", async () => {
    const { actor } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    await expect(markPaid(actor, sessionId, "cash", { cardConfirmed: false }, at(5))).rejects.toBeInstanceOf(TransitionError);
    expect((await getSession(h, sessionId)).status).toBe("running");
  });

  it("charge while running", async () => {
    const { actor } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    await expect(chargeCard(actor, sessionId)).rejects.toBeInstanceOf(TransitionError);
    expect(h.gateway.creates).toHaveLength(0);
  });

  it("stop twice, transfer after stop, pause after paid", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await expect(stopSession(actor, id, at(70))).rejects.toBeInstanceOf(TransitionError);
    await expect(transferSession(actor, id, h.tableId("Table 2"), at(70))).rejects.toBeInstanceOf(TransitionError);
    await markPaid(actor, id, "cash", { cardConfirmed: false }, at(71));
    await expect(pauseSession(actor, id, at(72))).rejects.toBeInstanceOf(TransitionError);
    await expect(markPaid(actor, id, "cash", { cardConfirmed: false }, at(72))).rejects.toBeInstanceOf(TransitionError);
  });

  it("unknown / malformed session ids are 404", async () => {
    await expect(pauseSession(h.staff.actor, "not-a-uuid", at(1))).rejects.toMatchObject({ status: 404 });
    await expect(pauseSession(h.staff.actor, "00000000-0000-4000-8000-0000000000ff", at(1))).rejects.toMatchObject({ status: 404 });
  });
});

describe("9. zero-time stop", () => {
  it("is voided with the no-charge reason and frees the table", async () => {
    const { actor } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    const r = await stopSession(actor, sessionId, at(0));
    expect(r).toEqual({ status: "void", billedMinutes: 0, totalCents: 0 });
    const s = await getSession(h, sessionId);
    expect(s.status).toBe("void");
    expect(s.void_reason).toMatch(/No charge/);
    expect(s.voided_by).toBe(actor.staffId);
    expect(s.current_table_id).toBeNull();
    expect(s.total_cents).toBe(0);
    expect(s.rate_snapshot).not.toBeNull();
    expect(await occupiedTables(h)).toEqual([]);
    const iv = await getIntervals(h, sessionId);
    expect(iv[0].ended_at).toEqual(at(0));
    expect(await auditActions(h, sessionId)).toEqual(["session.start", "session.stop_no_charge"]);
  });
});

describe("10. cash and card confirmation", () => {
  it("cash: stop -> markPaid -> paid by staff", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 3", 60);
    const out = await markPaid(actor, id, "cash", { cardConfirmed: false }, at(62));
    expect(out).toMatchObject({ kind: "paid", method: "cash", via: "staff" });
    const s = await getSession(h, id);
    expect(s.status).toBe("paid");
    expect(s.settled_method).toBe("cash");
    expect(s.settled_via).toBe("staff");
    expect(s.settled_by).toBe(actor.staffId);
    expect(s.settled_at).toEqual(at(62));
    expect(s.current_table_id).toBeNull();
    const [row] = await audits(h, id, "session.mark_paid");
    expect(row.actor_staff_id).toBe(actor.staffId);
    expect(row.device_label).toBe("Counter");
    expect(row.after).toMatchObject({ settled_method: "cash", settled_via: "staff", total_cents: 2500 });
  });

  it("card without confirmation is rejected and leaves the bill unpaid", async () => {
    const id = await awaitingPayment(h, "Table 3", 60);
    await expect(markPaid(h.staff.actor, id, "card", { cardConfirmed: false }, at(62))).rejects.toMatchObject({ status: 400 });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
  });

  it("card with confirmation is paid by staff and audited", async () => {
    const id = await awaitingPayment(h, "Table 3", 60);
    const out = await markPaid(h.staff.actor, id, "card", { cardConfirmed: true }, at(62));
    expect(out).toMatchObject({ kind: "paid", method: "card", via: "staff" });
    const s = await getSession(h, id);
    expect(s).toMatchObject({ status: "paid", settled_method: "card", settled_via: "staff", settled_by: h.staff.actor.staffId });
    const [row] = await audits(h, id, "session.mark_paid");
    expect(row.after).toMatchObject({ card_confirmed_by_staff: true });
  });

  it("pricing edge: 31 min rounds to 35 and a 10 min stop is lifted to the 30 min minimum", async () => {
    const a = await startSession(h.staff.actor, h.tableId("Table 1"), at(0));
    const ra = await stopSession(h.staff.actor, a.sessionId, at(31));
    // 31 -> 35 min x 2500/60 = 1458.33 -> 1458
    expect(ra).toMatchObject({ billedMinutes: 35, totalCents: 1458 });
    const b = await startSession(h.staff.actor, h.tableId("Table 2"), at(0));
    const rb = await stopSession(h.staff.actor, b.sessionId, at(10));
    // minimum 30 min = $12.50
    expect(rb).toMatchObject({ billedMinutes: 30, totalCents: 1250 });
  });
});
