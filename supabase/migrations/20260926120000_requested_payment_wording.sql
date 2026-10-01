-- Paid requests (unique order number):
--   personal request → "Requested amount received"
--   merchant request / bill → "Requested payment received"
--   (paid on another chain: "Payment credited to your Base Ledger", unchanged)
-- Activity rows carry merchantPersonal so the app titles them the same way.

create or replace function public.merchant_order_meta(p_order text, p_intent uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'merchantPayment', true,
    'merchantOrder', p_order,
    'merchantName', i.merchant_name,
    'merchantOrderKind', i.kind,
    'merchantPersonal', coalesce(i.personal, false)
  )
  from public.merchant_payment_intents i where i.id = p_intent
$$;

-- Existing rows.
update public.activity a
   set metadata = coalesce(a.metadata, '{}'::jsonb) || jsonb_build_object('merchantPersonal', coalesce(i.personal, false))
  from public.merchant_payments p join public.merchant_payment_intents i on i.id = p.intent_id
 where lower(regexp_replace(a.tx_hash, '^(recv_|send_)', '')) = p.tx_hash
   and ((a.activity_type = 'receive' and lower(a.wallet_address) = p.merchant_wallet)
     or (a.activity_type = 'send' and lower(a.wallet_address) = p.from_address));

create or replace function public.merchant_payment_intents_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  who text;
  ord text := coalesce(' · Order #' || new.order_number, '');
  shop text := coalesce(nullif(new.merchant_name, ''), 'the merchant');
  amt text := '$' || trim(to_char(new.received_amount, 'FM999999990.00')) || ' USDC';
  onchain text := case when new.source_chain is not null and new.source_chain <> 'Arc_Testnet'
                       then ' on ' || public.merchant_chain_label(new.source_chain) else '' end;
begin
  who := coalesce(nullif(new.customer_username, ''), case when new.customer_wallet is not null
           then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end, 'A customer');

  if new.status = 'paid' and old.status is distinct from 'paid' and old.status is distinct from 'processing'
     and not coalesce(new.completed_by_merchant, false) then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_received',
              case when onchain <> '' then 'Payment credited to your ' || public.merchant_chain_label(new.source_chain) || ' Ledger'
                   when coalesce(new.personal, false) then 'Requested amount received'
                   else 'Requested payment received' end,
              who || ' paid you ' || amt || ord || coalesce(' · ' || nullif(new.note, ''), '')
                || case when onchain <> '' then ' · in your ' || public.merchant_chain_label(new.source_chain) || ' Ledger' else '' end, false);
    end if;
    if new.customer_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.customer_user_id, 'merchant_order_paid', 'Order paid',
              'You paid ' || amt || ' to ' || shop || onchain || ord, false);
    end if;
  end if;

  if new.status = 'partially_paid' and new.received_amount is distinct from old.received_amount then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_partial', 'Partial payment',
              who || ' paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC' || onchain || ord, false);
    end if;
    if new.customer_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.customer_user_id, 'merchant_payment_partial', 'Partial payment',
              'You paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC to ' || shop || onchain || ord, false);
    end if;
  end if;

  if new.status = 'paid' and old.status is distinct from 'paid' and coalesce(new.completed_by_merchant, false)
     and new.customer_user_id is not null then
    insert into public.notifications (user_id, type, title, message, read)
    values (new.customer_user_id, 'merchant_order_completed', 'Order completed',
            shop || ' marked' || coalesce(' Order #' || new.order_number, ' your order') || ' as completed', false);
  end if;
  return new;
end;
$$;
