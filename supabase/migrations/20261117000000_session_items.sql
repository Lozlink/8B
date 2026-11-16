-- Snacks and drinks on a table's bill.
--
--   * products: a local copy of the fixed-price items in the Square catalogue (id = Square item
--     variation id). Refreshed from Square; never typed in by hand, never deleted (items that leave
--     the catalogue are marked inactive so old bills still resolve).
--   * session_items: what was put on a bill. The name, price and GST flag are copied at the moment
--     the item is added, so a later catalogue change can't alter a bill. Rows are never deleted:
--     taking an item off a bill stamps removed_at / removed_by and keeps the row.
--   * sessions.items_cents: the sum of the session's live (not removed) items. Maintained in the
--     same transaction as every add/remove, under the session row lock. Once a session is closed,
--     total_cents = table time + items_cents.

create table public.products (
  id           text primary key,  -- Square item variation id
  item_id      text not null,     -- Square item id
  name         text not null check (length(btrim(name)) between 1 and 120),
  price_cents  integer not null check (price_cents between 0 and 1000000),
  -- false when the Square item has no tax attached (e.g. GST-free bottled water)
  taxed        boolean not null default true,
  category     text,
  sort_order   integer not null default 0,
  active       boolean not null default true,
  synced_at    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Single row: when the catalogue was last read, and which Square variation is "Table hire".
-- Kept out of `settings` on purpose: settings has a floor-broadcast trigger and this row is written
-- by a background refresh.
create table public.catalog_state (
  id                       boolean primary key default true check (id),
  synced_at                timestamptz,
  table_hire_variation_id  text,
  last_error               text,
  updated_at               timestamptz not null default now()
);
insert into public.catalog_state (id) values (true);

create table public.session_items (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions (id),
  product_id  text not null references public.products (id),
  name        text not null check (length(btrim(name)) between 1 and 120),
  unit_cents  integer not null check (unit_cents between 0 and 1000000),
  quantity    integer not null check (quantity between 1 and 99),
  taxed       boolean not null,
  added_by    uuid not null references public.staff (id),
  added_at    timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  uuid references public.staff (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint session_items_removal_complete check ((removed_at is null) = (removed_by is null))
);
create index session_items_by_session on public.session_items (session_id, added_at);

alter table public.sessions
  add column items_cents integer not null default 0 check (items_cents >= 0),
  add constraint sessions_total_covers_items check (total_cents is null or total_cents >= items_cents);

-- The Square order a checkout attempt was itemised against (null = sent as a plain amount).
alter table public.terminal_checkouts add column square_order_id text;

-- Manager switch: send each charge to Square as an itemised order (table hire + items) instead of
-- a single amount. Turning it off is the fallback if itemised checkouts misbehave on the Terminal.
alter table public.settings add column itemise_charges boolean not null default true;

create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();
create trigger catalog_state_touch before update on public.catalog_state
  for each row execute function public.touch_updated_at();
create trigger session_items_touch before update on public.session_items
  for each row execute function public.touch_updated_at();

create trigger session_items_no_delete before delete on public.session_items
  for each row execute function public.forbid_mutation('bill items are never deleted; remove instead');
create trigger session_items_no_truncate before truncate on public.session_items
  for each statement execute function public.forbid_mutation('bill items are never deleted; remove instead');

-- An item going on or off a bill changes the floor. (products and catalog_state deliberately have
-- no broadcast trigger: the product list rides along with the next floor fetch.)
create trigger session_items_broadcast after insert or update on public.session_items
  for each statement execute function public.broadcast_floor_change();

revoke all on public.products, public.catalog_state, public.session_items from anon, authenticated;
revoke delete, truncate on public.session_items from service_role;

grant select, insert, update on public.products, public.session_items to timer_app;
grant select, update on public.catalog_state to timer_app;

alter table public.products       enable row level security;
alter table public.catalog_state  enable row level security;
alter table public.session_items  enable row level security;

create policy timer_app_select on public.products for select to timer_app using (true);
create policy timer_app_insert on public.products for insert to timer_app with check (true);
create policy timer_app_update on public.products for update to timer_app using (true) with check (true);

create policy timer_app_select on public.catalog_state for select to timer_app using (true);
create policy timer_app_update on public.catalog_state for update to timer_app using (true) with check (true);

create policy timer_app_select on public.session_items for select to timer_app using (true);
create policy timer_app_insert on public.session_items for insert to timer_app with check (true);
create policy timer_app_update on public.session_items for update to timer_app using (true) with check (true);
