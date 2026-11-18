import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, MANAGER_PIN, STAFF_PIN, type Harness } from "./helpers/harness";

// The routes read the device and staff cookies; give them a jar to read.
const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  const hdrs = new Map<string, string>();
  return {
    store,
    hdrs,
    jar: {
      get: (name: string) => (store.has(name) ? { name, value: store.get(name) as string } : undefined),
      has: (name: string) => store.has(name),
      set: (name: string, value: string) => void store.set(name, value),
      delete: (name: string) => void store.delete(name),
    },
    headerBag: { get: (name: string) => hdrs.get(name.toLowerCase()) ?? null },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => mocks.jar,
  headers: async () => mocks.headerBag,
}));
// `handler` waits on Next's connection(), and some routes schedule work with after(): neither
// exists outside a real request.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => undefined,
  after: () => undefined,
}));

import { hashPin, login, setDeviceCookie } from "@/lib/server/auth";
import { addItem } from "@/lib/server/sessions";
import { audits, awaitingPayment, expectBillAddsUp, expectFamilyAddsUp, getItems, getSession, seedDiscount, seedProduct } from "./helpers/util";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  mocks.store.clear();
  mocks.hdrs.clear();
  await h.sql`update public.staff set pin_hash = ${await hashPin(STAFF_PIN)} where id = ${h.staff.actor.staffId}`;
  await h.sql`update public.staff set pin_hash = ${await hashPin(MANAGER_PIN)} where id = ${h.staff.manager.id}`;
  await seedProduct(h, { id: "VAR_COKE", name: "Coke", priceCents: 450 });
  await seedDiscount(h, { id: "D_10", name: "Members 10%", kind: "percent", value: 1000 });
  await seedDiscount(h, { id: "D_VAMT", name: "Manager $", kind: "variable_amount" });
});

/** Enrols this "iPad" and logs the plain staff member in on it. */
async function signIn(): Promise<void> {
  const [d] = await h.sql<{ id: string; label: string }[]>`insert into public.devices (label) values ('Counter') returning id, label`;
  await setDeviceCookie(d.id, d.label);
  await login(h.staff.actor.staffId, STAFF_PIN);
}

interface Answer {
  status: number;
  body: Record<string, unknown> & { error?: { code: string; message: string } };
}

async function act(id: string, action: string, body?: unknown): Promise<Answer> {
  const { POST } = await import("@/app/api/sessions/[id]/[action]/route");
  const res = await POST(
    new Request(`https://example.test/api/sessions/${id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, action }) },
  );
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}

async function counter(): Promise<Answer> {
  const { POST } = await import("@/app/api/sessions/counter/route");
  const res = await POST();
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}

describe("routes for custom charges, counter sales, discounts and split bills", () => {
  it("nothing works without a logged-in staff member", async () => {
    const id = await awaitingPayment(h, "Table 1", 60);
    expect((await counter()).status).toBe(401);
    for (const action of ["add-custom-item", "discard", "set-discount", "remove-discount", "split", "merge-back"]) {
      expect((await act(id, action, {})).status, action).toBe(401);
    }
    expect(await getSession(h, id)).toMatchObject({ total_cents: 2500, checkout_attempt: 0 });
  });

  it("POST /api/sessions/counter opens a counter sale, attributed to whoever is logged in; discard throws it away", async () => {
    await signIn();
    const out = await counter();
    expect(out.status).toBe(200);
    const id = out.body.sessionId as string;
    expect(await getSession(h, id)).toMatchObject({ kind: "counter", status: "awaiting_payment", total_cents: 0, opened_by: h.staff.actor.staffId });
    const [row] = await audits(h, id, "session.counter_sale");
    expect(row).toMatchObject({ actor_staff_id: h.staff.actor.staffId, device_label: "Counter" });

    expect(await act(id, "discard")).toEqual({ status: 200, body: { ok: true } });
    expect(await getSession(h, id)).toMatchObject({ status: "void", voided_by: h.staff.actor.staffId });
    const again = await act(id, "discard");
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("invalid_transition");
  });

  it("add-custom-item: { name, amountCents }; a bad one is a 400 staff can read", async () => {
    await signIn();
    const id = await awaitingPayment(h, "Table 1", 60);
    expect(await act(id, "add-custom-item", { name: "Cue repair", amountCents: 1500 })).toEqual({ status: 200, body: { ok: true } });
    expect((await getItems(h, id))[0]).toMatchObject({ kind: "custom", name: "Cue repair", unit_cents: 1500 });
    await expectBillAddsUp(h, id);

    for (const body of [{}, { name: "Chalk" }, { amountCents: 250 }, { name: 5, amountCents: 250 }, { name: "Chalk", amountCents: "250" }]) {
      expect((await act(id, "add-custom-item", body)).status, JSON.stringify(body)).toBe(400);
    }
    const tooMuch = await act(id, "add-custom-item", { name: "Chalk", amountCents: 200_001 });
    expect(tooMuch).toMatchObject({ status: 400, body: { error: { code: "bad_request", message: "A custom charge must be between 1c and $2,000." } } });
    const noName = await act(id, "add-custom-item", { name: "  ", amountCents: 100 });
    expect(noName.body.error?.message).toBe("Give the charge a name, up to 60 characters.");
    expect(await getItems(h, id)).toHaveLength(1);
  });

  it("set-discount: a fixed discount needs no PIN", async () => {
    await signIn();
    const id = await awaitingPayment(h, "Table 1", 60);
    expect(await act(id, "set-discount", { discountId: "D_10" })).toEqual({ status: 200, body: { ok: true } });
    expect(await getSession(h, id)).toMatchObject({ discount_id: "D_10", discount_cents: 250, total_cents: 2250, discount_approved_by: null });
    expect(await act(id, "remove-discount")).toEqual({ status: 200, body: { ok: true } });
    expect(await getSession(h, id)).toMatchObject({ discount_kind: null, total_cents: 2500 });
    const none = await act(id, "remove-discount");
    expect(none).toMatchObject({ status: 409, body: { error: { code: "conflict", message: "There's no discount on this bill." } } });
  });

  it("set-discount: a variable or typed-in discount needs a manager's PIN, checked like void's", async () => {
    await signIn();
    const id = await awaitingPayment(h, "Table 1", 60);

    // no PIN
    const noPin = await act(id, "set-discount", { discountId: "D_VAMT", value: 500 });
    expect(noPin).toMatchObject({ status: 403, body: { error: { code: "forbidden", message: "A manager PIN is needed for this discount." } } });
    const noPinCustom = await act(id, "set-discount", { custom: { name: "Mates", kind: "percent", value: 1500 } });
    expect(noPinCustom.status).toBe(403);
    // a staff PIN is not a manager PIN
    const staffPin = await act(id, "set-discount", { discountId: "D_VAMT", value: 500, managerPin: STAFF_PIN });
    expect(staffPin).toMatchObject({ status: 403, body: { error: { message: "That isn't a manager PIN." } } });
    // not a PIN at all
    expect((await act(id, "set-discount", { discountId: "D_VAMT", value: 500, managerPin: "12" })).status).toBe(400);
    expect(await getSession(h, id)).toMatchObject({ discount_kind: null, total_cents: 2500 });

    expect(await act(id, "set-discount", { discountId: "D_VAMT", value: 500, managerPin: MANAGER_PIN })).toEqual({ status: 200, body: { ok: true } });
    expect(await getSession(h, id)).toMatchObject({ discount_id: "D_VAMT", discount_kind: "amount", discount_value: 500, total_cents: 2000, discount_approved_by: h.staff.manager.id, discount_by: h.staff.actor.staffId });

    expect(await act(id, "set-discount", { custom: { name: "Mates", kind: "percent", value: 1500 }, managerPin: MANAGER_PIN })).toEqual({ status: 200, body: { ok: true } });
    expect(await getSession(h, id)).toMatchObject({ discount_id: null, discount_name: "Mates", discount_kind: "percent", discount_cents: 375, total_cents: 2125 });
    const rows = await audits(h, id, "session.set_discount");
    expect(rows.map((r) => r.approved_by_staff_id)).toEqual([h.staff.manager.id, h.staff.manager.id]);
    // each wrong PIN was counted against this iPad, as void's are
    const [tries] = await h.sql<{ n: number }[]>`select count(*)::int as n from public.login_attempts where kind = 'manager' and not success`;
    expect(tries.n).toBe(1);
    await expectBillAddsUp(h, id);
  });

  it("set-discount: the body must name exactly one discount", async () => {
    await signIn();
    const id = await awaitingPayment(h, "Table 1", 60);
    const neither = await act(id, "set-discount", {});
    expect(neither).toMatchObject({ status: 400, body: { error: { message: "Pick a discount from the list, or type one in." } } });
    const both = await act(id, "set-discount", { discountId: "D_10", custom: { name: "Mates", kind: "percent", value: 1500 }, managerPin: MANAGER_PIN });
    expect(both.status).toBe(400);
    expect((await act(id, "set-discount", { custom: { name: "Mates", kind: "half", value: 1 }, managerPin: MANAGER_PIN })).status).toBe(400);
    expect((await act(id, "set-discount", { discountId: "D_NOPE" })).status).toBe(404);
    expect(await getSession(h, id)).toMatchObject({ discount_kind: null, total_cents: 2500, checkout_attempt: 0 });
  });

  it("split answers with the part ids; merge-back takes a part's id", async () => {
    await signIn();
    const id = await awaitingPayment(h, "Table 1", 60);
    await addItem(h.staff.actor, id, "VAR_COKE", 2); // 3400

    const three = await act(id, "split", { ways: 3 });
    expect(three.status).toBe(200);
    const partIds = three.body.partIds as string[];
    expect(partIds).toHaveLength(2);
    expect(await getSession(h, partIds[0])).toMatchObject({ kind: "part", split_of: id, total_cents: 1133, opened_by: h.staff.actor.staffId });
    await expectFamilyAddsUp(h, id);

    const one = await act(id, "split", { amountCents: 400 });
    expect((one.body.partIds as string[]).length).toBe(1);
    expect(await getSession(h, id)).toMatchObject({ total_cents: 3400 - 2 * 1133 - 400, split_off_cents: 2 * 1133 + 400 });

    for (const body of [{}, { ways: 2, amountCents: 100 }, { ways: "2" }, { ways: 11 }, { ways: 1 }, { amountCents: 0 }]) {
      expect((await act(id, "split", body)).status, JSON.stringify(body)).toBe(400);
    }

    expect(await act(partIds[0], "merge-back")).toEqual({ status: 200, body: { ok: true } });
    expect(await getSession(h, partIds[0])).toMatchObject({ status: "void", merged: true, voided_by: h.staff.actor.staffId });
    const notAPart = await act(id, "merge-back");
    expect(notAPart).toMatchObject({ status: 409, body: { error: { message: "Only a share of a split bill can be merged back." } } });
    await expectFamilyAddsUp(h, id);
    expect((await act(id, "no-such-action")).status).toBe(404);
  });

  it("expectedTotalCents travels in the body of charge, resend, cash-handoff, mark-paid and split; a stale one is 409 bill_changed", async () => {
    await signIn();
    const CHANGED = { status: 409, body: { error: { code: "bill_changed", message: "This bill has changed. Check the amount and try again." } } };
    const id = await awaitingPayment(h, "Table 1", 60); // 2500

    // stale: nothing happens
    for (const [action, body] of [
      ["charge", { expectedTotalCents: 2000 }],
      ["cash-handoff", { expectedTotalCents: 2000 }],
      ["mark-paid", { method: "cash", expectedTotalCents: 2000 }],
      ["split", { ways: 2, expectedTotalCents: 2000 }],
    ] as const) {
      expect(await act(id, action, body), action).toMatchObject(CHANGED);
    }
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", total_cents: 2500, split_off_cents: 0, checkout_attempt: 0 });
    expect(h.gateway.creates).toHaveLength(0);
    expect(await audits(h, id, "cash.handoff_started")).toHaveLength(0);

    // not whole cents, or negative: a bad request, not a stale one
    for (const bad of [12.5, -1, "2500"]) {
      expect((await act(id, "charge", { expectedTotalCents: bad })).status, String(bad)).toBe(400);
    }

    // right amount: each goes ahead
    const sent = await act(id, "charge", { expectedTotalCents: 2500 });
    expect(sent).toMatchObject({ status: 200, body: { kind: "sent", amountCents: 2500 } });
    expect(await act(id, "resend", { expectedTotalCents: 2000 })).toMatchObject(CHANGED);
    expect(h.gateway.cancels).toEqual([]);
    expect(await act(id, "resend", { expectedTotalCents: 2500 })).toMatchObject({ status: 200, body: { kind: "sent" } });
    expect((await act(id, "cancel-checkout")).status).toBe(200);
    const split = await act(id, "split", { amountCents: 500, expectedTotalCents: 2500 });
    expect(split.status).toBe(200);
    expect((await act(id, "cash-handoff", { expectedTotalCents: 2000 })).status).toBe(200);
    // a part, by its own total
    const [part] = split.body.partIds as string[];
    expect(await act(part, "mark-paid", { method: "cash", expectedTotalCents: 2000 })).toMatchObject(CHANGED);
    expect(await act(part, "mark-paid", { method: "cash", expectedTotalCents: 500 })).toMatchObject({ status: 200, body: { kind: "paid", amountCents: 500 } });
  });

  it("with no body at all, charge, resend and cash-handoff still work (what the previous release's screens send)", async () => {
    await signIn();
    const id = await awaitingPayment(h, "Table 1", 60);
    expect(await act(id, "charge")).toMatchObject({ status: 200, body: { kind: "sent", amountCents: 2500 } });
    expect(await act(id, "resend", {})).toMatchObject({ status: 200, body: { kind: "sent" } });
    expect((await act(id, "cancel-checkout")).status).toBe(200);
    expect(await act(id, "cash-handoff")).toMatchObject({ status: 200, body: { amountCents: 2500 } });
    expect(await act(id, "mark-paid", { method: "cash" })).toMatchObject({ status: 200, body: { kind: "paid", amountCents: 2500 } });
  });

  it("the times given are the server's own: a part is opened and closed when it is split off", async () => {
    await signIn();
    const id = await awaitingPayment(h, "Table 1", 60);
    const before = Date.now();
    const out = await act(id, "split", { ways: 2 });
    const part = await getSession(h, (out.body.partIds as string[])[0]);
    expect(part.opened_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(part.opened_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(part.closed_at).toEqual(part.opened_at);
  });
});
