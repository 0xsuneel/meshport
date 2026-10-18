-- Activity log rows the database writes itself: charges and bills (owner
-- or staff), refunds, staff and store changes.
create or replace function public.business_log_intent()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Orders a customer opened from the Shop QR, and personal requests, aren't business actions.
  if coalesce(new.personal, false) or new.via = 'shop_qr' then return new; end if;
  perform public.business_log_write(new.merchant_auth_uid, coalesce(new.created_by_staff, auth.uid(), new.merchant_auth_uid),
    case when new.kind = 'invoice' then 'bill_created' else 'charge_created' end,
    coalesce(new.order_number, new.code), new.requested_amount,
    jsonb_strip_nulls(jsonb_build_object('customer', new.customer_username, 'store_id', new.store_id, 'due_date', new.due_date, 'staff', new.created_by_staff is not null)));
  return new;
exception when others then return new; -- logging never blocks an order
end $$;
create or replace trigger business_log_intent after insert on public.merchant_payment_intents
  for each row execute function public.business_log_intent();

create or replace function public.business_log_refund()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.business_log_write(new.merchant_auth_uid, new.merchant_auth_uid, 'refund_sent',
    (select coalesce(p.order_number, left(p.tx_hash, 10)) from public.merchant_payments p where p.id = new.payment_id),
    new.amount, jsonb_strip_nulls(jsonb_build_object('reason', nullif(new.reason, ''), 'chain', new.refund_chain, 'route', new.route)));
  return new;
exception when others then return new;
end $$;
create or replace trigger business_log_refund after insert on public.merchant_refunds
  for each row execute function public.business_log_refund();

create or replace function public.business_log_staff()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r public.business_staff := coalesce(new, old); act text;
begin
  act := case when tg_op = 'INSERT' then 'staff_invited'
              when tg_op = 'DELETE' then case when auth.uid() = old.staff_auth_uid then 'staff_left' else 'staff_removed' end
              when new.status = 'active' and old.status <> 'active' then 'staff_joined'
              when new.role is distinct from old.role or new.store_id is distinct from old.store_id then 'staff_role_changed'
              else null end;
  if act is null then return r; end if;
  perform public.business_log_write(r.owner_auth_uid, coalesce(auth.uid(), r.owner_auth_uid), act, r.staff_username || '.arc', null,
    jsonb_strip_nulls(jsonb_build_object('role', r.role, 'old_role', case when tg_op = 'UPDATE' and new.role is distinct from old.role then old.role end, 'store_id', r.store_id)));
  return r;
exception when others then return r;
end $$;
create or replace trigger business_log_staff after insert or update or delete on public.business_staff
  for each row execute function public.business_log_staff();

create or replace function public.business_log_store()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r public.business_stores := coalesce(new, old);
begin
  if tg_op = 'UPDATE' and new.name is not distinct from old.name and new.type is not distinct from old.type
     and new.address is not distinct from old.address then return r; end if;
  perform public.business_log_write(r.owner_auth_uid, coalesce(auth.uid(), r.owner_auth_uid),
    case tg_op when 'INSERT' then 'store_added' when 'DELETE' then 'store_removed' else 'store_edited' end, r.name, null,
    case when tg_op = 'UPDATE' and new.name is distinct from old.name then jsonb_build_object('old_name', old.name) else '{}'::jsonb end);
  return r;
exception when others then return r;
end $$;
create or replace trigger business_log_store after insert or update or delete on public.business_stores
  for each row execute function public.business_log_store();

revoke execute on function public.business_log_intent() from anon, authenticated, public;
revoke execute on function public.business_log_refund() from anon, authenticated, public;
revoke execute on function public.business_log_staff() from anon, authenticated, public;
revoke execute on function public.business_log_store() from anon, authenticated, public;
