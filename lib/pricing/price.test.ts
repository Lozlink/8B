import { describe, expect, it } from "vitest";
import { price, gstOf, PricingError, parseLocalTime } from "./index";
import type { PricingInterval, PricingRateCard, PricingSettings } from "./types";

// ---------------------------------------------------------------------------
// Fixtures. All instants are UTC. Sydney is AEDT (UTC+11) from 4 Oct 2026 to
// 4 Apr 2027 and AEST (UTC+10) otherwise.
// ---------------------------------------------------------------------------

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

const STANDARD: PricingRateCard = {
  id: "std",
  name: "Standard",
  centsPerHour: 2500,
  daysOfWeek: ALL_DAYS,
  startMinute: 0,
  endMinute: 1440,
  priority: 0,
  active: true,
};

/** Second card for boundary tests: 22:00–24:00 local, $30/h, outranks Standard. */
const LATE: PricingRateCard = {
  id: "late",
  name: "Late",
  centsPerHour: 3000,
  daysOfWeek: ALL_DAYS,
  startMinute: parseLocalTime("22:00"),
  endMinute: parseLocalTime("24:00:00"),
  priority: 10,
  active: true,
};

/** 00:00–03:00 local, $20/h. Used to prove DST nights split on local, not wall-clock, time. */
const NIGHT: PricingRateCard = {
  id: "night",
  name: "Night",
  centsPerHour: 2000,
  daysOfWeek: ALL_DAYS,
  startMinute: 0,
  endMinute: parseLocalTime("03:00"),
  priority: 10,
  active: true,
};

const SETTINGS: PricingSettings = {
  roundingMinutes: 5,
  graceMinutes: 0,
  minimumMinutes: 30,
  timezone: "Australia/Sydney",
};

const iv = (startedAt: string, endedAt: string | null): PricingInterval => ({ startedAt, endedAt });

function run(
  intervals: PricingInterval[],
  opts: { cards?: PricingRateCard[]; settings?: Partial<PricingSettings>; now?: string } = {},
) {
  return price({
    intervals,
    rateCards: opts.cards ?? [STANDARD],
    settings: { ...SETTINGS, ...opts.settings },
    now: opts.now ?? "2030-01-01T00:00:00Z",
  });
}

// ---------------------------------------------------------------------------

describe("price — basics", () => {
  it("single interval: Table 3, 19:42–21:02 Sat 21 Nov 2026 = 80 min", () => {
    // 19:42 AEDT = 08:42Z. 80 min is already a multiple of 5.
    // 80 × 2500 / 60 = 3333.33… → 3333
    const r = run([iv("2026-11-21T08:42:00Z", "2026-11-21T10:02:00Z")]);
    expect(r.actualMs).toBe(80 * 60_000);
    expect(r.billedMinutes).toBe(80);
    expect(r.totalCents).toBe(3333);
    expect(r.gstCents).toBe(303); // 3333 / 11 = 303.0
    expect(r.lines).toEqual([
      {
        rateCardId: "std",
        rateCardName: "Standard",
        centsPerHour: 2500,
        actualMs: 80 * 60_000,
        minutes: 80,
        cents: 3333,
      },
    ]);
  });

  it("pause/resume: paused time is never billed", () => {
    // 60 min, paused 15 min, 25 min → 85 min → 85 × 2500 / 60 = 3541.67 → 3542
    const r = run([
      iv("2026-11-21T08:00:00Z", "2026-11-21T09:00:00Z"),
      iv("2026-11-21T09:15:00Z", "2026-11-21T09:40:00Z"),
    ]);
    expect(r.billedMinutes).toBe(85);
    expect(r.totalCents).toBe(3542);
  });

  it("transfer: back-to-back intervals on different tables add up", () => {
    // Table 2 for 40 min, Table 5 for 50 min (same instant hand-off) → 90 min → 3750
    const r = run([
      iv("2026-11-21T08:00:00Z", "2026-11-21T08:40:00Z"),
      iv("2026-11-21T08:40:00Z", "2026-11-21T09:30:00Z"),
    ]);
    expect(r.billedMinutes).toBe(90);
    expect(r.totalCents).toBe(3750);
    expect(r.lines).toHaveLength(1);
  });

  it("crossing midnight with a single all-day card", () => {
    // 23:30 Fri 20 Nov → 01:10 Sat 21 Nov AEDT = 100 min → 4166.67 → 4167
    const r = run([iv("2026-11-20T12:30:00Z", "2026-11-20T14:10:00Z")]);
    expect(r.billedMinutes).toBe(100);
    expect(r.totalCents).toBe(4167);
  });

  it("open interval is priced up to `now`", () => {
    // started 19:00 AEDT, now 20:07 → 67 min → 70 → 2916.67 → 2917
    const r = run([iv("2026-11-21T08:00:00Z", null)], { now: "2026-11-21T09:07:00Z" });
    expect(r.actualMs).toBe(67 * 60_000);
    expect(r.billedMinutes).toBe(70);
    expect(r.totalCents).toBe(2917);
  });

  it("open interval with `now` slightly before start (client clock skew) counts as zero", () => {
    const r = run([iv("2026-11-21T08:00:00Z", null)], { now: "2026-11-21T07:59:58Z" });
    expect(r.actualMs).toBe(0);
    expect(r.totalCents).toBe(0);
  });

  it("zero-length session bills nothing", () => {
    const r = run([iv("2026-11-21T08:00:00Z", "2026-11-21T08:00:00Z")]);
    expect(r).toEqual({ actualMs: 0, billedMinutes: 0, lines: [], totalCents: 0, gstCents: 0 });
  });

  it("session with no intervals bills nothing", () => {
    expect(run([]).totalCents).toBe(0);
  });
});

describe("price — rate boundaries", () => {
  it("splits at 22:00 local into Standard + Late", () => {
    // 21:30–22:30 AEDT: 30 min @ $25 (1250) + 30 min @ $30 (1500) = 2750
    const r = run([iv("2026-11-21T10:30:00Z", "2026-11-21T11:30:00Z")], { cards: [STANDARD, LATE] });
    expect(r.billedMinutes).toBe(60);
    expect(r.totalCents).toBe(2750);
    expect(r.lines.map((l) => [l.rateCardId, l.minutes, l.cents])).toEqual([
      ["std", 30, 1250],
      ["late", 30, 1500],
    ]);
  });

  it("allocates rounded-up minutes proportionally and rounds once at the end", () => {
    // 21:31–22:33 AEDT: 29 min Standard + 33 min Late = 62 → billed 65.
    // total = 65 × (29×2500 + 33×3000) / (62×60) = 11_147_500 / 3720 = 2996.64 → 2997
    // minutes: 65×29/62 = 30.40, 65×33/62 = 34.60 → 30 + 35 (largest remainder) = 65
    // cents:   1266.80 + 1729.84 → floors 1266 + 1729, two leftover cents → 1267 + 1730 = 2997
    const r = run([iv("2026-11-21T10:31:00Z", "2026-11-21T11:33:00Z")], { cards: [STANDARD, LATE] });
    expect(r.billedMinutes).toBe(65);
    expect(r.totalCents).toBe(2997);
    expect(r.lines.map((l) => [l.rateCardId, l.minutes, l.cents])).toEqual([
      ["std", 30, 1267],
      ["late", 35, 1730],
    ]);
    expect(r.lines.reduce((a, l) => a + l.cents, 0)).toBe(r.totalCents);
    expect(r.lines.reduce((a, l) => a + l.minutes, 0)).toBe(r.billedMinutes);
  });

  it("late card ends at midnight and Standard resumes", () => {
    // 23:30 → 00:30 AEDT: 30 min Late (1500) + 30 min Standard (1250) = 2750
    const r = run([iv("2026-11-21T12:30:00Z", "2026-11-21T13:30:00Z")], { cards: [STANDARD, LATE] });
    expect(r.lines.map((l) => [l.rateCardId, l.minutes])).toEqual([
      ["late", 30],
      ["std", 30],
    ]);
    expect(r.totalCents).toBe(2750);
  });

  it("a window that wraps midnight belongs to the day it opens", () => {
    // Friday-only card 22:00–02:00 at $40/h. Fri 23:30 → Sat 00:30 AEDT is entirely inside it.
    const friLate: PricingRateCard = {
      ...LATE,
      id: "fri",
      name: "Friday late",
      centsPerHour: 4000,
      daysOfWeek: [5],
      startMinute: parseLocalTime("22:00"),
      endMinute: parseLocalTime("02:00"),
      priority: 20,
    };
    const r = run([iv("2026-11-20T12:30:00Z", "2026-11-20T13:30:00Z")], { cards: [STANDARD, friLate] });
    expect(r.lines.map((l) => l.rateCardId)).toEqual(["fri"]);
    expect(r.totalCents).toBe(4000);

    // Same clock times a day later (Sat → Sun) are not covered by the Friday card.
    const r2 = run([iv("2026-11-21T12:30:00Z", "2026-11-21T13:30:00Z")], { cards: [STANDARD, friLate] });
    expect(r2.lines.map((l) => l.rateCardId)).toEqual(["std"]);
  });

  it("higher priority wins on overlap; inactive cards are ignored", () => {
    const promo: PricingRateCard = { ...STANDARD, id: "promo", name: "Promo", centsPerHour: 1000, priority: 50 };
    const r1 = run([iv("2026-11-21T08:00:00Z", "2026-11-21T09:00:00Z")], { cards: [STANDARD, promo] });
    expect(r1.totalCents).toBe(1000);
    const r2 = run([iv("2026-11-21T08:00:00Z", "2026-11-21T09:00:00Z")], {
      cards: [STANDARD, { ...promo, active: false }],
    });
    expect(r2.totalCents).toBe(2500);
  });

  it("seconds inside a minute are attributed to the card in force at that minute", () => {
    // 21:59:30 → 22:00:30 AEDT: 30 s Standard + 30 s Late. Min 30 → billed 30, split 15/15.
    // total = 30 × (30_000×2500 + 30_000×3000) / (60_000×60) = 1375
    const r = run([iv("2026-11-21T10:59:30Z", "2026-11-21T11:00:30Z")], { cards: [STANDARD, LATE] });
    expect(r.billedMinutes).toBe(30);
    expect(r.totalCents).toBe(1375);
    expect(r.lines.map((l) => [l.rateCardId, l.minutes, l.cents])).toEqual([
      ["std", 15, 625],
      ["late", 15, 750],
    ]);
  });
});

describe("price — DST (Australia/Sydney)", () => {
  it("DST start night, 4 Oct 2026: 01:30 AEST → 03:30 AEDT is 1 real hour, not 2", () => {
    // 02:00 AEST jumps to 03:00 AEDT at 16:00Z.
    const r = run([iv("2026-10-03T15:30:00Z", "2026-10-03T16:30:00Z")]);
    expect(r.actualMs).toBe(60 * 60_000);
    expect(r.billedMinutes).toBe(60);
    expect(r.totalCents).toBe(2500);
  });

  it("DST start night splits on local time: 30 min Night (before 02:00 AEST) + 30 min Standard (after 03:00 AEDT)", () => {
    // 15:30Z–16:00Z is 01:30–02:00 AEST (Night). 16:00Z–16:30Z is 03:00–03:30 AEDT (Standard).
    // 30 × 2000/60 + 30 × 2500/60 = 1000 + 1250 = 2250
    const r = run([iv("2026-10-03T15:30:00Z", "2026-10-03T16:30:00Z")], { cards: [STANDARD, NIGHT] });
    expect(r.lines.map((l) => [l.rateCardId, l.minutes, l.cents])).toEqual([
      ["night", 30, 1000],
      ["std", 30, 1250],
    ]);
    expect(r.totalCents).toBe(2250);
  });

  it("DST end night, 4 Apr 2027: 01:30 AEDT → 02:30 AEST is 2 real hours, not 1", () => {
    // 03:00 AEDT falls back to 02:00 AEST at 16:00Z.
    const r = run([iv("2027-04-03T14:30:00Z", "2027-04-03T16:30:00Z")]);
    expect(r.actualMs).toBe(120 * 60_000);
    expect(r.billedMinutes).toBe(120);
    expect(r.totalCents).toBe(5000);
  });

  it("DST end night: the repeated hour is billed under the Night card both times", () => {
    // 14:30Z (01:30 AEDT) → 17:00Z (03:00 AEST) is 150 real minutes, all inside 00:00–03:00 local.
    // 17:00Z → 17:30Z (03:00–03:30 AEST) is Standard.
    // 150 × 2000/60 + 30 × 2500/60 = 5000 + 1250 = 6250
    const r = run([iv("2027-04-03T14:30:00Z", "2027-04-03T17:30:00Z")], { cards: [STANDARD, NIGHT] });
    expect(r.actualMs).toBe(180 * 60_000);
    expect(r.lines.map((l) => [l.rateCardId, l.minutes, l.cents])).toEqual([
      ["night", 150, 5000],
      ["std", 30, 1250],
    ]);
    expect(r.totalCents).toBe(6250);
  });
});

describe("price — grace, minimum, rounding", () => {
  const at = (minutes: number, extraMs = 0) =>
    iv("2026-11-21T08:00:00Z", new Date(Date.parse("2026-11-21T08:00:00Z") + minutes * 60_000 + extraMs).toISOString());

  it("grace: total exactly equal to grace bills 0", () => {
    expect(run([at(5)], { settings: { graceMinutes: 5 } }).totalCents).toBe(0);
  });

  it("grace: one second over grace bills the minimum", () => {
    const r = run([at(5, 1000)], { settings: { graceMinutes: 5 } });
    expect(r.billedMinutes).toBe(30);
    expect(r.totalCents).toBe(1250);
  });

  it("grace: under grace bills 0", () => {
    expect(run([at(4, 59_000)], { settings: { graceMinutes: 5 } }).totalCents).toBe(0);
  });

  it("grace 0: any positive time bills at least the minimum", () => {
    expect(run([at(0, 1000)]).billedMinutes).toBe(30);
  });

  it("minimum: 10 minutes bills 30", () => {
    const r = run([at(10)]);
    expect(r.billedMinutes).toBe(30);
    expect(r.totalCents).toBe(1250);
  });

  it("minimum: exactly 30 bills 30; one second short still bills 30", () => {
    expect(run([at(30)]).billedMinutes).toBe(30);
    expect(run([at(29, 59_000)]).billedMinutes).toBe(30);
  });

  it("minimum 0 still rounds up to the rounding unit", () => {
    expect(run([at(2)], { settings: { minimumMinutes: 0 } }).billedMinutes).toBe(5);
  });

  it("rounding: an exact multiple is not rounded further", () => {
    const r = run([at(35)]);
    expect(r.billedMinutes).toBe(35);
    expect(r.totalCents).toBe(1458); // 35 × 2500 / 60 = 1458.33
  });

  it("rounding: one second past a multiple rounds up to the next", () => {
    const r = run([at(35, 1000)]);
    expect(r.billedMinutes).toBe(40);
    expect(r.totalCents).toBe(1667); // 1666.67
  });

  it("rounding: one millisecond past a multiple rounds up", () => {
    expect(run([at(35, 1)]).billedMinutes).toBe(40);
  });

  it("rounding 1 minute rounds partial minutes up", () => {
    expect(run([at(61, 30_000)], { settings: { roundingMinutes: 1 } }).billedMinutes).toBe(62);
  });

  it("rounding 15 minutes", () => {
    expect(run([at(46)], { settings: { roundingMinutes: 15 } }).billedMinutes).toBe(60);
  });

  it("rounding is applied once to the whole session, not per interval", () => {
    // Two 31-minute intervals = 62 → 65. Per-interval rounding would give 35 + 35 = 70.
    const r = run([
      iv("2026-11-21T08:00:00Z", "2026-11-21T08:31:00Z"),
      iv("2026-11-21T09:00:00Z", "2026-11-21T09:31:00Z"),
    ]);
    expect(r.billedMinutes).toBe(65);
  });

  it("rounds exact half cents up", () => {
    // $25.50/h = 42.5 c/min; 35 min = 1487.5 → 1488
    const r = run([at(35)], { cards: [{ ...STANDARD, centsPerHour: 2550 }] });
    expect(r.totalCents).toBe(1488);
  });
});

describe("gst", () => {
  it("is 1/11 of the inclusive total, half-up", () => {
    expect(gstOf(2500)).toBe(227); // 227.27
    expect(gstOf(0)).toBe(0);
    expect(gstOf(11)).toBe(1);
    expect(gstOf(115)).toBe(10); // 10.45 → 10
    expect(gstOf(116)).toBe(11); // 10.55 → 11
  });
});

describe("validation", () => {
  it("throws NO_RATE_CARD when nothing covers a minute", () => {
    expect(() => run([iv("2026-11-21T08:00:00Z", "2026-11-21T09:00:00Z")], { cards: [LATE] })).toThrow(PricingError);
    try {
      run([iv("2026-11-21T08:00:00Z", "2026-11-21T09:00:00Z")], { cards: [LATE] });
    } catch (e) {
      expect((e as PricingError).code).toBe("NO_RATE_CARD");
    }
  });

  it("throws on an interval that ends before it starts", () => {
    expect(() => run([iv("2026-11-21T09:00:00Z", "2026-11-21T08:00:00Z")])).toThrow(/ends before/);
  });

  it("throws on invalid settings and unknown zones", () => {
    expect(() => run([], { settings: { roundingMinutes: 0 } })).toThrow(PricingError);
    expect(() => run([], { settings: { timezone: "Mars/Olympus_Mons" } })).toThrow(PricingError);
  });

  it("throws on an invalid rate card", () => {
    expect(() => run([], { cards: [{ ...STANDARD, startMinute: 600, endMinute: 600 }] })).toThrow(PricingError);
  });
});

describe("parseLocalTime", () => {
  it("parses Postgres time output including 24:00:00", () => {
    expect(parseLocalTime("00:00:00")).toBe(0);
    expect(parseLocalTime("06:00")).toBe(360);
    expect(parseLocalTime("24:00:00")).toBe(1440);
    expect(() => parseLocalTime("24:30")).toThrow();
    expect(() => parseLocalTime("10:00:30")).toThrow();
  });
});
