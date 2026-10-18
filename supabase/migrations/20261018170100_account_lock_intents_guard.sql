-- Backstop for every server path that reserves a spend (pay-intent,
-- swap-intent, bulkpay-intent all insert here): a wallet owned by a
-- business that isn't approved yet can't create a spend intent, whichever
-- edge-function version is deployed.
create or replace function public.transaction_intents_account_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.wallet_can_spend(new.wallet_address) then
    raise exception 'Available after your business is approved' using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.transaction_intents_account_lock() from public, anon, authenticated;

create or replace trigger transaction_intents_account_lock
  before insert on public.transaction_intents
  for each row execute function public.transaction_intents_account_lock();
