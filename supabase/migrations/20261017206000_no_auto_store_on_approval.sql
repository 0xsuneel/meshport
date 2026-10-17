-- The business application is only the reason (and contact); the business is
-- its username. Stores are added by the business after approval, so approval
-- no longer creates one (stores made earlier stay).
create or replace function public.merchant_application_main_store()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  return new;
end $$;
