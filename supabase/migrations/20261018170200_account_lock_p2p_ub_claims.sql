-- Business accounts that aren't approved yet can't create P2P offers or
-- trades (escrow / cash-out) or file Unified Balance claims from the app.
-- Restrictive: added on top of the existing owner/participant policies.
create policy p2p_offers_insert_account_lock on public.p2p_offers
  as restrictive for insert to public
  with check (public.account_can_spend((select auth.uid())));

create policy p2p_trades_insert_account_lock on public.p2p_trades
  as restrictive for insert to public
  with check (public.account_can_spend((select auth.uid())));

create policy ub_claim_intents_insert_account_lock on public.ub_claim_intents
  as restrictive for insert to public
  with check (public.account_can_spend((select auth.uid())));
