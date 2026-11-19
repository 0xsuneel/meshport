-- Business receipts show who really paid (19 Nov 2026).
-- A Shop QR / bill / request payment goes payer -> MeshPortCheckout -> business,
-- so the chain watcher records the business's receive as coming from the
-- checkout contract (0xda51…) with its stand-in note "External deposit". Once
-- the receive is matched to its merchant_payments row, the receive now names
-- the real payer (their wallet, and their MeshPort username when they have
-- one) and drops the stand-in note. The payer's own "send" row is untouched.

-- The payer details for a business's receive row.
create or replace function public.merchant_receive_payer(p_from text, p_username text)
returns jsonb
language sql
immutable
as $$
  select case when nullif(p_username, '') is not null
              then jsonb_build_object('fromUsername', regexp_replace(p_username, '\.arc$', '', 'i') || '.arc')
              else '{}'::jsonb end
$$;

-- New activity rows (receive written after the order's payment row).
create or replace function public.activity_tag_merchant_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare p record;
begin
  if new.activity_type in ('receive', 'send') and new.tx_hash is not null then
    select mp.order_number, mp.intent_id, mp.from_address, mp.customer_username into p
      from public.merchant_payments mp
     where mp.tx_hash = lower(regexp_replace(new.tx_hash, '^(recv_|send_)', ''))
       and ((new.activity_type = 'receive' and mp.merchant_wallet = lower(new.wallet_address))
         or (new.activity_type = 'send' and mp.from_address = lower(new.wallet_address)))
     limit 1;
    if found then
      new.metadata := coalesce(new.metadata, '{}'::jsonb) || public.merchant_order_meta(p.order_number, p.intent_id);
      if new.activity_type = 'receive' and p.from_address is not null then
        new.counterparty_address := lower(p.from_address);
        new.metadata := (case when new.metadata->>'note' = 'External deposit' then new.metadata - 'note' else new.metadata end)
                        || public.merchant_receive_payer(p.from_address, p.customer_username);
      end if;
    end if;
  elsif new.activity_type = 'claim' and coalesce(new.source_chain, '') <> 'Arc_Testnet'
    and exists (select 1 from public.merchant_applications a
                 where a.wallet_address = lower(new.wallet_address) and a.status = 'approved') then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('merchant', true);
  end if;
  return new;
end;
$function$;

-- Receive rows already written when the order's payment row arrives.
create or replace function public.merchant_payments_tag_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare meta jsonb := public.merchant_order_meta(new.order_number, new.intent_id);
begin
  update public.activity a
     set metadata = coalesce(a.metadata, '{}'::jsonb) || meta
   where lower(regexp_replace(a.tx_hash, '^(recv_|send_)', '')) = lower(new.tx_hash)
     and (
       (a.activity_type = 'receive' and lower(a.wallet_address) = lower(new.merchant_wallet)) or
       (a.activity_type = 'send'    and lower(a.wallet_address) = lower(new.from_address))
     )
     and (a.metadata->>'merchantPayment' is null
          or coalesce(a.metadata->>'merchantOrder', '') is distinct from coalesce(new.order_number, ''));

  if new.from_address is not null then
    update public.activity a
       set counterparty_address = lower(new.from_address),
           metadata = (case when a.metadata->>'note' = 'External deposit' then a.metadata - 'note' else coalesce(a.metadata, '{}'::jsonb) end)
                      || public.merchant_receive_payer(new.from_address, new.customer_username)
     where a.activity_type = 'receive'
       and lower(a.tx_hash) = 'recv_' || lower(new.tx_hash)
       and lower(a.wallet_address) = lower(new.merchant_wallet);
  end if;
  return new;
end;
$function$;

-- Existing business receipts: the same correction.
update public.activity a
   set counterparty_address = lower(mp.from_address),
       metadata = (case when a.metadata->>'note' = 'External deposit' then a.metadata - 'note' else coalesce(a.metadata, '{}'::jsonb) end)
                  || public.merchant_receive_payer(mp.from_address, mp.customer_username)
  from public.merchant_payments mp
 where a.activity_type = 'receive'
   and mp.from_address is not null
   and mp.tx_hash = lower(regexp_replace(a.tx_hash, '^recv_', ''))
   and mp.merchant_wallet = lower(a.wallet_address);
