-- ============================================================
-- MeshPort: drop wallet_backups — dead table, passkey design removed
--
-- Added in 20260720120000_passkey_wallet_backup.sql for client-side,
-- passkey/PRF-encrypted wallet backups. That design is removed — see
-- 20260720140000_readd_encrypted_wallet_key.sql for the reasoning
-- (passkey restoration proved unreliable in production). No code writes
-- to or reads from this table anymore.
-- ============================================================

drop table if exists public.wallet_backups;
