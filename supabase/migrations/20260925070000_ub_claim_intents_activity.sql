-- Unified Balance claims: show them in Activity / Hub Activity as "Processing"
-- from the moment the deposit is made (like CCTP claims), not only once the
-- funds land on Arc.
--
-- ub_claim_intents is written by the app right after the source-chain
-- deposit; ub-claim-worker moves it waiting → submitted → completed.
-- This trigger keeps ONE activity row (tx_hash = deposit tx) in step:
--   insert            → activity row, status 'pending'
--   status completed  → same row flipped to 'completed' with the Arc mint tx
--   status failed/expired → stays 'pending' (funds are safe in Unified
--                       Balance; the app's auto-finish / Recover completes
--                       the same row when it sends them to Arc).

create or replace function public.ub_claim_intents_sync_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  k text := coalesce(lower(new.deposit_tx), 'ubclaim_' || new.id::text);
  chain text := case when new.source_chain = 'Polygon_Amoy_Testnet' then 'Polygon_Sepolia' else new.source_chain end;
  amt numeric := coalesce(new.send_amount, new.amount);
  n int;
begin
  begin
    if tg_op = 'INSERT' then
      insert into activity (wallet_address, tx_hash, activity_type, amount, usd_value, token_symbol,
                            source_chain, destination_chain, status, explorer_url, metadata, created_at)
      values (lower(new.wallet_address), k, 'claim', amt, amt, 'USDC',
              chain, 'Arc_Testnet', 'pending', null,
              jsonb_build_object('route', 'ub', 'claimed_amount', new.amount, 'ub_intent_id', new.id),
              coalesce(new.created_at, now()))
      on conflict do nothing;
      return new;
    end if;

    if new.status is distinct from old.status then
      if new.status = 'completed' then
        update activity
           set status = 'completed',
               error = null,
               destination_tx_hash = coalesce(lower(new.mint_tx), destination_tx_hash),
               explorer_url = case when new.mint_tx is not null then 'https://testnet.arcscan.app/tx/' || new.mint_tx else explorer_url end,
               amount = amt, usd_value = amt, arrived_amount = amt,
               metadata = coalesce(metadata, '{}'::jsonb)
                          || jsonb_build_object('route', 'ub', 'claimed_amount', new.amount, 'ub_intent_id', new.id, 'server_finished', true)
         where tx_hash = k and wallet_address = lower(new.wallet_address);
        get diagnostics n = row_count;
        if n = 0 then
          insert into activity (wallet_address, tx_hash, destination_tx_hash, activity_type, amount, usd_value, arrived_amount,
                                token_symbol, source_chain, destination_chain, status, explorer_url, metadata)
          values (lower(new.wallet_address), k, lower(new.mint_tx), 'claim', amt, amt, amt,
                  'USDC', chain, 'Arc_Testnet', 'completed',
                  case when new.mint_tx is not null then 'https://testnet.arcscan.app/tx/' || new.mint_tx end,
                  jsonb_build_object('route', 'ub', 'claimed_amount', new.amount, 'ub_intent_id', new.id, 'server_finished', true))
          on conflict do nothing;
        end if;
      elsif new.status in ('failed', 'expired') then
        update activity
           set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('ub_held', true)
         where tx_hash = k and wallet_address = lower(new.wallet_address) and status = 'pending';
      end if;
    end if;
  exception when others then
    raise warning 'ub_claim_intents_sync_activity: %', sqlerrm;
  end;
  return new;
end;
$function$;

drop trigger if exists ub_claim_intents_activity on public.ub_claim_intents;
create trigger ub_claim_intents_activity
  after insert or update on public.ub_claim_intents
  for each row execute function public.ub_claim_intents_sync_activity();

-- Backfill: claims the server is still finishing right now.
insert into activity (wallet_address, tx_hash, activity_type, amount, usd_value, token_symbol,
                      source_chain, destination_chain, status, metadata, created_at)
select lower(i.wallet_address), coalesce(lower(i.deposit_tx), 'ubclaim_' || i.id::text), 'claim',
       coalesce(i.send_amount, i.amount), coalesce(i.send_amount, i.amount), 'USDC',
       case when i.source_chain = 'Polygon_Amoy_Testnet' then 'Polygon_Sepolia' else i.source_chain end,
       'Arc_Testnet', 'pending',
       jsonb_build_object('route', 'ub', 'claimed_amount', i.amount, 'ub_intent_id', i.id),
       i.created_at
  from ub_claim_intents i
 where i.status in ('waiting', 'submitted')
on conflict do nothing;
