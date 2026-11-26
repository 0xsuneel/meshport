-- users out of the Realtime publication (docs/SUPABASE_LIGHT_PLAN.md, Phase 4
-- follow-up). users is readable by everyone, and the chat list listened to
-- every UPDATE on it: one profile change (a name, a cleared-notifications
-- watermark, a chat key) went to every open chat list and reloaded it - a
-- Realtime message per viewer per change. Nothing else listens to users.
do $m$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'users') then
    alter publication supabase_realtime drop table public.users;
  end if;
end $m$;
