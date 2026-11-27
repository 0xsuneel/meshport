-- Business app Phase 2 (27 Nov): the business chooses its alerts.
--  · Daily summary  - "Today: $X · N payments", at the hour it picks (9 pm default).
--  · Weekly summary - Monday, at the same hour: last week (Mon-Sun) and the
--                     change on the week before.
--  · Cash-out day   - a reminder on the weekday it picks (off by default),
--                     opening Cash out. MeshPort can't move money without the
--                     owner's key, so it reminds; the owner approves once.
-- All in the business's own time zone (users.time_zone, UTC until known).

alter table public.users
  add column if not exists biz_summary_daily  boolean  not null default true,
  add column if not exists biz_summary_hour   smallint not null default 21,
  add column if not exists biz_summary_weekly boolean  not null default true,
  add column if not exists biz_cashout_dow    smallint,             -- 0 Sunday .. 6 Saturday; null = off
  add column if not exists biz_cashout_hour   smallint not null default 10,
  add column if not exists business_weekly_on  date,
  add column if not exists business_cashout_on date;

do $$ begin
  alter table public.users add constraint users_biz_summary_hour_chk check (biz_summary_hour between 0 and 23);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.users add constraint users_biz_cashout_hour_chk check (biz_cashout_hour between 0 and 23);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.users add constraint users_biz_cashout_dow_chk check (biz_cashout_dow is null or biz_cashout_dow between 0 and 6);
exception when duplicate_object then null; end $$;

-- The signed-in business's alert settings.
create or replace function public.get_my_business_alerts()
returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'daily', u.biz_summary_daily, 'hour', u.biz_summary_hour, 'weekly', u.biz_summary_weekly,
    'cashoutDay', u.biz_cashout_dow, 'cashoutHour', u.biz_cashout_hour,
    'timeZone', coalesce(u.time_zone, 'UTC'))
    from public.users u where u.auth_uid = auth.uid() limit 1
$$;

create or replace function public.set_my_business_alerts(
  p_daily boolean, p_hour int, p_weekly boolean, p_cashout_day int, p_cashout_hour int)
returns void language plpgsql security definer set search_path to '' as $function$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_hour is null or p_hour not between 0 and 23 then raise exception 'Pick an hour'; end if;
  if p_cashout_hour is null or p_cashout_hour not between 0 and 23 then raise exception 'Pick an hour'; end if;
  if p_cashout_day is not null and p_cashout_day not between 0 and 6 then raise exception 'Pick a day'; end if;
  update public.users
     set biz_summary_daily = coalesce(p_daily, true), biz_summary_hour = p_hour,
         biz_summary_weekly = coalesce(p_weekly, true),
         biz_cashout_dow = p_cashout_day, biz_cashout_hour = p_cashout_hour
   where auth_uid = auth.uid() and account_type = 'business';
  if not found then raise exception 'Business accounts only'; end if;
end $function$;

revoke execute on function public.get_my_business_alerts() from anon, public;
revoke execute on function public.set_my_business_alerts(boolean, int, boolean, int, int) from anon, public;
grant execute on function public.get_my_business_alerts() to authenticated;
grant execute on function public.set_my_business_alerts(boolean, int, boolean, int, int) to authenticated;

-- Runs hourly (business-daily-summary, :47). Each business's local hour
-- decides what is due; the *_on dates keep each one to once.
create or replace function public.business_daily_summaries()
returns void language plpgsql security definer set search_path to '' as $function$
declare
  b record; tz text; local_now timestamp; today date; hr int; dow int;
  n int; total numeric; wk_start date; prev_total numeric; change text;
begin
  for b in
    select u.id, u.auth_uid, u.wallet_address, coalesce(u.time_zone, 'UTC') as tz,
           u.business_summary_on, u.business_weekly_on, u.business_cashout_on,
           u.biz_summary_daily, u.biz_summary_hour, u.biz_summary_weekly, u.biz_cashout_dow, u.biz_cashout_hour
      from public.users u
     where u.account_type = 'business'
       and exists (select 1 from public.merchant_applications m where m.auth_uid = u.auth_uid and m.status = 'approved')
  loop
    begin
      tz := b.tz;
      local_now := now() at time zone tz;
      today := local_now::date;
      hr := extract(hour from local_now)::int;
      dow := extract(dow from local_now)::int;  -- 0 Sunday

      -- Daily: today's payments, at the business's hour.
      if b.biz_summary_daily and hr = b.biz_summary_hour and b.business_summary_on is distinct from today then
        select count(*), coalesce(sum(p.amount), 0) into n, total
          from public.merchant_payments p
         where p.merchant_wallet = lower(b.wallet_address)
           and coalesce(p.screen_flag, '') = ''
           and p.created_at >= (today::timestamp at time zone tz)
           and p.created_at < ((today + 1)::timestamp at time zone tz);
        update public.users set business_summary_on = today where id = b.id;
        if n > 0 then
          insert into public.notifications (user_id, type, title, message, read)
          values (b.id::text, 'business_daily_summary', 'Today: $' || trim(to_char(total, 'FM999,999,990.00')),
                  n || case when n = 1 then ' payment' else ' payments' end || ' received today. Tap to see them.', false);
        end if;
      end if;

      -- Weekly: Monday, at the same hour - last Monday to Sunday.
      if b.biz_summary_weekly and dow = 1 and hr = b.biz_summary_hour and b.business_weekly_on is distinct from today then
        wk_start := today - 7;
        select count(*), coalesce(sum(p.amount), 0) into n, total
          from public.merchant_payments p
         where p.merchant_wallet = lower(b.wallet_address)
           and coalesce(p.screen_flag, '') = ''
           and p.created_at >= (wk_start::timestamp at time zone tz)
           and p.created_at < (today::timestamp at time zone tz);
        select coalesce(sum(p.amount), 0) into prev_total
          from public.merchant_payments p
         where p.merchant_wallet = lower(b.wallet_address)
           and coalesce(p.screen_flag, '') = ''
           and p.created_at >= ((wk_start - 7)::timestamp at time zone tz)
           and p.created_at < (wk_start::timestamp at time zone tz);
        update public.users set business_weekly_on = today where id = b.id;
        if n > 0 then
          change := case
            when prev_total <= 0 then ''
            when total >= prev_total then ', up ' || round((total - prev_total) / prev_total * 100) || '% on the week before'
            else ', down ' || round((prev_total - total) / prev_total * 100) || '% on the week before' end;
          insert into public.notifications (user_id, type, title, message, read)
          values (b.id::text, 'business_weekly_summary', 'Last week: $' || trim(to_char(total, 'FM999,999,990.00')),
                  n || case when n = 1 then ' payment' else ' payments' end || ' from ' || to_char(wk_start, 'FMDD Mon')
                  || ' to ' || to_char(today - 1, 'FMDD Mon') || change || '.', false);
        end if;
      end if;

      -- Cash-out day: the weekday and hour the business picked.
      if b.biz_cashout_dow is not null and dow = b.biz_cashout_dow and hr = b.biz_cashout_hour
         and b.business_cashout_on is distinct from today then
        update public.users set business_cashout_on = today where id = b.id;
        insert into public.notifications (user_id, type, title, message, read)
        values (b.id::text, 'business_cashout_due', 'Cash-out day',
                'Time to cash out to your bank. Tap to open Cash out - you approve it once.', false);
      end if;
    exception when others then null; -- one bad row never stops the rest
    end;
  end loop;
end $function$;
revoke execute on function public.business_daily_summaries() from anon, authenticated, public;

-- Push taps: summaries open Payments, the cash-out reminder opens Cash out.
do $do$
declare d text;
  old_case text := $q$when NEW.type in ('merchant_approved', 'business_staff_invite', 'business_daily_summary',$q$;
  new_case text := $q$when NEW.type in ('business_daily_summary', 'business_weekly_summary') then '/business?tab=payments'
                    when NEW.type = 'business_cashout_due' then '/business?screen=cashout'
                    when NEW.type in ('merchant_approved', 'business_staff_invite',$q$;
begin
  d := pg_get_functiondef('public.p2p_dispatch_push_for_notification()'::regprocedure);
  if position(new_case in d) > 0 then return; end if;
  if position(old_case in d) = 0 then raise exception 'p2p_dispatch_push_for_notification changed - update this migration'; end if;
  execute replace(d, old_case, new_case);
end $do$;
