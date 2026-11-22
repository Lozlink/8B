-- Names on bills, what items cost, and closing the day.
--
--   * sessions.customer_name: who a bill belongs to ("Sam", "Tuesday comp"). Typed in by staff at
--     any time while the bill is open, so a group can be followed when it moves tables or its bill
--     is split. `sessions.note` (there since the first migration, never written until now) holds
--     anything longer.
--   * products.cost_cents: what one unit costs us, EX GST. Typed in by a manager; Square is never
--     asked for it or told it. Null = not entered. The catalogue refresh never touches it.
--   * session_items.unit_cost_cents: the product's cost at the moment the line went on the bill,
--     copied the same way the name and price are, so changing a cost later doesn't rewrite the
--     profit on past sales. Null = the product had no cost then (or the line is a custom charge
--     or a split share). Reports fall back to the product's current cost for a null.
--   * day_closes: one row each time staff close a business day: the cash counted against the cash
--     expected, and the day's figures as they stood. Append-only like the audit log. A day can be
--     closed again (a late sale, a miscount): that adds a row, it never changes the earlier one.
--
-- Everything here is additive: new columns are nullable, so the release that is live when this
-- runs keeps working, and can be rolled back to afterwards.
--
-- `set local` only lasts for this transaction. Run outside one it does nothing but warn.
set local lock_timeout = '3s';

alter table public.sessions
  add column customer_name text check (customer_name is null or length(btrim(customer_name)) between 1 and 40);

alter table public.products
  add column cost_cents integer check (cost_cents is null or cost_cents between 0 and 1000000),
  add column cost_updated_at timestamptz,
  add column cost_updated_by uuid references public.staff (id);

alter table public.session_items
  add column unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents between 0 and 1000000);

create table public.day_closes (
  id                    uuid primary key default gen_random_uuid(),
  -- The business day that was closed (the local date it started on).
  business_date         date not null,
  -- 1 for the day's first close, 2 if it was closed again… The highest is the one that stands.
  seq                   integer not null check (seq >= 1),
  closed_at             timestamptz not null default now(),
  closed_by             uuid not null references public.staff (id),
  -- The manager who entered their PIN. Required to close a day that is already closed.
  approved_by           uuid references public.staff (id),
  device_label          text,
  -- Cash that was in the drawer before the day's first sale.
  float_cents           integer not null check (float_cents between 0 and 10000000),
  -- What staff counted in the drawer at close, float included.
  counted_cash_cents    integer not null check (counted_cash_cents between 0 and 100000000),
  -- float + cash taken − cash refunded, as the app had it at the moment of closing.
  expected_cash_cents   integer not null,
  -- counted − expected. Negative = the drawer is short.
  variance_cents        integer not null,
  -- How the count was made up, when staff counted by note and coin:
  -- { "10000": 2, "5000": 1, … } = face value in cents → how many. Null = a total was typed in.
  cash_counts           jsonb,
  note                  text check (note is null or length(note) <= 500),
  -- Why the day was closed again. Null on the first close.
  reason                text check (reason is null or length(btrim(reason)) between 3 and 500),
  -- The day's figures at the moment of closing (DayCloseTotals in lib/domain/types.ts).
  totals                jsonb not null,
  created_at            timestamptz not null default now(),
  unique (business_date, seq),
  constraint day_closes_variance_adds_up check (variance_cents = counted_cash_cents - expected_cash_cents),
  constraint day_closes_reclose_is_approved check (seq = 1 or (approved_by is not null and reason is not null))
);
create index day_closes_by_date on public.day_closes (business_date desc, seq desc);

create trigger day_closes_no_update before update on public.day_closes
  for each row execute function public.forbid_mutation('a day close is never changed; close the day again instead');
create trigger day_closes_no_delete before delete on public.day_closes
  for each row execute function public.forbid_mutation('a day close is never deleted');
create trigger day_closes_no_truncate before truncate on public.day_closes
  for each statement execute function public.forbid_mutation('a day close is never deleted');

-- Deliberately no floor-broadcast trigger: closing the day changes nothing on the floor.

revoke all on public.day_closes from anon, authenticated;
revoke update, delete, truncate on public.day_closes from service_role;

grant select, insert on public.day_closes to timer_app;

alter table public.day_closes enable row level security;

create policy timer_app_select on public.day_closes for select to timer_app using (true);
create policy timer_app_insert on public.day_closes for insert to timer_app with check (true);
