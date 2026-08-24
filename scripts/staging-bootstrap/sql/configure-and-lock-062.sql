begin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('app.staging.expected_environment',:'environment_name',true);
select set_config('app.staging.expected_supabase_origin',:'supabase_origin',true);
select set_config('app.staging.expected_public_media_origin',:'public_media_origin',true);

select public.configure_media_environment_service(
  :'environment_name',:'supabase_origin',:'public_media_origin',:'configuration_evidence'
);
select public.lock_media_environment_service(
  :'environment_name',:'supabase_origin',:'public_media_origin',:'lock_evidence'
);

do $verify_lock$
declare v_row record;
begin
  select * into strict v_row from public.media_environment_config_service();
  if v_row.environment_name<>current_setting('app.staging.expected_environment')
     or v_row.supabase_origin<>current_setting('app.staging.expected_supabase_origin')
     or v_row.public_media_origin<>current_setting('app.staging.expected_public_media_origin')
     or v_row.locked_at is null then
    raise exception 'Migration 062 environment lock readback mismatch';
  end if;
end
$verify_lock$;
commit;
