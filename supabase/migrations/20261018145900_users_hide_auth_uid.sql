-- NOT APPLIED YET. Apply only after the frontend that no longer reads
-- users.auth_uid (merchant.ts / merchantPay.ts use my_profile()) is live -
-- the previous frontend still filters users on auth_uid and would break.
--
-- Access rules and triggers already use the security-definer helpers from
-- 20261018140000-20261018140200, so nothing in the database needs this
-- column to be readable by anon/authenticated. Edge functions use the
-- service role and are unaffected.
revoke select (auth_uid) on public.users from anon, authenticated;
