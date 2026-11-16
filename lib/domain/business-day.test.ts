import { describe, expect, it } from "vitest";
import { businessWindow, currentBusinessDate, formatYMD } from "./business-day";

const TZ = "Australia/Sydney";
const SIX = 6 * 60;

describe("business day (06:00 cut-over, Sydney)", () => {
  it("Sat 21 Nov 2026 runs 06:00 AEDT Sat → 06:00 AEDT Sun", () => {
    const { from, to } = businessWindow({ y: 2026, m: 11, d: 21 }, SIX, TZ);
    expect(from.toISOString()).toBe("2026-11-20T19:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-21T19:00:00.000Z");
  });

  it("01:30 Sunday still belongs to Saturday's business day", () => {
    // 01:30 AEDT Sun 22 Nov = 14:30Z Sat 21 Nov
    expect(formatYMD(currentBusinessDate(new Date("2026-11-21T14:30:00Z"), SIX, TZ))).toBe("2026-11-21");
  });

  it("06:00 exactly starts the new business day", () => {
    expect(formatYMD(currentBusinessDate(new Date("2026-11-21T19:00:00Z"), SIX, TZ))).toBe("2026-11-22");
    expect(formatYMD(currentBusinessDate(new Date("2026-11-21T18:59:59Z"), SIX, TZ))).toBe("2026-11-21");
  });

  it("DST start day (Sat 3 Oct 2026) is 23 real hours long", () => {
    const { from, to } = businessWindow({ y: 2026, m: 10, d: 3 }, SIX, TZ);
    expect(from.toISOString()).toBe("2026-10-02T20:00:00.000Z"); // 06:00 AEST
    expect(to.toISOString()).toBe("2026-10-03T19:00:00.000Z"); // 06:00 AEDT
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(23);
  });

  it("DST end day (Sat 3 Apr 2027) is 25 real hours long", () => {
    const { from, to } = businessWindow({ y: 2027, m: 4, d: 3 }, SIX, TZ);
    expect(from.toISOString()).toBe("2027-04-02T19:00:00.000Z"); // 06:00 AEDT
    expect(to.toISOString()).toBe("2027-04-03T20:00:00.000Z"); // 06:00 AEST
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(25);
  });

  it("handles month and year rollover", () => {
    const { to } = businessWindow({ y: 2026, m: 12, d: 31 }, SIX, TZ);
    expect(to.toISOString()).toBe("2026-12-31T19:00:00.000Z"); // 06:00 AEDT 1 Jan 2027
  });
});
