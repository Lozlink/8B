import { describe, expect, it } from "vitest";
import { stockCountsFromWebhook, verifySquareSignature } from "./webhook";

// Test vector from https://developer.squareup.com/docs/webhooks/step3validate
const KEY = "asdf1234";
const URL = "https://example.com/webhook";
const BODY = '{"hello":"world"}';
const SIG = "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=";

describe("verifySquareSignature", () => {
  it("accepts Square's documented example", () => {
    expect(verifySquareSignature({ rawBody: BODY, signatureHeader: SIG, signatureKey: KEY, notificationUrl: URL })).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifySquareSignature({ rawBody: '{"hello":"world!"}', signatureHeader: SIG, signatureKey: KEY, notificationUrl: URL }),
    ).toBe(false);
  });

  it("rejects when the notification URL differs (e.g. trailing slash)", () => {
    expect(
      verifySquareSignature({ rawBody: BODY, signatureHeader: SIG, signatureKey: KEY, notificationUrl: URL + "/" }),
    ).toBe(false);
  });

  it("rejects a wrong key, a missing header, and garbage", () => {
    expect(verifySquareSignature({ rawBody: BODY, signatureHeader: SIG, signatureKey: "nope", notificationUrl: URL })).toBe(false);
    expect(verifySquareSignature({ rawBody: BODY, signatureHeader: null, signatureKey: KEY, notificationUrl: URL })).toBe(false);
    expect(verifySquareSignature({ rawBody: BODY, signatureHeader: "!!!", signatureKey: KEY, notificationUrl: URL })).toBe(false);
  });
});

describe("stockCountsFromWebhook", () => {
  const count = (over: Record<string, unknown> = {}) => ({
    catalog_object_id: "V1",
    catalog_object_type: "ITEM_VARIATION",
    location_id: "L1",
    quantity: "4.7",
    state: "IN_STOCK",
    calculated_at: "2026-11-21T01:00:00Z",
    ...over,
  });

  it("keeps the shelf counts for our location, rounded down", () => {
    expect(stockCountsFromWebhook({ inventory_counts: [count()] }, "L1")).toEqual([
      { variationId: "V1", quantity: 4, calculatedAt: new Date("2026-11-21T01:00:00Z") },
    ]);
  });

  it("drops other states, other locations, non-variations, unreadable quantities and odd entries", () => {
    const object = {
      inventory_counts: [
        count({ state: "SOLD" }),
        count({ location_id: "L2" }),
        count({ catalog_object_type: "ITEM" }),
        count({ quantity: "lots" }),
        count({ quantity: null }),
        "junk",
        null,
        count({ catalog_object_type: undefined, calculated_at: "not a date", quantity: "0" }),
      ],
    };
    expect(stockCountsFromWebhook(object, "L1")).toEqual([{ variationId: "V1", quantity: 0, calculatedAt: null }]);
  });

  it("drops a quantity too big to store, keeping the others", () => {
    const out = stockCountsFromWebhook({ inventory_counts: [count({ quantity: "99999999999" }), count({ catalog_object_id: "V2", quantity: "3" })] }, "L1");
    expect(out?.map((c) => c.variationId)).toEqual(["V2"]);
  });

  it("says so when the payload isn't the shape it expects", () => {
    expect(stockCountsFromWebhook(undefined, "L1")).toBeNull();
    expect(stockCountsFromWebhook({ inventory_counts: "nope" }, "L1")).toBeNull();
    expect(stockCountsFromWebhook({}, "L1")).toBeNull();
  });
});
