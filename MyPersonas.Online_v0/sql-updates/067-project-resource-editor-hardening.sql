-- 067-project-resource-editor-hardening.sql
-- Credential-free owner project-resource metadata with AAL2, erasure exclusion,
-- and optimistic concurrency. This migration never connects to a resource.

begin;

alter table public.project_resources
  add column if not exists row_version bigint not null default 1;

alter table public.project_resources
  drop constraint if exists project_resources_row_version_positive;
alter table public.project_resources
  add constraint project_resources_row_version_positive
  check (row_version > 0);

create or replace function public.project_resource_locator_safe_067(p_locator text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := trim(coalesce(p_locator,''));
begin
  if v_value = '' then return true; end if;
  if char_length(v_value) > 2048
     or v_value ~ '[[:cntrl:][:space:]]'
     or position(chr(92) in v_value) > 0
     or position('?' in v_value) > 0
     or position('#' in v_value) > 0
     or not public.is_safe_credential_free_https_url(v_value,false)
     or public.project_resource_text_has_secret(v_value) then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.project_resource_locator_safe_067(text)
  from public, anon, authenticated, service_role;

-- Migration 049 allowed metadata states that the hardened editor now rejects.
-- Disable only an already-enabled unsafe row; preserve its text for owner repair.
update public.project_resources resource set
  enabled = false,
  connection_state = 'blocked',
  row_version = resource.row_version + 1,
  updated_at = now()
where resource.enabled and (
  resource.connection_state <> 'ready'
  or trim(resource.resource_locator) = ''
  or not public.project_resource_locator_safe_067(resource.resource_locator)
  or (resource.account_ledger_id is not null and not exists(
    select 1 from public.account_ledger ledger
    where ledger.id = resource.account_ledger_id
      and ledger.owner = resource.owner
      and not ledger.suspended
  ))
);

create or replace function public.save_project_resource_v2(
  p_resource_id uuid,
  p_expected_row_version bigint,
  p_project_id uuid,
  p_resource_type text,
  p_display_name text,
  p_resource_locator text default '',
  p_account_ledger_id uuid default null,
  p_access_mode text default 'reference',
  p_connection_state text default 'not_configured',
  p_enabled boolean default false,
  p_owner_notes text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_id uuid;
  v_existing_project_id uuid;
  v_existing_row_version bigint;
  v_name text := trim(coalesce(p_display_name,''));
  v_locator text := trim(coalesce(p_resource_locator,''));
  v_notes text := trim(coalesce(p_owner_notes,''));
  v_owner_total integer;
  v_owner_day integer;
  v_project_total integer;
  v_day timestamptz := date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.assert_owner_erasure_inactive_066(v_owner);
  perform public.lock_owner_persona_org_creation_quota(v_owner);

  if not coalesce(p_resource_type in (
    'database','repository','drive_folder','document_library','website','other'
  ),false) then raise exception 'Invalid project resource type'; end if;
  if not coalesce(p_access_mode in ('reference','read_only'),false) then
    raise exception 'Invalid project access mode';
  end if;
  if not coalesce(p_connection_state in ('not_configured','ready','blocked','disabled'),false) then
    raise exception 'Invalid project connection state';
  end if;
  if v_name = '' or char_length(v_name) > 200
     or v_name ~ '[[:cntrl:]]'
     or public.project_resource_text_has_secret(v_name) then
    raise exception 'Project resource name is invalid or appears to contain a credential';
  end if;
  if char_length(v_notes) > 4000
     or pg_catalog.regexp_replace(v_notes,E'[\t\r\n]','','g') ~ '[[:cntrl:]]'
     or public.project_resource_text_has_secret(v_notes) then
    raise exception 'Project resource notes are invalid or appear to contain a credential';
  end if;
  if not public.project_resource_locator_safe_067(v_locator) then
    raise exception 'Use a credential-free HTTPS resource locator without a query or fragment';
  end if;
  if coalesce(p_enabled,false) and p_connection_state <> 'ready' then
    raise exception 'Only a resource marked ready may be enabled';
  end if;
  if p_connection_state = 'ready' and v_locator = '' then
    raise exception 'A ready resource needs a reviewed HTTPS locator';
  end if;

  if p_resource_id is null then
    if p_expected_row_version is not null and p_expected_row_version <> 0 then
      raise sqlstate '40001' using message = 'New project resources cannot have an existing row version';
    end if;
  elsif p_expected_row_version is null or p_expected_row_version < 1 then
    raise sqlstate '40001' using message = 'Reload the project resource before saving';
  end if;

  perform 1 from public.persona_projects project
  where project.id = p_project_id and project.owner = v_owner
  for update;
  if not found then raise exception 'Owned project not found'; end if;

  if p_resource_id is not null then
    select resource.project_id, resource.row_version
      into v_existing_project_id, v_existing_row_version
    from public.project_resources resource
    where resource.id = p_resource_id and resource.owner = v_owner
    for update;
    if not found then raise exception 'Owned project resource not found'; end if;
    if v_existing_project_id is distinct from p_project_id then
      raise exception 'Project resources cannot move between projects; delete and recreate the resource';
    end if;
    if v_existing_row_version is distinct from p_expected_row_version then
      raise sqlstate '40001' using message = 'Project resource changed; reload before saving';
    end if;
  end if;

  if p_account_ledger_id is not null and not exists(
    select 1 from public.account_ledger ledger
    where ledger.id = p_account_ledger_id
      and ledger.owner = v_owner
      and not ledger.suspended
  ) then raise exception 'Active owned account ledger entry not found'; end if;

  if p_resource_id is null then
    select count(*) into v_owner_total from (
      select 1 from public.project_resources resource
      where resource.owner = v_owner limit 1000
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.project_resources resource
      where resource.owner = v_owner and resource.created_at >= v_day
        and resource.created_at < v_day + interval '1 day' limit 50
    ) quota;
    select count(*) into v_project_total from (
      select 1 from public.project_resources resource
      where resource.owner = v_owner and resource.project_id = p_project_id limit 100
    ) quota;
    if v_owner_total >= 1000 then
      raise exception 'Project resource account limit reached (1000)'; end if;
    if v_owner_day >= 50 then
      raise exception 'Project resource daily creation limit reached (50 UTC)'; end if;
    if v_project_total >= 100 then
      raise exception 'Project resource project limit reached (100)'; end if;
    perform public.consume_owner_daily_rate(
      v_owner,'project_resources',50,1,v_owner_day
    );
    insert into public.project_resources(
      project_id,owner,resource_type,display_name,resource_locator,
      account_ledger_id,access_mode,connection_state,enabled,owner_notes,row_version
    ) values(
      p_project_id,v_owner,p_resource_type,v_name,v_locator,
      p_account_ledger_id,p_access_mode,p_connection_state,coalesce(p_enabled,false),
      v_notes,1
    ) returning id into v_id;
  else
    update public.project_resources resource set
      resource_type = p_resource_type,
      display_name = v_name,
      resource_locator = v_locator,
      account_ledger_id = p_account_ledger_id,
      access_mode = p_access_mode,
      connection_state = p_connection_state,
      enabled = coalesce(p_enabled,false),
      owner_notes = v_notes,
      row_version = resource.row_version + 1,
      updated_at = now()
    where resource.id = p_resource_id
      and resource.owner = v_owner
      and resource.project_id = p_project_id
      and resource.row_version = p_expected_row_version
    returning resource.id into v_id;
    if v_id is null then
      raise sqlstate '40001' using message = 'Project resource changed; reload before saving';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_project_resource_v2(
  p_resource_id uuid,
  p_expected_row_version bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_project_id uuid;
  v_locked_project_id uuid;
  v_existing_row_version bigint;
  v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.assert_owner_erasure_inactive_066(v_owner);
  perform public.lock_owner_persona_org_creation_quota(v_owner);
  if p_expected_row_version is null or p_expected_row_version < 1 then
    raise sqlstate '40001' using message = 'Reload the project resource before deleting';
  end if;

  select resource.project_id into v_project_id
  from public.project_resources resource
  where resource.id = p_resource_id and resource.owner = v_owner;
  if not found then return false; end if;

  perform 1 from public.persona_projects project
  where project.id = v_project_id and project.owner = v_owner
  for update;
  if not found then return false; end if;

  select resource.project_id, resource.row_version
    into v_locked_project_id, v_existing_row_version
  from public.project_resources resource
  where resource.id = p_resource_id and resource.owner = v_owner
  for update;
  if not found then return false; end if;
  if v_locked_project_id is distinct from v_project_id
     or v_existing_row_version is distinct from p_expected_row_version then
    raise sqlstate '40001' using message = 'Project resource changed; reload before deleting';
  end if;

  delete from public.project_resources resource
  where resource.id = p_resource_id
    and resource.owner = v_owner
    and resource.project_id = v_project_id
    and resource.row_version = p_expected_row_version;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise sqlstate '40001' using message = 'Project resource changed; reload before deleting';
  end if;
  return true;
end;
$$;

-- Migration 049 exposed last-write-wins RPCs. Keep their signatures for old
-- database history, but remove every browser and service-role execution grant.
revoke all on function public.save_project_resource(
  uuid,uuid,text,text,text,uuid,text,text,boolean,text
) from public, anon, authenticated, service_role;
revoke all on function public.delete_project_resource(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.save_project_resource_v2(
  uuid,bigint,uuid,text,text,text,uuid,text,text,boolean,text
) from public, anon, authenticated, service_role;
grant execute on function public.save_project_resource_v2(
  uuid,bigint,uuid,text,text,text,uuid,text,text,boolean,text
) to authenticated;
revoke all on function public.delete_project_resource_v2(uuid,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_project_resource_v2(uuid,bigint)
  to authenticated;

comment on function public.project_resource_locator_safe_067(text) is
  'Private helper accepting only empty or credential-free HTTPS project-resource locators. The app never server-fetches them.';
comment on function public.save_project_resource_v2(uuid,bigint,uuid,text,text,text,uuid,text,text,boolean,text) is
  'AAL2 owner mutation for credential-free resource metadata with erasure exclusion and row-version conflict detection.';
comment on function public.delete_project_resource_v2(uuid,bigint) is
  'AAL2 owner deletion for project-resource metadata with erasure exclusion and row-version conflict detection.';
comment on column public.project_resources.row_version is
  'Monotonic optimistic-concurrency version. Browser writes and deletes must supply the exact current value.';

commit;
