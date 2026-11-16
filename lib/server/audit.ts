import "server-only";
import type { Db } from "./db";

export interface AuditEntry {
  /** null = system (Square webhook / background reconciliation). */
  actorStaffId: string | null;
  approvedByStaffId?: string | null;
  deviceLabel: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Appends an audit row. Always call inside the same transaction as the change it records.
 * JSON goes over the wire as text and is cast by Postgres (`::text::jsonb`): postgres.js v4 would
 * otherwise JSON-encode an already-stringified value a second time and store a jsonb *string*.
 */
export async function audit(q: Db, e: AuditEntry): Promise<void> {
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  await q`
    insert into public.audit_log
      (actor_staff_id, approved_by_staff_id, device_label, action, entity, entity_id, before, after, reason)
    values (
      ${e.actorStaffId}, ${e.approvedByStaffId ?? null}, ${e.deviceLabel}, ${e.action}, ${e.entity},
      ${e.entityId}, ${json(e.before)}::text::jsonb, ${json(e.after)}::text::jsonb, ${e.reason ?? null}
    )`;
}
