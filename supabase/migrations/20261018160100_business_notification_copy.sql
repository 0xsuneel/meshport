-- Business notifications pointed at screens that no longer exist or told the
-- wrong person what happened:
--   * approval said "Open Multichain Hub → Ledger" - business tools live in Business now;
--   * a payment needing review said "Open Ledger" - it's Business → Help & disputes;
--   * a staff invite said "Open Business to accept" - staff use personal
--     accounts, which have no Business tab (Staff mode is on Home → More);
--   * a bill paid by someone other than its customer said "$x from <customer>"
--     to the merchant and "You paid" to the customer who didn't pay. The
--     payer now comes from the payment itself.
-- Bodies are otherwise the live definitions.

create or replace function public.merchant_applications_notify()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  -- A duplicate closed while relinking a sign-in isn't a review decision.
  if coalesce(current_setting('meshport.merchant_relink', true), '') = 'on' then return new; end if;
  if new.status is distinct from old.status and new.user_id is not null then
    if new.status = 'approved' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_approved', 'Merchant account approved',
              'You can now receive payments as ' || new.business_name || '. Open Business to start.', false);
    elsif new.status = 'rejected' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_rejected', 'Merchant application not approved',
              coalesce(nullif(trim(new.review_note), ''), 'Your merchant application was not approved.'), false);
    elsif new.status = 'revoked' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_revoked', 'Merchant access removed',
              coalesce(nullif(trim(new.review_note), ''), 'Your merchant access was removed by MeshPort.'), false);
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.merchant_unmatched_notify()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  perform public.merchant_notify(
    new.merchant_wallet, 'merchant_payment_review',
    'Payment needs review',
    '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC arrived on ' || public.merchant_chain_label(new.source_chain)
      || case when new.reason = 'amount_mismatch'
              then ' but doesn''t exactly match an open order. Open Business → Help & disputes to pick the order.'
              else ' and matches more than one open order. Open Business → Help & disputes to pick the order.' end
  );
  return new;
end;
$function$;

create or replace function public.business_staff_invite(p_username text, p_role text, p_store uuid default null::uuid)
 returns business_staff language plpgsql security definer set search_path to ''
as $function$
declare me record; them record; r public.business_staff; uname text := lower(regexp_replace(trim(coalesce(p_username, '')), '(^@|\.arc$)', '', 'g'));
begin
  select id, auth_uid, account_type, coalesce(nullif(store_name, ''), username) as shop into me from public.users where auth_uid = auth.uid() limit 1;
  if me.auth_uid is null then raise exception 'Sign in again'; end if;
  if not exists (select 1 from public.merchant_applications m where m.auth_uid = auth.uid() and m.status = 'approved') then
    raise exception 'Staff can be added once your business is approved';
  end if;
  if p_role not in ('cashier', 'manager') then raise exception 'Pick a role'; end if;
  if p_store is not null and not exists (select 1 from public.business_stores s where s.id = p_store and s.owner_auth_uid = auth.uid()) then
    raise exception 'Unknown store';
  end if;
  select id, auth_uid, username into them from public.users where lower(username) = uname limit 1;
  if them.auth_uid is null then raise exception 'No MeshPort user called %.arc', uname; end if;
  if them.auth_uid = auth.uid() then raise exception 'You are already the owner'; end if;
  insert into public.business_staff (owner_auth_uid, staff_auth_uid, staff_user_id, staff_username, role, store_id)
  values (auth.uid(), them.auth_uid, them.id::text, them.username, p_role, p_store)
  on conflict (owner_auth_uid, staff_auth_uid) do update set role = excluded.role, store_id = excluded.store_id
  returning * into r;
  insert into public.notifications (user_id, type, title, message, read)
  values (them.id::text, 'business_staff_invite', 'Staff invite from ' || coalesce(me.shop, 'a business'),
          'You were invited as ' || p_role || '. Open Home → More → Staff mode to accept.', false);
  return r;
end $function$;

create or replace function public.merchant_payment_intents_notify()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  who text;
  payer_id text;
  shop text := coalesce(nullif(new.merchant_name, ''), 'the merchant');
  amt text := '$' || trim(to_char(new.received_amount, 'FM999999990.00')) || ' USDC';
  onchain text := case when new.source_chain is not null and new.source_chain <> 'Arc_Testnet'
                       then ' on ' || public.merchant_chain_label(new.source_chain) else '' end;
  paid_title text := public.merchant_order_title(new.kind, new.personal, new.order_number, true);
  open_title text := public.merchant_order_title(new.kind, new.personal, new.order_number, false);
  received_title text := public.merchant_order_received_title(new.kind, new.personal, new.order_number);
  last public.merchant_payments;
begin
  -- Who actually paid: the latest payment on the order (anyone can pay a
  -- bill), else the order's customer.
  select * into last from public.merchant_payments p where p.intent_id = new.id order by p.created_at desc, p.id desc limit 1;
  who := coalesce(nullif(last.customer_username, ''),
                  case when last.from_address is not null then substr(last.from_address, 1, 6) || '…' || right(last.from_address, 4) end,
                  nullif(new.customer_username, ''),
                  case when new.customer_wallet is not null then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end,
                  'A customer');
  payer_id := case when last.id is not null then last.customer_user_id else new.customer_user_id end;

  if new.status = 'paid' and old.status is distinct from 'paid' and old.status is distinct from 'processing'
     and not coalesce(new.completed_by_merchant, false) then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_received',
              case when onchain <> '' then 'Payment received on ' || public.merchant_chain_label(new.source_chain) else received_title end,
              amt || ' from ' || who
                || case when onchain <> '' then ' · ' || received_title
                        else coalesce(' · ' || nullif(new.note, ''), '') end, false);
    end if;
    if payer_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (payer_id, 'merchant_order_paid', paid_title,
              'You paid ' || amt || ' to ' || shop || onchain, false);
    end if;
  end if;

  if new.status = 'partially_paid' and new.received_amount is distinct from old.received_amount then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_partial', 'Partial payment · ' || open_title,
              who || ' paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC' || onchain, false);
    end if;
    if payer_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (payer_id, 'merchant_payment_partial', 'Partial payment · ' || open_title,
              'You paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC to ' || shop || onchain, false);
    end if;
  end if;

  if new.status = 'paid' and old.status is distinct from 'paid' and coalesce(new.completed_by_merchant, false)
     and new.customer_user_id is not null then
    insert into public.notifications (user_id, type, title, message, read)
    values (new.customer_user_id, 'merchant_order_completed', 'Completed · ' || open_title,
            shop || ' marked ' || open_title || ' as completed', false);
  end if;
  return new;
end;
$function$;

revoke all on function public.merchant_applications_notify() from public, anon, authenticated;
revoke all on function public.merchant_unmatched_notify() from public, anon, authenticated;
revoke all on function public.merchant_payment_intents_notify() from public, anon, authenticated;
revoke all on function public.business_staff_invite(text, text, uuid) from public, anon;
grant execute on function public.business_staff_invite(text, text, uuid) to authenticated, service_role;
