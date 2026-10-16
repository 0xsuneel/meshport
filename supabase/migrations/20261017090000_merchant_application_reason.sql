-- Every new merchant application says why the business account is needed
-- (sign-up asks for it, and so does "Apply again"). NOT VALID: applications
-- sent before this rule stay as they are.
alter table public.merchant_applications
  add constraint merchant_applications_reason_chk
  check (status <> 'pending' or char_length(btrim(coalesce(description, ''))) >= 10) not valid;
