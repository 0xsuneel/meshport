-- The Shop QR page is headed by the store's own (reviewed) name, like
-- Square's per-location business name that customers of that location see.
-- shop_info now returns the store name for the main store too (a QR without
-- ?store=); store_id is still only set for a store asked for by the link.

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
  select b.id, b.public_name as name, b.address, b.public_logo_url, (b.id = p_store) as asked into s
    from public.business_stores b
   where b.owner_auth_uid = u.auth_uid and ((p_store is not null and b.id = p_store) or b.is_default)
   order by (b.id = p_store) desc nulls last limit 1;
  cat := nullif(trim(coalesce(a.business_type, '')), '');
  return query select coalesce(nullif(u.store_name, ''), nullif(a.business_name, ''), nullif(u.display_name, ''), u.username || '.arc')::text,
                      u.username::text,
                      case when s.asked then s.id end,
                      case when a.business_name is not null then nullif(s.name, '') end::text,
                      coalesce(case when a.business_name is not null then s.public_logo_url end, u.avatar_url)::text,
                      a.business_name is not null,
                      cat,
                      nullif(trim(coalesce(s.address, '')), '')::text,
                      case when cat is not null then public.business_mcc(cat) end,
                      case when a.business_name is not null then u.shop_contact::text end;
end $function$;
grant execute on function public.shop_info(text, uuid) to anon, authenticated, service_role;

-- The customer's "Paid to …" names the store they paid (as its page did).
do $do$
declare d text;
  a text := $q$values (payer_id, 'merchant_order_paid', case when k = 'shop' then 'Paid to ' || payee else paid_title end,
              'You paid ' || amt || ' to ' || payee || onchain, false);$q$;
  b text := $q$values (payer_id, 'merchant_order_paid', case when k = 'shop' then 'Paid to ' || place else paid_title end,
              'You paid ' || amt || ' to ' || case when k = 'shop' then place else payee end || onchain, false);$q$;
begin
  d := pg_get_functiondef('public.merchant_payment_intents_notify'::regproc);
  if position(b in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'merchant_payment_intents_notify changed - update this migration'; end if;
  execute replace(d, a, b);
end $do$;
