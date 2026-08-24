\set ON_ERROR_STOP on

-- Reserve -> writing -> register is serialized, redacted, and quota-idempotent.
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$
declare result jsonb;retry_result jsonb;
begin
  result:=public.consume_persona_source_rate_limit_service(
    '07000000-0000-4000-8000-000000000001','upload'
  );
  if result->>'allowed'<>'true' or result->>'action'<>'upload' then
    raise exception 'Upload rate limit did not return its redacted allowance';end if;
  result:=public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000011',128,repeat('a',64),
    '07000000-0000-4000-8000-000000000101'
  );
  if result->>'status'<>'reserved' or (result->>'byte_size')::integer<>128
     or result ? 'storage_path' then
    raise exception 'Upload reservation was not bounded/redacted: %',result;end if;
  result:=public.begin_persona_source_storage_write_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000101'
  );
  if result->>'status'<>'writing'
     or result->>'persona_id'<>'07000000-0000-4000-8000-000000000011'
     or result ? 'storage_path' then
    raise exception 'Storage-write handoff was not bounded/redacted: %',result;end if;
  retry_result:=public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000011',128,repeat('a',64),
    '07000000-0000-4000-8000-000000000101'
  );
  if retry_result->>'status'<>'writing' then
    raise exception 'Writing reservation retry regressed state: %',retry_result;end if;
end
$$;
reset role;

do $$ begin
  if not exists(select 1 from private.persona_source_quota_usage usage
      where usage.owner='07000000-0000-4000-8000-000000000001'
        and usage.reserved_asset_count=1 and usage.reserved_managed_bytes=128) then
    raise exception 'Writing retry double-counted or lost reserved quota';end if;
end $$;

insert into storage.objects(bucket_id,name,metadata) values(
  'persona-source-library',
  '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000011/source/07000000-0000-4000-8000-000000000101-'||repeat('a',64)||'.png',
  '{"size":"128"}'::jsonb
);

set role service_role;
do $$
declare result jsonb;duplicate_result jsonb;
begin
  result:=public.register_persona_source_asset_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000011',
    '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000011/source/07000000-0000-4000-8000-000000000101-'||repeat('a',64)||'.png',
    repeat('a',64),'image/png',128,800,600,'meal.png','research',
    'none','owner_created','derivative_allowed','standard',false,
    'Weeknight meal','Unsorted dinner reference',array['meal','dinner'],
    now()-interval '1 day','07000000-0000-4000-8000-000000000101'
  );
  if result->>'status'<>'registered' or result->>'asset_id' is null
     or result ? 'storage_path' then
    raise exception 'Registration did not return a safe receipt: %',result;end if;
  duplicate_result:=public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000011',128,repeat('a',64),
    '07000000-0000-4000-8000-000000000102'
  );
  if duplicate_result->>'status'<>'registered'
     or duplicate_result->>'duplicate'<>'true'
     or duplicate_result->>'asset_id'<>result->>'asset_id' then
    raise exception 'Exact duplicate was not safely deduplicated: %',duplicate_result;end if;
end
$$;

-- Register a second source so local and hosted jobs can coexist.
do $$ declare result jsonb;begin
  perform public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000011',256,repeat('d',64),
    '07000000-0000-4000-8000-000000000105'
  );
  result:=public.begin_persona_source_storage_write_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000105'
  );
  if result->>'status'<>'writing' then raise exception 'Second source did not enter writing';end if;
end $$;
reset role;

insert into storage.objects(bucket_id,name,metadata) values(
  'persona-source-library',
  '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000011/source/07000000-0000-4000-8000-000000000105-'||repeat('d',64)||'.jpg',
  '{"size":"256"}'::jsonb
);

set role service_role;
do $$ declare result jsonb;begin
  result:=public.register_persona_source_asset_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000011',
    '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000011/source/07000000-0000-4000-8000-000000000105-'||repeat('d',64)||'.jpg',
    repeat('d',64),'image/jpeg',256,1024,768,'prep.jpg','content_later',
    'assisted','owner_created','publish_allowed','standard',true,
    'Meal preparation','Second study fixture',array['prep'],now(),
    '07000000-0000-4000-8000-000000000105'
  );
  if result->>'status'<>'registered' then raise exception 'Second registration failed: %',result;end if;
end $$;
reset role;

-- A third source preserves independent queued/claimed coverage after the
-- single-item deletion race fixture is removed.
set role service_role;
do $$ begin
  perform public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000011',192,repeat('c',64),
    '07000000-0000-4000-8000-000000000106'
  );
  perform public.begin_persona_source_storage_write_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000106'
  );
end $$;
reset role;
insert into storage.objects(bucket_id,name,metadata) values(
  'persona-source-library',
  '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000011/source/07000000-0000-4000-8000-000000000106-'||repeat('c',64)||'.webp',
  '{"size":"192"}'::jsonb
);
set role service_role;
do $$ declare result jsonb;begin
  result:=public.register_persona_source_asset_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000011',
    '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000011/source/07000000-0000-4000-8000-000000000106-'||repeat('c',64)||'.webp',
    repeat('c',64),'image/webp',192,640,480,'reference.webp','research',
    'none','licensed','reference_only','standard',true,
    'Third fixture','Bulk deletion queue fixture',array['fixture'],now(),
    '07000000-0000-4000-8000-000000000106'
  );
  if result->>'status'<>'registered' then raise exception 'Third registration failed: %',result;end if;
end $$;
reset role;

-- Persona deletion fences an in-flight write, releases only idle reservations,
-- and detects an unregistered orphan by raw Storage prefix.
set role service_role;
do $$
declare guard_result jsonb;release_result jsonb;
  denied_reserve boolean:=false;denied_write boolean:=false;
  denied_register boolean:=false;denied_delete boolean:=false;
begin
  perform public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000013',64,repeat('b',64),
    '07000000-0000-4000-8000-000000000103'
  );
  perform public.begin_persona_source_storage_write_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000103'
  );
  guard_result:=public.begin_persona_source_deletion_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000013'
  );
  if guard_result->>'status'<>'active' or guard_result->>'active_writes'<>'1'
     or guard_result->>'active_studies'<>'0'
     or guard_result->>'persona_prefix'<>
       '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000013/' then
    raise exception 'Persona deletion guard was malformed: %',guard_result;end if;
  begin perform public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000013',32,repeat('c',64),
    '07000000-0000-4000-8000-000000000104'
  );exception when others then denied_reserve:=true;end;
  begin perform public.begin_persona_source_storage_write_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000103'
  );exception when others then denied_write:=true;end;
  begin perform public.register_persona_source_asset_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000013',
    '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000013/source/07000000-0000-4000-8000-000000000103-'||repeat('b',64)||'.png',
    repeat('b',64),'image/png',64,10,10,'race.png','unsorted','unknown',
    'unknown','reference_only','standard',false,'','',array[]::text[],now(),
    '07000000-0000-4000-8000-000000000103'
  );exception when others then denied_register:=true;end;
  begin perform public.delete_persona_source_library_for_persona_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000013'
  );exception when others then denied_delete:=true;end;
  if not denied_reserve or not denied_write or not denied_register or not denied_delete then
    raise exception 'Persona deletion guard failed a write/delete race gate';end if;
  release_result:=public.release_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000103'
  );
  if release_result->>'released'<>'true' or release_result->>'previous_state'<>'writing' then
    raise exception 'Writing reservation did not release cleanly: %',release_result;end if;
end
$$;
reset role;

insert into storage.objects(bucket_id,name,metadata) values(
  'persona-source-library',
  '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000013/source/orphan.bin',
  '{"size":"7"}'::jsonb
);
set role service_role;
do $$ declare denied boolean:=false;begin
  begin perform public.delete_persona_source_library_for_persona_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000013'
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Persona orphan Storage object was ignored';end if;
end $$;
reset role;
delete from storage.objects where name like
  '07000000-0000-4000-8000-000000000001/personas/07000000-0000-4000-8000-000000000013/%';
set role service_role;
do $$ declare result jsonb;begin
  result:=public.delete_persona_source_library_for_persona_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000013'
  );
  if result->>'status'<>'metadata_deleted' or result->>'assets_deleted'<>'0' then
    raise exception 'Persona deletion completion was malformed: %',result;end if;
end $$;
reset role;
do $$ begin
  if not exists(select 1 from private.persona_source_deletion_guards guard_row
    where guard_row.owner='07000000-0000-4000-8000-000000000001'
      and guard_row.persona_id='07000000-0000-4000-8000-000000000013'
      and guard_row.state='metadata_deleted') then
    raise exception 'Persona metadata-deleted tombstone was not retained';end if;
end $$;

-- Account deletion has the same in-flight/orphan fence, and its release RPC
-- supports content-only erasure without leaving uploads permanently blocked.
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$
declare guard_result jsonb;release_result jsonb;denied boolean:=false;
begin
  perform public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000002',
    '07000000-0000-4000-8000-000000000012',64,repeat('f',64),
    '07000000-0000-4000-8000-000000000201'
  );
  perform public.begin_persona_source_storage_write_service(
    '07000000-0000-4000-8000-000000000002',
    '07000000-0000-4000-8000-000000000201'
  );
  guard_result:=public.begin_persona_source_account_deletion_service(
    '07000000-0000-4000-8000-000000000002'
  );
  perform set_config('test.owner2_guard_token',guard_result->>'guard_token',false);
  if guard_result->>'status'<>'active' or guard_result->>'active_writes'<>'1'
     or guard_result->>'active_studies'<>'0'
     or guard_result->>'owner_prefix'<>'07000000-0000-4000-8000-000000000002/' then
    raise exception 'Account deletion guard was malformed: %',guard_result;end if;
  begin perform public.delete_persona_source_library_for_account_service(
    '07000000-0000-4000-8000-000000000002'
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Account metadata deleted during active write';end if;
  release_result:=public.release_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000002',
    '07000000-0000-4000-8000-000000000201'
  );
  if release_result->>'previous_state'<>'writing' then
    raise exception 'Account-fenced writing reservation did not release';end if;
end
$$;
reset role;

insert into storage.objects(bucket_id,name,metadata) values(
  'persona-source-library',
  '07000000-0000-4000-8000-000000000002/unregistered-orphan.bin',
  '{"size":"9"}'::jsonb
);
set role service_role;
do $$ declare denied boolean:=false;begin
  begin perform public.delete_persona_source_library_for_account_service(
    '07000000-0000-4000-8000-000000000002'
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Account orphan Storage object was ignored';end if;
end $$;
reset role;
delete from storage.objects where name like '07000000-0000-4000-8000-000000000002/%';
set role service_role;
do $$ declare result jsonb;release_result jsonb;retry_result jsonb;begin
  result:=public.delete_persona_source_library_for_account_service(
    '07000000-0000-4000-8000-000000000002'
  );
  if result->>'status'<>'metadata_deleted' then
    raise exception 'Account cleanup receipt was malformed: %',result;end if;
  release_result:=public.release_persona_source_account_deletion_guard_service(
    '07000000-0000-4000-8000-000000000002',
    current_setting('test.owner2_guard_token')::uuid
  );
  if release_result->>'released'<>'true' then
    raise exception 'Content-only account guard did not release: %',release_result;end if;
  retry_result:=public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000002',
    '07000000-0000-4000-8000-000000000012',16,repeat('9',64),
    '07000000-0000-4000-8000-000000000202'
  );
  if retry_result->>'status'<>'reserved' then
    raise exception 'Released account guard did not reopen uploads';end if;
  perform public.release_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000002',
    '07000000-0000-4000-8000-000000000202'
  );
end $$;
reset role;

-- Owner RLS, RPC-only writes, local queue isolation, MFA, and hosted consent.
select set_config('request.jwt.claim.sub','07000000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"aal":"aal1"}',false);
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$
declare asset_a uuid;asset_b uuid;job_one uuid;job_two uuid;denied boolean:=false;
begin
  select asset.id into asset_a from public.persona_source_assets asset
    where asset.source_sha256=repeat('a',64);
  select asset.id into asset_b from public.persona_source_assets asset
    where asset.source_sha256=repeat('d',64);
  if asset_a is null or asset_b is null then raise exception 'Owner could not read source assets';end if;
  begin
    insert into public.persona_source_assets(
      owner,persona_id,source_sha256,mime_type,byte_size,pixel_width,pixel_height,
      original_filename
    ) values(
      '07000000-0000-4000-8000-000000000001',
      '07000000-0000-4000-8000-000000000011',repeat('e',64),'image/png',1,1,1,'x.png'
    );
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Authenticated table insert bypassed RPC-only writes';end if;
  perform public.add_persona_source_note(asset_a,'research','Visible ingredient is uncertain.');
  job_one:=public.queue_persona_source_study(asset_a,'local');
  job_two:=public.queue_persona_source_study(asset_a,'local');
  if job_one<>job_two then raise exception 'Queue retry was not idempotent';end if;
  if public.cancel_persona_source_study(asset_a)<>'cancelled' then
    raise exception 'Queued study was not cancelled by asset id';end if;
  perform public.queue_persona_source_study(asset_b,'local');
  perform public.update_persona_source_asset(asset_a,
    '{"hosted_analysis_consent":true,"sensitivity":"restricted"}'::jsonb);
  denied:=false;
  begin perform public.queue_persona_source_study(asset_a,'hosted');
  exception when others then denied:=true;end;
  if not denied then raise exception 'Restricted source entered hosted analysis';end if;
  perform public.update_persona_source_asset(asset_a,'{"sensitivity":"standard"}'::jsonb);
  denied:=false;
  begin perform public.queue_persona_source_study(asset_a,'hosted');
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'AAL1 owner queued hosted analysis';end if;
end
$$;
reset role;

select set_config('request.jwt.claims','{"aal":"aal2"}',false);
set role authenticated;
do $$ declare asset_id uuid;begin
  select asset.id into asset_id from public.persona_source_assets asset
    where asset.source_sha256=repeat('a',64);
  perform public.queue_persona_source_study(asset_id,'hosted');
end $$;
reset role;

-- Hosted workers never claim local jobs and billing is checked inside SQL.
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare claim jsonb;begin
  perform set_config('test.billing_access','false',false);
  claim:=public.claim_persona_source_study_service('runtime-worker');
  if claim->>'status'<>'empty' then
    raise exception 'Database claimed a job without active owner entitlement: %',claim;end if;
  perform set_config('test.billing_access','true',false);
  claim:=public.claim_persona_source_study_service('runtime-worker');
  if claim->>'status'<>'claimed' or claim->>'execution_mode'<>'hosted'
     or claim->>'storage_path' not like '%/source/%' or claim->>'lease_token' is null then
    raise exception 'Hosted worker claim was malformed: %',claim;end if;
  perform set_config('test.claim_job',claim->>'job_id',false);
  perform set_config('test.claim_lease',claim->>'lease_token',false);
  perform set_config('test.claim_asset',claim->>'asset_id',false);
end $$;
reset role;

do $$ begin
  if not exists(select 1 from public.persona_source_analysis_jobs job
      where job.execution_mode='local' and job.status='queued') then
    raise exception 'Hosted service worker consumed a local companion job';end if;
end $$;

-- Claimed owner cancellation is cooperative; finalization discards notes.
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ begin
  if public.cancel_persona_source_study(current_setting('test.claim_asset')::uuid)
      <>'cancel_requested' then
    raise exception 'Claimed study did not enter cancel_requested';end if;
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare result jsonb;begin
  result:=public.finalize_persona_source_study_service(
    current_setting('test.claim_job')::uuid,current_setting('test.claim_lease')::uuid,
    'completed','[{"note_kind":"description","body":"discard me"}]'::jsonb,
    'test-provider','test-model',''
  );
  if result->>'status'<>'cancelled' or result->>'suggested_notes'<>'0' then
    raise exception 'Claimed cancellation accepted provider notes: %',result;end if;
end $$;
reset role;
do $$ begin
  if exists(select 1 from public.persona_source_notes note
    where note.analysis_job_id=current_setting('test.claim_job')::uuid) then
    raise exception 'Provider notes survived claimed cancellation';end if;
end $$;

-- Consent revocation and restricted sensitivity both serialize before finalize.
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ begin
  perform public.queue_persona_source_study(current_setting('test.claim_asset')::uuid,'hosted');
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare claim jsonb;begin
  claim:=public.claim_persona_source_study_service('consent-runtime-worker');
  perform set_config('test.claim_job',claim->>'job_id',false);
  perform set_config('test.claim_lease',claim->>'lease_token',false);
end $$;
reset role;
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ begin
  perform public.update_persona_source_asset(
    current_setting('test.claim_asset')::uuid,'{"hosted_analysis_consent":false}'::jsonb
  );
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare result jsonb;begin
  result:=public.finalize_persona_source_study_service(
    current_setting('test.claim_job')::uuid,current_setting('test.claim_lease')::uuid,
    'completed','[{"note_kind":"research","body":"discard after revoke"}]'::jsonb,
    'test-provider','test-model',''
  );
  if result->>'status'<>'cancelled' or result->>'suggested_notes'<>'0' then
    raise exception 'Consent revocation did not discard provider notes: %',result;end if;
end $$;
reset role;

select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ begin
  perform public.update_persona_source_asset(
    current_setting('test.claim_asset')::uuid,
    '{"hosted_analysis_consent":true,"sensitivity":"standard"}'::jsonb
  );
  perform public.queue_persona_source_study(current_setting('test.claim_asset')::uuid,'hosted');
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare claim jsonb;begin
  claim:=public.claim_persona_source_study_service('sensitivity-runtime-worker');
  perform set_config('test.claim_job',claim->>'job_id',false);
  perform set_config('test.claim_lease',claim->>'lease_token',false);
end $$;
reset role;
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ begin
  perform public.update_persona_source_asset(
    current_setting('test.claim_asset')::uuid,'{"sensitivity":"restricted"}'::jsonb
  );
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare result jsonb;begin
  result:=public.finalize_persona_source_study_service(
    current_setting('test.claim_job')::uuid,current_setting('test.claim_lease')::uuid,
    'completed','[{"note_kind":"warning","body":"discard restricted"}]'::jsonb,
    'test-provider','test-model',''
  );
  if result->>'status'<>'cancelled' or result->>'suggested_notes'<>'0' then
    raise exception 'Restricted transition did not discard provider notes: %',result;end if;
end $$;
reset role;

-- A normal hosted completion creates suggested notes and never auto-publishes.
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ begin
  perform public.update_persona_source_asset(
    current_setting('test.claim_asset')::uuid,'{"sensitivity":"standard"}'::jsonb
  );
  perform public.queue_persona_source_study(current_setting('test.claim_asset')::uuid,'hosted');
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare claim jsonb;result jsonb;begin
  claim:=public.claim_persona_source_study_service('complete-runtime-worker');
  result:=public.finalize_persona_source_study_service(
    (claim->>'job_id')::uuid,(claim->>'lease_token')::uuid,'completed',
    '[{"note_kind":"description","body":"A plated dinner in indoor light.","confidence":0.9},
      {"note_kind":"content_idea","body":"Use as a before-edit meal reference.","confidence":0.7}]'::jsonb,
    'test-provider','test-vision-model',''
  );
  if result->>'status'<>'completed' or result->>'suggested_notes'<>'2'
     or result->>'auto_publish'<>'false' then
    raise exception 'Study finalization violated review-only output: %',result;end if;
end $$;
reset role;

select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ declare note_id uuid;begin
  select note.id into note_id from public.persona_source_notes note
  where note.author_kind='ai' and note.review_state='suggested' limit 1;
  if note_id is null then raise exception 'Owner did not receive suggested AI notes';end if;
  perform public.review_persona_source_note(note_id,'accepted');
end $$;
reset role;

-- Another owner sees no source metadata/notes and cannot read private locators.
select set_config('request.jwt.claim.sub','07000000-0000-4000-8000-000000000002',false);
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ declare denied boolean:=false;begin
  if exists(select 1 from public.persona_source_assets)
     or exists(select 1 from public.persona_source_notes) then
    raise exception 'Owner RLS leaked another account source library';end if;
  begin perform count(*) from private.persona_source_asset_locations;
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Authenticated account read private source locators';end if;
end $$;
reset role;

-- Stale cancel_requested leases become cancelled; expired writing and rate rows
-- are settled in a bounded service-only retention batch.
select set_config('request.jwt.claim.sub','07000000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"aal":"aal2"}',false);
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ declare asset_b uuid;begin
  select asset.id into asset_b from public.persona_source_assets asset
    where asset.source_sha256=repeat('d',64);
  if public.cancel_persona_source_study(asset_b)<>'cancelled' then
    raise exception 'Local fixture did not remain queued for hosted-only claim test';end if;
  perform public.queue_persona_source_study(asset_b,'hosted');
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare claim jsonb;begin
  claim:=public.claim_persona_source_study_service('stale-runtime-worker');
  if claim->>'status'<>'claimed' then raise exception 'Stale fixture was not claimed';end if;
  perform set_config('test.stale_job',claim->>'job_id',false);
  perform set_config('test.stale_asset',claim->>'asset_id',false);
  perform public.reserve_persona_source_upload_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000011',64,repeat('e',64),
    '07000000-0000-4000-8000-000000000301'
  );
  perform public.begin_persona_source_storage_write_service(
    '07000000-0000-4000-8000-000000000001',
    '07000000-0000-4000-8000-000000000301'
  );
  perform public.consume_persona_source_rate_limit_service(
    '07000000-0000-4000-8000-000000000001','byte_read'
  );
end $$;
reset role;
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ begin
  if public.cancel_persona_source_study(current_setting('test.stale_asset')::uuid)
      <>'cancel_requested' then raise exception 'Stale claimed fixture was not cancel_requested';end if;
end $$;
reset role;

select set_config('app.persona_source_rpc_writer','1',false);
update public.persona_source_analysis_jobs set lease_expires_at=now()-interval '31 minutes'
where id=current_setting('test.stale_job')::uuid;
select set_config('app.persona_source_rpc_writer','',false);
update private.persona_source_upload_reservations set
  created_at=now()-interval '20 minutes',expires_at=now()-interval '1 minute'
where idempotency_key='07000000-0000-4000-8000-000000000301';
update private.persona_source_request_rate_limits set expires_at=now()-interval '1 minute';

select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare result jsonb;begin
  result:=public.purge_persona_source_library_retention_batch_service(10);
  if (result->>'expired_reservations')::integer<1
     or (result->>'expired_rate_rows')::integer<1
     or (result->>'stale_jobs_cancelled')::integer<1 then
    raise exception 'Bounded retention did not settle every fixture: %',result;end if;
end $$;
reset role;
do $$ begin
  if not exists(select 1 from public.persona_source_analysis_jobs job
    where job.id=current_setting('test.stale_job')::uuid and job.status='cancelled') then
    raise exception 'Stale cancel_requested lease became failed instead of cancelled';end if;
end $$;

-- Single-item deletion preflights before byte removal. A claimed worker is
-- cooperatively cancelled, its provider notes are discarded, and retry becomes
-- byte-safe only after no claimed study remains.
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ declare asset_b uuid;begin
  select asset.id into asset_b from public.persona_source_assets asset
    where asset.source_sha256=repeat('d',64);
  perform public.queue_persona_source_study(asset_b,'hosted');
  perform set_config('test.single_asset',asset_b::text,false);
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare claim jsonb;resolution record;denied boolean:=false;begin
  claim:=public.claim_persona_source_study_service('single-delete-runtime-worker');
  if claim->>'status'<>'claimed' then raise exception 'Single-delete fixture was not claimed';end if;
  perform set_config('test.single_job',claim->>'job_id',false);
  perform set_config('test.single_lease',claim->>'lease_token',false);
  select * into resolution from public.resolve_persona_source_asset_service(
    '07000000-0000-4000-8000-000000000001',
    current_setting('test.single_asset')::uuid
  );
  perform set_config('test.single_path',resolution.storage_path,false);
  perform set_config('test.single_sha',resolution.source_sha256,false);
  begin perform public.delete_persona_source_asset_metadata_service(
    '07000000-0000-4000-8000-000000000001',
    current_setting('test.single_asset')::uuid,
    resolution.storage_path,resolution.source_sha256
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Single metadata deletion bypassed preflight';end if;
end $$;
reset role;
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ declare denied boolean:=false;begin
  begin perform public.begin_persona_source_asset_deletion_service(
    '07000000-0000-4000-8000-000000000001',
    current_setting('test.single_asset')::uuid
  );exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Non-service caller entered asset deletion preflight';end if;
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare result jsonb;denied boolean:=false;begin
  result:=public.begin_persona_source_asset_deletion_service(
    '07000000-0000-4000-8000-000000000001',
    current_setting('test.single_asset')::uuid
  );
  if result->>'status'<>'deleting' or result->>'active_studies'<>'1'
     or result ? 'storage_path' then
    raise exception 'Single deletion preflight was malformed: %',result;end if;
  begin perform public.delete_persona_source_asset_metadata_service(
    '07000000-0000-4000-8000-000000000001',
    current_setting('test.single_asset')::uuid,
    current_setting('test.single_path'),current_setting('test.single_sha')
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Claimed study did not block single byte phase';end if;
end $$;
reset role;
do $$ begin
  if not exists(select 1 from storage.objects object
      where object.bucket_id='persona-source-library'
        and object.name=current_setting('test.single_path'))
     or not exists(select 1 from public.persona_source_assets asset
      where asset.id=current_setting('test.single_asset')::uuid
        and asset.lifecycle_state='deleting') then
    raise exception 'Single deletion preflight removed bytes or lost deleting state';end if;
end $$;
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ declare archive_denied boolean:=false;edit_denied boolean:=false;begin
  begin perform public.update_persona_source_asset(
    current_setting('test.single_asset')::uuid,'{"archived":true}'::jsonb
  );exception when others then archive_denied:=true;end;
  begin perform public.update_persona_source_asset(
    current_setting('test.single_asset')::uuid,'{"title":"race edit"}'::jsonb
  );exception when others then edit_denied:=true;end;
  if not archive_denied or not edit_denied then
    raise exception 'Deleting asset accepted an owner archive or metadata update';end if;
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare result jsonb;retry_result jsonb;begin
  result:=public.finalize_persona_source_study_service(
    current_setting('test.single_job')::uuid,
    current_setting('test.single_lease')::uuid,
    'completed','[{"note_kind":"description","body":"discard on deletion"}]'::jsonb,
    'test-provider','test-model',''
  );
  if result->>'status'<>'cancelled' or result->>'suggested_notes'<>'0' then
    raise exception 'Single deletion accepted provider notes: %',result;end if;
  retry_result:=public.begin_persona_source_asset_deletion_service(
    '07000000-0000-4000-8000-000000000001',
    current_setting('test.single_asset')::uuid
  );
  if retry_result->>'status'<>'deleting'
     or retry_result->>'active_studies'<>'0' then
    raise exception 'Single deletion retry was not byte-safe: %',retry_result;end if;
end $$;
reset role;
do $$ begin
  if exists(select 1 from public.persona_source_notes note
      where note.analysis_job_id=current_setting('test.single_job')::uuid)
     or not exists(select 1 from public.persona_source_assets asset
      where asset.id=current_setting('test.single_asset')::uuid
        and asset.lifecycle_state='deleting') then
    raise exception 'Single deletion finalization retained notes or reset lifecycle';end if;
end $$;
delete from storage.objects object
where object.bucket_id='persona-source-library'
  and object.name=current_setting('test.single_path');
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare result jsonb;begin
  result:=public.delete_persona_source_asset_metadata_service(
    '07000000-0000-4000-8000-000000000001',
    current_setting('test.single_asset')::uuid,
    current_setting('test.single_path'),current_setting('test.single_sha')
  );
  if result->>'deleted'<>'true' or result->>'status'<>'deleted' then
    raise exception 'Single byte-first metadata deletion failed: %',result;end if;
end $$;
reset role;

-- Final account deletion cancels queued hosted work, requests cancellation of
-- a claimed study, blocks queue/claim/delete until the lease settles, and keeps
-- its metadata-deleted tombstone after full account erasure.
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ declare asset_a uuid;asset_b uuid;begin
  select asset.id into asset_a from public.persona_source_assets asset
    where asset.source_sha256=repeat('a',64);
  select asset.id into asset_b from public.persona_source_assets asset
    where asset.source_sha256=repeat('c',64);
  perform public.update_persona_source_asset(asset_a,'{"archived":true}'::jsonb);
  perform public.update_persona_source_asset(asset_a,'{"archived":false}'::jsonb);
  perform public.queue_persona_source_study(asset_a,'hosted');
  perform set_config('test.final_asset_a',asset_a::text,false);
  perform set_config('test.final_asset_b',asset_b::text,false);
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare claim jsonb;begin
  claim:=public.claim_persona_source_study_service('deletion-runtime-worker');
  if claim->>'status'<>'claimed' then raise exception 'Deletion study was not claimed';end if;
  perform set_config('test.final_job',claim->>'job_id',false);
  perform set_config('test.final_lease',claim->>'lease_token',false);
end $$;
reset role;
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ begin
  perform public.queue_persona_source_study(current_setting('test.final_asset_b')::uuid,'hosted');
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare guard_result jsonb;claim jsonb;denied boolean:=false;begin
  guard_result:=public.begin_persona_source_account_deletion_service(
    '07000000-0000-4000-8000-000000000001'
  );
  perform set_config('test.final_guard_token',guard_result->>'guard_token',false);
  if guard_result->>'status'<>'active' or guard_result->>'active_studies'<>'1'
     or guard_result->>'active_writes'<>'0' then
    raise exception 'Final account guard did not report active study: %',guard_result;end if;
  claim:=public.claim_persona_source_study_service('guarded-runtime-worker');
  if claim->>'status'<>'empty' then raise exception 'Worker claimed under deletion guard';end if;
  begin perform public.delete_persona_source_library_for_account_service(
    '07000000-0000-4000-8000-000000000001'
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Account metadata deleted during claimed study';end if;
end $$;
reset role;
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ declare denied boolean:=false;begin
  begin perform public.queue_persona_source_study(
    current_setting('test.final_asset_b')::uuid,'hosted'
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Owner queued study under deletion guard';end if;
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare result jsonb;guard_result jsonb;denied boolean:=false;begin
  result:=public.finalize_persona_source_study_service(
    current_setting('test.final_job')::uuid,current_setting('test.final_lease')::uuid,
    'completed','[{"note_kind":"description","body":"discard during deletion"}]'::jsonb,
    'test-provider','test-model',''
  );
  if result->>'status'<>'cancelled' or result->>'suggested_notes'<>'0' then
    raise exception 'Deletion cancellation accepted provider notes: %',result;end if;
  guard_result:=public.begin_persona_source_account_deletion_service(
    '07000000-0000-4000-8000-000000000001'
  );
  if guard_result->>'active_studies'<>'0' then
    raise exception 'Deletion guard did not observe settled study: %',guard_result;end if;
  begin perform public.delete_persona_source_library_for_account_service(
    '07000000-0000-4000-8000-000000000001'
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Account metadata deleted before Storage prefix';end if;
end $$;
reset role;
do $$ begin
  if not exists(select 1 from public.persona_source_analysis_jobs job
      where job.asset_id=current_setting('test.final_asset_b')::uuid
        and job.execution_mode='hosted' and job.status='cancelled') then
    raise exception 'Deletion guard did not cancel queued hosted study';end if;
end $$;

delete from storage.objects
where bucket_id='persona-source-library'
  and name like '07000000-0000-4000-8000-000000000001/%';

select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$ declare result jsonb;begin
  result:=public.delete_persona_source_library_for_account_service(
    '07000000-0000-4000-8000-000000000001'
  );
  if result->>'status'<>'metadata_deleted' or not (result ? 'assets_deleted') then
    raise exception 'Final account erasure receipt was malformed: %',result;end if;
end $$;
reset role;

do $$ begin
  if exists(select 1 from public.persona_source_assets asset
      where asset.owner='07000000-0000-4000-8000-000000000001')
     or exists(select 1 from private.persona_source_quota_usage usage
      where usage.owner='07000000-0000-4000-8000-000000000001') then
    raise exception 'Account source-library erasure was incomplete';end if;
  if not exists(select 1 from private.persona_source_account_deletion_guards guard_row
      where guard_row.owner='07000000-0000-4000-8000-000000000001'
        and guard_row.state='metadata_deleted') then
    raise exception 'Full account erasure did not retain its deletion tombstone';end if;
end $$;

select 'persona-source-library-070-runtime-ok' as result;
