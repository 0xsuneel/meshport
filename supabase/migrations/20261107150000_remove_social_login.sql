-- Social login (Google / Circle user-controlled wallets) was removed from the
-- app: sign-in is Create New Wallet or Import Existing Wallet only.
-- Drops the social tables and columns and the one social account.

-- The users guard no longer touches the dropped columns.
create or replace function public.users_client_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.auth_uid := auth.uid();
    new.backup_email := null;
    new.created_at := now();
    return new;
  end if;
  new.id             := old.id;
  new.auth_uid       := old.auth_uid;
  new.wallet_address := old.wallet_address;
  new.username       := old.username;
  new.created_at     := old.created_at;
  new.login_type     := old.login_type;
  new.backup_email   := old.backup_email;
  if coalesce(old.email, '') <> '' then
    new.email := old.email;
  end if;
  return new;
end
$function$;

-- Email sign-in stays admin-only; the message no longer points to Google.
-- (Turn the Google provider off in Supabase Auth settings.)
create or replace function public.hook_before_user_created(event jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_provider text := coalesce(event #>> '{user,app_metadata,provider}', '');
  v_email    text := lower(coalesce(event #>> '{user,email}', ''));
begin
  if v_provider = 'email'
     and not exists (select 1 from public.admin_users a where lower(a.email) = v_email) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Email sign-in is for the admin panel only. Create or import a wallet.'));
  end if;
  return '{}'::jsonb;
end;
$function$;

drop table if exists public.circle_wallet_users;
drop table if exists public.wallet_passkeys;

alter table public.users
  drop column if exists encrypted_wallet_key,
  drop column if exists wallet_auth_share,
  drop column if exists recovery_qr_at;

-- The social accounts and their Google sign-ins.
delete from auth.users where id in (select auth_uid from public.users where login_type = 'social' and auth_uid is not null);
delete from public.users where login_type = 'social';
delete from auth.users where id in (select user_id from auth.identities where provider = 'google');

alter table public.users drop constraint if exists users_login_type_check;
alter table public.users add constraint users_login_type_check check (login_type is null or login_type = 'wallet');
