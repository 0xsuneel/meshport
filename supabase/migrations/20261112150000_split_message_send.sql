-- Sending a split group message: the server fills in the sender.
-- The insert rule looked the sender up in public.users, which the app's role
-- can't read ("permission denied for table users") - every send failed.
-- Messages now go through split_send_message (security definer): it checks
-- the caller is in the split and sets sender_user_id itself, so a sender can
-- never be spoofed. Direct inserts are no longer allowed.

drop policy if exists split_messages_send on public.split_messages;

create or replace function public.split_send_message(p_split uuid, p_body text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare me uuid; b text := btrim(coalesce(p_body, '')); m public.split_messages;
begin
  if auth.uid() is null then raise exception 'Sign in to send messages'; end if;
  if not public.is_split_member(p_split) then raise exception 'Split not found'; end if;
  if char_length(b) < 1 then raise exception 'Nothing to send'; end if;
  if char_length(b) > 1000 then b := left(b, 1000); end if;
  select id into me from public.users where auth_uid = auth.uid() limit 1;
  if me is null then raise exception 'Set up your wallet first'; end if;
  insert into public.split_messages (split_id, sender_user_id, body) values (p_split, me, b) returning * into m;
  return to_jsonb(m);
end $$;
revoke all on function public.split_send_message(uuid, text) from public, anon;
grant execute on function public.split_send_message(uuid, text) to authenticated;
