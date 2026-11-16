-- Local development seed (runs on `supabase db reset` only).
-- Reference data (7 tables, Standard rate, settings) lives in a migration so production gets it too.
--
-- Local only: give the server role a throwaway password so DATABASE_URL can use it.
-- NEVER run this file against production. In production set the password by hand (README).
alter role timer_app with login password 'local-dev-only-timer-app';
