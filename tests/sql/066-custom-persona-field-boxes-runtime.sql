\set ON_ERROR_STOP on

begin;

do $manifest_oid$
begin
  if (select original_oid from public.test_066_manifest_oid)<>
      'public.persona_publication_review_manifest(uuid)'::regprocedure::oid then
    raise exception 'Migration 066 replaced the public manifest OID and could leave cached callers on a bypass';
  end if;
end
$manifest_oid$;

insert into public.profiles(id) values
  ('06600000-0000-4000-8000-000000000001'),
  ('06600000-0000-4000-8000-000000000002');
insert into public.personas(
  id,owner,handle,visibility,publication_state,publication_revision,published_revision
) values
  ('06600000-0000-4000-8000-000000000101','06600000-0000-4000-8000-000000000001',
    'target','public','published',1,1),
  ('06600000-0000-4000-8000-000000000102','06600000-0000-4000-8000-000000000002',
    'viewer','public','published',1,1),
  ('06600000-0000-4000-8000-000000000103','06600000-0000-4000-8000-000000000002',
    'sentinel','private','draft',1,null),
  ('06600000-0000-4000-8000-000000000104','06600000-0000-4000-8000-000000000001',
    'sameowneractor','public','published',1,1);
insert into public.persona_publication_reviews(persona_id,owner,review_state) values(
  '06600000-0000-4000-8000-000000000101','06600000-0000-4000-8000-000000000001','ready'
);

do $owner_mutation$
declare
  v_owner constant uuid:='06600000-0000-4000-8000-000000000001';
  v_persona constant uuid:='06600000-0000-4000-8000-000000000101';
  v_owner_field jsonb;v_public_field jsonb;v_friend_field jsonb;
  v_follower_field jsonb;v_disabled_field jsonb;v_manifest jsonb;v_i integer;
begin
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);

  v_owner_field:=public.save_persona_custom_field_box(null,v_persona,null,
    'text','Owner note','private value','','','owner_only',true,0);
  if (select publication_revision from public.personas where id=v_persona)<>1 then
    raise exception 'Owner-only field invalidated publication';
  end if;

  v_public_field:=public.save_persona_custom_field_box(null,v_persona,null,
    'link','Official site','public description','Visit','https://example.test/about',
    'public',true,10);
  if not exists(select 1 from public.personas where id=v_persona
      and publication_revision=2 and publication_state='draft')
     or not exists(select 1 from public.persona_publication_reviews
      where persona_id=v_persona and review_state='stale') then
    raise exception 'Shared field did not stale the exact publication review';
  end if;

  v_friend_field:=public.save_persona_custom_field_box(null,v_persona,null,
    'text','Friend note','friends see this','','','friends',true,20);
  v_follower_field:=public.save_persona_custom_field_box(null,v_persona,null,
    'text','Follower note','followers see this','','','followers',true,30);
  v_disabled_field:=public.save_persona_custom_field_box(null,v_persona,null,
    'text','Disabled public','not rendered','','','public',false,40);

  begin
    perform public.save_persona_custom_field_box(
      (v_public_field->>'id')::uuid,v_persona,99,'link','Official site','x',
      'Visit','https://example.test/about','public',true,10);
    raise exception 'Stale CAS unexpectedly succeeded';
  exception when serialization_failure then null;
  end;
  begin
    perform public.save_persona_custom_field_box(null,v_persona,null,'link',
      'Unsafe','', 'Open','https://user:secret@example.test/','public',true,50);
    raise exception 'Credential-bearing URL unexpectedly succeeded';
  exception when raise_exception then
    if position('credential-free HTTPS URL' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_persona_custom_field_box(null,v_persona,null,'link',
      'Leaking link','', 'Open',
      'https://example.test/path?api_key=abcdefghijklmnop','public',true,50);
    raise exception 'Credential-bearing query URL unexpectedly succeeded';
  exception when raise_exception then
    if position('without a query, fragment, or secret' in sqlerrm)=0 then raise; end if;
  end;

  insert into public.meta_owner_erasure_leases(owner,lease_id,expires_at)
  values(v_owner,'06600000-0000-4000-8000-000000000901',now()+interval '10 minutes');
  begin
    perform public.save_persona_custom_field_box(null,v_persona,null,'text',
      'Erasure race','blocked','','','owner_only',false,50);
    raise exception 'Custom field creation crossed an active erasure lease';
  exception when object_not_in_prerequisite_state then
    if position('blocked while owner erasure is running' in sqlerrm)=0 then raise; end if;
  end;
  delete from public.meta_owner_erasure_leases where owner=v_owner;

  update public.personas set publication_state='published',
    published_revision=publication_revision where id=v_persona;
  v_manifest:=public.persona_publication_review_manifest(v_persona);
  if (v_manifest->'counts'->>'custom_field_boxes')::integer<>3
     or jsonb_array_length(v_manifest->'custom_field_boxes')<>3
     or exists(select 1 from jsonb_array_elements(v_manifest->'custom_field_boxes') field
       where field->>'visibility'='owner_only')
     or not coalesce((v_manifest->>'complete')::boolean,false) then
    raise exception 'Manifest custom-field binding was incomplete: %',v_manifest;
  end if;

  -- Fill the remaining per-persona quota with inert owner-only rows.
  for v_i in 6..24 loop
    perform public.save_persona_custom_field_box(null,v_persona,null,'text',
      'Private field '||v_i,'value','','','owner_only',false,v_i*10);
  end loop;
  begin
    perform public.save_persona_custom_field_box(null,v_persona,null,'text',
      'Quota overflow','value','','','owner_only',false,250);
    raise exception 'Twenty-fifth field unexpectedly succeeded';
  exception when raise_exception then
    if position('Persona custom field limit reached (24)' in sqlerrm)=0 then raise; end if;
  end;
end
$owner_mutation$;

do $audiences$
declare
  v_target constant uuid:='06600000-0000-4000-8000-000000000101';
  v_viewer_owner constant uuid:='06600000-0000-4000-8000-000000000002';
  v_actor constant uuid:='06600000-0000-4000-8000-000000000102';
  v_fields jsonb;
begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claim.role','anon',true);
  v_fields:=public.persona_custom_field_boxes(v_target,null);
  if jsonb_array_length(v_fields)<>1 or v_fields->0->>'visibility'<>'public' then
    raise exception 'Anonymous projection did not return exactly public fields: %',v_fields;
  end if;

  perform set_config('request.jwt.claim.sub',v_viewer_owner::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  insert into public.persona_follows(follower_persona_id,target_persona_id)
    values(v_actor,v_target);
  v_fields:=public.persona_custom_field_boxes(v_target,v_actor);
  if jsonb_array_length(v_fields)<>2
     or not exists(select 1 from jsonb_array_elements(v_fields) field
       where field->>'visibility'='followers')
     or exists(select 1 from jsonb_array_elements(v_fields) field
       where field->>'visibility' in ('friends','owner_only')) then
    raise exception 'Follower projection crossed an audience boundary: %',v_fields;
  end if;
  insert into public.follows(follower,target,status) values(v_actor,v_target,'accepted');
  v_fields:=public.persona_custom_field_boxes(v_target,v_actor);
  if jsonb_array_length(v_fields)<>3
     or not exists(select 1 from jsonb_array_elements(v_fields) field
       where field->>'visibility'='friends')
     or exists(select 1 from jsonb_array_elements(v_fields) field
       where field->>'visibility'='owner_only') then
    raise exception 'Friend projection crossed an audience boundary: %',v_fields;
  end if;

  perform set_config('request.jwt.claim.sub','06600000-0000-4000-8000-000000000001',true);
  v_fields:=public.persona_custom_field_boxes(
    v_target,'06600000-0000-4000-8000-000000000104');
  if jsonb_array_length(v_fields)<>1
     or v_fields->0->>'visibility'<>'public'
     or exists(select 1 from jsonb_array_elements(v_fields) field
       where field->>'visibility' in ('owner_only','friends','followers')) then
    raise exception 'Different same-owner actor received account-owner fields: %',v_fields;
  end if;

  perform set_config('request.jwt.claim.sub',v_viewer_owner::text,true);
  begin
    perform public.persona_custom_field_boxes(v_target,v_target);
    raise exception 'Foreign acting persona unexpectedly succeeded';
  exception when raise_exception then
    if position('Owned acting persona not found' in sqlerrm)=0 then raise; end if;
  end;
end
$audiences$;

do $erasure$
declare v_result jsonb;
begin
  perform set_config('request.jwt.claim.sub','06600000-0000-4000-8000-000000000002',true);
  perform public.save_persona_custom_field_box(null,
    '06600000-0000-4000-8000-000000000103',null,'text','Sentinel','keep',
    '','','owner_only',false,0);
  perform set_config('request.jwt.claim.role','service_role',true);
  v_result:=public.delete_persona_page_builder_data_for_account_service(
    '06600000-0000-4000-8000-000000000001');
  if (v_result->>'custom_fields_deleted')::integer<>24
     or exists(select 1 from public.persona_custom_field_boxes
       where owner='06600000-0000-4000-8000-000000000001')
     or not exists(select 1 from public.persona_custom_field_boxes
       where owner='06600000-0000-4000-8000-000000000002') then
    raise exception 'Owner-scoped custom-field erasure failed: %',v_result;
  end if;
end
$erasure$;

do $privileges$
begin
  if has_table_privilege('anon','public.persona_custom_field_boxes','select')
     or has_table_privilege('authenticated','public.persona_custom_field_boxes','select')
     or has_table_privilege('service_role','public.persona_custom_field_boxes','insert') then
    raise exception 'A role retained direct custom-field table authority';
  end if;
  if has_function_privilege('anon',
      'public.save_persona_custom_field_box(uuid,uuid,bigint,text,text,text,text,text,text,boolean,integer)','execute')
     or not has_function_privilege('authenticated',
      'public.save_persona_custom_field_box(uuid,uuid,bigint,text,text,text,text,text,text,boolean,integer)','execute')
     or not has_function_privilege('anon',
      'public.persona_custom_field_boxes(uuid,uuid)','execute') then
    raise exception 'Custom-field RPC privileges are incorrect';
  end if;
end
$privileges$;

rollback;

select 'custom-persona-field-boxes-066-runtime-ok' as result;
