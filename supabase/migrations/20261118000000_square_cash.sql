-- Cash sales are recorded in Square by the app, so they show in the Square dashboard without
-- anyone ringing them into Square POS.
--
--   * sessions.settled_cents: what was actually collected when the bill was paid. For a card it is
--     the amount the card was charged. For cash it is the bill rounded to the nearest 5c (Square
--     refuses cash amounts that aren't a multiple of 5c, and records the rounding itself).
--   * square_cash_records: one row per cash settlement, saying what Square should hold for it and
--     what Square does hold. The row is written in the same transaction that marks the bill paid;
--     the Square calls happen afterwards, outside any lock, and are retried in the background until
--     they succeed. Square being down never stops staff taking cash.

-- Fail fast rather than queue. ALTER TABLE on sessions needs a lock that waits behind any open
-- card charge, and every floor read would then wait behind this migration. With this, it gives up
-- after 3 seconds instead. If it fails with "canceling statement due to lock timeout", nothing was
-- changed (the file runs as one transaction): run it again.
-- `set local` only lasts for this transaction. Run outside one it does nothing but warn.
set local lock_timeout = '3s';

alter table public.sessions
  add column settled_cents integer check (settled_cents is null or settled_cents >= 0);

update public.sessions set settled_cents = total_cents where status = 'paid';

-- Keeps settled_cents in step with status for any writer that doesn't know the column: above all
-- the previous release of the app, which is still serving requests between this migration being
-- run and the new release going live. Without this, the constraint below would refuse every
-- payment (staff and card webhook alike) for that whole window.
--   * paid with no amount given  -> the bill total (what a card is charged; cash before this
--     release was recorded unrounded too)
--   * not paid                   -> null
-- The app sets the column itself on every path; this only fills what was left out.
create function public.sessions_settled_cents_default() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'paid' then
    if new.settled_cents is null then
      new.settled_cents := new.total_cents;
    end if;
  else
    new.settled_cents := null;
  end if;
  return new;
end;
$$;

grant execute on function public.sessions_settled_cents_default() to timer_app;

create trigger sessions_settled_cents_default before insert or update on public.sessions
  for each row execute function public.sessions_settled_cents_default();

alter table public.sessions
  add constraint sessions_settled_cents_iff_paid check ((status = 'paid') = (settled_cents is not null));

create table public.square_cash_records (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references public.sessions (id),
  -- 1 for the first time this bill was paid in cash, 2 if it was reversed and paid in cash again…
  -- Part of every Square idempotency key for the record.
  seq                integer not null check (seq >= 1),
  -- Cash collected (5c-rounded) and the bill it settled.
  amount_cents       integer not null check (amount_cents > 0 and amount_cents % 5 = 0),
  bill_cents         integer not null check (bill_cents > 0),
  -- The Square order lines as they stood when the bill was paid (same shape the card charge sends).
  -- Null = record a plain amount with no order.
  order_lines        jsonb,
  note               text,
  -- What Square should end up holding: the sale, or the sale and its refund (the payment was
  -- reversed by a manager).
  want               text not null default 'recorded' check (want in ('recorded', 'refunded')),
  -- pending  = there is still something to send to Square
  -- recorded = the sale is in Square
  -- refunded = the sale and its refund are in Square
  -- skipped  = reversed before anything was sent; nothing in Square, nothing to do
  -- failed   = Square refused it, or it kept failing; needs a manager to retry
  state              text not null default 'pending'
                       check (state in ('pending', 'recorded', 'refunded', 'skipped', 'failed')),
  square_order_id    text,
  square_payment_id  text,
  square_refund_id   text,
  attempts           integer not null default 0,
  last_error         text,
  next_attempt_at    timestamptz not null default now(),
  -- Set by the worker that is talking to Square about this row right now.
  claimed_at         timestamptz,
  created_by         uuid references public.staff (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (session_id, seq)
);
create index square_cash_records_due on public.square_cash_records (next_attempt_at)
  where state = 'pending';
create index square_cash_records_failed on public.square_cash_records (created_at)
  where state = 'failed';
-- One Square payment belongs to one record. This is what stops two bills claiming the same
-- Square POS cash sale when they are checked at the same moment.
create unique index square_cash_records_payment_uniq on public.square_cash_records (square_payment_id)
  where square_payment_id is not null;

create trigger square_cash_records_touch before update on public.square_cash_records
  for each row execute function public.touch_updated_at();

create trigger square_cash_records_no_delete before delete on public.square_cash_records
  for each row execute function public.forbid_mutation('cash records are never deleted');
create trigger square_cash_records_no_truncate before truncate on public.square_cash_records
  for each statement execute function public.forbid_mutation('cash records are never deleted');

-- Deliberately NO floor-broadcast trigger: this table is written by a background job that runs
-- after every floor fetch. A broadcast here would make every iPad refetch, run the job again and
-- loop (the triggers are statement-level and fire even when no row matches).

revoke all on public.square_cash_records from anon, authenticated;
revoke delete, truncate on public.square_cash_records from service_role;

grant select, insert, update on public.square_cash_records to timer_app;

alter table public.square_cash_records enable row level security;

create policy timer_app_select on public.square_cash_records for select to timer_app using (true);
create policy timer_app_insert on public.square_cash_records for insert to timer_app with check (true);
create policy timer_app_update on public.square_cash_records for update to timer_app using (true) with check (true);
