-- Defence in depth: the app never truncates business tables.
do $$
declare t record;
begin
  for t in select c.relname from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
              and (c.relname like 'merchant\_%' or c.relname like 'business\_%')
  loop
    execute format('revoke truncate on table public.%I from anon, authenticated', t.relname);
  end loop;
end $$;
