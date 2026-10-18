-- Shop QR orders can't be spammed to block a shop:
--  * the same signed-in customer asking again for the same amount gets their
--    open order back; at most 5 new orders per customer per 10 minutes;
--  * at most 5 open orders for the same amount, and 30 open orders in all,
--    per shop (open = pending and not expired; they expire after 30 minutes
--    and merchant_expire_orders marks them expired).
create index if not exists merchant_intents_shop_qr_idx
  on public.merchant_payment_intents (merchant_auth_uid, created_at) where via = 'shop_qr';

create or replace function public.shop_open_order(p_username text, p_amount numeric, p_store uuid default null, p_note text default null)
returns text language plpgsql security definer set search_path to '' as $function$
declare u record; ok boolean; st uuid; r public.merchant_payment_intents; me uuid := auth.uid();
        amt numeric; nt text; existing text;
begin
  if p_amount is null or p_amount < 0.01 or p_amount > 100000 then raise exception 'Enter an amount between $0.01 and $100,000'; end if;
  amt := round(p_amount, 6);
  nt := nullif(left(trim(coalesce(p_note, '')), 140), '');
  select auth_uid, account_type, shop_min_amount, shop_max_amount into u from public.users
   where lower(username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.auth_uid is null then raise exception 'Shop not found'; end if;
  ok := exists (select 1 from public.merchant_applications where auth_uid = u.auth_uid and status = 'approved');
  if not ok then raise exception 'Shop not found'; end if;
  if u.shop_min_amount is not null and p_amount < u.shop_min_amount then
    raise exception 'The smallest payment here is $%', to_char(u.shop_min_amount, 'FM999,999,990.00');
  end if;
  if u.shop_max_amount is not null and p_amount > u.shop_max_amount then
    raise exception 'The largest payment here is $%', to_char(u.shop_max_amount, 'FM999,999,990.00');
  end if;
  if p_store is not null then
    select id into st from public.business_stores where id = p_store and owner_auth_uid = u.auth_uid;
  end if;

  if me is not null then
    select code into existing from public.merchant_payment_intents
     where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and opened_by = me
       and status = 'pending' and received_amount = 0 and expires_at > now() + interval '5 minutes'
       and requested_amount = amt and store_id is not distinct from st and note is not distinct from nt
     order by created_at desc limit 1;
    if existing is not null then return existing; end if;
    if (select count(*) from public.merchant_payment_intents
         where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and opened_by = me
           and created_at > now() - interval '10 minutes') >= 5 then
      raise exception 'Too many orders from you right now - try again in a few minutes';
    end if;
  end if;
  if (select count(*) from public.merchant_payment_intents
       where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and status = 'pending'
         and expires_at > now() and requested_amount = amt) >= 5 then
    raise exception 'Too many open orders for this amount right now - try again in a few minutes';
  end if;
  if (select count(*) from public.merchant_payment_intents
       where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and status = 'pending' and expires_at > now()) >= 30 then
    raise exception 'This shop has too many open orders right now - try again in a few minutes';
  end if;
  if (select count(*) from public.merchant_payment_intents
       where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and created_at > now() - interval '10 minutes') >= 200 then
    raise exception 'Too many orders right now - try again in a minute';
  end if;

  perform set_config('meshport.shop_qr', '1', true);
  insert into public.merchant_payment_intents (merchant_auth_uid, requested_amount, note, expires_at, store_id, via, opened_by)
  values (u.auth_uid, amt, nt, now() + interval '30 minutes', st, 'shop_qr', me)
  returning * into r;
  perform set_config('meshport.shop_qr', '', true);
  return r.code;
end $function$;
