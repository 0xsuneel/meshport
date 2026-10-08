-- Merchant payment on another chain: the money is in the merchant's wallet on
-- that chain (not the Ledger), and auto-convert was replaced by Claim All.
create or replace function public.merchant_chain_receipts_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare lbl text := public.merchant_chain_label(new.source_chain);
begin
  if new.order_number is null then
    perform public.merchant_notify(new.merchant_wallet, 'merchant_chain_payment', 'Payment received on ' || lbl,
      '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC from '
        || coalesce(substr(new.from_address, 1, 6) || '…' || right(new.from_address, 4), 'a wallet')
        || ' on ' || lbl || ' · use Claim All in Ledger to move it to Arc');
  end if;
  return new;
end $$;
