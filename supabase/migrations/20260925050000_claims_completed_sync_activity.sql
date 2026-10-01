-- When a claim becomes completed (worker, recovery, or a status correction),
-- flip its existing Activity row to completed too. claim-worker's own
-- activity upsert ignores duplicates, so a row first written as 'failed'
-- used to stay failed forever. Insert a missing row only for recoveries
-- (recovered_via set); normal completions are written by claim-worker.
create or replace function public.claims_sync_recovered_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if new.status <> 'completed' then
    return new;
  end if;
  begin
    update activity
       set status = 'completed',
           error = null,
           metadata = case when new.recovered_via is not null
                           then coalesce(metadata, '{}'::jsonb) || jsonb_build_object('recovered_via', new.recovered_via)
                           else metadata end,
           arrived_amount = coalesce(new.arrived_amount, arrived_amount)
     where activity_type = 'claim'
       and tx_hash = lower(new.tx_hash)
       and wallet_address = lower(new.wallet_address);
    get diagnostics n = row_count;
    if n = 0 and new.tx_hash is not null and new.recovered_via is not null then
      insert into activity (wallet_address, tx_hash, activity_type, amount, usd_value, arrived_amount,
                            token_symbol, source_chain, destination_chain, status, metadata)
      values (lower(new.wallet_address), lower(new.tx_hash), 'claim',
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
$$;

drop trigger if exists claims_recovered_activity on public.claims;
create trigger claims_recovered_activity
  after update of status, recovered_via on public.claims
  for each row
  when (new.status = 'completed')
  execute function public.claims_sync_recovered_activity();
