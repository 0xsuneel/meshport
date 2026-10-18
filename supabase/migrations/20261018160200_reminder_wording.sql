-- Reminders cover bills and plain requests alike: "payments", not "bills".

create or replace function public.merchant_remind_customer(p_username text)
returns integer language plpgsql security definer set search_path to '' as $function$
declare ids uuid[] := '{}'; total numeric := 0; cust text; shop text; i public.merchant_payment_intents;
begin
  for i in select * from public.merchant_payment_intents
            where merchant_auth_uid = auth.uid() and customer_username = lower(regexp_replace(coalesce(p_username, ''), '\.arc$', ''))
              and (last_reminded_at is null or last_reminded_at <= now() - interval '12 hours')
            for update
  loop
    if public.merchant_bill_remindable(i) then
      ids := ids || i.id; total := total + (i.requested_amount - i.received_amount); cust := i.customer_user_id;
      shop := coalesce(nullif(i.merchant_name, ''), 'A business');
    end if;
  end loop;
  if cardinality(ids) = 0 then raise exception 'Nothing to remind - open payments reminded in the last 12 hours are skipped'; end if;
  if cardinality(ids) = 1 then
    perform public.merchant_bill_send_reminder(ids[1], false);
  else
    insert into public.notifications (user_id, type, title, message, read)
    values (cust, 'merchant_bill_reminder', 'Reminder · ' || cardinality(ids) || ' payments due to ' || shop,
            shop || ': $' || trim(to_char(total, 'FM999999990.00')) || ' USDC to pay across ' || cardinality(ids) || ' payments. Open them in your chat with ' || shop || ' to pay.', false);
    update public.merchant_payment_intents set reminder_count = reminder_count + 1, last_reminded_at = now() where id = any(ids);
  end if;
  return cardinality(ids);
end $function$;

create or replace function public.merchant_bill_send_reminder(p_id uuid, p_auto boolean)
returns void language plpgsql security definer set search_path to '' as $function$
declare i public.merchant_payment_intents; today date := (now() at time zone 'Asia/Kolkata')::date; due text; shop text;
begin
  select * into i from public.merchant_payment_intents where id = p_id;
  if i.id is null or i.customer_user_id is null then return; end if;
  shop := coalesce(nullif(i.merchant_name, ''), 'A business');
  due := case when i.due_date is null then ''
              when i.due_date > today then ' · due ' || to_char(i.due_date, 'FMDD Mon')
              when i.due_date = today then ' · due today'
              else ' · overdue by ' || (today - i.due_date) || case when today - i.due_date = 1 then ' day' else ' days' end end;
  insert into public.notifications (user_id, type, title, message, read)
  values (i.customer_user_id, 'merchant_bill_reminder', 'Reminder · ' || public.merchant_order_title(i.kind, i.personal, i.order_number, false),
          shop || ': $' || trim(to_char(greatest(i.requested_amount - i.received_amount, 0), 'FM999999990.00')) || ' USDC to pay' || due
          || '. Open it in your chat with ' || shop || ' to pay.', false);
  update public.merchant_payment_intents
     set reminder_count = reminder_count + 1, last_reminded_at = now(),
         auto_reminder_count = auto_reminder_count + case when p_auto then 1 else 0 end
   where id = p_id;
end $function$;
