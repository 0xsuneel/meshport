-- Payment reminders: everything waiting for the caller to pay - bills,
-- payment requests and Split Expense shares addressed to them - for the
-- reminder popup on Home. Read-only; paying is the request's own payment.

create or replace function public.my_due_requests()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare uid uuid := auth.uid(); my_id text; out jsonb;
begin
  if uid is null then return '[]'::jsonb; end if;
  select id::text into my_id from public.users where auth_uid = uid limit 1;
  if my_id is null then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(x order by (x->>'createdAt') desc), '[]'::jsonb) into out from (
    select jsonb_build_object(
      'code', i.code, 'orderNumber', i.order_number,
      'kind', case when i.split_id is not null then 'split' when i.kind = 'invoice' then 'bill' else 'request' end,
      'amount', i.requested_amount, 'due', greatest(i.requested_amount - i.received_amount, 0),
      'note', i.note, 'items', i.items, 'dueDate', i.due_date, 'createdAt', i.created_at,
      'fromName', coalesce(nullif(st.name, ''), nullif(i.merchant_name, ''), nullif(u.display_name, ''), u.username),
      'fromUsername', u.username, 'fromAvatar', u.avatar_url,
      'split', case when s.id is null then null else jsonb_build_object(
        'id', s.id, 'title', s.title, 'emoji', s.emoji, 'total', s.total,
        'people', 1 + (select count(*) from public.merchant_payment_intents y where y.split_id = s.id),
        'paid', 1 + (select count(*) from public.merchant_payment_intents y where y.split_id = s.id and y.status = 'paid')) end) as x
      from public.merchant_payment_intents i
      left join public.users u on u.id::text = i.merchant_user_id
      left join public.business_stores st on st.id = i.store_id
      left join public.splits s on s.id = i.split_id
     where i.customer_user_id = my_id
       and i.status in ('pending', 'partially_paid')
       and (i.expires_at is null or i.expires_at > now())
       and i.requested_amount > i.received_amount
       and coalesce(i.via, '') <> 'shop_qr'
     order by i.created_at desc
     limit 20) t;
  return out;
end $$;
revoke all on function public.my_due_requests() from public, anon;
grant execute on function public.my_due_requests() to authenticated;
