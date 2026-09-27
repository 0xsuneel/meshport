-- adminSupabase.ts's subscribeToSettings() subscribes to postgres_changes on
-- public.app_settings so every admin toggle (including the chains_ub /
-- chains_cctp rows) is pushed live to every open client. That subscription
-- was set up in code but the table was never added to the supabase_realtime
-- publication, so no change event was ever actually broadcast — an admin
-- flipping a toggle only showed up on OTHER already-open tabs/devices (e.g.
-- someone with the Multichain Transfer route picker open) after a manual
-- page reload, never live.
ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;
