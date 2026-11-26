-- A business account always controls its own money, approved or not (as
-- Venmo and PayPal: verification gates taking business payments, never the
-- balance). account_can_spend / wallet_can_spend used to refuse every
-- business that wasn't approved - a pending or rejected business couldn't
-- move funds sent to its wallet. They now allow everyone (kept so the
-- servers that call them keep working).
--
-- What approval gates is taking payments: Shop QR and bills already need an
-- approved business; payment requests and splits from a business that isn't
-- approved (none, pending, rejected or revoked) are now refused too.

create or replace function public.account_can_spend(p_auth_uid uuid)
returns boolean language sql stable security definer set search_path to '' as $$ select true $$;
create or replace function public.wallet_can_spend(p_wallet text)
returns boolean language sql stable security definer set search_path to '' as $$ select true $$;

do $do$
declare d text;
  old_block text := $q$if (select m.status from public.merchant_applications m where m.auth_uid = new.merchant_auth_uid
              order by m.created_at desc limit 1) = 'revoked' then
          raise exception 'Business access was removed - you can still send and withdraw your funds, but not take new payments';
        end if;
        $q$;
  new_block text := $q$-- A business takes payments only once approved (it can always send).
        if (select m.status from public.merchant_applications m where m.auth_uid = new.merchant_auth_uid
              order by m.created_at desc limit 1) = 'revoked' then
          raise exception 'Business access was removed - you can still send and withdraw your funds, but not take new payments';
        end if;
        raise exception 'Taking payments turns on once MeshPort approves your business - you can still send and withdraw your funds';
        $q$;
begin
  d := pg_get_functiondef('public.merchant_payment_intents_before_write'::regproc);
  if position(old_block in d) = 0 then raise exception 'merchant_payment_intents_before_write changed - update this migration'; end if;
  execute replace(d, old_block, new_block);
end $do$;
