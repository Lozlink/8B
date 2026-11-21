import "server-only";
import { audit } from "./audit";
import type { Actor, Manager } from "./auth";
import { withTx, type Db } from "./db";
import { badRequest, conflict, notFound } from "./errors";

/** The audit entries the summary lists under "Needs attention". */
export const ATTENTION_ACTIONS = [
  "payment.conflict",
  "session.reverse_paid",
  "checkout.cancel_failed",
  "square.cash_failed",
  // Stock Square wasn't told about (or wasn't given back) after a sale or a reopened bill.
  "square.stock_failed",
  // Cash handed to Square POS that nobody could confirm: Square may hold the sale twice.
  "cash.handoff_unconfirmed",
  "cash.handoff_check_skipped",
  // A refund Square refused (nothing went back), and one nobody can confirm either way.
  "refund.failed",
  "refund.unconfirmed",
] as const;

/** Written when a manager marks an attention entry as checked. `entity_id` is that entry's id. */
export const ATTENTION_CHECKED = "attention.checked";
const CHECKED_ENTITY = "audit";

export interface AttentionCheck {
  at: Date;
  byName: string | null;
}

/** Who checked which of these audit entries, by entry id. The first check wins if there are several. */
export async function attentionChecks(q: Db, entryIds: string[]): Promise<Map<string, AttentionCheck>> {
  if (entryIds.length === 0) return new Map();
  const rows = await q<{ entry_id: string; at: Date; by_name: string | null }[]>`
    select distinct on (c.entity_id) c.entity_id as entry_id, c.at, m.name as by_name
    from public.audit_log c
    left join public.staff m on m.id = c.approved_by_staff_id
    where c.entity = ${CHECKED_ENTITY} and c.action = ${ATTENTION_CHECKED} and c.entity_id = any(${entryIds}::text[])
    order by c.entity_id, c.id`;
  return new Map(rows.map((r) => [r.entry_id, { at: r.at, byName: r.by_name }]));
}

/**
 * A manager (PIN already verified by the route) has looked at a "Needs attention" entry and it needs nothing more. The audit log is
 * append-only, so this adds a row that points at the entry; the entry itself is never changed.
 * It only clears the notice: whatever the entry is about (a refund to settle, cash to resend to
 * Square) is still done where it always was.
 */
export async function checkAttention(actor: Actor, manager: Manager, entryId: string): Promise<void> {
  if (!/^\d{1,18}$/.test(entryId)) throw badRequest("Invalid entry.");
  await withTx(async (tx) => {
    // Two managers tapping at once: one row, and the other is told it's already done.
    await tx`select pg_advisory_xact_lock(hashtext(${"attention:" + entryId}))`;
    const [entry] = await tx<{ action: string }[]>`select action from public.audit_log where id = ${entryId}::bigint`;
    if (!entry || !(ATTENTION_ACTIONS as readonly string[]).includes(entry.action)) throw notFound("That entry isn't on the list.");
    if ((await attentionChecks(tx, [entryId])).size > 0) throw conflict("Someone has already marked that as checked.");
    await audit(tx, {
      actorStaffId: actor.staffId,
      approvedByStaffId: manager.id,
      deviceLabel: actor.deviceLabel,
      action: ATTENTION_CHECKED,
      entity: CHECKED_ENTITY,
      entityId: entryId,
      after: { action: entry.action },
    });
  });
}
