-- The recovery step already started for a stuck claim (MeshPort relay or a
-- new Circle attestation), who started it, and when. While it runs, Recover
-- shows "still processing" instead of offering the same step again.
-- (Transfers keep the same three keys in activity.metadata.)
alter table public.claims
  add column if not exists recovery_action text check (recovery_action in ('relay', 'reattest')),
  add column if not exists recovery_action_at timestamptz,
  add column if not exists recovery_action_by text check (recovery_action_by in ('user', 'meshport'));
