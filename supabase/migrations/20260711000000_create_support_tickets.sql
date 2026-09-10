-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: support_tickets — in-app Help & Support
--
-- Users submit a ticket from Profile → Help & Support. Admins view and
-- respond to tickets from a new Admin panel page. Follows the same RLS
-- pattern as admin_users (see supabase-admin-panel.sql): admins are
-- identified by an `exists (select 1 from admin_users where id = auth.uid())`
-- check, not a separate role system.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who filed it
  user_id         uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  wallet_address  text,
  email           text,
  username        text,

  -- The ticket itself
  subject         text        NOT NULL DEFAULT 'General',
  message         text        NOT NULL,

  -- Admin response
  status          text        NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  admin_reply     text,
  replied_by      text,
  replied_at      timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user   ON public.support_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets (status, created_at DESC);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION public.set_support_tickets_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS support_tickets_updated_at ON public.support_tickets;
CREATE TRIGGER support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_support_tickets_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "support_tickets_insert_own"   ON public.support_tickets;
DROP POLICY IF EXISTS "support_tickets_select_own"    ON public.support_tickets;
DROP POLICY IF EXISTS "support_tickets_admin_all"     ON public.support_tickets;

-- Users can file their own tickets
CREATE POLICY "support_tickets_insert_own" ON public.support_tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can see only their own tickets (and any admin reply on them)
CREATE POLICY "support_tickets_select_own" ON public.support_tickets
  FOR SELECT USING (auth.uid() = user_id);

-- Admins can read and update every ticket (respond, change status)
CREATE POLICY "support_tickets_admin_all" ON public.support_tickets
  FOR ALL USING (
    exists (select 1 from public.admin_users a where a.id = auth.uid())
  ) WITH CHECK (
    exists (select 1 from public.admin_users a where a.id = auth.uid())
  );

-- ── Realtime ───────────────────────────────────────────────────────────────────
-- Lets the user's ticket list update live the moment an admin replies,
-- without polling.
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_tickets;
