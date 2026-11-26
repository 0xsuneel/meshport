-- Payments keep the store's id as well as its name. merchantStore is the
-- store's name (what people read); merchantStoreId is what a link needs -
-- "Pay again" on a Shop QR payment reopens /paylink/<shop>?store=<id>.
-- The app used to keep the id in merchantStore on the payer's row, which this
-- function then overwrote with the name, so Pay again sent a name as the id.
create or replace function public.merchant_order_meta(p_order text, p_intent uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'merchantPayment', true,
    'merchantOrder', p_order,
    'merchantName', i.merchant_name,
    'merchantOrderKind', i.kind,
    'merchantPersonal', coalesce(i.personal, false),
    'merchantVia', i.via,
    'merchantStore', coalesce(
      (select s.name from public.business_stores s where s.id = i.store_id),
      (select s.name from public.business_stores s where s.owner_auth_uid = i.merchant_auth_uid and s.is_default limit 1)),
    'merchantStoreId', i.store_id
  ) - case when i.store_id is null then 'merchantStoreId' else '' end
  from public.merchant_payment_intents i where i.id = p_intent
$$;
revoke execute on function public.merchant_order_meta(text, uuid) from public, anon, authenticated;
grant execute on function public.merchant_order_meta(text, uuid) to service_role;
