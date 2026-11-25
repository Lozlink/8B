-- The contact page's form shares the enquiries table with the functions form.
--
--   * enquiries.kind: which form it came from. Anything sent before this is from the functions form.
--     A contact message always has a message, and never has the functions-only details (company,
--     date, how many).
--
-- Additive: the release that is live when this runs keeps working (it never sets kind, and gets the
-- default).
--
-- `set local` only lasts for this transaction. Run outside one it does nothing but warn.
set local lock_timeout = '3s';

alter table public.enquiries
  add column kind text not null default 'functions' check (kind in ('functions', 'contact'));

alter table public.enquiries
  add constraint enquiries_contact_has_message check (kind <> 'contact' or message is not null),
  add constraint enquiries_contact_no_function_details
    check (kind <> 'contact' or (company is null and preferred_date is null and group_size is null));
