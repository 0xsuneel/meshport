-- A merchant's claim from another chain (Claim All, or one chain from the
-- Ledger) moves customer payments to Arc: tag its Activity row as a merchant
-- payment when it is written, so Activity and the Hub show "Payment received"
-- instead of a plain "Claimed from". Insert-time only — existing rows are
-- left as they are (activity is append-only).
create or replace function public.activity_tag_merchant_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare p record;
begin
  if new.activity_type in ('receive', 'send') and new.tx_hash is not null then
    select mp.order_number, mp.intent_id into p
      from public.merchant_payments mp
     where mp.tx_hash = lower(regexp_replace(new.tx_hash, '^(recv_|send_)', ''))
       and ((new.activity_type = 'receive' and mp.merchant_wallet = lower(new.wallet_address))
         or (new.activity_type = 'send' and mp.from_address = lower(new.wallet_address)))
     limit 1;
    if found then
      new.metadata := coalesce(new.metadata, '{}'::jsonb) || public.merchant_order_meta(p.order_number, p.intent_id);
    end if;
  elsif new.activity_type = 'claim' and coalesce(new.source_chain, '') <> 'Arc_Testnet'
    and exists (select 1 from public.merchant_applications a
                 where a.wallet_address = lower(new.wallet_address) and a.status = 'approved') then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('merchant', true);
  end if;
  return new;
end;
$function$;
