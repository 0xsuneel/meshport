-- indexer-fast: once a minute; each call watches the busy external chains
-- for ~55s (a pass every 4s per chain). Same caller secret as the
-- blockchain-indexer-shadow job - its command with the URL and body swapped.
select cron.schedule('indexer-fast', '* * * * *',
  replace(replace((select command from cron.job where jobname = 'blockchain-indexer-shadow'),
    '/functions/v1/blockchain-indexer', '/functions/v1/indexer-fast'),
    'jsonb_build_object(''mode'', ''index'')', '''{}''::jsonb'))
where exists (select 1 from cron.job where jobname = 'blockchain-indexer-shadow')
  and not exists (select 1 from cron.job where jobname = 'indexer-fast');
