-- Anyone signed in can create a personal request; merchant orders (not
-- personal: multi-chain, bills, stores) only for an approved business. The
-- before-write trigger decides `personal`; this re-checks it.
alter policy mpi_insert_own on public.merchant_payment_intents
  with check (
    (select auth.uid()) is not null
    and merchant_auth_uid = (select auth.uid())
    and (coalesce(personal, true) and items is null and store_id is null
         or exists (select 1 from public.merchant_applications a
                     where a.auth_uid = (select auth.uid()) and a.status = 'approved'))
  );
