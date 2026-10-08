-- Admin switch (Features → Multichain): the wait between a merchant's Claim Alls.
--   on  = wait `value` hours (default 6)   ·   off = no wait (testing)
insert into public.app_settings (feature, enabled, category, label, value)
values ('merchant_claim_all_cooldown', true, 'multichain', 'Claim All wait (hours) — off = no wait', '6')
on conflict (feature) do nothing;
