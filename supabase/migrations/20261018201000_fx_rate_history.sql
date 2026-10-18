-- Rate history for tax-ready exports: the Business CSV shows each payment's
-- rupee value at the rate in effect when it arrived. p2p_fx_rates only keeps
-- the latest rate (refreshed every 15 minutes from open.er-api.com, which
-- publishes once a day); every time a currency's rate changes, the new rate
-- is appended here with the time it was seen. Rates are public data.

create table if not exists public.fx_rate_history (
  id       bigint generated always as identity primary key,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  usd_rate numeric not null check (usd_rate > 0),
  rate_at  timestamptz not null default now()
);
create index if not exists fx_rate_history_currency_at on public.fx_rate_history (currency, rate_at desc);
alter table public.fx_rate_history enable row level security;
drop policy if exists fx_rate_history_read on public.fx_rate_history;
create policy fx_rate_history_read on public.fx_rate_history for select using (true);
revoke insert, update, delete on public.fx_rate_history from anon, authenticated;

create or replace function public.fx_rate_history_append()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'INSERT' or new.usd_rate is distinct from old.usd_rate then
    insert into public.fx_rate_history (currency, usd_rate, rate_at) values (new.currency, new.usd_rate, new.updated_at);
  end if;
  return new;
end $$;
revoke all on function public.fx_rate_history_append() from public, anon, authenticated;

drop trigger if exists fx_rate_history_append on public.p2p_fx_rates;
create trigger fx_rate_history_append after insert or update of usd_rate on public.p2p_fx_rates
  for each row execute function public.fx_rate_history_append();

-- Start the history from the rates held now.
insert into public.fx_rate_history (currency, usd_rate, rate_at)
select r.currency, r.usd_rate, r.updated_at from public.p2p_fx_rates r
where not exists (select 1 from public.fx_rate_history h where h.currency = r.currency);
