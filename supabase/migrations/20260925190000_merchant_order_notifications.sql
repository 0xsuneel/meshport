-- Order-payment notifications carry the order number, and the customer is
-- told too. (The merchant's generic "Received from" for an order payment is
-- skipped in the app — see lib/notifications.ts — so each order payment
-- gives one notification per side.)
--
--   Merchant: Payment received · Order #…   | Partial payment · Order #…
--             Payment arriving (other chain) · Order #…
--   Customer: Order paid · Order #…          | Partial payment · Order #…
--             Order completed (merchant marked it completed)

create or replace function public.merchant_payments_after_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare who text;
begin
  if new.method = 'external_ub' then
    who := coalesce(nullif(new.customer_username, ''), substr(new.from_address, 1, 6) || '…' || right(new.from_address, 4));
    perform public.merchant_notify(new.merchant_wallet, 'merchant_payment_arriving', 'Payment arriving',
      who || ' paid you $' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC on '
        || public.merchant_chain_label(new.source_chain)
        || coalesce(' · Order #' || new.order_number, '') || ' — moving it to your Ledger');
  end if;
  return new;
end;
$$;

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
begin
  who := coalesce(nullif(new.customer_username, ''), case when new.customer_wallet is not null
           then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end, 'A customer');

  -- Paid in full (real payment).
  if new.status = 'paid' and old.status is distinct from 'paid' and not coalesce(new.completed_by_merchant, false) then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_received', 'Payment received',
              who || ' paid you ' || amt || ord
                || coalesce(' · ' || nullif(new.note, ''), '')
                || case when new.payment_method = 'external_ub' then ' · now in your Arc balance' else '' end, false);
    end if;
    if new.customer_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.customer_user_id, 'merchant_order_paid', 'Order paid',
              'You paid ' || amt || ' to ' || shop || ord, false);
    end if;
  end if;

  -- Part of the order paid.
  if new.status = 'partially_paid' and new.received_amount is distinct from old.received_amount then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_partial', 'Partial payment',
              who || ' paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC' || ord, false);
    end if;
    if new.customer_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.customer_user_id, 'merchant_payment_partial', 'Partial payment',
              'You paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC to ' || shop || ord, false);
    end if;
  end if;

  -- The merchant marked the order completed themselves.
  if new.status = 'paid' and old.status is distinct from 'paid' and coalesce(new.completed_by_merchant, false)
     and new.customer_user_id is not null then
    insert into public.notifications (user_id, type, title, message, read)
    values (new.customer_user_id, 'merchant_order_completed', 'Order completed',
            shop || ' marked' || coalesce(' Order #' || new.order_number, ' your order') || ' as completed', false);
  end if;
  return new;
end;
$$;
