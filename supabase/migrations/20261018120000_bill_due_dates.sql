-- Bills get an optional due date, and reminders to the customer: by hand
-- (Remind, at most once per 12 hours per bill) and automatic (a daily job
-- on the due date and every 3 days while overdue, at most 3).
alter table public.merchant_payment_intents
  add column if not exists due_date date,
  add column if not exists reminder_count integer not null default 0,
  add column if not exists auto_reminder_count integer not null default 0,
  add column if not exists last_reminded_at timestamptz;

-- Set by the database only; a due date within the next year.
create or replace function public.merchant_intents_due_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.reminder_count := 0; new.auto_reminder_count := 0; new.last_reminded_at := null;
    if new.due_date is not null and (new.due_date < (now() at time zone 'Asia/Kolkata')::date - 1
        or new.due_date > (now() at time zone 'Asia/Kolkata')::date + 366) then
      raise exception 'Pick a due date within the next year';
    end if;
  end if;
  return new;
end $$;
create or replace trigger merchant_intents_due_guard before insert on public.merchant_payment_intents
  for each row execute function public.merchant_intents_due_guard();
revoke execute on function public.merchant_intents_due_guard() from anon, authenticated, public;

create index if not exists merchant_intents_due_idx on public.merchant_payment_intents (due_date)
  where due_date is not null and status in ('pending', 'partially_paid');
