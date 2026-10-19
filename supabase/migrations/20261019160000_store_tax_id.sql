-- Each store (outlet / branch) can carry its own tax / business registration
-- number - GST, VAT, EIN, ABN, UEN, CR... This matters for businesses whose
-- outlets register separately (e.g. a different GSTIN per state in India);
-- the account's own registration (merchant_applications.registration_number)
-- stays the default for stores that don't set one. Shown on that store's
-- receipts and invoices.
alter table public.business_stores
  add column if not exists tax_id text
    check (tax_id is null or char_length(tax_id) <= 40);
