-- The "Unified merchant Ledger" trial is removed; the per-chain Ledger stays.
delete from public.app_settings where feature = 'merchant_unified_ledger';
