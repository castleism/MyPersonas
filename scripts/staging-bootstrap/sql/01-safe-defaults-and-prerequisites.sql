-- Supabase documents revoking target default table privileges before restoring
-- a schema snapshot. The additional sequence/function revokes preserve the
-- migration-061 fail-closed default rather than target-project drift.
alter default privileges for role postgres in schema public
  revoke all on tables from anon,authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon,authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public,anon,authenticated;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists supabase_vault with schema vault;
