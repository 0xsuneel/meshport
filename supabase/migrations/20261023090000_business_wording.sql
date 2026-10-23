-- Notification and error wording matches the app: no "Ledger" (money on
-- other chains is just "on <chain>"), and "Business account" instead of
-- "Merchant account". Type keys (merchant_*) and statuses stay as they are.

create or replace function public.merchant_payments_mark_collected()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  chains text[];
  total numeric;
  names text;
begin
  if new.status is not distinct from old.status then return new; end if;
  select array_agg(case when c = 'Polygon_Amoy_Testnet' then 'Polygon_Sepolia' else c end)
    into chains from unnest(coalesce(new.source_chains, array[new.source_chain])) c;
  select string_agg(distinct public.merchant_chain_label(c), ', ') into names from unnest(chains) c;

  if new.status = 'submitted' then
    with moved as (
      update public.merchant_payments p
         set status = 'in_ledger', ub_intent_id = coalesce(p.ub_intent_id, new.id)
       where p.merchant_wallet = lower(new.wallet_address) and p.source_chain = any(chains)
         and p.method = 'external_ub' and p.status = 'confirmed'
         and (p.ub_intent_id = new.id or (p.ub_intent_id is null and p.created_at <= new.created_at + interval '2 minutes'))
      returning p.amount
    )
    select sum(amount) into total from moved;
    if new.merchant then
      perform public.merchant_notify(new.wallet_address, 'merchant_ledger_moving', 'Funds moving to Arc',
        '$' || trim(to_char(coalesce(new.send_amount, new.amount), 'FM999999990.00')) || ' USDC from ' || names
          || ' is moving to your Arc main balance');
    end if;
  end if;

  if new.status = 'completed' then
    update public.merchant_payments p
       set status = 'collected', collected_at = now(), ub_intent_id = coalesce(p.ub_intent_id, new.id), arc_tx_hash = lower(new.mint_tx)
     where p.merchant_wallet = lower(new.wallet_address) and p.source_chain = any(chains)
       and p.method = 'external_ub' and p.status in ('confirmed', 'in_ledger')
       and (p.ub_intent_id = new.id or (p.ub_intent_id is null and p.created_at <= new.created_at + interval '2 minutes'));

    update public.merchant_chain_receipts r
       set status = 'converted', converted_at = now(), arc_tx_hash = lower(new.mint_tx), ub_intent_id = coalesce(r.ub_intent_id, new.id)
     where r.merchant_wallet = lower(new.wallet_address)
       and (r.ub_intent_id = new.id or (r.status in ('received', 'converting') and r.source_chain = any(chains) and r.created_at <= new.created_at + interval '2 minutes'));

    update public.merchant_payment_intents i
       set status = 'paid', paid_at = coalesce(i.paid_at, now()),
           destination_tx_hash = coalesce(i.destination_tx_hash, lower(new.mint_tx)),
           ub_intent_id = coalesce(i.ub_intent_id, new.id)
     where i.merchant_wallet = lower(new.wallet_address)
       and i.status = 'processing'
       and i.received_amount >= i.requested_amount * 0.999
       and not exists (select 1 from public.merchant_payments p where p.intent_id = i.id and p.method = 'external_ub' and p.status <> 'collected');

    if new.merchant then
      perform public.merchant_notify(new.wallet_address, 'merchant_funds_moved', 'Cross-chain payment received',
        '$' || trim(to_char(coalesce(new.send_amount, new.amount), 'FM999999990.00')) || ' USDC from ' || names
          || ' is now in your Arc main balance');
    end if;
  end if;

  if new.status in ('failed', 'expired') then
    update public.merchant_chain_receipts
       set status = 'received', ub_intent_id = null
     where ub_intent_id = new.id and status = 'converting';
  end if;
  return new;
end $function$;

create or replace function public.merchant_applications_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('meshport.merchant_relink', true), '') = 'on' then return new; end if;
  if new.status is distinct from old.status and new.user_id is not null then
    if new.status = 'approved' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_approved', 'Business account approved',
              'You can now receive payments as ' || new.business_name || '. Open Business to start.', false);
    elsif new.status = 'rejected' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_rejected', 'Business account not approved',
              coalesce(nullif(trim(new.review_note), ''), 'Your business account was not approved.'), false);
    elsif new.status = 'revoked' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_revoked', 'Business access removed',
              coalesce(nullif(trim(new.review_note), ''), 'Your business access was removed by MeshPort.'), false);
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.merchant_applications_business_only()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if not exists (select 1 from public.users where auth_uid = new.auth_uid and account_type = 'business') then
    raise exception 'Business verification is for business accounts. Create a business account at sign-up.'
      using errcode = '42501';
  end if;
  return new;
end $function$;

-- Notifications already sent with the old names read the same way.
update public.notifications set title = 'Funds moving to Arc',
       message = regexp_replace(regexp_replace(message, '^Your Ledger funds - ', ''), ' - are moving to', ' is moving to')
 where title = 'Ledger funds moving to Arc';
update public.notifications set title = 'Cross-chain payment received',
       message = regexp_replace(message, ' USDC from your (.*) Ledger is now', ' USDC from \1 is now')
 where title = 'Ledger payment received';
update public.notifications set title = 'Business account approved' where title = 'Merchant account approved';
update public.notifications set title = 'Business account not approved',
       message = replace(message, 'Your merchant application was not approved.', 'Your business account was not approved.')
 where title = 'Merchant application not approved';
update public.notifications set title = 'Business access removed',
       message = replace(message, 'Your merchant access was removed by MeshPort.', 'Your business access was removed by MeshPort.')
 where title = 'Merchant access removed';
update public.notifications set message = regexp_replace(message, ' from your (.*) Ledger$', ' from \1')
 where title = 'Moved to Arc' and message ~ ' Ledger$';
update public.notifications set message = replace(message, 'Open Multichain Hub → Ledger.', 'Open Business to start.')
 where message like '%Open Multichain Hub → Ledger.%';
