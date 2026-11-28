-- A category belongs to each store (28 Nov, like Paytm: every shop has its
-- own Business Category). A restaurant and a salon of one owner each show
-- their own category - and its merchant category code - to customers. The
-- business's category is its main store's. Paying by username, chat or
-- address shows the main store's.

-- shop_info: the category of the store being paid (else the main store's,
-- else the application's).
do $do$
declare d text := pg_get_functiondef('public.shop_info'::regproc);
begin
  if position('b.type as stype' in d) > 0 then return; end if;
  if position('select b.id, b.public_name as name, b.address, b.public_logo_url, (b.id = p_store) as asked into s' in d) = 0
     or position('cat := nullif(trim(coalesce(a.business_type, '''')), '''');' in d) = 0 then
    raise exception 'shop_info changed - update this migration';
  end if;
  d := replace(d, 'select b.id, b.public_name as name, b.address, b.public_logo_url, (b.id = p_store) as asked into s',
                  'select b.id, b.public_name as name, b.address, b.public_logo_url, (b.id = p_store) as asked, b.type as stype into s');
  d := replace(d, 'cat := nullif(trim(coalesce(a.business_type, '''')), '''');',
                  'cat := coalesce(nullif(trim(coalesce(s.stype, '''')), ''''), nullif(trim(coalesce(a.business_type, '''')), ''''));');
  execute d;
end $do$;

-- The business's category is its main store's category (shop_info above
-- falls back to the main store). The application's category stays as it
-- was submitted - the registered record (merchant_applications_before_write
-- locks it) - so nothing is copied into it.
