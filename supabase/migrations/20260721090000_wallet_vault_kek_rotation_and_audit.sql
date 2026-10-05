-- ============================================================
-- ArcPay: per-wallet derived KEK, key-rotation metadata, audit log
--
-- Three changes, all additive (no existing column dropped, no existing
-- row's ciphertext touched by this migration itself — re-encryption
-- happens lazily, at the application layer, the next time each row is
-- read; see supabase/functions/wallet-key/index.ts).
--
-- 1) wallet_vault gets a `wallet_id` — a second random identifier, distinct
--    from `user_id`, that becomes part of every KEK derivation from now on
--    (see the Edge Function). Rationale: HKDF(masterKEK, info = user_id +
--    wallet_id) means a leaked/guessable user_id ALONE is not enough to
--    derive that wallet's KEK — the attacker also needs wallet_id, which
--    is never derivable from anything public (not the wallet address, not
--    the user id, not the email). Pure defense-in-depth: user_id is
--    already a UUID and not realistically guessable either, but this
--    means compromising the identifier space in ANY single system
--    (auth.users, or a future multi-wallet-per-user id) is still not
--    sufficient on its own.
--
-- 2) `algorithm` and `kek_version` columns, alongside the existing
--    `version`. Together these let the crypto scheme evolve without a
--    schema migration:
--      - `version`      — which ENCRYPTION SCHEME this row uses (which
--                          code path decrypts it). Existing rows keep
--                          whatever they were written with; the Edge
--                          Function branches on this per-row.
--      - `algorithm`     — human-readable record of the actual primitive
--                          used (e.g. 'AES-256-GCM+HKDF-SHA256'), stored
--                          for audit/forensics even as `version` numbers
--                          are what code actually branches on.
--      - `kek_version`   — which MASTER KEK (env var WALLET_MASTER_KEK_V<n>)
--                          this row's MEK is currently wrapped under.
--                          Rotating the master KEK means adding a new
--                          WALLET_MASTER_KEK_V<n+1> secret and bumping
--                          WALLET_MASTER_KEK_CURRENT_VERSION — existing
--                          rows keep decrypting fine under their recorded
--                          kek_version (multiple KEK versions stay valid
--                          simultaneously) and are re-wrapped to the new
--                          version opportunistically, on next login, not
--                          in a single big-bang migration. See the Edge
--                          Function's `rewrapIfStale()`.
--
-- 3) wallet_audit_log — an insert-only, service-role-only audit trail.
--    Deliberately narrow schema: operational metadata only, enforced by
--    what code CAN write, not just convention — there is no column here
--    a private key, MEK, KEK, or any ciphertext could accidentally land
--    in. See the Edge Function's `logAudit()`, which is the only writer.
-- ============================================================

-- ── 1) wallet_id ─────────────────────────────────────────────────────────
alter table public.wallet_vault
  add column if not exists wallet_id uuid not null default gen_random_uuid();

-- Backfill safety: the default above already assigns a fresh wallet_id to
-- any pre-existing row when this column is added (Postgres 11+ computes
-- volatile defaults per-row for ADD COLUMN). This unique constraint is
-- added as a separate statement so a failure here is easy to diagnose
-- independently of the column addition.
alter table public.wallet_vault
  add constraint wallet_vault_wallet_id_key unique (wallet_id);

-- ── 2) rotation + algorithm-agility metadata ────────────────────────────
alter table public.wallet_vault
  add column if not exists algorithm text not null default 'AES-256-GCM+HKDF-SHA256';

alter table public.wallet_vault
  add column if not exists kek_version integer not null default 1;

comment on column public.wallet_vault.wallet_id is
  'Second random identifier (independent of user_id) folded into every KEK derivation. Never exposed to the client.';
comment on column public.wallet_vault.version is
  'Encryption SCHEME version for this row. The Edge Function branches decrypt logic on this value; new writes always use the current scheme, old rows keep decrypting under whatever scheme they were written with until lazily re-wrapped.';
comment on column public.wallet_vault.algorithm is
  'Human-readable record of the primitives used for this row, for audit/forensics. Not itself branched on by code — `version` is.';
comment on column public.wallet_vault.kek_version is
  'Which WALLET_MASTER_KEK_V<n> this row''s MEK is wrapped under. Lets the master KEK rotate without any row losing access — multiple versions stay valid simultaneously; see the Edge Function.';

-- ── 3) audit log ─────────────────────────────────────────────────────────
create table if not exists public.wallet_audit_log (
  id          bigint generated always as identity primary key,
  -- ON DELETE SET NULL (not CASCADE): the audit trail is meant to outlive
  -- account deletion for compliance/forensics purposes — losing the
  -- user_id linkage on deletion is acceptable, losing the row entirely
  -- is not.
  user_id     uuid references auth.users(id) on delete set null,
  wallet_id   uuid,
  operation   text not null check (operation in (
                'generate_wallet', 'restore_wallet', 'kek_rotation',
                'legacy_migration', 'decrypt_failure'
              )),
  success     boolean not null,
  occurred_at timestamptz not null default now(),
  device_id   text,
  ip_address  inet
);

create index if not exists wallet_audit_log_user_idx   on public.wallet_audit_log (user_id, occurred_at desc);
create index if not exists wallet_audit_log_wallet_idx on public.wallet_audit_log (wallet_id, occurred_at desc);
create index if not exists wallet_audit_log_op_idx     on public.wallet_audit_log (operation, occurred_at desc);

alter table public.wallet_audit_log enable row level security;

-- No policies at all: default-deny for anon/authenticated. Only the
-- service role (used exclusively by the wallet-key Edge Function) can
-- read or write this table. No update/delete policy for ANYONE, service
-- role included by convention — this is meant to be an append-only log;
-- if a retention policy is needed later, prune with a scheduled job using
-- the service role directly (e.g. `delete ... where occurred_at < now() -
-- interval '2 years'`), not a client-reachable policy.
revoke all on public.wallet_audit_log from anon, authenticated;

comment on table public.wallet_audit_log is
  'Append-only audit trail for wallet-key operations. Columns are deliberately narrow: operational metadata only. NEVER add a column here that could hold a private key, seed phrase, MEK, KEK, or any ciphertext — see the Edge Function''s logAudit(), the only writer, for the enforced allow-list.';
