-- One startup request instead of ~15 (OKX-style "home" call).
--
-- Opening the app used to fire a separate REST read for every piece of the
-- first screen: settings, notifications, P2P trades, conversations (three
-- times), unread chats, the cleared-notifications watermark (twice), recent
-- contacts (two), waiting chat messages, news. On a weak connection each one
-- pays its own round trip. This returns the same rows in one call.
--
-- SECURITY INVOKER (the default): every SELECT below runs as the caller under
-- the same RLS policies as the separate queries did, so it can never return
-- a row the app couldn't already read. Read-only. If it fails or the session
-- isn't linked yet, the app falls back to its normal per-feature queries.
create or replace function public.home_bootstrap(p_user_id text, p_wallet text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  uid uuid;
  wallet text := lower(coalesce(p_wallet, ''));
  conv_ids uuid[];
  -- linked: the caller's session is bound to this user. When it isn't (the
  -- session isn't ready yet), RLS hides their rows and the empty lists would
  -- look like "nothing there" - the app then ignores them and asks normally.
  res jsonb := jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint,
    'linked', coalesce(p2p_current_user_id() = p_user_id, false));
begin
  begin uid := p_user_id::uuid; exception when others then uid := null; end;

  res := res || jsonb_build_object('settings',
    (select coalesce(jsonb_agg(to_jsonb(s) order by s.category), '[]') from app_settings s));

  res := res || jsonb_build_object('news',
    (select coalesce(jsonb_agg(to_jsonb(n) order by n.published_at desc), '[]') from (
      select id, source, url, title, summary, body, image_url, topic, read_minutes, status_label, published_at
      from news_items where hidden = false order by published_at desc limit 10) n));

  if uid is not null then
    select coalesce(array_agg(c.id), '{}') into conv_ids
      from conversations c where c.participant_a = uid or c.participant_b = uid;

    res := res || jsonb_build_object(
      'cleared_at', (select u.notifications_cleared_at from users u where u.id = uid),
      'conversations', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id, 'participant_a', c.participant_a, 'participant_b', c.participant_b)), '[]')
        from conversations c where c.id = any(conv_ids)),
      'unread_chats', (select count(*) from messages m
        where m.conversation_id = any(conv_ids) and m.is_read = false and m.sender_id <> uid),
      'waiting_messages', (select coalesce(jsonb_agg(to_jsonb(w)), '[]') from (
        select id, conversation_id, content from messages
        where sender_id = uid and content like 'e2e:q2:%' limit 200) w),
      'notifications', (select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc), '[]') from (
        select * from notifications where user_id = p_user_id order by created_at desc limit 50) n),
      'trades', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]')
        from p2p_trades t where t.buyer_id = p_user_id or t.seller_id = p_user_id)
    );
  end if;

  if wallet <> '' then
    res := res || jsonb_build_object(
      'recent_sent', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]') from (
        select counterparty_address, amount, created_at from activity
        where wallet_address = wallet and activity_type = 'send' order by created_at desc limit 20) r),
      'recent_received', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]') from (
        select counterparty_address, amount, created_at from activity
        where wallet_address = wallet and activity_type = 'receive' order by created_at desc limit 20) r)
    );
  end if;

  return res;
end;
$$;

revoke all on function public.home_bootstrap(text, text) from public;
grant execute on function public.home_bootstrap(text, text) to anon, authenticated;
