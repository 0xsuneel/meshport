-- How a stuck/failed claim was finished ('cctp' | 'ub'); null = normal claim.
alter table public.claims add column if not exists recovered_via text;

-- When a recovered claim completes, make its Activity row say so and show
-- completed (the worker's own activity upsert ignores duplicates, so a row
-- first written as 'failed' would otherwise stay failed forever).
create or replace function public.claims_sync_recovered_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if new.status <> 'completed' or new.recovered_via is null then
    return new;
  end if;
  begin
    update activity
       set status = 'completed',
           error = null,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('recovered_via', new.recovered_via),
           arrived_amount = coalesce(new.arrived_amount, arrived_amount)
     where activity_type = 'claim'
       and tx_hash = lower(new.tx_hash)
       and wallet_address = lower(new.wallet_address);
    get diagnostics n = row_count;
    if n = 0 and new.tx_hash is not null then
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
  when (new.status = 'completed' and new.recovered_via is not null)
  execute function public.claims_sync_recovered_activity();

revoke execute on function public.claims_sync_recovered_activity() from public, anon, authenticated;
