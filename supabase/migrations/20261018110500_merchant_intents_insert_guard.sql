-- Business-only orders need an approved business:
--  * an unapproved business account's requests are plain (personal, Arc-only)
--    requests: no bills (items), no store, not a merchant order;
--  * created_by_staff only when an active staff member of this business made
--    it (staff_create_request); completed_* and via='shop_qr' are never
--    client-set (shop_open_order sets meshport.shop_qr for its own insert).
create or replace function public.merchant_payment_intents_before_write()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare a record; u record; it jsonb; clean jsonb := '[]'::jsonb; total numeric := 0; q numeric; p numeric; nm text;
begin
  if tg_op = 'INSERT' then
    select user_id, wallet_address, business_name into a
      from public.merchant_applications
     where auth_uid = new.merchant_auth_uid and status = 'approved'
     order by created_at desc limit 1;
    if a.wallet_address is not null then
      new.personal         := false;
      new.merchant_user_id := a.user_id;
      new.merchant_wallet  := lower(a.wallet_address);
      new.merchant_name    := coalesce((select nullif(x.store_name, '') from public.users x where x.auth_uid = new.merchant_auth_uid limit 1), a.business_name);
    else
      select id, wallet_address, username, display_name, account_type, store_name into u
        from public.users where auth_uid = new.merchant_auth_uid limit 1;
      if u.wallet_address is null then
        raise exception 'Set up your wallet before requesting payments';
      end if;
      if new.items is not null and coalesce(u.account_type, 'personal') <> 'business' then
        raise exception 'Only business accounts can send bills';
      end if;
      if coalesce(u.account_type, 'personal') = 'business' then
        if new.items is not null then raise exception 'Bills unlock once your business is approved'; end if;
        if new.store_id is not null then raise exception 'Stores unlock once your business is approved'; end if;
      end if;
      -- Not an approved business: a personal request (paid on Arc only).
      new.personal         := true;
      new.merchant_user_id := u.id::text;
      new.merchant_wallet  := lower(u.wallet_address);
      new.merchant_name    := coalesce(nullif(u.display_name, ''), nullif(u.username, '') || '.arc');
    end if;
    new.status := 'pending'; new.received_amount := 0; new.paid_at := null;
    new.source_tx_hash := null; new.destination_tx_hash := null; new.payment_method := null;
    new.customer_wallet := null; new.ub_intent_id := null; new.failure_reason := null;
    new.overpaid_amount := 0;
    new.completed_by_merchant := false; new.completed_at := null; new.completed_note := null;
    if new.created_by_staff is not null and not (
         new.created_by_staff = auth.uid()
         and exists (select 1 from public.business_staff s
                      where s.owner_auth_uid = new.merchant_auth_uid and s.staff_auth_uid = auth.uid() and s.status = 'active')) then
      new.created_by_staff := null;
    end if;
    if new.via = 'shop_qr' and coalesce(current_setting('meshport.shop_qr', true), '') <> '1' then
      new.via := null;
    end if;
    if coalesce(new.via, '') <> 'shop_qr' then new.opened_by := null; end if;
    new.customer_username := nullif(lower(regexp_replace(coalesce(new.customer_username, ''), '\.arc$', '')), '');
    new.customer_user_id := null;
    if new.customer_username is not null then
      select id::text into new.customer_user_id from public.users where lower(username) = new.customer_username limit 1;
    end if;

    if new.items is not null then
      if jsonb_typeof(new.items) <> 'array' or jsonb_array_length(new.items) = 0 or jsonb_array_length(new.items) > 50 then
        raise exception 'An invoice needs 1 to 50 items';
      end if;
      for it in select * from jsonb_array_elements(new.items) loop
        nm := left(trim(coalesce(it->>'name', '')), 80);
        q  := (it->>'qty')::numeric;
        p  := (it->>'price')::numeric;
        if nm = '' or q is null or q <= 0 or q > 100000 or p is null or p < 0 or p > 1000000 then
          raise exception 'Invalid invoice item';
        end if;
        q := round(q, 3); p := round(p, 6);
        clean := clean || jsonb_build_array(jsonb_build_object('name', nm, 'qty', q, 'price', p, 'total', round(q * p, 6)));
        total := total + round(q * p, 6);
      end loop;
      if total <= 0 then raise exception 'Invoice total must be more than 0'; end if;
      new.items := clean;
      new.requested_amount := round(total, 6);
      new.kind := 'invoice';
    else
      new.kind := 'request';
    end if;
  else
    new.items := old.items; new.kind := old.kind; new.requested_amount := old.requested_amount;
    new.personal := old.personal;
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
revoke execute on function public.merchant_payment_intents_before_write() from public, anon, authenticated;
