-- 049-persona-relationships-projects-businesses.sql
-- Owner-private family canon, project membership/resource boundaries, and
-- draft-first business profile foundations.
--
-- This migration does not publish relationship canon, connect a Castleborn
-- database, grant a persona authentication authority, or publish a business.
-- It may be applied only after migrations 017 and 048.

begin;

create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------
-- Harden the existing generic group membership owner boundary.
-- ----------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from public.persona_group_members member
    join public.persona_groups group_row on group_row.id = member.group_id
    where group_row.owner <> member.owner
  ) then
    raise exception
      'persona_group_members contains a cross-owner group reference; repair it before migration 049';
  end if;
end
$$;

create unique index if not exists persona_groups_id_owner_uidx
  on public.persona_groups(id, owner);

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'persona_group_members_group_owner_fkey'
      and conrelid = 'public.persona_group_members'::regclass
  ) then
    alter table public.persona_group_members
      add constraint persona_group_members_group_owner_fkey
      foreign key (group_id, owner)
      references public.persona_groups(id, owner)
      on delete cascade;
  end if;
end
$$;

-- ----------------------------------------------------------------------
-- Family relationships. Store only irreducible parent and partner edges.
-- Child and sibling labels are derived, preventing duplicate inverse rows.
-- ----------------------------------------------------------------------
create table if not exists public.persona_family_relationships (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null references public.profiles(id) on delete cascade,
  relationship_type   text not null check (relationship_type in ('parent_of','partner')),
  from_persona_id     uuid not null,
  to_persona_id       uuid not null,
  visibility          text not null default 'owner_only'
                        check (visibility in ('owner_only','friends','followers','public')),
  canon_status        text not null default 'working'
                        check (canon_status in ('proposed','working','owner_confirmed','retired')),
  source_key          text not null default '' check (char_length(source_key) <= 200),
  owner_notes         text not null default '' check (char_length(owner_notes) <= 4000),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (from_persona_id, owner)
    references public.personas(id, owner) on delete cascade,
  foreign key (to_persona_id, owner)
    references public.personas(id, owner) on delete cascade,
  check (from_persona_id <> to_persona_id),
  check (relationship_type <> 'partner' or from_persona_id < to_persona_id),
  unique (owner, relationship_type, from_persona_id, to_persona_id)
);

create index if not exists persona_family_relationships_owner_idx
  on public.persona_family_relationships(owner, from_persona_id, to_persona_id);
create index if not exists persona_family_relationships_to_idx
  on public.persona_family_relationships(owner, to_persona_id, relationship_type);

create or replace function public.enforce_persona_family_relationship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.profiles where id = new.owner for update;
  if not found then raise exception 'Relationship owner not found'; end if;

  if tg_op = 'UPDATE' and (
    new.owner is distinct from old.owner or
    new.relationship_type is distinct from old.relationship_type
  ) then
    raise exception 'Relationship owner and type are immutable';
  end if;

  if new.relationship_type = 'partner'
     and not (new.from_persona_id < new.to_persona_id) then
    raise exception 'Partner relationships must use canonical persona ordering';
  end if;

  if new.relationship_type = 'parent_of' and exists (
    with recursive descendants(persona_id) as (
      select new.to_persona_id
      union
      select relationship.to_persona_id
      from public.persona_family_relationships relationship
      join descendants current_node
        on current_node.persona_id = relationship.from_persona_id
      where relationship.owner = new.owner
        and relationship.relationship_type = 'parent_of'
        and relationship.id <> new.id
    )
    select 1 from descendants where persona_id = new.from_persona_id
  ) then
    raise exception 'A parent relationship cannot create an ancestry cycle';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists enforce_persona_family_relationship
  on public.persona_family_relationships;
create trigger enforce_persona_family_relationship
  before insert or update on public.persona_family_relationships
  for each row execute function public.enforce_persona_family_relationship();

-- ----------------------------------------------------------------------
-- Projects. A persona role is orchestration metadata, never an auth role.
-- Resource rows contain metadata only; credentials remain server-side.
-- ----------------------------------------------------------------------
create table if not exists public.persona_projects (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null references public.profiles(id) on delete cascade,
  slug           text not null check (slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  name           text not null check (char_length(name) between 1 and 160),
  description    text not null default '' check (char_length(description) <= 4000),
  project_status text not null default 'active'
                   check (project_status in ('active','paused','archived')),
  visibility     text not null default 'owner_only'
                   check (visibility in ('owner_only','friends','followers','public')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner, slug)
);
create unique index if not exists persona_projects_id_owner_uidx
  on public.persona_projects(id, owner);

create table if not exists public.persona_project_memberships (
  project_id  uuid not null,
  persona_id  uuid not null,
  owner       uuid not null references public.profiles(id) on delete cascade,
  role        text not null default 'member'
                check (role in ('manager','member','reviewer')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (project_id, persona_id),
  foreign key (project_id, owner)
    references public.persona_projects(id, owner) on delete cascade,
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
create index if not exists persona_project_memberships_persona_idx
  on public.persona_project_memberships(owner, persona_id, role);

create table if not exists public.project_resources (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null,
  owner              uuid not null references public.profiles(id) on delete cascade,
  resource_type      text not null
                       check (resource_type in ('database','repository','drive_folder','document_library','website','other')),
  display_name       text not null check (char_length(display_name) between 1 and 200),
  resource_locator   text not null default '' check (char_length(resource_locator) <= 2048),
  account_ledger_id  uuid,
  access_mode        text not null default 'reference'
                       check (access_mode in ('reference','read_only')),
  connection_state   text not null default 'not_configured'
                       check (connection_state in ('not_configured','ready','blocked','disabled')),
  enabled            boolean not null default false,
  owner_notes        text not null default '' check (char_length(owner_notes) <= 4000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (project_id, owner)
    references public.persona_projects(id, owner) on delete cascade,
  foreign key (account_ledger_id, owner)
    references public.account_ledger(id, owner) on delete restrict
);
create index if not exists project_resources_project_idx
  on public.project_resources(owner, project_id, enabled);

-- ----------------------------------------------------------------------
-- Draft-first business profiles, mission components, and persona titles.
-- A presentation title such as "Spokesperson" never grants permissions.
-- ----------------------------------------------------------------------
create table if not exists public.businesses (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null references public.profiles(id) on delete cascade,
  slug           text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  display_name   text not null check (char_length(display_name) between 1 and 160),
  short_bio      text not null default '' check (char_length(short_bio) <= 4000),
  mission        text not null default '' check (char_length(mission) <= 10000),
  page_status    text not null default 'draft'
                   check (page_status in ('draft','published','archived')),
  visibility     text not null default 'owner_only'
                   check (visibility in ('owner_only','friends','followers','public')),
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((page_status = 'published') = (published_at is not null))
);
create unique index if not exists businesses_id_owner_uidx
  on public.businesses(id, owner);

create table if not exists public.business_mission_items (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null,
  owner          uuid not null references public.profiles(id) on delete cascade,
  title          text not null check (char_length(title) between 1 and 200),
  body           text not null default '' check (char_length(body) <= 6000),
  sort_order     integer not null default 0 check (sort_order between 0 and 10000),
  enabled        boolean not null default true,
  visibility     text not null default 'owner_only'
                   check (visibility in ('owner_only','friends','followers','public')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (business_id, owner)
    references public.businesses(id, owner) on delete cascade
);
create index if not exists business_mission_items_business_idx
  on public.business_mission_items(owner, business_id, sort_order);

create table if not exists public.business_persona_memberships (
  business_id           uuid not null,
  persona_id            uuid not null,
  owner                 uuid not null references public.profiles(id) on delete cascade,
  membership_role       text not null default 'member'
                          check (membership_role in ('manager','member','creator','representative')),
  public_title          text not null default '' check (char_length(public_title) <= 120),
  enabled               boolean not null default true,
  membership_visibility text not null default 'owner_only'
                          check (membership_visibility in ('owner_only','friends','followers','public')),
  title_visibility      text not null default 'owner_only'
                          check (title_visibility in ('owner_only','friends','followers','public')),
  sort_order            integer not null default 0 check (sort_order between 0 and 10000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (business_id, persona_id),
  foreign key (business_id, owner)
    references public.businesses(id, owner) on delete cascade,
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
create index if not exists business_persona_memberships_persona_idx
  on public.business_persona_memberships(owner, persona_id, enabled);

-- ----------------------------------------------------------------------
-- Owner-only table access. All mutation goes through bounded RPCs below.
-- ----------------------------------------------------------------------
alter table public.persona_family_relationships enable row level security;
alter table public.persona_projects enable row level security;
alter table public.persona_project_memberships enable row level security;
alter table public.project_resources enable row level security;
alter table public.businesses enable row level security;
alter table public.business_mission_items enable row level security;
alter table public.business_persona_memberships enable row level security;

drop policy if exists "owner read family relationships"
  on public.persona_family_relationships;
create policy "owner read family relationships"
  on public.persona_family_relationships for select to authenticated
  using (owner = auth.uid());
drop policy if exists "owner read persona projects"
  on public.persona_projects;
create policy "owner read persona projects"
  on public.persona_projects for select to authenticated
  using (owner = auth.uid());
drop policy if exists "owner read project memberships"
  on public.persona_project_memberships;
create policy "owner read project memberships"
  on public.persona_project_memberships for select to authenticated
  using (owner = auth.uid());
drop policy if exists "owner read project resources"
  on public.project_resources;
create policy "owner read project resources"
  on public.project_resources for select to authenticated
  using (owner = auth.uid());
drop policy if exists "owner read businesses"
  on public.businesses;
create policy "owner read businesses"
  on public.businesses for select to authenticated
  using (owner = auth.uid());
drop policy if exists "owner read business mission items"
  on public.business_mission_items;
create policy "owner read business mission items"
  on public.business_mission_items for select to authenticated
  using (owner = auth.uid());
drop policy if exists "owner read business persona memberships"
  on public.business_persona_memberships;
create policy "owner read business persona memberships"
  on public.business_persona_memberships for select to authenticated
  using (owner = auth.uid());

revoke all on public.persona_family_relationships,
  public.persona_projects,
  public.persona_project_memberships,
  public.project_resources,
  public.businesses,
  public.business_mission_items,
  public.business_persona_memberships
  from public, anon, authenticated;
grant select on public.persona_family_relationships,
  public.persona_projects,
  public.persona_project_memberships,
  public.project_resources,
  public.businesses,
  public.business_mission_items,
  public.business_persona_memberships
  to authenticated;
grant all on public.persona_family_relationships,
  public.persona_projects,
  public.persona_project_memberships,
  public.project_resources,
  public.businesses,
  public.business_mission_items,
  public.business_persona_memberships
  to service_role;

create or replace function public.touch_persona_org_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'persona_projects','persona_project_memberships','project_resources',
    'businesses','business_mission_items','business_persona_memberships'
  ] loop
    execute format('drop trigger if exists touch_persona_org_updated_at on public.%I', table_name);
    execute format(
      'create trigger touch_persona_org_updated_at before update on public.%I '
      'for each row execute function public.touch_persona_org_updated_at()',
      table_name
    );
  end loop;
end
$$;

-- ----------------------------------------------------------------------
-- Bounded owner mutation RPCs.
-- ----------------------------------------------------------------------
create or replace function public.set_persona_family_relationship(
  p_relationship_id uuid,
  p_from_persona_id uuid,
  p_to_persona_id uuid,
  p_relationship_type text,
  p_visibility text default 'owner_only',
  p_canon_status text default 'working',
  p_source_key text default '',
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
  v_from uuid := p_from_persona_id;
  v_to uuid := p_to_persona_id;
  v_old_from uuid;
  v_old_to uuid;
  v_lock_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_relationship_type not in ('parent_of','partner') then
    raise exception 'Invalid relationship type';
  end if;
  if p_visibility not in ('owner_only','friends','followers','public') then
    raise exception 'Invalid relationship visibility';
  end if;
  if p_canon_status not in ('proposed','working','owner_confirmed','retired') then
    raise exception 'Invalid canon status';
  end if;
  if p_relationship_type = 'partner' and v_to < v_from then
    v_id := v_from; v_from := v_to; v_to := v_id;
  end if;
  if v_from = v_to then raise exception 'A persona cannot be related to itself'; end if;
  if not exists (
    select 1 from public.personas p
    where p.id in (v_from, v_to) and p.owner = v_owner
    group by p.owner having count(*) = 2
  ) then
    raise exception 'Both personas must belong to this account';
  end if;
  if p_relationship_id is not null then
    select relationship.from_persona_id,relationship.to_persona_id
    into v_old_from,v_old_to from public.persona_family_relationships relationship
    where relationship.id=p_relationship_id and relationship.owner=v_owner;
    if not found then raise exception 'Owned relationship not found'; end if;
  end if;
  for v_lock_id in select distinct id
    from unnest(array[v_from,v_to,v_old_from,v_old_to]) id
    where id is not null order by id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_lock_id::text,51051051)
    );
  end loop;

  if p_relationship_id is null then
    insert into public.persona_family_relationships (
      owner, relationship_type, from_persona_id, to_persona_id,
      visibility, canon_status, source_key, owner_notes
    ) values (
      v_owner, p_relationship_type, v_from, v_to,
      p_visibility, p_canon_status, left(coalesce(p_source_key,''),200),
      left(coalesce(p_owner_notes,''),4000)
    )
    on conflict (owner, relationship_type, from_persona_id, to_persona_id)
    do update set visibility = excluded.visibility,
      canon_status = excluded.canon_status,
      source_key = excluded.source_key,
      owner_notes = excluded.owner_notes,
      updated_at = now()
    returning id into v_id;
  else
    update public.persona_family_relationships relationship
    set from_persona_id = v_from,
        to_persona_id = v_to,
        visibility = p_visibility,
        canon_status = p_canon_status,
        source_key = left(coalesce(p_source_key,''),200),
        owner_notes = left(coalesce(p_owner_notes,''),4000)
    where relationship.id = p_relationship_id
      and relationship.owner = v_owner
      and relationship.relationship_type = p_relationship_type
    returning relationship.id into v_id;
    if v_id is null then raise exception 'Owned relationship not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_persona_family_relationship(p_relationship_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;v_from uuid;v_to uuid;v_lock_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select relationship.from_persona_id,relationship.to_persona_id into v_from,v_to
  from public.persona_family_relationships relationship
  where relationship.id=p_relationship_id and relationship.owner=auth.uid();
  if not found then return false; end if;
  for v_lock_id in select distinct id from unnest(array[v_from,v_to]) id order by id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_lock_id::text,51051051)
    );
  end loop;
  delete from public.persona_family_relationships
  where id = p_relationship_id and owner = auth.uid();
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.save_persona_project(
  p_project_id uuid,
  p_slug text,
  p_name text,
  p_description text default '',
  p_project_status text default 'active',
  p_visibility text default 'owner_only'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid := auth.uid(); v_id uuid; v_slug text := lower(trim(p_slug));
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{2,79}$' then raise exception 'Invalid project slug'; end if;
  if trim(coalesce(p_name,'')) = '' or char_length(p_name) > 160 then raise exception 'Invalid project name'; end if;
  if p_project_status not in ('active','paused','archived') then raise exception 'Invalid project status'; end if;
  if p_visibility not in ('owner_only','friends','followers','public') then raise exception 'Invalid project visibility'; end if;
  if p_project_id is null then
    insert into public.persona_projects(owner,slug,name,description,project_status,visibility)
    values(v_owner,v_slug,trim(p_name),left(coalesce(p_description,''),4000),p_project_status,p_visibility)
    returning id into v_id;
  else
    update public.persona_projects set slug=v_slug,name=trim(p_name),
      description=left(coalesce(p_description,''),4000),
      project_status=p_project_status,visibility=p_visibility
    where id=p_project_id and owner=v_owner returning id into v_id;
    if v_id is null then raise exception 'Owned project not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.set_persona_project_membership(
  p_project_id uuid,
  p_persona_id uuid,
  p_role text default 'member',
  p_remove boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_role not in ('manager','member','reviewer') then raise exception 'Invalid project role'; end if;
  perform 1 from public.persona_projects where id=p_project_id and owner=v_owner for update;
  if not found then raise exception 'Owned project not found'; end if;
  if not exists(select 1 from public.personas where id=p_persona_id and owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  if p_remove then
    delete from public.persona_project_memberships
    where project_id=p_project_id and persona_id=p_persona_id and owner=v_owner;
  else
    insert into public.persona_project_memberships(project_id,persona_id,owner,role)
    values(p_project_id,p_persona_id,v_owner,p_role)
    on conflict(project_id,persona_id) do update set role=excluded.role,updated_at=now();
  end if;
  return true;
end;
$$;

create or replace function public.save_project_resource(
  p_resource_id uuid,
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
declare v_owner uuid := auth.uid(); v_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_resource_type not in ('database','repository','drive_folder','document_library','website','other') then
    raise exception 'Invalid project resource type';
  end if;
  if p_access_mode not in ('reference','read_only') then raise exception 'Invalid project access mode'; end if;
  if p_connection_state not in ('not_configured','ready','blocked','disabled') then
    raise exception 'Invalid project connection state';
  end if;
  if trim(coalesce(p_display_name,''))='' or char_length(p_display_name)>200 then
    raise exception 'Invalid project resource name';
  end if;
  perform 1 from public.persona_projects where id=p_project_id and owner=v_owner for update;
  if not found then raise exception 'Owned project not found'; end if;
  if p_account_ledger_id is not null and not exists(
    select 1 from public.account_ledger where id=p_account_ledger_id and owner=v_owner
  ) then raise exception 'Owned account ledger entry not found'; end if;
  if p_resource_id is null then
    insert into public.project_resources(
      project_id,owner,resource_type,display_name,resource_locator,
      account_ledger_id,access_mode,connection_state,enabled,owner_notes
    ) values(
      p_project_id,v_owner,p_resource_type,trim(p_display_name),
      left(coalesce(p_resource_locator,''),2048),p_account_ledger_id,
      p_access_mode,p_connection_state,p_enabled,left(coalesce(p_owner_notes,''),4000)
    ) returning id into v_id;
  else
    update public.project_resources set project_id=p_project_id,
      resource_type=p_resource_type,display_name=trim(p_display_name),
      resource_locator=left(coalesce(p_resource_locator,''),2048),
      account_ledger_id=p_account_ledger_id,access_mode=p_access_mode,
      connection_state=p_connection_state,enabled=p_enabled,
      owner_notes=left(coalesce(p_owner_notes,''),4000)
    where id=p_resource_id and owner=v_owner returning id into v_id;
    if v_id is null then raise exception 'Owned project resource not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.save_business_profile(
  p_business_id uuid,
  p_slug text,
  p_display_name text,
  p_short_bio text default '',
  p_mission text default '',
  p_page_status text default 'draft',
  p_visibility text default 'owner_only'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid := auth.uid(); v_id uuid; v_slug text := lower(trim(p_slug));
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{2,79}$' then raise exception 'Invalid business slug'; end if;
  if trim(coalesce(p_display_name,'')) = '' or char_length(p_display_name)>160 then raise exception 'Invalid business name'; end if;
  if p_page_status not in ('draft','published','archived') then raise exception 'Invalid business page status'; end if;
  if p_visibility not in ('owner_only','friends','followers','public') then raise exception 'Invalid business visibility'; end if;
  if p_page_status='published' and p_visibility<>'public' then
    raise exception 'A published business page must be public';
  end if;
  if p_business_id is null then
    insert into public.businesses(owner,slug,display_name,short_bio,mission,page_status,visibility,published_at)
    values(v_owner,v_slug,trim(p_display_name),left(coalesce(p_short_bio,''),4000),
      left(coalesce(p_mission,''),10000),p_page_status,p_visibility,
      case when p_page_status='published' then now() else null end)
    returning id into v_id;
  else
    update public.businesses set slug=v_slug,display_name=trim(p_display_name),
      short_bio=left(coalesce(p_short_bio,''),4000),mission=left(coalesce(p_mission,''),10000),
      page_status=p_page_status,visibility=p_visibility,
      published_at=case when p_page_status='published' then coalesce(published_at,now()) else null end
    where id=p_business_id and owner=v_owner returning id into v_id;
    if v_id is null then raise exception 'Owned business not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.set_business_persona_membership(
  p_business_id uuid,
  p_persona_id uuid,
  p_membership_role text default 'member',
  p_public_title text default '',
  p_enabled boolean default true,
  p_membership_visibility text default 'owner_only',
  p_title_visibility text default 'owner_only',
  p_sort_order integer default 0,
  p_remove boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_membership_role not in ('manager','member','creator','representative') then raise exception 'Invalid business role'; end if;
  if p_membership_visibility not in ('owner_only','friends','followers','public')
     or p_title_visibility not in ('owner_only','friends','followers','public') then
    raise exception 'Invalid membership visibility';
  end if;
  if p_sort_order not between 0 and 10000 then raise exception 'Invalid sort order'; end if;
  perform 1 from public.businesses where id=p_business_id and owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;
  if not exists(select 1 from public.personas where id=p_persona_id and owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  if p_remove then
    delete from public.business_persona_memberships
    where business_id=p_business_id and persona_id=p_persona_id and owner=v_owner;
  else
    insert into public.business_persona_memberships(
      business_id,persona_id,owner,membership_role,public_title,enabled,
      membership_visibility,title_visibility,sort_order
    ) values (
      p_business_id,p_persona_id,v_owner,p_membership_role,
      left(coalesce(p_public_title,''),120),p_enabled,
      p_membership_visibility,p_title_visibility,p_sort_order
    ) on conflict(business_id,persona_id) do update set
      membership_role=excluded.membership_role,public_title=excluded.public_title,
      enabled=excluded.enabled,membership_visibility=excluded.membership_visibility,
      title_visibility=excluded.title_visibility,sort_order=excluded.sort_order,updated_at=now();
  end if;
  return true;
end;
$$;

create or replace function public.save_business_mission_item(
  p_item_id uuid,
  p_business_id uuid,
  p_title text,
  p_body text default '',
  p_sort_order integer default 0,
  p_enabled boolean default true,
  p_visibility text default 'owner_only'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid := auth.uid(); v_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if trim(coalesce(p_title,''))='' or char_length(p_title)>200 then raise exception 'Invalid mission item title'; end if;
  if p_sort_order not between 0 and 10000 then raise exception 'Invalid sort order'; end if;
  if p_visibility not in ('owner_only','friends','followers','public') then
    raise exception 'Invalid mission item visibility';
  end if;
  perform 1 from public.businesses where id=p_business_id and owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;
  if p_item_id is null then
    insert into public.business_mission_items(
      business_id,owner,title,body,sort_order,enabled,visibility
    ) values(
      p_business_id,v_owner,trim(p_title),left(coalesce(p_body,''),6000),
      p_sort_order,p_enabled,p_visibility
    ) returning id into v_id;
  else
    update public.business_mission_items set business_id=p_business_id,
      title=trim(p_title),body=left(coalesce(p_body,''),6000),
      sort_order=p_sort_order,enabled=p_enabled,visibility=p_visibility
    where id=p_item_id and owner=v_owner returning id into v_id;
    if v_id is null then raise exception 'Owned mission item not found'; end if;
  end if;
  return v_id;
end;
$$;

-- Owner-only relationship projection. Siblings are derived from shared parent
-- edges and return their shared-parent count instead of asserting a twin claim.
create or replace function public.my_persona_family(p_persona_id uuid)
returns table(
  relative_persona_id uuid,
  relationship_label text,
  shared_parent_count integer,
  visibility text,
  canon_status text
)
language sql
security definer
stable
set search_path = ''
as $$
  with owned as (
    select p.id,p.owner from public.personas p
    where p.id=p_persona_id and p.owner=auth.uid()
  ), direct_edges as (
    select relationship.to_persona_id relative_persona_id,
      case when relationship.relationship_type='parent_of' then 'child' else 'partner' end relationship_label,
      0 shared_parent_count,relationship.visibility,relationship.canon_status
    from public.persona_family_relationships relationship
    join owned on owned.owner=relationship.owner
    where relationship.from_persona_id=p_persona_id
    union all
    select relationship.from_persona_id,
      case when relationship.relationship_type='parent_of' then 'parent' else 'partner' end,
      0,relationship.visibility,relationship.canon_status
    from public.persona_family_relationships relationship
    join owned on owned.owner=relationship.owner
    where relationship.to_persona_id=p_persona_id
  ), siblings as (
    select other_child.to_persona_id relative_persona_id,
      'sibling'::text relationship_label,
      count(distinct my_parent.from_persona_id)::integer shared_parent_count,
      'owner_only'::text visibility,
      'working'::text canon_status
    from public.persona_family_relationships my_parent
    join public.persona_family_relationships other_child
      on other_child.owner=my_parent.owner
      and other_child.relationship_type='parent_of'
      and other_child.from_persona_id=my_parent.from_persona_id
      and other_child.to_persona_id<>p_persona_id
    join owned on owned.owner=my_parent.owner
    where my_parent.relationship_type='parent_of'
      and my_parent.to_persona_id=p_persona_id
    group by other_child.to_persona_id
  )
  select * from direct_edges
  union all
  select * from siblings;
$$;

-- Public family projection exposes only explicit public edges between public
-- personas. It never exposes source notes, canon notes, or the owner id.
create or replace function public.persona_family_by_handle(p_handle text)
returns table(
  relative_persona_id uuid,
  relative_handle text,
  relative_name text,
  relative_avatar_url text,
  relationship_label text
)
language sql
security definer
stable
set search_path = ''
as $$
  with subject as (
    select p.id,p.owner from public.personas p
    where p.handle=lower(trim(p_handle)) and p.visibility='public'
  ), direct_edges as (
    select relative.id,relative.handle,relative.name,relative.avatar_url,
      case when relationship.relationship_type='parent_of' then 'child' else 'partner' end relationship_label
    from public.persona_family_relationships relationship
    join subject on subject.owner=relationship.owner and subject.id=relationship.from_persona_id
    join public.personas relative on relative.id=relationship.to_persona_id and relative.visibility='public'
    where relationship.visibility='public'
    union all
    select relative.id,relative.handle,relative.name,relative.avatar_url,
      case when relationship.relationship_type='parent_of' then 'parent' else 'partner' end
    from public.persona_family_relationships relationship
    join subject on subject.owner=relationship.owner and subject.id=relationship.to_persona_id
    join public.personas relative on relative.id=relationship.from_persona_id and relative.visibility='public'
    where relationship.visibility='public'
  )
  select * from direct_edges;
$$;

-- Only published/public data is projected. Friends/followers tiers deliberately
-- fail closed until those two social relationships are represented separately.
create or replace function public.business_page_by_slug(p_slug text)
returns table (
  id uuid,
  slug text,
  display_name text,
  short_bio text,
  mission text,
  mission_items jsonb,
  personas jsonb
)
language sql
security definer
stable
set search_path = ''
as $$
  select business.id,business.slug,business.display_name,business.short_bio,business.mission,
    coalesce((
      select jsonb_agg(jsonb_build_object('title',item.title,'body',item.body)
        order by item.sort_order,item.created_at)
      from public.business_mission_items item
      where item.business_id=business.id and item.owner=business.owner
        and item.enabled and item.visibility='public'
    ),'[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',persona.id,'handle',persona.handle,'name',persona.name,
        'avatar_url',persona.avatar_url,
        'title',case when membership.title_visibility='public' then membership.public_title else '' end
      ) order by membership.sort_order,persona.name)
      from public.business_persona_memberships membership
      join public.personas persona on persona.id=membership.persona_id
      where membership.business_id=business.id and membership.owner=business.owner
        and membership.enabled and membership.membership_visibility='public'
        and persona.visibility='public'
    ),'[]'::jsonb)
  from public.businesses business
  where business.slug=lower(trim(p_slug))
    and business.page_status='published'
    and business.visibility='public'
  limit 1;
$$;

revoke all on function public.enforce_persona_family_relationship()
  from public, anon, authenticated;
revoke all on function public.touch_persona_org_updated_at()
  from public, anon, authenticated;
revoke all on function public.set_persona_family_relationship(uuid,uuid,uuid,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.delete_persona_family_relationship(uuid)
  from public, anon, authenticated;
revoke all on function public.save_persona_project(uuid,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.set_persona_project_membership(uuid,uuid,text,boolean)
  from public, anon, authenticated;
revoke all on function public.save_project_resource(uuid,uuid,text,text,text,uuid,text,text,boolean,text)
  from public, anon, authenticated;
revoke all on function public.save_business_profile(uuid,text,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.set_business_persona_membership(uuid,uuid,text,text,boolean,text,text,integer,boolean)
  from public, anon, authenticated;
revoke all on function public.save_business_mission_item(uuid,uuid,text,text,integer,boolean,text)
  from public, anon, authenticated;
revoke all on function public.my_persona_family(uuid)
  from public, anon, authenticated;
revoke all on function public.persona_family_by_handle(text)
  from public, anon, authenticated;
revoke all on function public.business_page_by_slug(text)
  from public, anon, authenticated;

grant execute on function public.set_persona_family_relationship(uuid,uuid,uuid,text,text,text,text,text)
  to authenticated;
grant execute on function public.delete_persona_family_relationship(uuid)
  to authenticated;
grant execute on function public.save_persona_project(uuid,text,text,text,text,text)
  to authenticated;
grant execute on function public.set_persona_project_membership(uuid,uuid,text,boolean)
  to authenticated;
grant execute on function public.save_project_resource(uuid,uuid,text,text,text,uuid,text,text,boolean,text)
  to authenticated;
grant execute on function public.save_business_profile(uuid,text,text,text,text,text,text)
  to authenticated;
grant execute on function public.set_business_persona_membership(uuid,uuid,text,text,boolean,text,text,integer,boolean)
  to authenticated;
grant execute on function public.save_business_mission_item(uuid,uuid,text,text,integer,boolean,text)
  to authenticated;
grant execute on function public.my_persona_family(uuid)
  to authenticated;
grant execute on function public.persona_family_by_handle(text)
  to anon, authenticated;
grant execute on function public.business_page_by_slug(text)
  to anon, authenticated;

comment on table public.persona_family_relationships is
  'Owner-private canonical family edges. Public visibility is explicit and off by default.';
comment on table public.persona_projects is
  'Owner projects that group personas and bounded resources; persona roles do not grant authentication authority.';
comment on table public.project_resources is
  'Owner-only project resource metadata. Never stores passwords, API keys, OAuth tokens, or database credentials.';
comment on column public.business_persona_memberships.public_title is
  'Optional presentation text such as Spokesperson. It never grants a site or provider permission.';

-- ----------------------------------------------------------------------
-- Exact Castleborn seed. It is skipped on empty installations. If WAIS exists,
-- the seed is all-or-nothing and rejects a partial or cross-owner roster.
-- ----------------------------------------------------------------------
do $$
declare
  v_owner uuid;
  v_project_id uuid;
  v_business_id uuid;
  v_missing text[];
  v_expected text[] := array[
    'wais','justiceright','castleborn.rohan','castleborn.maria',
    'castleborn.alexei','castleborn.cillian','castleborn.akiko',
    'castleborn.yarra','castleborn.sophia','castleborn.kunuk',
    'castleborn.avi','castleborn.lilly','castleborn.brom','castleborn.zara',
    'castleborn.song','castleborn.rhythm','castleborn.lyric','castleborn.adam',
    'castleborn.fenrir','castleborn.hecatia','castleborn.adeola'
  ];
begin
  select owner into v_owner from public.personas where handle='wais';
  if v_owner is null then
    raise notice 'WAIS is absent; Castleborn relationship and project seed skipped';
    return;
  end if;

  select array_agg(expected_handle order by expected_handle) into v_missing
  from unnest(v_expected) expected_handle
  where not exists (
    select 1 from public.personas persona
    where persona.handle=expected_handle and persona.owner=v_owner
  );
  if coalesce(array_length(v_missing,1),0)>0 then
    raise exception 'Castleborn seed refused because required same-owner personas are missing: %',v_missing;
  end if;

  with edge(parent_handle,child_handle) as (values
    ('castleborn.rohan','castleborn.avi'),
    ('castleborn.maria','castleborn.avi'),
    ('castleborn.rohan','castleborn.lilly'),
    ('castleborn.sophia','castleborn.lilly'),
    ('castleborn.adeola','castleborn.brom'),
    ('castleborn.alexei','castleborn.brom'),
    ('castleborn.adeola','castleborn.zara'),
    ('castleborn.alexei','castleborn.zara'),
    ('castleborn.cillian','castleborn.song'),
    ('castleborn.akiko','castleborn.song'),
    ('castleborn.cillian','castleborn.rhythm'),
    ('castleborn.akiko','castleborn.rhythm'),
    ('castleborn.cillian','castleborn.lyric'),
    ('castleborn.akiko','castleborn.lyric'),
    ('castleborn.kunuk','castleborn.adam'),
    ('castleborn.yarra','castleborn.adam'),
    ('justiceright','castleborn.fenrir'),
    ('castleborn.sophia','castleborn.fenrir'),
    ('justiceright','castleborn.hecatia'),
    ('castleborn.sophia','castleborn.hecatia')
  )
  insert into public.persona_family_relationships(
    owner,relationship_type,from_persona_id,to_persona_id,
    visibility,canon_status,source_key
  )
  select v_owner,'parent_of',parent.id,child.id,
    'owner_only','working','castleborn-parent-lineage-2026-08-22'
  from edge
  join public.personas parent on parent.handle=edge.parent_handle and parent.owner=v_owner
  join public.personas child on child.handle=edge.child_handle and child.owner=v_owner
  on conflict(owner,relationship_type,from_persona_id,to_persona_id) do nothing;

  with edge(left_handle,right_handle) as (values
    ('castleborn.adeola','castleborn.alexei'),
    ('castleborn.cillian','castleborn.akiko'),
    ('castleborn.kunuk','castleborn.yarra'),
    ('justiceright','castleborn.sophia')
  )
  insert into public.persona_family_relationships(
    owner,relationship_type,from_persona_id,to_persona_id,
    visibility,canon_status,source_key
  )
  select v_owner,'partner',least(left_persona.id,right_persona.id),
    greatest(left_persona.id,right_persona.id),
    'owner_only','working','castleborn-parent-lineage-2026-08-22'
  from edge
  join public.personas left_persona on left_persona.handle=edge.left_handle and left_persona.owner=v_owner
  join public.personas right_persona on right_persona.handle=edge.right_handle and right_persona.owner=v_owner
  on conflict(owner,relationship_type,from_persona_id,to_persona_id) do nothing;

  insert into public.persona_projects(owner,slug,name,description,project_status,visibility)
  values(v_owner,'castleborn','Castleborn',
    'Owner-private shared project for the current Castleborn persona roster.',
    'active','owner_only')
  on conflict(owner,slug) do nothing;
  select id into v_project_id from public.persona_projects
    where owner=v_owner and slug='castleborn';

  insert into public.persona_project_memberships(project_id,persona_id,owner,role)
  select v_project_id,persona.id,v_owner,
    case when persona.handle='wais' then 'manager' else 'member' end
  from public.personas persona
  where persona.owner=v_owner and persona.handle=any(v_expected)
  on conflict(project_id,persona_id) do nothing;

  insert into public.businesses(
    owner,slug,display_name,short_bio,mission,page_status,visibility,published_at
  ) values(v_owner,'castleborn','Castleborn','','','draft','owner_only',null)
  on conflict(slug) do nothing;
  select id into v_business_id from public.businesses
    where owner=v_owner and slug='castleborn';
  if v_business_id is null then
    raise exception 'The Castleborn business slug is already owned by another account';
  end if;
end
$$;

commit;
