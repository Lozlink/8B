-- 8 Ball Lounge — table timer: initial schema
--
-- Conventions
--   * All instants are timestamptz (stored UTC). All money is integer cents, AUD, GST-inclusive.
--   * Sessions and intervals are never hard-deleted (Australian sales-suppression laws). Voids keep
--     the row with status 'void' and a reason. Delete/truncate are revoked AND blocked by triggers.
--   * audit_log is append-only for every role, enforced by revokes AND triggers.
--   * Access model: the public API roles (anon, authenticated) get nothing — RLS is enabled on every
--     table with no policies for them. The Next.js server connects as the least-privilege role
--     `timer_app` (no DELETE anywhere, INSERT/SELECT only on audit_log), via explicit RLS policies.
--     The browser never queries tables; it only listens to a data-free Realtime broadcast ("something
--     changed") and refetches through authenticated server routes.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.staff_role as enum ('staff', 'manager');
create type public.session_status as enum ('running', 'paused', 'awaiting_payment', 'paid', 'void');
create type public.settled_method as enum ('card', 'cash');
-- square_webhook: Square told us via webhook. square_api: we learned it by asking Square (poll/cancel
-- reconciliation, used when a webhook is late or lost). staff: a staff member tapped "Mark paid".
create type public.settled_via as enum ('square_webhook', 'square_api', 'staff');

-- ---------------------------------------------------------------------------
-- Reference tables
-- ---------------------------------------------------------------------------

create table public.staff (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 60),
  pin_hash    text not null,
  role        public.staff_role not null default 'staff',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index staff_active_name_uniq on public.staff (lower(btrim(name))) where active;

create table public.devices (
  id            uuid primary key default gen_random_uuid(),
  label         text not null check (length(btrim(label)) between 1 and 40),
  enrolled_at   timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid references public.staff (id)
);

create table public.tables (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 40),
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index tables_name_uniq on public.tables (lower(btrim(name)));

create table public.rate_cards (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(btrim(name)) between 1 and 60),
  cents_per_hour  integer not null check (cents_per_hour between 0 and 1000000),
  -- ISO weekdays: 1 = Monday … 7 = Sunday
  days_of_week    smallint[] not null
                    check (cardinality(days_of_week) between 1 and 7
                           and days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  -- Local wall-clock window in settings.timezone. end_local may be 24:00. If end <= start the
  -- window wraps past midnight and days_of_week refers to the day it opens.
  start_local     time not null check (start_local < '24:00' and date_part('second', start_local) = 0),
  end_local       time not null check (end_local > '00:00' and date_part('second', end_local) = 0),
  priority        integer not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint rate_cards_window_nonempty check (start_local <> end_local)
);

create table public.settings (
  id                  boolean primary key default true check (id),  -- single row
  rounding_minutes    integer not null default 5 check (rounding_minutes between 1 and 60),
  grace_minutes       integer not null default 0 check (grace_minutes between 0 and 60),
  minimum_minutes     integer not null default 30 check (minimum_minutes between 0 and 600),
  timezone            text not null default 'Australia/Sydney',
  business_day_start  time not null default '06:00' check (date_part('second', business_day_start) = 0),
  terminal_device_id  text,
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

create table public.sessions (
  id                  uuid primary key default gen_random_uuid(),
  status              public.session_status not null default 'running',
  -- The table this session is occupying right now. Set while running/paused and while the bill is
  -- still "on the table"; cleared when the bill moves to the unpaid list, is paid, or is voided.
  current_table_id    uuid references public.tables (id),
  opened_at           timestamptz not null default now(),
  opened_by           uuid not null references public.staff (id),
  closed_at           timestamptz,
  closed_by           uuid references public.staff (id),
  billed_minutes      integer check (billed_minutes >= 0),
  total_cents         integer check (total_cents >= 0),
  rate_snapshot       jsonb,
  settled_method      public.settled_method,
  settled_via         public.settled_via,
  settled_by          uuid references public.staff (id),
  settled_at          timestamptz,
  square_checkout_id  text,                       -- latest Terminal checkout attempt
  checkout_attempt    integer not null default 0, -- last committed attempt number
  voided_at           timestamptz,
  voided_by           uuid references public.staff (id),
  void_reason         text,
  note                text check (note is null or length(note) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint sessions_live_has_table
    check (status not in ('running', 'paused') or current_table_id is not null),
  constraint sessions_final_has_no_table
    check (status not in ('paid', 'void') or current_table_id is null),
  constraint sessions_closed_is_priced
    check (status not in ('awaiting_payment', 'paid')
           or (closed_at is not null and billed_minutes is not null
               and total_cents is not null and rate_snapshot is not null)),
  constraint sessions_paid_is_settled
    check (status <> 'paid'
           or (settled_method is not null and settled_via is not null and settled_at is not null)),
  constraint sessions_unpaid_is_unsettled
    check (status = 'paid' or (settled_method is null and settled_via is null and settled_at is null)),
  constraint sessions_staff_settlement_has_actor
    check (settled_via is distinct from 'staff' or settled_by is not null),
  constraint sessions_void_has_reason
    check (status <> 'void'
           or (voided_at is not null and voided_by is not null
               and length(btrim(coalesce(void_reason, ''))) > 0)),
  constraint sessions_closed_after_opened
    check (closed_at is null or closed_at >= opened_at)
);

-- One session per table at a time (also protects against two iPads tapping Start together).
create unique index sessions_one_per_table on public.sessions (current_table_id)
  where current_table_id is not null;
create index sessions_open_status on public.sessions (status)
  where status in ('running', 'paused', 'awaiting_payment');
create index sessions_closed_at on public.sessions (closed_at);
create index sessions_settled_at on public.sessions (settled_at);
create index sessions_voided_at on public.sessions (voided_at);

create table public.session_intervals (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions (id),
  table_id    uuid not null references public.tables (id),
  started_at  timestamptz not null,
  ended_at    timestamptz,   -- null while running
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint session_intervals_ordered check (ended_at is null or ended_at >= started_at),
  -- No two intervals may bill the same table at the same instant (catches bad manual time edits).
  -- Deferred to commit so a multi-row time edit isn't rejected on an intermediate state.
  constraint session_intervals_no_table_overlap exclude using gist (
    table_id with =,
    tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz), '[)') with &&
  ) deferrable initially deferred,
  -- A session can't be on two tables at once.
  constraint session_intervals_no_session_overlap exclude using gist (
    session_id with =,
    tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz), '[)') with &&
  ) deferrable initially deferred
);

-- Required by the brief: at most one open interval per table and per session.
create unique index session_intervals_one_open_per_table on public.session_intervals (table_id)
  where ended_at is null;
create unique index session_intervals_one_open_per_session on public.session_intervals (session_id)
  where ended_at is null;
create index session_intervals_by_session on public.session_intervals (session_id, started_at);

-- Every Terminal checkout attempt for a session. Only Square checkout ids are stored — no payment or
-- card data.
create table public.terminal_checkouts (
  id              text primary key,  -- Square terminal checkout id
  session_id      uuid not null references public.sessions (id),
  attempt         integer not null check (attempt >= 1),
  amount_cents    integer not null check (amount_cents > 0),
  status          text not null
                    check (status in ('PENDING', 'IN_PROGRESS', 'CANCEL_REQUESTED', 'CANCELED', 'COMPLETED')),
  cancel_reason   text,
  created_by      uuid references public.staff (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_synced_at  timestamptz,
  unique (session_id, attempt)
);
create index terminal_checkouts_live on public.terminal_checkouts (session_id)
  where status in ('PENDING', 'IN_PROGRESS', 'CANCEL_REQUESTED');

-- ---------------------------------------------------------------------------
-- Webhooks, audit, login throttling
-- ---------------------------------------------------------------------------

create table public.webhook_events (
  event_id     text primary key,
  received_at  timestamptz not null default now(),
  type         text not null
);

create table public.audit_log (
  id                    bigint generated always as identity primary key,
  at                    timestamptz not null default now(),
  actor_staff_id        uuid references public.staff (id),  -- null = system (e.g. Square webhook)
  approved_by_staff_id  uuid references public.staff (id),  -- manager who entered their PIN
  device_label          text,
  action                text not null,
  entity                text not null,
  entity_id             text,
  before                jsonb,
  after                 jsonb,
  reason                text
);
create index audit_log_at on public.audit_log (at desc);
create index audit_log_entity on public.audit_log (entity, entity_id, at desc);
create index audit_log_action on public.audit_log (action, at desc);

create table public.login_attempts (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('enrol', 'login', 'manager')),
  device_id  uuid references public.devices (id),
  staff_id   uuid references public.staff (id),
  ip         text,
  success    boolean not null
);
create index login_attempts_device on public.login_attempts (device_id, at desc);
create index login_attempts_staff on public.login_attempts (staff_id, at desc);
create index login_attempts_ip on public.login_attempts (ip, at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger staff_touch before update on public.staff
  for each row execute function public.touch_updated_at();
create trigger tables_touch before update on public.tables
  for each row execute function public.touch_updated_at();
create trigger rate_cards_touch before update on public.rate_cards
  for each row execute function public.touch_updated_at();
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();
create trigger sessions_touch before update on public.sessions
  for each row execute function public.touch_updated_at();
create trigger session_intervals_touch before update on public.session_intervals
  for each row execute function public.touch_updated_at();
create trigger terminal_checkouts_touch before update on public.terminal_checkouts
  for each row execute function public.touch_updated_at();

-- Hard guard: refuse UPDATE/DELETE/TRUNCATE no matter which role or privilege tries it.
create function public.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% on %.% is not permitted (%).', tg_op, tg_table_schema, tg_table_name, tg_argv[0]
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_log_no_update before update on public.audit_log
  for each row execute function public.forbid_mutation('audit log is append-only');
create trigger audit_log_no_delete before delete on public.audit_log
  for each row execute function public.forbid_mutation('audit log is append-only');
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.forbid_mutation('audit log is append-only');

create trigger sessions_no_delete before delete on public.sessions
  for each row execute function public.forbid_mutation('sessions are never deleted; void instead');
create trigger sessions_no_truncate before truncate on public.sessions
  for each statement execute function public.forbid_mutation('sessions are never deleted; void instead');
create trigger session_intervals_no_delete before delete on public.session_intervals
  for each row execute function public.forbid_mutation('intervals are never deleted');
create trigger session_intervals_no_truncate before truncate on public.session_intervals
  for each statement execute function public.forbid_mutation('intervals are never deleted');
create trigger terminal_checkouts_no_delete before delete on public.terminal_checkouts
  for each row execute function public.forbid_mutation('checkout history is never deleted');

-- Realtime: after any change that affects the floor, broadcast a data-free "changed" ping on the
-- public topic 'floor'. Clients refetch through authenticated routes, so no business data ever
-- leaves via Realtime and RLS can stay deny-all for the API roles. Failures only warn: a broadcast
-- problem must never roll back a bill.
create function public.broadcast_floor_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('entity', tg_table_name, 'at', now()),
      'changed',
      'floor',
      false
    );
  exception when others then
    raise warning 'floor broadcast failed: %', sqlerrm;
  end;
  return null;
end;
$$;

create trigger sessions_broadcast after insert or update on public.sessions
  for each statement execute function public.broadcast_floor_change();
create trigger session_intervals_broadcast after insert or update on public.session_intervals
  for each statement execute function public.broadcast_floor_change();
create trigger terminal_checkouts_broadcast after insert or update on public.terminal_checkouts
  for each statement execute function public.broadcast_floor_change();
create trigger tables_broadcast after insert or update on public.tables
  for each statement execute function public.broadcast_floor_change();
create trigger rate_cards_broadcast after insert or update on public.rate_cards
  for each statement execute function public.broadcast_floor_change();
create trigger settings_broadcast after insert or update on public.settings
  for each statement execute function public.broadcast_floor_change();

-- ---------------------------------------------------------------------------
-- Roles, grants, RLS
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'timer_app') then
    -- NOLOGIN here; a password is set out-of-band (see README) so no secret lives in git.
    create role timer_app nologin noinherit;
  end if;
end;
$$;

-- Supabase grants the API roles full table access by default. Take it all back.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- service_role is unused by the app, but must not be able to erase history either.
revoke update, delete, truncate on public.audit_log from service_role;
revoke delete, truncate on public.sessions, public.session_intervals, public.terminal_checkouts
  from service_role;

grant usage on schema public to timer_app;
grant select, insert, update on
  public.staff, public.devices, public.tables, public.rate_cards, public.settings,
  public.sessions, public.session_intervals, public.terminal_checkouts
  to timer_app;
grant select, insert on public.audit_log, public.webhook_events, public.login_attempts to timer_app;
grant usage on all sequences in schema public to timer_app;
grant execute on function public.touch_updated_at() to timer_app;
grant execute on function public.forbid_mutation() to timer_app;

alter table public.staff               enable row level security;
alter table public.devices             enable row level security;
alter table public.tables              enable row level security;
alter table public.rate_cards          enable row level security;
alter table public.settings            enable row level security;
alter table public.sessions            enable row level security;
alter table public.session_intervals   enable row level security;
alter table public.terminal_checkouts  enable row level security;
alter table public.webhook_events      enable row level security;
alter table public.audit_log           enable row level security;
alter table public.login_attempts      enable row level security;

-- No policies exist for anon/authenticated, so RLS denies them everything.
-- timer_app (the server) gets explicit policies matching its grants. No DELETE policy anywhere.
create policy timer_app_select on public.staff for select to timer_app using (true);
create policy timer_app_insert on public.staff for insert to timer_app with check (true);
create policy timer_app_update on public.staff for update to timer_app using (true) with check (true);

create policy timer_app_select on public.devices for select to timer_app using (true);
create policy timer_app_insert on public.devices for insert to timer_app with check (true);
create policy timer_app_update on public.devices for update to timer_app using (true) with check (true);

create policy timer_app_select on public.tables for select to timer_app using (true);
create policy timer_app_insert on public.tables for insert to timer_app with check (true);
create policy timer_app_update on public.tables for update to timer_app using (true) with check (true);

create policy timer_app_select on public.rate_cards for select to timer_app using (true);
create policy timer_app_insert on public.rate_cards for insert to timer_app with check (true);
create policy timer_app_update on public.rate_cards for update to timer_app using (true) with check (true);

create policy timer_app_select on public.settings for select to timer_app using (true);
create policy timer_app_update on public.settings for update to timer_app using (true) with check (true);

create policy timer_app_select on public.sessions for select to timer_app using (true);
create policy timer_app_insert on public.sessions for insert to timer_app with check (true);
create policy timer_app_update on public.sessions for update to timer_app using (true) with check (true);

create policy timer_app_select on public.session_intervals for select to timer_app using (true);
create policy timer_app_insert on public.session_intervals for insert to timer_app with check (true);
create policy timer_app_update on public.session_intervals for update to timer_app using (true) with check (true);

create policy timer_app_select on public.terminal_checkouts for select to timer_app using (true);
create policy timer_app_insert on public.terminal_checkouts for insert to timer_app with check (true);
create policy timer_app_update on public.terminal_checkouts for update to timer_app using (true) with check (true);

create policy timer_app_select on public.webhook_events for select to timer_app using (true);
create policy timer_app_insert on public.webhook_events for insert to timer_app with check (true);

create policy timer_app_select on public.audit_log for select to timer_app using (true);
create policy timer_app_insert on public.audit_log for insert to timer_app with check (true);

create policy timer_app_select on public.login_attempts for select to timer_app using (true);
create policy timer_app_insert on public.login_attempts for insert to timer_app with check (true);
