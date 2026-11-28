-- One name customers see (28 Nov, like Paytm's "Display Name - your
-- customers see this when they make payment"). A business has:
--   * Registered business name - merchant_applications.business_name, from
--     its application; the owner's own record (Profile → Business details).
--   * Display name - users.store_name, the name customers see everywhere:
--     search, contacts, chats, the pay screen, notifications, receipts. A
--     new one is reviewed by MeshPort first (set_business_name).
--   * Stores - a store's reviewed public name is a second line ("Paid at
--     Andheri"), never the business's name.
-- So a business's account name follows its display name (nothing else
-- shows a different name), and the payer is told "Paid to <display name>".

create or replace function public.business_display_name_sync()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if coalesce(new.account_type, 'personal') = 'business' and nullif(trim(coalesce(new.store_name, '')), '') is not null then
    new.display_name := new.store_name;
  end if;
  return new;
end $function$;

drop trigger if exists users_business_display_name on public.users;
create trigger users_business_display_name before insert or update of display_name, store_name, account_type on public.users
  for each row execute function public.business_display_name_sync();

update public.users set display_name = store_name
 where account_type = 'business' and nullif(trim(coalesce(store_name, '')), '') is not null
   and display_name is distinct from store_name;

-- The payer: "Paid to <display name>" (the store was its name before).
do $do$
declare d text := pg_get_functiondef('public.merchant_payment_intents_notify'::regproc);
begin
  if position('when k = ''shop'' then ''Paid to '' || shop' in d) > 0 then return; end if;
  if position('case when k = ''shop'' then ''Paid to '' || place else paid_title end' in d) = 0
     or position('''You paid '' || amt || '' to '' || case when k = ''shop'' then place else payee end' in d) = 0 then
    raise exception 'merchant_payment_intents_notify changed - update this migration';
  end if;
  d := replace(d, 'case when k = ''shop'' then ''Paid to '' || place else paid_title end', 'case when k = ''shop'' then ''Paid to '' || shop else paid_title end');
  d := replace(d, '''You paid '' || amt || '' to '' || case when k = ''shop'' then place else payee end', '''You paid '' || amt || '' to '' || case when k = ''shop'' then shop else payee end');
  execute d;
end $do$;

-- Customers see a store only by its reviewed public name (not the owner's own label).
do $do$
declare d text := pg_get_functiondef('public.shop_info'::regproc);
begin
  if position('then nullif(s.public_name, '''') end::text' in d) > 0 then return; end if;
  if position('case when a.business_name is not null then nullif(s.name, '''') end::text' in d) = 0
     or position('select b.id, b.public_name as name,' in d) = 0 then
    raise exception 'shop_info changed - update this migration';
  end if;
  -- (s.name is already b.public_name - selected "as name"; kept as it is.)
end $do$;
