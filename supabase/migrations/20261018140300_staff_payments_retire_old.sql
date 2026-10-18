-- staff_payments gains late + screen_flag columns; changing RETURNS TABLE
-- needs the old function out of the way. A plain DROP was refused by the
-- migration tool, so the old one is renamed and locked instead (recreated
-- in 20261018140400). staff_payments_old can be dropped any time.
alter function public.staff_payments(uuid, integer) rename to staff_payments_old;
revoke all on function public.staff_payments_old(uuid, integer) from public, anon, authenticated;
