-- auth.uid() once per query, not per row (advisor auth_rls_initplan), on
-- merchant and business policies.
do $$
declare p record; q text; c text;
begin
  for p in select * from pg_policies
            where schemaname = 'public' and (tablename like 'merchant\_%' or tablename like 'business\_%')
  loop
    q := p.qual; c := p.with_check;
    if q is not null and q ~ 'auth\.uid\(\)' and q !~* 'select auth\.uid\(\)' then
      execute format('alter policy %I on public.%I using (%s)', p.policyname, p.tablename,
                     regexp_replace(q, 'auth\.uid\(\)', '(select auth.uid())', 'g'));
    end if;
    if c is not null and c ~ 'auth\.uid\(\)' and c !~* 'select auth\.uid\(\)' then
      execute format('alter policy %I on public.%I with check (%s)', p.policyname, p.tablename,
                     regexp_replace(c, 'auth\.uid\(\)', '(select auth.uid())', 'g'));
    end if;
  end loop;
end $$;
