-- Circle's reason for holding a Bring's fast transfer (Iris delayReason:
-- insufficient_fee, amount_above_max, insufficient_allowance_available),
-- kept by the claim worker so a slow Bring can be explained afterwards.
alter table public.claims add column if not exists delay_reason text;
