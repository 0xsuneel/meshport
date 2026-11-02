-- Email sign-in is kept for the admin panel only; the wallet app is Google
-- only. Supabase Auth "Before User Created" hook: a new account created with
-- email (an email code or email + password) is refused unless that email
-- belongs to an admin. Google and anonymous sign-ups are untouched.
--
-- Turn it on in the Supabase Dashboard: Authentication -> Hooks ->
-- Before User Created -> Postgres function -> public.hook_before_user_created.

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text := coalesce(event #>> '{user,app_metadata,provider}', '');
  v_email    text := lower(coalesce(event #>> '{user,email}', ''));
begin
  if v_provider = 'email'
     and not exists (select 1 from public.admin_users a where lower(a.email) = v_email) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Email sign-in is for the admin panel only. Continue with Google.'));
  end if;
  return '{}'::jsonb;
end;
$$;

revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
