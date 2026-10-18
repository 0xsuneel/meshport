-- Message edit guard (runs as the caller) - same check via the helper.
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
  is_sender := old.sender_id = any (public.my_user_ids());
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
