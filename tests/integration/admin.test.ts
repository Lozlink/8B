import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compareSync } from "bcryptjs";
import { bootHarness, MANAGER_PIN, STAFF_PIN, type Harness } from "./helpers/harness";
import {
  applyDevicePaired,
  createRateCard,
  createStaff,
  createTable,
  enrolDevice,
  getAdminState,
  needsFirstManager,
  revokeDevice,
  unpairTerminal,
  updateRateCard,
  updateSettings,
  updateStaff,
  updateTable,
} from "@/lib/server/admin";
import { withTx } from "@/lib/server/db";
import { startSession } from "@/lib/server/sessions";
import { at, audits } from "./helpers/util";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
});

const REASON = "Owner request";
const A = () => h.staff.managerActor;
const M = () => h.staff.manager;

interface CardRow {
  id: string;
  name: string;
  cents_per_hour: number;
  days_of_week: number[];
  start_local: string;
  end_local: string;
  active: boolean;
}
const cards = () =>
  h.sql<CardRow[]>`select id, name, cents_per_hour, days_of_week, start_local::text, end_local::text, active
                   from public.rate_cards order by created_at, name`;
const standardId = async () => (await cards())[0].id;
const entityAudits = async (entity: string, action: string) =>
  h.sql<{ entity_id: string | null; approved_by_staff_id: string | null; reason: string | null; before: unknown; after: unknown }[]>`
    select entity_id, approved_by_staff_id, reason, before, after from public.audit_log
    where entity = ${entity} and action = ${action} order by id`;

describe("admin module loads and reads state", () => {
  it("getAdminState returns tables, cards, settings, staff, devices", async () => {
    const s = await getAdminState(M());
    expect(s.tables).toHaveLength(7);
    expect(s.rateCards[0]).toMatchObject({ name: "Standard", centsPerHour: 2500, startLocal: "00:00", endLocal: "24:00", daysOfWeek: [1, 2, 3, 4, 5, 6, 7] });
    expect(s.settings).toMatchObject({ roundingMinutes: 5, businessDayStart: "06:00", terminalDeviceId: "DEVICE_TEST" });
    expect(s.staff.map((x) => x.name).sort()).toEqual(["Mia Manager", "Sam Staff"]);
    expect(s.squareEnvironment).toBe("sandbox");
  });
});

describe("tables", () => {
  it("createTable appends with the next sort order and audits with reason + approver", async () => {
    await createTable(A(), M(), " Table 8 ", REASON);
    const [t] = await h.sql<{ id: string; name: string; sort_order: number }[]>`select * from public.tables where name = 'Table 8'`;
    expect(t.sort_order).toBe(8);
    const [row] = await entityAudits("table", "table.create");
    expect(row).toMatchObject({ entity_id: t.id, approved_by_staff_id: M().id, reason: REASON });
    expect(row.after).toMatchObject({ name: "Table 8" });
  });

  it("rejects duplicate names (case-insensitive) and a missing reason", async () => {
    await expect(createTable(A(), M(), "table 1", REASON)).rejects.toMatchObject({ code: "23505", constraint_name: "tables_name_uniq" });
    await expect(createTable(A(), M(), "Table 9", "")).rejects.toMatchObject({ status: 400 });
  });

  it("updateTable renames/reorders; deactivation is blocked while occupied", async () => {
    await updateTable(A(), M(), h.tableId("Table 7"), { name: "Snooker", sortOrder: 20 }, REASON);
    const [t] = await h.sql<{ name: string; sort_order: number }[]>`select name, sort_order from public.tables where id = ${h.tableId("Table 7")}`;
    expect(t).toEqual({ name: "Snooker", sort_order: 20 });

    await startSession(h.staff.actor, h.tableId("Table 1"), at(0));
    await expect(updateTable(A(), M(), h.tableId("Table 1"), { active: false }, REASON)).rejects.toMatchObject({ status: 409 });
    expect((await h.sql<{ active: boolean }[]>`select active from public.tables where id = ${h.tableId("Table 1")}`)[0].active).toBe(true);

    await updateTable(A(), M(), h.tableId("Table 2"), { active: false }, REASON);
    expect((await h.sql<{ active: boolean }[]>`select active from public.tables where id = ${h.tableId("Table 2")}`)[0].active).toBe(false);
    // and an inactive table can't be started
    await expect(startSession(h.staff.actor, h.tableId("Table 2"), at(1))).rejects.toMatchObject({ status: 409 });
    const upd = await entityAudits("table", "table.update");
    expect(upd).toHaveLength(2);
    expect(upd[0].before).toMatchObject({ name: "Table 7" });
    expect(upd[0].after).toMatchObject({ name: "Snooker" });
  });

  it("unknown table is 404", async () => {
    await expect(updateTable(A(), M(), "00000000-0000-4000-8000-0000000000ff", { name: "x" }, REASON)).rejects.toMatchObject({ status: 404 });
  });
});

describe("rate cards", () => {
  const weekend = {
    name: "Weekend night",
    centsPerHour: 3000,
    daysOfWeek: [7, 5, 6, 5],
    startLocal: "18:00",
    endLocal: "00:00",
    priority: 1,
  };

  it("creates a card: days sorted+deduped, end 00:00 stored as 24:00", async () => {
    await createRateCard(A(), M(), weekend, REASON);
    const c = (await cards()).find((x) => x.name === "Weekend night");
    expect(c).toMatchObject({ cents_per_hour: 3000, start_local: "18:00:00", end_local: "24:00:00", active: true });
    expect(c?.days_of_week.map(Number)).toEqual([5, 6, 7]);
    const [row] = await entityAudits("rate_card", "rate_card.create");
    expect(row).toMatchObject({ approved_by_staff_id: M().id, reason: REASON });
  });

  it("an overnight window (22:00-02:00) is accepted as-is", async () => {
    await createRateCard(A(), M(), { ...weekend, name: "Late", startLocal: "22:00", endLocal: "02:00" }, REASON);
    const c = (await cards()).find((x) => x.name === "Late");
    expect(c).toMatchObject({ start_local: "22:00:00", end_local: "02:00:00" });
  });

  it("rejects invalid windows and inputs without writing", async () => {
    const before = (await cards()).length;
    await expect(createRateCard(A(), M(), { ...weekend, startLocal: "10:00", endLocal: "10:00" }, REASON)).rejects.toMatchObject({ status: 400 });
    await expect(createRateCard(A(), M(), { ...weekend, startLocal: "24:00" }, REASON)).rejects.toMatchObject({ status: 400 });
    await expect(createRateCard(A(), M(), { ...weekend, startLocal: "9am" }, REASON)).rejects.toMatchObject({ status: 400 });
    await expect(createRateCard(A(), M(), { ...weekend, daysOfWeek: [] }, REASON)).rejects.toBeDefined();
    await expect(createRateCard(A(), M(), { ...weekend, daysOfWeek: [8] }, REASON)).rejects.toBeDefined();
    await expect(createRateCard(A(), M(), { ...weekend, centsPerHour: -1 }, REASON)).rejects.toBeDefined();
    await expect(createRateCard(A(), M(), weekend, " ")).rejects.toMatchObject({ status: 400 });
    expect((await cards()).length).toBe(before);
  });

  it("updateRateCard changes fields, normalises end 00:00, and audits before/after", async () => {
    const id = await standardId();
    await updateRateCard(A(), M(), id, { centsPerHour: 2800, daysOfWeek: [3, 1, 2, 7, 6, 5, 4], endLocal: "00:00" }, REASON);
    const c = (await cards())[0];
    expect(c).toMatchObject({ cents_per_hour: 2800, end_local: "24:00:00" });
    expect(c.days_of_week.map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const [row] = await entityAudits("rate_card", "rate_card.update");
    expect(row.before).toMatchObject({ centsPerHour: 2500 });
    expect(row.after).toMatchObject({ centsPerHour: 2800 });
    await expect(updateRateCard(A(), M(), id, { startLocal: "12:00", endLocal: "12:00" }, REASON)).rejects.toMatchObject({ status: 400 });
    await expect(updateRateCard(A(), M(), "00000000-0000-4000-8000-0000000000ff", { name: "x" }, REASON)).rejects.toMatchObject({ status: 404 });
  });

  it("cannot deactivate the last active card, but can once another is active", async () => {
    const id = await standardId();
    await expect(updateRateCard(A(), M(), id, { active: false }, REASON)).rejects.toMatchObject({ status: 409 });
    expect((await cards())[0].active).toBe(true);

    await createRateCard(A(), M(), weekend, REASON);
    await updateRateCard(A(), M(), id, { active: false }, REASON);
    expect((await cards())[0].active).toBe(false);
    // now Weekend is the only active one
    const wk = (await cards()).find((x) => x.name === "Weekend night");
    await expect(updateRateCard(A(), M(), wk?.id ?? "", { active: false }, REASON)).rejects.toMatchObject({ status: 409 });
  });
});

describe("settings", () => {
  it("updates and audits; rejects bad values", async () => {
    await updateSettings(A(), M(), { roundingMinutes: 15, graceMinutes: 3, minimumMinutes: 60, businessDayStart: "05:30" }, REASON);
    const [s] = await h.sql<{ rounding_minutes: number; grace_minutes: number; minimum_minutes: number; bds: string; terminal_device_id: string }[]>`
      select rounding_minutes, grace_minutes, minimum_minutes, business_day_start::text as bds, terminal_device_id from public.settings`;
    expect(s).toEqual({ rounding_minutes: 15, grace_minutes: 3, minimum_minutes: 60, bds: "05:30:00", terminal_device_id: "DEVICE_TEST" });
    const [row] = await entityAudits("settings", "settings.update");
    expect(row.before).toMatchObject({ roundingMinutes: 5, graceMinutes: 0, minimumMinutes: 30 });
    expect(row.after).toMatchObject({ roundingMinutes: 15, businessDayStart: "05:30" });
    expect(row.reason).toBe(REASON);

    await expect(updateSettings(A(), M(), { roundingMinutes: 5, graceMinutes: 0, minimumMinutes: 30, businessDayStart: "24:00" }, REASON)).rejects.toMatchObject({ status: 400 });
    await expect(updateSettings(A(), M(), { roundingMinutes: 5, graceMinutes: 0, minimumMinutes: 30, businessDayStart: "soon" }, REASON)).rejects.toMatchObject({ status: 400 });
    await expect(updateSettings(A(), M(), { roundingMinutes: 0, graceMinutes: 0, minimumMinutes: 30, businessDayStart: "06:00" }, REASON)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("staff", () => {
  it("createStaff hashes the PIN, never stores it, and audits without the hash", async () => {
    await createStaff(A(), M(), { name: "Noor", role: "staff", pin: "3333" }, REASON);
    const [r] = await h.sql<{ id: string; pin_hash: string; role: string }[]>`select id, pin_hash, role from public.staff where name = 'Noor'`;
    expect(r.role).toBe("staff");
    expect(r.pin_hash).not.toContain("3333");
    expect(compareSync("3333", r.pin_hash)).toBe(true);
    const [row] = await entityAudits("staff", "staff.create");
    expect(JSON.stringify(row.after)).not.toMatch(/pin|\$2/);
    expect(row.entity_id).toBe(r.id);
  });

  it("PIN must be unique among ACTIVE staff", async () => {
    await expect(createStaff(A(), M(), { name: "Dup", role: "staff", pin: STAFF_PIN }, REASON)).rejects.toMatchObject({ status: 400 });
    await expect(createStaff(A(), M(), { name: "Dup2", role: "staff", pin: MANAGER_PIN }, REASON)).rejects.toMatchObject({ status: 400 });
    expect(await h.sql`select 1 from public.staff where name like 'Dup%'`).toHaveLength(0);

    // once Sam is deactivated, the PIN is free again
    await updateStaff(A(), M(), h.staff.actor.staffId, { active: false }, REASON);
    await createStaff(A(), M(), { name: "Sam Two", role: "staff", pin: STAFF_PIN }, REASON);
  });

  it("bad PINs and duplicate active names are rejected", async () => {
    await expect(createStaff(A(), M(), { name: "Bad", role: "staff", pin: "12" }, REASON)).rejects.toBeDefined();
    await expect(createStaff(A(), M(), { name: "sam staff", role: "staff", pin: "7777" }, REASON)).rejects.toMatchObject({ code: "23505" });
  });

  it("updateStaff: rename, change PIN (uniqueness enforced), audit flags the PIN change", async () => {
    const id = h.staff.actor.staffId;
    await expect(updateStaff(A(), M(), id, { pin: MANAGER_PIN }, REASON)).rejects.toMatchObject({ status: 400 });
    await updateStaff(A(), M(), id, { name: "Samantha", pin: "8888" }, REASON);
    const [r] = await h.sql<{ name: string; pin_hash: string }[]>`select name, pin_hash from public.staff where id = ${id}`;
    expect(r.name).toBe("Samantha");
    expect(compareSync("8888", r.pin_hash)).toBe(true);
    // keeping your own PIN is not a clash
    await updateStaff(A(), M(), id, { pin: "8888" }, REASON);
    const rows = await entityAudits("staff", "staff.update");
    expect(rows[0].after).toMatchObject({ pin_changed: true, name: "Samantha" });
    expect(JSON.stringify(rows)).not.toMatch(/\$2[aby]\$/);
  });

  it("cannot demote or deactivate the last manager", async () => {
    const mid = M().id;
    await expect(updateStaff(A(), M(), mid, { role: "staff" }, REASON)).rejects.toMatchObject({ status: 409 });
    await expect(updateStaff(A(), M(), mid, { active: false }, REASON)).rejects.toMatchObject({ status: 409 });
    await createStaff(A(), M(), { name: "Second Boss", role: "manager", pin: "9999" }, REASON);
    await updateStaff(A(), M(), mid, { role: "staff" }, REASON);
    const [r] = await h.sql<{ role: string }[]>`select role from public.staff where id = ${mid}`;
    expect(r.role).toBe("staff");
    // the remaining manager is now protected
    const [second] = await h.sql<{ id: string }[]>`select id from public.staff where name = 'Second Boss'`;
    await expect(updateStaff(A(), M(), second.id, { active: false }, REASON)).rejects.toMatchObject({ status: 409 });
  });

  it("unknown staff is 404", async () => {
    await expect(updateStaff(A(), M(), "00000000-0000-4000-8000-0000000000ff", { name: "x" }, REASON)).rejects.toMatchObject({ status: 404 });
  });
});

describe("devices", () => {
  async function noManagers() {
    await h.sql`update public.staff set active = false`;
  }

  it("first run requires a first manager and creates it with the device", async () => {
    await noManagers();
    expect(await needsFirstManager()).toBe(true);
    await expect(enrolDevice("Counter", undefined)).rejects.toMatchObject({ status: 400 });
    expect(await h.sql`select 1 from public.devices`).toHaveLength(0); // rolled back

    const d = await enrolDevice(" Counter ", { name: "Owner", pin: "4444" });
    expect(d.label).toBe("Counter");
    expect(await needsFirstManager()).toBe(false);
    const [m] = await h.sql<{ role: string; active: boolean; pin_hash: string }[]>`select role, active, pin_hash from public.staff where name = 'Owner'`;
    expect(m).toMatchObject({ role: "manager", active: true });
    expect(compareSync("4444", m.pin_hash)).toBe(true);
    const acts = (await h.sql<{ action: string }[]>`select action from public.audit_log order by id`).map((r) => r.action);
    expect(acts).toEqual(["device.enrol", "staff.create_first_manager"]);
  });

  it("second run enrols the device without creating another manager (even if one is supplied)", async () => {
    await noManagers();
    await enrolDevice("Counter", { name: "Owner", pin: "4444" });
    await enrolDevice("Floor 1", { name: "Intruder", pin: "5555" });
    await enrolDevice("Floor 2", undefined);
    expect(await h.sql`select 1 from public.staff where name = 'Intruder'`).toHaveLength(0);
    expect(await h.sql`select 1 from public.devices`).toHaveLength(3);
  });

  it("revokeDevice stamps revoked_at/by once and audits once", async () => {
    const d = await enrolDevice("Floor 1", undefined);
    await revokeDevice(A(), M(), d.id, REASON);
    await revokeDevice(A(), M(), d.id, REASON); // already revoked: no-op
    const [r] = await h.sql<{ revoked_at: Date | null; revoked_by: string | null }[]>`select revoked_at, revoked_by from public.devices where id = ${d.id}`;
    expect(r.revoked_at).toBeInstanceOf(Date);
    expect(r.revoked_by).toBe(M().id);
    expect(await audits(h, d.id, "device.revoke")).toHaveLength(1);
    await expect(revokeDevice(A(), M(), "00000000-0000-4000-8000-0000000000ff", REASON)).rejects.toMatchObject({ status: 404 });
    await expect(revokeDevice(A(), M(), d.id, "")).rejects.toMatchObject({ status: 400 });
  });
});

describe("terminal pairing", () => {
  const paired = (over: Partial<Parameters<typeof applyDevicePaired>[1]> = {}) => ({
    id: "dc_1",
    status: "PAIRED",
    deviceId: "DEV_NEW",
    locationId: "LOC_TEST",
    productType: "TERMINAL_API",
    ...over,
  });
  const run = (dc: Parameters<typeof applyDevicePaired>[1]) => withTx((tx) => applyDevicePaired(tx, dc));
  const deviceId = async () => (await h.sql<{ t: string | null }[]>`select terminal_device_id as t from public.settings`)[0].t;

  it("saves a PAIRED code for our location and audits it as a system action", async () => {
    expect(process.env.SQUARE_LOCATION_ID).toBe("LOC_TEST");
    expect(await run(paired())).toBe("applied");
    expect(await deviceId()).toBe("DEV_NEW");
    const [row] = await entityAudits("terminal", "terminal.paired");
    expect(row.entity_id).toBe("DEV_NEW");
    expect(row.before).toEqual({ terminal_device_id: "DEVICE_TEST" });
    expect(row.after).toEqual({ terminal_device_id: "DEV_NEW", via: "square_webhook" });
    // idempotent: same device again writes nothing new
    expect(await run(paired())).toBe("applied");
    expect(await entityAudits("terminal", "terminal.paired")).toHaveLength(1);
  });

  it("ignores wrong location, non-PAIRED, no device and non-Terminal product codes", async () => {
    expect(await run(paired({ locationId: "OTHER" }))).toBe("ignored");
    expect(await run(paired({ status: "UNPAIRED" }))).toBe("ignored");
    expect(await run(paired({ status: "PENDING" }))).toBe("ignored");
    expect(await run(paired({ deviceId: null }))).toBe("ignored");
    expect(await run(paired({ productType: "SQUARE_POS" }))).toBe("ignored");
    expect(await deviceId()).toBe("DEVICE_TEST");
    expect(await entityAudits("terminal", "terminal.paired")).toHaveLength(0);
  });

  it("a code without a location or product type is accepted", async () => {
    expect(await run(paired({ locationId: null, productType: undefined }))).toBe("applied");
    expect(await deviceId()).toBe("DEV_NEW");
  });

  it("unpairTerminal clears the device with a reason", async () => {
    await unpairTerminal(A(), M(), REASON);
    expect(await deviceId()).toBeNull();
    const [row] = await entityAudits("terminal", "terminal.unpaired");
    expect(row).toMatchObject({ entity_id: "DEVICE_TEST", approved_by_staff_id: M().id, reason: REASON });
  });
});
