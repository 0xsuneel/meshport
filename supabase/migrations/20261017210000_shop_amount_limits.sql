-- Shop QR / payment link limits: the smallest and largest amount a customer
-- may type on the business's open-amount page.
alter table public.users add column if not exists shop_min_amount numeric(18,6);
alter table public.users add column if not exists shop_max_amount numeric(18,6);

create or replace function public.set_shop_limits(p_min numeric, p_max numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_min is not null and (p_min < 0.01 or p_min > 100000) then raise exception 'Minimum must be between $0.01 and $100,000'; end if;
  if p_max is not null and (p_max < 0.01 or p_max > 100000) then raise exception 'Maximum must be between $0.01 and $100,000'; end if;
  if p_min is not null and p_max is not null and p_min > p_max then raise exception 'Minimum is more than the maximum'; end if;
  update public.users set shop_min_amount = p_min, shop_max_amount = p_max
   where auth_uid = auth.uid() and account_type = 'business';
end $$;
revoke all on function public.set_shop_limits(numeric, numeric) from public;
grant execute on function public.set_shop_limits(numeric, numeric) to authenticated;

-- Read by the open-amount page (anyone may load a shop's page).
create or replace function public.shop_limits(p_username text)
returns table(min_amount numeric, max_amount numeric)
language sql stable security definer set search_path = '' as $$
  select x.shop_min_amount, x.shop_max_amount from public.users x
   where lower(x.username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', ''))
     and x.account_type = 'business' limit 1
$$;
grant execute on function public.shop_limits(text) to anon, authenticated;

create or replace function public.shop_open_order(p_username text, p_amount numeric, p_store uuid default null, p_note text default null)
returns text language plpgsql security definer set search_path = '' as $function$
declare u record; ok boolean; st uuid; r public.merchant_payment_intents;
begin
  if p_amount is null or p_amount < 0.01 or p_amount > 100000 then raise exception 'Enter an amount between $0.01 and $100,000'; end if;
  select auth_uid, account_type, shop_min_amount, shop_max_amount into u from public.users
   where lower(username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.auth_uid is null then raise exception 'Shop not found'; end if;
  ok := coalesce(u.account_type, 'personal') = 'business' or exists (
    select 1 from public.merchant_applications where auth_uid = u.auth_uid and status = 'approved');
  if not ok then raise exception 'Shop not found'; end if;
  if u.shop_min_amount is not null and p_amount < u.shop_min_amount then
    raise exception 'The smallest payment here is $%', to_char(u.shop_min_amount, 'FM999,999,990.00');
  end if;
  if u.shop_max_amount is not null and p_amount > u.shop_max_amount then
    raise exception 'The largest payment here is $%', to_char(u.shop_max_amount, 'FM999,999,990.00');
  end if;
  if (select count(*) from public.merchant_payment_intents
       where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and created_at > now() - interval '10 minutes') >= 200 then
    raise exception 'Too many orders right now - try again in a minute';
  end if;
  if p_store is not null then
    select id into st from public.business_stores where id = p_store and owner_auth_uid = u.auth_uid;
  end if;
  insert into public.merchant_payment_intents (merchant_auth_uid, requested_amount, note, expires_at, store_id, via)
  values (u.auth_uid, round(p_amount, 6), nullif(left(trim(coalesce(p_note, '')), 140), ''), now() + interval '30 minutes', st, 'shop_qr')
  returning * into r;
  return r.code;
end $function$;
