-- One refund per transfer per merchant (a tx paying two merchants can be
-- refunded by each).
create or replace function public.merchant_refunds_one_per_tx()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c text; t text; w text;
begin
  if new.payment_id is not null then
    select source_chain, lower(tx_hash), lower(merchant_wallet) into c, t, w from public.merchant_payments where id = new.payment_id;
  elsif new.receipt_id is not null then
    select source_chain, lower(tx_hash), lower(merchant_wallet) into c, t, w from public.merchant_chain_receipts where id = new.receipt_id;
  end if;
  if t is not null and exists (
    select 1 from public.merchant_refunds r
      left join public.merchant_payments p on p.id = r.payment_id
      left join public.merchant_chain_receipts k on k.id = r.receipt_id
     where r.id is distinct from new.id
       and coalesce(p.source_chain, k.source_chain) = c and lower(coalesce(p.tx_hash, k.tx_hash)) = t
       and lower(coalesce(p.merchant_wallet, k.merchant_wallet)) = w) then
    raise exception 'This payment was already refunded';
  end if;
  return new;
end $$;
revoke execute on function public.merchant_refunds_one_per_tx() from public, anon, authenticated;
