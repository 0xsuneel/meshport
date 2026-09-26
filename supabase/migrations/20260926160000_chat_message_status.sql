-- Chat, WhatsApp-style message states and features.
--   delivered_at  the recipient's app received the message (two grey ticks)
--   read_at       the recipient opened the chat with it on screen (two blue ticks)
--   reply_to_id   swipe-to-reply: the quoted message
--   forwarded     "Forwarded" label
--   deleted_at    "Delete for everyone" time (content becomes '[deleted]')
alter table public.messages
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at      timestamptz,
  add column if not exists reply_to_id  uuid,
  add column if not exists forwarded    boolean not null default false,
  add column if not exists deleted_at   timestamptz;

-- Rows already read: count them as delivered + read at their send time, so
-- old messages don't all turn back to grey ticks.
update public.messages set delivered_at = coalesce(delivered_at, created_at), read_at = coalesce(read_at, created_at)
 where is_read and (delivered_at is null or read_at is null);

create or replace function public.messages_status_times()
returns trigger language plpgsql set search_path to 'public'
as $$
begin
  -- Reading implies delivery.
  if new.is_read and not coalesce(old.is_read, false) then
    new.read_at := coalesce(new.read_at, now());
    new.delivered_at := coalesce(new.delivered_at, old.delivered_at, new.read_at);
  end if;
  -- Delivery / read times only move forward once set.
  if old.delivered_at is not null then new.delivered_at := old.delivered_at; end if;
  if old.read_at is not null then new.read_at := old.read_at; end if;
  -- Delete for everyone: within 2 days of sending, and it stays deleted.
  if new.content = '[deleted]' and old.content is distinct from '[deleted]' then
    if old.created_at < now() - interval '2 days' then
      raise exception 'Messages can only be deleted for everyone within 2 days of sending';
    end if;
    new.deleted_at := now();
  elsif old.content = '[deleted]' then
    new.content := old.content; new.deleted_at := old.deleted_at;
  end if;
  return new;
end $$;

drop trigger if exists messages_status_times on public.messages;
create trigger messages_status_times before update on public.messages
  for each row execute function public.messages_status_times();

create index if not exists messages_conv_undelivered on public.messages (conversation_id) where delivered_at is null;
