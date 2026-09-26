-- The catch-up notifier (AppLayout.tsx, for claims that complete while the
-- user isn't watching MultichainClaimPage) was showing the gross claimed
-- amount instead of the actual net amount that arrived, because this RPC
-- never selected arrived_amount in the first place -- there was nothing
-- for the client to prefer. The live-path notifier already does this
-- correctly (c.arrivedAmount ?? c.amount); this brings the catch-up path
-- to parity by giving it arrived_amount to work with.
drop function if exists get_and_mark_unnotified_claims(text);

create or replace function get_and_mark_unnotified_claims(p_wallet_address text)
returns table(id uuid, amount numeric, arrived_amount numeric, source_chain text, completed_at timestamptz)
language plpgsql
security definer
as $function$
begin
  return query
  update public.claims c
  set user_notified_at = now()
  where c.wallet_address = lower(p_wallet_address)
    and c.status = 'completed'
    and c.user_notified_at is null
  returning c.id, c.amount, c.arrived_amount, c.source_chain, c.completed_at;
end;
$function$;
