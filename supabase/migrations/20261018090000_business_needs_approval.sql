-- Business features turn on only after MeshPort approves the business:
-- the Shop QR takes orders and staff can be invited only once approved.
do $$
declare d text;
begin
  select pg_get_functiondef('public.shop_open_order(text, numeric, uuid, text)'::regprocedure) into d;
  d := replace(d, $r$ok := coalesce(u.account_type, 'personal') = 'business' or exists ($r$, $r$ok := exists ($r$);
  execute d;
  select pg_get_functiondef('public.business_staff_invite(text, text, uuid)'::regprocedure) into d;
  d := replace(d, $r$  if coalesce(me.account_type, 'personal') <> 'business'
     and not exists$r$, $r$  if not exists$r$);
  d := replace(d, $r$'Only business accounts can add staff'$r$, $r$'Staff can be added once your business is approved'$r$);
  execute d;
end $$;
