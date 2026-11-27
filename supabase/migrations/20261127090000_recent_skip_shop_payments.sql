-- Recent contacts (Home's Pay again, Pay -> Recent, the Recent page) left out
-- shop payments: paying a business through its Shop QR (or a bill / order)
-- is a purchase, not a person you pay - like Indian payment apps, those never
-- show as a recent contact. A row is a shop payment when its metadata says
-- merchantVia = 'shop_qr' or merchantPayment = true, unless the business took
-- it on its personal account (merchantPersonal = true). The app filters the
-- same way when it reads activity itself (src/lib/recentContacts.ts).

create or replace function public.is_shop_payment(m jsonb)
returns boolean language sql immutable as $$
  select coalesce(
    (m->>'merchantVia' = 'shop_qr' or m->>'merchantPayment' = 'true')
      and coalesce(m->>'merchantPersonal', 'false') <> 'true',
    false)
$$;

CREATE OR REPLACE FUNCTION public.home_bootstrap(p_user_id text, p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  uid uuid;
  wallet text := lower(coalesce(p_wallet, ''));
  conv_ids uuid[];
  cleared timestamptz;
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
    select u.notifications_cleared_at into cleared from users u where u.id = uid;

    res := res || jsonb_build_object(
      'cleared_at', cleared,
      'chat_payments', (select coalesce(jsonb_agg(jsonb_build_object(
          'other_id', x.other_id, 'msgs', x.msgs,
          'sender', (select jsonb_build_object('username', u.username, 'display_name', u.display_name, 'wallet_address', u.wallet_address)
                     from users u where u.id = x.other_id))), '[]')
        from (
          select o.other_id, (select jsonb_agg(to_jsonb(m) order by m.created_at desc) from (
              select * from messages mm
              where mm.conversation_id = c.id and mm.type = 'payment_sent' and mm.sender_id = o.other_id
                and (cleared is null or mm.created_at > cleared)
              order by mm.created_at desc limit 20) m) msgs
          from conversations c
          cross join lateral (select case when c.participant_a = uid then c.participant_b else c.participant_a end other_id) o
          where c.id = any(conv_ids) and o.other_id is not null
        ) x where x.msgs is not null),
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
        where wallet_address = wallet and activity_type = 'send' and status is distinct from 'failed'
          and not public.is_shop_payment(metadata)
        order by created_at desc limit 20) r),
      'recent_received', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]') from (
        select counterparty_address, amount, created_at from activity
        where wallet_address = wallet and activity_type = 'receive' and status is distinct from 'failed'
          and not public.is_shop_payment(metadata)
        order by created_at desc limit 20) r)
    );
  end if;

  return res;
end;
$function$;
