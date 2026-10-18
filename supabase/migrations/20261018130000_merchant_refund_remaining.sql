-- Several refunds per payment (business refunds): what can still go back on a
-- payment. A payment and the plain receive of the same transfer are the same
-- money, so refunds count per transfer (chain + tx + merchant wallet), whether
-- they were recorded against the payment or the receipt.
-- Used by merchant-refund and /api/bridge-relay before sending/recording.
create or replace function public.merchant_refund_remaining(p_payment uuid default null, p_receipt uuid default null)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare c text; t text; w text; amt numeric; used numeric;
begin
  if p_payment is not null then
    select source_chain, lower(tx_hash), lower(merchant_wallet), amount into c, t, w, amt from public.merchant_payments where id = p_payment;
  elsif p_receipt is not null then
    select source_chain, lower(tx_hash), lower(merchant_wallet), amount into c, t, w, amt from public.merchant_chain_receipts where id = p_receipt;
  end if;
  if t is null then return null; end if;
  select coalesce(sum(r.amount), 0) into used
    from public.merchant_refunds r
    left join public.merchant_payments p on p.id = r.payment_id
    left join public.merchant_chain_receipts k on k.id = r.receipt_id
   where coalesce(p.source_chain, k.source_chain) = c and lower(coalesce(p.tx_hash, k.tx_hash)) = t
     and lower(coalesce(p.merchant_wallet, k.merchant_wallet)) = w;
  return greatest(amt - used, 0);
end $$;
revoke execute on function public.merchant_refund_remaining(uuid, uuid) from public, anon, authenticated;
grant execute on function public.merchant_refund_remaining(uuid, uuid) to service_role;
