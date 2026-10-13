-- Bring fees in Activity, and Activity follows a corrected claim.
--
-- 1. claims.meshport_fee: MeshPort's fee taken on the source chain before a
--    gasless bring's burn (claims.amount is the burned amount, after it).
--    Display only - Activity shows the fees a person actually paid.
-- 2. claims_sync_recovered_activity also moves activity.amount to the
--    arrived amount. It used to update arrived_amount only, so a claim whose
--    mint was first matched to the wrong claim (and later corrected) kept
--    the wrong amount in Activity. Also copies claimed_amount and
--    meshport_fee into the row's metadata.
-- Additive: existing rows and other routes are unaffected.

alter table public.claims add column if not exists meshport_fee numeric;

create or replace function public.claims_sync_recovered_activity()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  n int;
  recovered_now boolean := new.recovered_via is not null
    and (tg_op = 'UPDATE' and old.status is distinct from 'completed');
  fee_meta jsonb := jsonb_build_object('claimed_amount', new.amount)
    || case when new.meshport_fee is not null then jsonb_build_object('meshport_fee', new.meshport_fee) else '{}'::jsonb end;
begin
  if new.status <> 'completed' then
    return new;
  end if;
  begin
    update activity
       set status = 'completed',
           error = null,
           destination_tx_hash = coalesce(lower(new.destination_tx_hash), destination_tx_hash),
           metadata = coalesce(metadata, '{}'::jsonb) || fee_meta
                      || case when new.recovered_via is not null
                              then jsonb_build_object('recovered_via', new.recovered_via)
                              else '{}'::jsonb end,
           arrived_amount = coalesce(new.arrived_amount, arrived_amount),
           amount = coalesce(new.arrived_amount, amount),
           usd_value = coalesce(new.arrived_amount, usd_value),
           created_at = case when recovered_now then coalesce(new.completed_at, now()) else created_at end
     where activity_type = 'claim'
       and tx_hash = lower(new.tx_hash)
       and wallet_address = lower(new.wallet_address);
    get diagnostics n = row_count;
    if n = 0 and new.tx_hash is not null and new.recovered_via is not null then
      insert into activity (wallet_address, tx_hash, destination_tx_hash, activity_type, amount, usd_value, arrived_amount,
                            token_symbol, source_chain, destination_chain, status, metadata)
      values (lower(new.wallet_address), lower(new.tx_hash), lower(new.destination_tx_hash), 'claim',
              coalesce(new.arrived_amount, new.amount), coalesce(new.arrived_amount, new.amount), new.arrived_amount,
              'USDC', new.source_chain, 'Arc_Testnet', 'completed',
              fee_meta || jsonb_build_object('recovered_via', new.recovered_via))
      on conflict do nothing;
    end if;
  exception when others then
    raise warning 'claims_sync_recovered_activity: %', sqlerrm;
  end;
  return new;
end;
$function$;
