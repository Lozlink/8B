-- Catch-up for databases that ran 20261119000000_bill_extras.sql before refunds.request_id was
-- added to it. On a database built from the current files this changes nothing.
set local lock_timeout = '3s';

alter table public.refunds add column if not exists request_id uuid;
create unique index if not exists refunds_request_uniq
  on public.refunds (request_id) where request_id is not null;
