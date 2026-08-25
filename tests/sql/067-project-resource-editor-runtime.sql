\set ON_ERROR_STOP on

begin;

do $legacy_fail_closed$
begin
  if not exists(select 1 from public.project_resources resource
    where resource.id='06700000-0000-4000-8000-000000000299'
      and not resource.enabled and resource.connection_state='blocked'
      and resource.row_version=2
      and resource.owner_notes='preserve for owner repair') then
    raise exception 'Unsafe enabled migration-049 resource did not fail closed exactly once';
  end if;
end
$legacy_fail_closed$;

insert into public.profiles(id) values
  ('06700000-0000-4000-8000-000000000001'),
  ('06700000-0000-4000-8000-000000000002');
insert into public.persona_projects(id,owner,name) values
  ('06700000-0000-4000-8000-000000000101','06700000-0000-4000-8000-000000000001','Primary'),
  ('06700000-0000-4000-8000-000000000102','06700000-0000-4000-8000-000000000001','Secondary'),
  ('06700000-0000-4000-8000-000000000103','06700000-0000-4000-8000-000000000002','Foreign');
insert into public.account_ledger(id,owner,provider,suspended) values
  ('06700000-0000-4000-8000-000000000201','06700000-0000-4000-8000-000000000001','supabase',false),
  ('06700000-0000-4000-8000-000000000202','06700000-0000-4000-8000-000000000001','disabled-provider',true),
  ('06700000-0000-4000-8000-000000000203','06700000-0000-4000-8000-000000000002','foreign',false);

do $locator_matrix$
declare v_value text;
begin
  foreach v_value in array array[
    'https://example.test/path',
    'HTTPS://docs.example.test:443/folder/item',
    'https://example.test:65535/path'
  ] loop
    if not public.project_resource_locator_safe_067(v_value) then
      raise exception 'Safe locator rejected: %',v_value;
    end if;
  end loop;
  foreach v_value in array array[
    'http://example.test/path','https://localhost/path','https://127.0.0.1/path',
    'https://169.254.169.254/latest/meta-data','https://[::1]/path',
    'https://db.internal/path','https://printer.lan/path',
    'https://localhost./','https://LOCALHOST.:443/path','https://db.internal./path',
    'https://printer.lan./path','https://example.test:0/path',
    'https://0x7f.0x0.0x0.0x1/path',
    'https://user:pass@example.test/path','https://example.test/path?q=1',
    'https://example.test/path#fragment','https://example.test/api_key=abcdefghijklmnop',
    'https://example.test/path with-space','https://example.test\\path'
  ] loop
    if public.project_resource_locator_safe_067(v_value) then
      raise exception 'Unsafe locator accepted: %',v_value;
    end if;
  end loop;
end
$locator_matrix$;

do $aal_boundary$
begin
  perform set_config('request.jwt.claim.sub','06700000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims','{"aal":"aal1"}',true);
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101','database','AAL1 attempt','',null,
      'reference','not_configured',false,'');
    raise exception 'AAL1 mutation unexpectedly succeeded';
  exception when insufficient_privilege then
    if position('Two-factor verification required' in sqlerrm)=0 then raise; end if;
  end;
end
$aal_boundary$;

do $owner_mutations$
declare
  v_id uuid;
  v_ready_disabled uuid;
  v_deleted boolean;
  v_owner constant uuid:='06700000-0000-4000-8000-000000000001';
begin
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  perform set_config('request.jwt.claims','{"aal":"aal2"}',true);

  v_id:=public.save_project_resource_v2(null,null,
    '06700000-0000-4000-8000-000000000101','database','  Castleborn DB  ',
    'https://dashboard.example.test/project/castleborn',
    '06700000-0000-4000-8000-000000000201','read_only','ready',true,'  owner note  ');
  if not exists(select 1 from public.project_resources resource where resource.id=v_id
      and resource.owner=v_owner and resource.display_name='Castleborn DB'
      and resource.owner_notes='owner note' and resource.enabled
      and resource.connection_state='ready' and resource.row_version=1) then
    raise exception 'Valid resource was not normalized and saved at version 1';
  end if;

  v_ready_disabled:=public.save_project_resource_v2(null,0,
    '06700000-0000-4000-8000-000000000101','repository','Reviewed but disabled',
    'https://code.example.test/repository',null,'reference','ready',false,'');
  if not exists(select 1 from public.project_resources
      where id=v_ready_disabled and not enabled and row_version=1) then
    raise exception 'Ready-but-disabled metadata did not remain disabled';
  end if;

  perform public.save_project_resource_v2(v_id,1,
    '06700000-0000-4000-8000-000000000101','database','Castleborn database',
    'https://dashboard.example.test/project/castleborn',null,'reference','blocked',false,'updated');
  if not exists(select 1 from public.project_resources where id=v_id
      and display_name='Castleborn database' and connection_state='blocked'
      and not enabled and row_version=2) then
    raise exception 'Owner update did not advance row version';
  end if;

  begin
    perform public.save_project_resource_v2(v_id,1,
      '06700000-0000-4000-8000-000000000101','database','Stale overwrite','',null,
      'reference','not_configured',false,'');
    raise exception 'Stale update unexpectedly succeeded';
  exception when serialization_failure then
    if position('changed; reload before saving' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(v_id,2,
      '06700000-0000-4000-8000-000000000102','database','Moved','',null,
      'reference','not_configured',false,'');
    raise exception 'Cross-project move unexpectedly succeeded';
  exception when raise_exception then
    if position('cannot move between projects' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101','database','Missing locator','',null,
      'reference','ready',false,'');
    raise exception 'Ready metadata without a locator unexpectedly succeeded';
  exception when raise_exception then
    if position('needs a reviewed HTTPS locator' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101','database','Wrong state','',null,
      'reference','blocked',true,'');
    raise exception 'Enabled non-ready metadata unexpectedly succeeded';
  exception when raise_exception then
    if position('Only a resource marked ready may be enabled' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101','database','api_key=abcdefghijklmnop','',null,
      'reference','not_configured',false,'');
    raise exception 'Credential-like display name unexpectedly succeeded';
  exception when raise_exception then
    if position('name is invalid or appears to contain a credential' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101','database',E'Bad\nname','',null,
      'reference','not_configured',false,'');
    raise exception 'Control-character display name unexpectedly succeeded';
  exception when raise_exception then
    if position('name is invalid or appears to contain a credential' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101','database','Secret note','',null,
      'reference','not_configured',false,'api_key=abcdefghijklmnop');
    raise exception 'Credential-like note unexpectedly succeeded';
  exception when raise_exception then
    if position('notes are invalid or appear to contain a credential' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101','database','Suspended account','',
      '06700000-0000-4000-8000-000000000202','reference','not_configured',false,'');
    raise exception 'Suspended ledger binding unexpectedly succeeded';
  exception when raise_exception then
    if position('Active owned account ledger entry not found' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000103','database','Foreign project','',null,
      'reference','not_configured',false,'');
    raise exception 'Foreign project binding unexpectedly succeeded';
  exception when raise_exception then
    if position('Owned project not found' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101','database','Foreign account','',
      '06700000-0000-4000-8000-000000000203','reference','not_configured',false,'');
    raise exception 'Foreign account binding unexpectedly succeeded';
  exception when raise_exception then
    if position('Active owned account ledger entry not found' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101',null,'Null type','',null,
      'reference','not_configured',false,'');
    raise exception 'Null resource type unexpectedly succeeded';
  exception when raise_exception then
    if position('Invalid project resource type' in sqlerrm)=0 then raise; end if;
  end;

  insert into public.meta_owner_erasure_leases(owner,lease_id,expires_at)
  values(v_owner,gen_random_uuid(),now()+interval '5 minutes');
  begin
    perform public.save_project_resource_v2(null,null,
      '06700000-0000-4000-8000-000000000101','database','Erasure race','',null,
      'reference','not_configured',false,'');
    raise exception 'Mutation during active erasure unexpectedly succeeded';
  exception when object_not_in_prerequisite_state then
    if position('erasure is running' in sqlerrm)=0 then raise; end if;
  end;
  delete from public.meta_owner_erasure_leases where owner=v_owner;

  perform set_config('request.jwt.claim.sub','06700000-0000-4000-8000-000000000002',true);
  if public.delete_project_resource_v2(v_id,2) then
    raise exception 'Foreign owner deleted resource metadata';
  end if;
  begin
    perform public.save_project_resource_v2(v_id,2,
      '06700000-0000-4000-8000-000000000101','database','Foreign edit','',null,
      'reference','not_configured',false,'');
    raise exception 'Foreign owner edited resource metadata';
  exception when raise_exception then
    if position('Owned project not found' in sqlerrm)=0 then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  begin
    perform public.delete_project_resource_v2(v_id,1);
    raise exception 'Stale delete unexpectedly succeeded';
  exception when serialization_failure then
    if position('changed; reload before deleting' in sqlerrm)=0 then raise; end if;
  end;
  if not exists(select 1 from public.project_resources where id=v_id and row_version=2) then
    raise exception 'Stale delete changed the resource';
  end if;
  v_deleted:=public.delete_project_resource_v2(v_id,2);
  if not v_deleted then raise exception 'Owner deletion returned false for %',v_id; end if;
  if exists(select 1 from public.project_resources where id=v_id) then
    raise exception 'Owner deletion returned true but row % remains',v_id;
  end if;
end
$owner_mutations$;

do $privileges$
begin
  if has_table_privilege('anon','public.project_resources','select')
     or not has_table_privilege('authenticated','public.project_resources','select')
     or has_table_privilege('authenticated','public.project_resources','insert')
     or not has_table_privilege('service_role','public.project_resources','select')
     or has_table_privilege('service_role','public.project_resources','insert')
     or has_table_privilege('service_role','public.project_resources','update')
     or has_table_privilege('service_role','public.project_resources','delete') then
    raise exception 'Project-resource table privileges do not match the production role boundary';
  end if;
  if has_function_privilege('anon',
      'public.save_project_resource(uuid,uuid,text,text,text,uuid,text,text,boolean,text)','execute')
     or has_function_privilege('authenticated',
      'public.save_project_resource(uuid,uuid,text,text,text,uuid,text,text,boolean,text)','execute')
     or has_function_privilege('service_role',
      'public.save_project_resource(uuid,uuid,text,text,text,uuid,text,text,boolean,text)','execute')
     or has_function_privilege('anon','public.delete_project_resource(uuid)','execute')
     or has_function_privilege('authenticated','public.delete_project_resource(uuid)','execute')
     or has_function_privilege('service_role','public.delete_project_resource(uuid)','execute')
     or has_function_privilege('anon',
      'public.save_project_resource_v2(uuid,bigint,uuid,text,text,text,uuid,text,text,boolean,text)','execute')
     or not has_function_privilege('authenticated',
      'public.save_project_resource_v2(uuid,bigint,uuid,text,text,text,uuid,text,text,boolean,text)','execute')
     or has_function_privilege('service_role',
      'public.save_project_resource_v2(uuid,bigint,uuid,text,text,text,uuid,text,text,boolean,text)','execute')
     or has_function_privilege('anon','public.delete_project_resource_v2(uuid,bigint)','execute')
     or not has_function_privilege('authenticated','public.delete_project_resource_v2(uuid,bigint)','execute')
     or has_function_privilege('service_role','public.delete_project_resource_v2(uuid,bigint)','execute')
     or has_function_privilege('authenticated','public.project_resource_locator_safe_067(text)','execute')
     or has_function_privilege('service_role','public.project_resource_locator_safe_067(text)','execute') then
    raise exception 'Project-resource RPC privileges are incorrect';
  end if;
end
$privileges$;

rollback;

select 'project-resource-editor-067-runtime-ok' as result;
