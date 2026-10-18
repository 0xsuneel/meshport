-- users.email is private: nobody reads another person's email. Your own is
-- in the sign-in (supabase.auth) and my_profile().
-- APPLY ONLY AFTER the app build that stops selecting users.email is live:
-- a select that names a revoked column fails as a whole.
revoke select (email) on public.users from anon, authenticated;
