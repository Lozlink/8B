-- Reference data the app needs in every environment (local and production).
-- Idempotent: safe if re-applied. No staff are seeded — the first manager is created
-- on the first enrolled device (see README "First run"), so no default PIN ever exists.

insert into public.settings (id, rounding_minutes, grace_minutes, minimum_minutes, timezone, business_day_start)
values (true, 5, 0, 30, 'Australia/Sydney', '06:00')
on conflict (id) do nothing;

insert into public.tables (name, sort_order)
select 'Table ' || n, n
from generate_series(1, 7) as n
where not exists (select 1 from public.tables);

insert into public.rate_cards (name, cents_per_hour, days_of_week, start_local, end_local, priority)
select 'Standard', 2500, array[1, 2, 3, 4, 5, 6, 7]::smallint[], '00:00', '24:00', 0
where not exists (select 1 from public.rate_cards);
