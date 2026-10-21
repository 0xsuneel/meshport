-- indexer-fast's second worker: the less-used external chains ({group:'rest'}),
-- alongside the busy ones (the 'indexer-fast' job, body {}). Same command as
-- that job with the body swapped.
select cron.schedule('indexer-fast-rest', '* * * * *',
  replace((select command from cron.job where jobname = 'indexer-fast'), '''{}''::jsonb', '''{"group":"rest"}''::jsonb'))
where exists (select 1 from cron.job where jobname = 'indexer-fast')
  and not exists (select 1 from cron.job where jobname = 'indexer-fast-rest');
