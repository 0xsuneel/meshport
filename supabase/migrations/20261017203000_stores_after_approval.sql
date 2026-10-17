-- A business account is its username (e.g. chaiwala.arc); stores are the
-- shops/outlets it opens after approval. Only approved businesses add stores.
alter policy bs_owner_insert on public.business_stores
  with check (owner_auth_uid = auth.uid() and exists (
    select 1 from public.merchant_applications a where a.auth_uid = auth.uid() and a.status = 'approved'));
