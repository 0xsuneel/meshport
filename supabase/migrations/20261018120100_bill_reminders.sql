-- Bill reminders: the owner taps Remind (one per bill every 12 hours), or
-- Remind all for one customer; a daily job reminds on the due date and
-- every 3 days while overdue (3 automatic reminders at most).

-- One reminder notification for an open bill (internal).
create or replace function public.merchant_bill_send_reminder(p_id uuid, p_auto boolean)
returns void language plpgsql security definer set search_path = '' as $$
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
          || '. Open the bill in your chat with ' || shop || ' to pay.', false);
  update public.merchant_payment_intents
     set reminder_count = reminder_count + 1, last_reminded_at = now(),
         auto_reminder_count = auto_reminder_count + case when p_auto then 1 else 0 end
   where id = p_id;
end $$;
revoke execute on function public.merchant_bill_send_reminder(uuid, boolean) from anon, authenticated, public;

-- An open bill of an approved business, for a MeshPort customer.
create or replace function public.merchant_bill_remindable(i public.merchant_payment_intents)
returns boolean language sql stable security definer set search_path = '' as $$
  select i.customer_user_id is not null and not coalesce(i.personal, false)
     and i.status in ('pending', 'partially_paid') and (i.expires_at is null or i.expires_at > now())
     and i.requested_amount > i.received_amount
     and exists (select 1 from public.merchant_applications a where a.auth_uid = i.merchant_auth_uid and a.status = 'approved')
$$;
revoke execute on function public.merchant_bill_remindable(public.merchant_payment_intents) from anon, authenticated, public;

-- Remind (owner, one bill).
create or replace function public.merchant_bill_remind(p_intent uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.merchant_payment_intents; wait interval;
begin
  select * into i from public.merchant_payment_intents where id = p_intent and merchant_auth_uid = auth.uid() for update;
  if i.id is null then raise exception 'Bill not found'; end if;
  if i.customer_user_id is null then raise exception 'This bill has no MeshPort customer to remind - share the link instead'; end if;
  if not public.merchant_bill_remindable(i) then raise exception 'Only open bills can be reminded'; end if;
  if i.last_reminded_at is not null and i.last_reminded_at > now() - interval '12 hours' then
    wait := i.last_reminded_at + interval '12 hours' - now();
    raise exception 'Reminded recently - you can remind again in % h', greatest(1, ceil(extract(epoch from wait) / 3600)::int);
  end if;
  perform public.merchant_bill_send_reminder(i.id, false);
  return jsonb_build_object('reminded_at', now(), 'reminder_count', i.reminder_count + 1);
end $$;
revoke execute on function public.merchant_bill_remind(uuid) from anon, public;

-- Remind all (owner, every open bill of one customer that wasn't reminded in
-- the last 12 hours): one notification with the total.
create or replace function public.merchant_remind_customer(p_username text)
returns integer language plpgsql security definer set search_path = '' as $$
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
  if cardinality(ids) = 0 then raise exception 'No open bills to remind (bills reminded in the last 12 hours are skipped)'; end if;
  if cardinality(ids) = 1 then
    perform public.merchant_bill_send_reminder(ids[1], false);
  else
    insert into public.notifications (user_id, type, title, message, read)
    values (cust, 'merchant_bill_reminder', 'Reminder · ' || cardinality(ids) || ' bills from ' || shop,
            shop || ': $' || trim(to_char(total, 'FM999999990.00')) || ' USDC to pay across ' || cardinality(ids) || ' bills. Open them in your chat with ' || shop || ' to pay.', false);
    update public.merchant_payment_intents set reminder_count = reminder_count + 1, last_reminded_at = now() where id = any(ids);
  end if;
  return cardinality(ids);
end $$;
revoke execute on function public.merchant_remind_customer(text) from anon, public;

-- Set or clear the due date of an open bill (owner, or the staff who made it).
create or replace function public.merchant_set_due_date(p_intent uuid, p_due date)
returns void language plpgsql security definer set search_path = '' as $$
declare today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if p_due is not null and (p_due < today - 1 or p_due > today + 366) then raise exception 'Pick a due date within the next year'; end if;
  update public.merchant_payment_intents set due_date = p_due
   where id = p_intent and status in ('pending', 'partially_paid')
     and (merchant_auth_uid = auth.uid()
          or (created_by_staff = auth.uid() and exists (select 1 from public.business_staff s
               where s.owner_auth_uid = merchant_auth_uid and s.staff_auth_uid = auth.uid() and s.status = 'active')));
  if not found then raise exception 'Bill not found'; end if;
end $$;
revoke execute on function public.merchant_set_due_date(uuid, date) from anon, public;

-- Daily: on the due date, then every 3 days while overdue; 3 at most.
create or replace function public.business_bill_reminders()
returns void language plpgsql security definer set search_path = '' as $$
declare today date := (now() at time zone 'Asia/Kolkata')::date; i public.merchant_payment_intents;
begin
  for i in select * from public.merchant_payment_intents
            where due_date is not null and due_date <= today and auto_reminder_count < 3
              and status in ('pending', 'partially_paid') and customer_user_id is not null
              and (last_reminded_at is null
                   or (due_date = today and (last_reminded_at at time zone 'Asia/Kolkata')::date < today)
                   or (due_date < today and last_reminded_at < now() - interval '70 hours'))
            limit 2000
  loop
    begin
      if public.merchant_bill_remindable(i) then perform public.merchant_bill_send_reminder(i.id, true); end if;
    exception when others then null; -- one bad row never stops the rest
    end;
  end loop;
end $$;
revoke execute on function public.business_bill_reminders() from anon, authenticated, public;

-- 08:53 India time.
select cron.schedule('business-bill-reminders', '23 3 * * *', 'select public.business_bill_reminders()');
