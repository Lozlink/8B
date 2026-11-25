-- Enquiries sent from the public site's functions form.
--
--   * enquiries: one row per form sent. What the person typed is never changed afterwards: the app
--     can only mark a row as dealt with (who and when), or undo that. Never deleted.
--   * source_hash: a keyed hash of the sender's IP address (HMAC with the server's secret), so
--     someone sending over and over can be slowed down without the address itself being kept.
--
-- Additive only: the release that is live when this runs never reads the table.
--
-- `set local` only lasts for this transaction. Run outside one it does nothing but warn.
set local lock_timeout = '3s';

create table public.enquiries (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  name            text not null check (length(btrim(name)) between 1 and 80),
  company         text check (company is null or length(btrim(company)) between 1 and 120),
  email           text not null check (length(email) between 3 and 254 and position('@' in email) > 1),
  phone           text check (phone is null or length(phone) between 6 and 30),
  -- The day they have in mind, if they said. A plain date on the venue's calendar.
  preferred_date  date,
  group_size      integer check (group_size is null or group_size between 1 and 500),
  message         text check (message is null or length(message) between 1 and 2000),
  source_hash     text not null check (length(source_hash) = 64),
  handled_at      timestamptz,
  handled_by      uuid references public.staff (id),
  constraint enquiries_handled_together check ((handled_at is null) = (handled_by is null))
);
create index enquiries_newest on public.enquiries (created_at desc);
create index enquiries_by_source on public.enquiries (source_hash, created_at desc);

create trigger enquiries_no_delete before delete on public.enquiries
  for each row execute function public.forbid_mutation('an enquiry is never deleted');
create trigger enquiries_no_truncate before truncate on public.enquiries
  for each statement execute function public.forbid_mutation('an enquiry is never deleted');

revoke all on public.enquiries from anon, authenticated;
revoke delete, truncate on public.enquiries from service_role;

grant select, insert on public.enquiries to timer_app;
-- Only whether it has been dealt with can change. What was sent stays exactly as sent.
grant update (handled_at, handled_by) on public.enquiries to timer_app;

alter table public.enquiries enable row level security;

create policy timer_app_select on public.enquiries for select to timer_app using (true);
create policy timer_app_insert on public.enquiries for insert to timer_app with check (true);
create policy timer_app_update on public.enquiries for update to timer_app using (true) with check (true);
