import { describe, expect, it } from "vitest";
import { assertCan, can, isCheckoutLive, MANAGER_ACTIONS, TransitionError, type SessionAction } from "./machine";

describe("session state machine", () => {
  it("allows the happy path", () => {
    expect(can("running", "pause")).toBe(true);
    expect(can("paused", "resume")).toBe(true);
    expect(can("running", "transfer")).toBe(true);
    expect(can("paused", "transfer")).toBe(true);
    expect(can("running", "stop")).toBe(true);
    expect(can("paused", "stop")).toBe(true);
    expect(can("awaiting_payment", "charge_card")).toBe(true);
    expect(can("awaiting_payment", "mark_paid")).toBe(true);
    expect(can("paid", "reverse_paid")).toBe(true);
  });

  it("refuses illegal transitions", () => {
    expect(can("paused", "pause")).toBe(false);
    expect(can("running", "resume")).toBe(false);
    expect(can("running", "mark_paid")).toBe(false);
    expect(can("running", "charge_card")).toBe(false);
    expect(can("awaiting_payment", "pause")).toBe(false);
    expect(can("awaiting_payment", "transfer")).toBe(false);
  });

  it("paid can only be reversed; void is terminal", () => {
    const all: SessionAction[] = [
      "pause", "resume", "transfer", "stop", "release_table", "charge_card", "cancel_checkout",
      "resend_checkout", "sync_checkout", "mark_paid", "void", "reverse_paid", "edit_times",
    ];
    expect(all.filter((a) => can("paid", a))).toEqual(["reverse_paid"]);
    expect(all.filter((a) => can("void", a))).toEqual([]);
  });

  it("a paid session cannot be voided directly (reverse first, so the trail shows both steps)", () => {
    expect(can("paid", "void")).toBe(false);
  });

  it("assertCan throws a readable TransitionError", () => {
    expect(() => assertCan("paid", "pause")).toThrow(TransitionError);
    expect(() => assertCan("paid", "pause")).toThrow("Can't pause a session that is paid.");
  });

  it("manager-only actions", () => {
    expect([...MANAGER_ACTIONS].sort()).toEqual(["edit_times", "refund", "reverse_paid", "void"]);
  });

  it("only a paid bill can be refunded or have a receipt printed", () => {
    for (const from of ["running", "paused", "awaiting_payment", "void"] as const) {
      expect(can(from, "refund")).toBe(false);
      expect(can(from, "print_receipt")).toBe(false);
    }
    expect(can("paid", "refund")).toBe(true);
    expect(can("paid", "print_receipt")).toBe(true);
  });

  it("discounts follow the items rule; splitting needs a closed, unpaid bill", () => {
    for (const from of ["running", "paused", "awaiting_payment"] as const) {
      expect(can(from, "set_discount")).toBe(true);
      expect(can(from, "remove_discount")).toBe(true);
    }
    for (const from of ["paid", "void"] as const) {
      expect(can(from, "set_discount")).toBe(false);
      expect(can(from, "remove_discount")).toBe(false);
    }
    for (const action of ["split", "merge_back", "discard"] as const) {
      expect(can("awaiting_payment", action)).toBe(true);
      for (const from of ["running", "paused", "paid", "void"] as const) expect(can(from, action)).toBe(false);
    }
  });

  it("treats CANCEL_REQUESTED as still able to take money", () => {
    expect(isCheckoutLive("PENDING")).toBe(true);
    expect(isCheckoutLive("IN_PROGRESS")).toBe(true);
    expect(isCheckoutLive("CANCEL_REQUESTED")).toBe(true);
    expect(isCheckoutLive("CANCELED")).toBe(false);
    expect(isCheckoutLive("COMPLETED")).toBe(false);
    expect(isCheckoutLive(null)).toBe(false);
  });
});
