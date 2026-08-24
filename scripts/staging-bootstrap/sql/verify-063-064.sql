select set_config('request.jwt.claim.role','service_role',false);
select set_config('app.staging.expected_environment',:'environment_name',false);
select set_config('app.staging.expected_supabase_origin',:'supabase_origin',false);
select set_config('app.staging.expected_public_media_origin',:'public_media_origin',false);
do $verify_063_064$
declare v_row record;
begin
  select * into strict v_row from public.media_environment_config_service();
  if v_row.environment_name<>current_setting('app.staging.expected_environment')
     or v_row.supabase_origin<>current_setting('app.staging.expected_supabase_origin')
     or v_row.public_media_origin<>current_setting('app.staging.expected_public_media_origin')
     or v_row.locked_at is null then
    raise exception 'Locked staging environment changed before 063-064 verification';
  end if;
  if to_regclass('public.post_approved_media_handles') is null
     or to_regprocedure('public.approved_media_delivery_url(uuid)') is null
     or to_regprocedure('public.inventory_legacy_media_references_service(uuid,integer)') is null
     or to_regprocedure('public.resolve_legacy_media_preview_service(uuid,uuid)') is null then
    raise exception 'Migration 063 or 064 objects are incomplete';
  end if;
  if not exists(select 1 from storage.buckets where id='post-approved-media') then
    raise exception 'Approved-media staging bucket is missing';
  end if;
  if exists(select 1 from auth.users) or exists(select 1 from storage.objects)
     or (to_regclass('vault.secrets') is not null and exists(select 1 from vault.secrets)) then
    raise exception 'Readiness bootstrap unexpectedly contains copied users, objects, or secrets';
  end if;
end
$verify_063_064$;
select jsonb_build_object(
  'phase','063-064',
  'schema_ready',true,
  'environment_name',config.environment_name,
  'supabase_origin',config.supabase_origin,
  'public_media_origin',config.public_media_origin,
  'locked',config.locked_at is not null,
  'auth_users',(select count(*) from auth.users),
  'storage_objects',(select count(*) from storage.objects),
  'legacy_reference_rows',(select count(*) from public.legacy_media_references)
)::text from public.media_environment_config_service() as config;
