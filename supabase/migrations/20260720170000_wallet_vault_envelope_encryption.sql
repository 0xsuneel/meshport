-- ============================================================
-- ArcPay: wallet_vault — envelope-encrypted wallet storage for
-- social-login (Google + Email-OTP, unified "social" login_type) accounts.
--
-- REPLACES: public.users.encrypted_wallet_key (single-secret encryption —
-- WALLET_KEY_ENCRYPTION_SECRET directly encrypted the private key). That
-- column is NOT dropped by this migration — see
-- 20260720180000_drop_legacy_wallet_key_column.sql, which drops it only
-- once every row has been lazily migrated (the updated wallet-key Edge
-- Function migrates a row the first time it's touched — see that
-- function's header comment). Dropping it here, immediately, would risk
-- data loss for any account that hasn't logged in since this deployed.
--
-- WHY ENVELOPE ENCRYPTION (MEK + KEK) INSTEAD OF DIRECT KEK ENCRYPTION:
-- The previous design used ONE server secret (WALLET_KEY_ENCRYPTION_SECRET)
-- to encrypt the private key directly. This design generates a random
-- 256-bit Master Encryption Key (MEK) PER WALLET, encrypts the wallet with
-- a key derived from that MEK, and encrypts the MEK itself with a single
-- server-side Key-Encryption-Key (KEK, env var WALLET_KEK). Two concrete
-- benefits over direct encryption:
--   1. KEK rotation only re-encrypts small 32-byte MEKs, not every wallet.
--   2. The KEK's cryptographic exposure is minimal — it only ever touches
--      fixed-size, high-entropy MEK material, never variable-length
--      wallet ciphertext.
-- Being honest about what this does NOT change: WALLET_KEK (env var) + a
-- dump of this table TOGETHER can still reconstruct any social-login
-- account's wallet — same class of tradeoff as before, now two layers
-- deep instead of one. This is a deliberate reliability/UX choice
-- (documented at length in supabase/functions/wallet-key/index.ts),
-- not an oversight.
--
-- The app passcode is NEVER involved anywhere in this table or its
-- Edge Function. It is a local app-lock only (see src/lib/security.ts,
-- hashPasscode/verifyPasscode) — it cannot decrypt a wallet and never
-- has to match anything for a wallet to be restored. Users may set a new
-- passcode on every login without affecting the wallet in any way.
-- ============================================================

create table if not exists public.wallet_vault (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  wallet_address    text not null unique,

  -- AES-256-GCM ciphertext (base64) of the private key, encrypted with a
  -- key derived (via HKDF-SHA256, using `salt` below) from the random MEK.
  encrypted_wallet  text not null,

  -- Self-contained envelope: "v1:<iv-base64>:<ciphertext-base64>" — the
  -- random 256-bit MEK, AES-256-GCM-encrypted under the server KEK
  -- (WALLET_KEK). The MEK's own IV is packed inside this string so this
  -- table has exactly one top-level `iv` column, as specified, which is
  -- reserved for `encrypted_wallet`'s IV below.
  encrypted_mek     text not null,

  -- base64 96-bit IV used for `encrypted_wallet` (AES-GCM requires a
  -- unique IV per encryption; generated fresh every time a wallet is
  -- written, including on migration from the legacy column).
  iv                text not null,

  -- base64 HKDF salt used to derive the AES-256-GCM key for
  -- `encrypted_wallet` from the MEK. Provides key separation per record
  -- even though the MEK itself is already unique per wallet.
  salt              text not null,

  -- Crypto scheme version. Lets the KEK/HKDF derivation change in the
  -- future (e.g. a v2 with a rotated KEK) without breaking rows written
  -- under v1 — the Edge Function branches on this when decrypting.
  version           integer not null default 1,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists wallet_vault_wallet_address_idx on public.wallet_vault (wallet_address);

-- ── Keep updated_at honest ──────────────────────────────────────────────
create or replace function public.wallet_vault_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists wallet_vault_updated_at on public.wallet_vault;
create trigger wallet_vault_updated_at
  before update on public.wallet_vault
  for each row execute function public.wallet_vault_set_updated_at();

-- ── Access model: service role ONLY ─────────────────────────────────────
-- No anon/authenticated policy is created at all — RLS enabled with zero
-- policies is default-deny for every non-service-role caller. The ONLY
-- way to reach this table is the wallet-key Supabase Edge Function, which
-- authenticates the caller's session first (supabase.auth.getUser(jwt))
-- and then uses the service role, which bypasses RLS by design. Explicit
-- column-level revokes below are defense-in-depth, matching the pattern
-- already used elsewhere in this schema (see
-- 20260719140000_revoke_wallet_secret_columns.sql).
alter table public.wallet_vault enable row level security;

revoke all on public.wallet_vault from anon, authenticated;

comment on table public.wallet_vault is
  'Envelope-encrypted wallet storage for social-login (Google + Email-OTP) accounts only. Each row: a private key encrypted under a per-wallet random 256-bit MEK, which is itself encrypted under the server-only KEK (WALLET_KEK). Reachable only via the wallet-key Edge Function using the service role. create/import-wallet accounts never write here — their key never leaves the browser.';
