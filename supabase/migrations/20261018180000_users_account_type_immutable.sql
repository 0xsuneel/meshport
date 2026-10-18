-- An account's type (users.account_type) is fixed once it is created.
--
-- Clients already have no UPDATE grant on the column, but SECURITY DEFINER
-- functions run as their owner and bypass that. This trigger looks at the
-- caller's JWT role instead, so it also covers those functions: for an app
-- request (anon / authenticated) the type can't change, with one exception -
-- the business sign-up step itself (start_business_account, which marks the
-- transaction with meshport.business_signup). The service role (edge
-- functions, e.g. name-register) and direct database admin are unaffected.
create or replace function public.users_account_type_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if new.account_type is not distinct from old.account_type then
    return new;
  end if;
  if jwt_role not in ('anon', 'authenticated') and current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if old.account_type = 'personal' and new.account_type = 'business'
     and current_setting('meshport.business_signup', true) = 'on' then
    return new;
  end if;
  raise exception 'An account''s type can''t be changed (this is a % account)', old.account_type
    using errcode = '42501';
end
$$;

create or replace trigger users_account_type_guard
  before update on public.users
  for each row execute function public.users_account_type_guard();
