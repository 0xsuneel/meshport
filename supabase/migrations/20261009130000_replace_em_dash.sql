-- Use a plain "-" instead of "—" in every message the database writes
-- (notifications, activity, errors) and in admin setting labels.
-- Already applied to production; kept here so the history matches.
do $$
declare r record;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' and p.prosrc like '%—%'
  loop
    execute replace(replace(pg_get_functiondef(r.oid), ' — ', ' - '), '—', '-');
  end loop;
end $$;

update public.app_settings
   set label = replace(replace(label, ' — ', ' - '), '—', '-'),
       value = replace(replace(value, ' — ', ' - '), '—', '-')
 where label like '%—%' or value like '%—%';
