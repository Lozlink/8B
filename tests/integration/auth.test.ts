import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, MANAGER_PIN, STAFF_PIN, type Harness } from "./helpers/harness";

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  const hdrs = new Map<string, string>();
  return {
    store,
    hdrs,
    jar: {
      get: (name: string) => (store.has(name) ? { name, value: store.get(name) as string } : undefined),
      has: (name: string) => store.has(name),
      set: (name: string, value: string) => void store.set(name, value),
      delete: (name: string) => void store.delete(name),
    },
    headerBag: { get: (name: string) => hdrs.get(name.toLowerCase()) ?? null },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => mocks.jar,
  headers: async () => mocks.headerBag,
}));

import {
  assertPinUnique,
  checkEnrolCode,
  currentActor,
  currentDevice,
  elevate,
  hashPin,
  login,
  logout,
  requireElevation,
  setDeviceCookie,
  verifyManagerPin,
  type Actor,
} from "@/lib/server/auth";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});

let deviceA: { id: string; label: string };
let deviceB: { id: string; label: string };

async function newDevice(label: string): Promise<{ id: string; label: string }> {
  const [d] = await h.sql<{ id: string; label: string }[]>`insert into public.devices (label) values (${label}) returning id, label`;
  return d;
}

beforeEach(async () => {
  await h.reset();
  mocks.store.clear();
  mocks.hdrs.clear();
  mocks.hdrs.set("x-forwarded-for", "203.0.113.7, 10.0.0.1");
  // Seed real bcrypt hashes through the app's own hashPin.
  await h.sql`update public.staff set pin_hash = ${await hashPin(STAFF_PIN)} where id = ${h.staff.actor.staffId}`;
  await h.sql`update public.staff set pin_hash = ${await hashPin(MANAGER_PIN)} where id = ${h.staff.manager.id}`;
  deviceA = await newDevice("Counter");
  deviceB = await newDevice("Floor 1");
  await setDeviceCookie(deviceA.id, deviceA.label);
});

const attempts = (kind: string) =>
  h.sql<{ success: boolean; ip: string | null; staff_id: string | null; device_id: string | null }[]>`
    select success, ip, staff_id, device_id from public.login_attempts where kind = ${kind} order by id`;

const staffId = () => h.staff.actor.staffId;

async function wrongLogins(n: number, id = staffId()): Promise<void> {
  for (let i = 0; i < n; i++) {
    await expect(login(id, "9999")).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
  }
}

describe("checkEnrolCode", () => {
  const code = () => process.env.DEVICE_ENROL_CODE as string;

  it("correct code passes (trimmed) and is recorded as a success", async () => {
    await expect(checkEnrolCode(`  ${code()}  `)).resolves.toBeUndefined();
    expect(await attempts("enrol")).toEqual([{ success: true, ip: "203.0.113.7", staff_id: null, device_id: null }]);
  });

  it("wrong code is 403 and recorded against the first forwarded IP", async () => {
    await expect(checkEnrolCode("nope-nope-nope")).rejects.toMatchObject({ status: 403 });
    expect(await attempts("enrol")).toEqual([{ success: false, ip: "203.0.113.7", staff_id: null, device_id: null }]);
  });

  it("10 wrong attempts from one IP lock it out with 429, even for the right code", async () => {
    for (let i = 0; i < 10; i++) await expect(checkEnrolCode("wrong-code-here")).rejects.toMatchObject({ status: 403 });
    await expect(checkEnrolCode("wrong-code-here")).rejects.toMatchObject({ status: 429, code: "too_many_attempts" });
    await expect(checkEnrolCode(code())).rejects.toMatchObject({ status: 429 });
    // another IP is unaffected
    mocks.hdrs.set("x-forwarded-for", "198.51.100.9");
    await expect(checkEnrolCode(code())).resolves.toBeUndefined();
  });

  it("falls back to x-real-ip, and works without any IP (no throttle key)", async () => {
    mocks.hdrs.clear();
    mocks.hdrs.set("x-real-ip", "192.0.2.5");
    await expect(checkEnrolCode("wrong-code-here")).rejects.toMatchObject({ status: 403 });
    expect((await attempts("enrol"))[0].ip).toBe("192.0.2.5");
    mocks.hdrs.clear();
    await expect(checkEnrolCode(code())).resolves.toBeUndefined();
  });
});

describe("login", () => {
  it("correct PIN sets the session cookie and returns the Actor", async () => {
    const a = await login(staffId(), STAFF_PIN);
    expect(a).toEqual({ staffId: staffId(), name: "Sam Staff", role: "staff", deviceId: deviceA.id, deviceLabel: "Counter" });
    expect(mocks.store.get("tt_session")).toBeTruthy();
    expect(await currentActor()).toEqual(a);
    const [d] = await h.sql<{ last_seen_at: Date | null }[]>`select last_seen_at from public.devices where id = ${deviceA.id}`;
    expect(d.last_seen_at).toBeInstanceOf(Date);
    expect(await attempts("login")).toEqual([{ success: true, ip: null, staff_id: staffId(), device_id: deviceA.id }]);
  });

  it("wrong PIN is 401 invalid_credentials (not 'unauthorized') and sets no cookie", async () => {
    await expect(login(staffId(), "9999")).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
    expect(mocks.store.has("tt_session")).toBe(false);
    expect((await attempts("login"))[0].success).toBe(false);
  });

  it("unknown or deactivated staff look the same as a wrong PIN", async () => {
    await expect(login("00000000-0000-4000-8000-0000000000ff", STAFF_PIN)).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
    await h.sql`update public.staff set active = false where id = ${staffId()}`;
    await expect(login(staffId(), STAFF_PIN)).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
  });

  it("malformed PIN is a 400 before any attempt is recorded", async () => {
    await expect(login(staffId(), "12")).rejects.toMatchObject({ status: 400 });
    await expect(login(staffId(), "abcd")).rejects.toMatchObject({ status: 400 });
    expect(await attempts("login")).toHaveLength(0);
  });

  it("5 wrong PINs for one person in 15 min = 429, even with the right PIN; others can still log in", async () => {
    await wrongLogins(5);
    await expect(login(staffId(), STAFF_PIN)).rejects.toMatchObject({ status: 429, code: "too_many_attempts" });
    expect(mocks.store.has("tt_session")).toBe(false);
    const a = await login(h.staff.manager.id, MANAGER_PIN);
    expect(a.role).toBe("manager");
  });

  it("15 wrong attempts on one device lock the device (429)", async () => {
    for (let i = 0; i < 15; i++) {
      await expect(login("00000000-0000-4000-8000-0000000000ff", "9999")).rejects.toMatchObject({ code: "invalid_credentials" });
    }
    await expect(login(staffId(), STAFF_PIN)).rejects.toMatchObject({ status: 429 });
    // a different enrolled device is not locked
    mocks.store.clear();
    await setDeviceCookie(deviceB.id, deviceB.label);
    await expect(login(staffId(), STAFF_PIN)).resolves.toMatchObject({ deviceId: deviceB.id });
  });

  it("no device cookie -> 401 device_not_enrolled", async () => {
    mocks.store.delete("tt_device");
    await expect(login(staffId(), STAFF_PIN)).rejects.toMatchObject({ status: 401, code: "device_not_enrolled" });
  });

  it("revoked device -> device_not_enrolled, and an existing session stops working", async () => {
    await login(staffId(), STAFF_PIN);
    await h.sql`update public.devices set revoked_at = now() where id = ${deviceA.id}`;
    expect(await currentDevice()).toBeNull();
    expect(await currentActor()).toBeNull();
    await expect(login(staffId(), STAFF_PIN)).rejects.toMatchObject({ status: 401, code: "device_not_enrolled" });
  });

  it("a garbage / foreign-signed device cookie is not an enrolment", async () => {
    mocks.store.set("tt_device", "abc.def.ghi");
    expect(await currentDevice()).toBeNull();
    await expect(login(staffId(), STAFF_PIN)).rejects.toMatchObject({ code: "device_not_enrolled" });
  });
});

describe("currentActor", () => {
  it("is null with no session, after logout, and for a deactivated person", async () => {
    expect(await currentActor()).toBeNull();
    await login(staffId(), STAFF_PIN);
    expect(await currentActor()).not.toBeNull();
    await h.sql`update public.staff set active = false where id = ${staffId()}`;
    expect(await currentActor()).toBeNull();
    await h.sql`update public.staff set active = true where id = ${staffId()}`;
    await logout();
    expect(await currentActor()).toBeNull();
  });

  it("is null when the session was issued for a different device than the device cookie", async () => {
    await login(staffId(), STAFF_PIN); // session bound to device A
    expect(await currentActor()).not.toBeNull();
    await setDeviceCookie(deviceB.id, deviceB.label); // copy the session cookie onto device B
    expect(await currentActor()).toBeNull();
  });

  it("a session token can't be used as a device token (audience separation)", async () => {
    await login(staffId(), STAFF_PIN);
    mocks.store.set("tt_device", mocks.store.get("tt_session") as string);
    expect(await currentDevice()).toBeNull();
  });
});

describe("the staff session lasts a fixed 20 hours from login", () => {
  const HOUR = 60 * 60 * 1000;
  const start = new Date("2026-11-20T10:00:00+11:00");

  it("is still good after 19 hours of use, is never re-issued, and ends at 20 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      await login(h.staff.actor.staffId, STAFF_PIN);
      const first = mocks.store.get("tt_session");

      for (const hours of [2, 14.5, 19.9]) {
        vi.setSystemTime(new Date(start.getTime() + hours * HOUR));
        expect(await currentActor()).toMatchObject({ staffId: h.staff.actor.staffId });
        // Using it doesn't extend it.
        expect(mocks.store.get("tt_session")).toBe(first);
      }

      vi.setSystemTime(new Date(start.getTime() + 20.1 * HOUR));
      expect(await currentActor()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("manager elevation stays at 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      const actor = await login(h.staff.actor.staffId, STAFF_PIN);
      await elevate(actor, MANAGER_PIN);
      vi.setSystemTime(new Date(start.getTime() + 9 * 60 * 1000));
      await expect(requireElevation(actor)).resolves.toMatchObject({ id: h.staff.manager.id });
      vi.setSystemTime(new Date(start.getTime() + 11 * 60 * 1000));
      await expect(requireElevation(actor)).rejects.toMatchObject({ status: 403, code: "manager_required" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manager step-up", () => {
  async function staffActor(): Promise<Actor> {
    return login(staffId(), STAFF_PIN);
  }

  it("a staff PIN is rejected with 403; the manager PIN is accepted", async () => {
    const actor = await staffActor();
    await expect(verifyManagerPin(actor, STAFF_PIN)).rejects.toMatchObject({ status: 403 });
    await expect(verifyManagerPin(actor, MANAGER_PIN)).resolves.toEqual({ id: h.staff.manager.id, name: "Mia Manager" });
    const rows = await attempts("manager");
    expect(rows.map((r) => r.success)).toEqual([false, true]);
    expect(rows[1].staff_id).toBe(h.staff.manager.id);
  });

  it("5 wrong manager PINs on a device = 429 even for the right PIN", async () => {
    const actor = await staffActor();
    for (let i = 0; i < 5; i++) await expect(verifyManagerPin(actor, "9999")).rejects.toMatchObject({ status: 403 });
    await expect(verifyManagerPin(actor, MANAGER_PIN)).rejects.toMatchObject({ status: 429 });
  });

  it("a deactivated manager's PIN stops working", async () => {
    const actor = await staffActor();
    await h.sql`update public.staff set active = false where id = ${h.staff.manager.id}`;
    await expect(verifyManagerPin(actor, MANAGER_PIN)).rejects.toMatchObject({ status: 403 });
  });

  it("elevate unlocks requireElevation for the same staff + device", async () => {
    const actor = await staffActor();
    await expect(requireElevation(actor)).rejects.toMatchObject({ status: 403, code: "manager_required" });
    const m = await elevate(actor, MANAGER_PIN);
    expect(m.id).toBe(h.staff.manager.id);
    expect(mocks.store.has("tt_mgr")).toBe(true);
    await expect(requireElevation(actor)).resolves.toEqual(m);
  });

  it("an elevation cookie minted for another device or another staff member is rejected", async () => {
    const actor = await staffActor();
    await elevate(actor, MANAGER_PIN);
    await expect(requireElevation({ ...actor, deviceId: deviceB.id })).rejects.toMatchObject({ code: "manager_required" });
    await expect(requireElevation({ ...actor, staffId: h.staff.manager.id })).rejects.toMatchObject({ code: "manager_required" });
    await expect(requireElevation(actor)).resolves.toBeDefined();
  });

  it("elevation dies when the manager is deactivated, and logging in again clears it", async () => {
    const actor = await staffActor();
    await elevate(actor, MANAGER_PIN);
    await login(staffId(), STAFF_PIN);
    expect(mocks.store.has("tt_mgr")).toBe(false);
    await elevate(actor, MANAGER_PIN);
    await h.sql`update public.staff set role = 'staff' where id = ${h.staff.manager.id}`;
    await expect(requireElevation(actor)).rejects.toMatchObject({ code: "manager_required" });
  });
});

describe("logout", () => {
  it("clears tt_session and tt_mgr but keeps the device cookie", async () => {
    const actor = await login(staffId(), STAFF_PIN);
    await elevate(actor, MANAGER_PIN);
    expect(mocks.store.has("tt_session") && mocks.store.has("tt_mgr")).toBe(true);
    await logout();
    expect(mocks.store.has("tt_session")).toBe(false);
    expect(mocks.store.has("tt_mgr")).toBe(false);
    expect(mocks.store.has("tt_device")).toBe(true);
    expect(await currentActor()).toBeNull();
  });
});

describe("assertPinUnique", () => {
  it("rejects a PIN used by another active staff member", async () => {
    await expect(assertPinUnique(h.sql, STAFF_PIN, null)).rejects.toMatchObject({ status: 400 });
    await expect(assertPinUnique(h.sql, MANAGER_PIN, staffId())).rejects.toMatchObject({ status: 400 });
  });

  it("allows an unused PIN, your own PIN, and a PIN of someone now inactive", async () => {
    await expect(assertPinUnique(h.sql, "5150", null)).resolves.toBeUndefined();
    await expect(assertPinUnique(h.sql, STAFF_PIN, staffId())).resolves.toBeUndefined();
    await h.sql`update public.staff set active = false where id = ${staffId()}`;
    await expect(assertPinUnique(h.sql, STAFF_PIN, null)).resolves.toBeUndefined();
  });
});
