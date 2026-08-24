\set ON_ERROR_STOP on

begin;

do $isolated_staging_environment$
declare v_owner constant uuid:='06400000-0000-4000-8000-000000000001';
  v_path text:=lower(v_owner::text)||'/legacy/image.png';
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.configure_media_environment_service(
    'staging','https://abcdefghijklmnopqrst.supabase.co',
    'https://media-staging.mypersonas.online','isolated legacy-media review'
  );
  perform public.lock_media_environment_service(
    'staging','https://abcdefghijklmnopqrst.supabase.co',
    'https://media-staging.mypersonas.online','isolated legacy-media lock'
  );
  if public.legacy_media_exact_path_064(
      'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/media/'||v_path
    ) is distinct from v_path
    or public.legacy_media_exact_path_064(
      'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/'||v_path
    ) is not null then
    raise exception 'Legacy intake did not use only its staging Storage origin';
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
    'https://media.mypersonas.online','disposable legacy-media review'
  );
  perform public.lock_media_environment_service(
    'production','https://nwsqyuucwzihruszocge.supabase.co',
    'https://media.mypersonas.online','disposable legacy-media lock'
  );
end
$media_environment$;

do $privileges$
begin
  if has_table_privilege('anon','public.legacy_media_sources','select')
     or has_table_privilege('authenticated','public.legacy_media_sources','select')
     or has_table_privilege('anon','public.legacy_media_references','select')
     or has_table_privilege('authenticated','public.legacy_media_references','select')
     or has_table_privilege('anon','public.legacy_media_remediation_rate_limits_064','select')
     or has_table_privilege('authenticated','public.legacy_media_remediation_rate_limits_064','select') then
    raise exception 'A browser role can read legacy media remediation state';
  end if;
  if has_function_privilege('anon','public.inventory_legacy_media_references_service(uuid,integer)','execute')
     or has_function_privilege('authenticated','public.inventory_legacy_media_references_service(uuid,integer)','execute')
     or has_function_privilege('anon','public.list_legacy_media_references_service(uuid,uuid,integer)','execute')
     or has_function_privilege('authenticated','public.list_legacy_media_references_service(uuid,uuid,integer)','execute')
     or has_function_privilege('anon','public.resolve_legacy_media_preview_service(uuid,uuid)','execute')
     or has_function_privilege('authenticated','public.resolve_legacy_media_preview_service(uuid,uuid)','execute') then
    raise exception 'A browser role can execute a legacy media service RPC';
  end if;
  if not has_function_privilege('service_role','public.inventory_legacy_media_references_service(uuid,integer)','execute')
     or not has_function_privilege('service_role','public.list_legacy_media_references_service(uuid,uuid,integer)','execute')
     or not has_function_privilege('service_role','public.resolve_legacy_media_preview_service(uuid,uuid)','execute') then
    raise exception 'The service role is missing a legacy media RPC';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class
    where oid='public.legacy_media_sources'::regclass)
     or not (select relrowsecurity from pg_catalog.pg_class
    where oid='public.legacy_media_references'::regclass) then
    raise exception 'Legacy media remediation RLS is not enabled';
  end if;
end
$privileges$;

do $lifecycle$
declare
  v_owner_a constant uuid:='05900000-0000-4000-8000-000000000099';
  v_persona_a constant uuid:='05900000-0000-4000-8000-000000000199';
  v_owner_b constant uuid:='06400000-0000-4000-8000-000000000099';
  v_persona_b constant uuid:='06400000-0000-4000-8000-000000000299';
  v_prefix constant text:=
    'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/';
  v_cross_url text:=
    'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/'||
    '06400000-0000-4000-8000-000000000099/1720000000008-secret.png';
  v_summary jsonb;v_item uuid;v_cross_item uuid;v_owner_b_item uuid;
  v_resolution record;v_count integer;v_hash text:=repeat('a',64);
begin
  perform set_config('request.jwt.claim.role','service_role',true);

  if public.legacy_media_exact_path_064(v_prefix||
      '05900000-0000-4000-8000-000000000099/1720000000000-shared.png')
      is distinct from
      '05900000-0000-4000-8000-000000000099/1720000000000-shared.png' then
    raise exception 'Exact legacy media URL was rejected';
  end if;
  if public.legacy_media_exact_path_064(v_prefix||
      '05900000-0000-4000-8000-000000000099/../secret.png') is not null
     or public.legacy_media_exact_path_064(v_prefix||
      '05900000-0000-4000-8000-000000000099/encoded%2epng') is not null
     or public.legacy_media_exact_path_064(v_prefix||
      '05900000-0000-4000-8000-000000000099/file.png?download=1') is not null
     or public.legacy_media_exact_path_064(replace(v_prefix,'https://','http://')||
      '05900000-0000-4000-8000-000000000099/file.png') is not null
     or public.legacy_media_exact_path_064(replace(v_prefix,'object/public','render/image/public')||
      '05900000-0000-4000-8000-000000000099/file.png') is not null then
    raise exception 'A noncanonical legacy media URL was accepted';
  end if;

  v_summary:=public.inventory_legacy_media_references_service(v_owner_a,100);
  if (v_summary->>'references')::integer<>12
     or (v_summary->>'previewable')::integer<>9
     or (v_summary->>'blocked')::integer<>3
     or (v_summary->>'missing')::integer<>2
     or (v_summary->>'stale')::integer<>0 then
    raise exception 'Owner A inventory summary was not exact: %',v_summary::text;
  end if;
  if (select count(*) from public.legacy_media_sources where owner=v_owner_a)<>8
     or (select count(*) from public.legacy_media_references where owner=v_owner_a)<>12 then
    raise exception 'Owner A inventory did not deduplicate exact source objects';
  end if;
  if exists(select 1 from public.legacy_media_sources source
    where source.owner=v_owner_a and split_part(source.storage_path,'/',1)<>v_owner_a::text) then
    raise exception 'Cross-owner object was persisted as an owner A source';
  end if;
  if exists(select 1 from public.legacy_media_references reference
    where reference.owner=v_owner_a and reference.consumer='album_item'
      and reference.row_id='06400000-0000-4000-8000-000000002010') then
    raise exception 'Noncanonical render URL entered automatic remediation';
  end if;

  -- Repeating inventory preserves item ids and preview metadata/source groups.
  v_summary:=public.inventory_legacy_media_references_service(v_owner_a,100);
  if (select count(*) from public.legacy_media_sources where owner=v_owner_a)<>8
     or (select count(*) from public.legacy_media_references where owner=v_owner_a)<>12 then
    raise exception 'Repeated inventory was not idempotent';
  end if;

  v_summary:=public.inventory_legacy_media_references_service(v_owner_b,100);
  if (v_summary->>'references')::integer<>2
     or (v_summary->>'previewable')::integer<>2
     or (v_summary->>'blocked')::integer<>1 then
    raise exception 'Owner B sentinel inventory was not exact: %',v_summary::text;
  end if;
  select reference.id into v_owner_b_item
  from public.legacy_media_references reference
  where reference.owner=v_owner_b order by reference.id limit 1;

  select count(*) into v_count
  from public.list_legacy_media_references_service(v_owner_a,null,100) listed;
  if v_count<>12 then raise exception 'Safe list returned % rows, expected 12',v_count; end if;
  if exists(select 1 from public.list_legacy_media_references_service(v_owner_a,null,100) listed
    where listed.persona_id=v_persona_b) then
    raise exception 'Owner A safe list exposed owner B persona state';
  end if;
  if exists(select 1 from public.list_legacy_media_references_service(
    v_owner_a,v_owner_b_item,100)) then
    raise exception 'A foreign cursor could page through owner A inventory';
  end if;
  if not exists(select 1
    from public.list_legacy_media_references_service(v_owner_a,null,100) listed
    where listed.consumer='persona' and listed.slot='avatar'
      and listed.shared_reference_count=2 and listed.can_preview) then
    raise exception 'Safe list lost source grouping or previewability';
  end if;

  select reference.id into v_cross_item
  from public.legacy_media_references reference
  where reference.owner=v_owner_a and reference.consumer='persona'
    and reference.slot='feed_header';
  if not exists(select 1 from public.legacy_media_references reference
      where reference.id=v_cross_item and reference.state='blocked_cross_owner'
        and reference.source_id is null)
     or exists(select 1 from public.resolve_legacy_media_preview_service(
      v_owner_a,v_cross_item)) then
    raise exception 'Cross-owner reference became previewable';
  end if;

  select reference.id into v_item
  from public.legacy_media_references reference
  where reference.owner=v_owner_a and reference.consumer='persona'
    and reference.slot='avatar';
  select * into v_resolution
  from public.resolve_legacy_media_preview_service(v_owner_a,v_item);
  if v_resolution.bucket<>'media'
     or v_resolution.storage_path<>
       '05900000-0000-4000-8000-000000000099/1720000000000-shared.png'
     or v_resolution.object_id<>'06400000-0000-4000-8000-000000001001'
     or v_resolution.expected_byte_size<>24 then
    raise exception 'Preview resolution did not bind the exact current object';
  end if;
  if public.record_legacy_media_preview_service(
      v_owner_a,v_item,gen_random_uuid(),v_resolution.object_updated_at,
      v_hash,24,'image/png') then
    raise exception 'Preview record accepted the wrong Storage object';
  end if;
  if not public.record_legacy_media_preview_service(
      v_owner_a,v_item,v_resolution.object_id,v_resolution.object_updated_at,
      v_hash,24,'image/png') then
    raise exception 'Exact preview record failed';
  end if;
  if not public.record_legacy_media_preview_service(
      v_owner_a,v_item,v_resolution.object_id,v_resolution.object_updated_at,
      v_hash,24,'image/png') then
    raise exception 'Exact preview record was not idempotent';
  end if;
  if (select count(*) from public.list_legacy_media_references_service(
      v_owner_a,null,100) listed
      where listed.source_item_id=(select source_id
        from public.legacy_media_references where id=v_item)
        and listed.previewed and listed.detected_mime='image/png'
        and listed.byte_size=24)<>2 then
    raise exception 'Source-level preview did not safely cover both exact references';
  end if;

  -- A Storage version change clears the prior exact-byte preview on refresh.
  update storage.objects set updated_at=updated_at+interval '1 second'
  where id=v_resolution.object_id;
  perform public.inventory_legacy_media_references_service(v_owner_a,100);
  if exists(select 1 from public.legacy_media_sources source
    where source.id=(select source_id from public.legacy_media_references where id=v_item)
      and source.previewed_at is not null) then
    raise exception 'Changed Storage object retained stale preview authority';
  end if;

  -- A removed current value becomes stale without violating the null source
  -- invariant of a previously cross-owner row; restoring it is idempotent.
  update public.personas set feed_img_url='' where id=v_persona_a;
  v_summary:=public.inventory_legacy_media_references_service(v_owner_a,100);
  if (v_summary->>'references')::integer<>11 or (v_summary->>'stale')::integer<>1
     or not exists(select 1 from public.legacy_media_references reference
       where reference.id=v_cross_item and reference.state='stale'
         and reference.source_id is null) then
    raise exception 'Removed cross-owner reference did not become safely stale: %',v_summary::text;
  end if;
  update public.personas set feed_img_url=v_cross_url where id=v_persona_a;
  perform public.inventory_legacy_media_references_service(v_owner_a,100);
  if not exists(select 1 from public.legacy_media_references reference
    where reference.id=v_cross_item and reference.state='blocked_cross_owner'
      and reference.source_id is null) then
    raise exception 'Restored cross-owner reference was not reclassified safely';
  end if;

  if not public.consume_legacy_media_remediation_rate_service(v_owner_a,'list') then
    raise exception 'Initial owner rate-limit request was rejected';
  end if;
  if public.consume_legacy_media_remediation_rate_service(v_owner_a,'unknown') then
    raise exception 'Unknown rate-limit action was accepted';
  end if;

  -- Mirrors the explicit content-only erasure order. Owner B sentinels remain.
  delete from public.legacy_media_references where owner=v_owner_a;
  delete from public.legacy_media_sources where owner=v_owner_a;
  delete from public.legacy_media_remediation_rate_limits_064 where owner=v_owner_a;
  if exists(select 1 from public.legacy_media_references where owner=v_owner_a)
     or exists(select 1 from public.legacy_media_sources where owner=v_owner_a)
     or exists(select 1 from public.legacy_media_remediation_rate_limits_064 where owner=v_owner_a)
     or not exists(select 1 from public.legacy_media_references where owner=v_owner_b)
     or not exists(select 1 from public.legacy_media_sources where owner=v_owner_b) then
    raise exception 'Owner-scoped remediation erasure crossed an account boundary';
  end if;
end
$lifecycle$;

set local role authenticated;
do $browser_denied$
begin
  begin
    perform * from public.list_legacy_media_references_service(
      '05900000-0000-4000-8000-000000000099',null,10);
    raise exception 'Authenticated browser service call unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.legacy_media_sources limit 1;
    raise exception 'Authenticated browser table read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$browser_denied$;
reset role;

rollback;
