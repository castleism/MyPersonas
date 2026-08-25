\set ON_ERROR_STOP on

begin;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $acl_and_lease$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona constant uuid:='05900000-0000-4000-8000-000000000199';
  v_hash constant text:=repeat('b',64);
  v_path text:=lower(v_owner::text)||'/published/provenance/none/uploaded/'
    ||lower(v_persona::text)||'/profile/test/'||v_hash||'.png';
  v_url text:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'||v_path;
  v_lease constant uuid:='06500000-0000-4000-8000-000000004001';
  v_busy_lease constant uuid:='06500000-0000-4000-8000-000000004002';
  v_erasure constant uuid:='06500000-0000-4000-8000-000000005001';
  v_asset uuid;v_failed boolean;
begin
  if has_function_privilege('authenticated',
      'public.declare_legacy_media_reference_service(uuid,uuid,text)','EXECUTE')
     or has_function_privilege('service_role',
      'public.inventory_legacy_media_references_core_064(uuid,integer)','EXECUTE')
     or has_function_privilege('service_role',
      'public.register_imported_persona_media_asset_service_065(uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,text,uuid,timestamptz)','EXECUTE')
     or has_function_privilege('service_role',
      'public.register_persona_media_asset_core_063(uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,uuid,text)','EXECUTE') then
    raise exception 'Internal remediation helpers leaked EXECUTE authority';
  end if;
  if to_regprocedure(
    'public.register_persona_media_asset_service(uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,uuid,text)'
  ) is not null then raise exception 'Unsafe no-lease registrar survived 065'; end if;

  insert into storage.objects(id,bucket_id,name,metadata,updated_at) values(
    '06500000-0000-4000-8000-000000003001','persona-media',v_path,
    '{"size":24,"mimetype":"image/png"}'::jsonb,'2026-08-23T13:00:00Z'
  );
  if public.claim_persona_media_upload_service_065(
      v_owner,v_lease,v_path,'media_ingest',180)<>'claimed' then
    raise exception 'Normal intake upload lease was not claimed';
  end if;
  v_failed:=false;
  begin
    perform public.register_persona_media_asset_service(
      v_owner,v_persona,'image',v_path,v_url,'image/png',24,'uploaded',
      'none',v_hash,v_hash,'not_required','','',null,'original',
      '06500000-0000-4000-8000-000000004099');
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'Foreign upload lease registered media'; end if;
  v_asset:=public.register_persona_media_asset_service(
    v_owner,v_persona,'image',v_path,v_url,'image/png',24,'uploaded',
    'none',v_hash,v_hash,'not_required','','',null,'original',v_lease);
  if v_asset is null then raise exception 'Lease-bound normal intake registration failed'; end if;
  if not public.release_persona_media_upload_service_065(v_owner,v_lease) then
    raise exception 'Normal intake upload lease did not release';
  end if;
  v_failed:=false;
  begin
    perform public.register_persona_media_asset_service(
      v_owner,v_persona,'image',v_path,v_url,'image/png',24,'uploaded',
      'none',v_hash,v_hash,'not_required','','',null,'original',v_lease);
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'Released upload lease was replayed'; end if;

  v_path:=lower(v_owner::text)||'/published/provenance/none/uploaded/'
    ||lower(v_persona::text)||'/profile/busy/'||repeat('c',64)||'.png';
  if public.claim_persona_media_upload_service_065(
      v_owner,v_busy_lease,v_path,'media_ingest',180)<>'claimed' then
    raise exception 'Busy-window upload lease was not claimed';
  end if;
  if public.claim_meta_owner_erasure(v_owner,v_erasure,300)<>'busy' then
    raise exception 'Erasure started while an upload lease was active';
  end if;
  perform public.release_persona_media_upload_service_065(v_owner,v_busy_lease);
  if public.claim_meta_owner_erasure(v_owner,v_erasure,300)<>'claimed' then
    raise exception 'Erasure did not claim after upload lease release';
  end if;
  if public.claim_persona_media_upload_service_065(
      v_owner,v_busy_lease,v_path,'media_ingest',180)<>'erasure_active' then
    raise exception 'Upload began during active erasure';
  end if;
  v_failed:=false;
  begin perform public.inventory_legacy_media_references_service(v_owner,250);
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'Inventory mutated during active erasure'; end if;
  if not public.arm_persona_media_erasure_tombstone_service_065(v_owner,v_erasure)
     or not public.release_meta_owner_erasure(v_owner,v_erasure) then
    raise exception 'Erasure cooldown/release was not verified';
  end if;
  if public.claim_persona_media_upload_service_065(
      v_owner,v_busy_lease,v_path,'media_ingest',180)<>'erasure_active' then
    raise exception 'Upload began during the post-erasure cooldown';
  end if;
  v_failed:=false;
  begin
    insert into storage.objects(id,bucket_id,name,metadata,updated_at) values(
      '06500000-0000-4000-8000-000000003099','persona-media',v_path,
      '{"size":24,"mimetype":"image/png"}'::jsonb,now());
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'Storage-row guard allowed a late owner write'; end if;
  if coalesce((public.legacy_media_release_readiness_service_065()
      ->>'active_erasure_cooldowns')::bigint,0)<1 then
    raise exception 'Readiness ignored the active erasure cooldown';
  end if;
end
$acl_and_lease$;

reset role;
delete from public.persona_media_erasure_tombstones_065 tombstone
where tombstone.owner_hash=public.persona_media_owner_hash_065(
  '05900000-0000-4000-8000-000000000099');
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $shared_import$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona_a constant uuid:='05900000-0000-4000-8000-000000000199';
  v_persona_b constant uuid:='06400000-0000-4000-8000-000000000199';
  v_object constant uuid:='06400000-0000-4000-8000-000000001001';
  v_updated constant timestamptz:='2026-08-23T10:00:00Z';
  v_hash constant text:=repeat('a',64);
  v_ref_a uuid;v_ref_b uuid;v_decl_a uuid;v_decl_b uuid;
  v_path_a text;v_path_b text;v_url_a text;v_url_b text;
  v_lease_a constant uuid:='06500000-0000-4000-8000-000000004011';
  v_lease_b constant uuid:='06500000-0000-4000-8000-000000004012';
  v_asset_a uuid;v_asset_b uuid;v_import_a uuid;v_import_b uuid;
  v_public_a uuid;v_public_b uuid;v_revision_a integer;v_revision_b integer;
  v_destination_id uuid;v_destination_updated timestamptz;v_state text;
  v_failed boolean;
begin
  perform public.inventory_legacy_media_references_service(v_owner,500);
  select reference.id into strict v_ref_a from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='persona'
    and reference.row_id=v_persona_a and reference.slot='avatar';
  select reference.id into strict v_ref_b from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='persona'
    and reference.row_id=v_persona_b and reference.slot='avatar';
  if not public.record_legacy_media_preview_service(
      v_owner,v_ref_a,v_object,v_updated,v_hash,24,'image/png')
     or not public.record_legacy_media_preview_service(
      v_owner,v_ref_b,v_object,v_updated,v_hash,24,'image/png') then
    raise exception 'Reference-local exact previews failed';
  end if;
  v_decl_a:=public.declare_legacy_media_reference_service(v_owner,v_ref_a,'none');
  v_decl_b:=public.declare_legacy_media_reference_service(v_owner,v_ref_b,'none');
  if v_decl_a=v_decl_b or exists(select 1 from public.legacy_media_declarations_065 declaration
    where declaration.id in(v_decl_a,v_decl_b) and declaration.state<>'active') then
    raise exception 'Shared-source declarations were not independently active';
  end if;

  v_path_a:=lower(v_owner::text)||'/published/provenance/none/imported/'
    ||lower(v_persona_a::text)||'/profile/avatar/legacy_original/'||v_hash||'.png';
  v_path_b:=lower(v_owner::text)||'/published/provenance/none/imported/'
    ||lower(v_persona_b::text)||'/profile/avatar/legacy_original/'||v_hash||'.png';
  v_url_a:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'||v_path_a;
  v_url_b:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'||v_path_b;
  insert into storage.objects(id,bucket_id,name,metadata,updated_at) values
    ('06500000-0000-4000-8000-000000003011','persona-media',v_path_a,
     '{"size":24,"mimetype":"image/png"}'::jsonb,'2026-08-23T13:11:00Z'),
    ('06500000-0000-4000-8000-000000003012','persona-media',v_path_b,
     '{"size":24,"mimetype":"image/png"}'::jsonb,'2026-08-23T13:12:00Z');
  if public.claim_persona_media_upload_service_065(
      v_owner,v_lease_a,v_path_a,'legacy_import',180)<>'claimed'
     or public.claim_persona_media_upload_service_065(
      v_owner,v_lease_b,v_path_b,'legacy_import',180)<>'claimed' then
    raise exception 'Legacy import upload leases were not claimed';
  end if;
  select destination.object_id,destination.object_updated_at
  into strict v_destination_id,v_destination_updated
  from public.resolve_legacy_media_destination_service_065(
    v_owner,v_decl_a,v_path_a,v_hash,24,'image/png',v_lease_a) destination;
  select persona.publication_revision into v_revision_a
  from public.personas persona where persona.id=v_persona_a;
  v_import_a:=public.commit_legacy_media_import_service_065(
    v_owner,v_decl_a,v_path_a,v_url_a,v_hash,24,'image/png',
    'not_required','','',v_destination_id,v_destination_updated,v_lease_a);
  perform public.release_persona_media_upload_service_065(v_owner,v_lease_a);
  select destination.object_id,destination.object_updated_at
  into strict v_destination_id,v_destination_updated
  from public.resolve_legacy_media_destination_service_065(
    v_owner,v_decl_b,v_path_b,v_hash,24,'image/png',v_lease_b) destination;
  select persona.publication_revision into v_revision_b
  from public.personas persona where persona.id=v_persona_b;
  v_import_b:=public.commit_legacy_media_import_service_065(
    v_owner,v_decl_b,v_path_b,v_url_b,v_hash,24,'image/png',
    'not_required','','',v_destination_id,v_destination_updated,v_lease_b);
  perform public.release_persona_media_upload_service_065(v_owner,v_lease_b);

  select imported.asset_id,imported.public_id into strict v_asset_a,v_public_a
  from public.legacy_media_imports_065 imported where imported.id=v_import_a;
  select imported.asset_id,imported.public_id into strict v_asset_b,v_public_b
  from public.legacy_media_imports_065 imported where imported.id=v_import_b;
  if v_asset_a=v_asset_b or v_public_a=v_public_b or not exists(
    select 1 from public.persona_media_assets asset
    where asset.id=v_asset_a and asset.owner=v_owner and asset.persona_id=v_persona_a
      and asset.origin='imported' and asset.declaration_source='import'
      and asset.source='sourced' and asset.mime_type='image/png'
      and asset.source_sha256=asset.content_sha256
      and asset.storage_path=v_path_a) or not exists(
    select 1 from public.persona_media_assets asset
    where asset.id=v_asset_b and asset.owner=v_owner and asset.persona_id=v_persona_b
      and asset.origin='imported' and asset.declaration_source='import'
      and asset.storage_path=v_path_b) then
    raise exception 'Shared source crossed persona asset/handle authority';
  end if;
  v_failed:=false;
  begin
    update public.persona_media_assets asset set status='archived'
    where asset.id=v_asset_a;
  exception when others then
    v_failed:=sqlerrm like 'A bound legacy import cannot be archived%';
  end;
  if not v_failed then raise exception 'Bound import asset was archived independently'; end if;
  v_failed:=false;
  begin
    delete from public.persona_media_assets asset where asset.id=v_asset_a;
  exception when others then
    v_failed:=sqlerrm like 'A bound legacy import cannot be archived%';
  end;
  if not v_failed then raise exception 'Bound import asset was deleted independently'; end if;
  select status.state into v_state from public.legacy_media_import_status_service(
    v_owner,v_decl_a) status;
  if v_state<>'applied' then raise exception 'Persona A exact opaque binding was not current'; end if;
  select status.state into v_state from public.legacy_media_import_status_service(
    v_owner,v_decl_b) status;
  if v_state<>'applied' then raise exception 'Persona B exact opaque binding was not current'; end if;
  if (select persona.publication_revision from public.personas persona
      where persona.id=v_persona_a)<>v_revision_a+1
     or (select persona.publication_revision from public.personas persona
      where persona.id=v_persona_b)<>v_revision_b+1 then
    raise exception 'Public persona review invalidation was not exactly once';
  end if;
  perform public.inventory_legacy_media_references_service(v_owner,500);
  if exists(select 1 from public.legacy_media_references reference
      where reference.id in(v_ref_a,v_ref_b) and reference.state<>'imported')
     then
    raise exception 'Routine re-inventory destroyed terminal import state';
  end if;
  select status.state into v_state from public.legacy_media_import_status_service(
    v_owner,v_decl_a) status;
  if v_state<>'applied' then raise exception 'Persona A second-scan idempotency was lost'; end if;
  select status.state into v_state from public.legacy_media_import_status_service(
    v_owner,v_decl_b) status;
  if v_state<>'applied' then raise exception 'Applied import idempotency was lost'; end if;
end
$shared_import$;

do $declare_then_disappear$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_draft constant uuid:='06500000-0000-4000-8000-000000002001';
  v_source constant uuid:='06500000-0000-4000-8000-000000001001';
  v_ref uuid;v_decl uuid;
begin
  select reference.id into strict v_ref from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='draft'
    and reference.row_id=v_draft and reference.slot='media';
  if not public.record_legacy_media_preview_service(
      v_owner,v_ref,v_source,'2026-08-23T11:00:00Z',repeat('d',64),24,'image/png') then
    raise exception 'Private draft preview failed';
  end if;
  v_decl:=public.declare_legacy_media_reference_service(v_owner,v_ref,'none');
  if v_decl is null then raise exception 'Private draft declaration failed'; end if;
end
$declare_then_disappear$;

reset role;
set local session_replication_role=replica;
update public.drafts set media_url=''
where id='06500000-0000-4000-8000-000000002001';
set local session_replication_role=origin;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $disappearance_supersedes$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_draft constant uuid:='06500000-0000-4000-8000-000000002001';
begin
  perform public.inventory_legacy_media_references_service(v_owner,500);
  if not exists(select 1 from public.legacy_media_references reference
      where reference.owner=v_owner and reference.consumer='draft'
        and reference.row_id=v_draft and reference.state='stale'
        and reference.preview_revision is null)
     or exists(select 1 from public.legacy_media_declarations_065 declaration
       join public.legacy_media_references reference on reference.id=declaration.reference_id
       where reference.owner=v_owner and reference.consumer='draft'
         and reference.row_id=v_draft and declaration.state='active') then
    raise exception 'Disappeared pending reference retained active authority';
  end if;
end
$disappearance_supersedes$;

reset role;
set local session_replication_role=replica;
update public.drafts set
  media_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1730000000000-private.png'
where id='06500000-0000-4000-8000-000000002001';
set local session_replication_role=origin;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $private_draft_import$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona constant uuid:='05900000-0000-4000-8000-000000000199';
  v_draft constant uuid:='06500000-0000-4000-8000-000000002001';
  v_source constant uuid:='06500000-0000-4000-8000-000000001001';
  v_destination constant uuid:='06500000-0000-4000-8000-000000003031';
  v_lease constant uuid:='06500000-0000-4000-8000-000000004031';
  v_hash constant text:=repeat('d',64);
  v_ref uuid;v_decl uuid;v_path text;v_url text;v_import uuid;v_asset uuid;
  v_destination_updated timestamptz;v_before integer;
begin
  perform public.inventory_legacy_media_references_service(v_owner,500);
  select reference.id into strict v_ref from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='draft'
    and reference.row_id=v_draft and reference.slot='media';
  if not public.record_legacy_media_preview_service(
      v_owner,v_ref,v_source,'2026-08-23T11:00:00Z',v_hash,24,'image/png') then
    raise exception 'Restored private draft preview failed';
  end if;
  v_decl:=public.declare_legacy_media_reference_service(v_owner,v_ref,'none');
  v_path:=lower(v_owner::text)||'/published/provenance/none/imported/'
    ||lower(v_persona::text)||'/draft/media/legacy_original/'||v_hash||'.png';
  v_url:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'||v_path;
  v_destination_updated:='2026-08-23T13:31:00Z';
  insert into storage.objects(id,bucket_id,name,metadata,updated_at) values(
    v_destination,'persona-media',v_path,
    '{"size":24,"mimetype":"image/png"}'::jsonb,v_destination_updated);
  if public.claim_persona_media_upload_service_065(
      v_owner,v_lease,v_path,'legacy_import',180)<>'claimed' then
    raise exception 'Private draft lease failed';
  end if;
  select persona.publication_revision into v_before from public.personas persona
  where persona.id=v_persona;
  v_import:=public.commit_legacy_media_import_service_065(
    v_owner,v_decl,v_path,v_url,v_hash,24,'image/png','not_required','','',
    v_destination,v_destination_updated,v_lease);
  perform public.release_persona_media_upload_service_065(v_owner,v_lease);
  select imported.asset_id into strict v_asset from public.legacy_media_imports_065 imported
  where imported.id=v_import;
  if (select persona.publication_revision from public.personas persona
      where persona.id=v_persona)<>v_before
     or not exists(select 1 from public.resolve_persona_media_asset_service(v_owner,v_asset))
     or not exists(select 1 from public.legacy_media_references reference
       where reference.id=v_ref and reference.state='imported') then
    raise exception 'Private draft import changed publication state or did not resolve';
  end if;
end
$private_draft_import$;

reset role;
set local session_replication_role=replica;
update public.post_drafts set
  approved_content_hash='old-approval',approved_timezone='UTC',
  approved_facebook_page_id='old-page',approved_instagram_business_id='old-ig',
  approved_fb_media_sha256=repeat('1',64),approved_fb_media_mime='image/png',
  approved_fb_media_bytes=24,approved_fb_media_path='old/path.png',
  approved_fb_media_url='https://old.example.test/fb.png',
  approved_fb_provenance_sha256=repeat('2',64),last_error='old error'
where id='06500000-0000-4000-8000-000000002002';
set local session_replication_role=origin;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $post_draft_import$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona constant uuid:='05900000-0000-4000-8000-000000000199';
  v_draft constant uuid:='06500000-0000-4000-8000-000000002002';
  v_source constant uuid:='06500000-0000-4000-8000-000000001001';
  v_destination constant uuid:='06500000-0000-4000-8000-000000003032';
  v_lease constant uuid:='06500000-0000-4000-8000-000000004032';
  v_hash constant text:=repeat('d',64);
  v_ref uuid;v_decl uuid;v_path text;v_url text;v_before integer;
begin
  perform public.inventory_legacy_media_references_service(v_owner,500);
  select reference.id into strict v_ref from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='post_draft'
    and reference.row_id=v_draft and reference.slot='source';
  if not public.record_legacy_media_preview_service(
      v_owner,v_ref,v_source,'2026-08-23T11:00:00Z',v_hash,24,'image/png') then
    raise exception 'Post-draft source preview failed';
  end if;
  v_decl:=public.declare_legacy_media_reference_service(v_owner,v_ref,'none');
  v_path:=lower(v_owner::text)||'/published/provenance/none/imported/'
    ||lower(v_persona::text)||'/social/source/legacy_original/'||v_hash||'.png';
  v_url:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'||v_path;
  insert into storage.objects(id,bucket_id,name,metadata,updated_at) values(
    v_destination,'persona-media',v_path,
    '{"size":24,"mimetype":"image/png"}'::jsonb,'2026-08-23T13:32:00Z');
  if public.claim_persona_media_upload_service_065(
      v_owner,v_lease,v_path,'legacy_import',180)<>'claimed' then
    raise exception 'Post-draft import lease failed';
  end if;
  select persona.publication_revision into v_before from public.personas persona
  where persona.id=v_persona;
  perform public.commit_legacy_media_import_service_065(
    v_owner,v_decl,v_path,v_url,v_hash,24,'image/png','not_required','','',
    v_destination,'2026-08-23T13:32:00Z',v_lease);
  perform public.release_persona_media_upload_service_065(v_owner,v_lease);
  if (select persona.publication_revision from public.personas persona
      where persona.id=v_persona)<>v_before
     or not exists(select 1 from public.legacy_media_references reference
       where reference.id=v_ref and reference.state='imported')
     or not exists(select 1 from public.post_drafts draft where draft.id=v_draft
       and draft.status='draft' and draft.scheduled_for is null
       and draft.approved_at is null and draft.approved_by is null
       and draft.approved_content_hash='' and draft.approved_timezone=''
       and draft.approved_facebook_page_id='' and draft.approved_instagram_business_id=''
       and draft.approved_fb_media_sha256='' and draft.approved_fb_media_mime=''
       and draft.approved_fb_media_bytes=0 and draft.approved_fb_media_path=''
       and draft.approved_fb_media_url='' and draft.approved_fb_provenance_sha256=''
       and draft.last_error is null and draft.media_provenance_required) then
    raise exception 'Post-draft import did not clear snapshots or changed publication state';
  end if;
end
$post_draft_import$;

do $post_draft_social_setup$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona constant uuid:='05900000-0000-4000-8000-000000000199';
  v_draft constant uuid:='06500000-0000-4000-8000-000000002002';
  v_source constant uuid:='06500000-0000-4000-8000-000000001002';
  v_destination constant uuid:='06500000-0000-4000-8000-000000003033';
  v_lease constant uuid:='06500000-0000-4000-8000-000000004033';
  v_ref uuid;v_decl uuid;v_path text;
begin
  perform public.inventory_legacy_media_references_service(v_owner,500);
  select reference.id into strict v_ref from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='post_draft'
    and reference.row_id=v_draft and reference.slot='facebook';
  if not public.record_legacy_media_preview_service(
      v_owner,v_ref,v_source,'2026-08-23T11:01:00Z',repeat('e',64),24,'image/png') then
    raise exception 'Post-draft social preview failed';
  end if;
  v_decl:=public.declare_legacy_media_reference_service(v_owner,v_ref,'none');
  v_path:=lower(v_owner::text)||'/published/provenance/none/imported/'
    ||lower(v_persona::text)||'/social/facebook/legacy_facebook/'||repeat('f',64)||'.png';
  insert into storage.objects(id,bucket_id,name,metadata,updated_at) values(
    v_destination,'persona-media',v_path,
    '{"size":24,"mimetype":"image/png"}'::jsonb,'2026-08-23T13:33:00Z');
  if public.claim_persona_media_upload_service_065(
      v_owner,v_lease,v_path,'legacy_import',180)<>'claimed' then
    raise exception 'Post-draft social lease failed';
  end if;
end
$post_draft_social_setup$;

reset role;
update storage.objects set updated_at='2026-08-23T11:02:00Z'
where id='06500000-0000-4000-8000-000000001002';
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $source_toctou_rejected$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona constant uuid:='05900000-0000-4000-8000-000000000199';
  v_draft constant uuid:='06500000-0000-4000-8000-000000002002';
  v_destination constant uuid:='06500000-0000-4000-8000-000000003033';
  v_lease constant uuid:='06500000-0000-4000-8000-000000004033';
  v_decl uuid;v_path text;v_url text;v_failed boolean:=false;
begin
  select declaration.id into strict v_decl
  from public.legacy_media_declarations_065 declaration
  join public.legacy_media_references reference on reference.id=declaration.reference_id
  where declaration.owner=v_owner and declaration.state='active'
    and reference.consumer='post_draft' and reference.row_id=v_draft
    and reference.slot='facebook';
  v_path:=lower(v_owner::text)||'/published/provenance/none/imported/'
    ||lower(v_persona::text)||'/social/facebook/legacy_facebook/'||repeat('f',64)||'.png';
  v_url:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'||v_path;
  begin
    perform public.commit_legacy_media_import_service_065(
      v_owner,v_decl,v_path,v_url,repeat('f',64),24,'image/png',
      'not_required','','',v_destination,'2026-08-23T13:33:00Z',v_lease);
  exception when others then
    v_failed:=sqlerrm like 'Legacy source object changed%';
  end;
  if not v_failed then raise exception 'Changed legacy source committed after re-hash'; end if;
  perform public.release_persona_media_upload_service_065(v_owner,v_lease);
end
$source_toctou_rejected$;

reset role;
update storage.objects set updated_at='2026-08-23T11:01:00Z'
where id='06500000-0000-4000-8000-000000001002';
select set_config('request.jwt.claim.role','service_role',true);

do $post_draft_queue_gates_and_clear$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona constant uuid:='05900000-0000-4000-8000-000000000199';
  v_draft constant uuid:='06500000-0000-4000-8000-000000002002';
  v_ref uuid;v_status text;v_failed boolean;v_before integer;
begin
  select reference.id into strict v_ref from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='post_draft'
    and reference.row_id=v_draft and reference.slot='facebook';
  foreach v_status in array array['approved','scheduled','publishing','posted','failed','skipped'] loop
    perform set_config('session_replication_role','replica',true);
    update public.post_drafts set status=v_status where id=v_draft;
    perform set_config('session_replication_role','origin',true);
    v_failed:=false;
    begin perform public.clear_legacy_media_reference_service_065(v_owner,v_ref);
    exception when others then v_failed:=sqlerrm like 'Queued or historical%'; end;
    if not v_failed then raise exception 'Post-draft queue status % was remediated',v_status; end if;
  end loop;

  perform set_config('session_replication_role','replica',true);
  update public.post_drafts set status='draft',scheduled_for=now(),posted_at=now(),
    fb_published_at=now(),ig_published_at=now() where id=v_draft;
  perform set_config('session_replication_role','origin',true);
  v_failed:=false;
  begin perform public.clear_legacy_media_reference_service_065(v_owner,v_ref);
  exception when others then v_failed:=sqlerrm like 'Queued or historical%'; end;
  if not v_failed then raise exception 'Post-draft immutable history was remediated'; end if;

  perform set_config('session_replication_role','replica',true);
  update public.post_drafts set scheduled_for=null,posted_at=null,fb_published_at=null,
    ig_published_at=null,fb_post_id='fb-result',ig_media_id='ig-result',x_tweet_id='x-result'
  where id=v_draft;
  perform set_config('session_replication_role','origin',true);
  v_failed:=false;
  begin perform public.clear_legacy_media_reference_service_065(v_owner,v_ref);
  exception when others then v_failed:=sqlerrm like 'Queued or historical%'; end;
  if not v_failed then raise exception 'Post-draft provider result was remediated'; end if;

  perform set_config('session_replication_role','replica',true);
  update public.post_drafts set fb_post_id=null,ig_media_id=null,x_tweet_id=null,
    publish_claimed_at=now(),publish_facebook_page_id='page',
    publish_instagram_business_id='ig',approved_content_hash='old',
    approved_timezone='UTC',last_error='old error'
  where id=v_draft;
  perform set_config('session_replication_role','origin',true);
  v_failed:=false;
  begin perform public.clear_legacy_media_reference_service_065(v_owner,v_ref);
  exception when others then v_failed:=sqlerrm like 'Queued or historical%'; end;
  if not v_failed then raise exception 'Claimed post-draft was remediated'; end if;

  perform set_config('session_replication_role','replica',true);
  update public.post_drafts set publish_claimed_at=null,publish_facebook_page_id='',
    publish_instagram_business_id='' where id=v_draft;
  perform set_config('session_replication_role','origin',true);
  select persona.publication_revision into v_before from public.personas persona
  where persona.id=v_persona;
  if not public.clear_legacy_media_reference_service_065(v_owner,v_ref) then
    raise exception 'Clean private post-draft clear failed';
  end if;
  if (select persona.publication_revision from public.personas persona
      where persona.id=v_persona)<>v_before
     or not exists(select 1 from public.post_drafts draft where draft.id=v_draft
       and draft.status='draft' and draft.approved_content_hash=''
       and draft.approved_timezone='' and draft.last_error is null
       and draft.media_provenance_required)
     or not exists(select 1 from public.legacy_media_references reference
       where reference.id=v_ref and reference.state='cleared') then
    raise exception 'Private post-draft clear changed publication or retained snapshots';
  end if;
end
$post_draft_queue_gates_and_clear$;

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $affiliate_binding_replay$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona_a constant uuid:='05900000-0000-4000-8000-000000000199';
  v_product constant uuid:='06400000-0000-4000-8000-000000002007';
  v_source constant uuid:='06400000-0000-4000-8000-000000001007';
  v_destination constant uuid:='06500000-0000-4000-8000-000000003034';
  v_lease constant uuid:='06500000-0000-4000-8000-000000004034';
  v_hash constant text:=repeat('c',64);
  v_ref uuid;v_decl uuid;v_path text;v_url text;v_state text;
begin
  update public.persona_affiliate_offers offer set status='inactive'
  where offer.id='06400000-0000-4000-8000-000000002009';
  perform public.inventory_legacy_media_references_service(v_owner,500);
  select reference.id into strict v_ref from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='affiliate_product'
    and reference.row_id=v_product and reference.persona_id=v_persona_a
    and reference.state='pending';
  if not public.record_legacy_media_preview_service(
      v_owner,v_ref,v_source,'2026-08-23T10:07:00Z',v_hash,24,'image/png') then
    raise exception 'Affiliate preview failed';
  end if;
  v_decl:=public.declare_legacy_media_reference_service(v_owner,v_ref,'none');
  v_path:=lower(v_owner::text)||'/published/provenance/none/imported/'
    ||lower(v_persona_a::text)||'/affiliate/product/legacy_original/'||v_hash||'.png';
  v_url:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'||v_path;
  insert into storage.objects(id,bucket_id,name,metadata,updated_at) values(
    v_destination,'persona-media',v_path,
    '{"size":24,"mimetype":"image/png"}'::jsonb,'2026-08-23T13:34:00Z');
  if public.claim_persona_media_upload_service_065(
      v_owner,v_lease,v_path,'legacy_import',180)<>'claimed' then
    raise exception 'Affiliate import lease failed';
  end if;
  perform public.commit_legacy_media_import_service_065(
    v_owner,v_decl,v_path,v_url,v_hash,24,'image/png','not_required','','',
    v_destination,'2026-08-23T13:34:00Z',v_lease);
  perform public.release_persona_media_upload_service_065(v_owner,v_lease);
  select status.state into v_state
  from public.legacy_media_import_status_service(v_owner,v_decl) status;
  if v_state<>'applied' then raise exception 'Affiliate exact binding was not current'; end if;
  update public.persona_affiliate_offers offer set status=case
    when offer.id='06400000-0000-4000-8000-000000002008' then 'inactive'
    when offer.id='06400000-0000-4000-8000-000000002009' then 'active'
    else offer.status end
  where offer.product_id=v_product;
  select status.state into v_state
  from public.legacy_media_import_status_service(v_owner,v_decl) status;
  if v_state<>'superseded' then
    raise exception 'Moved affiliate persona retained false applied authority';
  end if;
end
$affiliate_binding_replay$;

reset role;
set local session_replication_role=replica;
update public.personas set
  avatar_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000000-shared.png',
  avatar_media_asset_id=null
where id='05900000-0000-4000-8000-000000000199';
set local session_replication_role=origin;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $restore_clear_and_readiness$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona_a constant uuid:='05900000-0000-4000-8000-000000000199';
  v_persona_b constant uuid:='06400000-0000-4000-8000-000000000199';
  v_ref_a uuid;v_import_b uuid;v_decl_b uuid;v_new_decl uuid;
  v_before integer;v_readiness jsonb;v_failed boolean;v_state text;
begin
  perform public.inventory_legacy_media_references_service(v_owner,500);
  select reference.id into strict v_ref_a from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='persona'
    and reference.row_id=v_persona_a and reference.slot='avatar';
  select imported.id,imported.declaration_id into strict v_import_b,v_decl_b
  from public.legacy_media_imports_065 imported where imported.persona_id=v_persona_b;
  if not exists(select 1 from public.legacy_media_references reference
      where reference.id=v_ref_a and reference.state='pending'
        and reference.preview_revision is null)
     or not exists(select 1 from public.legacy_media_declarations_065 declaration
      where declaration.reference_id=v_ref_a and declaration.state='superseded') then
    raise exception 'Restored legacy URL reused terminal preview/declaration authority';
  end if;
  select status.state into v_state from public.legacy_media_import_status_service(
    v_owner,v_decl_b) status;
  if v_state<>'applied' then
    raise exception 'Persona A restoration invalidated persona B exact binding';
  end if;
  if not public.record_legacy_media_preview_service(
      v_owner,v_ref_a,'06400000-0000-4000-8000-000000001001',
      '2026-08-23T10:00:00Z',repeat('a',64),24,'image/png') then
    raise exception 'Restored reference could not create a fresh preview';
  end if;
  v_new_decl:=public.declare_legacy_media_reference_service(v_owner,v_ref_a,'none');
  select status.state into v_state from public.legacy_media_import_status_service(
    v_owner,v_decl_b) status;
  if v_new_decl is null or v_state<>'applied' then
    raise exception 'Fresh A declaration disturbed B import';
  end if;
  select persona.publication_revision into v_before from public.personas persona
  where persona.id=v_persona_a;
  if not public.clear_legacy_media_reference_service_065(v_owner,v_ref_a) then
    raise exception 'Explicit clear failed';
  end if;
  perform public.inventory_legacy_media_references_service(v_owner,500);
  if not exists(select 1 from public.legacy_media_references reference
      where reference.id=v_ref_a and reference.state='cleared')
     or (select persona.publication_revision from public.personas persona
      where persona.id=v_persona_a)<>v_before+1
     then
    raise exception 'Clear terminal state/invalidation/shared isolation failed';
  end if;
  select status.state into v_state from public.legacy_media_import_status_service(
    v_owner,v_decl_b) status;
  if v_state<>'applied' then raise exception 'Persona B binding was invalidated by A clear'; end if;

  select reference.id into strict v_ref_a from public.legacy_media_references reference
  where reference.owner=v_owner and reference.consumer='persona'
    and reference.row_id=v_persona_a and reference.slot='feed_header';
  v_failed:=false;
  begin perform public.declare_legacy_media_reference_service(v_owner,v_ref_a,'none');
  exception when others then v_failed:=true; end;
  if not v_failed or not public.clear_legacy_media_reference_service_065(v_owner,v_ref_a) then
    raise exception 'Cross-owner reference was previewable/importable or not clearable';
  end if;

  v_readiness:=public.legacy_media_release_readiness_service_065();
  if coalesce((v_readiness->>'release_ready')::boolean,true)
     or not coalesce((v_readiness->>'legacy_bucket_public')::boolean,false)
     or coalesce((v_readiness->>'blocked_unverifiable_references')::bigint,0)<1
     or coalesce((v_readiness->>'finalizer_installed')::boolean,true)
     or coalesce((v_readiness->>'purge_performed')::boolean,true) then
    raise exception 'Legacy release readiness was falsely green or incomplete';
  end if;
end
$restore_clear_and_readiness$;

rollback;
