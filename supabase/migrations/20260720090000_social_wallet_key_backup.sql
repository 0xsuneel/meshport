-- ============================================================
-- MeshPort: re-introduce server-side wallet key backup — Google/Email
-- (social-login) accounts ONLY, not create/import-wallet accounts.
--
-- CONTEXT — read before touching this again: server-side wallet backup
-- existed before (encrypted_private_key, mnemonic_hint), was found to be
-- readable by ANY caller holding the public anon key because RLS only
-- restricts rows, not columns (see 20260719140000_revoke_wallet_secret_
-- columns.sql), and was then removed entirely (see 20260719150000_
-- remove_wallet_backup_columns.sql) as a deliberate privacy decision.
--
-- WHY THIS IS DIFFERENT THIS TIME:
--   1. Only the PRIVATE KEY is ever stored — never a mnemonic/seed phrase.
--      A compromised key can be rotated by generating a new wallet; a
--      compromised seed phrase compromises every key ever derivable from
--      it. This column intentionally has no seed-phrase equivalent.
--   2. Encryption happens SERVER-SIDE (see supabase/functions/wallet-key (action: save-full-key / restore-full-key)), with a
--      symmetric key that only exists in the server's environment
--      (WALLET_KEY_ENCRYPTION_SECRET) and is never sent to the client.
--      The old design encrypted client-side with the user's passcode,
--      which is what let a new-passcode-on-a-new-device flow silently
--      break restoration — this design doesn't depend on the passcode
--      at all for decryption, only for re-caching locally afterward.
--   3. This column is revoked from anon/authenticated for BOTH read and
--      write, from the moment it's created — there is no window where
--      it's reachable directly with the public anon key. All access goes
--      through the wallet-key Supabase Edge Function, which verify the caller's Supabase
--      session before using the service role (which bypasses RLS/grants,
--      same as every other server endpoint in this app).
--   4. Scoped by convention to accounts with login_type = 'social' —
--      create/import-wallet accounts never call the endpoint that writes
--      this column, so it stays null for them, and the app's own
--      restoreWallet.ts only ever queries it for walletSource ===
--      'social-auto'.
-- ============================================================

alter table public.users
  add column if not exists encrypted_wallet_key text;

comment on column public.users.encrypted_wallet_key is
  'Server-side AES-256-GCM ciphertext of the private key for Google/Email (social) accounts only. Encrypted with a server-only secret (WALLET_KEY_ENCRYPTION_SECRET), never a client-derived key. Never contains a mnemonic/seed phrase. Reachable only via supabase/functions/wallet-key (action: save-full-key / restore-full-key) using the service role — revoked from anon/authenticated below.';

-- Lock this out for anon/authenticated from day one — same lesson as the
-- prior incident, applied up front instead of as a follow-up patch.
revoke select (encrypted_wallet_key) on public.users from anon, authenticated;
revoke insert (encrypted_wallet_key) on public.users from anon, authenticated;
revoke update (encrypted_wallet_key) on public.users from anon, authenticated;
