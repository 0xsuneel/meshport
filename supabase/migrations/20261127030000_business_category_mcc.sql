-- The category customers see is the one MeshPort reviewed, like UPI's
-- merchant category code (MCC, ISO 18245) fixed when a merchant is onboarded:
-- the business type on its approved application. A store's own "type" stays
-- the owner's label (it picks the Business tab's words - guests, clients…)
-- and no longer changes what customers see. Each category maps to its
-- standard MCC, returned with the shop for receipts, exports and any card or
-- payment network later.

create or replace function public.business_mcc(p_category text)
returns text language sql immutable set search_path to '' as $$
  select case p_category
    when 'Retail store'           then '5399'  -- misc. general merchandise
    when 'Grocery / Supermarket'  then '5411'  -- grocery stores, supermarkets
    when 'Restaurant / Café'      then '5812'  -- eating places, restaurants
    when 'Online shop'            then '5999'  -- misc. and specialty retail
    when 'Pharmacy'               then '5912'  -- drug stores, pharmacies
    when 'Salon / Beauty'         then '7230'  -- beauty and barber shops
    when 'Clinic / Healthcare'    then '8099'  -- medical services, health practitioners
    when 'Education / Tutoring'   then '8299'  -- schools and educational services
    when 'Hotel / Stay'           then '7011'  -- hotels, motels, resorts
    when 'Events / Tickets'       then '7922'  -- theatrical producers, ticket agencies
    when 'Repair / Workshop'      then '7699'  -- misc. repair shops
    when 'Transport / Delivery'   then '4215'  -- courier services
    when 'Services'               then '7299'  -- misc. personal services
    when 'Freelancer'             then '8999'  -- professional services
    when 'Kiosk / Counter'        then '5499'  -- misc. food stores, convenience
    when 'Non-profit / Donations' then '8398'  -- charitable organizations
    else '5999'
  end
$$;
grant execute on function public.business_mcc(text) to anon, authenticated, service_role;

drop function if exists public.shop_info(text, uuid);
create function public.shop_info(p_username text, p_store uuid default null)
returns table(business_name text, username text, store_id uuid, store_name text, avatar_url text, verified boolean,
              category text, address text, mcc text)
language plpgsql stable security definer set search_path to '' as $function$
declare u record; a record; s record; cat text;
begin
  select x.id, x.auth_uid, x.username, x.display_name, x.store_name, x.avatar_url, x.account_type into u
    from public.users x where lower(x.username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.id is null then return; end if;
  select m.business_name, m.business_type into a from public.merchant_applications m
   where m.auth_uid = u.auth_uid and m.status = 'approved' order by m.created_at desc limit 1;
  if coalesce(u.account_type, 'personal') <> 'business' and a.business_name is null then return; end if;
  -- The store asked for, else the main store (for its address).
  select b.id, b.public_name as name, b.address, (b.id = p_store) as asked into s
    from public.business_stores b
   where b.owner_auth_uid = u.auth_uid and ((p_store is not null and b.id = p_store) or b.is_default)
   order by (b.id = p_store) desc nulls last limit 1;
  -- The reviewed category (approved application); none until approved.
  cat := nullif(trim(coalesce(a.business_type, '')), '');
  return query select coalesce(nullif(u.store_name, ''), nullif(a.business_name, ''), nullif(u.display_name, ''), u.username || '.arc')::text,
                      u.username::text,
                      case when s.asked then s.id end,
                      case when s.asked then s.name::text end,
                      u.avatar_url::text, a.business_name is not null,
                      cat,
                      nullif(trim(coalesce(s.address, '')), '')::text,
                      case when cat is not null then public.business_mcc(cat) end;
end $function$;
grant execute on function public.shop_info(text, uuid) to anon, authenticated, service_role;
