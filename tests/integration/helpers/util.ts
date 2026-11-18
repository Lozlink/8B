import { expect } from "vitest";
import { price } from "@/lib/pricing";
import type { Harness } from "./harness";
import type { SessionRow, IntervalRow, CheckoutRow } from "@/lib/server/repo";
import { startSession, stopSession } from "@/lib/server/sessions";

/** Fixed reference instant (Fri 20 Nov 2026, 10:00 Sydney). All tests derive times from it. */
export const T0 = new Date("2026-11-20T10:00:00+11:00");
export const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

export async function getSession(h: Harness, id: string): Promise<SessionRow> {
  const [s] = await h.sql<SessionRow[]>`select * from public.sessions where id = ${id}`;
  return s;
}

export async function getIntervals(h: Harness, id: string): Promise<(IntervalRow & { table_name: string })[]> {
  return h.sql<(IntervalRow & { table_name: string })[]>`
    select i.id, i.session_id, i.table_id, i.started_at, i.ended_at, t.name as table_name
    from public.session_intervals i join public.tables t on t.id = i.table_id
    where i.session_id = ${id} order by i.started_at`;
}

export async function getCheckouts(h: Harness, id: string): Promise<CheckoutRow[]> {
  return h.sql<CheckoutRow[]>`select * from public.terminal_checkouts where session_id = ${id} order by attempt`;
}

export interface AuditRow {
  id: string;
  actor_staff_id: string | null;
  approved_by_staff_id: string | null;
  device_label: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

export async function audits(h: Harness, entityId: string, action?: string): Promise<AuditRow[]> {
  return h.sql<AuditRow[]>`
    select * from public.audit_log
    where entity_id = ${entityId} ${action ? h.sql`and action = ${action}` : h.sql``}
    order by id`;
}

export async function auditActions(h: Harness, entityId: string): Promise<string[]> {
  return (await audits(h, entityId)).map((a) => a.action);
}

/** Starts on `table` at T0 and stops `minutes` later. Returns the session id (awaiting_payment). */
export async function awaitingPayment(h: Harness, table = "Table 1", minutes = 60): Promise<string> {
  const { sessionId } = await startSession(h.staff.actor, h.tableId(table), T0);
  await stopSession(h.staff.actor, sessionId, at(minutes));
  return sessionId;
}

export async function occupiedTables(h: Harness): Promise<string[]> {
  const rows = await h.sql<{ name: string }[]>`
    select t.name from public.sessions s join public.tables t on t.id = s.current_table_id order by t.name`;
  return rows.map((r) => r.name);
}

export interface SeedProduct {
  id: string;
  name: string;
  priceCents: number;
  taxed?: boolean;
  category?: string | null;
  active?: boolean;
  sortOrder?: number;
}

/** Puts a product straight into `products`, as a catalogue sync would have. */
export async function seedProduct(h: Harness, p: SeedProduct): Promise<string> {
  await h.sql`
    insert into public.products (id, item_id, name, price_cents, taxed, category, sort_order, active)
    values (${p.id}, ${`ITEM_${p.id}`}, ${p.name}, ${p.priceCents}, ${p.taxed ?? true}, ${p.category ?? null},
            ${p.sortOrder ?? 0}, ${p.active ?? true})`;
  return p.id;
}

export interface ItemRow {
  id: string;
  session_id: string;
  kind: "product" | "custom" | "split";
  product_id: string | null;
  name: string;
  unit_cents: number;
  quantity: number;
  taxed: boolean;
  added_by: string;
  removed_at: Date | null;
  removed_by: string | null;
}

export async function getItems(h: Harness, sessionId: string): Promise<ItemRow[]> {
  return h.sql<ItemRow[]>`select * from public.session_items where session_id = ${sessionId} order by added_at, id`;
}

// ---------------------------------------------------------------------------
// The bill identity
// ---------------------------------------------------------------------------

/** Puts a discount straight into `discounts`, as a catalogue sync would have. */
export async function seedDiscount(
  h: Harness,
  d: { id: string; name: string; kind: "percent" | "amount" | "variable_percent" | "variable_amount"; value?: number | null; active?: boolean },
): Promise<string> {
  await h.sql`
    insert into public.discounts (id, name, kind, value, active)
    values (${d.id}, ${d.name}, ${d.kind}, ${d.value ?? null}, ${d.active ?? true})`;
  return d.id;
}

export interface BillFacts {
  tableCents: number;
  itemsCents: number;
  discountCents: number;
  splitOffCents: number;
  totalCents: number | null;
}

/**
 * Checks, from the rows alone and without any of the server's own bill code, that a bill adds up:
 *
 *     total_cents = table time + items_cents − discount_cents − split_off_cents     (>= 0)
 *
 * and that each stored term is what its source rows say: items_cents is the live lines,
 * discount_cents is the discount's kind and value applied to table time + items, split_off_cents
 * is the parts that still stand, and table time is the stored rates run over the stored intervals.
 * Call it after every change to a bill. Returns the terms.
 */
export async function expectBillAddsUp(h: Harness, id: string): Promise<BillFacts> {
  const s = await getSession(h, id);
  expect(s, `bill ${id} exists`).toBeTruthy();
  const tag = `${s.kind} bill ${id.slice(0, 8)} (${s.status})`;

  const items = (await getItems(h, id)).filter((i) => !i.removed_at);
  const itemsCents = items.reduce((a, i) => a + i.unit_cents * i.quantity, 0);
  expect(s.items_cents, `${tag}: items_cents is the live lines`).toBe(itemsCents);

  const parts = await h.sql<{ total_cents: number | null }[]>`
    select total_cents from public.sessions where split_of = ${id} and not merged`;
  const standing = parts.reduce((a, p) => a + (p.total_cents ?? 0), 0);
  expect(s.split_off_cents, `${tag}: split_off_cents is the parts that still stand`).toBe(standing);
  expect(s.split_off_cents).toBeGreaterThanOrEqual(0);
  expect(s.discount_cents).toBeGreaterThanOrEqual(0);

  if (s.kind === "part") {
    expect(s.split_of, `${tag}: a part has a parent`).toBeTruthy();
    expect(items.map((i) => i.kind), `${tag}: a part has exactly one line, its share`).toEqual(["split"]);
    expect(s.discount_kind, `${tag}: a part has no discount`).toBeNull();
    expect(standing, `${tag}: a part has no parts`).toBe(0);
    expect((await getIntervals(h, id)).length, `${tag}: a part has no intervals`).toBe(0);
    expect(s.rate_snapshot).toBeNull();
  } else {
    expect(s.split_of).toBeNull();
    expect(items.some((i) => i.kind === "split"), `${tag}: only a part carries a split line`).toBe(false);
  }
  if (s.kind === "counter") {
    expect((await getIntervals(h, id)).length, `${tag}: a counter sale has no intervals`).toBe(0);
    expect(s.rate_snapshot).toBeNull();
  }

  if (s.status === "running" || s.status === "paused") {
    expect(s.total_cents, `${tag}: no total until it stops`).toBeNull();
    expect(s.discount_cents, `${tag}: the discount is worked out at stop`).toBe(0);
    return { tableCents: 0, itemsCents, discountCents: 0, splitOffCents: standing, totalCents: null };
  }
  if (s.total_cents === null) {
    // Voided while running: it was never priced.
    expect(s.status).toBe("void");
    return { tableCents: 0, itemsCents, discountCents: s.discount_cents, splitOffCents: standing, totalCents: null };
  }

  let tableCents = 0;
  if (s.kind === "table") {
    expect(s.rate_snapshot, `${tag}: a priced table bill keeps its rates`).toBeTruthy();
    const snap = s.rate_snapshot as NonNullable<typeof s.rate_snapshot>;
    const intervals = await getIntervals(h, id);
    const r = price({
      intervals: intervals.map((i) => ({ startedAt: i.started_at, endedAt: i.ended_at })),
      rateCards: snap.rateCards,
      settings: snap.settings,
      now: s.closed_at ?? new Date(),
    });
    tableCents = r.totalCents;
    expect(s.billed_minutes, `${tag}: billed minutes are the table time`).toBe(r.billedMinutes);
  } else {
    expect(s.billed_minutes, `${tag}: no table time`).toBe(0);
  }

  const base = tableCents + itemsCents;
  if (s.discount_kind && s.discount_value !== null) {
    expect(s.discount_name, `${tag}: a discount has a name`).toBeTruthy();
    expect(s.discount_by, `${tag}: a discount says who put it on`).toBeTruthy();
    const exact =
      s.discount_kind === "amount"
        ? Math.min(s.discount_value, base)
        : Math.min(base, Number((BigInt(base) * BigInt(s.discount_value) * 2n + 10_000n) / 20_000n));
    // A no-charge void (nothing on the bill) keeps the discount but takes nothing off.
    expect(s.discount_cents, `${tag}: discount_cents is the discount applied to table time + items`).toBe(exact);
  } else {
    expect(s.discount_cents, `${tag}: no discount, nothing off`).toBe(0);
  }

  expect(s.total_cents, `${tag}: total = table ${tableCents} + items ${itemsCents} − discount ${s.discount_cents} − split off ${s.split_off_cents}`).toBe(
    base - s.discount_cents - s.split_off_cents,
  );
  expect(s.total_cents).toBeGreaterThanOrEqual(0);
  return { tableCents, itemsCents, discountCents: s.discount_cents, splitOffCents: s.split_off_cents, totalCents: s.total_cents };
}

/** `expectBillAddsUp` for a bill and every part ever split off it (merged-back ones too). */
export async function expectFamilyAddsUp(h: Harness, parentId: string): Promise<{ parent: BillFacts; standingCents: number }> {
  const parent = await expectBillAddsUp(h, parentId);
  const parts = await h.sql<{ id: string }[]>`select id from public.sessions where split_of = ${parentId} order by created_at, id`;
  for (const p of parts) await expectBillAddsUp(h, p.id);
  return { parent, standingCents: parent.splitOffCents };
}
