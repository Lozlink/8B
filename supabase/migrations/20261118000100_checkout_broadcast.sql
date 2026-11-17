-- Fewer floor broadcasts from terminal_checkouts.
--
-- The old trigger fired for every INSERT or UPDATE statement on the table, whether or not anything
-- the floor shows had changed, and even when the statement touched no rows. While a card request
-- was waiting, the background check stamped last_synced_at every 15 seconds and each stamp made
-- every iPad refetch the floor.
--
-- Now a broadcast goes out when a checkout is created and when one changes status. Nothing else on
-- the row (last_synced_at, updated_at) is shown anywhere.

drop trigger terminal_checkouts_broadcast on public.terminal_checkouts;

create trigger terminal_checkouts_broadcast_insert after insert on public.terminal_checkouts
  for each statement execute function public.broadcast_floor_change();

-- Row-level so it can look at the change. broadcast_floor_change() returns null, which is ignored
-- for an AFTER trigger. A statement that matches no rows fires nothing.
create trigger terminal_checkouts_broadcast_status after update on public.terminal_checkouts
  for each row when (old.status is distinct from new.status)
  execute function public.broadcast_floor_change();
