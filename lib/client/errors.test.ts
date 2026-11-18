import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { isBillChanged } from "./errors";

describe("isBillChanged", () => {
  it("is the 409 the server sends when the amount on screen is no longer the bill", () => {
    expect(isBillChanged(new ApiError(409, "bill_changed", "The bill changed to $20.00. Check the amount, then try again."))).toBe(true);
  });

  it("is not any other 409, or any other failure", () => {
    expect(isBillChanged(new ApiError(409, "conflict", "Cancel the card request first."))).toBe(false);
    expect(isBillChanged(new ApiError(400, "bill_changed", "x"))).toBe(false);
    expect(isBillChanged(new ApiError(0, "network", "No connection."))).toBe(false);
    expect(isBillChanged(new Error("bill_changed"))).toBe(false);
    expect(isBillChanged(null)).toBe(false);
  });
});
