-- Chat messages sent before the recipient had a chat key are sealed for the
-- sender only ('e2e:q2:…'). Once the recipient signs in, the sender's app
-- re-seals them for both as 'e2e:v2:…'. That hand-over is the one content
-- change a sender may make besides deleting ('[deleted]'); no other edits.
create or replace function public.messages_edit_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  is_sender boolean;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
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
    if new.type is distinct from old.type and new.type <> 'text' then
      new.type := old.type;
    end if;
    if new.content is distinct from old.content
       and new.content <> '[deleted]'
       and not (left(old.content, 7) = 'e2e:q2:' and left(new.content, 7) = 'e2e:v2:') then
      new.content := old.content;
    end if;
  else
    new.content    := old.content;
    new.type       := old.type;
    new.deleted_at := old.deleted_at;
  end if;
  return new;
end
$function$;
