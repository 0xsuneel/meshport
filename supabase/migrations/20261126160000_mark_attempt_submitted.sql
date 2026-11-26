-- "Mark sent" without an Edge Function (docs/SUPABASE_LIGHT_PLAN.md, Phase 3).
-- pay-intent / swap-intent / bulkpay-intent each had action=markSubmitted: an
-- Edge Function call per payment that only checked the attempt is the
-- caller's and saved the tx hash. Same checks, as a database function:
--   - the caller's wallet: users.wallet_address where auth_uid = auth.uid()
--     (what the functions' callerWallet() does);
--   - the attempt must be that wallet's (attemptOwnedBy);
--   - the hash must start with 0x (markPayAttemptSubmitted & co.);
--   - the write is the same: tx_hash (lowercased), status SUBMITTED,
--     submitted_at now. The transaction_attempts_confirm_on_submit trigger
--     still starts the confirmation, as before.
-- Returns {success} or {success:false, error}; 'not_linked' tells the app to
-- re-link the session and retry (invokeLinked's 401/403 path).

create or replace function public.mark_attempt_submitted(p_attempt_id uuid, p_tx_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me     text;
  owner  text;
  hash   text := lower(coalesce(p_tx_hash, ''));
begin
  if p_attempt_id is null then
    return jsonb_build_object('success', false, 'error', 'attemptId required');
  end if;
  if hash = '' or left(hash, 2) <> '0x' then
    return jsonb_build_object('success', false, 'error', 'a valid txHash is required');
  end if;
  if auth.uid() is null then
    return jsonb_build_object('success', false, 'error', 'not_linked');
  end if;
  select lower(u.wallet_address) into me from users u where u.auth_uid = auth.uid() limit 1;
  if me is null or me = '' then
    return jsonb_build_object('success', false, 'error', 'not_linked');
  end if;
  select lower(a.wallet_address) into owner from transaction_attempts a where a.id = p_attempt_id;
  if owner is null or owner <> me then
    return jsonb_build_object('success', false, 'error', 'Not your transaction');
  end if;
  update transaction_attempts
     set tx_hash = hash, status = 'SUBMITTED', submitted_at = now()
   where id = p_attempt_id;
  return jsonb_build_object('success', true);
end
$$;
revoke all on function public.mark_attempt_submitted(uuid, text) from public, anon;
grant execute on function public.mark_attempt_submitted(uuid, text) to authenticated;
