-- Stock levels and barcodes for the items sold from the Square catalogue.
--
-- Square holds the stock counts: counting and receiving happen there, and the app keeps a copy to
-- show staff. The one thing the app sends is the sales Square can't see item by item.
--
--   * products.barcode / sku: copied from the Square item variation (its GTIN and SKU) on every
--     catalogue refresh, so a scanned barcode can be matched to an item without calling Square.
--   * products.tracked / stock_count / stock_at: whether Square tracks stock for the variation at
--     our location, Square's IN_STOCK count, and when Square worked that count out.
--   * stock_moves: what Square's stock has been told about each paid bill. A bill paid against an
--     itemised Square order has its stock taken off by Square itself; every other paid bill (a
--     plain amount, a split bill, cash taken in Square POS, a card marked paid by hand, a $0 bill)
--     is taken off by the app with an inventory adjustment. A paid bill that is reopened gets its
--     stock put back the same way. Rows are written by a background pass, never by the request
--     that takes the payment, so Square being slow or down never holds up the till.
--
-- Everything here is additive: new columns have defaults or are nullable, so the release that is
-- live when this runs keeps working.
--
-- `set local` only lasts for this transaction. Run outside one it does nothing but warn.
set local lock_timeout = '3s';

alter table public.products
  -- Digits only (a GTIN: 8, 12, 13 or 14 digits). Null = the item has no barcode in Square.
  add column barcode      text check (barcode is null or barcode ~ '^[0-9]{6,14}$'),
  add column sku          text check (sku is null or length(sku) between 1 and 120),
  -- true when Square tracks stock for this variation at our location.
  add column tracked      boolean not null default false,
  -- Square's IN_STOCK count, rounded down to a whole unit. Can be negative (Square lets a sale go
  -- through with nothing counted in). Null = not tracked, or never counted in Square.
  add column stock_count  integer,
  -- Square's `calculated_at` for that count. An older reading never overwrites a newer one.
  add column stock_at     timestamptz,
  -- When the item last became tracked (set by the catalogue refresh when `tracked` goes from false
  -- to true, or a new item arrives tracked). Square's opening count for an item excludes every
  -- sale before then, so bills opened before it are ignored for this item, in both directions.
  -- Null on a tracked item = unknown, so ignored too.
  add column tracked_since timestamptz;

-- A scan looks an item up by its barcode. Not unique: Square doesn't stop two items sharing one.
create index products_by_barcode on public.products (barcode) where barcode is not null and active;

alter table public.catalog_state
  -- When stock counts were last read from Square (the time of the attempt, like synced_at).
  add column stock_synced_at  timestamptz,
  -- Why the last stock read failed, if it did.
  add column stock_error      text,
  -- Bills paid before this moment are never touched: their stock was dealt with by hand, or not
  -- at all, before the app knew about stock.
  add column stock_from       timestamptz not null default now(),
  -- Set when the catalogue has an item whose tax is added on top of the price instead of being
  -- included in it. Such an item can't be charged itemised (Square's total would differ from ours).
  add column tax_warning      text;

create table public.stock_moves (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references public.sessions (id),
  -- 1 for the bill's first move, 2 for its second… Part of the Square idempotency key.
  seq              integer not null check (seq >= 1),
  -- sale    = the bill was paid: its items leave stock
  -- restock = the paid bill was reopened: the same items go back
  kind             text not null check (kind in ('sale', 'restock')),
  -- square = a paid Square order of this bill took the stock off itself (see source_order_id).
  --          Evidence of what Square did; nothing is ever sent for it
  -- app    = the app sends (or sent) an inventory adjustment
  via              text not null check (via in ('square', 'app')),
  -- [{ "productId": "<Square variation id>", "quantity": 2 }, …]. An app move holds only items
  -- Square tracks stock for. A Square row holds every catalogue line of the paid order, tracked or
  -- not (whether an item counts is decided when the row is read). May be empty: the row then only
  -- records that the order has been looked at.
  lines            jsonb not null default '[]'::jsonb,
  -- pending = still to be sent to Square
  -- done    = Square's stock reflects it
  -- failed  = Square refused it, or it kept failing; needs a manager to retry
  state            text not null default 'pending' check (state in ('pending', 'done', 'failed')),
  -- Sent as the adjustment's `occurred_at`. Fixed the first time the row is sent, so every retry
  -- under the same idempotency key carries the same body.
  occurred_at      timestamptz,
  attempts         integer not null default 0,
  last_error       text,
  next_attempt_at  timestamptz not null default now(),
  -- Set by the worker that is talking to Square about this row right now.
  claimed_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- For via = 'square': the Square order whose payment took the stock. One row per paid order, so
  -- recording an order twice (two passes at once, or the same order seen again) is harmless.
  source_order_id  text,
  -- True when it failed because Square refused it (as opposed to never answering). A refused move
  -- is retried with its original occurred_at; one that got no answer may have been applied, so a
  -- stale occurred_at is refreshed on retry and Square's key tells us if it was.
  refused          boolean not null default false,
  unique (session_id, seq),
  constraint stock_moves_square_is_done check (via <> 'square' or state = 'done')
);
create index stock_moves_due on public.stock_moves (next_attempt_at) where state = 'pending';
create index stock_moves_failed on public.stock_moves (created_at) where state = 'failed';
create unique index stock_moves_source_order on public.stock_moves (source_order_id) where source_order_id is not null;
-- The background pass looks at bills and moves that changed lately.
create index stock_moves_by_updated on public.stock_moves (updated_at);
create index sessions_by_updated on public.sessions (updated_at);
create index square_cash_records_by_updated on public.square_cash_records (updated_at);

create trigger stock_moves_touch before update on public.stock_moves
  for each row execute function public.touch_updated_at();

create trigger stock_moves_no_delete before delete on public.stock_moves
  for each row execute function public.forbid_mutation('stock moves are never deleted');
create trigger stock_moves_no_truncate before truncate on public.stock_moves
  for each statement execute function public.forbid_mutation('stock moves are never deleted');

-- Deliberately NO floor-broadcast trigger on stock_moves (or on products, as before): both are
-- written by background passes that run after every floor fetch. New stock figures reach each
-- iPad with its next floor fetch.

revoke all on public.stock_moves from anon, authenticated;
revoke delete, truncate on public.stock_moves from service_role;

grant select, insert, update on public.stock_moves to timer_app;

alter table public.stock_moves enable row level security;

create policy timer_app_select on public.stock_moves for select to timer_app using (true);
create policy timer_app_insert on public.stock_moves for insert to timer_app with check (true);
create policy timer_app_update on public.stock_moves for update to timer_app using (true) with check (true);
