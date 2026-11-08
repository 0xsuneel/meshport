-- Device-only chat, no backup (owner's decision, 8 Nov): Supabase only
-- relays a sealed message or file until the other person's phone has it.
-- Like WhatsApp, anything never delivered is dropped after 30 days, so no
-- chat content sits on the server for good:
--   * chat messages (and receipts / signals) still waiting in the mailbox,
--     including e2e:q2 ones still waiting for the recipient's chat key
--   * chat files (attachments/chat/<conversation>/…) never downloaded
-- Payment cards (payment_sent / payment_received) are kept: they're the
-- payment history every device shows.
--
-- Files must be removed through the Storage API (deleting storage.objects
-- rows in SQL leaves the stored bytes behind), so the daily job calls the
-- chat-expiry edge function, which uses these two helpers.

create or replace function public.chat_expire_mail(p_days int default 30)
returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  delete from public.messages
   where type not in ('payment_sent', 'payment_received')
     and created_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.chat_expired_files(p_days int default 30, p_limit int default 500)
returns setof text
language sql stable security definer set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'attachments'
     and o.name like 'chat/%'
     and o.created_at < now() - make_interval(days => greatest(p_days, 1))
   order by o.created_at
   limit greatest(1, least(p_limit, 1000))
$$;

revoke all on function public.chat_expire_mail(int) from public, anon, authenticated;
revoke all on function public.chat_expired_files(int, int) from public, anon, authenticated;
grant execute on function public.chat_expire_mail(int) to service_role;
grant execute on function public.chat_expired_files(int, int) to service_role;

-- Daily at 03:53 UTC.
select cron.schedule('chat-expiry', '53 3 * * *', $$
  select net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/chat-expiry',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('days', 30)
  );
$$);
