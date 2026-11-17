import "server-only";
import { formatLocalTime, parseLocalTime, price, type PricingRateCard } from "@/lib/pricing";
import type { AdminStateDTO, PairingCodeDTO, StaffRole } from "@/lib/domain/types";
import * as squareTerminal from "@/lib/square/terminal";
import { randomUUID } from "node:crypto";
import { assertPinUnique, hashPin, type Actor, type Manager } from "./auth";
import { audit } from "./audit";
import { db, withTx, type Tx } from "./db";
import { squareEnv, squareEnvironmentOrNull } from "./env";
import { badRequest, conflict, notFound } from "./errors";
import { getCatalogState, getProducts, getSettings, mapRateCard, type RateCardRow } from "./repo";
import { getCashOutstanding } from "./square-cash";

const by = (a: Actor, m: Manager) => ({ actorStaffId: a.staffId, approvedByStaffId: m.id, deviceLabel: a.deviceLabel });

function reasonOf(r: string): string {
  const t = r.trim();
  if (t.length < 3) throw badRequest("A reason is required.");
  return t.slice(0, 500);
}

const hhmm = (t: string) => formatLocalTime(parseLocalTime(t));

// postgres.js v4: arrays are passed as plain JS arrays and cast in SQL (sql.array() was removed).
const sortedDays = (days: number[]) => [...new Set(days)].sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function getAdminState(manager: Manager): Promise<AdminStateDTO> {
  const q = db();
  const [tables, rateCards, settings, staff, devices, products, catalog, squareCash] = await Promise.all([
    q<{ id: string; name: string; sort_order: number; active: boolean }[]>`
      select id, name, sort_order, active from public.tables order by sort_order, name`,
    q<RateCardRow[]>`
      select id, name, cents_per_hour, days_of_week, start_local::text as start_local,
             end_local::text as end_local, priority, active
      from public.rate_cards order by active desc, priority desc, name`,
    getSettings(q),
    q<{ id: string; name: string; role: StaffRole; active: boolean }[]>`
      select id, name, role, active from public.staff order by active desc, name`,
    q<{ id: string; label: string; enrolled_at: Date; last_seen_at: Date | null; revoked_at: Date | null }[]>`
      select id, label, enrolled_at, last_seen_at, revoked_at from public.devices order by revoked_at nulls first, label`,
    getProducts(q, { activeOnly: false }),
    getCatalogState(q),
    getCashOutstanding(q),
  ]);
  return {
    manager,
    catalog: {
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        priceCents: p.price_cents,
        taxed: p.taxed,
        category: p.category,
        active: p.active,
      })),
      syncedAt: catalog.synced_at?.toISOString() ?? null,
      tableHireLinked: !!catalog.table_hire_variation_id,
      lastError: catalog.last_error,
    },
    squareCash,
    tables: tables.map((t) => ({ id: t.id, name: t.name, sortOrder: t.sort_order, active: t.active })),
    rateCards: rateCards.map((r) => ({
      id: r.id,
      name: r.name,
      centsPerHour: r.cents_per_hour,
      daysOfWeek: r.days_of_week.map(Number),
      startLocal: hhmm(r.start_local),
      endLocal: hhmm(r.end_local),
      priority: r.priority,
      active: r.active,
    })),
    settings: {
      roundingMinutes: settings.roundingMinutes,
      graceMinutes: settings.graceMinutes,
      minimumMinutes: settings.minimumMinutes,
      timezone: settings.timezone,
      businessDayStart: formatLocalTime(settings.businessDayStartMinute),
      terminalDeviceId: settings.terminalDeviceId,
      itemiseCharges: settings.itemiseCharges,
    },
    staff,
    devices: devices.map((d) => ({
      id: d.id,
      label: d.label,
      enrolledAt: d.enrolled_at.toISOString(),
      lastSeenAt: d.last_seen_at?.toISOString() ?? null,
      revokedAt: d.revoked_at?.toISOString() ?? null,
    })),
    squareEnvironment: squareEnvironmentOrNull(),
  };
}

// ---------------------------------------------------------------------------
// Tables (never deleted — deactivate instead)
// ---------------------------------------------------------------------------

export async function createTable(actor: Actor, m: Manager, name: string, reason: string): Promise<void> {
  const r = reasonOf(reason);
  await withTx(async (tx) => {
    const [row] = await tx<{ id: string; name: string; sort_order: number }[]>`
      insert into public.tables (name, sort_order)
      values (${name.trim()}, coalesce((select max(sort_order) + 1 from public.tables), 1))
      returning id, name, sort_order`;
    await audit(tx, { ...by(actor, m), action: "table.create", entity: "table", entityId: row.id, after: row, reason: r });
  });
}

export async function updateTable(
  actor: Actor,
  m: Manager,
  id: string,
  patch: { name?: string; sortOrder?: number; active?: boolean },
  reason: string,
): Promise<void> {
  const r = reasonOf(reason);
  await withTx(async (tx) => {
    const [before] = await tx<{ id: string; name: string; sort_order: number; active: boolean }[]>`
      select id, name, sort_order, active from public.tables where id = ${id} for update`;
    if (!before) throw notFound("Table not found.");
    if (patch.active === false) {
      const [busy] = await tx`select 1 from public.sessions where current_table_id = ${id}`;
      if (busy) throw conflict(`${before.name} has a session on it. Finish or move it first.`);
    }
    const [after] = await tx<typeof before[]>`
      update public.tables set
        name = ${patch.name?.trim() ?? before.name},
        sort_order = ${patch.sortOrder ?? before.sort_order},
        active = ${patch.active ?? before.active}
      where id = ${id}
      returning id, name, sort_order, active`;
    await audit(tx, { ...by(actor, m), action: "table.update", entity: "table", entityId: id, before, after, reason: r });
  });
}

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------

export interface RateCardInput {
  name: string;
  centsPerHour: number;
  daysOfWeek: number[];
  startLocal: string;
  endLocal: string;
  priority: number;
  active?: boolean;
}

/** Runs the card through the pricing engine's own validation so the DB never holds a card it can't price. */
function validateCardInput(c: RateCardInput): void {
  let card: PricingRateCard;
  try {
    card = {
      id: "validate",
      name: c.name,
      centsPerHour: c.centsPerHour,
      daysOfWeek: c.daysOfWeek,
      startMinute: parseLocalTime(c.startLocal),
      endMinute: parseLocalTime(c.endLocal),
      priority: c.priority,
      active: true,
    };
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "Invalid time.");
  }
  if (card.startMinute >= 1440) throw badRequest("Start time must be before 24:00.");
  if (card.endMinute === 0) card.endMinute = 1440;
  try {
    price({
      intervals: [],
      rateCards: [card],
      settings: { roundingMinutes: 1, graceMinutes: 0, minimumMinutes: 0, timezone: "UTC" },
      now: 0,
    });
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "Invalid rate card.");
  }
}

const normEnd = (t: string) => (parseLocalTime(t) === 0 ? "24:00" : hhmm(t));

export async function createRateCard(actor: Actor, m: Manager, c: RateCardInput, reason: string): Promise<void> {
  const r = reasonOf(reason);
  validateCardInput(c);
  await withTx(async (tx) => {
    const [row] = await tx<RateCardRow[]>`
      insert into public.rate_cards (name, cents_per_hour, days_of_week, start_local, end_local, priority, active)
      values (${c.name.trim()}, ${c.centsPerHour}, ${sortedDays(c.daysOfWeek)}::smallint[],
              ${hhmm(c.startLocal)}::time, ${normEnd(c.endLocal)}::time, ${c.priority}, ${c.active ?? true})
      returning id, name, cents_per_hour, days_of_week, start_local::text as start_local,
                end_local::text as end_local, priority, active`;
    await audit(tx, {
      ...by(actor, m),
      action: "rate_card.create",
      entity: "rate_card",
      entityId: row.id,
      after: mapRateCard(row),
      reason: r,
    });
  });
}

export async function updateRateCard(
  actor: Actor,
  m: Manager,
  id: string,
  patch: Partial<RateCardInput>,
  reason: string,
): Promise<void> {
  const r = reasonOf(reason);
  await withTx(async (tx) => {
    const [row] = await tx<RateCardRow[]>`
      select id, name, cents_per_hour, days_of_week, start_local::text as start_local,
             end_local::text as end_local, priority, active
      from public.rate_cards where id = ${id} for update`;
    if (!row) throw notFound("Rate card not found.");
    const before = mapRateCard(row);
    const next: RateCardInput = {
      name: patch.name ?? row.name,
      centsPerHour: patch.centsPerHour ?? row.cents_per_hour,
      daysOfWeek: patch.daysOfWeek ?? row.days_of_week.map(Number),
      startLocal: patch.startLocal ?? hhmm(row.start_local),
      endLocal: patch.endLocal ?? normEnd(row.end_local),
      priority: patch.priority ?? row.priority,
      active: patch.active ?? row.active,
    };
    validateCardInput(next);
    if (next.active === false) {
      const [other] = await tx`select 1 from public.rate_cards where active and id <> ${id} limit 1`;
      if (!other) throw conflict("At least one rate card must stay active.");
    }
    const [updated] = await tx<RateCardRow[]>`
      update public.rate_cards set
        name = ${next.name.trim()}, cents_per_hour = ${next.centsPerHour},
        days_of_week = ${sortedDays(next.daysOfWeek)}::smallint[],
        start_local = ${hhmm(next.startLocal)}::time, end_local = ${normEnd(next.endLocal)}::time,
        priority = ${next.priority}, active = ${next.active ?? true}
      where id = ${id}
      returning id, name, cents_per_hour, days_of_week, start_local::text as start_local,
                end_local::text as end_local, priority, active`;
    await audit(tx, {
      ...by(actor, m),
      action: "rate_card.update",
      entity: "rate_card",
      entityId: id,
      before,
      after: mapRateCard(updated),
      reason: r,
    });
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function updateSettings(
  actor: Actor,
  m: Manager,
  s: { roundingMinutes: number; graceMinutes: number; minimumMinutes: number; businessDayStart: string },
  reason: string,
): Promise<void> {
  const r = reasonOf(reason);
  let bds: number;
  try {
    bds = parseLocalTime(s.businessDayStart);
  } catch {
    throw badRequest("Business day start must be HH:MM.");
  }
  if (bds >= 1440) throw badRequest("Business day start must be before 24:00.");
  await withTx(async (tx) => {
    const before = await getSettings(tx);
    await tx`
      update public.settings set
        rounding_minutes = ${s.roundingMinutes}, grace_minutes = ${s.graceMinutes},
        minimum_minutes = ${s.minimumMinutes}, business_day_start = ${formatLocalTime(bds)}::time
      where id`;
    await audit(tx, {
      ...by(actor, m),
      action: "settings.update",
      entity: "settings",
      entityId: null,
      before: { ...before, terminalDeviceId: undefined },
      after: s,
      reason: r,
    });
  });
}

/**
 * Manager switch for itemised Square charges. Off = every charge goes to the Terminal as a single
 * amount, which is the fallback if itemised checkouts misbehave.
 */
export async function setItemiseCharges(actor: Actor, m: Manager, enabled: boolean, reason: string): Promise<void> {
  const r = reasonOf(reason);
  await withTx(async (tx) => {
    const [before] = await tx<{ itemise_charges: boolean }[]>`
      select itemise_charges from public.settings where id for update`;
    if (!before) throw new Error("settings row missing — run the reference-data migration");
    if (before.itemise_charges === enabled) return;
    await tx`update public.settings set itemise_charges = ${enabled} where id`;
    await audit(tx, {
      ...by(actor, m),
      action: "settings.itemise_charges",
      entity: "settings",
      entityId: null,
      before: { itemise_charges: before.itemise_charges },
      after: { itemise_charges: enabled },
      reason: r,
    });
  });
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

async function assertAnotherManagerRemains(tx: Tx, exceptId: string): Promise<void> {
  const [row] = await tx`
    select 1 from public.staff where active and role = 'manager' and id <> ${exceptId} limit 1`;
  if (!row) throw conflict("There must always be at least one active manager.");
}

export async function createStaff(
  actor: Actor,
  m: Manager,
  input: { name: string; role: StaffRole; pin: string },
  reason: string,
): Promise<void> {
  const r = reasonOf(reason);
  const pinHash = await hashPin(input.pin);
  await withTx(async (tx) => {
    await assertPinUnique(tx, input.pin, null);
    const [row] = await tx<{ id: string; name: string; role: StaffRole }[]>`
      insert into public.staff (name, role, pin_hash) values (${input.name.trim()}, ${input.role}, ${pinHash})
      returning id, name, role`;
    await audit(tx, { ...by(actor, m), action: "staff.create", entity: "staff", entityId: row.id, after: row, reason: r });
  });
}

export async function updateStaff(
  actor: Actor,
  m: Manager,
  id: string,
  patch: { name?: string; role?: StaffRole; active?: boolean; pin?: string },
  reason: string,
): Promise<void> {
  const r = reasonOf(reason);
  const pinHash = patch.pin ? await hashPin(patch.pin) : null;
  await withTx(async (tx) => {
    const [before] = await tx<{ id: string; name: string; role: StaffRole; active: boolean }[]>`
      select id, name, role, active from public.staff where id = ${id} for update`;
    if (!before) throw notFound("Staff member not found.");
    const losingManager =
      before.role === "manager" && before.active && (patch.role === "staff" || patch.active === false);
    if (losingManager) await assertAnotherManagerRemains(tx, id);
    if (patch.pin) await assertPinUnique(tx, patch.pin, id);
    const [after] = await tx<typeof before[]>`
      update public.staff set
        name = ${patch.name?.trim() ?? before.name},
        role = ${patch.role ?? before.role},
        active = ${patch.active ?? before.active},
        pin_hash = coalesce(${pinHash}, pin_hash)
      where id = ${id}
      returning id, name, role, active`;
    await audit(tx, {
      ...by(actor, m),
      action: "staff.update",
      entity: "staff",
      entityId: id,
      before,
      after: { ...after, pin_changed: pinHash ? true : undefined },
      reason: r,
    });
  });
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function needsFirstManager(): Promise<boolean> {
  const [row] = await db()`select 1 from public.staff where active and role = 'manager' limit 1`;
  return !row;
}

/**
 * Enrols a device. On first run (no active manager yet) the first manager must be created in the
 * same step — there are no default PINs anywhere.
 */
export async function enrolDevice(
  label: string,
  firstManager: { name: string; pin: string } | undefined,
): Promise<{ id: string; label: string }> {
  const pinHash = firstManager ? await hashPin(firstManager.pin) : null;
  return withTx(async (tx) => {
    // Serialise first-run so two iPads can't both create "the first manager".
    await tx`select pg_advisory_xact_lock(hashtext('eight-ball-timer:first-manager'))`;
    const [mgr] = await tx`select 1 from public.staff where active and role = 'manager' limit 1`;
    const [device] = await tx<{ id: string; label: string }[]>`
      insert into public.devices (label) values (${label.trim()}) returning id, label`;
    await audit(tx, {
      actorStaffId: null,
      deviceLabel: device.label,
      action: "device.enrol",
      entity: "device",
      entityId: device.id,
      after: device,
    });
    if (!mgr) {
      if (!firstManager || !pinHash) throw badRequest("Create the first manager to finish setting up.");
      const [staff] = await tx<{ id: string; name: string; role: StaffRole }[]>`
        insert into public.staff (name, role, pin_hash) values (${firstManager.name.trim()}, 'manager', ${pinHash})
        returning id, name, role`;
      await audit(tx, {
        actorStaffId: null,
        deviceLabel: device.label,
        action: "staff.create_first_manager",
        entity: "staff",
        entityId: staff.id,
        after: staff,
      });
    }
    return device;
  });
}

export async function revokeDevice(actor: Actor, m: Manager, id: string, reason: string): Promise<void> {
  const r = reasonOf(reason);
  await withTx(async (tx) => {
    const [before] = await tx<{ id: string; label: string; revoked_at: Date | null }[]>`
      select id, label, revoked_at from public.devices where id = ${id} for update`;
    if (!before) throw notFound("Device not found.");
    if (before.revoked_at) return;
    await tx`update public.devices set revoked_at = now(), revoked_by = ${m.id} where id = ${id}`;
    await audit(tx, { ...by(actor, m), action: "device.revoke", entity: "device", entityId: id, before, reason: r });
  });
}

// ---------------------------------------------------------------------------
// Terminal pairing (Devices API — production only; codes expire after 5 minutes)
// ---------------------------------------------------------------------------

export async function startPairing(actor: Actor, m: Manager): Promise<PairingCodeDTO> {
  const code = await squareTerminal.createDeviceCode(
    squareEnv().SQUARE_LOCATION_ID,
    `8 Ball Lounge timer (${actor.deviceLabel})`,
    randomUUID(),
  );
  await withTx(async (tx) => {
    await audit(tx, {
      ...by(actor, m),
      action: "terminal.pairing_started",
      entity: "terminal",
      entityId: null,
      after: { code_id: code.id, pair_by: code.pairBy },
    });
  });
  return { codeId: code.id, code: code.code ?? "", pairBy: code.pairBy, status: code.status, deviceId: code.deviceId };
}

async function saveTerminalDevice(tx: Tx, deviceId: string, via: string, actor: Actor | null, m: Manager | null): Promise<void> {
  const before = await getSettings(tx);
  if (before.terminalDeviceId === deviceId) return;
  await tx`update public.settings set terminal_device_id = ${deviceId} where id`;
  await audit(tx, {
    actorStaffId: actor?.staffId ?? null,
    approvedByStaffId: m?.id ?? null,
    deviceLabel: actor?.deviceLabel ?? "Square webhook",
    action: "terminal.paired",
    entity: "terminal",
    entityId: deviceId,
    before: { terminal_device_id: before.terminalDeviceId },
    after: { terminal_device_id: deviceId, via },
  });
}

/** Polled by the admin screen; also saves the device if the webhook hasn't yet. */
export async function pairingStatus(actor: Actor, m: Manager, codeId: string): Promise<PairingCodeDTO> {
  const code = await squareTerminal.getDeviceCode(codeId);
  if (code.status === "PAIRED" && code.deviceId) {
    const deviceId = code.deviceId;
    await withTx((tx) => saveTerminalDevice(tx, deviceId, "pairing_screen", actor, m));
  }
  return { codeId: code.id, code: code.code ?? "", pairBy: code.pairBy, status: code.status, deviceId: code.deviceId };
}

export async function unpairTerminal(actor: Actor, m: Manager, reason: string): Promise<void> {
  const r = reasonOf(reason);
  await withTx(async (tx) => {
    const before = await getSettings(tx);
    await tx`update public.settings set terminal_device_id = null where id`;
    await audit(tx, {
      ...by(actor, m),
      action: "terminal.unpaired",
      entity: "terminal",
      entityId: before.terminalDeviceId,
      before: { terminal_device_id: before.terminalDeviceId },
      after: { terminal_device_id: null },
      reason: r,
    });
  });
}

/** device.code.paired webhook. Only accepts Terminal API codes for our location. */
export async function applyDevicePaired(
  tx: Tx,
  dc: { id: string; status: string; deviceId: string | null; locationId: string | null; productType?: string },
): Promise<"applied" | "ignored"> {
  if (dc.status !== "PAIRED" || !dc.deviceId) return "ignored";
  let locationId: string;
  try {
    locationId = squareEnv().SQUARE_LOCATION_ID;
  } catch {
    return "ignored"; // Square not configured: we can't tell whether this code is ours
  }
  if (dc.locationId && dc.locationId !== locationId) return "ignored";
  if (dc.productType && dc.productType !== "TERMINAL_API") return "ignored";
  await saveTerminalDevice(tx, dc.deviceId, "square_webhook", null, null);
  return "applied";
}
