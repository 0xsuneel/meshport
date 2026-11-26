-- Business audit fixes (27 Nov), compared with PhonePe / Paytm Business,
-- Google Pay for Business and Square.
--
-- 1. Payment notifications read like a payments app:
--    business, Shop QR: "Received on Sharma Jeneral Store" · "$1.00 USDC from vrsun.arc"
--    customer, Shop QR: "Paid to Shop" · "You paid $1.00 USDC to Shop"
--    People are always "name.arc" (was "from vrsun"); a personal requester is
--    named by username like everyone else (was their display name).
-- 2. Rejecting or removing a business needs a real reason (10+ characters) -
--    one was sent as "H".
-- 3. A business can show a public contact (phone / email / site) on its
--    Shop QR page and receipts - only what it chooses (users.shop_contact).
-- 4. End-of-day summary, like PhonePe / Paytm Business: at 9 pm in the
--    business's own time zone, "Today: $42.00 in 7 payments" (days with
--    payments only). One database job an hour - no Edge Function.

-- 1 ── Notification wording ───────────────────────────────────────────────
create or replace function public.merchant_payment_intents_notify()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  who text;
  payer_id text;
  shop text := coalesce(nullif(new.merchant_name, ''), 'the merchant');
  payee text;
  place text;
  amt text := '$' || trim(to_char(new.received_amount, 'FM999999990.00')) || ' USDC';
  onchain text := case when new.source_chain is not null and new.source_chain <> 'Arc_Testnet'
                       then ' on ' || public.merchant_chain_label(new.source_chain) else '' end;
  k text := case when new.via = 'shop_qr' then 'shop' else new.kind end;
  paid_title text := public.merchant_order_title(k, new.personal, new.order_number, true);
  open_title text := public.merchant_order_title(k, new.personal, new.order_number, false);
  received_title text := public.merchant_order_received_title(k, new.personal, new.order_number);
  last public.merchant_payments;
begin
  select * into last from public.merchant_payments p where p.intent_id = new.id order by p.created_at desc, p.id desc limit 1;
  who := coalesce(nullif(last.customer_username, '') || '.arc',
                  case when last.from_address is not null then substr(last.from_address, 1, 6) || '…' || right(last.from_address, 4) end,
                  nullif(new.customer_username, '') || '.arc',
                  case when new.customer_wallet is not null then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end,
                  'A customer');
  payer_id := case when last.id is not null then last.customer_user_id else new.customer_user_id end;
  -- Who was paid, as the customer sees it: a business by its name, a person by username.
  payee := case when coalesce(new.personal, false)
                then coalesce((select u.username || '.arc' from public.users u where u.id::text = new.merchant_user_id limit 1), shop)
                else shop end;
  -- Which store took it (its reviewed public name), when that isn't just the business name.
  place := coalesce((select nullif(s.public_name, '') from public.business_stores s where s.id = new.store_id), shop);

  if new.status = 'paid' and old.status is distinct from 'paid' and old.status is distinct from 'processing'
     and not coalesce(new.completed_by_merchant, false) then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_received',
              case when k = 'shop' then 'Received on ' || place
                   when onchain <> '' then 'Payment received on ' || public.merchant_chain_label(new.source_chain)
                   else received_title end,
              amt || ' from ' || who || onchain
                || case when k <> 'shop' and onchain <> '' then ' · ' || received_title
                        else coalesce(' · ' || nullif(new.note, ''), '') end, false);
    end if;
    if payer_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (payer_id, 'merchant_order_paid', case when k = 'shop' then 'Paid to ' || payee else paid_title end,
              'You paid ' || amt || ' to ' || payee || onchain, false);
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
              'You paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC to ' || payee || onchain, false);
    end if;
  end if;

  if new.status = 'paid' and old.status is distinct from 'paid' and coalesce(new.completed_by_merchant, false)
     and new.customer_user_id is not null then
    insert into public.notifications (user_id, type, title, message, read)
    values (new.customer_user_id, 'merchant_order_completed', 'Completed · ' || open_title,
            payee || ' marked ' || open_title || ' as completed', false);
  end if;
  return new;
end;
$function$;

-- 2 ── A real reason to reject or remove a business ───────────────────────
create or replace function public.merchant_applications_reason_required()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if new.status in ('rejected', 'revoked') and new.status is distinct from old.status
     and coalesce(current_setting('meshport.merchant_relink', true), '') <> 'on'
     and char_length(trim(coalesce(new.review_note, ''))) < 10 then
    raise exception 'Give the business a clear reason (at least 10 characters) - they see it'
      using errcode = '22023';
  end if;
  return new;
end $function$;
drop trigger if exists merchant_applications_reason_required on public.merchant_applications;
create trigger merchant_applications_reason_required before update of status on public.merchant_applications
  for each row execute function public.merchant_applications_reason_required();

-- 3 ── Public contact ───────────────────────────────────────────────────────
alter table public.users add column if not exists shop_contact text;

create or replace function public.set_shop_contact(p_contact text)
returns text language plpgsql security definer set search_path to '' as $function$
declare c text := nullif(left(regexp_replace(trim(coalesce(p_contact, '')), '\s+', ' ', 'g'), 120), '');
begin
  update public.users set shop_contact = c where auth_uid = auth.uid() and account_type = 'business';
  if not found then raise exception 'Only business accounts have a shop contact'; end if;
  return c;
end $function$;
revoke execute on function public.set_shop_contact(text) from anon, public;
grant execute on function public.set_shop_contact(text) to authenticated;

drop function if exists public.shop_info(text, uuid);
create function public.shop_info(p_username text, p_store uuid default null)
returns table(business_name text, username text, store_id uuid, store_name text, avatar_url text, verified boolean,
              category text, address text, mcc text, contact text)
language plpgsql stable security definer set search_path to '' as $function$
declare u record; a record; s record; cat text;
begin
  select x.id, x.auth_uid, x.username, x.display_name, x.store_name, x.avatar_url, x.account_type, x.shop_contact into u
    from public.users x where lower(x.username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.id is null then return; end if;
  select m.business_name, m.business_type into a from public.merchant_applications m
   where m.auth_uid = u.auth_uid and m.status = 'approved' order by m.created_at desc limit 1;
  if coalesce(u.account_type, 'personal') <> 'business' and a.business_name is null then return; end if;
  select b.id, b.public_name as name, b.address, (b.id = p_store) as asked into s
    from public.business_stores b
   where b.owner_auth_uid = u.auth_uid and ((p_store is not null and b.id = p_store) or b.is_default)
   order by (b.id = p_store) desc nulls last limit 1;
  cat := nullif(trim(coalesce(a.business_type, '')), '');
  return query select coalesce(nullif(u.store_name, ''), nullif(a.business_name, ''), nullif(u.display_name, ''), u.username || '.arc')::text,
                      u.username::text,
                      case when s.asked then s.id end,
                      case when s.asked then s.name::text end,
                      u.avatar_url::text, a.business_name is not null,
                      cat,
                      nullif(trim(coalesce(s.address, '')), '')::text,
                      case when cat is not null then public.business_mcc(cat) end,
                      case when a.business_name is not null then u.shop_contact::text end;
end $function$;
grant execute on function public.shop_info(text, uuid) to anon, authenticated, service_role;

create or replace function public.my_shop_contact()
returns text language sql stable security definer set search_path to '' as $$
  select u.shop_contact from public.users u where auth.uid() is not null and u.auth_uid = auth.uid() limit 1
$$;
revoke execute on function public.my_shop_contact() from anon, public;
grant execute on function public.my_shop_contact() to authenticated;

-- 4 ── End-of-day summary ───────────────────────────────────────────────────
alter table public.users add column if not exists business_summary_on date;

create or replace function public.business_daily_summaries()
returns void language plpgsql security definer set search_path to '' as $function$
declare b record; tz text; today date; n int; total numeric;
begin
  for b in
    select u.id, u.auth_uid, u.wallet_address, coalesce(u.time_zone, 'UTC') as tz, u.business_summary_on
      from public.users u
     where u.account_type = 'business'
       and exists (select 1 from public.merchant_applications m where m.auth_uid = u.auth_uid and m.status = 'approved')
  loop
    tz := b.tz;
    today := (now() at time zone tz)::date;
    -- 9 pm local, once a day.
    if extract(hour from (now() at time zone tz)) <> 21 or b.business_summary_on = today then continue; end if;
    select count(*), coalesce(sum(p.amount), 0) into n, total
      from public.merchant_payments p
     where p.merchant_wallet = lower(b.wallet_address)
       and coalesce(p.screen_flag, '') = ''
       and p.created_at >= (today::timestamp at time zone tz)
       and p.created_at < ((today + 1)::timestamp at time zone tz);
    update public.users set business_summary_on = today where id = b.id;
    if n > 0 then
      insert into public.notifications (user_id, type, title, message, read)
      values (b.id::text, 'business_daily_summary', 'Today: $' || trim(to_char(total, 'FM999,999,990.00')),
              n || case when n = 1 then ' payment' else ' payments' end || ' received today. Open Business → Reports for the statement.', false);
    end if;
  end loop;
end $function$;
revoke execute on function public.business_daily_summaries() from anon, authenticated, public;

do $mig$
begin
  if not exists (select 1 from cron.job where jobname = 'business-daily-summary') then
    perform cron.schedule('business-daily-summary', '47 * * * *', 'select public.business_daily_summaries()');
  end if;
end $mig$;

-- Push taps: business summary and name reviews open Business.
create or replace function public.p2p_dispatch_push_for_notification()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_secret text;
begin
  if NEW.type in ('merchant_order_paid', 'merchant_refund_sent')
     or (NEW.type = 'merchant_chain_payment' and NEW.title ilike 'Your USDC arrived%')
     or (NEW.type = 'merchant_payment_partial' and NEW.message ilike 'You paid%') then
    update public.notifications set read = true where id = NEW.id;
    return NEW;
  end if;

  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'p2p_push_secret';
  exception when others then
    v_secret := null;
  end;

  if v_secret is not null then
    perform net.http_post(
      url     := 'https://meshport.xyz/api/push?action=send-internal',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      body    := jsonb_build_object(
        'userId', NEW.user_id,
        'title',  NEW.title,
        'body',   NEW.message,
        'tag',    'n-' || NEW.id::text,
        'data',   jsonb_build_object('kind', NEW.type),
        'url',    case
                    when NEW.trade_id is not null then '/p2p/trade/' || NEW.trade_id::text
                    when NEW.type in ('merchant_payment_received', 'merchant_payment_partial', 'merchant_payment_arriving') then '/business?tab=payments'
                    when NEW.type in ('merchant_chain_payment', 'merchant_ledger_credited', 'merchant_ledger_moving', 'merchant_funds_moved') then '/business?tab=settlements'
                    when NEW.type in ('merchant_approved', 'business_staff_invite', 'business_daily_summary',
                                      'business_name_approved', 'business_name_rejected', 'store_name_approved', 'store_name_rejected') then '/business'
                    when NEW.type in ('merchant_refund', 'merchant_order_completed') then '/activity'
                    when NEW.type = 'merchant_bill_reminder' then '/chat'
                    when NEW.type like 'merchant_%' or NEW.type like 'business_%' then '/business'
                    else '/notifications'
                  end
      )
    );
  end if;
  return NEW;
exception when others then
  return NEW;
end;
$function$;
