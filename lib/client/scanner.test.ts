import { describe, expect, it } from "vitest";
import { EMPTY_SCAN, SCAN_GAP_MS, TRAILING_SUFFIX_MS, isTrailingSuffix, scanIdle, scanStep, type KeyInput, type ScanState } from "./scanner";

/** Feeds keys in order; returns each step's result. */
function feed(keys: KeyInput[], from: ScanState = EMPTY_SCAN) {
  let state = from;
  return keys.map((k) => {
    const step = scanStep(state, k);
    state = step.state;
    return step;
  });
}

function burst(digits: string, startMs: number, gapMs: number): KeyInput[] {
  return [...digits].map((key, i) => ({ key, timeMs: startMs + i * gapMs }));
}

const enterAfter = (keys: KeyInput[], gapMs: number): KeyInput => ({
  key: "Enter",
  timeMs: keys[keys.length - 1].timeMs + gapMs,
});

describe("scanStep", () => {
  it("finishes a fast burst of digits plus Enter as a scan, and consumes the Enter", () => {
    const keys = burst("9300633123456", 1000, 8);
    const steps = feed([...keys, enterAfter(keys, 10)]);
    expect(steps.slice(0, -1).every((s) => s.code === null && !s.consume)).toBe(true);
    const last = steps[steps.length - 1];
    expect(last.code).toBe("9300633123456");
    expect(last.consume).toBe(true);
    expect(last.state).toEqual(EMPTY_SCAN);
  });

  it("keeps the padding in the code it reports", () => {
    const keys = burst("0012345678905", 0, 5);
    expect(feed([...keys, enterAfter(keys, 5)]).pop()?.code).toBe("0012345678905");
  });

  it("ignores human-speed typing", () => {
    const keys = burst("9300633123456", 0, SCAN_GAP_MS + 40);
    const last = feed([...keys, enterAfter(keys, 20)]).pop();
    expect(last?.code).toBeNull();
    expect(last?.consume).toBe(false);
  });

  it("starts a new burst after a slow gap, dropping what came before", () => {
    const junk = burst("12", 0, 5);
    const scan = burst("9300633123456", 1000, 6);
    const last = feed([...junk, ...scan, enterAfter(scan, 6)]).pop();
    expect(last?.code).toBe("9300633123456");
  });

  it("does not count Enter that comes too late", () => {
    const keys = burst("9300633123456", 0, 5);
    expect(feed([...keys, enterAfter(keys, 500)]).pop()?.code).toBeNull();
  });

  it("needs at least 6 characters, and a real barcode", () => {
    const short = burst("12345", 0, 5);
    expect(feed([...short, enterAfter(short, 5)]).pop()?.code).toBeNull();
    const zeros = burst("000000", 0, 5);
    expect(feed([...zeros, enterAfter(zeros, 5)]).pop()?.consume).toBe(false);
    const letters = burst("abcdefgh", 0, 5);
    expect(feed([...letters, enterAfter(letters, 5)]).pop()?.code).toBeNull();
  });

  it("resets on a non-printable key in the middle", () => {
    const a = burst("93006", 0, 5);
    const tab: KeyInput = { key: "Tab", timeMs: 30 };
    const b = burst("33123456", 35, 5);
    const last = feed([...a, tab, ...b.slice(0, 3), enterAfter(b.slice(0, 3), 5)]).pop();
    expect(last?.code).toBeNull();
  });

  it("resets on a modifier chord and on held-key repeat", () => {
    const a = burst("930063", 0, 5);
    const chord = feed([...a, { key: "c", timeMs: 30, meta: true }, { key: "Enter", timeMs: 35 }]).pop();
    expect(chord?.code).toBeNull();
    const rep = feed([...a, { key: "3", timeMs: 30, repeat: true }, { key: "Enter", timeMs: 35 }]).pop();
    expect(rep?.code).toBeNull();
  });

  it("lets Shift through without breaking the burst", () => {
    const a = burst("930063", 0, 5);
    const steps = feed([...a, { key: "Shift", timeMs: 28 }, { key: "3", timeMs: 32 }, { key: "Enter", timeMs: 37 }]);
    expect(steps.pop()?.code).toBe("9300633");
  });

  it("gives up on an over-long burst", () => {
    const long = burst("1".repeat(40), 0, 2);
    expect(feed([...long, enterAfter(long, 2)]).pop()?.code).toBeNull();
  });
});

describe("scanners that don't end with a prompt Enter", () => {
  const stateAfter = (keys: KeyInput[]) => feed(keys).at(-1)?.state ?? EMPTY_SCAN;

  it("takes Tab as the suffix, like Enter", () => {
    const keys = burst("9300675024235", 1000, 8);
    const steps = feed([...keys, { key: "Tab", timeMs: keys[keys.length - 1].timeMs + 8 }]);
    expect(steps.at(-1)).toMatchObject({ code: "9300675024235", consume: true });
  });

  it("no suffix: a fast burst that is a barcode is a scan once the keys stop", () => {
    expect(scanIdle(stateAfter(burst("9300675024235", 1000, 8)))).toBe("9300675024235");
    expect(scanIdle(stateAfter(burst("80001218", 1000, 8)))).toBe("80001218");
  });

  it("no suffix: typing, short bursts and non-barcodes are not scans", () => {
    expect(scanIdle(stateAfter(burst("9300675024235", 1000, SCAN_GAP_MS + 40)))).toBeNull();
    expect(scanIdle(stateAfter(burst("12345", 1000, 8)))).toBeNull();
    expect(scanIdle(stateAfter(burst("ABC12345", 1000, 8)))).toBeNull();
    expect(scanIdle(stateAfter(burst("00000000", 1000, 8)))).toBeNull();
    expect(scanIdle(EMPTY_SCAN)).toBeNull();
  });

  it("a suffix that turns up late after such a scan is recognised, and only then", () => {
    expect(isTrailingSuffix({ key: "Enter", timeMs: 2100 }, 2000)).toBe(true);
    expect(isTrailingSuffix({ key: "Tab", timeMs: 2100 }, 2000)).toBe(true);
    expect(isTrailingSuffix({ key: "Enter", timeMs: 2000 + TRAILING_SUFFIX_MS }, 2000)).toBe(false);
    expect(isTrailingSuffix({ key: "5", timeMs: 2100 }, 2000)).toBe(false);
    expect(isTrailingSuffix({ key: "Enter", timeMs: 2100 }, null)).toBe(false);
  });
});
