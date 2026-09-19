-- ============================================================
-- MeshPort: passkey-encrypted wallet backup for Google/Email accounts
--
-- Replaces the encrypted_wallet_key / wallet_auth_share / wallet-key Edge
-- Function design entirely. That design needed a server-held secret
-- (WALLET_KEY_ENCRYPTION_SECRET) to encrypt/decrypt — meaning that secret
-- plus a database dump together could reconstruct any social-login
-- account's key. This design has NO server-side secret at all: the
-- private key is encrypted CLIENT-SIDE with a key derived from a WebAuthn
-- passkey's `prf` extension (see src/lib/passkey.ts) before it ever
-- reaches Supabase. The server — including MeshPort's own Edge Functions,
-- which this design has none of — never sees plaintext, never holds a
-- decryption key, and never performs encryption or decryption itself.
--
-- Security model: `encrypted_wallet` is safe to read even in a full
-- database dump, because there is no secret anywhere in this database (or
-- in any MeshPort-controlled server) capable of decrypting it. Decryption
-- requires the PASSKEY itself, which lives in the user's platform account
-- (iCloud Keychain / Google Password Manager) — not in this table, not on
-- any MeshPort server, and not derivable from anything stored here.
--
-- This is why RLS alone (auth_uid = auth.uid()) is sufficient authorization
-- here, unlike the previous design which needed a custom identity-verified
-- Edge Function: even if RLS were somehow bypassed, the ciphertext alone
-- is still useless to an attacker who doesn't also control the user's
-- passkey.
-- ============================================================

create table if not exists public.wallet_backups (
  id                  uuid primary key default gen_random_uuid(),
  auth_uid             uuid not null unique references auth.users(id) on delete cascade,
  wallet_address        text not null,
  encrypted_wallet       text not null,   -- AES-256-GCM ciphertext of the PRIVATE KEY only, never a mnemonic
  iv                     text not null,
  passkey_credential_id  text,             -- which passkey this was encrypted for (helps target the right one at restore; not secret)
  algorithm_version      text not null default 'prf-aes256gcm-v1',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists wallet_backups_auth_uid_idx on public.wallet_backups (auth_uid);

alter table public.wallet_backups enable row level security;

drop policy if exists "wallet_backups_select" on public.wallet_backups;
drop policy if exists "wallet_backups_insert" on public.wallet_backups;
drop policy if exists "wallet_backups_update" on public.wallet_backups;

-- Only the row's own owner can read or write it — enforced by Postgres
-- itself, using the caller's real Supabase Auth session (auth.uid()).
-- No custom backend code sits between the client and this table; the
-- client calls supabase.from('wallet_backups')... directly.
create policy "wallet_backups_select" on public.wallet_backups
  for select using (auth_uid = auth.uid());

create policy "wallet_backups_insert" on public.wallet_backups
  for insert with check (auth_uid = auth.uid());

create policy "wallet_backups_update" on public.wallet_backups
  for update using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

-- No delete policy — losing your own backup row isn't something the
-- client should be able to do accidentally; support/admin only, via the
-- service role if ever genuinely needed.

comment on table public.wallet_backups is
  'Client-side-encrypted private key backups for Google/Email (social-login) wallets. No MeshPort server, past or present, holds a key capable of decrypting these rows — decryption requires the users own WebAuthn passkey (see src/lib/passkey.ts). create/import-wallet accounts never write to this table.';
