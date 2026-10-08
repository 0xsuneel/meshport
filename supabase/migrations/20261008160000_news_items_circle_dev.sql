-- MeshPort Updates: allow developer updates as their own source.
-- news-sync saves Circle's CCTP / Gateway release notes and the App Kit /
-- Bridge Kit changelogs with source = 'circle_dev' (the "Developer" filter).

alter table public.news_items drop constraint if exists news_items_source_check;
alter table public.news_items add constraint news_items_source_check
  check (source in ('arc', 'circle', 'circle_dev', 'arc_status', 'meshport'));
