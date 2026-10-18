-- An order's received total and status, computed from its payments in one
-- locked step (no read-then-write race between the watcher and a submit).
-- A cancelled order stays cancelled (a late payment is still recorded and
-- counted); an order the merchant completed stays paid.
create or replace function public.merchant_intent_recompute(p_intent uuid)
returns public.merchant_payment_intents
language plpgsql security definer set search_path = '' as $$
declare
  i public.merchant_payment_intents;
  last public.merchant_payments;
  total numeric;
  first_from text;
  is_full boolean;
  keep boolean;
begin
  select * into i from public.merchant_payment_intents where id = p_intent for update;
  if i.id is null then return null; end if;
  select coalesce(sum(amount), 0) into total from public.merchant_payments where intent_id = p_intent;
  select * into last from public.merchant_payments where intent_id = p_intent order by created_at desc, id desc limit 1;
  select from_address into first_from from public.merchant_payments where intent_id = p_intent order by created_at asc, id asc limit 1;
  is_full := total > 0 and i.requested_amount - total <= 0.000001;
  keep := i.status = 'cancelled' or (i.status = 'paid' and coalesce(i.completed_by_merchant, false));
  update public.merchant_payment_intents set
    received_amount = round(total, 6),
    overpaid_amount = greatest(round(total - i.requested_amount, 6), 0),
    status = case when keep then i.status
                  when is_full then 'paid'
                  when total > 0 then 'partially_paid'
                  else i.status end,
    paid_at = case when not keep and is_full then coalesce(i.paid_at, now()) else i.paid_at end,
    destination_tx_hash = case when not keep and is_full and last.source_chain = 'Arc_Testnet'
                               then coalesce(i.destination_tx_hash, last.tx_hash) else i.destination_tx_hash end,
    payment_method = coalesce(last.method, i.payment_method),
    source_chain = coalesce(last.source_chain, i.source_chain),
    source_tx_hash = coalesce(last.tx_hash, i.source_tx_hash),
    customer_wallet = coalesce(i.customer_wallet, first_from),
    customer_username = coalesce(i.customer_username, last.customer_username),
    customer_user_id = coalesce(i.customer_user_id, last.customer_user_id)
  where id = p_intent
  returning * into i;
  return i;
end $$;
revoke execute on function public.merchant_intent_recompute(uuid) from public, anon, authenticated;
grant execute on function public.merchant_intent_recompute(uuid) to service_role;
