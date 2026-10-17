-- Business → saved items: the shop's products and prices, tapped into an
-- itemised bill instead of typed each time. Items used in a bill are saved
-- (or their price updated) automatically.
create table if not exists public.business_items (
  id             uuid primary key default gen_random_uuid(),
  owner_auth_uid uuid not null default auth.uid(),
  name           text not null check (char_length(trim(name)) between 1 and 80),
  price          numeric(18,6) not null check (price >= 0 and price <= 1000000),
  used_count     integer not null default 0,
  updated_at     timestamptz not null default now()
);
create unique index if not exists business_items_owner_name on public.business_items (owner_auth_uid, lower(name));
alter table public.business_items enable row level security;
create policy bi_select on public.business_items for select to authenticated using (owner_auth_uid = auth.uid());
create policy bi_insert on public.business_items for insert to authenticated with check (owner_auth_uid = auth.uid());
create policy bi_update on public.business_items for update to authenticated using (owner_auth_uid = auth.uid()) with check (owner_auth_uid = auth.uid());
create policy bi_delete on public.business_items for delete to authenticated using (owner_auth_uid = auth.uid());

-- Save the items of a bill: new names are added, known ones get the new price.
create or replace function public.business_items_remember(p_items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare it jsonb;
begin
  if auth.uid() is null or jsonb_typeof(p_items) <> 'array' then return; end if;
  for it in select * from jsonb_array_elements(p_items) limit 50 loop
    if nullif(trim(coalesce(it->>'name', '')), '') is null or (it->>'price') is null then continue; end if;
    insert into public.business_items (owner_auth_uid, name, price, used_count)
    values (auth.uid(), left(trim(it->>'name'), 80), least(greatest((it->>'price')::numeric, 0), 1000000), 1)
    on conflict (owner_auth_uid, lower(name)) do update
      set price = excluded.price, used_count = public.business_items.used_count + 1, updated_at = now();
  end loop;
end $$;
revoke all on function public.business_items_remember(jsonb) from public;
grant execute on function public.business_items_remember(jsonb) to authenticated;
