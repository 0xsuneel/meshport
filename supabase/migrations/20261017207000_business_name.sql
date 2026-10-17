-- Business → name: the business's own display name (users.store_name), set
-- in Business profile. Shown on the pay page, orders, receipts and
-- notifications; the username is used until one is set. Logo = profile photo.
create or replace function public.set_business_name(p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare n text := nullif(left(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), 60), '');
begin
  if n is not null and char_length(n) < 2 then raise exception 'Use at least 2 characters'; end if;
  update public.users set store_name = n where auth_uid = auth.uid() and account_type = 'business';
  if not found then raise exception 'Only business accounts have a business name'; end if;
  return n;
end $$;
revoke all on function public.set_business_name(text) from public;
grant execute on function public.set_business_name(text) to authenticated;

-- Orders: the business name first, then the application's name.
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.merchant_payment_intents_before_write'::regproc);
  if position('new.merchant_name    := a.business_name;' in d) > 0 then
    d := replace(d, 'new.merchant_name    := a.business_name;',
      'new.merchant_name    := coalesce((select nullif(x.store_name, '''') from public.users x where x.auth_uid = new.merchant_auth_uid limit 1), a.business_name);');
    execute d;
  end if;
end $do$;

-- Pay page: the business name first.
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.shop_info(text, uuid)'::regprocedure);
  d := replace(d, $q$coalesce(nullif(a.business_name, ''), nullif(u.store_name, ''),$q$, $q$coalesce(nullif(u.store_name, ''), nullif(a.business_name, ''),$q$);
  execute d;
end $do$;
