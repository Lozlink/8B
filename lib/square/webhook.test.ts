import { describe, expect, it } from "vitest";
import { verifySquareSignature } from "./webhook";

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
