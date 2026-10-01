-- Keep a claim's Arc mint hash on its Activity row too, so claim-recovery-scan
-- (which dedupes on tx_hash OR destination_tx_hash) never records the same
-- mint a second time as "Received from 0x0000…" or a new "Claimed from X".
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
begin
  if new.status <> 'completed' then
    return new;
  end if;
  begin
    update activity
       set status = 'completed',
           error = null,
           destination_tx_hash = coalesce(lower(new.destination_tx_hash), destination_tx_hash),
           metadata = case when new.recovered_via is not null
                           then coalesce(metadata, '{}'::jsonb) || jsonb_build_object('recovered_via', new.recovered_via)
                           else metadata end,
           arrived_amount = coalesce(new.arrived_amount, arrived_amount),
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
              jsonb_build_object('claimed_amount', new.amount, 'recovered_via', new.recovered_via))
      on conflict do nothing;
    end if;
  exception when others then
    raise warning 'claims_sync_recovered_activity: %', sqlerrm;
  end;
  return new;
end;
$function$;

drop trigger if exists claims_recovered_activity on public.claims;
create trigger claims_recovered_activity
  after insert or update on public.claims
  for each row execute function public.claims_sync_recovered_activity();
