-- Confirm a Pay / Swap / BulkPay attempt as soon as it is submitted.
--
-- Confirmation used to wait for the next */2 cron sweep (pay-confirm,
-- swap-confirm, bulkpay-confirm), so a payment Arc finalized in ~1s showed
-- as confirmed 17-117s later. This trigger asks the blockchain-indexer to
-- run the SAME canonical confirmation mode the moment an attempt becomes
-- SUBMITTED. Nothing is trusted from the client: the indexer re-verifies
-- sender, nonce, destination and receipt on-chain, and its updates only
-- touch attempts still SUBMITTED/CONFIRMING, so racing the cron sweep is
-- harmless. The cron sweeps stay as the fallback (e.g. a receipt not yet
-- mined when this fires). net.http_post is async: the UPDATE never waits.
create or replace function public.transaction_attempts_confirm_on_submit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mode text;
begin
  begin
    select case i.feature
             when 'pay' then 'pay-confirm'
             when 'swap' then 'swap-confirm'
             when 'bulkpay' then 'bulkpay-confirm'
           end
      into mode
      from transaction_intents i
     where i.id = new.intent_id;
    if mode is not null then
      perform net.http_post(
        url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/blockchain-indexer',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
        ),
        body    := jsonb_build_object('mode', mode)
      );
    end if;
  exception when others then
    -- Never block the submit; the cron sweep confirms it instead.
    raise warning 'transaction_attempts_confirm_on_submit: %', sqlerrm;
  end;
  return new;
end;
$function$;

drop trigger if exists transaction_attempts_confirm_on_submit on public.transaction_attempts;
create trigger transaction_attempts_confirm_on_submit
  after update of status on public.transaction_attempts
  for each row
  when (new.status = 'SUBMITTED' and old.status is distinct from 'SUBMITTED' and new.tx_hash is not null)
  execute function public.transaction_attempts_confirm_on_submit();

-- Safety net: an attempt inserted already SUBMITTED gets the same treatment.
drop trigger if exists transaction_attempts_confirm_on_submit_insert on public.transaction_attempts;
create trigger transaction_attempts_confirm_on_submit_insert
  after insert on public.transaction_attempts
  for each row
  when (new.status = 'SUBMITTED' and new.tx_hash is not null)
  execute function public.transaction_attempts_confirm_on_submit();
