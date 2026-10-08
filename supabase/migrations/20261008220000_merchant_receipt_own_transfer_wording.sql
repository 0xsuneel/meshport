-- Merchant receipt notifications: the merchant's own Transfer Funds from Arc
-- (sender = their own address) vs someone paying them (a wallet, or 0x0 for
-- a payment through a bridge).
create or replace function public.merchant_chain_receipts_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
  lbl text := public.merchant_chain_label(new.source_chain);
  amt text := '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC';
begin
  if new.order_number is not null then return new; end if;
  if new.from_address is null or new.from_address = new.merchant_wallet then
    perform public.merchant_notify(new.merchant_wallet, 'merchant_chain_payment', 'Own Ledger payment received · ' || lbl,
      amt || ' from your Arc balance is in your ' || lbl || ' Ledger · use Claim All to move it back to Arc');
  else
    perform public.merchant_notify(new.merchant_wallet, 'merchant_chain_payment', 'Payment received in Ledger (' || lbl || ')',
      amt || ' from '
        || case when new.from_address = '0x0000000000000000000000000000000000000000' then 'a bridge (CCTP)'
                else substr(new.from_address, 1, 6) || '…' || right(new.from_address, 4) end
        || ' on ' || lbl || ' · use Claim All in Ledger to move it to Arc');
  end if;
  return new;
end $$;
