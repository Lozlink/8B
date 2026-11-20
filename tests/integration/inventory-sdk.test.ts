import { beforeEach, describe, expect, it, vi } from "vitest";
import { SquareError } from "square";

// What `lib/square/inventory.ts` sends to the SDK and how it reads the answer. The stand-in client
// records the request and hands back what the real one would.
const calls: { name: string; request: Record<string, unknown>; options?: Record<string, unknown> }[] = [];
let countPages: Record<string, unknown>[][] = [];
let failWith: Error | null = null;
let orderAnswer: Record<string, unknown> | undefined;

vi.mock("@/lib/square/client", async (orig) => {
  const actual = await orig<typeof import("@/lib/square/client")>();
  return {
    ...actual,
    square: () => ({
      orders: {
        get: async (request: Record<string, unknown>) => {
          calls.push({ name: "orders.get", request });
          if (failWith) throw failWith;
          return { order: orderAnswer };
        },
      },
      inventory: {
        batchGetCounts: async (request: Record<string, unknown>) => {
          calls.push({ name: "batchGetCounts", request });
          if (failWith) throw failWith;
          const items = countPages.shift() ?? [];
          return { async *[Symbol.asyncIterator]() { yield* items; } };
        },
        batchCreateChanges: async (request: Record<string, unknown>, options: Record<string, unknown>) => {
          calls.push({ name: "batchCreateChanges", request, options });
          if (failWith) throw failWith;
          return {};
        },
      },
    }),
  };
});

import { changeStock, getStockCounts, wholeUnits } from "@/lib/square/inventory";
import { getOrderItems } from "@/lib/square/orders";

beforeEach(() => {
  calls.length = 0;
  countPages = [];
  failWith = null;
});

describe("getStockCounts", () => {
  it("asks for IN_STOCK at our location only, 100 ids at a time, and rounds down", async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `V${i}`);
    countPages = [
      [
        { catalogObjectId: "V1", state: "IN_STOCK", locationId: "L1", quantity: "7.9", calculatedAt: "2026-11-21T01:00:00Z" },
        { catalogObjectId: "V2", state: "IN_STOCK", locationId: "L1", quantity: "-2.5" },
        { catalogObjectId: "V3", state: "IN_STOCK", locationId: "L1", quantity: "not a number" },
        { catalogObjectId: "V4", state: "SOLD", locationId: "L1", quantity: "3" },
        { catalogObjectId: "V5", state: "IN_STOCK", locationId: "OTHER", quantity: "3" },
      ],
      [],
      [{ catalogObjectId: "V229", state: "IN_STOCK", locationId: "L1", quantity: "0" }],
    ];
    const out = await getStockCounts({ locationId: "L1", variationIds: ids });
    expect(out).toEqual([
      { variationId: "V1", quantity: 7, calculatedAt: new Date("2026-11-21T01:00:00Z") },
      { variationId: "V2", quantity: -3, calculatedAt: null },
      { variationId: "V229", quantity: 0, calculatedAt: null },
    ]);
    expect(calls.map((c) => (c.request.catalogObjectIds as string[]).length)).toEqual([100, 100, 30]);
    expect(calls[0].request).toMatchObject({ locationIds: ["L1"], states: ["IN_STOCK"] });
  });

  it("[6] drops a count too big to store", async () => {
    countPages = [[
      { catalogObjectId: "V1", state: "IN_STOCK", locationId: "L1", quantity: "99999999999" },
      { catalogObjectId: "V2", state: "IN_STOCK", locationId: "L1", quantity: "5" },
    ]];
    expect((await getStockCounts({ locationId: "L1", variationIds: ["V1", "V2"] })).map((c) => c.variationId)).toEqual(["V2"]);
  });

  it("turns a Square error into a message staff can read", async () => {
    failWith = new SquareError({ message: "boom", statusCode: 500, body: { errors: [{ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR", detail: "Square had a problem" }] } });
    await expect(getStockCounts({ locationId: "L1", variationIds: ["V1"] })).rejects.toMatchObject({
      code: "square_error",
      message: expect.stringMatching(/couldn't read stock levels/),
    });
  });
});

describe("changeStock", () => {
  const base = { idempotencyKey: "S-st1", locationId: "L1", occurredAt: new Date("2026-11-21T01:02:03Z"), lines: [{ variationId: "V1", quantity: 2 }, { variationId: "V2", quantity: 1 }] };

  it("a sale is an adjustment from IN_STOCK to SOLD", async () => {
    await changeStock({ ...base, kind: "sale" });
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toEqual({
      idempotencyKey: "S-st1",
      ignoreUnchangedCounts: true,
      changes: [
        { type: "ADJUSTMENT", adjustment: { catalogObjectId: "V1", fromState: "IN_STOCK", toState: "SOLD", fromLocationId: "L1", toLocationId: "L1", quantity: "2", occurredAt: "2026-11-21T01:02:03.000Z" } },
        { type: "ADJUSTMENT", adjustment: { catalogObjectId: "V2", fromState: "IN_STOCK", toState: "SOLD", fromLocationId: "L1", toLocationId: "L1", quantity: "1", occurredAt: "2026-11-21T01:02:03.000Z" } },
      ],
    });
    expect(calls[0].options).toEqual({ timeoutInSeconds: 8, maxRetries: 0 });
  });

  it("putting stock back is an adjustment from UNLINKED_RETURN to IN_STOCK", async () => {
    await changeStock({ ...base, kind: "restock" });
    const changes = calls[0].request.changes as { adjustment: Record<string, unknown> }[];
    expect(changes.map((c) => [c.adjustment.fromState, c.adjustment.toState])).toEqual([
      ["UNLINKED_RETURN", "IN_STOCK"],
      ["UNLINKED_RETURN", "IN_STOCK"],
    ]);
  });

  it("a Square error comes back as an upstream error carrying the status", async () => {
    failWith = new SquareError({ message: "no", statusCode: 400, body: { errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", detail: "nope" }] } });
    await expect(changeStock({ ...base, kind: "sale" })).rejects.toMatchObject({ code: "square_error", detail: { status: 400, codes: ["BAD_REQUEST"] } });
  });
});

describe("getOrderItems", () => {
  it("keeps the lines tied to a catalogue item, as whole numbers", async () => {
    orderAnswer = {
      id: "O1",
      state: "COMPLETED",
      lineItems: [
        { catalogObjectId: "V1", quantity: "2" },
        { catalogObjectId: "V2", quantity: "1.5" },
        { name: "Custom", quantity: "1" },
        { catalogObjectId: "V3", quantity: "0" },
        { catalogObjectId: "V4", quantity: "lots" },
      ],
    };
    expect(await getOrderItems("O1")).toEqual({
      state: "COMPLETED",
      items: [
        { catalogObjectId: "V1", quantity: 2 },
        { catalogObjectId: "V2", quantity: 1 },
      ],
    });
    expect(calls[0]).toMatchObject({ name: "orders.get", request: { orderId: "O1" } });
  });

  it("an order with no lines is an empty list", async () => {
    orderAnswer = { id: "O2" };
    expect(await getOrderItems("O2")).toEqual({ state: null, items: [] });
  });
});

describe("wholeUnits", () => {
  it("rounds down and skips what isn't a number", () => {
    expect([wholeUnits("3"), wholeUnits("2.99999"), wholeUnits("-0.5"), wholeUnits(" "), wholeUnits(""), wholeUnits(null), wholeUnits("x")]).toEqual([3, 2, -1, null, null, null, null]);
  });
});
