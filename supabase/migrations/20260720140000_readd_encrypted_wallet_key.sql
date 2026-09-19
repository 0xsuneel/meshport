-- ============================================================
-- MeshPort: re-add encrypted_wallet_key — back to server-side backup
--
-- This column existed before (see 20260720090000_social_wallet_key_backup.sql),
-- was dropped when this app switched to a passkey/WebAuthn-based design
-- (20260720130000_drop_encrypted_wallet_key.sql), and is being re-added now
-- because passkeys proved unreliable in production (network-timing
-- sensitivity mid-ceremony, OS-level passkey provider state, browser rules
-- requiring a direct user gesture for navigator.credentials.get() — several
-- of which broke in practice with no clear self-service recovery for the
-- user). This is a deliberate reliability-over-single-point-of-failure
-- tradeoff, made a second time, consciously, not a reversal by accident.
--
-- Same security model as before: encrypted server-side with
-- WALLET_KEY_ENCRYPTION_SECRET (a Supabase project secret, never sent to
-- the client), reachable only via the wallet-key Edge Function
-- (action: generate-wallet / restore-full-key) using the service role.
-- Revoked from anon/authenticated for both read and write from the start.
-- ============================================================

alter table public.users
  add column if not exists encrypted_wallet_key text;

comment on column public.users.encrypted_wallet_key is
  'Server-side AES-256-GCM ciphertext of the private key for Google/Email (social) accounts only. Encrypted with a server-only secret (WALLET_KEY_ENCRYPTION_SECRET), never a client-derived key. Never contains a mnemonic/seed phrase. Reachable only via the wallet-key Supabase Edge Function (action: generate-wallet / restore-full-key) using the service role — revoked from anon/authenticated below.';

revoke select (encrypted_wallet_key) on public.users from anon, authenticated;
revoke insert (encrypted_wallet_key) on public.users from anon, authenticated;
revoke update (encrypted_wallet_key) on public.users from anon, authenticated;
