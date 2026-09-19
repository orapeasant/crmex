-- Removes demo_sms_usage and consume_demo_sms(): objects from a different
-- project that were created in this database by mistake (confirmed 2026-09-19).
-- Nothing in CRMEX references either — no migration created them, no code calls
-- them, and the function is hard-coded to a single address, demo@adirondax.com.
--
-- A capture migration briefly existed (20260918000000) to stop `migration list`
-- reporting drift. That was the wrong fix: it made CRMEX's migration history
-- claim objects CRMEX does not own. It has been reverted from the remote
-- history and deleted, and this migration removes the objects themselves, so
-- the migrations describe exactly CRMEX and nothing else.

drop function if exists public.consume_demo_sms();
drop table if exists public.demo_sms_usage;
