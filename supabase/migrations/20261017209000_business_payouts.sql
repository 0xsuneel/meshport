-- Business → Payouts: saved payout lists (staff, suppliers) with an optional
-- repeat. Payouts are signed on the owner's device, so a due payout is a
-- reminder ("Payroll is due") that opens Bulk Pay filled in - never an
-- automatic send.
create table if not exists public.business_payouts (
  id             uuid primary key default gen_random_uuid(),
  owner_auth_uid uuid not null default auth.uid(),
  name           text not null check (char_length(trim(name)) between 1 and 60),
  -- [{ "to": "ravi.arc" | "0x…", "amount": 120.5, "label": "Cook" }]
  recipients     jsonb not null default '[]'::jsonb check (jsonb_typeof(recipients) = 'array' and jsonb_array_length(recipients) <= 100),
  repeat         text not null default 'none' check (repeat in ('none', 'weekly', 'monthly')),
  next_due       date,
  last_paid_at   timestamptz,
  reminded_for   date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists business_payouts_owner on public.business_payouts (owner_auth_uid);
create index if not exists business_payouts_due on public.business_payouts (next_due) where next_due is not null;
alter table public.business_payouts enable row level security;
create policy bp_select on public.business_payouts for select to authenticated using (owner_auth_uid = auth.uid());
create policy bp_insert on public.business_payouts for insert to authenticated with check (owner_auth_uid = auth.uid());
create policy bp_update on public.business_payouts for update to authenticated using (owner_auth_uid = auth.uid()) with check (owner_auth_uid = auth.uid());
create policy bp_delete on public.business_payouts for delete to authenticated using (owner_auth_uid = auth.uid());

-- Paid: a repeating payout moves to its next date, a one-off is done.
create or replace function public.business_payout_paid(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.business_payouts set
    last_paid_at = now(), updated_at = now(), reminded_for = null,
    next_due = case repeat
      when 'weekly'  then greatest(coalesce(next_due, current_date), current_date - 6) + 7
      when 'monthly' then (greatest(coalesce(next_due, current_date), current_date - 27) + interval '1 month')::date
      else null end
  where id = p_id and owner_auth_uid = auth.uid();
end $$;
revoke all on function public.business_payout_paid(uuid) from public;
grant execute on function public.business_payout_paid(uuid) to authenticated;

-- Daily reminder on the due date (once per due date).
create or replace function public.business_payout_reminders()
returns void language plpgsql security definer set search_path = '' as $$
declare p record;
begin
  for p in
    select b.id, b.name, b.next_due, u.id as user_id,
           (select coalesce(sum((r->>'amount')::numeric), 0) from jsonb_array_elements(b.recipients) r) as total,
           jsonb_array_length(b.recipients) as n
      from public.business_payouts b join public.users u on u.auth_uid = b.owner_auth_uid
     where b.next_due is not null and b.next_due <= current_date
       and b.reminded_for is distinct from b.next_due
  loop
    insert into public.notifications (user_id, type, title, message, read)
    values (p.user_id::text, 'business_payout_due', p.name || ' is due',
            'Pay $' || to_char(p.total, 'FM999,999,990.00') || ' to ' || p.n || case when p.n = 1 then ' person' else ' people' end || ' - open Business → Payouts.', false);
    update public.business_payouts set reminded_for = p.next_due where id = p.id;
  end loop;
end $$;
revoke all on function public.business_payout_reminders() from public;

select cron.schedule('business-payout-reminders', '7 * * * *', 'select public.business_payout_reminders()');

