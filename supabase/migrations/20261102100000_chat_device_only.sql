-- Device-only chat (owner's decision, 1 Nov): text, photos and files live on
-- people's phones. The server holds an encrypted chat message only until the
-- recipient's phone takes it (chat_take_mail), then it is deleted.
-- Payment cards (payment_sent / payment_received) stay in Supabase for good:
-- payment history shows on every device, as on the block explorer.
-- Receipts and "delete for everyone" travel the same way as small 'signal'
-- rows (message ids and a time - no content), each taken by the other side.

-- ── 1. chat_take_mail: my waiting chat messages, handed over and deleted ────
-- Mine = in a conversation I'm in, not a payment card, and sent by the other
-- person (in a chat with myself: by me). Not yet: 'e2e:q2:' messages still
-- waiting for my chat key (the sender re-seals them first).
-- Each handed-over message (not signals) leaves the sender a 'delivered' signal.
create or replace function public.chat_take_mail(p_limit int default 200)
returns setof public.messages
language plpgsql security definer set search_path = ''
as $$
declare me uuid[] := public.my_user_ids();
begin
  if coalesce(array_length(me, 1), 0) = 0 then return; end if;
  return query
  with mine as (
    select m.id
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
     where (c.participant_a = any(me) or c.participant_b = any(me))
       and m.type not in ('payment_sent', 'payment_received')
       and coalesce(m.content, '') not like 'e2e:q2:%'
       and (case when c.participant_a = c.participant_b then m.sender_id = any(me) else not (m.sender_id = any(me)) end)
     order by m.created_at
     limit greatest(1, least(p_limit, 500))
     for update of m skip locked
  ), taken as (
    delete from public.messages d using mine where d.id = mine.id returning d.*
  ), receipts as (
    insert into public.messages (conversation_id, sender_id, type, content, is_read)
    select t.conversation_id,
           case when c.participant_a = any(me) then c.participant_a else c.participant_b end,
           'signal',
           jsonb_build_object('kind', 'delivered', 'ids', jsonb_agg(t.id), 'at', now())::text,
           false
      from taken t join public.conversations c on c.id = t.conversation_id
     where t.type <> 'signal' and c.participant_a <> c.participant_b
     group by t.conversation_id, c.participant_a, c.participant_b
    returning 1
  )
  select * from taken order by created_at;
end $$;

-- ── 2. chat_signal: a read receipt or a delete-for-everyone, ids only ──────
create or replace function public.chat_signal(p_conversation uuid, p_kind text, p_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare me uuid[] := public.my_user_ids(); sender uuid;
begin
  if p_kind not in ('read', 'delete') then raise exception 'unknown signal'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 500 then raise exception 'bad ids'; end if;
  select case when c.participant_a = any(me) then c.participant_a when c.participant_b = any(me) then c.participant_b end
    into sender from public.conversations c where c.id = p_conversation;
  if sender is null then raise exception 'not your conversation'; end if;
  if public.chat_blocked_in(p_conversation, sender) then return; end if;
  -- Deleting my own message that hasn't been taken yet: gone from the server too.
  if p_kind = 'delete' then
    delete from public.messages where id = any(p_ids) and conversation_id = p_conversation
      and sender_id = any(me) and type not in ('payment_sent', 'payment_received');
  end if;
  insert into public.messages (conversation_id, sender_id, type, content, is_read)
  values (p_conversation, sender, 'signal',
          jsonb_build_object('kind', p_kind, 'ids', to_jsonb(p_ids), 'at', now())::text, false);
end $$;

revoke all on function public.chat_take_mail(int) from public;
revoke all on function public.chat_signal(uuid, text, uuid[]) from public;
grant execute on function public.chat_take_mail(int) to authenticated;
grant execute on function public.chat_signal(uuid, text, uuid[]) to authenticated;

-- ── 3. Conversations keep no message content ───────────────────────────────
update public.conversations set last_message = null where last_message is not null;

-- ── 4. attachments bucket: anyone could change or delete any file ─────────
-- Reads stay public (avatars, P2P proofs, encrypted chat files by link).
drop policy if exists "Allow all operations 1mt4rzk_0" on storage.objects;
drop policy if exists "Allow all operations 1mt4rzk_1" on storage.objects;
drop policy if exists "Allow all operations 1mt4rzk_2" on storage.objects;
drop policy if exists "Allow all operations 1mt4rzk_3" on storage.objects;
drop policy if exists "Allow public updates" on storage.objects;
drop policy if exists "Allow public uploads" on storage.objects;
drop policy if exists attachments_upload on storage.objects;
drop policy if exists attachments_owner_update on storage.objects;
drop policy if exists attachments_delete on storage.objects;
create policy attachments_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments');
create policy attachments_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'attachments' and owner = auth.uid());
-- Delete: the uploader; a chat file (chat/<conversation>/…) also by either
-- person in that conversation - the recipient removes it once it's on the phone.
create policy attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (
    owner = auth.uid()
    or ((storage.foldername(name))[1] = 'chat' and exists (
      select 1 from public.conversations c
       where c.id::text = (storage.foldername(name))[2]
         and (c.participant_a = any(public.my_user_ids()) or c.participant_b = any(public.my_user_ids()))))
  ));
