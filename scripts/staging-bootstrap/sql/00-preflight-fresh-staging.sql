-- This file is prepended to the staging-only predecessor migration. It must run
-- before any DDL and aborts unless the destination is an empty Supabase project.
do $fresh_staging$
declare
  v_count bigint;
begin
  if current_database() <> 'postgres' then
    raise exception 'Staging bootstrap requires the Supabase postgres database';
  end if;
  if to_regclass('auth.users') is null or to_regclass('storage.objects') is null
     or to_regclass('storage.buckets') is null then
    raise exception 'Target is not a provisioned Supabase project';
  end if;

  select count(*) into v_count from auth.users;
  if v_count <> 0 then raise exception 'Target is not fresh: auth.users has % rows',v_count; end if;
  select count(*) into v_count from storage.objects;
  if v_count <> 0 then raise exception 'Target is not fresh: storage.objects has % rows',v_count; end if;
  select count(*) into v_count from storage.buckets
    where id in ('media','persona-media','persona-docs','post-approved-media');
  if v_count <> 0 then raise exception 'Target already has MyPersonas Storage configuration'; end if;

  if to_regclass('vault.secrets') is not null then
    execute 'select count(*) from vault.secrets' into v_count;
    if v_count <> 0 then raise exception 'Target is not fresh: Vault contains % secrets',v_count; end if;
  end if;

  select count(*) into v_count
  from pg_catalog.pg_class as class
  join pg_catalog.pg_namespace as namespace on namespace.oid=class.relnamespace
  where namespace.nspname='public'
    and class.relkind in ('r','p','v','m','S','f')
    and not exists (
      select 1 from pg_catalog.pg_depend as dependency
      join pg_catalog.pg_extension as extension on extension.oid=dependency.refobjid
      where dependency.classid='pg_catalog.pg_class'::regclass
        and dependency.objid=class.oid and dependency.deptype='e'
    );
  if v_count <> 0 then
    raise exception 'Target public schema has % non-extension relations and is not fresh',v_count;
  end if;

  select count(*) into v_count
  from pg_catalog.pg_proc as procedure
  join pg_catalog.pg_namespace as namespace on namespace.oid=procedure.pronamespace
  where namespace.nspname='public'
    and not exists (
      select 1 from pg_catalog.pg_depend as dependency
      join pg_catalog.pg_extension as extension on extension.oid=dependency.refobjid
      where dependency.classid='pg_catalog.pg_proc'::regclass
        and dependency.objid=procedure.oid and dependency.deptype='e'
    );
  if v_count <> 0 then
    raise exception 'Target public schema has % non-extension routines and is not fresh',v_count;
  end if;

  if to_regclass('cron.job') is not null then
    execute $query$
      select count(*) from cron.job
      where jobname in ('data-retention-weekly','mypersonas-run-post-queue','fan-chat-ephemeral-cleanup')
         or jobname like 'mypersonas-%'
    $query$ into v_count;
    if v_count <> 0 then raise exception 'Target already has a MyPersonas scheduler job'; end if;
  end if;
end
$fresh_staging$;
