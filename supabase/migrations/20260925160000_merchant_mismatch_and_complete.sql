-- Direct deposits whose amount doesn't exactly match, and "Mark as completed".
--
-- The watcher (merchant-pay 'watch') now also handles non-exact amounts:
--   • from the order's named customer, less than due → partial payment
--     (the rest can follow); more than due → paid, shown as overpaid;
--   • from anyone else, within ±10% of an open order's amount → "needs
--     review" (reason 'amount_mismatch'); the merchant picks or dismisses.
-- Merchants can also mark an order completed themselves (e.g. paid in cash
-- or settled another way). That's recorded as completed_by_merchant — no
-- payment row is invented.

alter table public.merchant_unmatched_deposits add column if not exists reason text not null default 'multiple_orders'
  check (reason in ('multiple_orders', 'amount_mismatch'));

alter table public.merchant_payment_intents add column if not exists completed_by_merchant boolean not null default false;
alter table public.merchant_payment_intents add column if not exists completed_at timestamptz;
alter table public.merchant_payment_intents add column if not exists completed_note text;

create or replace function public.merchant_unmatched_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.merchant_notify(
    new.merchant_wallet, 'merchant_payment_review',
    'Payment needs review',
    '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC arrived on ' || public.merchant_chain_label(new.source_chain)
      || case when new.reason = 'amount_mismatch'
              then ' but doesn''t exactly match an open order. Open Ledger to pick the order.'
              else ' and matches more than one open order. Open Ledger to pick the order.' end
  );
  return new;
end;
$$;

-- "Payment received" only when money was actually received — not when the
-- merchant marked the order completed themselves.
create or replace function public.merchant_payment_intents_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare who text;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' and new.merchant_user_id is not null
     and not coalesce(new.completed_by_merchant, false) then
    who := coalesce(nullif(new.customer_username, ''), case when new.customer_wallet is not null
             then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end, 'A customer');
    insert into public.notifications (user_id, type, title, message, read)
    values (new.merchant_user_id, 'merchant_payment_received', 'Payment received',
            who || ' paid you $' || trim(to_char(new.received_amount, 'FM999999990.00')) || ' USDC'
              || coalesce(' · ' || nullif(new.note, ''), '')
              || case when new.payment_method = 'external_ub' then ' · now in your Arc balance' else '' end, false);
  end if;
  return new;
end;
$$;
