-- Every payment into a business counts as a business payment (28 Nov, like
-- Paytm for Business: whatever pays the shop - its QR, its username, its
-- wallet address - is a sale). A transfer to an approved business's Arc
-- wallet that pays no order (sent by username or address, from MeshPort or
-- any wallet) is recorded as a Shop QR payment marked `direct`: it gets the
-- "Received on <shop>" alert and voice, counts in the Payments list, the
-- totals, reports and summaries, and can be refunded. The owner's own moves
-- (Unified Balance, Move to Arc, swaps, P2P) are never counted - the watcher
-- skips them before it gets here.

alter table public.merchant_payment_intents add column if not exists direct boolean not null default false;

-- `direct` only from the server (merchant_open_direct_order); fixed after insert.
do $do$
declare d text := pg_get_functiondef('public.merchant_payment_intents_before_write'::regproc);
begin
  if position('meshport.direct' in d) > 0 then return; end if;
  if position('if coalesce(new.via, '''') <> ''shop_qr'' then new.opened_by := null; end if;' in d) = 0
     or position('new.personal := old.personal;' in d) = 0 then
    raise exception 'merchant_payment_intents_before_write changed - update this migration';
  end if;
  d := replace(d, 'if coalesce(new.via, '''') <> ''shop_qr'' then new.opened_by := null; end if;',
    'if coalesce(new.via, '''') <> ''shop_qr'' then new.opened_by := null; end if;
    new.direct := coalesce(new.direct, false) and new.via = ''shop_qr''
                  and coalesce(current_setting(''meshport.direct'', true), '''') = ''1'';');
  d := replace(d, 'new.personal := old.personal;', 'new.personal := old.personal; new.direct := old.direct;');
  execute d;
end $do$;

-- A payment straight to an approved business's wallet: its order (USDC,
-- exactly the amount, never expiring). Service role only (merchant-pay).
-- null when the wallet isn't an approved business.
create or replace function public.merchant_open_direct_order(p_wallet text, p_amount numeric)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare a record; r public.merchant_payment_intents;
begin
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then return null; end if;
  select m.auth_uid into a from public.merchant_applications m
   where m.wallet_address = lower(p_wallet) and m.status = 'approved' and m.auth_uid is not null
   order by m.created_at desc limit 1;
  if a.auth_uid is null then return null; end if;
  perform set_config('meshport.shop_qr', '1', true);
  perform set_config('meshport.direct', '1', true);
  insert into public.merchant_payment_intents (merchant_auth_uid, requested_amount, via, direct, expires_at)
  values (a.auth_uid, round(p_amount, 6), 'shop_qr', true, null)
  returning * into r;
  perform set_config('meshport.shop_qr', '', true);
  perform set_config('meshport.direct', '', true);
  return to_jsonb(r);
end $function$;
revoke execute on function public.merchant_open_direct_order(text, numeric) from anon, authenticated, public;

-- A direct payment: the payer sent a plain transfer (their own app already
-- says "Sent"), so only the business is told. `meshport.quiet` (the backfill
-- below) tells nobody.
do $do$
declare d text := pg_get_functiondef('public.merchant_payment_intents_notify'::regproc);
begin
  if position('meshport.quiet' in d) > 0 then return; end if;
  if position('    if payer_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (payer_id, ''merchant_order_paid''' in d) = 0 or position('begin
  select * into last' in d) = 0 then
    raise exception 'merchant_payment_intents_notify changed - update this migration';
  end if;
  d := replace(d, 'begin
  select * into last', 'begin
  if coalesce(current_setting(''meshport.quiet'', true), '''') = ''1'' then return new; end if;
  select * into last');
  d := replace(d, '    if payer_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (payer_id, ''merchant_order_paid''', '    if payer_id is not null and not coalesce(new.direct, false) then
      insert into public.notifications (user_id, type, title, message, read)
      values (payer_id, ''merchant_order_paid''');
  execute d;
end $do$;
