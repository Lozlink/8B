import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { chargeCard } from "@/lib/server/sessions";
import { audits, awaitingPayment, getCheckouts, getSession } from "./helpers/util";

let h: Harness;
let POST: (req: Request) => Promise<Response>;

beforeAll(async () => {
  h = await bootHarness(); // sets the dummy server env before anything reads it
  ({ POST } = await import("@/app/api/square/webhook/route"));
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const key = () => process.env.SQUARE_WEBHOOK_SIGNATURE_KEY as string;
const url = () => process.env.SQUARE_WEBHOOK_URL as string;
const sign = (body: string, k = key(), u = url()) => createHmac("sha256", k).update(u + body).digest("base64");

function deliver(payload: unknown, opts: { signature?: string | null; rawBody?: string } = {}): Promise<Response> {
  const body = opts.rawBody ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = opts.signature === undefined ? sign(body) : opts.signature;
  if (sig !== null) headers["x-square-hmacsha256-signature"] = sig;
  return POST(new Request(url(), { method: "POST", headers, body }));
}

const checkoutEvent = (eventId: string, id: string, status: string, ref: string | null, cancelReason: string | null = null) => ({
  event_id: eventId,
  type: "terminal.checkout.updated",
  data: { object: { checkout: { id, status, reference_id: ref, cancel_reason: cancelReason } } },
});

const events = () => h.sql<{ event_id: string; type: string }[]>`select event_id, type from public.webhook_events order by received_at, event_id`;

async function charged(): Promise<string> {
  const id = await awaitingPayment(h);
  await chargeCard(h.staff.actor, id);
  return id;
}

describe("signature", () => {
  it("missing, wrong-key, wrong-url and tampered signatures are 401 and store nothing", async () => {
    const id = await charged();
    const p = checkoutEvent("evt_a", "chk_1", "COMPLETED", id);
    const body = JSON.stringify(p);
    expect((await deliver(p, { signature: null })).status).toBe(401);
    expect((await deliver(p, { signature: "garbage" })).status).toBe(401);
    expect((await deliver(p, { signature: "" })).status).toBe(401);
    expect((await deliver(p, { signature: sign(body, "other-key") })).status).toBe(401);
    expect((await deliver(p, { signature: sign(body, key(), "https://evil.test/hook") })).status).toBe(401);
    expect((await deliver(p, { signature: sign(body + " ") })).status).toBe(401);
    expect(await events()).toHaveLength(0);
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
  });

  it("a valid signature on a non-JSON or wrong-shape body is 400 and stores nothing", async () => {
    expect((await deliver(null, { rawBody: "not json" })).status).toBe(400);
    expect((await deliver({ hello: "world" })).status).toBe(400);
    expect(await events()).toHaveLength(0);
  });
});

describe("terminal.checkout.updated", () => {
  it("COMPLETED pays the session via square_webhook and records the event", async () => {
    const id = await charged();
    const res = await deliver(checkoutEvent("evt_1", "chk_1", "COMPLETED", id));
    expect(res.status).toBe(200);
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "card", settled_via: "square_webhook" });
    expect((await getCheckouts(h, id))[0].status).toBe("COMPLETED");
    expect(await events()).toEqual([{ event_id: "evt_1", type: "terminal.checkout.updated" }]);
  });

  it("the same event_id twice: 200 both times and exactly one session.paid", async () => {
    const id = await charged();
    const p = checkoutEvent("evt_dup", "chk_1", "COMPLETED", id);
    expect((await deliver(p)).status).toBe(200);
    expect((await deliver(p)).status).toBe(200);
    expect(await audits(h, id, "session.paid")).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("IN_PROGRESS then CANCELED via webhook keep the bill awaiting; stale IN_PROGRESS after COMPLETED is harmless", async () => {
    const id = await charged();
    expect((await deliver(checkoutEvent("e1", "chk_1", "IN_PROGRESS", id))).status).toBe(200);
    expect((await getCheckouts(h, id))[0].status).toBe("IN_PROGRESS");
    expect((await deliver(checkoutEvent("e2", "chk_1", "CANCELED", id, "BUYER_CANCELED"))).status).toBe(200);
    expect((await getCheckouts(h, id))[0]).toMatchObject({ status: "CANCELED", cancel_reason: "BUYER_CANCELED" });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    // Square: a timed-out checkout can still complete
    expect((await deliver(checkoutEvent("e3", "chk_1", "COMPLETED", id))).status).toBe(200);
    expect((await getSession(h, id)).status).toBe("paid");
    expect((await deliver(checkoutEvent("e4", "chk_1", "IN_PROGRESS", id))).status).toBe(200);
    expect((await getCheckouts(h, id))[0].status).toBe("COMPLETED");
  });

  it("an orphan itemised checkout is adopted with its order id and amount read from the payload", async () => {
    const id = await awaitingPayment(h);
    const res = await deliver({
      event_id: "evt_orphan",
      type: "terminal.checkout.updated",
      data: {
        object: {
          checkout: { id: "chk_orphan", status: "PENDING", reference_id: id, order_id: "ord_sq", amount_money: { amount: 2500, currency: "AUD" } },
        },
      },
    });
    expect(res.status).toBe(200);
    const rows = await h.sql<{ id: string; amount_cents: number; square_order_id: string | null }[]>`
      select id, amount_cents, square_order_id from public.terminal_checkouts where session_id = ${id}`;
    expect(rows).toEqual([{ id: "chk_orphan", amount_cents: 2500, square_order_id: "ord_sq" }]);
  });

  it("an unknown checkout is 200 (no retry storm), recorded, and audited", async () => {
    expect((await deliver(checkoutEvent("evt_u", "chk_ghost", "COMPLETED", null))).status).toBe(200);
    expect(await events()).toHaveLength(1);
    expect(await h.sql`select 1 from public.audit_log where action = 'webhook.unknown_checkout' and entity_id = 'chk_ghost'`).toHaveLength(1);
  });

  it("a payload with the wrong shape is recorded and ignored", async () => {
    const id = await charged();
    const res = await deliver({ event_id: "evt_bad", type: "terminal.checkout.updated", data: { object: { nope: {} } } });
    expect(res.status).toBe(200);
    expect(await events()).toHaveLength(1);
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
  });
});

describe("processing failure", () => {
  it("returns 500, keeps no event row, and a retry succeeds", async () => {
    const id = await charged();
    const p = checkoutEvent("evt_retry", "chk_1", "COMPLETED", id);

    await h.pg.exec("reset role");
    await h.pg.exec("revoke insert on public.audit_log from timer_app");
    await h.pg.exec("set role timer_app");
    let failed: Response;
    try {
      failed = await deliver(p);
    } finally {
      await h.pg.exec("reset role");
      await h.pg.exec("grant select, insert on public.audit_log to timer_app");
      await h.pg.exec("set role timer_app");
    }
    expect(failed.status).toBe(500);
    expect(await events()).toHaveLength(0);
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    expect((await getCheckouts(h, id))[0].status).toBe("PENDING");

    const retry = await deliver(p);
    expect(retry.status).toBe(200);
    expect((await getSession(h, id)).status).toBe("paid");
    expect(await events()).toHaveLength(1);
    expect(await audits(h, id, "session.paid")).toHaveLength(1);
  });
});

describe("device.code.paired", () => {
  const paired = (eventId: string, over: Record<string, unknown> = {}, topLocation?: string) => ({
    event_id: eventId,
    type: "device.code.paired",
    ...(topLocation ? { location_id: topLocation } : {}),
    data: {
      object: {
        device_code: { id: "dc_1", status: "PAIRED", device_id: "DEV_NEW", location_id: "LOC_TEST", product_type: "TERMINAL_API", ...over },
      },
    },
  });
  const terminal = async () => (await h.sql<{ t: string | null }[]>`select terminal_device_id as t from public.settings`)[0].t;

  it("matching location saves the Terminal device id", async () => {
    expect((await deliver(paired("evt_p1"))).status).toBe(200);
    expect(await terminal()).toBe("DEV_NEW");
    expect(await h.sql`select 1 from public.audit_log where action = 'terminal.paired'`).toHaveLength(1);
  });

  it("falls back to the envelope location_id when the device code has none", async () => {
    expect((await deliver(paired("evt_p2", { location_id: null }, "LOC_TEST"))).status).toBe(200);
    expect(await terminal()).toBe("DEV_NEW");
  });

  it("a different location is ignored but the event is recorded", async () => {
    expect((await deliver(paired("evt_p3", { location_id: "SOMEONE_ELSE" }))).status).toBe(200);
    expect(await terminal()).toBe("DEVICE_TEST");
    expect(await events()).toEqual([{ event_id: "evt_p3", type: "device.code.paired" }]);
  });

  it("a code that is not PAIRED is ignored", async () => {
    expect((await deliver(paired("evt_p4", { status: "UNPAIRED" }))).status).toBe(200);
    expect(await terminal()).toBe("DEVICE_TEST");
  });
});

describe("other events", () => {
  it("unknown types are recorded, return 200 and change nothing", async () => {
    const id = await charged();
    const before = await h.sql`select count(*)::int as n from public.audit_log`;
    const res = await deliver({ event_id: "evt_x", type: "payment.updated", data: { object: { payment: { id: "p1" } } } });
    expect(res.status).toBe(200);
    expect(await events()).toEqual([{ event_id: "evt_x", type: "payment.updated" }]);
    expect(await h.sql`select count(*)::int as n from public.audit_log`).toEqual(before);
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    // and a replay is still a clean 200
    expect((await deliver({ event_id: "evt_x", type: "payment.updated" })).status).toBe(200);
  });
});
