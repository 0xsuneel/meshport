-- A Shop QR payment shows no order number: nobody requested it or billed it,
-- so "Payment Paid #109" / "Payment #109 Received" read like an order. It's a
-- plain payment: "Payment Paid" (payer) / "Payment Received" (business). The
-- stored order number is unchanged - it still matches the payment to its order.
-- Same wording as the app (src/lib/orderLabels.ts, kind 'shop').

create or replace function public.merchant_order_title(p_kind text, p_personal boolean, p_order text, p_paid boolean)
returns text language sql immutable set search_path = '' as $$
  select case
      when p_kind = 'shop' then (case when p_paid then 'Payment Paid' else 'Payment' end)
      else (case
          when p_kind = 'invoice' then (case when p_paid then 'Paid Bill ' else 'Bill ' end)
          when coalesce(p_personal, true) then (case when p_paid then 'Request Amount Paid ' else 'Request ' end)
          else (case when p_paid then 'Requested Payment Paid ' else 'Requested Payment ' end)
        end || coalesce(public.merchant_order_display(p_order), ''))
    end
$$;

create or replace function public.merchant_order_received_title(p_kind text, p_personal boolean, p_order text)
returns text language sql immutable set search_path = '' as $$
  select case
      when p_kind = 'invoice' then 'Bill ' || coalesce(public.merchant_order_display(p_order), '') || ' Received'
      when p_kind = 'shop' then 'Payment Received'
      when coalesce(p_personal, true) then 'Request ' || coalesce(public.merchant_order_display(p_order), '') || ' Amount Received'
      else 'Requested ' || coalesce(public.merchant_order_display(p_order), '') || ' Payment Received'
    end
$$;
