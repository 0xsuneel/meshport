-- Activity: which store took a business's order payment. A business with
-- several stores (branches) needs the history card to say where the money
-- came in - "Payment Received · sunil.arc · Royal Salons". The store is the
-- order's own store, else the business's main store (orders made before
-- stores existed, or a Shop QR without ?store=). Both sides' rows carry it.

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
      (select s.name from public.business_stores s where s.owner_auth_uid = i.merchant_auth_uid and s.is_default limit 1))
  )
  from public.merchant_payment_intents i where i.id = p_intent
$$;
revoke execute on function public.merchant_order_meta(text, uuid) from public, anon, authenticated;
grant execute on function public.merchant_order_meta(text, uuid) to service_role;

-- Order payments already in Activity.
update public.activity a
   set metadata = a.metadata || jsonb_build_object('merchantStore', st.name)
  from (
    select i.order_number, coalesce(
      (select s.name from public.business_stores s where s.id = i.store_id),
      (select s.name from public.business_stores s where s.owner_auth_uid = i.merchant_auth_uid and s.is_default limit 1)) as name
    from public.merchant_payment_intents i where i.order_number is not null
  ) st
 where a.metadata ? 'merchantOrder'
   and a.metadata->>'merchantOrder' = st.order_number
   and st.name is not null
   and a.metadata->>'merchantStore' is null;
