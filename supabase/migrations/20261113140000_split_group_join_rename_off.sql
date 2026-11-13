-- A settled split is closed: a new split expense always starts a new group.
-- Nothing adds a split to an existing group, or renames a group, any more -
-- the app no longer calls these, so they are removed (no unused write path
-- left callable). splits.group_id / group_name stay: splits already grouped
-- before this still show together, under their group's name.
drop function if exists public.split_join_group(uuid, uuid);
drop function if exists public.split_group_rename(uuid, text, text);
