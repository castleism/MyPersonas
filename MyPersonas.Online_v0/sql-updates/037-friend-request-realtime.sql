-- 037-friend-request-realtime.sql
-- Publish only the existing follows table to Supabase Realtime so the signed-in
-- owner can receive RLS-filtered request/accept events. This migration is
-- independent of the dormant opt-in cron in 036 and may be applied while 036
-- remains intentionally unapplied. Existing follows RLS remains authoritative.

begin;

create index if not exists follows_target_status_created_idx
  on public.follows (target, status, created_at desc);
create index if not exists follows_follower_status_created_idx
  on public.follows (follower, status, created_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'follows'
  ) then
    alter publication supabase_realtime add table public.follows;
  end if;
exception
  when undefined_object then
    raise exception using
      message = 'Supabase Realtime publication is unavailable; follows was not exposed',
      hint = 'Enable Supabase Realtime for this project, then rerun migration 037.';
end
$$;

commit;
