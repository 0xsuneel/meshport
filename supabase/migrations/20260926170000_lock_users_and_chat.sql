-- Lock the users table and chats/messages to their owners.
--
-- APPLY ONLY AFTER the app build that uses the `bind-session` function is
-- live. Before this, the app linked a session to an account by writing
-- users.auth_uid itself — which anyone could do for ANY account. From here on
-- only bind-session (wallet-signature checked, service role) can change it.
--
-- What changes:
--   users         · anyone can still look people up (search, pay-by-username)
--                 · you can only edit YOUR row, and never its id, username,
--                   wallet address, login link (auth_uid) or created date
--                 · a new row is linked to the session that created it
--                 · one account per wallet address
--                 · the wallet-vault and backup-email columns are no longer
--                   readable/writable from the app at all
--   conversations · only the two people in it (no "unlinked account" loophole)
--   messages      · read: only people in the conversation
--                 · send: only as yourself, only text / payment_sent
--                 · edit: the recipient can only mark delivered/read; the
--                   sender can delete-for-everyone; nobody can change who
--                   sent it, where, when, or payment details
--                 · delete: only your own messages
-- Server code (service role: /api/chat, edge functions, cron) is unaffected.

begin;

-- ── users: guard the identity columns ──────────────────────────────────────
create or replace function public.users_client_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Only app requests (PostgREST roles) are restricted; server code isn't.
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.auth_uid := auth.uid();           -- linked to the creating session
    new.encrypted_wallet_key := null;
    new.wallet_auth_share := null;
    new.backup_email := null;
    new.created_at := now();
    return new;
  end if;

  -- UPDATE: identity columns keep their values (silently — registration's
  -- upsert re-sends them and must keep working).
  new.id                   := old.id;
  new.auth_uid             := old.auth_uid;
  new.wallet_address       := old.wallet_address;
  new.username             := old.username;
  new.created_at           := old.created_at;
  new.login_type           := old.login_type;
  new.encrypted_wallet_key := old.encrypted_wallet_key;
  new.wallet_auth_share    := old.wallet_auth_share;
  new.backup_email         := old.backup_email;
  -- Email is used to find the account at email login — it can be filled in
  -- once, not switched to someone else's.
  if coalesce(old.email, '') <> '' then
    new.email := old.email;
  end if;
  return new;
end
$$;

drop trigger if exists users_client_guard on public.users;
create trigger users_client_guard
  before insert or update on public.users
  for each row execute function public.users_client_guard();

drop policy if exists users_insert on public.users;
drop policy if exists users_update on public.users;
create policy users_insert on public.users
  for insert with check (auth.uid() is not null);
create policy users_update on public.users
  for update using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());
-- users_select stays open: username / address lookups are part of the app.

-- One account per wallet address (no duplicates exist today).
create unique index if not exists users_wallet_address_unique
  on public.users (lower(wallet_address))
  where coalesce(wallet_address, '') <> '';

-- Column access: the app never needs the wallet vault or backup email.
revoke select, insert, update on public.users from anon, authenticated;
grant select (id, username, display_name, email, wallet_address, avatar_url, created_at,
              auth_uid, notifications_cleared_at, login_type, chat_public_key)
  on public.users to anon, authenticated;
grant insert (id, username, display_name, email, wallet_address, avatar_url,
              notifications_cleared_at, login_type, chat_public_key)
  on public.users to anon, authenticated;
grant update (id, username, display_name, email, wallet_address, avatar_url,
              notifications_cleared_at, login_type, chat_public_key)
  on public.users to anon, authenticated;

-- ── conversations: only the two participants ───────────────────────────────
drop policy if exists conv_select on public.conversations;
drop policy if exists conv_insert on public.conversations;
drop policy if exists conv_update on public.conversations;

create policy conv_select on public.conversations for select using (
  exists (select 1 from public.users u
          where u.auth_uid = auth.uid()
            and u.id in (conversations.participant_a, conversations.participant_b)));
create policy conv_insert on public.conversations for insert with check (
  exists (select 1 from public.users u
          where u.auth_uid = auth.uid()
            and u.id in (conversations.participant_a, conversations.participant_b)));
create policy conv_update on public.conversations for update using (
  exists (select 1 from public.users u
          where u.auth_uid = auth.uid()
            and u.id in (conversations.participant_a, conversations.participant_b)))
  with check (
  exists (select 1 from public.users u
          where u.auth_uid = auth.uid()
            and u.id in (conversations.participant_a, conversations.participant_b)));

-- ── messages ────────────────────────────────────────────────────────────────
drop policy if exists msg_select on public.messages;
drop policy if exists msg_insert on public.messages;
drop policy if exists msg_update on public.messages;
drop policy if exists msg_delete on public.messages;

create policy msg_select on public.messages for select using (
  exists (select 1 from public.conversations c
          join public.users u on u.id in (c.participant_a, c.participant_b)
          where c.id = messages.conversation_id and u.auth_uid = auth.uid()));

create policy msg_insert on public.messages for insert with check (
  type in ('text', 'payment_sent')
  and exists (select 1 from public.users u
              where u.id = messages.sender_id and u.auth_uid = auth.uid())
  and exists (select 1 from public.conversations c
              where c.id = messages.conversation_id
                and messages.sender_id in (c.participant_a, c.participant_b)));

create policy msg_update on public.messages for update using (
  exists (select 1 from public.conversations c
          join public.users u on u.id in (c.participant_a, c.participant_b)
          where c.id = messages.conversation_id and u.auth_uid = auth.uid()));

create policy msg_delete on public.messages for delete using (
  exists (select 1 from public.users u
          where u.id = messages.sender_id and u.auth_uid = auth.uid()));

-- What an edit may change. Runs before messages_status_times (name order).
create or replace function public.messages_edit_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  is_sender boolean;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  -- Never changes: who sent it, where, when, and payment details.
  new.id              := old.id;
  new.sender_id       := old.sender_id;
  new.conversation_id := old.conversation_id;
  new.created_at      := old.created_at;
  new.payment_amount  := old.payment_amount;
  new.payment_tx_hash := old.payment_tx_hash;
  new.token_symbol    := old.token_symbol;
  new.reply_to_id     := old.reply_to_id;
  new.forwarded       := old.forwarded;

  select exists (select 1 from public.users u
                 where u.id = old.sender_id and u.auth_uid = auth.uid())
    into is_sender;

  if is_sender then
    -- The sender may delete for everyone (content → '[deleted]', type → text).
    if new.type is distinct from old.type and new.type <> 'text' then
      new.type := old.type;
    end if;
    if new.content is distinct from old.content and new.content <> '[deleted]' then
      new.content := old.content;
    end if;
  else
    -- The recipient may only mark it delivered / read.
    new.content    := old.content;
    new.type       := old.type;
    new.deleted_at := old.deleted_at;
  end if;
  return new;
end
$$;

drop trigger if exists messages_edit_guard on public.messages;
create trigger messages_edit_guard
  before update on public.messages
  for each row execute function public.messages_edit_guard();

commit;
