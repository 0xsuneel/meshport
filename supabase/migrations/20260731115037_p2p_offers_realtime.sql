-- Enables live updates for the P2P Admin "Offers" panel
-- (P2PAdminPage.tsx) — admins need to see new/cancelled/depleted offers
-- appear instantly, matching how p2p_trades already works for the
-- trades/disputes side of the admin panel.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.p2p_offers;
EXCEPTION
  WHEN duplicate_object THEN NULL; -- already added — safe to re-run
END $$;
