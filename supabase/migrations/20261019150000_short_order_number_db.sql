-- Server-side order numbers now read as #N too, matching the app.
--
-- merchant_order_display turned ORD-100042 into ORD-00042; the app has since
-- moved to the short #N form everywhere (displayOrderNumber → #42). This is
-- the one helper every server-generated title uses (merchant_order_title and
-- merchant_order_received_title, which feed the merchant/customer
-- notifications and bill reminders), so changing it here switches all of that
-- notification text to #N in step with the app.
--
-- Display only: the stored order_number (ORD-100042) is unchanged, so links,
-- chat message text, payment-matching tags and activity metadata keep working.
-- Notifications already sent keep their old text (that text is static); only
-- notifications from here on read #N.
create or replace function public.merchant_order_display(p_order text)
returns text language sql immutable set search_path = '' as $$
  select case
      when p_order ~* '^ORD-[0-9]+$' and substr(p_order, 5)::bigint > 100000
        then '#' || (substr(p_order, 5)::bigint - 100000)::text
      else p_order
    end
$$;
