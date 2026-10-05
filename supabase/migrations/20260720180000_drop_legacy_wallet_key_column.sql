-- ============================================================
-- ArcPay: drop the legacy encrypted_wallet_key column — GUARDED.
--
-- Do NOT run this immediately after deploying the wallet-key Edge
-- Function change. encrypted_wallet_key rows are migrated LAZILY — the
-- first time each affected user's account is touched by the updated
-- Edge Function (generate-wallet or restore-full-key), it is decrypted
-- with the legacy secret, re-encrypted as envelope encryption, written to
-- wallet_vault, and only THEN cleared from this column. Until every
-- existing social-login account has logged in at least once post-deploy,
-- some rows may still hold live data here.
--
-- This migration is intentionally self-guarding: it raises and aborts if
-- any row still has a non-null value, instead of silently discarding
-- data. Check first with:
--   select count(*) from public.users where encrypted_wallet_key is not null;
-- Re-run this migration once that returns 0.
-- ============================================================

do $$
declare
  remaining int;
begin
  select count(*) into remaining from public.users where encrypted_wallet_key is not null;

  if remaining > 0 then
    raise exception
      'Refusing to drop encrypted_wallet_key: % row(s) still hold un-migrated legacy wallet data. Have every social-login user log in at least once (which lazily migrates them to wallet_vault) before re-running this migration.',
      remaining;
  end if;

  alter table public.users drop column if exists encrypted_wallet_key;
end $$;
