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
