import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import {
  chargeCard,
  editTimes,
  markPaid,
  pauseSession,
  reversePaid,
  resumeSession,
  startSession,
  stopSession,
  voidSession,
} from "@/lib/server/sessions";
import { TransitionError } from "@/lib/domain/machine";
import { at, audits, auditActions, awaitingPayment, getIntervals, getSession, occupiedTables } from "./helpers/util";

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

describe("19. voidSession / reversePaid", () => {
  it("voids a running session: closes the interval, frees the table, records manager + reason", async () => {
    const { actor, managerActor, manager } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 2"), at(0));
    const out = await voidSession(managerActor, manager, sessionId, "Started on wrong table", at(10));
    expect(out).toEqual({ kind: "voided" });

    const s = await getSession(h, sessionId);
    expect(s).toMatchObject({
      status: "void",
      voided_by: manager.id,
      void_reason: "Started on wrong table",
      current_table_id: null,
    });
    expect(s.voided_at).toEqual(at(10));
    expect(s.closed_at).toEqual(at(10));
    const iv = await getIntervals(h, sessionId);
    expect(iv).toHaveLength(1);
    expect(iv[0].ended_at).toEqual(at(10));
    expect(await occupiedTables(h)).toEqual([]);

    const [row] = await audits(h, sessionId, "session.void");
    expect(row.approved_by_staff_id).toBe(manager.id);
    expect(row.actor_staff_id).toBe(managerActor.staffId);
    expect(row.reason).toBe("Started on wrong table");
    expect(row.device_label).toBe("Counter");
  });

  it("rejects an empty or blank reason and changes nothing", async () => {
    const { actor, managerActor, manager } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 2"), at(0));
    for (const reason of ["", "   ", "x"]) {
      await expect(voidSession(managerActor, manager, sessionId, reason, at(10))).rejects.toMatchObject({ status: 400 });
    }
    expect((await getSession(h, sessionId)).status).toBe("running");
  });

  it("voids a paused session and an awaiting-payment one", async () => {
    const { actor, managerActor, manager } = h.staff;
    const a = await startSession(actor, h.tableId("Table 1"), at(0));
    await pauseSession(actor, a.sessionId, at(5));
    await voidSession(managerActor, manager, a.sessionId, "Walked out", at(8));
    expect((await getSession(h, a.sessionId)).status).toBe("void");

    const b = await awaitingPayment(h, "Table 2", 45);
    await voidSession(managerActor, manager, b, "Comped by owner", at(50));
    const s = await getSession(h, b);
    expect(s.status).toBe("void");
    expect(s.total_cents).toBe(1875); // 45 min kept on the record
    expect(await occupiedTables(h)).toEqual([]);
  });

  it("a paid session can't be voided directly; reverse then void works", async () => {
    const { actor, managerActor, manager } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await markPaid(actor, id, "cash", { cardConfirmed: false }, at(61));
    await expect(voidSession(managerActor, manager, id, "Mistake", at(62))).rejects.toBeInstanceOf(TransitionError);
    await expect(reversePaid(managerActor, manager, id, "")).rejects.toMatchObject({ status: 400 });

    await reversePaid(managerActor, manager, id, "Cash was a counterfeit note");
    const rev = await getSession(h, id);
    expect(rev).toMatchObject({ status: "awaiting_payment", settled_method: null, settled_via: null, settled_by: null, settled_at: null });
    const [row] = await audits(h, id, "session.reverse_paid");
    expect(row.approved_by_staff_id).toBe(manager.id);
    expect(row.reason).toBe("Cash was a counterfeit note");

    await voidSession(managerActor, manager, id, "Customer never paid; write off", at(63));
    expect((await getSession(h, id)).status).toBe("void");
    expect(await auditActions(h, id)).toEqual([
      "session.start",
      "session.stop",
      "session.mark_paid",
      "session.reverse_paid",
      "session.void",
    ]);
  });

  it("voiding an awaiting-payment bill with a live checkout cancels it first", async () => {
    const { managerActor, manager } = h.staff;
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    const out = await voidSession(managerActor, manager, id, "Customer left", at(70));
    expect(out).toEqual({ kind: "voided" });
    expect(h.gateway.cancels).toEqual(["chk_1"]);
  });

  it("if the live checkout turns out COMPLETED the void is refused (already paid by card)", async () => {
    const { managerActor, manager } = h.staff;
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelFor.set("chk_1", "COMPLETED");
    const out = await voidSession(managerActor, manager, id, "Customer left", at(70));
    expect(out).toEqual({ kind: "already_paid_by_card" });
    expect((await getSession(h, id)).status).toBe("paid");
  });
});

describe("20. editTimes", () => {
  it("re-prices from the rate snapshot, ignoring later rate-card changes", async () => {
    const { actor, managerActor, manager } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    await stopSession(actor, sessionId, at(60));
    expect((await getSession(h, sessionId)).total_cents).toBe(2500);

    // Owner doubles the rate after the stop. The existing bill must keep using the old rate.
    await h.sql`update public.rate_cards set cents_per_hour = 5000`;

    const [iv] = await getIntervals(h, sessionId);
    // Extend to 90 min at the OLD $25/h = 3750 (at the new rate it would be 7500).
    const r = await editTimes(managerActor, manager, sessionId, "Staff forgot to stop the timer", [
      { id: iv.id, startedAt: at(0), endedAt: at(90) },
    ], at(120));
    expect(r.totalCents).toBe(3750);

    const s = await getSession(h, sessionId);
    expect(s.total_cents).toBe(3750);
    expect(s.billed_minutes).toBe(90);
    expect(s.checkout_attempt).toBe(1); // bumped so a new amount never reuses an idempotency key
    expect(s.closed_at).toEqual(at(90));
    expect(s.status).toBe("awaiting_payment");

    const [row] = await audits(h, sessionId, "session.edit_times");
    expect(row.approved_by_staff_id).toBe(manager.id);
    expect(row.reason).toBe("Staff forgot to stop the timer");
    expect(row.before).toMatchObject({ total_cents: 2500, billed_minutes: 60 });
    expect(row.after).toMatchObject({ total_cents: 3750, billed_minutes: 90 });
    const before = row.before as { intervals: { ended_at: string }[] };
    const after = row.after as { intervals: { ended_at: string }[] };
    expect(new Date(before.intervals[0].ended_at)).toEqual(at(60));
    expect(new Date(after.intervals[0].ended_at)).toEqual(at(90));

    // The next card charge uses attempt 2 and the corrected amount.
    await chargeCard(actor, sessionId);
    expect(h.gateway.creates[0]).toMatchObject({ idempotencyKey: `${sessionId}-a2i`, amountCents: 3750 });
  });

  it("requires a reason and refuses to edit while a checkout is live", async () => {
    const { managerActor, manager } = h.staff;
    const id = await awaitingPayment(h);
    const [iv] = await getIntervals(h, id);
    await expect(editTimes(managerActor, manager, id, " ", [{ id: iv.id, startedAt: at(0), endedAt: at(50) }], at(120))).rejects.toMatchObject({ status: 400 });
    await chargeCard(h.staff.actor, id);
    await expect(
      editTimes(managerActor, manager, id, "Fix", [{ id: iv.id, startedAt: at(0), endedAt: at(50) }], at(120)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects overlapping intervals within the session, future times and inverted ranges", async () => {
    const { actor, managerActor, manager } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(0));
    await pauseSession(actor, sessionId, at(20));
    await resumeSession(actor, sessionId, at(30));
    await stopSession(actor, sessionId, at(60));
    const [a, b] = await getIntervals(h, sessionId);
    const edit = (x: { id: string; s: number; e: number }[], now = 120) =>
      editTimes(managerActor, manager, sessionId, "Fixing times", x.map((i) => ({ id: i.id, startedAt: at(i.s), endedAt: at(i.e) })), at(now));

    await expect(edit([{ id: a.id, s: 0, e: 40 }, { id: b.id, s: 30, e: 60 }])).rejects.toMatchObject({ status: 400 });
    await expect(edit([{ id: a.id, s: 0, e: 20 }, { id: b.id, s: 30, e: 200 }])).rejects.toMatchObject({ status: 400 }); // future
    await expect(edit([{ id: a.id, s: 30, e: 20 }, { id: b.id, s: 30, e: 60 }])).rejects.toMatchObject({ status: 400 }); // inverted
    await expect(edit([{ id: a.id, s: 0, e: 20 }])).rejects.toMatchObject({ status: 400 }); // missing interval

    // nothing was changed by the failures
    const iv = await getIntervals(h, sessionId);
    expect(iv.map((i) => [i.started_at, i.ended_at])).toEqual([[at(0), at(20)], [at(30), at(60)]]);
    expect(await audits(h, sessionId, "session.edit_times")).toHaveLength(0);
  });

  it("rejects an edit that overlaps ANOTHER session on the same table (exclusion constraint)", async () => {
    const { actor, managerActor, manager } = h.staff;
    // Session A on Table 1: 00:00 - 01:00, paid so the table is free again.
    const a = await awaitingPayment(h, "Table 1", 60);
    await markPaid(actor, a, "cash", { cardConfirmed: false }, at(61));
    // Session B on Table 1: 02:00 - 03:00.
    const b = await startSession(actor, h.tableId("Table 1"), at(120));
    await stopSession(actor, b.sessionId, at(180));
    const [ivB] = await getIntervals(h, b.sessionId);

    // Pull B's start back to 00:30, inside A's hour.
    const err = await editTimes(managerActor, manager, b.sessionId, "Customer says they arrived earlier", [
      { id: ivB.id, startedAt: at(30), endedAt: at(180) },
    ], at(240)).then(
      () => null,
      (e: unknown) => e as { code?: string; constraint_name?: string },
    );
    expect(err, "overlapping edit must be rejected").not.toBeNull();
    expect(err?.code).toBe("23P01");
    expect(err?.constraint_name).toBe("session_intervals_no_table_overlap");

    // rolled back
    const [after] = await getIntervals(h, b.sessionId);
    expect(after.started_at).toEqual(at(120));
    expect((await getSession(h, b.sessionId)).total_cents).toBe(2500);

    // A non-overlapping edit on the same table is fine.
    await expect(
      editTimes(managerActor, manager, b.sessionId, "Fix start", [{ id: ivB.id, startedAt: at(90), endedAt: at(180) }], at(240)),
    ).resolves.toMatchObject({ totalCents: 3750 });
  });

  it("editing a running session doesn't re-price or bump the attempt", async () => {
    const { actor, managerActor, manager } = h.staff;
    const { sessionId } = await startSession(actor, h.tableId("Table 1"), at(10));
    const [iv] = await getIntervals(h, sessionId);
    const r = await editTimes(managerActor, manager, sessionId, "Started earlier", [{ id: iv.id, startedAt: at(0), endedAt: null }], at(20));
    expect(r.totalCents).toBeNull();
    const s = await getSession(h, sessionId);
    expect(s.opened_at).toEqual(at(0));
    expect(s.checkout_attempt).toBe(0);
  });
});
