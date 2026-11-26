-- The Shop QR page names the business the way payment apps do (Google Pay,
-- PhonePe, Paytm, Square checkout): logo, registered name, verified badge,
-- then what kind of business it is and where - not its username. shop_info
-- now also returns the category (the store's own type, else the type the
-- business applied with) and the store's address.

drop function if exists public.shop_info(text, uuid);
create function public.shop_info(p_username text, p_store uuid default null)
returns table(business_name text, username text, store_id uuid, store_name text, avatar_url text, verified boolean,
              category text, address text)
language plpgsql stable security definer set search_path to '' as $function$
declare u record; a record; s record;
begin
  select x.id, x.auth_uid, x.username, x.display_name, x.store_name, x.avatar_url, x.account_type into u
    from public.users x where lower(x.username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.id is null then return; end if;
  select m.business_name, m.business_type into a from public.merchant_applications m
   where m.auth_uid = u.auth_uid and m.status = 'approved' order by m.created_at desc limit 1;
  if coalesce(u.account_type, 'personal') <> 'business' and a.business_name is null then return; end if;
  -- The store asked for, else the main store (for its category and address).
  select b.id, b.public_name as name, b.type, b.address, (b.id = p_store) as asked into s
    from public.business_stores b
   where b.owner_auth_uid = u.auth_uid and ((p_store is not null and b.id = p_store) or b.is_default)
   order by (b.id = p_store) desc nulls last limit 1;
  return query select coalesce(nullif(u.store_name, ''), nullif(a.business_name, ''), nullif(u.display_name, ''), u.username || '.arc')::text,
                      u.username::text,
                      case when s.asked then s.id end,
                      case when s.asked then s.name::text end,
                      u.avatar_url::text, a.business_name is not null,
                      coalesce(nullif(s.type, ''), nullif(a.business_type, ''))::text,
                      nullif(trim(coalesce(s.address, '')), '')::text;
end $function$;
grant execute on function public.shop_info(text, uuid) to anon, authenticated, service_role;
