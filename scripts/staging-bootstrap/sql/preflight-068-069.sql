select set_config('request.jwt.claim.role','service_role',false);
select set_config('app.staging.expected_environment',:'environment_name',false);
select set_config('app.staging.expected_supabase_origin',:'supabase_origin',false);
select set_config('app.staging.expected_public_media_origin',:'public_media_origin',false);

do $preflight_068_069$
declare
  v_config record;
  v_versions text[];
  v_expected_versions constant text[]:=array[
    '20260823035000',
    '20260823040000',
    '20260823050000',
    '20260823060000'
  ];
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'Supabase migration ledger is missing';
  end if;

  select coalesce(
    array_agg(migration.version::text order by migration.version::text),
    array[]::text[]
  ) into v_versions
  from supabase_migrations.schema_migrations migration;
  if v_versions<>v_expected_versions then
    raise exception
      'Staging ledger is not exactly baseline plus 062-064 before 068-069: %',
      v_versions;
  end if;

  select * into strict v_config from public.media_environment_config_service();
  if v_config.environment_name<>current_setting('app.staging.expected_environment')
     or v_config.supabase_origin<>current_setting('app.staging.expected_supabase_origin')
     or v_config.public_media_origin<>current_setting('app.staging.expected_public_media_origin')
     or v_config.locked_at is null then
    raise exception 'Locked staging media environment is not the reviewed 062 state';
  end if;
  if to_regclass('public.post_approved_media_handles') is null
     or to_regclass('public.legacy_media_references') is null
     or to_regprocedure('public.approved_media_delivery_url(uuid)') is null
     or to_regprocedure('public.inventory_legacy_media_references_service(uuid,integer)') is null then
    raise exception 'Verified 063-064 prerequisites are incomplete';
  end if;

  if to_regclass('private.billing_runtime_config') is not null
     or to_regclass('private.billing_plan_catalog') is not null
     or to_regprocedure('public.billing_entitlement_snapshot(uuid)') is not null
     or to_regprocedure('public.staff_operational_alerts(timestamp with time zone,text,integer)') is not null then
    raise exception 'Migration 068 or 069 objects already exist outside the reviewed ledger';
  end if;
  if exists(select 1 from auth.users)
     or exists(select 1 from storage.objects)
     or (to_regclass('vault.secrets') is not null and exists(select 1 from vault.secrets)) then
    raise exception 'Staging release preflight requires the verified pre-data 062-064 checkpoint';
  end if;
end
$preflight_068_069$;

select jsonb_build_object(
  'phase','preflight-068-069',
  'ready',true,
  'project_environment',config.environment_name,
  'supabase_origin',config.supabase_origin,
  'public_media_origin',config.public_media_origin,
  'locked',config.locked_at is not null,
  'migration_versions',(
    select jsonb_agg(migration.version::text order by migration.version::text)
    from supabase_migrations.schema_migrations migration
  ),
  'verified_through','064',
  'pending_reviewed_migrations',jsonb_build_array('068','069'),
  'deferred_migrations_excluded',jsonb_build_array('065','066','067'),
  'auth_users',(select count(*) from auth.users),
  'storage_objects',(select count(*) from storage.objects)
)::text
from public.media_environment_config_service() config;
