-- Business accounts: other-chain receipts reach the app live (pop-up, payments
-- list, "to settle") instead of waiting for the 30 s refresh. RLS still
-- applies: a business only receives its own wallet's rows (mcr_select_business).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'merchant_chain_receipts') then
    alter publication supabase_realtime add table public.merchant_chain_receipts;
  end if;
end $$;
