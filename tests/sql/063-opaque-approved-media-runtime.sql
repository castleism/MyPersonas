\set ON_ERROR_STOP on

begin;

do $isolated_staging_environment$
declare v_id constant uuid:='06300000-0000-4000-8000-000000000001';v_url text;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.configure_media_environment_service(
    'staging','https://abcdefghijklmnopqrst.supabase.co',
    'https://media-staging.mypersonas.online','isolated approved-media review'
  );
  perform public.lock_media_environment_service(
    'staging','https://abcdefghijklmnopqrst.supabase.co',
    'https://media-staging.mypersonas.online','isolated approved-media lock'
  );
  v_url:=public.approved_media_delivery_url(v_id);
  if v_url<>'https://media-staging.mypersonas.online/approved/v1/'||v_id::text
    or public.approved_media_delivery_id_from_url(v_url) is distinct from v_id then
    raise exception 'Approved media did not use its staging delivery origin';
  end if;
end
$isolated_staging_environment$;

rollback;
begin;

do $media_environment$
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.configure_media_environment_service(
    'production','https://nwsqyuucwzihruszocge.supabase.co',
    'https://media.mypersonas.online','disposable approved-media review'
  );
  perform public.lock_media_environment_service(
    'production','https://nwsqyuucwzihruszocge.supabase.co',
    'https://media.mypersonas.online','disposable approved-media lock'
  );
end
$media_environment$;

do $privileges$
begin
  if has_table_privilege('anon','public.post_approved_media_handles','select')
     or has_table_privilege('authenticated','public.post_approved_media_handles','select') then
    raise exception 'Browser role can read the approved-media correlation map';
  end if;
  if has_function_privilege('anon','public.resolve_post_approved_media_service(uuid)','execute')
     or has_function_privilege('authenticated','public.resolve_post_approved_media_service(uuid)','execute')
     or has_function_privilege('anon','public.resolve_post_approved_media_delivery_service(uuid)','execute')
     or has_function_privilege('authenticated','public.resolve_post_approved_media_delivery_service(uuid)','execute')
     or has_function_privilege('anon','public.finalize_post_approved_media_bucket_service()','execute')
     or has_function_privilege('authenticated','public.finalize_post_approved_media_bucket_service()','execute') then
    raise exception 'Browser role can execute an approved-media service operation';
  end if;
  if not has_function_privilege('service_role','public.resolve_post_approved_media_service(uuid)','execute') then
    raise exception 'Service role cannot resolve opaque approved media';
  end if;
end
$privileges$;

do $lifecycle$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona constant uuid:='05900000-0000-4000-8000-000000000199';
  v_legacy_draft constant uuid:='05900000-0000-4000-8000-000000000299';
  v_new_draft constant uuid:='06300000-0000-4000-8000-000000000299';
  v_legacy_hash constant text:=repeat('b',64);
  v_new_hash constant text:=repeat('c',64);
  v_legacy_path text;
  v_new_path text;
  v_legacy_url text;
  v_new_url text;
  v_source_path text;
  v_source_url text;
  v_source_asset uuid;
  v_legacy_id uuid;
  v_new_id uuid;
  v_count integer;
  v_ready jsonb;
  v_final jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  v_legacy_path:='owners/'||v_owner::text||'/sha256/bb/'||v_legacy_hash||'.png';
  v_new_path:='owners/'||v_owner::text||'/sha256/cc/'||v_new_hash||'.jpg';
  v_legacy_url:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/post-approved-media/'||v_legacy_path;
  v_new_url:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/post-approved-media/'||v_new_path;
  v_source_path:=v_owner::text||'/published/provenance/none/uploaded/'
    ||v_persona::text||'/composer/source/'||v_new_hash||'.jpg';
  v_source_url:='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'
    ||v_source_path;

  if public.approved_media_delivery_id_from_url(
    'https://media.mypersonas.online/approved/v1/11111111-1111-4111-8111-111111111111'
  ) is distinct from '11111111-1111-4111-8111-111111111111'::uuid then
    raise exception 'Canonical approved-media URL did not round-trip';
  end if;
  if public.approved_media_delivery_id_from_url(
      'https://media.mypersonas.online/approved/v1/11111111-1111-4111-8111-111111111111?x=1'
    ) is not null
    or public.approved_media_delivery_id_from_url(
      'https://media.mypersonas.online/approved/v1/11111111-1111-4111-8111-111111111111/'
    ) is not null then
    raise exception 'Non-canonical approved-media URL was accepted';
  end if;

  v_ready:=public.post_approved_media_release_readiness_service();
  if (v_ready->>'retryable_rows_missing_delivery')::integer<>1
     or coalesce((v_ready->>'ready_to_finalize')::boolean,false) then
    raise exception 'Legacy retryable snapshot did not block finalization: %',v_ready::text;
  end if;
  v_count:=public.backfill_post_approved_media_handles_service(10);
  if v_count<>1 then raise exception 'Legacy handle backfill count was %, expected 1',v_count; end if;
  select approved_fb_delivery_id into v_legacy_id from public.post_drafts
    where id=v_legacy_draft;
  if v_legacy_id is null or public.approved_media_delivery_url(v_legacy_id) like '%'||v_owner::text||'%' then
    raise exception 'Legacy approval did not receive an owner-opaque provider URL';
  end if;
  if not exists(select 1 from public.post_drafts draft where draft.id=v_legacy_draft
    and draft.approved_fb_media_sha256=v_legacy_hash
    and draft.approved_fb_media_path=v_legacy_path
    and draft.approved_fb_media_url=v_legacy_url) then
    raise exception 'Legacy approval hash/path/URL changed during opaque backfill';
  end if;

  insert into storage.objects(bucket_id,name,metadata) values (
    'post-approved-media',v_new_path,
    jsonb_build_object('size',15,'mimetype','image/jpeg')
  );
  v_new_id:=public.issue_post_approved_media_handle_service(
    v_owner,v_new_path,v_new_hash,'image/jpeg',15
  );
  if v_new_id is null or public.issue_post_approved_media_handle_service(
      v_owner,v_new_path,v_new_hash,'image/jpeg',15
    ) is distinct from v_new_id then
    raise exception 'Approved-media issuance was not idempotent';
  end if;
  if not exists(select 1 from public.resolve_post_approved_media_service(v_new_id) resolved
    where resolved.bucket='post-approved-media' and resolved.storage_path=v_new_path
      and resolved.mime_type='image/jpeg' and resolved.byte_size=15
      and resolved.content_sha256=v_new_hash) then
    raise exception 'Opaque approved-media resolver returned the wrong immutable object';
  end if;
  if exists(select 1 from public.resolve_post_approved_media_delivery_service(v_new_id)) then
    raise exception 'Unreferenced staged approved-media handle resolved publicly';
  end if;

  v_source_asset:=public.register_persona_media_asset_service(
    v_owner,v_persona,'image',v_source_path,v_source_url,'image/jpeg',15,
    'uploaded','none',v_new_hash,v_new_hash,'not_required','','',null,'source'
  );
  insert into public.post_drafts(
    id,owner,persona_id,status,targets,source_image_url,fb_image_url,ig_image_url,
    source_media_asset_id,fb_media_asset_id,ig_media_asset_id
  ) values (
    v_new_draft,v_owner,v_persona,'draft',array['facebook','instagram']::text[],
    v_source_url,v_source_url,v_source_url,v_source_asset,v_source_asset,v_source_asset
  );
  perform public.approve_and_schedule_post_draft_opaque(
    v_owner,v_new_draft,now()+interval '1 day','UTC','','','',
    array['facebook','instagram']::text[],v_new_url,v_new_url,
    v_new_hash,'image/jpeg',15,v_new_path,v_new_url,v_new_id,
    v_new_hash,'image/jpeg',15,v_new_path,v_new_url,v_new_id
  );
  if not exists(select 1 from public.post_drafts draft where draft.id=v_new_draft
    and draft.approved_fb_delivery_id=v_new_id
    and draft.approved_ig_delivery_id=v_new_id
    and draft.approved_fb_media_sha256=v_new_hash
    and draft.approved_ig_media_sha256=v_new_hash) then
    raise exception 'Opaque scheduling did not bind exact provider deliveries';
  end if;
  if not exists(select 1 from public.resolve_post_approved_media_delivery_service(v_new_id)) then
    raise exception 'Referenced immutable approved-media handle did not resolve for its provider';
  end if;

  begin
    update public.post_drafts set approved_fb_delivery_id=gen_random_uuid()
      where id=v_new_draft;
    raise exception 'Approved delivery mutation unexpectedly succeeded';
  exception when others then
    if sqlerrm='Approved delivery mutation unexpectedly succeeded' then raise; end if;
  end;

  begin
    perform public.finalize_post_approved_media_bucket_service();
    raise exception 'Finalizer unexpectedly ignored unconfirmed release controls';
  exception when others then
    if sqlerrm='Finalizer unexpectedly ignored unconfirmed release controls' then raise; end if;
  end;
  if not exists(select 1 from storage.buckets where id='post-approved-media' and public) then
    raise exception 'Expansion changed the approved-media bucket before manual finalization';
  end if;
  perform public.set_post_approved_media_release_controls_service(
    true,true,'disposable-063-runtime-fixture'
  );
  v_ready:=public.post_approved_media_release_readiness_service();
  if coalesce((v_ready->>'ready_to_finalize')::boolean,false) is not true
     or (v_ready->>'retryable_rows_missing_delivery')::integer<>0
     or (v_ready->>'delivery_mapping_mismatches')::integer<>0
     or (v_ready->>'active_handles_missing_storage')::integer<>0 then
    raise exception 'Approved-media release readiness was not exact: %',v_ready::text;
  end if;
  v_final:=public.finalize_post_approved_media_bucket_service();
  if coalesce((v_final->>'finalized')::boolean,false) is not true
     or exists(select 1 from storage.buckets where id='post-approved-media' and public) then
    raise exception 'Manual approved-media finalizer did not contract the bucket';
  end if;

  v_count:=public.revoke_post_approved_media_owner_service(v_owner);
  if v_count<>2 then raise exception 'Owner revocation count was %, expected 2',v_count; end if;
  if exists(select 1 from public.resolve_post_approved_media_service(v_legacy_id))
     or exists(select 1 from public.resolve_post_approved_media_service(v_new_id)) then
    raise exception 'Revoked approved-media handle still resolved';
  end if;
  delete from public.post_drafts where owner=v_owner;
  delete from public.post_approved_media_handles where owner=v_owner;
  if exists(select 1 from public.post_approved_media_handles where owner=v_owner) then
    raise exception 'Approved-media handle erasure did not complete';
  end if;
end
$lifecycle$;

set local role anon;
do $anon$
begin
  begin
    perform * from public.resolve_post_approved_media_service(
      '11111111-1111-4111-8111-111111111111'::uuid
    );
    raise exception 'Anon resolver call unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$anon$;
reset role;

rollback;
