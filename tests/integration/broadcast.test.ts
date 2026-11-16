import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { chargeCard, syncStaleCheckouts } from "@/lib/server/sessions";
import { db, setDbForTests } from "@/lib/server/db";
import { awaitingPayment } from "./helpers/util";

let h: Harness;

beforeAll(async () => {
  h = await bootHarness();
  // Stand-in for Supabase's realtime.send: records each broadcast so the test can count them.
  await h.raw(null, `create schema realtime`);
  await h.raw(null, `create table realtime.sent (id serial primary key, topic text not null, event text not null)`);
  await h.raw(
    null,
    `create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void
     language sql as $$ insert into realtime.sent (topic, event) values (topic, event) $$`,
  );
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const broadcasts = async () => (await h.raw<{ n: number }>(null, `select count(*)::int as n from realtime.sent`))[0]?.n ?? 0;

describe("R7: the background checkout sync can't start a refetch loop", () => {
  it("doesn't broadcast when nothing is due (it runs after every floor fetch)", async () => {
    const before = await broadcasts();
    await syncStaleCheckouts();
    await syncStaleCheckouts();
    expect(await broadcasts()).toBe(before);
  });

  it("doesn't broadcast for a live checkout that was synced recently", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id); // created just now: not due for 8 s
    const before = await broadcasts();
    await syncStaleCheckouts();
    expect(await broadcasts()).toBe(before);
    expect(h.gateway.gets).toEqual([]);
  });

  it("still claims and checks a stale checkout, then stays quiet until it's due again", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await h.raw(null, `update public.terminal_checkouts set created_at = now() - interval '1 minute', last_synced_at = null`);
    h.gateway.getFor.set("chk_1", "IN_PROGRESS");

    await syncStaleCheckouts();
    expect(h.gateway.gets).toEqual(["chk_1"]);

    const afterClaim = await broadcasts();
    await syncStaleCheckouts(); // within the 15 s throttle
    expect(await broadcasts()).toBe(afterClaim);
    expect(h.gateway.gets).toEqual(["chk_1"]);
  });
});

describe("R8: pool settings for Supabase's transaction pooler", () => {
  it("never pipelines queries and bounds how long a query can wait", async () => {
    setDbForTests(undefined); // build the production pool (lazy: nothing connects)
    const sql = db();
    try {
      expect(sql.options.prepare).toBe(false);
      expect(sql.options.max_pipeline).toBe(1);
      expect(sql.options.query_timeout).toBeGreaterThan(0);
      expect(sql.options.query_timeout).toBeLessThan(30); // under the client's 35 s POST timeout
    } finally {
      await sql.end({ timeout: 0 });
      setDbForTests(h.sql);
    }
  });
});
