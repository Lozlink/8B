import { describe, expect, it } from "vitest";
import type { FloorDTO } from "@/lib/domain/types";
import {
  connectionState,
  countsAsFloorFailure,
  floorFingerprint,
  pollIntervalMs,
  timeOffsetSample,
} from "./floor-logic";

const floor = (over: Partial<FloorDTO> = {}): FloorDTO => ({
  serverTime: "2026-11-18T10:00:00.000Z",
  tables: [],
  sessions: [],
  unpaidOffTableCount: 0,
  pricing: {} as FloorDTO["pricing"],
  terminalPaired: true,
  posCashAvailable: false,
  products: [],
  ...over,
});

describe("floorFingerprint", () => {
  it("ignores serverTime", () => {
    expect(floorFingerprint(floor())).toBe(floorFingerprint(floor({ serverTime: "2026-11-18T10:00:20.000Z" })));
  });
  it("changes when the floor changes", () => {
    expect(floorFingerprint(floor())).not.toBe(floorFingerprint(floor({ unpaidOffTableCount: 1 })));
    expect(floorFingerprint(floor())).not.toBe(floorFingerprint(floor({ terminalPaired: false })));
  });
});

describe("connectionState", () => {
  it("is ok for a single failure", () => expect(connectionState(true, 1)).toBe("ok"));
  it("is degraded, not offline, for a short run", () => {
    expect(connectionState(true, 2)).toBe("degraded");
    expect(connectionState(true, 4)).toBe("degraded");
  });
  it("is offline for a long run or no network", () => {
    expect(connectionState(true, 5)).toBe("offline");
    expect(connectionState(false, 0)).toBe("offline");
  });
});

describe("failure counting", () => {
  it("counts everything except auth redirects", () => {
    expect(countsAsFloorFailure(false)).toBe(true);
    expect(countsAsFloorFailure(true)).toBe(false);
  });
});

describe("pollIntervalMs", () => {
  it("polls fast while Realtime is not up and slowly once it is", () => {
    expect(pollIntervalMs(0, false)).toBe(5000);
    expect(pollIntervalMs(0, true)).toBe(20000);
  });
  it("retries quickly while failing", () => {
    expect(pollIntervalMs(2, true)).toBe(3000);
  });
});

describe("timeOffsetSample", () => {
  it("uses the midpoint of the round trip", () => {
    expect(timeOffsetSample(1000, 1200, 5100)).toBe(4000);
  });
  it("drops slow round trips and nonsense", () => {
    expect(timeOffsetSample(0, 2001, 5000)).toBeNull();
    expect(timeOffsetSample(0, 2000, 5000)).not.toBeNull();
    expect(timeOffsetSample(10, 5, 5000)).toBeNull();
    expect(timeOffsetSample(0, 100, Number.NaN)).toBeNull();
  });
});
