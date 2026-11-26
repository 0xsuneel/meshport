-- Business days follow each business's own time zone (MeshPort is used in
-- every country). Six functions assumed India time (Asia/Kolkata): bill due
-- dates and their reminders, payout reminders and the cashier's "today".
-- Like Square's per-location time zone, each account now keeps the IANA zone
-- of its phone (set by the app, set_my_time_zone); until it's known, UTC.

alter table public.users add column if not exists time_zone text;

create or replace function public.set_my_time_zone(p_tz text)
returns void language plpgsql security definer set search_path to '' as $function$
begin
  if auth.uid() is null then return; end if;
  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then
    raise exception 'Unknown time zone';
  end if;
  update public.users set time_zone = p_tz where auth_uid = auth.uid() and time_zone is distinct from p_tz;
end $function$;
revoke execute on function public.set_my_time_zone(text) from anon, public;
grant execute on function public.set_my_time_zone(text) to authenticated;

-- The business's time zone (UTC when it hasn't been set) and its "today".
create or replace function public.business_tz(p_owner uuid)
returns text language sql stable security definer set search_path to '' as $$
  select coalesce((select u.time_zone from public.users u where u.auth_uid = p_owner limit 1), 'UTC')
$$;
create or replace function public.business_today(p_owner uuid)
returns date language sql stable security definer set search_path to '' as $$
  select (now() at time zone public.business_tz(p_owner))::date
$$;
revoke execute on function public.business_tz(uuid) from anon, public;
revoke execute on function public.business_today(uuid) from anon, public;
grant execute on function public.business_tz(uuid) to authenticated;
grant execute on function public.business_today(uuid) to authenticated;

-- Automatic bill reminders: on the due date and after, in the business's day.
create or replace function public.business_bill_reminders()
returns void language plpgsql security definer set search_path to '' as $function$
declare i public.merchant_payment_intents; tz text; today date;
begin
  -- Candidates up to tomorrow in UTC (+14 h covers the earliest time zones).
  for i in select * from public.merchant_payment_intents
            where due_date is not null and due_date <= ((now() + interval '14 hours') at time zone 'UTC')::date
              and auto_reminder_count < 3
              and status in ('pending', 'partially_paid') and customer_user_id is not null
            limit 2000
  loop
    begin
      tz := public.business_tz(i.merchant_auth_uid);
      today := (now() at time zone tz)::date;
      if i.due_date <= today
         and (i.last_reminded_at is null
              or (i.due_date = today and (i.last_reminded_at at time zone tz)::date < today)
              or (i.due_date < today and i.last_reminded_at < now() - interval '70 hours'))
         and public.merchant_bill_remindable(i) then
        perform public.merchant_bill_send_reminder(i.id, true);
      end if;
    exception when others then null; -- one bad row never stops the rest
    end;
  end loop;
end $function$;

create or replace function public.business_payout_reminders()
returns void language plpgsql security definer set search_path to '' as $function$
declare p record;
begin
  for p in
    select b.id, b.name, b.next_due, u.id as user_id,
           (select coalesce(sum(case when (r->>'amount') ~ '^\s*\d+(\.\d+)?\s*$' then (r->>'amount')::numeric else 0 end), 0)
              from jsonb_array_elements(b.recipients) r) as total,
           jsonb_array_length(b.recipients) as n
      from public.business_payouts b join public.users u on u.auth_uid = b.owner_auth_uid
     where b.next_due is not null and b.next_due <= (now() at time zone coalesce(u.time_zone, 'UTC'))::date
       and b.reminded_for is distinct from b.next_due
  loop
    insert into public.notifications (user_id, type, title, message, read)
    values (p.user_id::text, 'business_payout_due', p.name || ' is due',
            'Pay $' || to_char(p.total, 'FM999,999,990.00') || ' to ' || p.n || case when p.n = 1 then ' person' else ' people' end || ' - open Business → Payouts.', false);
    update public.business_payouts set reminded_for = p.next_due where id = p.id;
  end loop;
end $function$;

create or replace function public.merchant_bill_send_reminder(p_id uuid, p_auto boolean)
returns void language plpgsql security definer set search_path to '' as $function$
declare i public.merchant_payment_intents; today date; due text; shop text;
begin
  select * into i from public.merchant_payment_intents where id = p_id;
  if i.id is null or i.customer_user_id is null then return; end if;
  today := public.business_today(i.merchant_auth_uid);
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

create or replace function public.merchant_intents_due_guard()
returns trigger language plpgsql set search_path to '' as $function$
declare today date;
begin
  if tg_op = 'INSERT' then
    new.reminder_count := 0; new.auto_reminder_count := 0; new.last_reminded_at := null;
    if new.due_date is not null then
      today := public.business_today(new.merchant_auth_uid);
      if new.due_date < today - 1 or new.due_date > today + 366 then
        raise exception 'Pick a due date within the next year';
      end if;
    end if;
  end if;
  return new;
end $function$;

create or replace function public.merchant_set_due_date(p_intent uuid, p_due date)
returns void language plpgsql security definer set search_path to '' as $function$
declare today date;
begin
  select public.business_today(i.merchant_auth_uid) into today from public.merchant_payment_intents i where i.id = p_intent;
  today := coalesce(today, (now() at time zone 'UTC')::date);
  if p_due is not null and (p_due < today - 1 or p_due > today + 366) then raise exception 'Pick a due date within the next year'; end if;
  update public.merchant_payment_intents set due_date = p_due
   where id = p_intent and status in ('pending', 'partially_paid')
     and (merchant_auth_uid = auth.uid()
          or (created_by_staff = auth.uid() and exists (select 1 from public.business_staff s
               where s.owner_auth_uid = merchant_auth_uid and s.staff_auth_uid = auth.uid() and s.status = 'active')));
  if not found then raise exception 'Bill not found'; end if;
end $function$;

-- Cashiers see today's payments - the business's today.
do $do$
declare d text; old_expr text := $q$(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')$q$;
begin
  d := pg_get_functiondef('public.staff_payments(uuid, integer)'::regprocedure);
  if position(old_expr in d) = 0 then raise exception 'staff_payments changed - update this migration'; end if;
  execute replace(d, old_expr, $q$(date_trunc('day', now() at time zone public.business_tz(p_owner)) at time zone public.business_tz(p_owner))$q$);
end $do$;
