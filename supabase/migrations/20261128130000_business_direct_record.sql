-- Recording a direct payment to a business (28 Nov). The business-direct
-- function finds money that landed in an approved business's Arc wallet
-- without paying an order (a send by username or address, from MeshPort or
-- any wallet), checks it on-chain, and records it here in one step: the
-- direct order and its payment together, so no order matcher can ever see
-- the order half-made.

-- Transfers the function has already looked at and set aside (the owner's
-- own move, MeshPort's contracts, a failed transaction...), so they aren't
-- read from the chain again every few seconds.
create table if not exists public.business_direct_seen (
  tx_hash text not null,
  merchant_wallet text not null,
  result text not null,
  created_at timestamptz not null default now(),
  primary key (tx_hash, merchant_wallet)
);
alter table public.business_direct_seen enable row level security;

-- Receives into approved businesses on Arc that pay nothing yet.
-- `p_min_age`: left alone this long first, so an order's own match always wins.
create or replace function public.business_direct_candidates(p_since timestamptz, p_min_age interval default interval '15 seconds', p_limit int default 50)
returns table (wallet text, tx text, amount numeric, at timestamptz)
language sql stable security definer set search_path to '' as $function$
  select lower(a.wallet_address), lower(substr(a.tx_hash, 6)), a.amount, a.created_at
    from public.activity a
   where a.activity_type = 'receive'
     and a.created_at >= p_since and a.created_at <= now() - p_min_age
     and coalesce(a.token_symbol, 'USDC') = 'USDC'
     and coalesce(a.source_chain, 'Arc_Testnet') = 'Arc_Testnet'
     and a.tx_hash ~* '^recv_0x[0-9a-f]{64}$'
     and lower(a.wallet_address) in (select lower(m.wallet_address) from public.merchant_applications m where m.status = 'approved' and m.wallet_address is not null)
     and not exists (select 1 from public.merchant_payments p
                      where p.source_chain = 'Arc_Testnet' and p.tx_hash = lower(substr(a.tx_hash, 6)) and p.merchant_wallet = lower(a.wallet_address))
     and not exists (select 1 from public.merchant_unmatched_deposits d
                      where d.source_chain = 'Arc_Testnet' and d.tx_hash = lower(substr(a.tx_hash, 6)) and d.merchant_wallet = lower(a.wallet_address))
     and not exists (select 1 from public.business_direct_seen s
                      where s.tx_hash = lower(substr(a.tx_hash, 6)) and s.merchant_wallet = lower(a.wallet_address))
     and not exists (select 1 from public.p2p_trades t where lower(t.tx_hash) = lower(substr(a.tx_hash, 6)))
   order by a.created_at
   limit p_limit
$function$;
revoke execute on function public.business_direct_candidates(timestamptz, interval, int) from anon, authenticated, public;

-- The direct order and its payment, in one step. `p_at`: when it was paid
-- (older payments added afterwards keep their day); `p_quiet`: nobody is
-- notified (those older payments).
create or replace function public.merchant_record_direct(p_wallet text, p_tx text, p_from text, p_amount numeric,
  p_screen text default null, p_at timestamptz default null, p_quiet boolean default false)
returns text language plpgsql security definer set search_path to '' as $function$
declare j jsonb; c record; w text := lower(p_wallet); tx text := lower(p_tx); fr text := lower(p_from); at timestamptz := coalesce(p_at, now());
begin
  if exists (select 1 from public.merchant_payments p where p.source_chain = 'Arc_Testnet' and p.tx_hash = tx and p.merchant_wallet = w) then
    return 'exists';
  end if;
  if p_quiet then perform set_config('meshport.quiet', '1', true); end if;
  j := public.merchant_open_direct_order(w, p_amount);
  if j is null then perform set_config('meshport.quiet', '', true); return 'not_business'; end if;
  if p_at is not null then
    update public.merchant_payment_intents set created_at = at where id = (j->>'id')::uuid;
  end if;
  select u.id::text as id, u.username into c from public.users u where lower(u.wallet_address) = fr limit 1;
  insert into public.merchant_payments (intent_id, merchant_wallet, source_chain, tx_hash, from_address, amount, method, status,
                                        customer_user_id, customer_username, order_number, matched_by, late, screen_flag, arc_tx_hash, created_at)
  values ((j->>'id')::uuid, w, 'Arc_Testnet', tx, fr, round(p_amount, 6), case when c.id is not null then 'arc_direct' else 'external_arc' end, 'confirmed',
          c.id, c.username, j->>'order_number', 'watcher', false, p_screen, tx, at);
  perform public.merchant_intent_recompute((j->>'id')::uuid);
  if p_at is not null then
    update public.merchant_payment_intents set paid_at = at where id = (j->>'id')::uuid and status = 'paid';
  end if;
  perform set_config('meshport.quiet', '', true);
  return 'recorded';
end $function$;
revoke execute on function public.merchant_record_direct(text, text, text, numeric, text, timestamptz, boolean) from anon, authenticated, public;

-- Older payments added back quietly don't move anyone's reward progress.
do $do$
declare d text := pg_get_functiondef('public.merchant_offer_step'::regproc);
begin
  if position('meshport.quiet' in d) > 0 then return; end if;
  if position('begin
  if new.status <> ''confirmed''' in d) = 0 then raise exception 'merchant_offer_step changed - update this migration'; end if;
  d := replace(d, 'begin
  if new.status <> ''confirmed''', 'begin
  if coalesce(current_setting(''meshport.quiet'', true), '''') = ''1'' then return new; end if;
  if new.status <> ''confirmed''');
  execute d;
end $do$;

-- Every minute, but only while money has just landed in an approved business
-- (no edge-function run on quiet minutes). Each run looks every 5 s for ~55 s.
select cron.schedule('business-direct-watch', '* * * * *', $cron$
do $gate$ begin
  if exists (select 1 from public.activity a
              where a.activity_type = 'receive' and a.created_at > now() - interval '10 minutes'
                and lower(a.wallet_address) in (select lower(m.wallet_address) from public.merchant_applications m
                                                 where m.status = 'approved' and m.wallet_address is not null)) then
    perform net.http_post(
      url := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/business-direct',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')),
      body := '{}'::jsonb, timeout_milliseconds := 30000);
  end if;
end $gate$;
$cron$);
