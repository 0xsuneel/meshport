-- A business whose access MeshPort removed can still move its own money out
-- (pay, transfer, swap, claim from other chains, P2P sell) - removing
-- business access must not freeze the funds in the wallet. What it can't do
-- is take new payments: no requests, bills or Shop QR (Shop QR and bills
-- already need an approved business; plain requests are blocked below).
-- Businesses never approved (none / pending / rejected) stay locked as
-- before.

create or replace function public.account_can_spend(p_auth_uid uuid)
returns boolean language sql stable security definer set search_path to '' as $function$
  select not exists (
    select 1
    from public.users u
    where p_auth_uid is not null
      and u.auth_uid = p_auth_uid
      and u.account_type = 'business'
      and not exists (
        select 1 from public.merchant_applications m
        where m.status in ('approved', 'revoked')
          and (m.auth_uid = p_auth_uid or m.user_id = u.id::text)
      )
  )
$function$;

create or replace function public.wallet_can_spend(p_wallet text)
returns boolean language sql stable security definer set search_path to '' as $function$
  select not exists (
    select 1
    from public.users u
    where coalesce(p_wallet, '') <> ''
      and coalesce(u.wallet_address, '') <> ''
      and lower(u.wallet_address) = lower(p_wallet)
      and u.account_type = 'business'
      and not exists (
        select 1 from public.merchant_applications m
        where m.status in ('approved', 'revoked')
          and ((u.auth_uid is not null and m.auth_uid = u.auth_uid) or m.user_id = u.id::text)
      )
  )
$function$;

-- No new payment requests from a revoked business (its latest application
-- is revoked and none is approved).
do $do$
declare d text; marker text := $q$if new.items is not null then raise exception 'Bills unlock once your business is approved'; end if;$q$;
begin
  d := pg_get_functiondef('public.merchant_payment_intents_before_write'::regproc);
  if position(marker in d) = 0 then raise exception 'merchant_payment_intents_before_write changed - update this migration'; end if;
  if position('Business access was removed' in d) = 0 then
    d := replace(d, marker, $q$if (select m.status from public.merchant_applications m where m.auth_uid = new.merchant_auth_uid
              order by m.created_at desc limit 1) = 'revoked' then
          raise exception 'Business access was removed - you can still send and withdraw your funds, but not take new payments';
        end if;
        $q$ || marker);
    execute d;
  end if;
end $do$;
