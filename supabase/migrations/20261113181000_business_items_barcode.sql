-- Business → saved items: a product's barcode, so scanning it at the counter
-- adds the item to a bill. Each barcode belongs to one item of the business.
alter table public.business_items
  add column if not exists barcode text
  check (barcode is null or barcode ~ '^[0-9A-Za-z\-\.\$/\+% ]{3,64}$');
create unique index if not exists business_items_owner_barcode
  on public.business_items (owner_auth_uid, barcode) where barcode is not null;

-- Save a scanned product: a known name gets the barcode (and the new price),
-- a new name is added. The barcode moves off any other item that had it.
create or replace function public.business_item_save_barcode(p_name text, p_price numeric, p_barcode text)
returns table (id uuid, name text, price numeric, barcode text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_name text := left(trim(coalesce(p_name, '')), 80);
  v_code text := trim(coalesce(p_barcode, ''));
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if v_name = '' then raise exception 'Add a name'; end if;
  if p_price is null or p_price < 0 or p_price > 1000000 then raise exception 'Add a price'; end if;
  if v_code !~ '^[0-9A-Za-z\-\.\$/\+% ]{3,64}$' then raise exception 'Not a barcode'; end if;

  update public.business_items bi set barcode = null, updated_at = now()
   where bi.owner_auth_uid = v_uid and bi.barcode = v_code and lower(bi.name) <> lower(v_name);

  return query
  insert into public.business_items as bi (owner_auth_uid, name, price, barcode)
  values (v_uid, v_name, p_price, v_code)
  on conflict (owner_auth_uid, lower(name)) do update
    set price = excluded.price, barcode = excluded.barcode, updated_at = now()
  returning bi.id, bi.name, bi.price, bi.barcode;
end $$;
revoke all on function public.business_item_save_barcode(text, numeric, text) from public, anon;
grant execute on function public.business_item_save_barcode(text, numeric, text) to authenticated;
