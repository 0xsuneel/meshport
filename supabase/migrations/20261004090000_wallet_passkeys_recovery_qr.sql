-- Self-custodial Google / email wallets.
--
-- wallet_passkeys: a passkey registered to the MeshPort account (users.id),
-- usable on any device the passkey syncs to. Holds only public credential
-- data plus the wallet key LOCKED with a secret that only the passkey's
-- authenticator can produce (WebAuthn PRF). The server can't open it: no
-- private key, passkey private key or PRF output is ever stored.
create table if not exists public.wallet_passkeys (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  credential_id    text not null unique,
  prf_salt         text not null,
  encrypted_wallet text not null, -- AES-256-GCM(HKDF(PRF output)), base64
  iv               text not null,
  wallet_address   text not null,
  label            text,
  created_at       timestamptz not null default now()
);
create index if not exists wallet_passkeys_user_idx on public.wallet_passkeys(user_id);

alter table public.wallet_passkeys enable row level security;
revoke all on public.wallet_passkeys from anon, authenticated;
grant select, insert, delete on public.wallet_passkeys to authenticated;

drop policy if exists wallet_passkeys_select on public.wallet_passkeys;
create policy wallet_passkeys_select on public.wallet_passkeys for select to authenticated
  using (exists (select 1 from public.users u where u.id = wallet_passkeys.user_id and u.auth_uid = auth.uid()));

-- Only for the caller's own account, and only for that account's wallet.
drop policy if exists wallet_passkeys_insert on public.wallet_passkeys;
create policy wallet_passkeys_insert on public.wallet_passkeys for insert to authenticated
  with check (exists (select 1 from public.users u
                      where u.id = wallet_passkeys.user_id and u.auth_uid = auth.uid()
                        and lower(u.wallet_address) = lower(wallet_passkeys.wallet_address)));

drop policy if exists wallet_passkeys_delete on public.wallet_passkeys;
create policy wallet_passkeys_delete on public.wallet_passkeys for delete to authenticated
  using (exists (select 1 from public.users u where u.id = wallet_passkeys.user_id and u.auth_uid = auth.uid()));

-- When the account's Recovery QR was made. Only a date: the QR itself, its
-- password and anything decrypted from it never reach the server.
alter table public.users add column if not exists recovery_qr_at timestamptz;
grant select (recovery_qr_at), update (recovery_qr_at) on public.users to authenticated;

-- chat_key_sig (20261003170000) was added without a grant, so publishing a
-- signed chat key failed. Same grants as chat_public_key.
grant select (chat_key_sig), insert (chat_key_sig), update (chat_key_sig) on public.users to authenticated;

-- wallet-key's forget-vault action audits as 'vault_deleted'.
alter table public.wallet_audit_log drop constraint if exists wallet_audit_log_operation_check;
alter table public.wallet_audit_log add constraint wallet_audit_log_operation_check
  check (operation = any (array['generate_wallet','restore_wallet','kek_rotation','legacy_migration','decrypt_failure','vault_deleted']));
