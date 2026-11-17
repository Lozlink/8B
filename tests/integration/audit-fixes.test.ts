import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { squareRejection, squareServerError, squareTimeout } from "./helpers/fake-gateway";
import { audits, awaitingPayment, getCheckouts, getSession } from "./helpers/util";
import { withTx, type Db } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { errorResponse } from "@/lib/server/http";
import { BILL_BUSY_MESSAGE, lockSession } from "@/lib/server/repo";
import {
  applyWebhookCheckout,
  chargeCard,
  markPaid,
  resendCheckout,
  syncCheckout,
  syncStaleCheckouts,
} from "@/lib/server/sessions";

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
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

async function charged(): Promise<string> {
  const id = await awaitingPayment(h);
  await chargeCard(h.staff.actor, id);
  return id;
}

/** Ages every checkout, as if it was sent this long ago. */
const age = (minutes: number) =>
  h.raw(null, `update public.terminal_checkouts set created_at = now() - interval '${minutes} minutes', last_synced_at = null`);

const notFound = () => squareRejection(404, "NOT_FOUND", "Square couldn't check the card payment: checkout not found");

describe("A1. waiting for a bill someone else has locked", () => {
  it("caps the wait at 4 s for the transaction only", async () => {
    const id = await awaitingPayment(h);
    await withTx(async (tx) => {
      expect(await lockSession(tx, id)).toMatchObject({ id });
      const [r] = await tx<{ lock_timeout: string }[]>`show lock_timeout`;
      expect(r.lock_timeout).toBe("4s");
    });
    const [after] = await h.sql<{ lock_timeout: string }[]>`show lock_timeout`;
    expect(after.lock_timeout).toBe("0");
  });

  // PGlite gives the suite one connection, so a real lock wait can't be staged. These feed
  // lockSession the errors Postgres and postgres.js raise for one.
  const failingWith = (code: string): Db => {
    let calls = 0;
    const q = () => (++calls === 1 ? Promise.resolve([]) : Promise.reject(Object.assign(new Error(code), { code })));
    return q as unknown as Db;
  };

  it("a lock timeout on the bill is a 409 staff can read", async () => {
    for (const code of ["55P03", "QUERY_TIMEOUT"]) {
      const err = await lockSession(failingWith(code), "00000000-0000-4000-8000-000000000001").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ status: 409, code: "bill_busy", message: BILL_BUSY_MESSAGE });
      const res = errorResponse(err);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "bill_busy", message: BILL_BUSY_MESSAGE } });
    }
  });

  it("other database errors on the lock are not dressed up as 'busy'", async () => {
    const err = await lockSession(failingWith("08006"), "00000000-0000-4000-8000-000000000001").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AppError);
    expect(errorResponse(err).status).toBe(500);
  });

  it("a lock timeout on any other row in the transaction is a 409 too, not a 500", async () => {
    const res = errorResponse(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "busy" } });
  });
});

describe("A1b. the webhook still answers 5xx when the bill is locked", () => {
  it("a bill_busy from the lock becomes a 500 and the event is not recorded, so Square retries", async () => {
    const id = await charged();
    const { POST } = await import("@/app/api/square/webhook/route");
    const body = JSON.stringify({
      event_id: "evt_busy",
      type: "terminal.checkout.updated",
      data: { object: { checkout: { id: "chk_1", status: "COMPLETED", reference_id: id, cancel_reason: null } } },
    });
    const url = process.env.SQUARE_WEBHOOK_URL as string;
    const sig = createHmac("sha256", process.env.SQUARE_WEBHOOK_SIGNATURE_KEY as string).update(url + body).digest("base64");
    const deliver = () =>
      POST(new Request(url, { method: "POST", headers: { "x-square-hmacsha256-signature": sig }, body }));

    // Someone else holds the bill: make the lock statement fail the way Postgres would after 4 s.
    const real = h.sql.begin.bind(h.sql);
    const spy = vi.spyOn(h.sql, "begin").mockImplementation(((fn: (tx: Db) => Promise<unknown>) =>
      real((tx) => {
        const wrapped = new Proxy(tx, {
          apply(target, thisArg, args: unknown[]) {
            const first = args[0];
            if (Array.isArray(first) && first.join("").includes("for update") && first.join("").includes("public.sessions")) {
              return Promise.reject(Object.assign(new Error("lock timeout"), { code: "55P03" }));
            }
            return Reflect.apply(target, thisArg, args) as unknown;
          },
        });
        return fn(wrapped as unknown as Db);
      })) as typeof h.sql.begin);

    expect((await deliver()).status).toBe(500);
    expect(await h.sql`select 1 from public.webhook_events`).toHaveLength(0);
    expect((await getSession(h, id)).status).toBe("awaiting_payment");

    // The lock clears; Square's retry goes through.
    spy.mockRestore();
    expect((await deliver()).status).toBe(200);
    expect((await getSession(h, id)).status).toBe("paid");
  });
});

describe("A4. a checkout Square can't find", () => {
  it("older than 10 minutes: closed as cancelled, with an audit row saying why", async () => {
    const id = await charged();
    await age(11);
    h.gateway.getFor.set("chk_1", notFound());
    await syncCheckout(h.staff.actor, id);

    const [c] = await getCheckouts(h, id);
    expect(c).toMatchObject({ status: "CANCELED", cancel_reason: "Not found in Square" });
    const [a] = await audits(h, id, "checkout.canceled");
    expect(a.after).toMatchObject({ checkout_id: "chk_1", status: "CANCELED", cancel_reason: "Not found in Square" });
    expect(a.reason).toMatch(/no record of this card request/);
    expect((await getSession(h, id)).status).toBe("awaiting_payment");

    // The bill isn't stuck: it can be charged again.
    await expect(chargeCard(h.staff.actor, id)).resolves.toMatchObject({ kind: "sent", checkoutId: "chk_2" });
  });

  it("the background check does the same", async () => {
    const id = await charged();
    await age(11);
    h.gateway.getFor.set("chk_1", notFound());
    await syncStaleCheckouts();
    expect((await getCheckouts(h, id))[0].status).toBe("CANCELED");
  });

  it("younger than 10 minutes: left live, and the check fails as before", async () => {
    const id = await charged();
    await age(9);
    h.gateway.getFor.set("chk_1", notFound());
    await expect(syncCheckout(h.staff.actor, id)).rejects.toMatchObject({ code: "square_error" });
    expect((await getCheckouts(h, id))[0]).toMatchObject({ status: "PENDING", cancel_reason: null });
    expect(await audits(h, id, "checkout.canceled")).toHaveLength(0);
  });

  it("a timeout, a 5xx, a 401, a 403 or a 404 that isn't NOT_FOUND never cancels, however old", async () => {
    const id = await charged();
    await age(600);
    const others = [
      squareTimeout(),
      squareServerError(),
      squareRejection(401, "UNAUTHORIZED"),
      squareRejection(403, "FORBIDDEN"),
      squareRejection(404, "BAD_REQUEST"),
      squareRejection(400, "NOT_FOUND"),
      new Error("socket hang up"),
    ];
    for (const e of others) {
      h.gateway.getFor.set("chk_1", e);
      await expect(syncCheckout(h.staff.actor, id)).rejects.toBeTruthy();
      expect((await getCheckouts(h, id))[0].status).toBe("PENDING");

      h.gateway.cancelFor.set("chk_1", e);
      const out = await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false });
      // Today's behaviour: the bill is paid with a warning to cancel on the Terminal by hand.
      expect(out.warnings.length).toBeGreaterThan(0);
      expect((await getCheckouts(h, id))[0].status).toBe("PENDING");
      await h.raw(
        null,
        `update public.sessions set status = 'awaiting_payment', settled_method = null, settled_via = null,
           settled_by = null, settled_at = null where id = '${id}'`,
      );
    }
    expect(await audits(h, id, "checkout.canceled")).toHaveLength(0);
  });

  it("cancelling an old checkout Square can't find closes it, with no warning", async () => {
    const id = await charged();
    await age(11);
    h.gateway.cancelFor.set("chk_1", notFound());
    const out = await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false });
    expect(out).toMatchObject({ kind: "paid", warnings: [] });
    expect((await getCheckouts(h, id))[0]).toMatchObject({ status: "CANCELED", cancel_reason: "Not found in Square" });
    expect(await audits(h, id, "checkout.cancel_failed")).toHaveLength(0);
    expect((await audits(h, id, "checkout.canceled"))[0].reason).toMatch(/no record of this card request/);
  });

  it("cancelling a young one Square can't find keeps today's warning", async () => {
    const id = await charged();
    h.gateway.cancelFor.set("chk_1", notFound());
    const out = await markPaid(h.staff.actor, id, "cash", { cardConfirmed: false });
    expect(out.warnings).toHaveLength(1);
    expect((await getCheckouts(h, id))[0].status).toBe("PENDING");
    expect(await audits(h, id, "checkout.cancel_failed")).toHaveLength(1);
  });

  it("if it completes after all, the payment still counts", async () => {
    const id = await charged();
    await age(11);
    h.gateway.getFor.set("chk_1", notFound());
    await syncCheckout(h.staff.actor, id);
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "COMPLETED", referenceId: id, cancelReason: null, amountCents: null }));
    expect(await getSession(h, id)).toMatchObject({ status: "paid", settled_method: "card", settled_cents: 2500 });
  });
});

describe("A5. resend never puts a second request beside a live one", () => {
  it("refuses when the cancel left the checkout live, whatever the cancel call reported", async () => {
    const id = await charged();
    // Square answers the cancel with "still in progress": not CANCEL_REQUESTED, no error.
    h.gateway.cancelDefault = "IN_PROGRESS";
    await expect(resendCheckout(h.staff.actor, id)).rejects.toMatchObject({ status: 409, code: "conflict", message: expect.stringMatching(/still cancelling/) });

    expect(h.gateway.creates).toHaveLength(1);
    const cos = await getCheckouts(h, id);
    expect(cos.map((c) => c.status)).toEqual(["IN_PROGRESS"]);
    expect((await getSession(h, id)).checkout_attempt).toBe(1);
    // Returned, not thrown: what the cancel found out is kept.
    expect(await audits(h, id, "checkout.cancel_requested")).toHaveLength(1);
  });

  it("still resends once the old request is really cancelled", async () => {
    const id = await charged();
    h.gateway.cancelDefault = "IN_PROGRESS";
    await expect(resendCheckout(h.staff.actor, id)).rejects.toMatchObject({ status: 409 });
    h.gateway.cancelDefault = "CANCELED";
    await expect(resendCheckout(h.staff.actor, id)).resolves.toMatchObject({ kind: "sent", checkoutId: "chk_2" });
  });
});

describe("A3. checkout state is only written when it changes", () => {
  it("a webhook repeating the status we hold leaves the row untouched", async () => {
    const id = await charged();
    const [before] = await h.sql<{ updated_at: Date; last_synced_at: Date | null }[]>`
      select updated_at, last_synced_at from public.terminal_checkouts`;
    await withTx((tx) => applyWebhookCheckout(tx, { id: "chk_1", status: "PENDING", referenceId: id, cancelReason: null, amountCents: null }));
    await syncCheckout(h.staff.actor, id); // Square: still PENDING
    const [after] = await h.sql<{ updated_at: Date; last_synced_at: Date | null }[]>`
      select updated_at, last_synced_at from public.terminal_checkouts`;
    expect(after).toEqual(before);
  });
});
