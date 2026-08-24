select set_config('request.jwt.claim.role','service_role',false);
select set_config('app.staging.expected_environment',:'environment_name',false);
select set_config('app.staging.expected_supabase_origin',:'supabase_origin',false);
select set_config('app.staging.expected_public_media_origin',:'public_media_origin',false);
do $verify_062$
declare v_row record;
begin
  if to_regclass('public.media_environment_config_062') is null
     or to_regclass('public.persona_public_media_handles') is null
     or to_regprocedure('public.public_media_delivery_url(uuid)') is null then
    raise exception 'Migration 062 objects are incomplete';
  end if;
  select * into strict v_row from public.media_environment_config_service();
  if v_row.environment_name<>current_setting('app.staging.expected_environment')
     or v_row.supabase_origin<>current_setting('app.staging.expected_supabase_origin')
     or v_row.public_media_origin<>current_setting('app.staging.expected_public_media_origin')
     or v_row.locked_at is null then
    raise exception 'Migration 062 exact locked configuration is missing';
  end if;
  if has_table_privilege('anon','public.media_environment_config_062','select')
     or has_table_privilege('authenticated','public.media_environment_config_062','select')
     or has_function_privilege('anon','public.media_environment_config_service()','execute')
     or has_function_privilege('authenticated','public.media_environment_config_service()','execute') then
    raise exception 'Migration 062 private configuration is browser-readable';
  end if;
end
$verify_062$;
select jsonb_build_object(
  'phase','062-locked','schema_ready',true,
  'environment_name',config.environment_name,
  'supabase_origin',config.supabase_origin,
  'public_media_origin',config.public_media_origin,
  'locked',config.locked_at is not null
)::text from public.media_environment_config_service() as config;
