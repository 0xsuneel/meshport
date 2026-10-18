-- Merchant applications carry proof for the admin: a registration number
-- (GSTIN, Udyam, shop licence…) and up to 5 documents - ID, shop photo,
-- registration certificate. Files live in a PRIVATE bucket: only the owner
-- (their own folder) and admins can read them; admins open them through
-- short-lived signed links. A file can't be overwritten, and once an
-- application lists it the owner can't delete it either.

alter table public.merchant_applications
  add column if not exists registration_number text
    check (registration_number is null or char_length(registration_number) <= 40),
  add column if not exists documents jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('business-docs', 'business-docs', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists business_docs_insert_own on storage.objects;
create policy business_docs_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'business-docs' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists business_docs_select_own_or_admin on storage.objects;
create policy business_docs_select_own_or_admin on storage.objects for select to authenticated
  using (bucket_id = 'business-docs' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (select 1 from public.admin_users a where a.id = (select auth.uid()))));

-- Removing a file picked by mistake, before it's sent. Listed files stay.
drop policy if exists business_docs_delete_unsent on storage.objects;
create policy business_docs_delete_unsent on storage.objects for delete to authenticated
  using (bucket_id = 'business-docs' and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (select 1 from public.merchant_applications m
                     where m.documents @> jsonb_build_array(jsonb_build_object('path', storage.objects.name))));

-- Documents must be the applicant's own uploaded files: path in their
-- folder, the file present in the bucket, a known kind. Returns the list
-- trimmed to the fields the app reads.
create or replace function public.merchant_application_clean_documents(p_docs jsonb, p_uid uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare d jsonb; out jsonb := '[]'::jsonb; p text;
begin
  if p_docs is null or p_docs = 'null'::jsonb then return '[]'::jsonb; end if;
  if jsonb_typeof(p_docs) <> 'array' then raise exception 'Documents must be a list'; end if;
  if jsonb_array_length(p_docs) > 5 then raise exception 'Add up to 5 documents'; end if;
  for d in select * from jsonb_array_elements(p_docs) loop
    p := d->>'path';
    if p is null or p !~ ('^' || p_uid::text || '/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$') then
      raise exception 'Upload the document again';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'business-docs' and o.name = p) then
      raise exception 'A document did not finish uploading - add it again';
    end if;
    if coalesce(d->>'kind', '') not in ('id', 'shop_photo', 'registration', 'other') then
      raise exception 'Unknown document type';
    end if;
    out := out || jsonb_build_array(jsonb_build_object(
      'path', p, 'kind', d->>'kind', 'name', left(coalesce(nullif(trim(d->>'name'), ''), 'Document'), 120)));
  end loop;
  return out;
end $$;
revoke all on function public.merchant_application_clean_documents(jsonb, uuid) from public, anon, authenticated;

-- Same as before, plus: documents and registration number checked on insert
-- and locked afterwards like the other applicant fields.
create or replace function public.merchant_applications_before_write()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u record; relink boolean := coalesce(current_setting('meshport.merchant_relink', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    select id, wallet_address, username into u from public.users where auth_uid = new.auth_uid limit 1;
    if u.id is null then
      raise exception 'No MeshPort account found for this session';
    end if;
    new.user_id        := u.id::text;
    new.wallet_address := lower(u.wallet_address);
    new.username       := u.username;
    new.status         := 'pending';
    new.review_note    := null;
    new.reviewed_by    := null;
    new.reviewed_at    := null;
    new.registration_number := nullif(upper(trim(new.registration_number)), '');
    new.documents      := public.merchant_application_clean_documents(new.documents, new.auth_uid);
  else
    -- Identity is locked - except the owner's new login id, moved by
    -- merchant_relink_owner() when the same account signs in again.
    if not relink then new.auth_uid := old.auth_uid; end if;
    new.user_id := old.user_id;
    new.wallet_address := old.wallet_address; new.username := old.username;
    new.business_name := old.business_name; new.business_type := old.business_type;
    new.contact := old.contact; new.description := old.description;
    new.registration_number := old.registration_number; new.documents := old.documents;
    if new.status is distinct from old.status then new.reviewed_at := now(); end if;
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
