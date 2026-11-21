import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import {
  addCustomItem,
  chargeCard,
  continueSession,
  markPaid,
  pauseSession,
  releaseTable,
  resumeSession,
  splitBill,
  startSession,
  stopSession,
} from "@/lib/server/sessions";
import { T0, at, audits, awaitingPayment, getIntervals, getSession, occupiedTables } from "./helpers/util";

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

describe("keep playing: a stopped table goes back to running", () => {
  it("stopped by mistake: bills exactly as if it had never been stopped", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await continueSession(actor, id, { countGap: true }, at(75));

    const running = await getSession(h, id);
    expect(running).toMatchObject({ status: "running", closed_at: null, billed_minutes: null, total_cents: null, discount_cents: 0 });
    expect(await occupiedTables(h)).toEqual(["Table 1"]);
    const intervals = await getIntervals(h, id);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ started_at: T0, ended_at: null });

    const again = await stopSession(actor, id, at(120));
    const { sessionId: plain } = await startSession(actor, h.tableId("Table 2"), T0);
    expect(again).toEqual(await stopSession(actor, plain, at(120)));

    const [entry] = await audits(h, id, "session.continue");
    expect(entry.after).toMatchObject({ status: "running", count_gap: true });
  });

  it("start the clock from now: the time in between is not charged, like a pause", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await continueSession(actor, id, { countGap: false }, at(90));
    const intervals = await getIntervals(h, id);
    expect(intervals.map((i) => [i.started_at, i.ended_at])).toEqual([
      [T0, at(60)],
      [at(90), null],
    ]);

    const { sessionId: paused } = await startSession(actor, h.tableId("Table 2"), T0);
    await pauseSession(actor, paused, at(60));
    await resumeSession(actor, paused, at(90));
    expect(await stopSession(actor, id, at(120))).toEqual(await stopSession(actor, paused, at(120)));
  });

  it("paused when it was stopped: counting the gap starts the clock at the stop", async () => {
    const { actor } = h.staff;
    const { sessionId: id } = await startSession(actor, h.tableId("Table 1"), T0);
    await pauseSession(actor, id, at(30));
    await stopSession(actor, id, at(60));
    await continueSession(actor, id, { countGap: true }, at(80));
    expect((await getIntervals(h, id)).map((i) => [i.started_at, i.ended_at])).toEqual([
      [T0, at(30)],
      [at(60), null],
    ]);
  });

  it("items stay on the bill and are in the next total", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    const before = (await getSession(h, id)).total_cents ?? 0;
    await addCustomItem(actor, id, "Chalk", 500);
    await continueSession(actor, id, { countGap: true }, at(61));
    expect((await getSession(h, id)).items_cents).toBe(500);
    const again = await stopSession(actor, id, at(60));
    expect(again.totalCents).toBe(before + 500);
  });

  it("can be paid as usual afterwards", async () => {
    const { actor } = h.staff;
    const id = await awaitingPayment(h, "Table 1", 60);
    await continueSession(actor, id, { countGap: false }, at(70));
    await stopSession(actor, id, at(130));
    await markPaid(actor, id, "cash", { cardConfirmed: false }, at(131));
    expect((await getSession(h, id)).status).toBe("paid");
  });

  it("is refused once the bill has left its table, been split, is on the Terminal, or is paid", async () => {
    const { actor } = h.staff;
    const unchanged = async (id: string) => expect((await getSession(h, id)).status).not.toBe("running");

    const left = await awaitingPayment(h, "Table 1", 60);
    await releaseTable(actor, left);
    await expect(continueSession(actor, left, { countGap: true }, at(70))).rejects.toMatchObject({ status: 409 });
    await unchanged(left);

    const split = await awaitingPayment(h, "Table 2", 60);
    await splitBill(actor, split, { ways: 2 });
    await expect(continueSession(actor, split, { countGap: true }, at(70))).rejects.toMatchObject({ status: 409 });
    await unchanged(split);

    const onTerminal = await awaitingPayment(h, "Table 3", 60);
    await chargeCard(actor, onTerminal);
    await expect(continueSession(actor, onTerminal, { countGap: true }, at(70))).rejects.toMatchObject({ status: 409 });
    await unchanged(onTerminal);

    const paid = await awaitingPayment(h, "Table 4", 60);
    await markPaid(actor, paid, "cash", { cardConfirmed: false }, at(61));
    await expect(continueSession(actor, paid, { countGap: true }, at(70))).rejects.toBeTruthy();
    expect((await getSession(h, paid)).status).toBe("paid");

    const { sessionId: running } = await startSession(actor, h.tableId("Table 5"), T0);
    await expect(continueSession(actor, running, { countGap: true }, at(70))).rejects.toBeTruthy();
  });
});
