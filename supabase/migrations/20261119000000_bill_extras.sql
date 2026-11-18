-- Refunds, receipt reprints, custom charges, counter sales, discounts and split bills.
--
-- Everything here is additive for the release that is live when this runs: new columns have
-- defaults or are nullable, and the two constraints that change are only loosened.
--
-- The bill identity, kept by the application (lib/server/sessions.ts repriceBill) rather than by a
-- constraint, because the table-time part is computed from intervals:
--
--     total_cents = table time + items_cents - discount_cents - split_off_cents      (>= 0)
--
-- Fail fast rather than queue behind an open card charge; safe to rerun if it fails on the lock.
-- `set local` only lasts for this transaction. Run outside one it does nothing but warn.
set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The Square payment a completed card request produced. Needed to refund it or reprint its
--    receipt. Filled when the checkout is seen COMPLETED (webhook, sync, cancel answer).
-- ---------------------------------------------------------------------------
alter table public.terminal_checkouts add column square_payment_id text;

-- ---------------------------------------------------------------------------
-- 2. Bills: kinds, discount, split, refunded total
-- ---------------------------------------------------------------------------
alter table public.sessions
  -- table   = a table's bill (the only kind until now)
  -- counter = a sale with no table: no intervals, no table time
  -- part    = a share split off another bill: no intervals, one 'split' line for its amount
  add column kind text not null default 'table' check (kind in ('table', 'counter', 'part')),
  add column split_of uuid references public.sessions (id),
  -- On the bill that was split: the sum of the amounts of its parts that still stand (not merged
  -- back). Comes off this bill's total, because that money is collected on the parts.
  add column split_off_cents integer not null default 0 check (split_off_cents >= 0),
  -- A part that was folded back into its bill. It is void, but it is not a write-off.
  add column merged boolean not null default false,

  -- One discount per bill, off the whole bill (table time + items).
  add column discount_id text,                 -- Square catalogue discount id; null = typed in by a manager
  add column discount_name text check (discount_name is null or length(btrim(discount_name)) between 1 and 60),
  add column discount_kind text check (discount_kind in ('percent', 'amount')),
  -- percent: basis points (1000 = 10%); amount: cents
  add column discount_value integer check (discount_value > 0),
  -- What the discount takes off right now. Recomputed every time the bill is priced; 0 while the
  -- session is still running (the screens estimate it).
  add column discount_cents integer not null default 0 check (discount_cents >= 0),
  add column discount_by uuid references public.staff (id),
  add column discount_approved_by uuid references public.staff (id),

  -- Sum of this bill's refunds that have not failed (pending + completed).
  add column refunded_cents integer not null default 0 check (refunded_cents >= 0),

  add constraint sessions_part_has_parent check ((kind = 'part') = (split_of is not null)),
  add constraint sessions_merged_is_void_part check (not merged or (kind = 'part' and status = 'void')),
  add constraint sessions_discount_complete check (
    (discount_kind is null and discount_name is null and discount_value is null and discount_id is null
       and discount_by is null and discount_approved_by is null and discount_cents = 0)
    or (discount_kind is not null and discount_name is not null and discount_value is not null
       and discount_by is not null)),
  add constraint sessions_discount_percent_range check (discount_kind is distinct from 'percent' or discount_value <= 10000),
  add constraint sessions_refund_within_paid check (
    refunded_cents = 0 or (settled_cents is not null and refunded_cents <= settled_cents));

create index sessions_parts on public.sessions (split_of) where split_of is not null;

-- With a discount or a split the total can be less than the items on the bill.
alter table public.sessions drop constraint sessions_total_covers_items;

-- Counter sales and parts have no table time, so no rates to capture.
alter table public.sessions drop constraint sessions_closed_is_priced;
alter table public.sessions add constraint sessions_closed_is_priced
  check (status not in ('awaiting_payment', 'paid')
         or (closed_at is not null and billed_minutes is not null and total_cents is not null
             and (rate_snapshot is not null or kind <> 'table')));

-- ---------------------------------------------------------------------------
-- 3. Bill lines that are not catalogue products
-- ---------------------------------------------------------------------------
alter table public.session_items
  alter column product_id drop not null,
  -- product = a Square catalogue item
  -- custom  = a name and price typed in by staff
  -- split   = the single line on a part: its share of the bill it was split from
  add column kind text not null default 'product' check (kind in ('product', 'custom', 'split')),
  add constraint session_items_product_iff_kind check ((kind = 'product') = (product_id is not null));

-- ---------------------------------------------------------------------------
-- 4. Discounts, copied from the Square catalogue like products (never typed in here).
-- ---------------------------------------------------------------------------
create table public.discounts (
  id          text primary key,  -- Square catalogue discount id
  name        text not null check (length(btrim(name)) between 1 and 60),
  -- percent / amount: fixed in Square. variable_*: the value is entered when it is applied.
  kind        text not null check (kind in ('percent', 'amount', 'variable_percent', 'variable_amount')),
  -- basis points or cents; null for the variable kinds
  value       integer check (value > 0),
  active      boolean not null default true,
  synced_at   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint discounts_value_matches_kind check ((kind in ('percent', 'amount')) = (value is not null)),
  constraint discounts_percent_range check (kind <> 'percent' or value <= 10000)
);

create trigger discounts_touch before update on public.discounts
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Refunds. One row per refund a manager asked for. The row is written in the same transaction
--    that takes the amount off what is refundable; Square is called afterwards with a fixed
--    idempotency key and retried in the background until it answers.
-- ---------------------------------------------------------------------------
create table public.refunds (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references public.sessions (id),
  -- nth refund of this bill; part of the Square idempotency key
  seq                integer not null check (seq >= 1),
  square_payment_id  text not null,
  -- how the money goes back: to the card, or cash handed over (recorded in Square)
  method             public.settled_method not null,
  amount_cents       integer not null check (amount_cents > 0),
  reason             text not null check (length(btrim(reason)) between 3 and 500),
  -- pending   = Square has not confirmed it yet (still being sent, or Square says PENDING)
  -- completed = Square says the refund is done
  -- failed    = Square refused it or it failed; nothing was refunded and the amount is refundable again
  state              text not null default 'pending' check (state in ('pending', 'completed', 'failed')),
  square_refund_id   text,
  square_status      text,
  attempts           integer not null default 0,
  last_error         text,
  next_attempt_at    timestamptz not null default now(),
  claimed_at         timestamptz,
  -- Made up by the screen once per refund the manager means to make, and sent again if they retry
  -- after a lost answer. The same request id never makes a second refund: the first one is returned.
  request_id         uuid,
  created_by         uuid not null references public.staff (id),
  approved_by        uuid not null references public.staff (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (session_id, seq)
);
create unique index refunds_request_uniq on public.refunds (request_id) where request_id is not null;
create index refunds_due on public.refunds (next_attempt_at) where state = 'pending';
create index refunds_created_at on public.refunds (created_at);

create trigger refunds_touch before update on public.refunds
  for each row execute function public.touch_updated_at();
create trigger refunds_no_delete before delete on public.refunds
  for each row execute function public.forbid_mutation('refunds are never deleted');
create trigger refunds_no_truncate before truncate on public.refunds
  for each statement execute function public.forbid_mutation('refunds are never deleted');

-- Deliberately NO floor-broadcast trigger on discounts or refunds: both are written by background
-- work that runs after floor fetches (catalogue refresh, refund status checks).

revoke all on public.discounts, public.refunds from anon, authenticated;
revoke delete, truncate on public.refunds from service_role;

grant select, insert, update on public.discounts, public.refunds to timer_app;

alter table public.discounts enable row level security;
alter table public.refunds   enable row level security;

create policy timer_app_select on public.discounts for select to timer_app using (true);
create policy timer_app_insert on public.discounts for insert to timer_app with check (true);
create policy timer_app_update on public.discounts for update to timer_app using (true) with check (true);

create policy timer_app_select on public.refunds for select to timer_app using (true);
create policy timer_app_insert on public.refunds for insert to timer_app with check (true);
create policy timer_app_update on public.refunds for update to timer_app using (true) with check (true);
