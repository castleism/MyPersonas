-- This adversarial fixture is run in a disposable database and rolls back. The
-- same assertions may be run read-only in approved non-production after 062,
-- but the lifecycle portion below intentionally mutates only its seeded rows.
begin;

do $assert$
declare
  v_id constant uuid:='11111111-1111-4111-8111-111111111111';
  v_url text;
begin
  v_url:=public.public_media_delivery_url(v_id);
  if public.public_media_handle_from_url(v_url) is distinct from v_id then
    raise exception 'Exact opaque URL did not round-trip';
  end if;
  if public.public_media_handle_from_url(v_url||'?download=1') is not null
     or public.public_media_handle_from_url(v_url||'#x') is not null
     or public.public_media_handle_from_url(replace(v_url,'https://media.mypersonas.online','https://evil.example')) is not null
     or public.public_media_handle_from_url(replace(v_url,'/persona/v1/','/persona/v1//')) is not null then
    raise exception 'Malformed opaque URL was accepted';
  end if;
  if not public.is_public_media_delivery_reference_062(v_url)
     or not public.is_public_media_delivery_reference_062(v_url||'?download=1')
     or not public.is_public_media_delivery_reference_062(
       'https://nwsqyuucwzihruszocge.supabase.co/functions/v1/public-media/'||v_id::text)
     or not public.is_public_media_delivery_reference_062(
       'https://media.mypersonas.online/approved/v1/'||v_id::text)
     or not public.is_public_media_delivery_reference_062(
       'https://nwsqyuucwzihruszocge.supabase.co/functions/v1/approved-media/'||v_id::text) then
    raise exception 'Private media gateway spelling escaped the broad classifier';
  end if;
  if not public.is_persona_media_storage_reference_062(
       'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/sign/other-bucket/a.png')
     or not public.is_persona_media_storage_reference_062(
       'https://nwsqyuucwzihruszocge.supabase.co/storage%252fv1%252fobject%252fpublic%252fmedia%252fa.png')
     or not public.is_legacy_media_bucket_reference_062(
       'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/render/image/public/media/a.png') then
    raise exception 'Project or legacy media Storage spelling escaped classification';
  end if;
  if not public.is_external_reference_url_062('https://outside.example.test/item',false)
     or public.is_external_reference_url_062(v_url,false)
     or public.is_external_reference_url_062(
       'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/a.png',false) then
    raise exception 'External-reference predicate did not fail closed';
  end if;
  if has_table_privilege('anon','public.persona_public_media_handles','select')
     or has_table_privilege('authenticated','public.persona_public_media_handles','select') then
    raise exception 'Browser role can read the private opaque correlation map';
  end if;
  if has_function_privilege('anon','public.issue_persona_public_media_handle_service(uuid,boolean)','execute')
     or has_function_privilege('authenticated','public.issue_persona_public_media_handle_service(uuid,boolean)','execute')
     or has_function_privilege('anon','public.public_media_release_readiness_service()','execute')
     or has_function_privilege('authenticated','public.public_media_release_readiness_service()','execute') then
    raise exception 'Browser role can invoke an opaque media service operation';
  end if;
  if has_function_privilege('anon','public.resolve_public_media_service(uuid)','execute')
     or has_function_privilege('authenticated','public.resolve_public_media_service(uuid)','execute') then
    raise exception 'Browser role can invoke the private media resolver';
  end if;
  if not has_function_privilege('service_role','public.resolve_public_media_service(uuid)','execute') then
    raise exception 'Service role cannot invoke the private media resolver';
  end if;
end
$assert$;

-- Random syntactically valid UUIDs must never create attacker-selected limiter
-- rows. They may increment only the single global emergency counter.
do $rate_limit_cardinality$
declare v_before integer;v_after integer;v_i integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select count(*) into v_before from public.public_media_rate_limits_062
    where scope like 'asset:%';
  for v_i in 1..10000 loop
    perform public.consume_public_media_rate_limit_service(gen_random_uuid());
  end loop;
  select count(*) into v_after from public.public_media_rate_limits_062
    where scope like 'asset:%';
  if v_after<>v_before then
    raise exception 'Random UUID flood grew per-asset limiter cardinality: % -> %',v_before,v_after;
  end if;
  if (select count(*) from public.public_media_rate_limits_062 where scope='global')<>1 then
    raise exception 'Random UUID flood did not remain bounded to one global limiter row';
  end if;
  delete from public.public_media_rate_limits_062;
end
$rate_limit_cardinality$;

-- The fixture contains one pre-062 legacy `media` navigation value. It must be
-- counted, never auto-rewritten, and owner remediation must clear both gates.
do $legacy_external_inventory$
declare v_result jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  v_result:=public.public_media_release_readiness_service();
  if coalesce((v_result->>'blocked_external_reference_violations')::integer,0)<>1
     or coalesce((v_result->>'legacy_media_bucket_references')::integer,0)<>1 then
    raise exception 'Legacy external/media inventory was not quantified: %',v_result;
  end if;
  delete from public.persona_links
  where persona_id='05900000-0000-4000-8000-000000000199'
    and url like '%/storage/v1/object/public/media/%';
  v_result:=public.public_media_release_readiness_service();
  if coalesce((v_result->>'blocked_external_reference_violations')::integer,-1)<>0
     or coalesce((v_result->>'legacy_media_bucket_references')::integer,-1)<>0 then
    raise exception 'Owner-remediated external/media inventory did not clear: %',v_result;
  end if;
end
$legacy_external_inventory$;

do $external_forward_guards$
declare
  v_persona constant uuid:='05900000-0000-4000-8000-000000000199';
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_album uuid;v_raw text:=
    'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/owner/file.png';
begin
  insert into public.persona_links(persona_id,url)
  values(v_persona,'https://outside.example.test/profile');
  begin
    insert into public.persona_links(persona_id,url) values(v_persona,v_raw);
    raise exception 'Unsafe persona link unexpectedly passed';
  exception when others then
    if sqlerrm='Unsafe persona link unexpectedly passed' then raise; end if;
  end;

  insert into public.albums(persona_id) values(v_persona) returning id into v_album;
  insert into public.album_items(album_id,thumb_url,link_url)
  values(v_album,'','https://outside.example.test/album');
  begin
    insert into public.album_items(album_id,thumb_url,link_url) values(v_album,'',v_raw);
    raise exception 'Unsafe album destination unexpectedly passed';
  exception when others then
    if sqlerrm='Unsafe album destination unexpectedly passed' then raise; end if;
  end;

  insert into public.persona_page_layouts(persona_id,owner,layout) values(
    v_persona,v_owner,
    '{"version":1,"order":[],"cards":{},"widgets":[{"id":"safe","kind":"link","url":"https://outside.example.test/widget"}]}'::jsonb
  );
  begin
    update public.persona_page_layouts set layout=
      jsonb_set(layout,'{widgets,0,url}',to_jsonb(v_raw),false)
    where persona_id=v_persona;
    raise exception 'Unsafe layout destination unexpectedly passed';
  exception when others then
    if sqlerrm='Unsafe layout destination unexpectedly passed' then raise; end if;
  end;

  insert into public.affiliate_products(owner,title,affiliate_url,product_url,status)
  values(v_owner,'Safe product','https://outside.example.test/buy',
    'https://outside.example.test/product','active');
  begin
    insert into public.affiliate_products(owner,title,affiliate_url,product_url,status)
    values(v_owner,'Unsafe product',v_raw,'','active');
    raise exception 'Unsafe affiliate destination unexpectedly passed';
  exception when others then
    if sqlerrm='Unsafe affiliate destination unexpectedly passed' then raise; end if;
  end;

  update public.personas set music_url='https://outside.example.test/audio',
    live_url='https://outside.example.test/live' where id=v_persona;
  begin
    update public.personas set music_url=v_raw where id=v_persona;
    raise exception 'Unsafe music destination unexpectedly passed';
  exception when others then
    if sqlerrm='Unsafe music destination unexpectedly passed' then raise; end if;
  end;
  begin
    update public.personas set live_url=
      'https://media.mypersonas.online/approved/v1/11111111-1111-4111-8111-111111111111'
    where id=v_persona;
    raise exception 'Reserved media destination unexpectedly passed';
  exception when others then
    if sqlerrm='Reserved media destination unexpectedly passed' then raise; end if;
  end;
end
$external_forward_guards$;

do $lifecycle$
declare
  v_owner constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona constant uuid:='05900000-0000-4000-8000-000000000199';
  v_hash constant text:=repeat('a',64);
  v_asset uuid;
  v_public_id uuid;
  v_rotated_id uuid;
  v_url text;
  v_rotated_url text;
  v_provenance text;
  v_count integer;
  v_result jsonb;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.set_public_media_waf_attestation_service(true,'disposable-runtime-fixture');

  v_asset:=public.register_persona_media_asset_service(
    v_owner,v_persona,'image',
    v_owner::text||'/published/provenance/none/uploaded/'||v_persona::text
      ||'/profile/avatar/'||v_hash||'.png',
    'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'
      ||v_owner::text||'/published/provenance/none/uploaded/'||v_persona::text
      ||'/profile/avatar/'||v_hash||'.png',
    'image/png',123,'uploaded','none',v_hash,v_hash,
    'not_required','','',null,'avatar'
  );

  -- A canonical active asset without a handle blocks private-bucket cutover.
  begin
    perform public.finalize_opaque_public_media_bucket_service();
    raise exception 'Finalization unexpectedly accepted a missing active handle';
  exception when others then
    if sqlerrm='Finalization unexpectedly accepted a missing active handle' then raise; end if;
  end;

  v_public_id:=public.issue_persona_public_media_handle_service(v_asset,false);
  v_url:=public.public_media_delivery_url(v_public_id);
  if v_public_id is null or public.public_media_handle_from_url(v_url) is distinct from v_public_id then
    raise exception 'Service issuance did not produce an exact opaque URL';
  end if;
  if public.issue_persona_public_media_handle_service(v_asset,false) is distinct from v_public_id then
    raise exception 'Non-rotating issuance was not idempotent';
  end if;

  select count(*) into v_count from public.resolve_public_media_service(v_public_id);
  if v_count<>0 then raise exception 'Unreferenced or unreviewed asset resolved'; end if;

  update public.personas persona set avatar_url=v_url where persona.id=v_persona;
  if not exists(select 1 from public.personas persona
    where persona.id=v_persona and persona.avatar_media_asset_id=v_asset) then
    raise exception 'Opaque page reference did not bind to its asset';
  end if;
  select asset.provenance_sha256 into v_provenance
    from public.persona_media_assets asset where asset.id=v_asset;
  update public.personas persona set publication_state='published',published_revision=publication_revision
    where persona.id=v_persona;
  insert into public.persona_publication_reviews(
    persona_id,owner,review_state,reviewed_revision,readiness_snapshot
  ) select persona.id,persona.owner,'published',persona.publication_revision,
    jsonb_build_object('review_manifest',jsonb_build_object('opaque_media',jsonb_build_object(
      'assets',jsonb_build_array(jsonb_build_object(
        'consumer','profile','slot','avatar','asset_id',v_asset,
        'public_id',v_public_id,'provenance_sha256',v_provenance
      ))
    )))
    from public.personas persona where persona.id=v_persona;

  select count(*) into v_count from public.resolve_public_media_service(v_public_id);
  if v_count<>1 then raise exception 'Exact current reviewed asset did not resolve'; end if;
  if exists(select 1 from public.resolve_public_media_service(v_public_id) resolved
    where resolved.bucket<>'persona-media' or resolved.storage_path like '%..%'
      or resolved.mime_type<>'image/png' or resolved.byte_size<>123
      or resolved.content_sha256<>v_hash) then
    raise exception 'Resolver returned an unexpected or unbounded target';
  end if;

  update public.persona_publication_reviews review
  set readiness_snapshot=jsonb_set(readiness_snapshot,
    '{review_manifest,opaque_media,assets,0,slot}','"banner"'::jsonb,false)
  where review.persona_id=v_persona;
  select count(*) into v_count from public.resolve_public_media_service(v_public_id);
  if v_count<>0 then raise exception 'Wrong reviewed slot resolved'; end if;
  update public.persona_publication_reviews review
  set readiness_snapshot=jsonb_set(readiness_snapshot,
    '{review_manifest,opaque_media,assets,0,slot}','"avatar"'::jsonb,false)
  where review.persona_id=v_persona;

  update public.persona_publication_reviews review
  set readiness_snapshot=jsonb_set(readiness_snapshot,
    '{review_manifest,opaque_media,assets,0,provenance_sha256}',to_jsonb(repeat('0',64)),false)
  where review.persona_id=v_persona;
  select count(*) into v_count from public.resolve_public_media_service(v_public_id);
  if v_count<>0 then raise exception 'Wrong reviewed provenance resolved'; end if;
  update public.persona_publication_reviews review
  set readiness_snapshot=jsonb_set(readiness_snapshot,
    '{review_manifest,opaque_media,assets,0,provenance_sha256}',to_jsonb(v_provenance),false)
  where review.persona_id=v_persona;

  update public.personas persona set avatar_url='' where persona.id=v_persona;
  select count(*) into v_count from public.resolve_public_media_service(v_public_id);
  if v_count<>0 then raise exception 'Reviewed handle resolved without its exact current reference'; end if;
  update public.personas persona set avatar_url=v_url where persona.id=v_persona;

  v_result:=public.rotate_persona_public_media_handle_service(v_asset);
  v_rotated_id:=(v_result->>'public_id')::uuid;
  v_rotated_url:=v_result->>'public_url';
  if v_rotated_id is null or v_rotated_id=v_public_id
     or v_rotated_url<>public.public_media_delivery_url(v_rotated_id) then
    raise exception 'Rotation did not issue and bind a fresh handle';
  end if;
  select count(*) into v_count from public.resolve_public_media_service(v_public_id);
  if v_count<>0 then raise exception 'Rotated handle still resolved'; end if;
  select count(*) into v_count from public.resolve_public_media_service(v_rotated_id);
  if v_count<>0 then raise exception 'New handle resolved before exact re-review'; end if;

  update public.persona_publication_reviews review
  set readiness_snapshot=jsonb_set(readiness_snapshot,
    '{review_manifest,opaque_media,assets,0,public_id}',to_jsonb(v_rotated_id::text),false)
  where review.persona_id=v_persona;
  select count(*) into v_count from public.resolve_public_media_service(v_rotated_id);
  if v_count<>1 then raise exception 'Re-reviewed rotated handle did not resolve'; end if;

  update public.persona_media_assets asset set status='flagged' where asset.id=v_asset;
  select count(*) into v_count from public.resolve_public_media_service(v_rotated_id);
  if v_count<>0 then raise exception 'Flagged asset still resolved'; end if;
  if exists(select 1 from public.persona_public_media_handles handle
    where handle.asset_id=v_asset and handle.state='active') then
    raise exception 'Flagging did not revoke the active handle';
  end if;

  update public.personas persona set avatar_url='',publication_state='draft'
    where persona.id=v_persona;

  v_result:=public.finalize_opaque_public_media_bucket_service();
  if coalesce((v_result->>'private')::boolean,false) is not true
     or exists(select 1 from storage.buckets bucket
       where bucket.id='persona-media' and bucket.public) then
    raise exception 'Finalization did not make the bucket private';
  end if;
end
$lifecycle$;

set local role anon;
do $assert$
begin
  begin
    perform * from public.resolve_public_media_service(
      '11111111-1111-4111-8111-111111111111'::uuid
    );
    raise exception 'anon resolver call unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$assert$;
reset role;

rollback;
