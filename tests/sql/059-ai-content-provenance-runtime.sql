\set ON_ERROR_STOP on

insert into public.profiles(id) values ('05900000-0000-4000-8000-000000000001');
insert into public.ai_backends(id,owner) values
  ('05900000-0000-4000-8000-000000000010','05900000-0000-4000-8000-000000000001');
insert into public.personas(id,owner,handle) values
  ('05900000-0000-4000-8000-000000000101','05900000-0000-4000-8000-000000000001','provenance-test'),
  ('05900000-0000-4000-8000-000000000102','05900000-0000-4000-8000-000000000001','provenance-test-second');

select set_config('request.jwt.claim.sub','05900000-0000-4000-8000-000000000099',false);
select set_config('request.jwt.claim.role','authenticated',false);
do $$
declare manifest jsonb;
begin
  manifest:=public.persona_publication_review_manifest('05900000-0000-4000-8000-000000000199');
  if (manifest->'ai_provenance'->>'complete')::boolean is not true
     or (manifest->'ai_provenance'->>'grandfathered_external_assets')::integer<>1
     or (manifest->'ai_provenance'->>'blocked_external_assets')::integer<>0 then
    raise exception 'Pre-migration external media was not preserved as an explicit one-time grandfather';end if;
end
$$;

select set_config('request.jwt.claim.sub','05900000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claim.role','service_role',false);

do $$
declare asset_id uuid;second_asset_id uuid;generated_id uuid;event_id uuid;
  source_hash text:=repeat('a',64);generated_source text:=repeat('b',64);generated_final text:=repeat('c',64);
begin
  asset_id:=public.register_persona_media_asset_service(
    '05900000-0000-4000-8000-000000000001','05900000-0000-4000-8000-000000000101',
    'image','05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||source_hash||'.png',
    'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||source_hash||'.png',
    'image/png',1234,'uploaded','none',source_hash,source_hash,'not_required','','',null,'avatar_url'
  );
  if asset_id is null then raise exception 'No-AI asset was not registered';end if;
  second_asset_id:=public.register_persona_media_asset_service(
    '05900000-0000-4000-8000-000000000001','05900000-0000-4000-8000-000000000102',
    'image','05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000102/profile/avatar/'||source_hash||'.png',
    'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000102/profile/avatar/'||source_hash||'.png',
    'image/png',1234,'uploaded','none',source_hash,source_hash,'not_required','','',null,'avatar_url'
  );
  if second_asset_id is null or second_asset_id=asset_id then
    raise exception 'Persona-scoped content paths did not prevent a cross-persona collision';end if;

  insert into public.ai_media_generation_events(
    id,owner,persona_id,backend_id,provider,model,prompt_sha256,output_sha256,output_mime
  ) values (
    '05900000-0000-4000-8000-000000000201','05900000-0000-4000-8000-000000000001',
    '05900000-0000-4000-8000-000000000101','05900000-0000-4000-8000-000000000010',
    'google','gemini-test',repeat('d',64),generated_source,'image/png'
  ) returning id into event_id;
  generated_id:=public.register_persona_media_asset_service(
    '05900000-0000-4000-8000-000000000001','05900000-0000-4000-8000-000000000101',
    'image','05900000-0000-4000-8000-000000000001/published/provenance/generated/generated/05900000-0000-4000-8000-000000000101/profile/banner/05900000-0000-4000-8000-000000000201/'||generated_final||'.png',
    'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/generated/generated/05900000-0000-4000-8000-000000000101/profile/banner/05900000-0000-4000-8000-000000000201/'||generated_final||'.png',
    'image/png',4321,'site_generated','generated',generated_source,generated_final,
    'system_applied','mypersonas-ai-watermark-v1','c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2',
    event_id,'banner_url'
  );
  if generated_id is null then raise exception 'Generated asset was not registered';end if;
  if not exists(select 1 from public.ai_media_generation_events event
    where event.id=event_id and event.derivative_count=1) then
    raise exception 'Generation evidence was not atomically consumed with registration';end if;
end
$$;

insert into public.ai_media_generation_events(
  id,owner,persona_id,backend_id,provider,model,prompt_sha256,output_sha256,
  output_mime,expires_at,derivative_count
) values (
  '05900000-0000-4000-8000-000000000202','05900000-0000-4000-8000-000000000001',
  '05900000-0000-4000-8000-000000000101','05900000-0000-4000-8000-000000000010',
  'google','expired-test',repeat('d',64),repeat('e',64),'image/png',now()-interval '1 minute',1
);
do $$
declare denied boolean:=false;
begin
  begin perform public.register_persona_media_asset_service(
    '05900000-0000-4000-8000-000000000001','05900000-0000-4000-8000-000000000101',
    'image','05900000-0000-4000-8000-000000000001/published/provenance/generated/generated/05900000-0000-4000-8000-000000000101/profile/expired/'||repeat('f',64)||'.png',
    'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/generated/generated/05900000-0000-4000-8000-000000000101/profile/expired/'||repeat('f',64)||'.png',
    'image/png',1234,'site_generated','generated',repeat('e',64),repeat('f',64),
    'system_applied','mypersonas-ai-watermark-v1','c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2',
    '05900000-0000-4000-8000-000000000202','expired_test'
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Expired generation evidence remained registerable';end if;
end
$$;

update public.personas set
  avatar_url='https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||repeat('a',64)||'.png',
  banner_url='https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/generated/generated/05900000-0000-4000-8000-000000000101/profile/banner/05900000-0000-4000-8000-000000000201/'||repeat('c',64)||'.png'
where id='05900000-0000-4000-8000-000000000101';

insert into public.posts(persona_id,media_url) values(
  '05900000-0000-4000-8000-000000000101',
  'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||repeat('a',64)||'.png'
);
insert into public.post_drafts(id,owner,persona_id,source_image_url,fb_image_url,ig_image_url,x_image_url,targets,media_provenance_required)
values(
  '05900000-0000-4000-8000-000000000301',
  '05900000-0000-4000-8000-000000000001','05900000-0000-4000-8000-000000000101',
  'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||repeat('a',64)||'.png',
  'https://project.test/storage/v1/render/image/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||repeat('a',64)||'.png?width=1200&height=628',
  'https://project.test/storage/v1/render/image/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||repeat('a',64)||'.png?width=1080&height=1080',
  '','{facebook,instagram}',true
);
update public.post_drafts set status='scheduled'
where id='05900000-0000-4000-8000-000000000301';

do $$
declare manifest jsonb;denied boolean:=false;flag_bypass boolean:=false;
begin
  if exists(select 1 from public.post_drafts
    where id='05900000-0000-4000-8000-000000000299'
      and media_provenance_required is not true) then
    raise exception 'Existing post draft was not backfilled to require provenance';end if;
  begin
    update public.post_drafts set media_provenance_required=false
    where id='05900000-0000-4000-8000-000000000299';
  exception when others then flag_bypass:=true;end;
  if not flag_bypass then raise exception 'Post draft provenance requirement remained mutable false';end if;
  if exists(select 1 from public.personas where id='05900000-0000-4000-8000-000000000101'
    and (avatar_media_asset_id is null or banner_media_asset_id is null)) then
    raise exception 'Persona media references were not bound';end if;
  if exists(select 1 from public.posts where media_asset_id is null) then
    raise exception 'Post media reference was not bound';end if;
  if exists(select 1 from public.post_drafts where id='05900000-0000-4000-8000-000000000301' and (source_media_asset_id is null
    or fb_media_asset_id is null or ig_media_asset_id is null
    or approved_fb_provenance_sha256='' or approved_ig_provenance_sha256='')) then
    raise exception 'Approved draft did not freeze exact provenance';end if;
  manifest:=public.persona_publication_review_manifest('05900000-0000-4000-8000-000000000101');
  if manifest->>'schema_version'<>'2' or (manifest->'ai_provenance'->>'complete')::boolean is not true then
    raise exception 'Publication manifest did not include complete AI provenance';end if;
  begin
    update public.persona_media_assets set content_sha256=repeat('e',64)
    where id=(select id from public.persona_media_assets where declaration_source<>'legacy' order by id limit 1);
  exception when others then denied:=true;end;
  if not denied then raise exception 'Immutable provenance was mutable';end if;
end
$$;

do $$
declare denied_ai_render boolean:=false;denied_unsafe_render boolean:=false;
  denied_external_target boolean:=false;manifest jsonb;
begin
  begin
    update public.personas set banner_url=
      'https://project.test/storage/v1/render/image/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/generated/generated/05900000-0000-4000-8000-000000000101/profile/banner/05900000-0000-4000-8000-000000000201/'||repeat('c',64)||'.png?width=1200&height=628'
    where id='05900000-0000-4000-8000-000000000101';
  exception when others then denied_ai_render:=true;end;
  if not denied_ai_render then raise exception 'AI-used render URL was normalized to its source asset';end if;

  begin
    update public.personas set avatar_url=
      'https://project.test/storage/v1/render/image/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||repeat('a',64)||'.png?width=9999&height=628'
    where id='05900000-0000-4000-8000-000000000101';
  exception when others then denied_unsafe_render:=true;end;
  if not denied_unsafe_render then raise exception 'Unbounded no-AI render URL was accepted';end if;

  insert into public.post_drafts(
    id,owner,persona_id,source_image_url,fb_image_url,targets
  ) values (
    '05900000-0000-4000-8000-000000000302',
    '05900000-0000-4000-8000-000000000001','05900000-0000-4000-8000-000000000101',
    'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/generated/generated/05900000-0000-4000-8000-000000000101/profile/banner/05900000-0000-4000-8000-000000000201/'||repeat('c',64)||'.png',
    'https://cdn.example.test/unregistered-ai-target.png','{facebook}'
  );
  begin
    update public.post_drafts set status='scheduled'
    where id='05900000-0000-4000-8000-000000000302';
  exception when others then denied_external_target:=true;end;
  if not denied_external_target then raise exception 'Unregistered external target inherited an AI asset binding';end if;

  insert into public.post_drafts(
    id,owner,persona_id,source_image_url,fb_image_url,targets
  ) values (
    '05900000-0000-4000-8000-000000000303',
    '05900000-0000-4000-8000-000000000001','05900000-0000-4000-8000-000000000101',
    'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||repeat('a',64)||'.png',
    'https://project.test/storage/v1/render/image/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/none/uploaded/05900000-0000-4000-8000-000000000101/profile/avatar/'||repeat('a',64)||'.png?width=1200&height=628',
    '{facebook}'
  );
  update public.post_drafts set
    fb_image_url='https://project.test/storage/v1/object/public/post-approved-media/owners/test/sha256/'||repeat('e',64)||'.png',
    approved_fb_media_url='https://project.test/storage/v1/object/public/post-approved-media/owners/test/sha256/'||repeat('e',64)||'.png',
    approved_fb_media_sha256=repeat('e',64),status='scheduled'
  where id='05900000-0000-4000-8000-000000000303';
  update public.post_drafts set status='publishing'
  where id='05900000-0000-4000-8000-000000000303';

  insert into public.post_drafts(
    id,owner,persona_id,source_image_url,fb_image_url,targets
  ) values (
    '05900000-0000-4000-8000-000000000304',
    '05900000-0000-4000-8000-000000000001','05900000-0000-4000-8000-000000000101',
    'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/generated/generated/05900000-0000-4000-8000-000000000101/profile/banner/05900000-0000-4000-8000-000000000201/'||repeat('c',64)||'.png',
    'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/generated/generated/05900000-0000-4000-8000-000000000101/profile/banner/05900000-0000-4000-8000-000000000201/'||repeat('c',64)||'.png',
    '{facebook}'
  );
  denied_ai_render:=false;
  begin
    update public.post_drafts set
      fb_image_url='https://project.test/storage/v1/object/public/post-approved-media/owners/test/sha256/'||repeat('d',64)||'.png',
      approved_fb_media_url='https://project.test/storage/v1/object/public/post-approved-media/owners/test/sha256/'||repeat('d',64)||'.png',
      approved_fb_media_sha256=repeat('d',64),status='scheduled'
    where id='05900000-0000-4000-8000-000000000304';
  exception when others then denied_ai_render:=true;end;
  if not denied_ai_render then raise exception 'AI approval snapshot changed registered final bytes';end if;

  update public.personas set feed_img_url='/media/unregistered-local.png'
  where id='05900000-0000-4000-8000-000000000101';
  manifest:=public.persona_publication_review_manifest('05900000-0000-4000-8000-000000000101');
  if (manifest->'ai_provenance'->>'complete')::boolean is true
     or (manifest->'ai_provenance'->>'invalid_new_assets')::integer<1 then
    raise exception 'Unbound local media did not fail publication-manifest completeness';end if;

  update public.personas set feed_img_url='https://cdn.example.test/legacy-embed.png'
  where id='05900000-0000-4000-8000-000000000101';
  manifest:=public.persona_publication_review_manifest('05900000-0000-4000-8000-000000000101');
  if (manifest->'ai_provenance'->>'complete')::boolean is true
     or (manifest->'ai_provenance'->>'external_unverified_assets')::integer<>1
     or (manifest->'ai_provenance'->>'blocked_external_assets')::integer<>1 then
    raise exception 'New external media did not fail closed as explicitly unverified';end if;
  update public.personas set feed_img_url=''
  where id='05900000-0000-4000-8000-000000000101';
end
$$;

set role authenticated;
select set_config('request.jwt.claim.role','authenticated',false);
update public.personas set publication_revision=7,published_revision=7,
  publication_state='published'
where id='05900000-0000-4000-8000-000000000101';
select public.set_persona_media_asset_status(
  (select id from public.persona_media_assets
   where persona_id='05900000-0000-4000-8000-000000000101'
     and ai_use='none'
   order by created_at,id limit 1),'archived'
);
do $$begin
  if not exists(select 1 from public.personas
    where id='05900000-0000-4000-8000-000000000101'
      and publication_revision=8 and publication_state='draft') then
    raise exception 'Asset status change did not invalidate the published revision';end if;
end$$;
do $$
declare denied_rpc boolean:=false;denied_storage boolean:=false;denied_registry boolean:=false;
begin
  begin perform public.add_media_asset(
    '05900000-0000-4000-8000-000000000101','image','','','','','uploaded','',null,'{}','{}'
  );exception when insufficient_privilege then denied_rpc:=true;end;
  if not denied_rpc then raise exception 'Generic browser media RPC remained executable';end if;
  begin insert into public.persona_media_assets(owner,persona_id) values(
    '05900000-0000-4000-8000-000000000001','05900000-0000-4000-8000-000000000101'
  );exception when insufficient_privilege then denied_registry:=true;end;
  if not denied_registry then raise exception 'Authenticated browser retained direct provenance-registry writes';end if;
  begin insert into storage.objects(bucket_id,name) values(
    'persona-media','05900000-0000-4000-8000-000000000001/published/bypass.png'
  );exception when insufficient_privilege then denied_storage:=true;when check_violation then denied_storage:=true;end;
  if not denied_storage then raise exception 'Authenticated browser retained direct persona-media writes';end if;
end
$$;
reset role;

select set_config('request.jwt.claim.role','service_role',false);
do $$
declare denied boolean:=false;asset public.persona_media_assets%rowtype;
begin
  select item.* into asset from public.persona_media_assets item
  where item.persona_id='05900000-0000-4000-8000-000000000101'
    and item.ai_use='none' and item.status='archived' limit 1;
  if asset.id is null then raise exception 'Archived retry fixture was not found';end if;
  begin perform public.register_persona_media_asset_service(
    asset.owner,asset.persona_id,asset.media_type,asset.storage_path,asset.public_url,
    asset.mime_type,asset.byte_size,asset.origin,asset.ai_use,asset.source_sha256,
    asset.content_sha256,asset.watermark_state,asset.watermark_version,
    asset.watermark_asset_sha256,asset.generation_event_id,asset.rendition
  );exception when others then denied:=true;end;
  if not denied then raise exception 'Archived media was returned as a usable retry';end if;
end
$$;

do $$
declare denied boolean:=false;
begin
  begin update public.personas set avatar_url=
    'https://project.test/storage/v1/object/public/persona-media/05900000-0000-4000-8000-000000000001/published/provenance/generated/uploaded/05900000-0000-4000-8000-000000000101/missing/'||repeat('f',64)||'.png'
    where id='05900000-0000-4000-8000-000000000101';
  exception when others then denied:=true;end;
  if not denied then raise exception 'A canonical URL without registry authority was accepted';end if;
end
$$;

select 'AI provenance migration 059 runtime assertions passed' as result;
