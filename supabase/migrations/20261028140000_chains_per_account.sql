-- Admin Panel → Chains: separate switches for personal and business accounts,
-- and Bring gets route switches like Transfer (src/lib/featureFilters.ts).
--
--   Personal (existing rows, unchanged)       Business (new, biz_ prefix)
--   chains_transfer   <c>_transfer_enabled    biz_chains_transfer
--   chains_ub         <c>_ub_enabled          biz_chains_ub
--   chains_cctp       <c>_cctp_enabled        biz_chains_cctp
--   chains_claim      <c>_claim_enabled       biz_chains_claim
--   chains_claim_ub   <c>_claim_ub_enabled    biz_chains_claim_ub      (new: Bring routes)
--   chains_claim_cctp <c>_claim_cctp_enabled  biz_chains_claim_cctp
--                                             biz_chains_settle  biz_<c>_settle_enabled
--
-- Insert-only. Every new row starts at what applies today, so nothing changes
-- for anyone when this runs:
--   * Bring routes: on (today Bring offers every route a chain supports)
--   * business rows: a copy of the personal row's current value (and reason)
--   * business Settle: the personal Bring switch's current value (Settle has
--     followed it until now)
-- Existing rows are never touched.

-- 1. Personal Bring routes
insert into public.app_settings (feature, enabled, category, label)
select regexp_replace(feature, '_claim_enabled$', '_claim_ub_enabled'), true, 'chains_claim_ub',
       regexp_replace(coalesce(label, feature), '\s*\(.*\)$', '') || ' (Bring · UB)'
from public.app_settings
where category = 'chains_claim' and feature ~ '_claim_enabled$'
on conflict (feature) do nothing;

insert into public.app_settings (feature, enabled, category, label)
select regexp_replace(feature, '_claim_enabled$', '_claim_cctp_enabled'), true, 'chains_claim_cctp',
       regexp_replace(coalesce(label, feature), '\s*\(.*\)$', '') || ' (Bring · CCTP)'
from public.app_settings
where category = 'chains_claim' and feature ~ '_claim_enabled$'
on conflict (feature) do nothing;

-- 2. Business copies of every personal chain and route switch
insert into public.app_settings (feature, enabled, category, label, value)
select 'biz_' || feature, enabled, 'biz_' || category,
       regexp_replace(coalesce(label, feature), '\s*\(.*\)$', '') || ' (Business · ' ||
         case category
           when 'chains_transfer'   then 'Transfer'
           when 'chains_ub'         then 'Transfer UB'
           when 'chains_cctp'       then 'Transfer CCTP'
           when 'chains_claim'      then 'Bring'
           when 'chains_claim_ub'   then 'Bring UB'
           when 'chains_claim_cctp' then 'Bring CCTP'
         end || ')',
       value
from public.app_settings
where category in ('chains_transfer', 'chains_ub', 'chains_cctp', 'chains_claim', 'chains_claim_ub', 'chains_claim_cctp')
  and feature !~ '^biz_'
on conflict (feature) do nothing;

-- 3. Business Settle (always CCTP), starting from today's Bring switch
insert into public.app_settings (feature, enabled, category, label)
select 'biz_' || regexp_replace(feature, '_claim_enabled$', '_settle_enabled'), enabled, 'biz_chains_settle',
       regexp_replace(coalesce(label, feature), '\s*\(.*\)$', '') || ' (Business · Settle)'
from public.app_settings
where category = 'chains_claim' and feature ~ '_claim_enabled$'
on conflict (feature) do nothing;
