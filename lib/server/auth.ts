import "server-only";
import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { compare, hash } from "bcryptjs";
import { timingSafeEqual, createHash } from "node:crypto";
import { db, withTx, type Db, type Tx } from "./db";
import { env } from "./env";
import { AppError, forbidden, tooMany, unauthorized, badRequest } from "./errors";
import type { StaffRole } from "@/lib/domain/types";

/*
 * Auth model
 * ----------
 * 1. Device enrolment: an iPad becomes trusted once someone types DEVICE_ENROL_CODE (a long secret
 *    held by the owner). It gets a signed, httpOnly device cookie. PIN login only works on enrolled
 *    devices, so a 4-digit PIN can't be brute-forced from the open internet. Managers can revoke.
 * 2. Staff session: tap your name, enter your PIN → signed session cookie bound to the device.
 *    It lasts 20 hours from login and is never renewed: long enough that it doesn't run out in the
 *    middle of a long day's trade, short enough that each day starts with someone's own PIN, so
 *    actions aren't attributed to whoever logged in days ago.
 * 3. Manager step-up: sensitive actions carry a manager PIN in the request (or, for the admin
 *    screens, a 10-minute elevation cookie obtained with a manager PIN).
 * All PIN attempts are recorded and throttled.
 */

const DEVICE_COOKIE = "tt_device";
const SESSION_COOKIE = "tt_session";
const ELEVATION_COOKIE = "tt_mgr";

const SESSION_TTL_S = 20 * 60 * 60; // fixed from login; covers the longest trading day
const ELEVATION_TTL_S = 10 * 60;
const DEVICE_TTL_S = 400 * 24 * 60 * 60; // browsers cap cookie lifetime at 400 days

export const PIN_RE = /^\d{4,6}$/;
const BCRYPT_COST = 10;

export interface Actor {
  staffId: string;
  name: string;
  role: StaffRole;
  deviceId: string;
  deviceLabel: string;
}

export interface Manager {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function key(): Uint8Array {
  return new TextEncoder().encode(env().SESSION_SECRET);
}

/** Signs a short-lived token with the session secret. The audience keeps one kind of token from passing as another. */
export async function signToken(payload: JWTPayload, ttlSeconds: number, audience: string): Promise<string> {
  return sign(payload, ttlSeconds, audience);
}

/** The payload of a token made by `signToken` for this audience, or null if it is forged, expired or for something else. */
export async function verifyToken(token: string | undefined, audience: string): Promise<JWTPayload | null> {
  return verify(token, audience);
}

async function sign(payload: JWTPayload, ttlSeconds: number, audience: string): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience(audience)
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key());
}

async function verify(token: string | undefined, audience: string): Promise<JWTPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { audience, algorithms: ["HS256"] });
    return payload;
  } catch {
    return null;
  }
}

const cookieBase = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

// ---------------------------------------------------------------------------
// PINs
// ---------------------------------------------------------------------------

export function assertPinFormat(pin: string): void {
  if (!PIN_RE.test(pin)) throw badRequest("PIN must be 4–6 digits.");
}

export function hashPin(pin: string): Promise<string> {
  assertPinFormat(pin);
  return hash(pin, BCRYPT_COST);
}

export function pinMatches(pin: string, pinHash: string): Promise<boolean> {
  return compare(pin, pinHash);
}

/** Rejects a PIN already used by another active staff member (manager step-up is PIN-only). */
export async function assertPinUnique(q: Db, pin: string, exceptStaffId: string | null): Promise<void> {
  const rows = await q<{ id: string; pin_hash: string }[]>`
    select id, pin_hash from public.staff where active`;
  for (const r of rows) {
    if (r.id !== exceptStaffId && (await pinMatches(pin, r.pin_hash))) {
      throw badRequest("That PIN is already in use. Choose a different one.");
    }
  }
}

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

type AttemptKind = "enrol" | "login" | "manager";

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0]?.trim() : null) || h.get("x-real-ip") || null;
}

async function recordAttempt(
  q: Db,
  kind: AttemptKind,
  success: boolean,
  ids: { deviceId?: string | null; staffId?: string | null; ip?: string | null },
): Promise<void> {
  await q`
    insert into public.login_attempts (kind, success, device_id, staff_id, ip)
    values (${kind}, ${success}, ${ids.deviceId ?? null}, ${ids.staffId ?? null}, ${ids.ip ?? null})`;
}

async function failuresSince(
  q: Db,
  column: "device_id" | "staff_id" | "ip",
  value: string,
  kind: AttemptKind,
  minutes: number,
): Promise<number> {
  const [row] = await q<{ n: number }[]>`
    select count(*)::int as n from public.login_attempts
    where ${q(column)} = ${value} and kind = ${kind} and not success
      and at > now() - make_interval(mins => ${minutes})`;
  return row?.n ?? 0;
}

/**
 * Serialises attempts that share a throttle bucket. Check → verify → record happens while holding
 * a transaction-scoped advisory lock, so parallel requests can't all pass the "fewer than N
 * failures" check before any of them records a failure. Keys are locked in sorted order so two
 * callers taking several keys can't deadlock.
 */
async function lockBuckets(tx: Tx, keys: string[]): Promise<void> {
  for (const k of [...keys].sort()) {
    await tx`select pg_advisory_xact_lock(hashtext(${"throttle:" + k}))`;
  }
}

// ---------------------------------------------------------------------------
// Device enrolment
// ---------------------------------------------------------------------------

function constantTimeEqual(a: string, b: string): boolean {
  // Hash first so lengths always match and nothing leaks through timing.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function checkEnrolCode(code: string): Promise<void> {
  const ip = await clientIp();
  const outcome = await withTx(async (tx) => {
    if (ip) {
      await lockBuckets(tx, [`enrol:ip:${ip}`]);
      if ((await failuresSince(tx, "ip", ip, "enrol", 60)) >= 10) return "throttled" as const;
    }
    const okCode = constantTimeEqual(code.trim(), env().DEVICE_ENROL_CODE);
    await recordAttempt(tx, "enrol", okCode, { ip });
    return okCode ? ("ok" as const) : ("wrong" as const);
  });
  // Thrown after commit so the failed attempt stays recorded.
  if (outcome === "throttled") throw tooMany("Too many attempts. Try again in an hour.");
  if (outcome === "wrong") throw forbidden("That enrolment code isn't right.");
}

export async function setDeviceCookie(deviceId: string, label: string): Promise<void> {
  const token = await sign({ sub: deviceId, label }, DEVICE_TTL_S, "device");
  (await cookies()).set(DEVICE_COOKIE, token, { ...cookieBase, maxAge: DEVICE_TTL_S });
}

export async function currentDevice(): Promise<{ id: string; label: string } | null> {
  const payload = await verify((await cookies()).get(DEVICE_COOKIE)?.value, "device");
  if (!payload?.sub) return null;
  const [row] = await db()<{ id: string; label: string }[]>`
    select id, label from public.devices where id = ${payload.sub} and revoked_at is null`;
  return row ?? null;
}

export async function requireDevice(): Promise<{ id: string; label: string }> {
  const d = await currentDevice();
  if (!d) throw new AppError(401, "device_not_enrolled", "This device isn't enrolled.");
  return d;
}

// ---------------------------------------------------------------------------
// Staff login
// ---------------------------------------------------------------------------

export async function login(staffId: string, pin: string): Promise<Actor> {
  const device = await requireDevice();
  assertPinFormat(pin);

  type Found = { id: string; name: string; role: StaffRole; pin_hash: string };
  const outcome = await withTx(async (tx) => {
    await lockBuckets(tx, [`login:device:${device.id}`, `login:staff:${staffId}`]);
    if ((await failuresSince(tx, "staff_id", staffId, "login", 15)) >= 5) return { kind: "staff_throttled" as const };
    if ((await failuresSince(tx, "device_id", device.id, "login", 15)) >= 15) return { kind: "device_throttled" as const };
    const [found] = await tx<Found[]>`
      select id, name, role, pin_hash from public.staff where id = ${staffId} and active`;
    const good = found ? await pinMatches(pin, found.pin_hash) : false;
    await recordAttempt(tx, "login", good, { deviceId: device.id, staffId: found ? found.id : null });
    return good && found ? { kind: "ok" as const, staff: found } : { kind: "wrong" as const };
  });
  if (outcome.kind === "staff_throttled") {
    throw tooMany("Too many wrong PINs for this person. Wait 15 minutes or ask a manager.");
  }
  if (outcome.kind === "device_throttled") throw tooMany("Too many wrong PINs on this device. Wait 15 minutes.");
  // Distinct code: the client treats 401 "unauthorized" as "session expired → /login", which would
  // bounce the login page itself on a mistyped PIN.
  if (outcome.kind !== "ok") throw new AppError(401, "invalid_credentials", "Wrong PIN.");
  const s = outcome.staff;

  const jar = await cookies();
  await issueSession(jar, s.id, device.id);
  jar.delete(ELEVATION_COOKIE);
  await db()`update public.devices set last_seen_at = now() where id = ${device.id}`;
  return { staffId: s.id, name: s.name, role: s.role, deviceId: device.id, deviceLabel: device.label };
}

type CookieJar = Awaited<ReturnType<typeof cookies>>;

async function issueSession(jar: CookieJar, staffId: string, deviceId: string): Promise<void> {
  const token = await sign({ sub: staffId, dev: deviceId }, SESSION_TTL_S, "staff");
  jar.set(SESSION_COOKIE, token, { ...cookieBase, maxAge: SESSION_TTL_S });
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(ELEVATION_COOKIE);
}

export async function currentActor(): Promise<Actor | null> {
  const jar = await cookies();
  const [dev, ses] = await Promise.all([
    verify(jar.get(DEVICE_COOKIE)?.value, "device"),
    verify(jar.get(SESSION_COOKIE)?.value, "staff"),
  ]);
  if (!dev?.sub || !ses?.sub || ses.dev !== dev.sub) return null;
  const [row] = await db()<{ staff_id: string; name: string; role: StaffRole; device_id: string; label: string }[]>`
    select s.id as staff_id, s.name, s.role, d.id as device_id, d.label
    from public.staff s, public.devices d
    where s.id = ${ses.sub} and s.active and d.id = ${dev.sub} and d.revoked_at is null`;
  if (!row) return null;
  return { staffId: row.staff_id, name: row.name, role: row.role, deviceId: row.device_id, deviceLabel: row.label };
}

export async function requireActor(): Promise<Actor> {
  const a = await currentActor();
  if (!a) throw unauthorized();
  return a;
}

// ---------------------------------------------------------------------------
// Manager step-up
// ---------------------------------------------------------------------------

/** Checks a manager PIN typed on this device. Throttled per device. */
export async function verifyManagerPin(actor: Actor, pin: string): Promise<Manager> {
  assertPinFormat(pin);
  const outcome = await withTx(async (tx) => {
    await lockBuckets(tx, [`manager:device:${actor.deviceId}`]);
    if ((await failuresSince(tx, "device_id", actor.deviceId, "manager", 15)) >= 5) return "throttled" as const;
    const managers = await tx<{ id: string; name: string; pin_hash: string }[]>`
      select id, name, pin_hash from public.staff where active and role = 'manager'`;
    let match: Manager | null = null;
    for (const m of managers) {
      if (await pinMatches(pin, m.pin_hash)) {
        match = { id: m.id, name: m.name };
        break;
      }
    }
    await recordAttempt(tx, "manager", match !== null, { deviceId: actor.deviceId, staffId: match?.id ?? null });
    return match;
  });
  if (outcome === "throttled") throw tooMany("Too many wrong manager PINs on this device. Wait 15 minutes.");
  if (!outcome) throw forbidden("That isn't a manager PIN.");
  return outcome;
}

/** Admin screens: unlock for 10 minutes with a manager PIN. */
export async function elevate(actor: Actor, pin: string): Promise<Manager> {
  const m = await verifyManagerPin(actor, pin);
  const token = await sign({ sub: m.id, dev: actor.deviceId, by: actor.staffId }, ELEVATION_TTL_S, "manager");
  (await cookies()).set(ELEVATION_COOKIE, token, { ...cookieBase, maxAge: ELEVATION_TTL_S });
  return m;
}

export async function dropElevation(): Promise<void> {
  (await cookies()).delete(ELEVATION_COOKIE);
}

export async function currentElevation(actor: Actor): Promise<Manager | null> {
  const p = await verify((await cookies()).get(ELEVATION_COOKIE)?.value, "manager");
  if (!p?.sub || p.dev !== actor.deviceId || p.by !== actor.staffId) return null;
  const [m] = await db()<Manager[]>`
    select id, name from public.staff where id = ${p.sub} and active and role = 'manager'`;
  return m ?? null;
}

export async function requireElevation(actor: Actor): Promise<Manager> {
  const m = await currentElevation(actor);
  if (!m) throw new AppError(403, "manager_required", "Manager PIN required.");
  return m;
}
