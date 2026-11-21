-- Item pictures from the Square catalogue.
--
--   * products.image_url: the URL of the item's picture in Square (the variation's own picture if
--     it has one, else the item's first), copied on every catalogue refresh like the name and
--     price. Null = the item has no picture in Square.
--
-- Additive and nullable, so the release that is live when this runs keeps working. Existing rows
-- get their picture on the next catalogue refresh (within 10 minutes, or Admin → Items → Refresh).
--
-- `set local` only lasts for this transaction. Run outside one it does nothing but warn.
set local lock_timeout = '3s';

alter table public.products
  add column image_url text check (image_url is null or (image_url ~ '^https://' and length(image_url) <= 500));
