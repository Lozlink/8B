import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, MANAGER_PIN, type Harness } from "./helpers/harness";

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

import {
  applyWebhookCheckout,
  cancelCheckout,
  chargeCard,
  markPaid,
  releaseTable,
  resendCheckout,
  syncStaleCheckouts,
  voidSession,
} from "@/lib/server/sessions";
import { checkEnrolCode, login, setDeviceCookie, verifyManagerPin } from "@/lib/server/auth";
import { withTx } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { getSummary } from "@/lib/server/queries";
import { currentBusinessDate, formatYMD } from "@/lib/domain/business-day";
import { at, audits, auditActions, awaitingPayment, getCheckouts, getSession } from "./helpers/util";

let h: Harness;
let POST: (req: Request) => Promise<Response>;

beforeAll(async () => {
  h = await bootHarness();
  ({ POST } = await import("@/app/api/square/webhook/route"));
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  mocks.store.clear();
  mocks.hdrs.clear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const webhook = (id: string, status: string, referenceId: string | null, amountCents: number | null = null) =>
  withTx((tx) => applyWebhookCheckout(tx, { id, status, referenceId, cancelReason: null, amountCents }));

/** Makes every live checkout look old enough for the background reconciler. */
const backdate = () =>
  h.raw(null, `update public.terminal_checkouts set created_at = now() - interval '1 minute', last_synced_at = null`);

/** audit_log.at is the DB clock, so the summary has to be read for the real current business date. */
async function liveSummary() {
  const [s] = await h.sql<{ m: string }[]>`select business_day_start::text as m from public.settings`;
  const [hh, mm] = s.m.split(":").map(Number);
  return getSummary(formatYMD(currentBusinessDate(new Date(), hh * 60 + mm, "Australia/Sydney")));
}

const apiError = () => new AppError(502, "square_error", "Square is down");

describe("R1: the lost-webhook safety net covers bills that are off the table", () => {
  it("reconciles a charged bill that was moved to Unpaid first", async () => {
    const id = await awaitingPayment(h);
    await releaseTable(h.staff.actor, id);
    expect((await getSession(h, id)).current_table_id).toBeNull();
    await chargeCard(h.staff.actor, id);
    await backdate();
    h.gateway.getFor.set("chk_1", "COMPLETED");

    await syncStaleCheckouts();
    expect(h.gateway.gets).toEqual(["chk_1"]);
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "card", settled_via: "square_api" });
    expect((await getCheckouts(h, id))[0].status).toBe("COMPLETED");
  });

  it("flags a card payment that completes after cash was taken during CANCEL_REQUESTED", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelFor.set("chk_1", "CANCEL_REQUESTED");
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(70));
    expect((await getSession(h, id)).current_table_id).toBeNull();
    expect((await getCheckouts(h, id))[0].status).toBe("CANCEL_REQUESTED");

    await backdate();
    h.gateway.getFor.set("chk_1", "COMPLETED");
    await syncStaleCheckouts();

    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "cash", settled_via: "staff" });
    const conflicts = await audits(h, id, "payment.conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].entity).toBe("session");
    const sum = await liveSummary();
    expect(sum.attention.some((a) => a.action === "payment.conflict" && a.entityId === id)).toBe(true);
  });
});

describe("R2: card marked paid by staff while the Terminal might still take the card", () => {
  for (const state of ["CANCEL_REQUESTED", "CANCELED"] as const) {
    it(`webhook COMPLETED after staff card mark-paid with cancel=${state} is a payment.conflict`, async () => {
      const id = await awaitingPayment(h);
      await chargeCard(h.staff.actor, id);
      h.gateway.cancelFor.set("chk_1", state);
      await markPaid(h.staff.actor, id, "card", { cardConfirmed: true }, at(70));
      await webhook("chk_1", "COMPLETED", id);

      expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "card", settled_via: "staff" });
      expect(await audits(h, id, "payment.conflict")).toHaveLength(1);
      expect(await audits(h, id, "payment.confirmed_by_square")).toHaveLength(0);
      const sum = await liveSummary();
      expect(sum.attention.some((a) => a.action === "payment.conflict" && a.entityId === id)).toBe(true);
    });
  }
});

describe("R3: orphan checkouts (Square created it, our transaction rolled back)", () => {
  it("COMPLETED for an unknown checkout on an awaiting session is adopted and pays the bill", async () => {
    const id = await awaitingPayment(h);
    expect(await webhook("chk_orphan", "COMPLETED", id, 2500)).toBe("applied");
    const [co] = await getCheckouts(h, id);
    expect(co).toMatchObject({ id: "chk_orphan", attempt: 1, amount_cents: 2500, status: "COMPLETED" });
    expect(await getSession(h, id)).toMatchObject({
      status: "paid",
      settled_method: "card",
      settled_via: "square_webhook",
      checkout_attempt: 1,
      square_checkout_id: "chk_orphan",
    });
    expect(await audits(h, id, "session.paid")).toHaveLength(1);
    expect(await audits(h, "chk_orphan", "webhook.unknown_checkout")).toHaveLength(0);
  });

  it("the adopted attempt number continues after earlier attempts", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await cancelCheckout(h.staff.actor, id);
    expect(await webhook("chk_orphan", "COMPLETED", id, 2500)).toBe("applied");
    const cos = await getCheckouts(h, id);
    expect(cos.map((c) => [c.id, c.attempt])).toEqual([["chk_1", 1], ["chk_orphan", 2]]);
    const s = await getSession(h, id);
    expect(s.checkout_attempt).toBe(2);
    expect(s.square_checkout_id).toBe("chk_orphan");
    expect(s.status).toBe("paid");
  });

  it("a session already paid in cash gets the orphan adopted plus a payment.conflict", async () => {
    const id = await awaitingPayment(h);
    await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false }, at(70));
    expect(await webhook("chk_orphan", "COMPLETED", id, 2500)).toBe("applied");
    expect((await getCheckouts(h, id)).map((c) => c.id)).toEqual(["chk_orphan"]);
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "cash", settled_via: "staff" });
    const [c] = await audits(h, id, "payment.conflict");
    expect(c).toBeDefined();
    expect(c.entity).toBe("session");
  });

  it("a PENDING orphan is adopted as live: the bill stays awaiting and a new charge is refused", async () => {
    const id = await awaitingPayment(h);
    expect(await webhook("chk_orphan", "PENDING", id, 2500)).toBe("applied");
    const [co] = await getCheckouts(h, id);
    expect(co).toMatchObject({ id: "chk_orphan", attempt: 1, status: "PENDING" });
    expect(await getSession(h, id)).toMatchObject({ status: "awaiting_payment", checkout_attempt: 1, square_checkout_id: "chk_orphan" });
    await expect(chargeCard(h.staff.actor, id)).rejects.toMatchObject({ status: 409 });
    expect(h.gateway.creates).toHaveLength(0);
  });

  it("an unknown session is still unknown and audited", async () => {
    expect(await webhook("chk_orphan", "COMPLETED", "00000000-0000-4000-8000-0000000000ff", 2500)).toBe("unknown");
    expect(await audits(h, "chk_orphan", "webhook.unknown_checkout")).toHaveLength(1);
    expect(await h.sql`select 1 from public.terminal_checkouts`).toHaveLength(0);
  });

  it("through the real route, checkout.amount_money.amount is passed through", async () => {
    const id = await awaitingPayment(h);
    const body = JSON.stringify({
      event_id: "evt_orphan",
      type: "terminal.checkout.updated",
      data: { object: { checkout: { id: "chk_route", status: "COMPLETED", reference_id: id, amount_money: { amount: 2500, currency: "AUD" } } } },
    });
    const sig = createHmac("sha256", process.env.SQUARE_WEBHOOK_SIGNATURE_KEY as string)
      .update((process.env.SQUARE_WEBHOOK_URL as string) + body)
      .digest("base64");
    const res = await POST(
      new Request(process.env.SQUARE_WEBHOOK_URL as string, {
        method: "POST",
        headers: { "x-square-hmacsha256-signature": sig },
        body,
      }),
    );
    expect(res.status).toBe(200);
    const [co] = await getCheckouts(h, id);
    expect(co).toMatchObject({ id: "chk_route", amount_cents: 2500, status: "COMPLETED" });
    expect((await getSession(h, id)).status).toBe("paid");
  });
});

describe("R4: PIN throttles hold under parallel guesses", () => {
  const deviceId = () => h.staff.actor.deviceId;
  const codes = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? (r.reason as { code?: string }).code : "ok");

  it("verifyManagerPin: 20 parallel wrong PINs record at most 5 failures and the rest are 429", async () => {
    await h.raw(null, `insert into public.devices (id, label) values ('${deviceId()}', 'Counter')`);
    const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => verifyManagerPin(h.staff.actor, String(3000 + i))));
    const c = res.map(codes);
    expect(c.filter((x) => x === "forbidden").length).toBeLessThanOrEqual(5);
    expect(c.filter((x) => x === "too_many_attempts").length).toBe(20 - c.filter((x) => x === "forbidden").length);
    const [row] = await h.sql<{ n: number }[]>`select count(*)::int n from public.login_attempts where kind = 'manager' and not success`;
    expect(row.n).toBeLessThanOrEqual(5);
    // and the right PIN is locked out afterwards
    await expect(verifyManagerPin(h.staff.actor, MANAGER_PIN)).rejects.toMatchObject({ status: 429 });
  });

  it("login: 10 parallel wrong PINs for one person record at most 5 failures and the rest are 429", async () => {
    const [d] = await h.sql<{ id: string }[]>`insert into public.devices (label) values ('Counter') returning id`;
    await setDeviceCookie(d.id, "Counter");
    const res = await Promise.allSettled(Array.from({ length: 10 }, () => login(h.staff.actor.staffId, "9999")));
    const c = res.map(codes);
    expect(c.filter((x) => x === "invalid_credentials").length).toBeLessThanOrEqual(5);
    expect(c.filter((x) => x === "too_many_attempts").length).toBe(10 - c.filter((x) => x === "invalid_credentials").length);
    const [row] = await h.sql<{ n: number }[]>`select count(*)::int n from public.login_attempts where kind = 'login' and not success`;
    expect(row.n).toBeLessThanOrEqual(5);
  });

  it("checkEnrolCode: 15 parallel wrong codes from one IP record at most 10 failures and the rest are 429", async () => {
    mocks.hdrs.set("x-forwarded-for", "203.0.113.50");
    const res = await Promise.allSettled(Array.from({ length: 15 }, () => checkEnrolCode("wrong-code-here")));
    const c = res.map(codes);
    expect(c.filter((x) => x === "forbidden").length).toBeLessThanOrEqual(10);
    expect(c.filter((x) => x === "too_many_attempts").length).toBe(15 - c.filter((x) => x === "forbidden").length);
    const [row] = await h.sql<{ n: number }[]>`select count(*)::int n from public.login_attempts where kind = 'enrol' and not success`;
    expect(row.n).toBeLessThanOrEqual(10);
  });
});

describe("R5: a failing Square lookup doesn't get hammered", () => {
  it("last_synced_at advances even when gateway.get throws", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    await backdate();
    h.gateway.getFor.set("chk_1", apiError());

    await syncStaleCheckouts();
    expect(h.gateway.gets).toEqual(["chk_1"]);
    const [co] = await getCheckouts(h, id);
    expect(co.last_synced_at).toBeInstanceOf(Date);
    expect(Date.now() - (co.last_synced_at as Date).getTime()).toBeLessThan(60_000);
    expect(co.status).toBe("PENDING");

    // the next poll right away leaves it alone
    await syncStaleCheckouts();
    expect(h.gateway.gets).toEqual(["chk_1"]);
  });
});

describe("R6: a pending cancel is persisted even though the action is refused", () => {
  it("resendCheckout: conflict, but the row shows CANCEL_REQUESTED and the audit row is kept", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelDefault = "CANCEL_REQUESTED";
    await expect(resendCheckout(h.staff.actor, id)).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(h.gateway.creates).toHaveLength(1);
    expect((await getCheckouts(h, id))[0].status).toBe("CANCEL_REQUESTED");
    expect(await audits(h, id, "checkout.cancel_requested")).toHaveLength(1);
    expect((await getSession(h, id)).checkout_attempt).toBe(1);
  });

  it("voidSession: conflict, cancel state + audit kept, session not voided", async () => {
    const id = await awaitingPayment(h);
    await chargeCard(h.staff.actor, id);
    h.gateway.cancelDefault = "CANCEL_REQUESTED";
    await expect(voidSession(h.staff.managerActor, h.staff.manager, id, "Customer left", at(70))).rejects.toMatchObject({ status: 409 });
    expect((await getSession(h, id)).status).toBe("awaiting_payment");
    expect((await getCheckouts(h, id))[0].status).toBe("CANCEL_REQUESTED");
    expect(await audits(h, id, "checkout.cancel_requested")).toHaveLength(1);
    expect(await auditActions(h, id)).not.toContain("session.void");
  });
});
