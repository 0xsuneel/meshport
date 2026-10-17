-- Business accounts (approved or not) get their other-chain payments too:
-- merchant-pay now watches their wallet, they can read the receipts, and
-- the notification reaches them. Wording drops "Ledger" (Business tab).
create or replace function public.merchant_notify(p_wallet text, p_type text, p_title text, p_message text)
returns void language sql security definer set search_path = 'public' as $$
  insert into public.notifications (user_id, type, title, message, read)
  select uid, p_type, p_title, p_message, false from (
    select a.user_id::text as uid, 0 as pri from public.merchant_applications a
     where a.wallet_address = lower(p_wallet) and a.status = 'approved' and a.user_id is not null
    union all
    select u.id::text, 1 from public.users u
     where lower(u.wallet_address) = lower(p_wallet) and u.account_type = 'business'
  ) w order by pri limit 1
$$;

create or replace function public.merchant_chain_receipts_notify()
returns trigger language plpgsql security definer set search_path = 'public' as $$
declare
  lbl text := public.merchant_chain_label(new.source_chain);
  amt text := '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC';
begin
  if new.order_number is not null then return new; end if;
  if new.from_address is null or new.from_address = new.merchant_wallet then
    perform public.merchant_notify(new.merchant_wallet, 'merchant_chain_payment', 'Your USDC arrived on ' || lbl,
      amt || ' · ready to settle to Arc');
  else
    perform public.merchant_notify(new.merchant_wallet, 'merchant_chain_payment', 'Payment received on ' || lbl,
      amt || ' from '
        || case when new.from_address = '0x0000000000000000000000000000000000000000' then 'a bridge'
                else substr(new.from_address, 1, 6) || '…' || right(new.from_address, 4) end
        || ' · settle it to Arc from Business');
  end if;
  return new;
end $$;

create policy mcr_select_business on public.merchant_chain_receipts for select to authenticated
  using (merchant_wallet in (select lower(u.wallet_address) from public.users u where u.auth_uid = auth.uid() and u.account_type = 'business'));

-- Order paid on another chain: "Payment received on Base" (no "Ledger").
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.merchant_payment_intents_notify'::regproc);
  d := replace(d, $q$'Payment received in Ledger'$q$, $q$'Payment received on ' || public.merchant_chain_label(new.source_chain)$q$);
  d := replace(d, $q$|| ' · ' || public.merchant_chain_label(new.source_chain) || ' Ledger'$q$, '');
  execute d;
end $do$;

-- A business account's orders aren't "personal" requests: they can be paid
-- on any chain (settled to Arc from Business), like an approved merchant's.
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.merchant_payment_intents_before_write'::regproc);
  if position('new.personal         := true;' in d) > 0 then
    d := replace(d, 'new.personal         := true;', 'new.personal         := coalesce(u.account_type, ''personal'') <> ''business'';');
    execute d;
  end if;
end $do$;
