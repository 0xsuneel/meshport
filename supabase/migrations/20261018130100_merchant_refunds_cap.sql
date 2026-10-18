-- Refunds on one transfer (chain + tx + merchant wallet) never add up to more
-- than the payment. Serialised per transfer with a transaction-scoped lock so
-- two refunds recorded at once can't both pass. A blocked (screened) sender
-- can't be refunded.
create or replace function public.merchant_refunds_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c text; t text; w text; amt numeric; flag text; used numeric;
begin
  if new.payment_id is not null then
    select source_chain, lower(tx_hash), lower(merchant_wallet), amount, screen_flag into c, t, w, amt, flag from public.merchant_payments where id = new.payment_id;
  elsif new.receipt_id is not null then
    select source_chain, lower(tx_hash), lower(merchant_wallet), amount, screen_flag into c, t, w, amt, flag from public.merchant_chain_receipts where id = new.receipt_id;
  end if;
  if t is null then return new; end if;
  if flag is not null then raise exception 'This payment came from a blocked address and can''t be refunded'; end if;
  perform pg_advisory_xact_lock(hashtextextended('merchant_refund:' || c || ':' || t || ':' || w, 0));
  select coalesce(sum(r.amount), 0) into used
    from public.merchant_refunds r
    left join public.merchant_payments p on p.id = r.payment_id
    left join public.merchant_chain_receipts k on k.id = r.receipt_id
   where r.id is distinct from new.id
     and coalesce(p.source_chain, k.source_chain) = c and lower(coalesce(p.tx_hash, k.tx_hash)) = t
     and lower(coalesce(p.merchant_wallet, k.merchant_wallet)) = w;
  if used + new.amount > amt + 0.000001 then
    raise exception 'Refunds would be more than this payment (% left)', to_char(greatest(amt - used, 0), 'FM999999990.00');
  end if;
  return new;
end $$;
revoke execute on function public.merchant_refunds_cap() from public, anon, authenticated;
drop trigger if exists merchant_refunds_cap on public.merchant_refunds;
create trigger merchant_refunds_cap before insert on public.merchant_refunds
  for each row execute function public.merchant_refunds_cap();
