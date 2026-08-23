-- 051-publication-social-security-governance.sql
-- Reviewed persona publication, immediate public follows, policy-gated friend
-- requests, account-feed sync preferences, feature/extension review queues,
-- staff-role foundations, and abuse/audit controls.
--
-- Additive source only. This migration does not publish a page, grant a staff
-- role, connect a provider, send email, enable an Auth Hook, activate a WAF,
-- or execute uploaded code. Those remain explicit release/owner operations.
-- Apply only after migrations 049 and 050.

begin;

create extension if not exists pgcrypto with schema extensions;

-- One database boundary is authoritative for every public URL consumer. It
-- accepts only credential-free HTTPS URLs whose hostname and optional port are
-- also accepted by the Edge URL parser; optional fields may be blank.
create or replace function public.is_safe_credential_free_https_url(
  p_value text,p_allow_empty boolean default false
)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  v_url text:=coalesce(p_value,'');v_tail text;v_authority text;v_remainder text;
  v_host text;v_port_text text;v_label text;
begin
  if v_url='' then return p_allow_empty; end if;
  if v_url<>trim(v_url) or char_length(v_url)>2048
     or lower(left(v_url,8))<>'https://'
     or v_url~'[[:cntrl:][:space:]<>]' or position(chr(92) in v_url)>0 then
    return false;
  end if;
  v_tail:=substr(v_url,9);
  v_authority:=split_part(split_part(split_part(v_tail,'/',1),'?',1),'#',1);
  v_remainder:=substr(v_tail,char_length(v_authority)+1);
  if v_authority='' or position('@' in v_authority)>0
     or (v_remainder<>'' and left(v_remainder,1) not in ('/','?','#')) then
    return false;
  end if;
  if v_authority~':[0-9]+$' then
    v_port_text:=substring(v_authority from ':([0-9]+)$');
    v_host:=left(v_authority,char_length(v_authority)-char_length(v_port_text)-1);
    if char_length(v_port_text)>5 or v_port_text::integer not between 1 and 65535 then return false; end if;
  else
    v_host:=v_authority;
    if position(':' in v_host)>0 then return false; end if;
  end if;
  if char_length(v_host) not between 1 and 253
     or position('.' in v_host)=0
     or lower(v_host) in ('localhost','localhost.localdomain')
     or lower(v_host)~'\.(localhost|local|internal|lan)$'
     or v_host~'^[0-9.]+$'
     or v_host~*'^(?:[0-9]+|0x[0-9a-f]+)(?:\.(?:[0-9]+|0x[0-9a-f]+))+$'
     then return false; end if;
  if v_host!~'^[0-9.]+$' then
    foreach v_label in array string_to_array(v_host,'.') loop
      if char_length(v_label) not between 1 and 63
         or v_label!~'^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$' then return false; end if;
    end loop;
  end if;
  return true;
end;
$$;
revoke all on function public.is_safe_credential_free_https_url(text,boolean)
  from public,anon,authenticated;

-- The legacy persona bundle accepted an arbitrary JSON object for modules.
-- Keep one small, reviewable schema so unknown keys or non-boolean values can
-- never become public without appearing in the exact review manifest.
create or replace function public.persona_modules_are_canonical(p_modules jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when p_modules is null then true
    when jsonb_typeof(p_modules)<>'object' then false
    else not exists (
      select 1 from jsonb_each(p_modules) item
      where item.key not in (
        'live','music','about','fan_chat','links','top8','linked','family',
        'revenue','albums','feed'
      ) or jsonb_typeof(item.value)<>'boolean'
    )
  end
$$;

create or replace function public.canonical_persona_modules(p_modules jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'live',coalesce((p_modules->'live')<>'false'::jsonb,true),
    'music',coalesce((p_modules->'music')<>'false'::jsonb,true),
    'about',coalesce((p_modules->'about')<>'false'::jsonb,true),
    'fan_chat',coalesce((p_modules->'fan_chat')<>'false'::jsonb,true),
    'links',coalesce((p_modules->'links')<>'false'::jsonb,true),
    'top8',coalesce((p_modules->'top8')<>'false'::jsonb,true),
    'linked',coalesce((p_modules->'linked')<>'false'::jsonb,true),
    'family',coalesce((p_modules->'family')<>'false'::jsonb,true),
    'revenue',coalesce((p_modules->'revenue')<>'false'::jsonb,true),
    'albums',coalesce((p_modules->'albums')<>'false'::jsonb,true),
    'feed',coalesce((p_modules->'feed')<>'false'::jsonb,true)
  )
$$;

revoke all on function public.persona_modules_are_canonical(jsonb),
  public.canonical_persona_modules(jsonb)
  from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- Persona publication lifecycle and transparent AI disclosure
-- ---------------------------------------------------------------------------

alter table public.personas add column if not exists publication_state text;
alter table public.personas add column if not exists publication_revision integer not null default 1;
alter table public.personas add column if not exists published_revision integer;
alter table public.personas add column if not exists published_at timestamptz;
alter table public.personas add column if not exists unpublished_at timestamptz;
alter table public.personas add column if not exists updated_at timestamptz not null default now();
update public.personas
set publication_state = 'unpublished',
    published_revision = null,
    published_at = null,
    unpublished_at = now()
where publication_state is null;
alter table public.personas alter column publication_state set default 'draft';
alter table public.personas alter column publication_state set not null;
alter table public.personas drop constraint if exists personas_publication_state_check;
alter table public.personas add constraint personas_publication_state_check
  check (publication_state in ('draft','in_review','published','unpublished'));

alter table public.personas add column if not exists ai_disclosure text not null default
  'This is an AI-assisted persona. Public content may be drafted with AI and is owner-reviewed unless stated otherwise.';
alter table public.personas drop constraint if exists personas_ai_disclosure_len;
alter table public.personas add constraint personas_ai_disclosure_len
  check (char_length(ai_disclosure) between 1 and 1000);
create table if not exists public.persona_publication_reviews (
  persona_id          uuid primary key,
  owner               uuid not null references public.profiles(id) on delete cascade,
  intention           text not null default '' check (char_length(intention) <= 12000),
  owner_review_notes  text not null default '' check (char_length(owner_review_notes) <= 12000),
  readiness_snapshot  jsonb not null default '{}'::jsonb,
  required_missing    integer not null default 0 check (required_missing >= 0),
  review_state        text not null default 'draft'
                      check (review_state in ('draft','in_review','changes_requested','ready','published','stale')),
  reviewed_revision   integer not null default 0 check (reviewed_revision >= 0),
  submitted_at        timestamptz,
  reviewed_at         timestamptz,
  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);

create index if not exists persona_publication_reviews_owner_idx
  on public.persona_publication_reviews(owner, review_state, updated_at desc);

-- A published page can render public identity cards for other personas through
-- Top 8, linked-persona, and public family sections. Store the exact reviewed
-- projection fingerprint rather than synchronously updating every dependent
-- persona when one card changes. Public visibility then fails closed on drift.
-- dependency_persona_id intentionally has no foreign key: deleting a referenced
-- persona must leave a detectable missing dependency, not silently cascade the
-- evidence away and make the referring page look current.
create table if not exists public.persona_publication_dependency_sets (
  persona_id          uuid primary key,
  owner               uuid not null,
  reviewed_revision   integer not null check (reviewed_revision > 0),
  manifest_sha256     text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  dependency_count    integer not null check (dependency_count between 0 and 308),
  captured_at         timestamptz not null default now(),
  unique (persona_id, owner),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);

create table if not exists public.persona_publication_dependencies (
  persona_id             uuid not null,
  owner                  uuid not null,
  dependency_persona_id  uuid not null,
  dependency_kind        text not null check (dependency_kind in ('top8','linked','family')),
  projection_sha256      text not null check (projection_sha256 ~ '^[0-9a-f]{64}$'),
  dependency_revision    integer not null check (dependency_revision > 0),
  created_at             timestamptz not null default now(),
  primary key (persona_id, dependency_persona_id, dependency_kind),
  foreign key (persona_id, owner)
    references public.persona_publication_dependency_sets(persona_id, owner) on delete cascade
);

create index if not exists persona_publication_dependencies_dependency_idx
  on public.persona_publication_dependencies(dependency_persona_id, persona_id);

create or replace function public.persona_dependency_projection_hash(
  p_dependency_persona_id uuid,p_dependency_kind text
)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'kind',p_dependency_kind,
    'handle',relative.handle,
    'name',relative.name,
    'tagline',case when p_dependency_kind='linked' then coalesce(relative.tagline,'') else '' end,
    'avatar_url',coalesce(relative.avatar_url,''),
    'eligible_visibility',case when p_dependency_kind='family'
      then relative.visibility='public'
      else relative.visibility in ('public','unlisted') end
  )::text,'UTF8'),'sha256'),'hex')
  from public.personas relative
  where relative.id=p_dependency_persona_id
    and p_dependency_kind in ('top8','linked','family')
$$;

revoke all on function public.persona_dependency_projection_hash(uuid,text)
  from public,anon,authenticated;

-- Every mutation RPC that can lock both a persona row and one of its content
-- rows takes the same persona-scoped transaction lock first. This prevents the
-- draft/content lock inversion without serializing unrelated accounts.
create or replace function public.lock_persona_publication_mutation(p_persona_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_persona_id is null then raise exception 'Persona id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_persona_id::text,51051051)
  );
end;
$$;

revoke all on function public.lock_persona_publication_mutation(uuid)
  from public,anon,authenticated;

-- New owner-authored rows are bounded under one account-scoped transaction
-- lock. Creation RPCs take this lock before any persona publication lock so
-- concurrent requests cannot race the aggregate/day caps or invert lock order.
create or replace function public.lock_owner_content_creation_quota(p_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner is null or p_owner is distinct from auth.uid() then
    raise exception 'Authenticated owner is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051056)
  );
end;
$$;

revoke all on function public.lock_owner_content_creation_quota(uuid)
  from public,anon,authenticated,service_role;

create index if not exists personas_owner_created_quota_idx
  on public.personas(owner,created_at,id);
create index if not exists albums_persona_created_quota_idx
  on public.albums(persona_id,created_at,id);
create index if not exists album_items_album_created_quota_idx
  on public.album_items(album_id,created_at,id);
create index if not exists affiliate_products_owner_created_quota_idx
  on public.affiliate_products(owner,created_at,id);
create index if not exists persona_affiliate_offers_owner_created_quota_idx
  on public.persona_affiliate_offers(owner,created_at,id);
create index if not exists persona_page_code_snippets_owner_created_quota_idx
  on public.persona_page_code_snippets(owner,created_at,id);

-- Family, project, membership, and project-resource creation shares a separate
-- owner-scoped lock. It must be taken before persona publication locks or
-- project rows so concurrent browser requests cannot race owner/day caps.
create or replace function public.lock_owner_persona_org_creation_quota(p_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner is null or p_owner is distinct from auth.uid() then
    raise exception 'Authenticated owner is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051058)
  );
end;
$$;

revoke all on function public.lock_owner_persona_org_creation_quota(uuid)
  from public,anon,authenticated,service_role;

-- Live-row counts are useful storage caps but are not rate limits: deleting a
-- row used to erase the evidence and permit an unlimited create/delete loop.
-- Keep exactly one durable UTC-day counter per owner/scope. The observed count
-- bootstraps accounts that already created rows earlier on migration day; an
-- atomic upsert preserves the high-water mark after those rows are removed.
create table if not exists public.owner_daily_rate_usage (
  owner        uuid not null references public.profiles(id) on delete cascade,
  scope        text not null check (scope ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  window_start date not null,
  hit_count    integer not null check (hit_count between 0 and 100000),
  updated_at   timestamptz not null default now(),
  primary key (owner,scope)
);

alter table public.owner_daily_rate_usage enable row level security;
revoke all on public.owner_daily_rate_usage
  from public,anon,authenticated,service_role;

create or replace function public.consume_owner_daily_rate(
  p_owner uuid,p_scope text,p_limit integer,p_units integer default 1,
  p_observed integer default 0
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_today date:=(now() at time zone 'UTC')::date;
  v_count integer;v_initial integer:=greatest(coalesce(p_observed,0),0)+p_units;
begin
  if p_owner is null or p_owner is distinct from auth.uid() then
    raise exception 'Authenticated owner is required';
  end if;
  if coalesce(p_scope,'')!~'^[a-z0-9][a-z0-9_.:-]{0,63}$'
     or p_limit not between 1 and 100000 or p_units not between 1 and p_limit
     or coalesce(p_observed,-1)<0 then
    raise exception 'Invalid retained daily usage request';
  end if;
  if v_initial>p_limit then
    raise exception '% daily retained usage limit reached (%)',p_scope,p_limit;
  end if;
  insert into public.owner_daily_rate_usage as usage(
    owner,scope,window_start,hit_count,updated_at
  ) values(p_owner,p_scope,v_today,v_initial,now())
  on conflict(owner,scope) do update set
    window_start=excluded.window_start,
    hit_count=case when usage.window_start=excluded.window_start
      then greatest(usage.hit_count,greatest(p_observed,0))+p_units
      else v_initial end,
    updated_at=now()
  where case when usage.window_start=excluded.window_start
      then greatest(usage.hit_count,greatest(p_observed,0))+p_units
      else v_initial end <=p_limit
  returning hit_count into v_count;
  if v_count is null then
    raise exception '% daily retained usage limit reached (%)',p_scope,p_limit;
  end if;
  return v_count;
end;
$$;

revoke all on function public.consume_owner_daily_rate(uuid,text,integer,integer,integer)
  from public,anon,authenticated,service_role;

create or replace function public.project_resource_text_has_secret(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_value,'') ~* concat(
    '(password|passcode|api[ _-]?key|client[ _-]?secret|secret[ _-]?access[ _-]?key|',
    'access[ _-]?token|refresh[ _-]?token|authorization|bearer|private[ _-]?key)',
    '[[:space:]]*[:=][[:space:]]*[^[:space:]]{4,}|',
    'bearer[[:space:]]+[A-Za-z0-9._~+/-]{12,}|',
    '(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|',
    'AKIA[A-Z0-9]{16})([^A-Za-z0-9]|$)|',
    '-----BEGIN[[:space:]][A-Z0-9 ]*PRIVATE KEY-----|',
    '[A-Za-z][A-Za-z0-9+.-]*://[^/?#[:space:]]+@'
  )
$$;

revoke all on function public.project_resource_text_has_secret(text)
  from public,anon,authenticated,service_role;

create index if not exists persona_family_owner_created_quota_idx
  on public.persona_family_relationships(owner,created_at,id);
create index if not exists persona_projects_owner_created_quota_idx
  on public.persona_projects(owner,created_at,id);
create index if not exists persona_project_memberships_owner_created_quota_idx
  on public.persona_project_memberships(owner,created_at,project_id,persona_id);
create index if not exists persona_project_memberships_project_count_idx
  on public.persona_project_memberships(owner,project_id,persona_id);
create index if not exists project_resources_owner_created_quota_idx
  on public.project_resources(owner,created_at,project_id,id);
create index if not exists project_resources_project_count_idx
  on public.project_resources(owner,project_id,id);

-- Owner browsers retain SELECT for export and use only reviewed mutation RPCs.
-- Service-created/edited organization rows must use a lock-first service path;
-- account erasure uses the service-only cleanup wrapper defined below.
revoke insert,update,delete on public.persona_family_relationships,
  public.persona_projects,public.persona_project_memberships,
  public.project_resources from authenticated;
revoke insert,update,delete on public.persona_family_relationships,
  public.persona_projects,public.persona_project_memberships,
  public.project_resources from service_role;

-- Direct service writes to backup pairs used to take the backup row before the
-- trigger's owner-profile lock. Revoke that inversion and expose one service-
-- only wrapper that takes the same owner lock as the authenticated RPC first.
revoke insert,update,delete on public.persona_backup_relationships
  from service_role;

create or replace function public.set_persona_backup_service(
  p_owner uuid,p_main_persona_id uuid,p_backup_persona_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null or p_main_persona_id is null then
    raise exception 'Owner and main persona are required';
  end if;

  perform 1 from public.profiles profile
  where profile.id=p_owner for update;
  if not found then raise exception 'Owner profile not found'; end if;

  perform 1 from public.personas persona
  where persona.id=p_main_persona_id and persona.owner=p_owner for update;
  if not found then raise exception 'Owned main persona not found'; end if;

  if p_backup_persona_id is null then
    delete from public.persona_backup_relationships relationship
    where relationship.owner=p_owner
      and relationship.main_persona_id=p_main_persona_id;
    return null;
  end if;
  if p_backup_persona_id=p_main_persona_id then
    raise exception 'A persona cannot be its own backup';
  end if;

  perform 1 from public.personas persona
  where persona.id=p_backup_persona_id and persona.owner=p_owner for update;
  if not found then raise exception 'Owned backup persona not found'; end if;

  insert into public.persona_backup_relationships(
    owner,main_persona_id,backup_persona_id
  ) values(p_owner,p_main_persona_id,p_backup_persona_id)
  on conflict(main_persona_id) do update
  set backup_persona_id=excluded.backup_persona_id,updated_at=now();
  return p_backup_persona_id;
end;
$$;

revoke all on function public.set_persona_backup_service(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.set_persona_backup_service(uuid,uuid,uuid)
  to service_role;

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
  v_owner uuid:=auth.uid();
  v_id uuid;
  v_from uuid:=p_from_persona_id;
  v_to uuid:=p_to_persona_id;
  v_old_from uuid;
  v_old_to uuid;
  v_lock_id uuid;
  v_is_new boolean:=false;
  v_from_needs_capacity boolean:=false;
  v_to_needs_capacity boolean:=false;
  v_owner_total integer;
  v_owner_day integer;
  v_from_total integer;
  v_to_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
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
  if p_relationship_type='partner' and v_to<v_from then
    v_id:=v_from;v_from:=v_to;v_to:=v_id;
  end if;
  if v_from=v_to then raise exception 'A persona cannot be related to itself'; end if;

  -- Serialize both inserts and endpoint moves before reading or locking a
  -- relationship row. This makes the later capacity recheck race-free.
  perform public.lock_owner_persona_org_creation_quota(v_owner);
  if not exists(
    select 1 from public.personas persona
    where persona.id in (v_from,v_to) and persona.owner=v_owner
    group by persona.owner having count(*)=2
  ) then raise exception 'Both personas must belong to this account'; end if;

  if p_relationship_id is not null then
    select relationship.from_persona_id,relationship.to_persona_id
    into v_old_from,v_old_to
    from public.persona_family_relationships relationship
    where relationship.id=p_relationship_id and relationship.owner=v_owner
    for update;
    if not found then raise exception 'Owned relationship not found'; end if;
  end if;

  for v_lock_id in select distinct id
    from unnest(array[v_from,v_to,v_old_from,v_old_to]) id
    where id is not null order by id
  loop
    perform public.lock_persona_publication_mutation(v_lock_id);
  end loop;

  -- Recheck existence and every applicable capacity only after the owner,
  -- existing row, and sorted endpoint locks are held.
  if p_relationship_id is null then
    select not exists(
      select 1 from public.persona_family_relationships relationship
      where relationship.owner=v_owner
        and relationship.relationship_type=p_relationship_type
        and relationship.from_persona_id=v_from
        and relationship.to_persona_id=v_to
    ) into v_is_new;
  end if;
  v_from_needs_capacity:=v_is_new or not (v_from=any(array[v_old_from,v_old_to]));
  v_to_needs_capacity:=v_is_new or not (v_to=any(array[v_old_from,v_old_to]));

  if v_is_new then
    select count(*) into v_owner_total from (
      select 1 from public.persona_family_relationships relationship
      where relationship.owner=v_owner limit 1000
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.persona_family_relationships relationship
      where relationship.owner=v_owner and relationship.created_at>=v_day
        and relationship.created_at<v_day+interval '1 day' limit 100
    ) quota;
    if v_owner_total>=1000 then
      raise exception 'Family relationship account limit reached (1000)'; end if;
    if v_owner_day>=100 then
      raise exception 'Family relationship daily creation limit reached (100 UTC)'; end if;
    perform public.consume_owner_daily_rate(
      v_owner,'family_relationships',100,1,v_owner_day
    );
  end if;
  if v_from_needs_capacity then
    select count(*) into v_from_total from (
      select 1 from public.persona_family_relationships relationship
      where relationship.owner=v_owner
        and relationship.id is distinct from p_relationship_id and (
        relationship.from_persona_id=v_from or relationship.to_persona_id=v_from
      ) limit 100
    ) quota;
    if v_from_total>=100 then
      raise exception 'Family relationship persona limit reached (100)'; end if;
  end if;
  if v_to_needs_capacity then
    select count(*) into v_to_total from (
      select 1 from public.persona_family_relationships relationship
      where relationship.owner=v_owner
        and relationship.id is distinct from p_relationship_id and (
        relationship.from_persona_id=v_to or relationship.to_persona_id=v_to
      ) limit 100
    ) quota;
    if v_to_total>=100 then
      raise exception 'Family relationship persona limit reached (100)'; end if;
  end if;

  if p_relationship_id is null then
    insert into public.persona_family_relationships(
      owner,relationship_type,from_persona_id,to_persona_id,
      visibility,canon_status,source_key,owner_notes
    ) values(
      v_owner,p_relationship_type,v_from,v_to,p_visibility,p_canon_status,
      left(coalesce(p_source_key,''),200),left(coalesce(p_owner_notes,''),4000)
    )
    on conflict(owner,relationship_type,from_persona_id,to_persona_id)
    do update set visibility=excluded.visibility,
      canon_status=excluded.canon_status,source_key=excluded.source_key,
      owner_notes=excluded.owner_notes,updated_at=now()
    returning id into v_id;
  else
    update public.persona_family_relationships relationship
    set from_persona_id=v_from,to_persona_id=v_to,
      visibility=p_visibility,canon_status=p_canon_status,
      source_key=left(coalesce(p_source_key,''),200),
      owner_notes=left(coalesce(p_owner_notes,''),4000)
    where relationship.id=p_relationship_id
      and relationship.owner=v_owner
      and relationship.relationship_type=p_relationship_type
    returning relationship.id into v_id;
    if v_id is null then raise exception 'Owned relationship not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_persona_family_relationship(
  p_relationship_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid:=auth.uid();v_count integer;v_from uuid;v_to uuid;v_lock_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_owner_persona_org_creation_quota(v_owner);
  select relationship.from_persona_id,relationship.to_persona_id into v_from,v_to
  from public.persona_family_relationships relationship
  where relationship.id=p_relationship_id and relationship.owner=v_owner;
  if not found then return false; end if;
  for v_lock_id in select distinct id from unnest(array[v_from,v_to]) id order by id
  loop perform public.lock_persona_publication_mutation(v_lock_id); end loop;
  delete from public.persona_family_relationships relationship
  where relationship.id=p_relationship_id and relationship.owner=v_owner;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;

-- Legacy owners above a modern per-persona cap can retire or delete edges in
-- deterministic batches. Each call touches at most 100 rows and locks every
-- affected persona in sorted order before any relationship mutation.
create or replace function public.bulk_manage_persona_family_relationships(
  p_persona_id uuid,p_action text default 'delete',p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_limit integer:=least(greatest(coalesce(p_limit,100),1),100);
  v_ids uuid[];
  v_lock_id uuid;
  v_count integer:=0;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if coalesce(p_action,'') not in ('delete','retire') then
    raise exception 'Family bulk action must be delete or retire';
  end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  perform public.lock_owner_persona_org_creation_quota(v_owner);

  select coalesce(pg_catalog.array_agg(candidate.id order by candidate.id),'{}'::uuid[])
  into v_ids from (
    select relationship.id from public.persona_family_relationships relationship
    where relationship.owner=v_owner and (
      relationship.from_persona_id=p_persona_id
      or relationship.to_persona_id=p_persona_id
    ) order by relationship.id limit v_limit
  ) candidate;
  if pg_catalog.cardinality(v_ids)=0 then return 0; end if;

  for v_lock_id in
    select endpoint.id from (
      select relationship.from_persona_id as id
      from public.persona_family_relationships relationship
      where relationship.owner=v_owner and relationship.id=any(v_ids)
      union
      select relationship.to_persona_id as id
      from public.persona_family_relationships relationship
      where relationship.owner=v_owner and relationship.id=any(v_ids)
    ) endpoint order by endpoint.id
  loop perform public.lock_persona_publication_mutation(v_lock_id); end loop;

  if p_action='retire' then
    update public.persona_family_relationships relationship
    set canon_status='retired',visibility='owner_only',updated_at=now()
    where relationship.owner=v_owner and relationship.id=any(v_ids);
  else
    delete from public.persona_family_relationships relationship
    where relationship.owner=v_owner and relationship.id=any(v_ids);
  end if;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

create or replace function public.save_persona_project(
  p_project_id uuid,p_slug text,p_name text,p_description text default '',
  p_project_status text default 'active',p_visibility text default 'owner_only'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_id uuid;
  v_slug text:=lower(trim(p_slug));
  v_owner_total integer;
  v_owner_day integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if v_slug!~'^[a-z0-9][a-z0-9-]{2,79}$' then raise exception 'Invalid project slug'; end if;
  if trim(coalesce(p_name,''))='' or char_length(p_name)>160 then
    raise exception 'Invalid project name'; end if;
  if p_project_status not in ('active','paused','archived') then
    raise exception 'Invalid project status'; end if;
  if p_visibility not in ('owner_only','friends','followers','public') then
    raise exception 'Invalid project visibility'; end if;

  if p_project_id is null then
    perform public.lock_owner_persona_org_creation_quota(v_owner);
    select count(*) into v_owner_total from (
      select 1 from public.persona_projects project
      where project.owner=v_owner limit 100
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.persona_projects project
      where project.owner=v_owner and project.created_at>=v_day
        and project.created_at<v_day+interval '1 day' limit 20
    ) quota;
    if v_owner_total>=100 then raise exception 'Project account limit reached (100)'; end if;
    if v_owner_day>=20 then raise exception 'Project daily creation limit reached (20 UTC)'; end if;
    perform public.consume_owner_daily_rate(v_owner,'persona_projects',20,1,v_owner_day);
    insert into public.persona_projects(
      owner,slug,name,description,project_status,visibility
    ) values(
      v_owner,v_slug,trim(p_name),left(coalesce(p_description,''),4000),
      p_project_status,p_visibility
    ) returning id into v_id;
  else
    update public.persona_projects project
    set slug=v_slug,name=trim(p_name),
      description=left(coalesce(p_description,''),4000),
      project_status=p_project_status,visibility=p_visibility
    where project.id=p_project_id and project.owner=v_owner
    returning project.id into v_id;
    if v_id is null then raise exception 'Owned project not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_persona_project(p_project_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid:=auth.uid();v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform 1 from public.persona_projects project
  where project.id=p_project_id and project.owner=v_owner for update;
  if not found then return false; end if;
  delete from public.persona_projects project
  where project.id=p_project_id and project.owner=v_owner;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;

create or replace function public.set_persona_project_membership(
  p_project_id uuid,p_persona_id uuid,p_role text default 'member',
  p_remove boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_remove boolean:=coalesce(p_remove,false);
  v_is_new boolean:=false;
  v_owner_total integer;
  v_owner_day integer;
  v_project_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_role not in ('manager','member','reviewer') then
    raise exception 'Invalid project role'; end if;

  -- Any non-removal request may become an insert. Serialize before taking the
  -- project row lock, then re-check the composite key while holding both.
  if not v_remove then
    perform public.lock_owner_persona_org_creation_quota(v_owner);
  end if;
  perform 1 from public.persona_projects project
  where project.id=p_project_id and project.owner=v_owner for update;
  if not found then raise exception 'Owned project not found'; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;

  if v_remove then
    delete from public.persona_project_memberships membership
    where membership.project_id=p_project_id
      and membership.persona_id=p_persona_id and membership.owner=v_owner;
    return true;
  end if;

  select not exists(
    select 1 from public.persona_project_memberships membership
    where membership.project_id=p_project_id
      and membership.persona_id=p_persona_id and membership.owner=v_owner
  ) into v_is_new;
  if v_is_new then
    select count(*) into v_owner_total from (
      select 1 from public.persona_project_memberships membership
      where membership.owner=v_owner limit 5000
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.persona_project_memberships membership
      where membership.owner=v_owner and membership.created_at>=v_day
        and membership.created_at<v_day+interval '1 day' limit 200
    ) quota;
    select count(*) into v_project_total from (
      select 1 from public.persona_project_memberships membership
      where membership.owner=v_owner and membership.project_id=p_project_id limit 100
    ) quota;
    if v_owner_total>=5000 then
      raise exception 'Project membership account limit reached (5000)'; end if;
    if v_owner_day>=200 then
      raise exception 'Project membership daily creation limit reached (200 UTC)'; end if;
    if v_project_total>=100 then
      raise exception 'Project membership project limit reached (100)'; end if;
    perform public.consume_owner_daily_rate(
      v_owner,'project_memberships',200,1,v_owner_day
    );
  end if;

  insert into public.persona_project_memberships(
    project_id,persona_id,owner,role
  ) values(p_project_id,p_persona_id,v_owner,p_role)
  on conflict(project_id,persona_id) do update
  set role=excluded.role,updated_at=now();
  return true;
end;
$$;

create or replace function public.save_project_resource(
  p_resource_id uuid,p_project_id uuid,p_resource_type text,
  p_display_name text,p_resource_locator text default '',
  p_account_ledger_id uuid default null,p_access_mode text default 'reference',
  p_connection_state text default 'not_configured',p_enabled boolean default false,
  p_owner_notes text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_id uuid;
  v_existing_project_id uuid;
  v_locator text:=trim(coalesce(p_resource_locator,''));
  v_notes text:=trim(coalesce(p_owner_notes,''));
  v_owner_total integer;
  v_owner_day integer;
  v_project_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_resource_type not in (
    'database','repository','drive_folder','document_library','website','other'
  ) then raise exception 'Invalid project resource type'; end if;
  if p_access_mode not in ('reference','read_only') then
    raise exception 'Invalid project access mode'; end if;
  if p_connection_state not in ('not_configured','ready','blocked','disabled') then
    raise exception 'Invalid project connection state'; end if;
  if trim(coalesce(p_display_name,''))='' or char_length(p_display_name)>200 then
    raise exception 'Invalid project resource name'; end if;
  if char_length(v_locator)>2048 or char_length(v_notes)>4000
     or v_locator~'[[:cntrl:]]'
     or pg_catalog.regexp_replace(v_notes,E'[\t\r\n]','','g')~'[[:cntrl:]]' then
    raise exception 'Project resource metadata is too long or contains control characters';
  end if;
  if public.project_resource_text_has_secret(v_locator)
     or public.project_resource_text_has_secret(v_notes) then
    raise exception 'Project resource metadata appears to contain a credential; store only a safe reference';
  end if;
  if v_locator<>'' then
    if v_locator~*'^[A-Za-z][A-Za-z0-9+.-]*://' then
      if not public.is_safe_credential_free_https_url(v_locator,false)
         or position('?' in v_locator)>0 or position('#' in v_locator)>0 then
        raise exception 'Project resource URLs must be credential-free HTTPS without a query or fragment';
      end if;
    elsif v_locator!~'^[A-Za-z0-9][A-Za-z0-9._:/-]*$' then
      raise exception 'Project resource locator must be HTTPS or a bounded opaque reference';
    end if;
  end if;

  if p_resource_id is null then
    perform public.lock_owner_persona_org_creation_quota(v_owner);
  else
    select resource.project_id into v_existing_project_id
    from public.project_resources resource
    where resource.id=p_resource_id and resource.owner=v_owner;
    if not found then raise exception 'Owned project resource not found'; end if;
    if v_existing_project_id is distinct from p_project_id then
      raise exception 'Project resources cannot move between projects; delete and recreate the resource';
    end if;
  end if;

  perform 1 from public.persona_projects project
  where project.id=p_project_id and project.owner=v_owner for update;
  if not found then raise exception 'Owned project not found'; end if;
  if p_account_ledger_id is not null and not exists(
    select 1 from public.account_ledger account
    where account.id=p_account_ledger_id and account.owner=v_owner
  ) then raise exception 'Owned account ledger entry not found'; end if;

  if p_resource_id is null then
    select count(*) into v_owner_total from (
      select 1 from public.project_resources resource
      where resource.owner=v_owner limit 1000
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.project_resources resource
      where resource.owner=v_owner and resource.created_at>=v_day
        and resource.created_at<v_day+interval '1 day' limit 50
    ) quota;
    select count(*) into v_project_total from (
      select 1 from public.project_resources resource
      where resource.owner=v_owner and resource.project_id=p_project_id limit 100
    ) quota;
    if v_owner_total>=1000 then
      raise exception 'Project resource account limit reached (1000)'; end if;
    if v_owner_day>=50 then
      raise exception 'Project resource daily creation limit reached (50 UTC)'; end if;
    if v_project_total>=100 then
      raise exception 'Project resource project limit reached (100)'; end if;
    perform public.consume_owner_daily_rate(
      v_owner,'project_resources',50,1,v_owner_day
    );
    insert into public.project_resources(
      project_id,owner,resource_type,display_name,resource_locator,
      account_ledger_id,access_mode,connection_state,enabled,owner_notes
    ) values(
      p_project_id,v_owner,p_resource_type,trim(p_display_name),
      v_locator,p_account_ledger_id,
      p_access_mode,p_connection_state,coalesce(p_enabled,false),
      v_notes
    ) returning id into v_id;
  else
    update public.project_resources resource
    set resource_type=p_resource_type,display_name=trim(p_display_name),
      resource_locator=v_locator,
      account_ledger_id=p_account_ledger_id,access_mode=p_access_mode,
      connection_state=p_connection_state,enabled=coalesce(p_enabled,false),
      owner_notes=v_notes
    where resource.id=p_resource_id and resource.owner=v_owner
      and resource.project_id=p_project_id
    returning resource.id into v_id;
    if v_id is null then raise exception 'Owned project resource not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_project_resource(p_resource_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid:=auth.uid();v_project_id uuid;v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select resource.project_id into v_project_id
  from public.project_resources resource
  where resource.id=p_resource_id and resource.owner=v_owner;
  if not found then return false; end if;
  perform 1 from public.persona_projects project
  where project.id=v_project_id and project.owner=v_owner for update;
  if not found then return false; end if;
  delete from public.project_resources resource
  where resource.id=p_resource_id and resource.owner=v_owner
    and resource.project_id=v_project_id;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;

create or replace function public.delete_persona_org_data_for_account_service(
  p_owner uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_persona_id uuid;
  v_resource_count integer:=0;
  v_project_count integer:=0;
  v_family_count integer:=0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;

  -- The service cannot call the auth.uid()-bound helper. Take its exact owner
  -- advisory key directly, before every project row and persona lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051058)
  );
  if not exists(select 1 from public.profiles profile where profile.id=p_owner) then
    raise exception 'Owner profile not found';
  end if;

  for v_project_id in
    select project.id from public.persona_projects project
    where project.owner=p_owner order by project.id for update
  loop
    null;
  end loop;
  for v_persona_id in
    select endpoint.id from (
      select relationship.from_persona_id as id
      from public.persona_family_relationships relationship
      where relationship.owner=p_owner
      union
      select relationship.to_persona_id as id
      from public.persona_family_relationships relationship
      where relationship.owner=p_owner
    ) endpoint order by endpoint.id
  loop
    perform public.lock_persona_publication_mutation(v_persona_id);
  end loop;

  delete from public.project_resources resource where resource.owner=p_owner;
  get diagnostics v_resource_count=row_count;
  delete from public.persona_projects project where project.owner=p_owner;
  get diagnostics v_project_count=row_count;
  delete from public.persona_family_relationships relationship
  where relationship.owner=p_owner;
  get diagnostics v_family_count=row_count;

  return jsonb_build_object(
    'projectResources',v_resource_count,
    'projects',v_project_count,
    'familyRelationships',v_family_count
  );
end;
$$;

revoke all on function public.set_persona_family_relationship(uuid,uuid,uuid,text,text,text,text,text),
  public.delete_persona_family_relationship(uuid),
  public.bulk_manage_persona_family_relationships(uuid,text,integer),
  public.save_persona_project(uuid,text,text,text,text,text),
  public.delete_persona_project(uuid),
  public.set_persona_project_membership(uuid,uuid,text,boolean),
  public.save_project_resource(uuid,uuid,text,text,text,uuid,text,text,boolean,text),
  public.delete_project_resource(uuid),
  public.delete_persona_org_data_for_account_service(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.set_persona_family_relationship(uuid,uuid,uuid,text,text,text,text,text),
  public.delete_persona_family_relationship(uuid),
  public.bulk_manage_persona_family_relationships(uuid,text,integer),
  public.save_persona_project(uuid,text,text,text,text,text),
  public.delete_persona_project(uuid),
  public.set_persona_project_membership(uuid,uuid,text,boolean),
  public.save_project_resource(uuid,uuid,text,text,text,uuid,text,text,boolean,text),
  public.delete_project_resource(uuid)
  to authenticated;
grant execute on function public.delete_persona_org_data_for_account_service(uuid)
  to service_role;

create index if not exists personas_top8_gin_idx on public.personas using gin(top8);
create index if not exists personas_linked_gin_idx on public.personas using gin(linked);

create or replace function public.mark_persona_public_edit_as_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material_change boolean;
  v_transition text := current_setting('app.persona_publication_transition', true);
  v_touched text := coalesce(current_setting('app.persona_revision_touched',true),'');
begin
  if tg_op = 'INSERT' then
    new.publication_state := 'draft';
    new.publication_revision := 1;
    new.published_revision := null;
    new.published_at := null;
    new.unpublished_at := null;
    new.updated_at := now();
    return new;
  end if;

  if row(new.id,new.owner,new.created_at) is distinct from row(old.id,old.owner,old.created_at) then
    raise exception 'Persona identity, owner, and creation time are immutable';
  end if;

  if row(
    new.publication_state, new.publication_revision, new.published_revision,
    new.published_at, new.unpublished_at
  ) is distinct from row(
    old.publication_state, old.publication_revision, old.published_revision,
    old.published_at, old.unpublished_at
  ) and coalesce(v_transition, '') not in ('review','publish','unpublish','layout','content') then
    raise exception 'Publication lifecycle fields can only be changed through reviewed publication actions';
  end if;

  v_material_change := row(
    new.handle, new.name, new.tagline, new.bio, new.nsfw, new.visibility,
    new.avatar_url, new.banner_url, new.bg_url, new.feed_img_url,
    new.music_url, new.live_url, new.theme, new.topics, new.hashtags,
    new.top8, new.modules, new.linked, new.title, new.focus,
    new.pet_project, new.ai_disclosure, new.purpose, new.voice,
    new.audience, new.dont, new.ai_backend
  ) is distinct from row(
    old.handle, old.name, old.tagline, old.bio, old.nsfw, old.visibility,
    old.avatar_url, old.banner_url, old.bg_url, old.feed_img_url,
    old.music_url, old.live_url, old.theme, old.topics, old.hashtags,
    old.top8, old.modules, old.linked, old.title, old.focus,
    old.pet_project, old.ai_disclosure, old.purpose, old.voice,
    old.audience, old.dont, old.ai_backend
  );

  if v_material_change and position(','||old.id::text||',' in ','||v_touched||',')=0 then
    new.publication_revision := old.publication_revision + 1;
    update public.persona_publication_reviews
    set review_state = 'stale', updated_at = now()
    where persona_id = old.id and owner = old.owner;
    if old.publication_state in ('published','in_review') then
      if old.publication_state = 'published' and v_transition = 'review' then
        new.publication_state := 'in_review';
      else
        new.publication_state := 'draft';
      end if;
      if old.publication_state = 'published' then
        new.unpublished_at := now();
      end if;
    end if;
    v_touched:=concat_ws(',',nullif(v_touched,''),old.id::text);
    perform set_config('app.persona_revision_touched',v_touched,true);
  end if;
  if old.publication_state = 'published'
     and new.publication_state = 'in_review'
     and v_transition = 'review' then
    new.unpublished_at := coalesce(new.unpublished_at, now());
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.mark_persona_public_edit_as_draft()
  from public, anon, authenticated;
drop trigger if exists mark_persona_public_edit_as_draft on public.personas;
create trigger mark_persona_public_edit_as_draft
  before insert or update on public.personas
  for each row execute function public.mark_persona_public_edit_as_draft();

create or replace function public.invalidate_persona_review_revision(p_persona_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touched text:=coalesce(current_setting('app.persona_revision_touched',true),'');
  v_transition text:=current_setting('app.persona_publication_transition',true);
begin
  if p_persona_id is null
     or position(','||p_persona_id::text||',' in ','||v_touched||',')>0 then return; end if;
  v_touched:=concat_ws(',',nullif(v_touched,''),p_persona_id::text);
  perform set_config('app.persona_revision_touched',v_touched,true);
  perform set_config('app.persona_publication_transition','content',true);
  update public.personas persona
  set publication_revision=persona.publication_revision+1,
      publication_state=case when persona.publication_state in ('published','in_review') then 'draft' else persona.publication_state end,
      unpublished_at=case when persona.publication_state='published' then now() else persona.unpublished_at end,
      updated_at=now()
  where persona.id=p_persona_id;
  update public.persona_publication_reviews review
  set review_state='stale',updated_at=now()
  where review.persona_id=p_persona_id;
  perform set_config('app.persona_publication_transition',coalesce(v_transition,''),true);
exception when others then
  perform set_config('app.persona_publication_transition',coalesce(v_transition,''),true);
  raise;
end;
$$;

revoke all on function public.invalidate_persona_review_revision(uuid)
  from public,anon,authenticated;

create or replace function public.invalidate_personas_after_backend_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_persona_id uuid;
begin
  if row(new.provider,new.base_url,new.model,new.extra)
     is not distinct from row(old.provider,old.base_url,old.model,old.extra) then return new; end if;
  for v_persona_id in
    select persona.id from public.personas persona
    where persona.ai_backend=new.id and persona.owner=new.owner order by persona.id
  loop
    perform public.lock_persona_publication_mutation(v_persona_id);
    perform public.invalidate_persona_review_revision(v_persona_id);
  end loop;
  return new;
end;
$$;

revoke all on function public.invalidate_personas_after_backend_change()
  from public,anon,authenticated;
drop trigger if exists invalidate_personas_after_backend_change on public.ai_backends;
create trigger invalidate_personas_after_backend_change
  after update of provider,base_url,model,extra on public.ai_backends
  for each row execute function public.invalidate_personas_after_backend_change();

create or replace function public.invalidate_personas_after_backend_credential_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_backend_id uuid:=case when tg_op='DELETE' then old.backend_id else new.backend_id end;
  v_owner uuid:=case when tg_op='DELETE' then old.owner else new.owner end;
  v_persona_id uuid;
begin
  for v_persona_id in
    select persona.id from public.personas persona
    where persona.ai_backend=v_backend_id and persona.owner=v_owner
    order by persona.id
  loop
    perform public.lock_persona_publication_mutation(v_persona_id);
    perform public.invalidate_persona_review_revision(v_persona_id);
  end loop;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public.invalidate_personas_after_backend_credential_change()
  from public,anon,authenticated;
drop trigger if exists invalidate_personas_after_backend_credential_change
  on public.ai_backend_credentials;
create trigger invalidate_personas_after_backend_credential_change
  after insert or update or delete on public.ai_backend_credentials
  for each row execute function public.invalidate_personas_after_backend_credential_change();

create or replace function public.invalidate_persona_after_fan_binding_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_persona_id uuid:=case when tg_op='DELETE' then old.persona_id else new.persona_id end;
begin
  if tg_op<>'UPDATE'
     or row(new.status,new.claim_state,new.fan_chat_enabled,new.fan_daily_message_limit)
        is distinct from row(old.status,old.claim_state,old.fan_chat_enabled,old.fan_daily_message_limit) then
    perform public.lock_persona_publication_mutation(v_persona_id);
    perform public.invalidate_persona_review_revision(v_persona_id);
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public.invalidate_persona_after_fan_binding_change()
  from public,anon,authenticated;
drop trigger if exists invalidate_persona_after_fan_binding_change on public.agent_bindings;
create trigger invalidate_persona_after_fan_binding_change
  after insert or update or delete
  on public.agent_bindings for each row
  execute function public.invalidate_persona_after_fan_binding_change();

create or replace function public.mark_persona_layout_edit_as_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touched text:=coalesce(current_setting('app.persona_revision_touched',true),'');
  v_persona_id uuid:=case when tg_op='DELETE' then old.persona_id else new.persona_id end;
  v_owner uuid:=case when tg_op='DELETE' then old.owner else new.owner end;
begin
  if tg_op = 'UPDATE' and new.layout is not distinct from old.layout then
    return new;
  end if;
  if position(','||v_persona_id::text||',' in ','||v_touched||',')>0 then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  perform set_config('app.persona_publication_transition','layout',true);
  update public.personas
  set publication_revision = publication_revision + 1,
      publication_state = case when publication_state = 'published' then 'draft' else publication_state end,
      unpublished_at = case when publication_state = 'published' then now() else unpublished_at end,
      updated_at = now()
  where id = v_persona_id and owner = v_owner;
  update public.persona_publication_reviews
  set review_state = 'stale', updated_at = now()
  where persona_id = v_persona_id and owner = v_owner;
  v_touched:=concat_ws(',',nullif(v_touched,''),v_persona_id::text);
  perform set_config('app.persona_revision_touched',v_touched,true);
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public.mark_persona_layout_edit_as_draft()
  from public, anon, authenticated;
drop trigger if exists mark_persona_layout_edit_as_draft on public.persona_page_layouts;
create trigger mark_persona_layout_edit_as_draft
  after insert or update or delete on public.persona_page_layouts
  for each row execute function public.mark_persona_layout_edit_as_draft();

-- Public page content participates in the same revision gate as profile fields
-- and layouts. A content change never remains live under an already-published
-- persona; the owner reviews and republishes the new revision.
create or replace function public.mark_persona_content_edit_as_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_persona_id uuid;
  v_owner uuid;
  v_persona_ids uuid[] := '{}'::uuid[];
  v_touched text := coalesce(current_setting('app.persona_revision_touched',true),'');
begin
  if current_setting('app.persona_bundle_suppress_content',true)='on' then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' and new is not distinct from old then return new; end if;
  if tg_table_name='persona_family_relationships' then
    if (tg_op='INSERT' and new.visibility<>'public')
       or (tg_op='DELETE' and old.visibility<>'public')
       or (tg_op='UPDATE' and old.visibility<>'public' and new.visibility<>'public')
       or (tg_op='UPDATE' and old.visibility='public' and new.visibility='public'
         and row(old.relationship_type,old.from_persona_id,old.to_persona_id)
           is not distinct from row(new.relationship_type,new.from_persona_id,new.to_persona_id)) then
      if tg_op='DELETE' then return old; else return new; end if;
    end if;
  end if;
  if tg_table_name = 'album_items' then
    select coalesce(array_agg(distinct album.persona_id),'{}'::uuid[]) into v_persona_ids
    from public.albums album
    where album.id in (new.album_id,old.album_id);
  elsif tg_table_name = 'persona_family_relationships' then
    select coalesce(array_agg(distinct persona_id),'{}'::uuid[]) into v_persona_ids
    from unnest(array[
      new.from_persona_id,new.to_persona_id,
      old.from_persona_id,old.to_persona_id
    ]::uuid[]) persona_id
    where persona_id is not null;
  else
    select coalesce(array_agg(distinct persona_id),'{}'::uuid[]) into v_persona_ids
    from unnest(array[new.persona_id,old.persona_id]::uuid[]) persona_id
    where persona_id is not null;
  end if;

  perform set_config('app.persona_publication_transition','content',true);
  foreach v_persona_id in array v_persona_ids loop
    if position(','||v_persona_id::text||',' in ','||v_touched||',')>0 then continue; end if;
    select persona.owner into v_owner from public.personas persona where persona.id=v_persona_id;
    if v_owner is not null then
      update public.personas
      set publication_revision=publication_revision+1,
          publication_state=case when publication_state in ('published','in_review') then 'draft' else publication_state end,
          unpublished_at=case when publication_state='published' then now() else unpublished_at end,
          updated_at=now()
      where id=v_persona_id and owner=v_owner;
      update public.persona_publication_reviews
      set review_state='stale',updated_at=now()
      where persona_id=v_persona_id and owner=v_owner;
      v_touched:=concat_ws(',',nullif(v_touched,''),v_persona_id::text);
      perform set_config('app.persona_revision_touched',v_touched,true);
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public.mark_persona_content_edit_as_draft()
  from public, anon, authenticated;
drop trigger if exists mark_persona_post_edit_as_draft on public.posts;
create trigger mark_persona_post_edit_as_draft
  after insert or update or delete on public.posts
  for each row execute function public.mark_persona_content_edit_as_draft();
drop trigger if exists mark_persona_link_edit_as_draft on public.persona_links;
create trigger mark_persona_link_edit_as_draft
  after insert or update or delete on public.persona_links
  for each row execute function public.mark_persona_content_edit_as_draft();
drop trigger if exists mark_persona_album_edit_as_draft on public.albums;
create trigger mark_persona_album_edit_as_draft
  after insert or update or delete on public.albums
  for each row execute function public.mark_persona_content_edit_as_draft();
drop trigger if exists mark_persona_album_item_edit_as_draft on public.album_items;
create trigger mark_persona_album_item_edit_as_draft
  after insert or update or delete on public.album_items
  for each row execute function public.mark_persona_content_edit_as_draft();
drop trigger if exists mark_persona_family_edit_as_draft on public.persona_family_relationships;
create trigger mark_persona_family_edit_as_draft
  after insert or update or delete on public.persona_family_relationships
  for each row execute function public.mark_persona_content_edit_as_draft();

-- Browser content writes use persona-scoped RPCs so the advisory lock is taken
-- before either the persona row or a content row. This removes the remaining
-- save-bundle/content lock inversion while retaining read-only table access.
create or replace function public.save_persona_post(
  p_post_id uuid,p_persona_id uuid,p_kind text,p_title text,
  p_body text,p_tags text,p_media_url text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;
  v_owner_total integer;v_owner_day integer;v_persona_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_post_id is null then
    perform public.lock_owner_content_creation_quota(v_owner);
  end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  if p_kind not in ('post','reel') then raise exception 'Invalid post type'; end if;
  if char_length(coalesce(p_title,''))>1000 or char_length(coalesce(p_body,''))>30000
     or char_length(coalesce(p_tags,''))>4000 or char_length(coalesce(p_media_url,''))>2048 then
    raise exception 'Post content is too long'; end if;
  if not public.is_safe_credential_free_https_url(p_media_url,true) then
    raise exception 'Post media requires a credential-free HTTPS URL'; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found'; end if;
  if p_post_id is null then
    select count(*) into v_owner_total from (
      select 1 from public.posts post
      join public.personas persona on persona.id=post.persona_id
      where persona.owner=v_owner limit 5000
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.posts post
      join public.personas persona on persona.id=post.persona_id
      where persona.owner=v_owner and post.created_at>=v_day
        and post.created_at<v_day+interval '1 day' limit 200
    ) quota;
    select count(*) into v_persona_total from (
      select 1 from public.posts post where post.persona_id=p_persona_id limit 500
    ) quota;
    if v_owner_total>=5000 then raise exception 'Post account limit reached (5000)'; end if;
    if v_owner_day>=200 then raise exception 'Post daily creation limit reached (200 UTC)'; end if;
    if v_persona_total>=500 then raise exception 'Post persona limit reached (500)'; end if;
    perform public.consume_owner_daily_rate(v_owner,'posts',200,1,v_owner_day);
    insert into public.posts(persona_id,kind,title,body,tags,media_url)
    values(p_persona_id,p_kind,coalesce(p_title,''),coalesce(p_body,''),
      coalesce(p_tags,''),coalesce(p_media_url,'')) returning id into v_id;
  else
    update public.posts post set kind=p_kind,title=coalesce(p_title,''),
      body=coalesce(p_body,''),tags=coalesce(p_tags,''),media_url=coalesce(p_media_url,'')
    where post.id=p_post_id and post.persona_id=p_persona_id
      and public.owns_persona(post.persona_id) returning post.id into v_id;
    if v_id is null then raise exception 'Owned post not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_persona_post(p_post_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_persona_id uuid;v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select post.persona_id into v_persona_id from public.posts post
  join public.personas persona on persona.id=post.persona_id and persona.owner=v_owner
  where post.id=p_post_id;
  if not found then raise exception 'Owned post not found'; end if;
  perform public.lock_persona_publication_mutation(v_persona_id);
  delete from public.posts post where post.id=p_post_id and post.persona_id=v_persona_id;
  get diagnostics v_count=row_count;return v_count=1;
end;
$$;

create or replace function public.save_persona_album(
  p_album_id uuid,p_persona_id uuid,p_title text,p_kind text,p_sort integer
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;
  v_owner_total integer;v_owner_day integer;v_persona_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_album_id is null then
    perform public.lock_owner_content_creation_quota(v_owner);
  end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  if trim(coalesce(p_title,''))='' or char_length(p_title)>1000 then
    raise exception 'Album title is required and must be 1000 characters or less'; end if;
  if p_kind not in ('gallery','affiliate') then raise exception 'Invalid album type'; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found'; end if;
  if p_album_id is null then
    select count(*) into v_owner_total from (
      select 1 from public.albums album
      join public.personas persona on persona.id=album.persona_id
      where persona.owner=v_owner limit 1000
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.albums album
      join public.personas persona on persona.id=album.persona_id
      where persona.owner=v_owner and album.created_at>=v_day
        and album.created_at<v_day+interval '1 day' limit 50
    ) quota;
    select count(*) into v_persona_total from (
      select 1 from public.albums album where album.persona_id=p_persona_id limit 100
    ) quota;
    if v_owner_total>=1000 then raise exception 'Album account limit reached (1000)'; end if;
    if v_owner_day>=50 then raise exception 'Album daily creation limit reached (50 UTC)'; end if;
    if v_persona_total>=100 then raise exception 'Album persona limit reached (100)'; end if;
    perform public.consume_owner_daily_rate(v_owner,'albums',50,1,v_owner_day);
    insert into public.albums(persona_id,title,kind,sort)
    values(p_persona_id,trim(p_title),p_kind,greatest(0,least(coalesce(p_sort,0),10000)))
    returning id into v_id;
  else
    update public.albums album set title=trim(p_title),kind=p_kind,
      sort=greatest(0,least(coalesce(p_sort,0),10000))
    where album.id=p_album_id and album.persona_id=p_persona_id
      and public.owns_persona(album.persona_id) returning album.id into v_id;
    if v_id is null then raise exception 'Owned album not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_persona_album(p_album_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_persona_id uuid;v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select album.persona_id into v_persona_id from public.albums album
  join public.personas persona on persona.id=album.persona_id and persona.owner=v_owner
  where album.id=p_album_id;
  if not found then raise exception 'Owned album not found'; end if;
  perform public.lock_persona_publication_mutation(v_persona_id);
  delete from public.albums album where album.id=p_album_id and album.persona_id=v_persona_id;
  get diagnostics v_count=row_count;return v_count=1;
end;
$$;

create or replace function public.save_persona_album_item(
  p_item_id uuid,p_album_id uuid,p_thumb_url text,p_caption text,
  p_link_url text,p_sort integer
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_persona_id uuid;v_id uuid;
  v_owner_total integer;v_owner_day integer;v_persona_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select album.persona_id into v_persona_id from public.albums album
  join public.personas persona on persona.id=album.persona_id and persona.owner=v_owner
  where album.id=p_album_id;
  if not found then raise exception 'Owned album not found'; end if;
  if p_item_id is null then
    perform public.lock_owner_content_creation_quota(v_owner);
  end if;
  perform public.lock_persona_publication_mutation(v_persona_id);
  if char_length(coalesce(p_thumb_url,''))>2048 or char_length(coalesce(p_link_url,''))>2048
     or char_length(coalesce(p_caption,''))>4000 then raise exception 'Album item is too long'; end if;
  if not public.is_safe_credential_free_https_url(p_thumb_url,true) then
    raise exception 'Album media requires a credential-free HTTPS URL'; end if;
  if not public.is_safe_credential_free_https_url(p_link_url,true) then
    raise exception 'Album destination requires a credential-free HTTPS URL'; end if;
  if p_item_id is null then
    select count(*) into v_owner_total from (
      select 1 from public.album_items item
      join public.albums album on album.id=item.album_id
      join public.personas persona on persona.id=album.persona_id
      where persona.owner=v_owner limit 10000
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.album_items item
      join public.albums album on album.id=item.album_id
      join public.personas persona on persona.id=album.persona_id
      where persona.owner=v_owner and item.created_at>=v_day
        and item.created_at<v_day+interval '1 day' limit 500
    ) quota;
    select count(*) into v_persona_total from (
      select 1 from public.album_items item
      join public.albums album on album.id=item.album_id
      where album.persona_id=v_persona_id limit 1000
    ) quota;
    if v_owner_total>=10000 then raise exception 'Album item account limit reached (10000)'; end if;
    if v_owner_day>=500 then raise exception 'Album item daily creation limit reached (500 UTC)'; end if;
    if v_persona_total>=1000 then raise exception 'Album item persona limit reached (1000)'; end if;
    perform public.consume_owner_daily_rate(v_owner,'album_items',500,1,v_owner_day);
    insert into public.album_items(album_id,thumb_url,caption,link_url,sort)
    values(p_album_id,coalesce(p_thumb_url,''),coalesce(p_caption,''),
      coalesce(p_link_url,''),greatest(0,least(coalesce(p_sort,0),10000)))
    returning id into v_id;
  else
    update public.album_items item set thumb_url=coalesce(p_thumb_url,''),
      caption=coalesce(p_caption,''),link_url=coalesce(p_link_url,''),
      sort=greatest(0,least(coalesce(p_sort,0),10000))
    where item.id=p_item_id and item.album_id=p_album_id returning item.id into v_id;
    if v_id is null then raise exception 'Owned album item not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_persona_album_item(p_item_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_persona_id uuid;v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select album.persona_id into v_persona_id from public.album_items item
  join public.albums album on album.id=item.album_id
  join public.personas persona on persona.id=album.persona_id and persona.owner=v_owner
  where item.id=p_item_id;
  if not found then raise exception 'Owned album item not found'; end if;
  perform public.lock_persona_publication_mutation(v_persona_id);
  delete from public.album_items item where item.id=p_item_id;
  get diagnostics v_count=row_count;return v_count=1;
end;
$$;

create or replace function public.set_persona_backend(p_persona_id uuid,p_backend_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  if p_backend_id is not null and not exists(select 1 from public.ai_backends backend
    where backend.id=p_backend_id and backend.owner=auth.uid()) then
    raise exception 'Owned model connection not found'; end if;
  update public.personas persona set ai_backend=p_backend_id
  where persona.id=p_persona_id and persona.owner=auth.uid();
  if not found then raise exception 'Owned persona not found'; end if;return true;
end;
$$;

create or replace function public.set_persona_pet_project(p_persona_id uuid,p_pet_project text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(coalesce(p_pet_project,''))>1000 then raise exception 'Pet project is too long'; end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  update public.personas persona set pet_project=coalesce(p_pet_project,'')
  where persona.id=p_persona_id and persona.owner=auth.uid();
  if not found then raise exception 'Owned persona not found'; end if;return true;
end;
$$;

create or replace function public.delete_owned_persona(p_persona_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_business_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(auth.uid()::text,51051101)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_persona_id::text,51051102)
  );
  -- Migration 052's membership trigger takes the business publication lock while
  -- a persona delete cascades through business_persona_memberships. Prelock every
  -- attached business in one deterministic order before taking the persona lock,
  -- matching the business-first order used by membership mutation RPCs.
  for v_business_id in
    select membership.business_id
    from public.business_persona_memberships membership
    where membership.persona_id=p_persona_id and membership.owner=auth.uid()
    order by membership.business_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_business_id::text,52052052)
    );
  end loop;
  perform public.lock_persona_publication_mutation(p_persona_id);
  delete from public.personas persona
  where persona.id=p_persona_id and persona.owner=auth.uid();
  if not found then raise exception 'Owned persona not found'; end if;return true;
end;
$$;

revoke insert,update,delete on public.posts,public.persona_links,
  public.albums,public.album_items from authenticated;
revoke insert,update,delete on public.personas from authenticated;
revoke all on function public.save_persona_post(uuid,uuid,text,text,text,text,text),
  public.delete_persona_post(uuid),public.save_persona_album(uuid,uuid,text,text,integer),
  public.delete_persona_album(uuid),
  public.save_persona_album_item(uuid,uuid,text,text,text,integer),
  public.delete_persona_album_item(uuid),public.set_persona_backend(uuid,uuid),
  public.set_persona_pet_project(uuid,text),public.delete_owned_persona(uuid)
  from public,anon;
grant execute on function public.save_persona_post(uuid,uuid,text,text,text,text,text),
  public.delete_persona_post(uuid),public.save_persona_album(uuid,uuid,text,text,integer),
  public.delete_persona_album(uuid),
  public.save_persona_album_item(uuid,uuid,text,text,text,integer),
  public.delete_persona_album_item(uuid),public.set_persona_backend(uuid,uuid),
  public.set_persona_pet_project(uuid,text),public.delete_owned_persona(uuid)
  to authenticated;

-- Keep the private account shell and per-persona note store bounded. The auth
-- identity is the email authority; browser code cannot rewrite its profile
-- copy. Private notes remain writable only through the atomic persona bundle,
-- which replaces them with at most one 20,000-character owner note.
create or replace function public.update_my_profile(
  p_display_name text,p_prefs jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_result jsonb;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(p_display_name,'')))>120 then
    raise exception 'Account display name must be 120 characters or less';
  end if;
  if jsonb_typeof(coalesce(p_prefs,'null'::jsonb))<>'object'
     or octet_length(p_prefs::text)>100000 then
    raise exception 'Account preferences must be an object no larger than 100000 bytes';
  end if;
  update public.profiles profile set
    display_name=trim(coalesce(p_display_name,'')),prefs=p_prefs
  where profile.id=v_owner
  returning jsonb_build_object(
    'id',profile.id,'display_name',profile.display_name,'prefs',profile.prefs
  ) into v_result;
  if v_result is null then raise exception 'Owner profile not found'; end if;
  return v_result;
end;
$$;

revoke insert,update,delete on public.private_notes from authenticated;
revoke update on public.profiles from authenticated;
revoke all on function public.update_my_profile(text,jsonb)
  from public,anon,authenticated;
grant execute on function public.update_my_profile(text,jsonb) to authenticated;

create index if not exists account_ledger_owner_created_quota_idx
  on public.account_ledger(owner,created_at,id);

create or replace function public.account_ledger_text_has_secret(p_value text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_value,'') ~* concat(
    '(password|passcode|api[ _-]?key|client[ _-]?secret|access[ _-]?token|',
    'refresh[ _-]?token|authorization|bearer)[[:space:]]*[:=][[:space:]]*',
    '[^[:space:]]{4,}|(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{16,}|',
    'gh[pousr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})([^A-Za-z0-9]|$)'
  )
$$;

-- Email-match attestation and ledger edits share one owner/row lock. Without
-- this wrapper an edit could race verification and retain evidence for a
-- different provider identity under the same ledger id.
do $migration$
begin
  if to_regprocedure('public.verify_account_ledger_email_legacy_009(uuid)') is null
     and to_regprocedure('public.verify_account_ledger_email(uuid)') is not null then
    alter function public.verify_account_ledger_email(uuid)
      rename to verify_account_ledger_email_legacy_009;
  end if;
end
$migration$;

create or replace function public.verify_account_ledger_email(p_ledger_id uuid)
returns public.account_connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_result public.account_connections%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051059)
  );
  perform 1 from public.account_ledger ledger
  where ledger.id=p_ledger_id and ledger.owner=v_owner for update;
  if not found then raise exception 'Owned account ledger entry not found'; end if;
  v_result:=public.verify_account_ledger_email_legacy_009(p_ledger_id);
  return v_result;
end;
$$;

revoke all on function public.verify_account_ledger_email_legacy_009(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.verify_account_ledger_email(uuid)
  from public,anon,authenticated;
grant execute on function public.verify_account_ledger_email(uuid)
  to authenticated;

create or replace function public.save_account_ledger_entry(
  p_ledger_id uuid,p_persona_id uuid,p_provider text,p_username text,
  p_login_email text,p_url text,p_notes text,p_aliases text,
  p_suspended boolean default false,p_is_primary boolean default false
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;v_provider text:=lower(trim(coalesce(p_provider,'')));
  v_username text:=trim(coalesce(p_username,''));
  v_email text:=lower(trim(coalesce(p_login_email,'')));
  v_url text:=trim(coalesce(p_url,''));v_notes text:=trim(coalesce(p_notes,''));
  v_aliases text:=trim(coalesce(p_aliases,''));v_total integer;v_day_total integer;
  v_existing public.account_ledger%rowtype;v_connection_state text;
  v_lock_persona_id uuid;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if v_provider!~'^[a-z0-9][a-z0-9._-]{0,63}$' then
    raise exception 'Invalid account provider key';
  end if;
  if char_length(v_username)>500 or char_length(v_email)>320
     or char_length(v_url)>2048 or char_length(v_notes)>4000
     or char_length(v_aliases)>4000 then
    raise exception 'Account ledger metadata is too long';
  end if;
  if v_email<>'' and v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid account login email';
  end if;
  if v_url<>'' and (
       not public.is_safe_credential_free_https_url(v_url,false)
       or position('?' in v_url)>0 or position('#' in v_url)>0
     ) then
    raise exception 'Account profile URL must be credential-free HTTPS without a query or fragment';
  end if;
  if v_username='' and v_email='' and v_url='' then
    raise exception 'Add a username, login email, or account URL';
  end if;
  if public.account_ledger_text_has_secret(v_username)
     or public.account_ledger_text_has_secret(v_email)
     or public.account_ledger_text_has_secret(v_notes)
     or public.account_ledger_text_has_secret(v_aliases) then
    raise exception 'Account metadata appears to contain a credential; store only non-secret inventory notes';
  end if;
  if p_persona_id is not null and not exists (
    select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner
  ) then raise exception 'Owned persona not found'; end if;

  -- Agent writers lock owner, persona, then account. Enter that hierarchy
  -- before a ledger reassignment so a concurrent destination/task/draft save
  -- cannot retain a now-mismatched account/persona pair or deadlock a delete.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051101)
  );
  for v_lock_persona_id in
    select distinct affected.persona_id from (
      select p_persona_id as persona_id
      union all
      select ledger.persona_id from public.account_ledger ledger
      where p_ledger_id is not null and ledger.id=p_ledger_id and ledger.owner=v_owner
      union all
      select destination.persona_id from public.agent_destinations destination
      where p_ledger_id is not null and destination.owner=v_owner
        and destination.account_id=p_ledger_id
      union all
      select task.persona_id from public.ai_tasks task
      where p_ledger_id is not null and task.owner=v_owner and task.account_id=p_ledger_id
      union all
      select draft.persona_id from public.drafts draft
      where p_ledger_id is not null and draft.owner=v_owner and draft.account_id=p_ledger_id
    ) affected where affected.persona_id is not null order by affected.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_lock_persona_id::text,51051102)
    );
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051059)
  );

  if p_ledger_id is null then
    select count(*) into v_total from (
      select 1 from public.account_ledger ledger
      where ledger.owner=v_owner limit 500
    ) bounded;
    select count(*) into v_day_total from (
      select 1 from public.account_ledger ledger
      where ledger.owner=v_owner and ledger.created_at>=v_day
        and ledger.created_at<v_day+interval '1 day' limit 50
    ) bounded;
    if v_total>=500 then raise exception 'Account ledger limit reached (500)'; end if;
    if v_day_total>=50 then raise exception 'Account ledger daily creation limit reached (50 UTC)'; end if;
    perform public.consume_owner_daily_rate(v_owner,'account_ledger',50,1,v_day_total);
    if coalesce(p_is_primary,false) then
      update public.account_ledger ledger set is_primary=false,updated_at=now()
      where ledger.owner=v_owner and ledger.provider=v_provider
        and ledger.persona_id is not distinct from p_persona_id and ledger.is_primary;
    end if;
    insert into public.account_ledger(
      owner,persona_id,provider,username,login_email,url,notes,aliases,suspended,is_primary
    ) values (
      v_owner,p_persona_id,v_provider,v_username,v_email,v_url,v_notes,v_aliases,
      coalesce(p_suspended,false),coalesce(p_is_primary,false)
    ) returning id into v_id;
  else
    select ledger.* into v_existing from public.account_ledger ledger
    where ledger.id=p_ledger_id and ledger.owner=v_owner for update;
    if not found then raise exception 'Owned account ledger entry not found'; end if;
    if exists (
      select 1 from (
        select destination.persona_id from public.agent_destinations destination
        where destination.owner=v_owner and destination.account_id=p_ledger_id
        union all
        select task.persona_id from public.ai_tasks task
        where task.owner=v_owner and task.account_id=p_ledger_id
        union all
        select draft.persona_id from public.drafts draft
        where draft.owner=v_owner and draft.account_id=p_ledger_id
      ) dependent
      where dependent.persona_id is distinct from p_persona_id
    ) then
      raise exception 'Reassign or delete agent destinations, tasks, and drafts before moving this account';
    end if;
    v_id:=v_existing.id;
    select connection.connection_state into v_connection_state
    from public.account_connections connection
    where connection.ledger_id=v_id and connection.owner=v_owner for update;
    if found and (
      lower(trim(v_existing.provider)) is distinct from v_provider
      or regexp_replace(lower(trim(coalesce(v_existing.username,''))),'^@','')
        is distinct from regexp_replace(lower(v_username),'^@','')
      or lower(trim(coalesce(v_existing.login_email,''))) is distinct from v_email
    ) then
      if v_connection_state in ('connected','error') then
        raise exception 'Disconnect or reset the provider connection before changing its identity fields';
      end if;
      delete from public.account_connections connection
      where connection.ledger_id=v_id and connection.owner=v_owner;
    end if;
    if coalesce(p_is_primary,false) then
      update public.account_ledger ledger set is_primary=false,updated_at=now()
      where ledger.owner=v_owner and ledger.id<>v_id and ledger.provider=v_provider
        and ledger.persona_id is not distinct from p_persona_id and ledger.is_primary;
    end if;
    update public.account_ledger ledger set
      persona_id=p_persona_id,provider=v_provider,username=v_username,
      login_email=v_email,url=v_url,notes=v_notes,aliases=v_aliases,
      suspended=coalesce(p_suspended,false),is_primary=coalesce(p_is_primary,false),
      updated_at=now()
    where ledger.id=v_id and ledger.owner=v_owner;
    if p_persona_id is not null then
      delete from public.account_persona_links link
      where link.owner=v_owner and link.ledger_id=v_id
        and link.persona_id=p_persona_id;
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.assign_account_ledger_persona(
  p_ledger_id uuid,p_persona_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_lock_persona_id uuid;v_existing_persona_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_persona_id is not null and not exists (
    select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner
  ) then raise exception 'Owned persona not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051101)
  );
  for v_lock_persona_id in
    select distinct affected.persona_id from (
      select p_persona_id as persona_id
      union all
      select ledger.persona_id from public.account_ledger ledger
      where ledger.id=p_ledger_id and ledger.owner=v_owner
      union all
      select destination.persona_id from public.agent_destinations destination
      where destination.owner=v_owner and destination.account_id=p_ledger_id
      union all
      select task.persona_id from public.ai_tasks task
      where task.owner=v_owner and task.account_id=p_ledger_id
      union all
      select draft.persona_id from public.drafts draft
      where draft.owner=v_owner and draft.account_id=p_ledger_id
    ) affected where affected.persona_id is not null order by affected.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_lock_persona_id::text,51051102)
    );
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051059)
  );
  select ledger.persona_id into v_existing_persona_id
  from public.account_ledger ledger
  where ledger.id=p_ledger_id and ledger.owner=v_owner for update;
  if not found then raise exception 'Owned account ledger entry not found'; end if;
  if exists (
    select 1 from (
      select destination.persona_id from public.agent_destinations destination
      where destination.owner=v_owner and destination.account_id=p_ledger_id
      union all
      select task.persona_id from public.ai_tasks task
      where task.owner=v_owner and task.account_id=p_ledger_id
      union all
      select draft.persona_id from public.drafts draft
      where draft.owner=v_owner and draft.account_id=p_ledger_id
    ) dependent
    where dependent.persona_id is distinct from p_persona_id
  ) then
    raise exception 'Reassign or delete agent destinations, tasks, and drafts before moving this account';
  end if;
  update public.account_ledger ledger set persona_id=p_persona_id,updated_at=now()
  where ledger.id=p_ledger_id and ledger.owner=v_owner;
  if p_persona_id is not null then
    delete from public.account_persona_links link
    where link.owner=v_owner and link.ledger_id=p_ledger_id
      and link.persona_id=p_persona_id;
  end if;
  return true;
end;
$$;

create or replace function public.set_primary_account_ledger_entry(p_ledger_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_ledger public.account_ledger%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051059)
  );
  select * into v_ledger from public.account_ledger ledger
  where ledger.id=p_ledger_id and ledger.owner=v_owner for update;
  if not found then raise exception 'Owned account ledger entry not found'; end if;
  update public.account_ledger ledger set is_primary=false,updated_at=now()
  where ledger.owner=v_owner and ledger.id<>v_ledger.id
    and ledger.provider=v_ledger.provider
    and ledger.persona_id is not distinct from v_ledger.persona_id
    and ledger.is_primary;
  update public.account_ledger ledger set is_primary=true,updated_at=now()
  where ledger.id=v_ledger.id and ledger.owner=v_owner;
  return true;
end;
$$;

create or replace function public.delete_account_ledger_entry(p_ledger_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_count integer;v_persona_id uuid;
  v_connection_state text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  -- Agent storage writers acquire owner-agent, persona-agent, child-row, then
  -- ledger locks. Enter that same hierarchy before touching the parent row so
  -- an FK cascade/set-null cannot deadlock with a concurrent writer.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051101)
  );
  for v_persona_id in
    select distinct affected.persona_id from (
      select destination.persona_id from public.agent_destinations destination
      where destination.owner=v_owner and destination.account_id=p_ledger_id
      union all
      select task.persona_id from public.ai_tasks task
      where task.owner=v_owner and task.account_id=p_ledger_id
      union all
      select draft.persona_id from public.drafts draft
      where draft.owner=v_owner and draft.account_id=p_ledger_id
    ) affected where affected.persona_id is not null order by affected.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_persona_id::text,51051102)
    );
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051059)
  );
  perform 1 from public.account_ledger ledger
  where ledger.id=p_ledger_id and ledger.owner=v_owner for update;
  if not found then raise exception 'Owned account ledger entry not found'; end if;
  select connection.connection_state into v_connection_state
  from public.account_connections connection
  where connection.ledger_id=p_ledger_id and connection.owner=v_owner for update;
  if found and v_connection_state in ('connected','error') then
    raise exception 'Disconnect or reset the provider connection before deleting this account record';
  end if;
  delete from public.account_ledger ledger
  where ledger.id=p_ledger_id and ledger.owner=v_owner;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;

create or replace function public.delete_account_ledger_for_account_service(p_owner uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_ledger_id uuid;v_persona_id uuid;v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051101)
  );
  for v_persona_id in
    select distinct affected.persona_id from (
      select destination.persona_id from public.agent_destinations destination
      where destination.owner=p_owner
      union all
      select task.persona_id from public.ai_tasks task where task.owner=p_owner
      union all
      select draft.persona_id from public.drafts draft where draft.owner=p_owner
    ) affected where affected.persona_id is not null order by affected.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_persona_id::text,51051102)
    );
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051059)
  );
  for v_ledger_id in
    select ledger.id from public.account_ledger ledger
    where ledger.owner=p_owner order by ledger.id for update
  loop null; end loop;
  delete from public.account_ledger ledger where ledger.owner=p_owner;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

revoke insert,update,delete on public.account_ledger from authenticated;
revoke insert,update,delete on public.account_ledger from service_role;
revoke all on function public.account_ledger_text_has_secret(text),
  public.save_account_ledger_entry(uuid,uuid,text,text,text,text,text,text,boolean,boolean),
  public.assign_account_ledger_persona(uuid,uuid),
  public.set_primary_account_ledger_entry(uuid),public.delete_account_ledger_entry(uuid),
  public.delete_account_ledger_for_account_service(uuid)
  from public,anon,authenticated;
grant execute on function public.save_account_ledger_entry(
  uuid,uuid,text,text,text,text,text,text,boolean,boolean
),public.assign_account_ledger_persona(uuid,uuid),
  public.set_primary_account_ledger_entry(uuid),public.delete_account_ledger_entry(uuid)
  to authenticated;
revoke all on function public.delete_account_ledger_for_account_service(uuid)
  from service_role;
grant execute on function public.delete_account_ledger_for_account_service(uuid)
  to service_role;

create index if not exists account_persona_links_owner_created_quota_idx
  on public.account_persona_links(owner,created_at,ledger_id,persona_id);

create or replace function public.set_account_persona_link(
  p_ledger_id uuid,p_persona_id uuid,p_enabled boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_primary_persona_id uuid;
  v_total integer;v_day_total integer;v_ledger_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051059)
  );
  select ledger.persona_id into v_primary_persona_id
  from public.account_ledger ledger
  where ledger.id=p_ledger_id and ledger.owner=v_owner for update;
  if not found then raise exception 'Owned account ledger entry not found'; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  if not coalesce(p_enabled,false) then
    delete from public.account_persona_links link
    where link.ledger_id=p_ledger_id and link.persona_id=p_persona_id
      and link.owner=v_owner;
    return true;
  end if;
  if v_primary_persona_id=p_persona_id then
    delete from public.account_persona_links link
    where link.ledger_id=p_ledger_id and link.persona_id=p_persona_id
      and link.owner=v_owner;
    return true;
  end if;
  if exists(select 1 from public.account_persona_links link
    where link.ledger_id=p_ledger_id and link.persona_id=p_persona_id
      and link.owner=v_owner) then return true; end if;
  select count(*) into v_total from (
    select 1 from public.account_persona_links link
    where link.owner=v_owner limit 5000
  ) quota;
  select count(*) into v_day_total from (
    select 1 from public.account_persona_links link
    where link.owner=v_owner and link.created_at>=v_day
      and link.created_at<v_day+interval '1 day' limit 200
  ) quota;
  select count(*) into v_ledger_total from (
    select 1 from public.account_persona_links link
    where link.owner=v_owner and link.ledger_id=p_ledger_id limit 100
  ) quota;
  if v_total>=5000 then raise exception 'Shared account manager limit reached (5000)'; end if;
  if v_day_total>=200 then raise exception 'Shared account manager daily creation limit reached (200 UTC)'; end if;
  if v_ledger_total>=100 then raise exception 'Account co-manager limit reached (100)'; end if;
  perform public.consume_owner_daily_rate(
    v_owner,'account_persona_links',200,1,v_day_total
  );
  insert into public.account_persona_links(ledger_id,persona_id,owner)
  values(p_ledger_id,p_persona_id,v_owner)
  on conflict(ledger_id,persona_id) do nothing;
  return true;
end;
$$;

revoke insert,update,delete on public.account_persona_links
  from authenticated,service_role;
revoke all on function public.set_account_persona_link(uuid,uuid,boolean)
  from public,anon,authenticated;
grant execute on function public.set_account_persona_link(uuid,uuid,boolean)
  to authenticated;

-- Legacy persona groups predate the bounded project model. Keep the simple
-- grouping UX, but place all browser mutation behind serialized RPCs so one
-- account cannot create an unbounded auxiliary graph.
create index if not exists persona_groups_owner_created_quota_idx
  on public.persona_groups(owner,created_at,id);
create index if not exists persona_group_members_owner_created_quota_idx
  on public.persona_group_members(owner,created_at,group_id,persona_id);

create or replace function public.save_persona_group(
  p_group_id uuid,p_name text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;v_total integer;v_day_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_owner_persona_org_creation_quota(v_owner);
  if trim(coalesce(p_name,''))='' or char_length(trim(p_name))>80 then
    raise exception 'Group name is required and must be 80 characters or less';
  end if;
  if p_group_id is null then
    select count(*) into v_total from (
      select 1 from public.persona_groups group_row
      where group_row.owner=v_owner limit 100
    ) quota;
    select count(*) into v_day_total from (
      select 1 from public.persona_groups group_row
      where group_row.owner=v_owner and group_row.created_at>=v_day
        and group_row.created_at<v_day+interval '1 day' limit 20
    ) quota;
    if v_total>=100 then raise exception 'Persona group account limit reached (100)'; end if;
    if v_day_total>=20 then raise exception 'Persona group daily creation limit reached (20 UTC)'; end if;
    perform public.consume_owner_daily_rate(v_owner,'persona_groups',20,1,v_day_total);
    insert into public.persona_groups(owner,name)
    values(v_owner,trim(p_name)) returning id into v_id;
  else
    update public.persona_groups group_row set name=trim(p_name)
    where group_row.id=p_group_id and group_row.owner=v_owner
    returning group_row.id into v_id;
    if v_id is null then raise exception 'Owned persona group not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_persona_group(p_group_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_owner_persona_org_creation_quota(v_owner);
  perform 1 from public.persona_groups group_row
  where group_row.id=p_group_id and group_row.owner=v_owner for update;
  if not found then raise exception 'Owned persona group not found'; end if;
  delete from public.persona_groups group_row
  where group_row.id=p_group_id and group_row.owner=v_owner;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Owned persona group not found'; end if;
  return true;
end;
$$;

create or replace function public.set_persona_group_member(
  p_group_id uuid,p_persona_id uuid,p_enabled boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_total integer;v_day_total integer;v_group_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_owner_persona_org_creation_quota(v_owner);
  perform 1 from public.persona_groups group_row
  where group_row.id=p_group_id and group_row.owner=v_owner for update;
  if not found then raise exception 'Owned persona group not found'; end if;
  if not coalesce(p_enabled,false) then
    delete from public.persona_group_members member
    where member.owner=v_owner and member.group_id=p_group_id
      and member.persona_id=p_persona_id;
    return true;
  end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  if exists(select 1 from public.persona_group_members member
    where member.owner=v_owner and member.group_id=p_group_id
      and member.persona_id=p_persona_id) then return true; end if;
  select count(*) into v_total from (
    select 1 from public.persona_group_members member
    where member.owner=v_owner limit 5000
  ) quota;
  select count(*) into v_day_total from (
    select 1 from public.persona_group_members member
    where member.owner=v_owner and member.created_at>=v_day
      and member.created_at<v_day+interval '1 day' limit 200
  ) quota;
  select count(*) into v_group_total from (
    select 1 from public.persona_group_members member
    where member.owner=v_owner and member.group_id=p_group_id limit 100
  ) quota;
  if v_total>=5000 then raise exception 'Persona group membership account limit reached (5000)'; end if;
  if v_day_total>=200 then raise exception 'Persona group membership daily creation limit reached (200 UTC)'; end if;
  if v_group_total>=100 then raise exception 'Persona group membership limit reached (100)'; end if;
  perform public.consume_owner_daily_rate(
    v_owner,'persona_group_members',200,1,v_day_total
  );
  insert into public.persona_group_members(group_id,persona_id,owner)
  values(p_group_id,p_persona_id,v_owner) on conflict(group_id,persona_id) do nothing;
  return true;
end;
$$;

revoke insert,update,delete on public.persona_groups,
  public.persona_group_members from authenticated;
revoke insert,update on public.persona_groups,
  public.persona_group_members from service_role;
revoke all on function public.save_persona_group(uuid,text),
  public.delete_persona_group(uuid),
  public.set_persona_group_member(uuid,uuid,boolean)
  from public,anon,authenticated;
grant execute on function public.save_persona_group(uuid,text),
  public.delete_persona_group(uuid),
  public.set_persona_group_member(uuid,uuid,boolean)
  to authenticated;

-- Monetization controls are public page content too. Changes to settings,
-- active offers, or a linked product's public fields invalidate the persona
-- revision. Browser writes use lock-ordered RPCs so reviewed revenue rails and
-- affiliate redirect destinations cannot change under a published revision.
create or replace function public.mark_persona_revenue_edit_as_draft()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_persona_ids uuid[]:='{}'::uuid[];v_persona_id uuid;
begin
  if current_setting('app.persona_bundle_suppress_content',true)='on' then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' then
    if tg_table_name='persona_revenue_settings' and row(
      new.affiliate_enabled,new.review_requests_enabled,new.default_disclosure,
      new.cta_label,new.review_cta_label
    ) is not distinct from row(
      old.affiliate_enabled,old.review_requests_enabled,old.default_disclosure,
      old.cta_label,old.review_cta_label
    ) then return new; end if;
    if tg_table_name='persona_affiliate_offers' and row(
      new.persona_id,new.product_id,new.placement,new.priority,new.cta_label,new.status
    ) is not distinct from row(
      old.persona_id,old.product_id,old.placement,old.priority,old.cta_label,old.status
    ) then return new; end if;
    if tg_table_name='affiliate_products' and row(
      new.title,new.merchant,new.product_url,new.affiliate_url,new.category,new.status,
      new.disclosure,new.image_url
    ) is not distinct from row(
      old.title,old.merchant,old.product_url,old.affiliate_url,old.category,old.status,
      old.disclosure,old.image_url
    ) then return new; end if;
    if tg_table_name='product_review_settings' and row(
      new.enabled,new.destination_ledger_id
    ) is not distinct from row(old.enabled,old.destination_ledger_id) then return new; end if;
  end if;

  if tg_table_name in ('persona_revenue_settings','product_review_settings') then
    v_persona_ids:=case when tg_op='DELETE' then array[old.persona_id]
      when tg_op='INSERT' then array[new.persona_id]
      else array[new.persona_id,old.persona_id] end;
  elsif tg_table_name='persona_affiliate_offers' then
    v_persona_ids:=case when tg_op='DELETE' then array[old.persona_id]
      when tg_op='INSERT' then array[new.persona_id]
      else array[new.persona_id,old.persona_id] end;
  else
    select coalesce(array_agg(distinct offer.persona_id order by offer.persona_id),'{}'::uuid[])
    into v_persona_ids from public.persona_affiliate_offers offer
    where offer.product_id=case when tg_op='DELETE' then old.id else new.id end;
  end if;

  for v_persona_id in select distinct id from unnest(v_persona_ids) id where id is not null order by id
  loop
    perform public.lock_persona_publication_mutation(v_persona_id);
    perform public.invalidate_persona_review_revision(v_persona_id);
  end loop;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public.mark_persona_revenue_edit_as_draft()
  from public,anon,authenticated;
drop trigger if exists mark_persona_revenue_settings_edit_as_draft on public.persona_revenue_settings;
create trigger mark_persona_revenue_settings_edit_as_draft
  after insert or update or delete on public.persona_revenue_settings
  for each row execute function public.mark_persona_revenue_edit_as_draft();
drop trigger if exists mark_persona_affiliate_offer_edit_as_draft on public.persona_affiliate_offers;
create trigger mark_persona_affiliate_offer_edit_as_draft
  after insert or update or delete on public.persona_affiliate_offers
  for each row execute function public.mark_persona_revenue_edit_as_draft();
drop trigger if exists mark_affiliate_product_edit_as_draft on public.affiliate_products;
create trigger mark_affiliate_product_edit_as_draft
  after insert or update or delete on public.affiliate_products
  for each row execute function public.mark_persona_revenue_edit_as_draft();
drop trigger if exists mark_product_review_setting_edit_as_draft on public.product_review_settings;
create trigger mark_product_review_setting_edit_as_draft
  after insert or update or delete on public.product_review_settings
  for each row execute function public.mark_persona_revenue_edit_as_draft();

create or replace function public.auto_create_persona_revenue_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_previous text:=current_setting('app.persona_bundle_suppress_content',true);
begin
  perform set_config('app.persona_bundle_suppress_content','on',true);
  insert into public.persona_revenue_settings(persona_id,owner)
  values(new.id,new.owner) on conflict(persona_id) do nothing;
  perform set_config('app.persona_bundle_suppress_content',coalesce(v_previous,''),true);
  return new;
exception when others then
  perform set_config('app.persona_bundle_suppress_content',coalesce(v_previous,''),true);
  raise;
end;
$$;
revoke all on function public.auto_create_persona_revenue_settings()
  from public,anon,authenticated;

do $migration$
begin
  if to_regprocedure('public.configure_product_review_legacy_043(uuid,boolean,uuid)') is null
     and to_regprocedure('public.configure_product_review(uuid,boolean,uuid)') is not null then
    alter function public.configure_product_review(uuid,boolean,uuid)
      rename to configure_product_review_legacy_043;
  end if;
end
$migration$;

create or replace function public.configure_product_review(
  p_persona_id uuid,p_enabled boolean,p_destination_ledger_id uuid
)
returns public.product_review_settings
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  return public.configure_product_review_legacy_043(
    p_persona_id,p_enabled,p_destination_ledger_id
  );
end;
$$;
revoke all on function public.configure_product_review_legacy_043(uuid,boolean,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.configure_product_review(uuid,boolean,uuid)
  from public,anon;
grant execute on function public.configure_product_review(uuid,boolean,uuid)
  to authenticated;

create index if not exists affiliate_partners_owner_created_quota_idx
  on public.affiliate_partners(owner,created_at,id);

create or replace function public.save_affiliate_partner(
  p_partner_id uuid,p_partner jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;v_status text;
  v_total integer;v_day_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if jsonb_typeof(coalesce(p_partner,'null'::jsonb))<>'object'
     or exists(select 1 from jsonb_object_keys(p_partner) key
       where key<>all(array['name','program_url','status','default_disclosure','notes'])) then
    raise exception 'Affiliate partner must be a canonical object';
  end if;
  v_status:=coalesce(p_partner->>'status','active');
  if trim(coalesce(p_partner->>'name',''))=''
     or char_length(trim(p_partner->>'name'))>200
     or char_length(coalesce(p_partner->>'program_url',''))>2048
     or char_length(coalesce(p_partner->>'default_disclosure',''))>2000
     or char_length(coalesce(p_partner->>'notes',''))>4000 then
    raise exception 'Affiliate partner content is missing or too long';
  end if;
  if v_status not in ('active','paused','inactive') then
    raise exception 'Invalid affiliate partner status'; end if;
  if not public.is_safe_credential_free_https_url(
    coalesce(p_partner->>'program_url',''),true
  ) then raise exception 'Affiliate program URL must be credential-free HTTPS'; end if;
  if public.account_ledger_text_has_secret(p_partner->>'default_disclosure')
     or public.account_ledger_text_has_secret(p_partner->>'notes') then
    raise exception 'Affiliate partner metadata appears to contain a credential';
  end if;
  perform public.lock_owner_content_creation_quota(v_owner);
  if p_partner_id is null then
    select count(*) into v_total from (
      select 1 from public.affiliate_partners partner
      where partner.owner=v_owner limit 100
    ) quota;
    select count(*) into v_day_total from (
      select 1 from public.affiliate_partners partner
      where partner.owner=v_owner and partner.created_at>=v_day
        and partner.created_at<v_day+interval '1 day' limit 10
    ) quota;
    if v_total>=100 then raise exception 'Affiliate partner account limit reached (100)'; end if;
    if v_day_total>=10 then raise exception 'Affiliate partner daily creation limit reached (10 UTC)'; end if;
    perform public.consume_owner_daily_rate(
      v_owner,'affiliate_partners',10,1,v_day_total
    );
    insert into public.affiliate_partners(
      owner,name,program_url,status,default_disclosure,notes
    ) values (
      v_owner,trim(p_partner->>'name'),coalesce(p_partner->>'program_url',''),
      v_status,coalesce(p_partner->>'default_disclosure',''),
      coalesce(p_partner->>'notes','')
    ) returning id into v_id;
  else
    update public.affiliate_partners partner set
      name=trim(p_partner->>'name'),
      program_url=coalesce(p_partner->>'program_url',''),status=v_status,
      default_disclosure=coalesce(p_partner->>'default_disclosure',''),
      notes=coalesce(p_partner->>'notes',''),updated_at=now()
    where partner.id=p_partner_id and partner.owner=v_owner
    returning partner.id into v_id;
    if v_id is null then raise exception 'Owned affiliate partner not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_affiliate_partner(p_partner_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_persona_id uuid;v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_owner_content_creation_quota(v_owner);
  if not exists(select 1 from public.affiliate_partners partner
    where partner.id=p_partner_id and partner.owner=v_owner) then
    raise exception 'Owned affiliate partner not found'; end if;
  for v_persona_id in
    select distinct offer.persona_id
    from public.affiliate_products product
    join public.persona_affiliate_offers offer
      on offer.product_id=product.id and offer.owner=v_owner
    where product.partner_id=p_partner_id and product.owner=v_owner
    order by offer.persona_id
  loop perform public.lock_persona_publication_mutation(v_persona_id); end loop;
  delete from public.affiliate_partners partner
  where partner.id=p_partner_id and partner.owner=v_owner;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;

create or replace function public.delete_revenue_review_data_for_account_service(
  p_owner uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_persona_id uuid;v_count integer;v_deleted integer:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051056)
  );
  for v_persona_id in
    select persona.id from public.personas persona
    where persona.owner=p_owner order by persona.id
  loop perform public.lock_persona_publication_mutation(v_persona_id); end loop;

  -- Owner review writers lock request rows before notification/event rows.
  -- Delete the parent request first (its FKs cascade or null the dependants)
  -- so account erasure follows the same order and cannot deadlock them.
  delete from public.product_review_requests request where request.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  delete from public.product_review_notifications notification
  where notification.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  delete from public.product_review_events event where event.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  delete from public.product_review_settings setting where setting.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  delete from public.persona_review_requests request where request.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  delete from public.affiliate_click_events event where event.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  delete from public.persona_affiliate_offers offer where offer.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  delete from public.affiliate_products product where product.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  delete from public.affiliate_partners partner where partner.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  delete from public.persona_revenue_settings setting where setting.owner=p_owner;
  get diagnostics v_count=row_count;v_deleted:=v_deleted+v_count;
  return jsonb_build_object('rows_deleted',v_deleted);
end;
$$;

revoke insert,update,delete on public.persona_revenue_settings,
  public.affiliate_partners,public.affiliate_products,
  public.persona_affiliate_offers,public.affiliate_click_events,
  public.persona_review_requests,public.product_review_settings,
  public.product_review_requests,public.product_review_events,
  public.product_review_notifications from service_role;
revoke all on function public.delete_revenue_review_data_for_account_service(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.delete_revenue_review_data_for_account_service(uuid)
  to service_role;

-- Migration 044/045 owner data includes account-wide notifications and
-- activity rows whose persona_id may be null, so persona cascade alone cannot
-- satisfy either content-only or full-account erasure. Keep service erasure on
-- the same owner-before-persona lock order as other content cleanup paths.
create or replace function public.delete_owner_research_content_data_for_account_service(
  p_owner uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_persona_id uuid;
  v_total integer:=0;
  v_notifications integer:=0;
  v_activity integer:=0;
  v_variants integer:=0;
  v_packages integer:=0;
  v_annotations integer:=0;
  v_plans integer:=0;
  v_topics integer:=0;
  v_briefs integer:=0;
  v_settings integer:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051056)
  );
  for v_persona_id in
    select persona.id from public.personas persona
    where persona.owner=p_owner order by persona.id
  loop
    perform public.lock_persona_publication_mutation(v_persona_id);
  end loop;

  delete from public.owner_notifications notification
  where notification.owner=p_owner;
  get diagnostics v_notifications=row_count;
  delete from public.persona_activity_events event
  where event.owner=p_owner;
  get diagnostics v_activity=row_count;
  delete from public.persona_content_variants variant
  where variant.owner=p_owner;
  get diagnostics v_variants=row_count;
  delete from public.persona_content_packages package
  where package.owner=p_owner;
  get diagnostics v_packages=row_count;
  delete from public.research_brief_annotations annotation
  where annotation.owner=p_owner;
  get diagnostics v_annotations=row_count;
  delete from public.persona_topic_post_plans plan
  where plan.owner=p_owner;
  get diagnostics v_plans=row_count;
  delete from public.persona_research_topics topic
  where topic.owner=p_owner;
  get diagnostics v_topics=row_count;
  delete from public.persona_research_briefs brief
  where brief.owner=p_owner;
  get diagnostics v_briefs=row_count;
  delete from public.persona_research_settings setting
  where setting.owner=p_owner;
  get diagnostics v_settings=row_count;

  v_total:=v_notifications+v_activity+v_variants+v_packages+
    v_annotations+v_plans+v_topics+v_briefs+v_settings;
  return jsonb_build_object(
    'rows_deleted',v_total,
    'owner_notifications',v_notifications,
    'persona_activity_events',v_activity,
    'persona_content_variants',v_variants,
    'persona_content_packages',v_packages,
    'research_brief_annotations',v_annotations,
    'persona_topic_post_plans',v_plans,
    'persona_research_topics',v_topics,
    'persona_research_briefs',v_briefs,
    'persona_research_settings',v_settings
  );
end;
$$;

revoke insert,update,delete on public.persona_research_settings,
  public.persona_research_briefs,public.persona_research_topics,
  public.persona_topic_post_plans,public.research_brief_annotations,
  public.persona_content_packages,public.persona_content_variants,
  public.owner_notifications,public.persona_activity_events
  from service_role;
revoke all on function public.delete_owner_research_content_data_for_account_service(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.delete_owner_research_content_data_for_account_service(uuid)
  to service_role;

create or replace function public.save_persona_revenue_settings(
  p_persona_id uuid,p_settings jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if jsonb_typeof(coalesce(p_settings,'{}'::jsonb))<>'object' then raise exception 'Settings must be an object'; end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  if not exists(select 1 from public.personas persona where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found'; end if;
  if char_length(coalesce(p_settings->>'default_disclosure',''))>2000
     or char_length(coalesce(p_settings->>'cta_label',''))>200
     or char_length(coalesce(p_settings->>'review_cta_label',''))>200 then
    raise exception 'Revenue setting text is too long'; end if;
  insert into public.persona_revenue_settings(
    persona_id,owner,affiliate_enabled,review_requests_enabled,
    default_disclosure,cta_label,review_cta_label
  ) values (
    p_persona_id,v_owner,coalesce((p_settings->>'affiliate_enabled')::boolean,false),
    coalesce((p_settings->>'review_requests_enabled')::boolean,false),
    coalesce(p_settings->>'default_disclosure',''),coalesce(p_settings->>'cta_label','Get it here'),
    coalesce(p_settings->>'review_cta_label','Request a review')
  ) on conflict(persona_id) do update set
    affiliate_enabled=excluded.affiliate_enabled,
    review_requests_enabled=excluded.review_requests_enabled,
    default_disclosure=excluded.default_disclosure,cta_label=excluded.cta_label,
    review_cta_label=excluded.review_cta_label;
  return true;
end;
$$;

create or replace function public.save_affiliate_product(
  p_product_id uuid,p_product jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;v_persona_id uuid;v_partner_id uuid;
  v_tags text[]:='{}'::text[];v_status text:=coalesce(p_product->>'status','draft');
  v_owner_total integer;v_owner_day integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_owner_content_creation_quota(v_owner);
  if jsonb_typeof(coalesce(p_product,'{}'::jsonb))<>'object' then raise exception 'Product must be an object'; end if;
  if trim(coalesce(p_product->>'title',''))='' or char_length(p_product->>'title')>500
     or char_length(coalesce(p_product->>'merchant',''))>500
     or greatest(char_length(coalesce(p_product->>'product_url','')),
       char_length(coalesce(p_product->>'affiliate_url','')),
       char_length(coalesce(p_product->>'image_url','')))>2048
     or char_length(coalesce(p_product->>'category',''))>200
     or char_length(coalesce(p_product->>'disclosure',''))>2000
     or char_length(coalesce(p_product->>'price_note',''))>500
     or octet_length(coalesce(p_product->'metadata','{}'::jsonb)::text)>10000 then
    raise exception 'Affiliate product content is missing or too long'; end if;
  if not public.is_safe_credential_free_https_url(p_product->>'affiliate_url',false)
     or not public.is_safe_credential_free_https_url(p_product->>'product_url',true)
     or not public.is_safe_credential_free_https_url(p_product->>'image_url',true) then
    raise exception 'Product URLs must use HTTPS'; end if;
  if v_status not in ('draft','active','paused','archived') then raise exception 'Invalid product status'; end if;
  if p_product ? 'partner_id' and nullif(p_product->>'partner_id','') is not null then
    v_partner_id:=(p_product->>'partner_id')::uuid;
    if not exists(select 1 from public.affiliate_partners partner where partner.id=v_partner_id and partner.owner=v_owner) then
      raise exception 'Owned affiliate partner not found'; end if;
  end if;
  if p_product ? 'tags' then
    if jsonb_typeof(p_product->'tags')<>'array' or jsonb_array_length(p_product->'tags')>50 then
      raise exception 'Product tags must be an array with at most 50 entries'; end if;
    select coalesce(array_agg(left(tag.value,200) order by tag.ordinality),'{}'::text[])
    into v_tags from jsonb_array_elements_text(p_product->'tags') with ordinality tag(value,ordinality);
  end if;
  if p_product_id is not null then
    if not exists(select 1 from public.affiliate_products product where product.id=p_product_id and product.owner=v_owner) then
      raise exception 'Owned affiliate product not found'; end if;
    for v_persona_id in select distinct offer.persona_id from public.persona_affiliate_offers offer
      where offer.product_id=p_product_id and offer.owner=v_owner order by offer.persona_id
    loop perform public.lock_persona_publication_mutation(v_persona_id); end loop;
  end if;
  if p_product_id is null then
    select count(*) into v_owner_total from (
      select 1 from public.affiliate_products product
      where product.owner=v_owner limit 500
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.affiliate_products product
      where product.owner=v_owner and product.created_at>=v_day
        and product.created_at<v_day+interval '1 day' limit 20
    ) quota;
    if v_owner_total>=500 then raise exception 'Affiliate product account limit reached (500)'; end if;
    if v_owner_day>=20 then raise exception 'Affiliate product daily creation limit reached (20 UTC)'; end if;
    perform public.consume_owner_daily_rate(
      v_owner,'affiliate_products',20,1,v_owner_day
    );
    insert into public.affiliate_products(
      owner,partner_id,title,merchant,product_url,affiliate_url,category,tags,status,
      disclosure,image_url,price_note,metadata
    ) values (
      v_owner,v_partner_id,trim(p_product->>'title'),coalesce(p_product->>'merchant',''),
      coalesce(p_product->>'product_url',''),p_product->>'affiliate_url',
      coalesce(p_product->>'category',''),v_tags,v_status,
      coalesce(p_product->>'disclosure',''),coalesce(p_product->>'image_url',''),
      coalesce(p_product->>'price_note',''),coalesce(p_product->'metadata','{}'::jsonb)
    ) returning id into v_id;
  else
    update public.affiliate_products product set partner_id=v_partner_id,
      title=trim(p_product->>'title'),merchant=coalesce(p_product->>'merchant',''),
      product_url=coalesce(p_product->>'product_url',''),affiliate_url=p_product->>'affiliate_url',
      category=coalesce(p_product->>'category',''),tags=v_tags,status=v_status,
      disclosure=coalesce(p_product->>'disclosure',''),image_url=coalesce(p_product->>'image_url',''),
      price_note=coalesce(p_product->>'price_note',''),metadata=coalesce(p_product->'metadata','{}'::jsonb)
    where product.id=p_product_id and product.owner=v_owner returning product.id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_affiliate_product(p_product_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_persona_id uuid;v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if not exists(select 1 from public.affiliate_products product where product.id=p_product_id and product.owner=v_owner) then
    raise exception 'Owned affiliate product not found'; end if;
  for v_persona_id in select distinct offer.persona_id from public.persona_affiliate_offers offer
    where offer.product_id=p_product_id and offer.owner=v_owner order by offer.persona_id
  loop perform public.lock_persona_publication_mutation(v_persona_id); end loop;
  delete from public.affiliate_products product where product.id=p_product_id and product.owner=v_owner;
  get diagnostics v_count=row_count;return v_count=1;
end;
$$;

create or replace function public.save_persona_affiliate_offer(
  p_offer_id uuid,p_persona_id uuid,p_product_id uuid,p_offer jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_old_persona uuid;v_lock_id uuid;v_id uuid;
  v_placement text:=coalesce(p_offer->>'placement','general');
  v_status text:=coalesce(p_offer->>'status','active');
  v_owner_total integer;v_owner_day integer;v_persona_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_offer_id is null then
    perform public.lock_owner_content_creation_quota(v_owner);
  end if;
  perform public.require_aal2();
  if jsonb_typeof(coalesce(p_offer,'{}'::jsonb))<>'object' then raise exception 'Offer must be an object'; end if;
  if v_placement not in ('general','bio','pinned_post','review_cta','album')
     or v_status not in ('active','paused','inactive') then raise exception 'Invalid offer state'; end if;
  if char_length(coalesce(p_offer->>'cta_label',''))>200 then raise exception 'Offer CTA is too long'; end if;
  if not exists(select 1 from public.personas persona where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found'; end if;
  if not exists(select 1 from public.affiliate_products product where product.id=p_product_id and product.owner=v_owner) then
    raise exception 'Owned affiliate product not found'; end if;
  if p_offer_id is not null then
    select offer.persona_id into v_old_persona from public.persona_affiliate_offers offer
    where offer.id=p_offer_id and offer.owner=v_owner;
    if not found then raise exception 'Owned affiliate offer not found'; end if;
  end if;
  for v_lock_id in select distinct id from unnest(array[p_persona_id,v_old_persona]) id
    where id is not null order by id
  loop perform public.lock_persona_publication_mutation(v_lock_id); end loop;
  if p_offer_id is null then
    select count(*) into v_owner_total from (
      select 1 from public.persona_affiliate_offers offer
      where offer.owner=v_owner limit 2000
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.persona_affiliate_offers offer
      where offer.owner=v_owner and offer.created_at>=v_day
        and offer.created_at<v_day+interval '1 day' limit 100
    ) quota;
    select count(*) into v_persona_total from (
      select 1 from public.persona_affiliate_offers offer
      where offer.owner=v_owner and offer.persona_id=p_persona_id limit 100
    ) quota;
    if v_owner_total>=2000 then raise exception 'Affiliate offer account limit reached (2000)'; end if;
    if v_owner_day>=100 then raise exception 'Affiliate offer daily creation limit reached (100 UTC)'; end if;
    if v_persona_total>=100 then raise exception 'Affiliate offer persona limit reached (100)'; end if;
    perform public.consume_owner_daily_rate(
      v_owner,'affiliate_offers',100,1,v_owner_day
    );
    insert into public.persona_affiliate_offers(
      owner,persona_id,product_id,placement,priority,cta_label,status
    ) values (
      v_owner,p_persona_id,p_product_id,v_placement,
      greatest(-10000,least(coalesce((p_offer->>'priority')::integer,50),10000)),
      coalesce(p_offer->>'cta_label',''),v_status
    ) returning id into v_id;
  else
    update public.persona_affiliate_offers offer set persona_id=p_persona_id,
      product_id=p_product_id,placement=v_placement,
      priority=greatest(-10000,least(coalesce((p_offer->>'priority')::integer,50),10000)),
      cta_label=coalesce(p_offer->>'cta_label',''),status=v_status
    where offer.id=p_offer_id and offer.owner=v_owner returning offer.id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_persona_affiliate_offer(p_offer_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_persona_id uuid;v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select offer.persona_id into v_persona_id from public.persona_affiliate_offers offer
  where offer.id=p_offer_id and offer.owner=v_owner;
  if not found then raise exception 'Owned affiliate offer not found'; end if;
  perform public.lock_persona_publication_mutation(v_persona_id);
  delete from public.persona_affiliate_offers offer where offer.id=p_offer_id and offer.owner=v_owner;
  get diagnostics v_count=row_count;return v_count=1;
end;
$$;

revoke insert,update,delete on public.persona_revenue_settings,
  public.affiliate_partners,public.affiliate_products,
  public.persona_affiliate_offers,public.affiliate_click_events,
  public.persona_review_requests from authenticated;
revoke insert,update on public.affiliate_partners from service_role;
revoke all on function public.save_affiliate_partner(uuid,jsonb),
  public.delete_affiliate_partner(uuid),public.save_persona_revenue_settings(uuid,jsonb),
  public.save_affiliate_product(uuid,jsonb),public.delete_affiliate_product(uuid),
  public.save_persona_affiliate_offer(uuid,uuid,uuid,jsonb),
  public.delete_persona_affiliate_offer(uuid) from public,anon;
grant execute on function public.save_affiliate_partner(uuid,jsonb),
  public.delete_affiliate_partner(uuid),public.save_persona_revenue_settings(uuid,jsonb),
  public.save_affiliate_product(uuid,jsonb),public.delete_affiliate_product(uuid),
  public.save_persona_affiliate_offer(uuid,uuid,uuid,jsonb),
  public.delete_persona_affiliate_offer(uuid) to authenticated;

-- Repost and media-library scaffolding from 043 is private owner data, but its
-- original tables were unrestricted owner CRUD and its helper inputs were
-- unbounded. Preserve the feature through narrow, quota-aware RPCs.
create index if not exists persona_reposts_owner_created_quota_idx
  on public.persona_reposts(owner,created_at,id);
create index if not exists persona_reposts_persona_created_quota_idx
  on public.persona_reposts(persona_id,created_at,id);
create index if not exists persona_media_assets_owner_created_quota_idx
  on public.persona_media_assets(owner,created_at,id);
create index if not exists persona_media_assets_persona_created_quota_idx
  on public.persona_media_assets(persona_id,created_at,id);

create or replace function public.create_repost(
  p_persona_id uuid,p_source_persona_id uuid default null,
  p_source_url text default '',p_source_platform text default '',
  p_attribution_text text default '',p_repost_type text default 'quote',
  p_notes text default ''
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;v_total integer;v_day_total integer;v_persona_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_owner_content_creation_quota(v_owner);
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found'; end if;
  if p_source_persona_id is not null and not exists(
    select 1 from public.personas persona
    where persona.id=p_source_persona_id and persona.owner=v_owner
  ) then raise exception 'Owned source persona not found'; end if;
  if p_repost_type not in ('quote','share','remix','response')
     or char_length(coalesce(p_source_url,''))>2048
     or char_length(coalesce(p_source_platform,''))>64
     or coalesce(p_source_platform,'')!~'^[A-Za-z0-9._ -]{0,64}$'
     or char_length(coalesce(p_attribution_text,''))>1000
     or char_length(coalesce(p_notes,''))>4000 then
    raise exception 'Repost content is invalid or too long'; end if;
  if not public.is_safe_credential_free_https_url(coalesce(p_source_url,''),true) then
    raise exception 'Repost source URL must be credential-free HTTPS'; end if;
  if public.account_ledger_text_has_secret(p_notes) then
    raise exception 'Repost notes appear to contain a credential'; end if;
  select count(*) into v_total from (
    select 1 from public.persona_reposts repost
    where repost.owner=v_owner limit 5000
  ) quota;
  select count(*) into v_day_total from (
    select 1 from public.persona_reposts repost
    where repost.owner=v_owner and repost.created_at>=v_day
      and repost.created_at<v_day+interval '1 day' limit 200
  ) quota;
  select count(*) into v_persona_total from (
    select 1 from public.persona_reposts repost
    where repost.owner=v_owner and repost.persona_id=p_persona_id limit 500
  ) quota;
  if v_total>=5000 then raise exception 'Repost account limit reached (5000)'; end if;
  if v_day_total>=200 then raise exception 'Repost daily creation limit reached (200 UTC)'; end if;
  if v_persona_total>=500 then raise exception 'Persona repost limit reached (500)'; end if;
  perform public.consume_owner_daily_rate(v_owner,'persona_reposts',200,1,v_day_total);
  insert into public.persona_reposts(
    owner,persona_id,source_persona_id,source_url,source_platform,
    attribution_text,repost_type,status,notes
  ) values (
    v_owner,p_persona_id,p_source_persona_id,coalesce(p_source_url,''),
    trim(coalesce(p_source_platform,'')),coalesce(p_attribution_text,''),
    p_repost_type,'draft',coalesce(p_notes,'')
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.link_repost_to_draft(
  p_repost_id uuid,p_draft_id uuid
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_repost public.persona_reposts%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select * into v_repost from public.persona_reposts repost
  where repost.id=p_repost_id and repost.owner=v_owner for update;
  if not found then raise exception 'Owned repost not found'; end if;
  if v_repost.status not in ('draft','queued') then
    raise exception 'Only a draft repost can be linked'; end if;
  if not exists(select 1 from public.post_drafts draft
    where draft.id=p_draft_id and draft.owner=v_owner
      and draft.persona_id=v_repost.persona_id) then
    raise exception 'Owned draft for the repost persona not found'; end if;
  update public.persona_reposts repost set
    post_draft_id=p_draft_id,status='queued',updated_at=now()
  where repost.id=p_repost_id and repost.owner=v_owner;
end;
$$;

create or replace function public.delete_persona_repost(p_repost_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  delete from public.persona_reposts repost
  where repost.id=p_repost_id and repost.owner=v_owner
    and repost.status in ('draft','archived');
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Deletable owned repost not found'; end if;
  return true;
end;
$$;

create or replace function public.add_media_asset(
  p_persona_id uuid,p_media_type text default 'image',
  p_storage_path text default '',p_public_url text default '',
  p_alt_text text default '',p_caption text default '',
  p_source text default 'generated',p_generation_prompt text default '',
  p_generation_backend uuid default null,p_tags text[] default '{}',
  p_metadata jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;v_total integer;v_day_total integer;v_persona_total integer;
  v_tags text[]:=coalesce(p_tags,'{}'::text[]);
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_owner_content_creation_quota(v_owner);
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found'; end if;
  if p_generation_backend is not null and not exists(
    select 1 from public.ai_backends backend
    where backend.id=p_generation_backend and backend.owner=v_owner
  ) then raise exception 'Owned generation backend not found'; end if;
  if p_media_type not in ('image','video','audio','document')
     or p_source not in ('generated','uploaded','sourced','remixed')
     or char_length(coalesce(p_storage_path,''))>1024
     or char_length(coalesce(p_public_url,''))>2048
     or char_length(coalesce(p_alt_text,''))>2000
     or char_length(coalesce(p_caption,''))>5000
     or char_length(coalesce(p_generation_prompt,''))>10000
     or jsonb_typeof(coalesce(p_metadata,'null'::jsonb))<>'object'
     or octet_length(coalesce(p_metadata,'{}'::jsonb)::text)>10000
     or coalesce(array_length(v_tags,1),0)>50
     or exists(select 1 from unnest(v_tags) tag
       where tag is null or char_length(tag)>200 or tag~'[[:cntrl:]<>]') then
    raise exception 'Media asset metadata is invalid or too long'; end if;
  if coalesce(p_storage_path,'')<>'' and (
       p_storage_path!~'^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$'
       or p_storage_path~'(^|/)\.\.(/|$)'
     ) then raise exception 'Media storage path must be a safe relative object path'; end if;
  if not public.is_safe_credential_free_https_url(coalesce(p_public_url,''),true) then
    raise exception 'Media public URL must be credential-free HTTPS'; end if;
  if public.account_ledger_text_has_secret(p_generation_prompt) then
    raise exception 'Generation prompt appears to contain a credential'; end if;
  select count(*) into v_total from (
    select 1 from public.persona_media_assets asset
    where asset.owner=v_owner limit 5000
  ) quota;
  select count(*) into v_day_total from (
    select 1 from public.persona_media_assets asset
    where asset.owner=v_owner and asset.created_at>=v_day
      and asset.created_at<v_day+interval '1 day' limit 200
  ) quota;
  select count(*) into v_persona_total from (
    select 1 from public.persona_media_assets asset
    where asset.owner=v_owner and asset.persona_id=p_persona_id limit 1000
  ) quota;
  if v_total>=5000 then raise exception 'Media asset account limit reached (5000)'; end if;
  if v_day_total>=200 then raise exception 'Media asset daily creation limit reached (200 UTC)'; end if;
  if v_persona_total>=1000 then raise exception 'Persona media asset limit reached (1000)'; end if;
  perform public.consume_owner_daily_rate(v_owner,'persona_media_assets',200,1,v_day_total);
  insert into public.persona_media_assets(
    owner,persona_id,media_type,storage_path,public_url,alt_text,caption,source,
    generation_prompt,generation_backend,tags,metadata,status
  ) values (
    v_owner,p_persona_id,p_media_type,coalesce(p_storage_path,''),
    coalesce(p_public_url,''),coalesce(p_alt_text,''),coalesce(p_caption,''),
    p_source,coalesce(p_generation_prompt,''),p_generation_backend,v_tags,
    coalesce(p_metadata,'{}'::jsonb),'active'
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.set_persona_media_asset_status(
  p_asset_id uuid,p_status text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_status not in ('active','archived','flagged') then
    raise exception 'Invalid media asset status'; end if;
  update public.persona_media_assets asset set status=p_status,updated_at=now()
  where asset.id=p_asset_id and asset.owner=v_owner;
  if not found then raise exception 'Owned media asset not found'; end if;
  return true;
end;
$$;

create or replace function public.delete_persona_media_asset(p_asset_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  delete from public.persona_media_assets asset
  where asset.id=p_asset_id and asset.owner=v_owner
    and asset.status in ('archived','flagged');
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Archive or flag the owned media asset before deleting it'; end if;
  return true;
end;
$$;

create or replace function public.get_persona_media_library(
  p_persona_id uuid,p_media_type text default null
)
returns table(
  id uuid,media_type text,storage_path text,public_url text,alt_text text,
  caption text,source text,tags text[],status text,created_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  select asset.id,asset.media_type,asset.storage_path,asset.public_url,
    asset.alt_text,asset.caption,asset.source,asset.tags,asset.status,asset.created_at
  from public.persona_media_assets asset
  where asset.owner=auth.uid() and asset.persona_id=p_persona_id
    and (p_media_type is null or asset.media_type=p_media_type)
    and asset.status='active'
  order by asset.created_at desc,asset.id desc limit 500
$$;

do $migration$
begin
  if to_regprocedure('public.get_content_calendar_legacy_043(integer)') is null
     and to_regprocedure('public.get_content_calendar(integer)') is not null then
    alter function public.get_content_calendar(integer)
      rename to get_content_calendar_legacy_043;
  end if;
end
$migration$;

create or replace function public.get_content_calendar(p_days_ahead integer default 7)
returns table(
  cal_date date,persona_id uuid,persona_name text,persona_handle text,
  item_type text,task_name text,content_kind text,platform text,
  scheduled_time text,status text,draft_id uuid,task_id uuid
)
language plpgsql security definer stable set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_days_ahead not between 1 and 90 then
    raise exception 'Calendar range must be between 1 and 90 days'; end if;
  return query select * from public.get_content_calendar_legacy_043(p_days_ahead);
end;
$$;

revoke insert,update,delete on public.persona_reposts,
  public.persona_media_assets from authenticated,service_role;
revoke all on function public.create_repost(uuid,uuid,text,text,text,text,text),
  public.link_repost_to_draft(uuid,uuid),public.delete_persona_repost(uuid),
  public.add_media_asset(uuid,text,text,text,text,text,text,text,uuid,text[],jsonb),
  public.set_persona_media_asset_status(uuid,text),
  public.delete_persona_media_asset(uuid),
  public.get_persona_media_library(uuid,text),
  public.get_content_calendar_legacy_043(integer),
  public.get_content_calendar(integer)
  from public,anon,authenticated,service_role;
grant execute on function public.create_repost(uuid,uuid,text,text,text,text,text),
  public.link_repost_to_draft(uuid,uuid),public.delete_persona_repost(uuid),
  public.add_media_asset(uuid,text,text,text,text,text,text,text,uuid,text[],jsonb),
  public.set_persona_media_asset_status(uuid,text),
  public.delete_persona_media_asset(uuid),
  public.get_persona_media_library(uuid,text),
  public.get_content_calendar(integer)
  to authenticated;

-- Reviewed first-party public assets are immutable and content-addressed.
-- Owners upload a new SHA-256-named object and then save its new URL, which
-- advances the page revision. Replacement/deletion of a reviewed path is not
-- available to browser sessions; account erasure and eventual garbage
-- collection remain service-role operations.
update storage.buckets
set public=true,file_size_limit=52428800,
    allowed_mime_types=array[
      'image/png','image/jpeg','image/webp','image/gif',
      'video/mp4','video/webm','audio/mpeg','audio/ogg','audio/wav'
    ]::text[]
where id='persona-media';
drop policy if exists "persona media owner insert" on storage.objects;
create policy "persona media owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id='persona-media'
    and split_part(name,'/',1)=auth.uid()::text
    and name ~ ('^'||auth.uid()::text||'/published/(?:[a-z0-9_-]+/)*[0-9a-f]{64}\.(?:png|jpe?g|webp|gif|mp4|webm|mp3|ogg|wav)$')
  );
drop policy if exists "persona media owner update" on storage.objects;
drop policy if exists "persona media owner delete" on storage.objects;

-- Migration 014 replaced every link row on every bundle save. Wrap that
-- implementation so unchanged links do not create a false public revision,
-- while a real link change joins any profile edit in one transaction revision.
-- A target-scoped, transaction-local guard preserves stable public link ids on
-- a semantic no-op. It cannot be enabled by a browser table write and affects
-- only the exact persona id selected by this SECURITY DEFINER wrapper.
create or replace function public.preserve_persona_links_during_noop_bundle()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_persona_id uuid:=case when tg_op='DELETE' then old.persona_id else new.persona_id end;
begin
  if coalesce(current_setting('app.persona_bundle_preserve_links',true),'')=v_persona_id::text then
    return null;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.preserve_persona_links_during_noop_bundle()
  from public,anon,authenticated;
drop trigger if exists aa_preserve_persona_links_during_noop_bundle on public.persona_links;
create trigger aa_preserve_persona_links_during_noop_bundle
  before insert or delete on public.persona_links for each row
  execute function public.preserve_persona_links_during_noop_bundle();

do $migration$
begin
  if to_regprocedure('public.save_persona_bundle_legacy_014(uuid,jsonb,jsonb,text)') is null then
    alter function public.save_persona_bundle(uuid,jsonb,jsonb,text)
      rename to save_persona_bundle_legacy_014;
  end if;
end
$migration$;

create or replace function public.save_persona_bundle(
  p_persona_id uuid,p_persona jsonb,p_links jsonb,p_note text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid:=auth.uid();
  v_id uuid;
  v_links_changed boolean:=false;
  v_touched text;
  v_owner_total integer;
  v_owner_day integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
  v_prior_suppress text:=coalesce(current_setting('app.persona_bundle_suppress_content',true),'');
  v_prior_preserve text:=coalesce(current_setting('app.persona_bundle_preserve_links',true),'');
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(coalesce(p_persona,'null'::jsonb))<>'object' then
    raise exception 'Persona data must be an object';
  end if;
  if jsonb_typeof(coalesce(p_links,'null'::jsonb))<>'array'
     or jsonb_array_length(case when jsonb_typeof(p_links)='array'
       then p_links else '[]'::jsonb end)>100 then
    raise exception 'Links must be an array of at most 100 items';
  end if;
  if jsonb_typeof(coalesce(p_persona->'linked','[]'::jsonb))<>'array'
     or jsonb_array_length(case when jsonb_typeof(p_persona->'linked')='array'
       then p_persona->'linked' else '[]'::jsonb end)>100 then
    raise exception 'Linked personas must be an array of at most 100 items';
  end if;
  if p_persona_id is null then
    perform public.lock_owner_content_creation_quota(v_uid);
    select count(*) into v_owner_total from (
      select 1 from public.personas persona where persona.owner=v_uid limit 100
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.personas persona
      where persona.owner=v_uid and persona.created_at>=v_day
        and persona.created_at<v_day+interval '1 day' limit 20
    ) quota;
    if v_owner_total>=100 then raise exception 'Persona account limit reached (100)'; end if;
    if v_owner_day>=20 then raise exception 'Persona daily creation limit reached (20 UTC)'; end if;
    perform public.consume_owner_daily_rate(v_uid,'personas',20,1,v_owner_day);
  end if;
  if p_persona_id is not null then
    perform public.lock_persona_publication_mutation(p_persona_id);
  end if;
  if p_persona_id is not null and jsonb_typeof(p_links)='array' then
    if not exists(select 1 from public.personas where id=p_persona_id and owner=v_uid) then
      raise exception 'Owned persona not found';
    end if;
    select exists(
      select link.platform,link.handle,link.url,link.sort
      from public.persona_links link where link.persona_id=p_persona_id
      except all
      select coalesce(nullif(trim(item.value->>'platform'),''),'other'),
        coalesce(item.value->>'handle',''),coalesce(item.value->>'url',''),item.ordinality::integer-1
      from jsonb_array_elements(p_links) with ordinality item(value,ordinality)
    ) or exists(
      select coalesce(nullif(trim(item.value->>'platform'),''),'other'),
        coalesce(item.value->>'handle',''),coalesce(item.value->>'url',''),item.ordinality::integer-1
      from jsonb_array_elements(p_links) with ordinality item(value,ordinality)
      except all
      select link.platform,link.handle,link.url,link.sort
      from public.persona_links link where link.persona_id=p_persona_id
    ) into v_links_changed;
  end if;
  if not public.is_safe_credential_free_https_url(p_persona->>'avatar_url',true)
     or not public.is_safe_credential_free_https_url(p_persona->>'banner_url',true)
     or not public.is_safe_credential_free_https_url(p_persona->>'bg_url',true)
     or not public.is_safe_credential_free_https_url(p_persona->>'feed_img_url',true)
     or not public.is_safe_credential_free_https_url(p_persona->>'music_url',true)
     or not public.is_safe_credential_free_https_url(p_persona->>'live_url',true)
     or exists(select 1 from jsonb_array_elements(case
          when jsonb_typeof(p_links)='array' then p_links else '[]'::jsonb end) item
       where not public.is_safe_credential_free_https_url(item->>'url',true)) then
    raise exception 'Public persona and link URLs must be credential-free HTTPS URLs';
  end if;
  if not public.persona_modules_are_canonical(p_persona->'modules') then
    raise exception 'Persona modules must contain only known boolean module keys';
  end if;

  perform set_config('app.persona_bundle_suppress_content','on',true);
  if p_persona_id is not null and not v_links_changed then
    perform set_config('app.persona_bundle_preserve_links',p_persona_id::text,true);
  else
    perform set_config('app.persona_bundle_preserve_links','',true);
  end if;
  begin
    v_id:=public.save_persona_bundle_legacy_014(p_persona_id,p_persona,p_links,p_note);
  exception when others then
    perform set_config('app.persona_bundle_preserve_links',v_prior_preserve,true);
    perform set_config('app.persona_bundle_suppress_content',v_prior_suppress,true);
    raise;
  end;
  perform set_config('app.persona_bundle_preserve_links',v_prior_preserve,true);
  perform set_config('app.persona_bundle_suppress_content',v_prior_suppress,true);

  if p_persona_id is not null and v_links_changed then
    v_touched:=coalesce(current_setting('app.persona_revision_touched',true),'');
    if position(','||v_id::text||',' in ','||v_touched||',')=0 then
      perform set_config('app.persona_publication_transition','content',true);
      update public.personas
      set publication_revision=publication_revision+1,
          publication_state=case when publication_state in ('published','in_review') then 'draft' else publication_state end,
          unpublished_at=case when publication_state='published' then now() else unpublished_at end,
          updated_at=now()
      where id=v_id and owner=v_uid;
      update public.persona_publication_reviews
      set review_state='stale',updated_at=now()
      where persona_id=v_id and owner=v_uid;
      v_touched:=concat_ws(',',nullif(v_touched,''),v_id::text);
      perform set_config('app.persona_revision_touched',v_touched,true);
    end if;
  end if;
  return v_id;
end;
$$;

revoke all on function public.save_persona_bundle_legacy_014(uuid,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
revoke all on function public.save_persona_bundle(uuid,jsonb,jsonb,text)
  from public,anon;
grant execute on function public.save_persona_bundle(uuid,jsonb,jsonb,text)
  to authenticated;

-- Private learning snippets remain editable and deletable, but creation and
-- aggregate stored source are serialized under the same owner quota lock.
-- A legacy owner already above the byte cap may make a non-growing edit or
-- delete rows; the stored total cannot grow further until it is under cap.
create or replace function public.save_persona_page_code_snippet(
  p_snippet_id uuid,p_persona_id uuid,p_name text,p_language text,p_code text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_id uuid:=coalesce(p_snippet_id,extensions.gen_random_uuid());
  v_is_new boolean:=p_snippet_id is null;
  v_new_bytes integer:=octet_length(coalesce(p_code,''));
  v_old_bytes integer:=0;
  v_stored_bytes bigint;
  v_owner_total integer;
  v_owner_day integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_owner_content_creation_quota(v_owner);
  if p_persona_id is not null and not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  if trim(coalesce(p_name,''))='' or char_length(trim(p_name))>120 then
    raise exception 'Snippet name is required and must be 120 characters or less';
  end if;
  if p_language not in ('html','css','json') then
    raise exception 'Unsupported snippet language';
  end if;
  if v_new_bytes>20000 then raise exception 'Snippet code must be 20000 bytes or less'; end if;

  if not v_is_new then
    select octet_length(snippet.code) into v_old_bytes
    from public.persona_page_code_snippets snippet
    where snippet.id=p_snippet_id and snippet.owner=v_owner;
    if not found then raise exception 'Owned snippet not found'; end if;
  else
    select count(*) into v_owner_total from (
      select 1 from public.persona_page_code_snippets snippet
      where snippet.owner=v_owner limit 100
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.persona_page_code_snippets snippet
      where snippet.owner=v_owner and snippet.created_at>=v_day
        and snippet.created_at<v_day+interval '1 day' limit 20
    ) quota;
    if v_owner_total>=100 then raise exception 'Snippet account limit reached (100)'; end if;
    if v_owner_day>=20 then raise exception 'Snippet daily creation limit reached (20 UTC)'; end if;
    perform public.consume_owner_daily_rate(
      v_owner,'page_code_snippets',20,1,v_owner_day
    );
  end if;

  select coalesce(sum(octet_length(snippet.code)),0) into v_stored_bytes
  from public.persona_page_code_snippets snippet where snippet.owner=v_owner;
  if v_stored_bytes-v_old_bytes+v_new_bytes>1000000 and v_new_bytes>v_old_bytes then
    raise exception 'Snippet stored code limit reached (1000000 bytes)';
  end if;

  if v_is_new then
    insert into public.persona_page_code_snippets(id,owner,persona_id,name,language,code)
    values(v_id,v_owner,p_persona_id,trim(p_name),p_language,coalesce(p_code,''));
  else
    update public.persona_page_code_snippets snippet
    set persona_id=p_persona_id,name=trim(p_name),language=p_language,code=coalesce(p_code,'')
    where snippet.id=p_snippet_id and snippet.owner=v_owner;
    if not found then raise exception 'Owned snippet not found'; end if;
  end if;
  return v_id;
end;
$$;

revoke all on function public.save_persona_page_code_snippet(uuid,uuid,text,text,text)
  from public,anon;
grant execute on function public.save_persona_page_code_snippet(uuid,uuid,text,text,text)
  to authenticated;

-- Service credentials do not receive an unbounded alternate writer for page
-- layouts or private learning snippets. Account erasure uses one lock-ordered
-- service function instead of bypassing the same owner/persona serialization
-- used by the browser mutation paths.
revoke insert,update,delete on public.persona_page_layouts,
  public.persona_page_code_snippets from service_role;

create or replace function public.delete_persona_page_builder_data_for_account_service(
  p_owner uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_persona_id uuid;
  v_layout_count integer;
  v_snippet_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051056)
  );
  for v_persona_id in
    select layout.persona_id from public.persona_page_layouts layout
    where layout.owner=p_owner order by layout.persona_id
  loop
    perform public.lock_persona_publication_mutation(v_persona_id);
  end loop;
  delete from public.persona_page_code_snippets snippet
  where snippet.owner=p_owner;
  get diagnostics v_snippet_count=row_count;
  delete from public.persona_page_layouts layout
  where layout.owner=p_owner;
  get diagnostics v_layout_count=row_count;
  return jsonb_build_object(
    'layouts_deleted',v_layout_count,'snippets_deleted',v_snippet_count
  );
end;
$$;

revoke all on function public.delete_persona_page_builder_data_for_account_service(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.delete_persona_page_builder_data_for_account_service(uuid)
  to service_role;

-- The legacy native publisher inserts a post and immediately records the
-- automation draft as published. Under the page-level review contract that is
-- a false success: inserting the post intentionally creates a new draft page
-- revision. Preserve the old implementation only as an inaccessible migration
-- artifact, fail closed for background callers, and give an authenticated owner
-- an explicit staging action that lands the exact approved content in Review.
do $migration$
begin
  if to_regprocedure('public.publish_native_agent_draft_legacy_012(uuid,uuid,boolean)') is null then
    alter function public.publish_native_agent_draft(uuid,uuid,boolean)
      rename to publish_native_agent_draft_legacy_012;
  end if;
end
$migration$;

create or replace function public.publish_native_agent_draft(
  p_draft_id uuid,p_owner uuid,p_require_due boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode='P0001',
    message='Native automatic publication is paused until it can complete the persona page review contract',
    hint='An owner can stage the approved draft into the page and publish that exact page revision from Review.';
end;
$$;

revoke all on function public.publish_native_agent_draft_legacy_012(uuid,uuid,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.publish_native_agent_draft(uuid,uuid,boolean)
  from public,anon,authenticated;
grant execute on function public.publish_native_agent_draft(uuid,uuid,boolean)
  to service_role;

create or replace function public.stage_native_agent_draft_for_review(p_draft_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid:=auth.uid();
  v_persona_id uuid;
  v_draft public.drafts%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_target public.agent_destinations%rowtype;
  v_post public.posts%rowtype;
  v_hash text;
  v_post_id uuid;
  v_idempotent boolean:=false;
  v_existing_post boolean:=false;
  v_owner_total integer;
  v_owner_day integer;
  v_persona_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text,51051101)
  );
  select draft.persona_id into v_persona_id from public.drafts draft
  where draft.id=p_draft_id and draft.owner=v_uid;
  if not found or v_persona_id is null then raise exception 'Draft persona is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_persona_id::text,51051102)
  );
  perform public.lock_owner_content_creation_quota(v_uid);
  perform public.lock_persona_publication_mutation(v_persona_id);
  select * into v_draft from public.drafts
  where id=p_draft_id and owner=v_uid for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.persona_id is distinct from v_persona_id then
    raise exception 'Draft persona changed; retry the operation';
  end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history requires reconciliation';
  end if;
  if v_draft.account_id is not null
     or public.normalize_agent_destination(v_draft.platform) not in (
       'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
     ) then
    raise exception 'Only a native-feed draft can be staged in page review';
  end if;
  if coalesce(v_draft.title,'')='' and coalesce(v_draft.body,'')=''
     and coalesce(v_draft.media_url,'')='' then
    raise exception 'Draft content is empty';
  end if;
  if char_length(coalesce(v_draft.title,''))>1000
     or char_length(coalesce(v_draft.body,''))>30000
     or char_length(coalesce(v_draft.tags,''))>4000
     or char_length(coalesce(v_draft.media_url,''))>2048 then
    raise exception 'Post content is too long';
  end if;
  if not public.is_safe_credential_free_https_url(v_draft.media_url,true) then
    raise exception 'Post media requires a credential-free HTTPS URL';
  end if;

  select * into v_binding from public.agent_bindings
  where owner=v_uid and persona_id=v_draft.persona_id for share;
  if not found or v_binding.status<>'active'
     or v_binding.claim_state not in ('self_attested','verified')
     or v_binding.autonomy_level<2 then
    raise exception 'An active claimed L2 or L3 persona binding is required';
  end if;
  select * into v_target from public.agent_destinations
  where owner=v_uid and binding_id=v_binding.id
    and persona_id=v_draft.persona_id and account_id is null
    and public.normalize_agent_destination(destination) in (
      'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
    ) for share;
  if not found or not v_target.enabled or v_target.mode='manual'
     or not (v_draft.content_kind=any(v_target.allowed_content_types)) then
    raise exception 'The native review-staging target is not enabled for this content';
  end if;

  v_hash:=public.agent_draft_hash(
    v_draft.title,v_draft.body,v_draft.tags,v_draft.media_url,
    v_draft.content_kind,v_draft.persona_id,v_draft.account_id,
    v_draft.platform,v_draft.publish_at
  );
  if v_draft.approval_state<>'approved'
     or v_draft.approved_content_hash='' or v_hash is distinct from v_draft.approved_content_hash then
    raise exception 'Exact owner approval is required';
  end if;
  if not exists (
    select 1 from public.personas
    where id=v_draft.persona_id and owner=v_uid
  ) then raise exception 'Owned persona not found'; end if;

  if coalesce(v_draft.provider_post_id,'') ~
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    select * into v_post from public.posts
    where id=v_draft.provider_post_id::uuid and persona_id=v_draft.persona_id
    for update;
    v_existing_post:=found;
  end if;

  if v_existing_post then
    v_idempotent:=row(v_post.kind,v_post.title,v_post.body,v_post.tags,v_post.media_url)
      is not distinct from row(
        case when v_draft.content_kind='reel' then 'reel' else 'post' end,
        coalesce(v_draft.title,''),coalesce(v_draft.body,''),
        coalesce(v_draft.tags,''),coalesce(v_draft.media_url,'')
      );
    if not v_idempotent then
      update public.posts set
        kind=case when v_draft.content_kind='reel' then 'reel' else 'post' end,
        title=coalesce(v_draft.title,''),body=coalesce(v_draft.body,''),
        tags=coalesce(v_draft.tags,''),media_url=coalesce(v_draft.media_url,'')
      where id=v_post.id returning id into v_post_id;
    else
      v_post_id:=v_post.id;
    end if;
  else
    select count(*) into v_owner_total from (
      select 1 from public.posts post
      join public.personas persona on persona.id=post.persona_id
      where persona.owner=v_uid limit 5000
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.posts post
      join public.personas persona on persona.id=post.persona_id
      where persona.owner=v_uid and post.created_at>=v_day
        and post.created_at<v_day+interval '1 day' limit 200
    ) quota;
    select count(*) into v_persona_total from (
      select 1 from public.posts post where post.persona_id=v_persona_id limit 500
    ) quota;
    if v_owner_total>=5000 then raise exception 'Post account limit reached (5000)'; end if;
    if v_owner_day>=200 then raise exception 'Post daily creation limit reached (200 UTC)'; end if;
    if v_persona_total>=500 then raise exception 'Post persona limit reached (500)'; end if;
    perform public.consume_owner_daily_rate(v_uid,'posts',200,1,v_owner_day);
    insert into public.posts(persona_id,kind,title,body,tags,media_url)
    values(
      v_draft.persona_id,
      case when v_draft.content_kind='reel' then 'reel' else 'post' end,
      coalesce(v_draft.title,''),coalesce(v_draft.body,''),
      coalesce(v_draft.tags,''),coalesce(v_draft.media_url,'')
    ) returning id into v_post_id;
  end if;

  update public.drafts set
    status='ready',publish_state='blocked',publish_next_attempt_at=null,
    provider_post_id=v_post_id::text,
    publish_error='Staged in the persona page draft. Publish the exact page revision from Review.'
  where id=v_draft.id;
  insert into public.agent_actions(
    owner,persona_id,binding_id,action_type,entity_type,entity_id,outcome,detail
  ) values(
    v_uid,v_draft.persona_id,v_binding.id,'publish.staged_for_page_review',
    'draft',v_draft.id,'ok',jsonb_build_object(
      'destination','aliaspaces','postId',v_post_id,'idempotent',v_idempotent,
      'published',false
    )
  );
  return jsonb_build_object(
    'staged',true,'published',false,'draftId',v_draft.id,
    'personaId',v_draft.persona_id,'postId',v_post_id,'idempotent',v_idempotent
  );
end;
$$;

revoke all on function public.stage_native_agent_draft_for_review(uuid)
  from public,anon;
grant execute on function public.stage_native_agent_draft_for_review(uuid)
  to authenticated;

create or replace function public.remove_exact_staged_native_post(p_draft public.drafts)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_post public.posts%rowtype;
begin
  if p_draft.account_id is not null
     or public.normalize_agent_destination(p_draft.platform) not in (
       'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
     )
     or coalesce(p_draft.provider_post_id,'') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  select * into v_post from public.posts post
  where post.id=p_draft.provider_post_id::uuid and post.persona_id=p_draft.persona_id
  for update;
  if not found then return false; end if;
  if row(v_post.kind,v_post.title,v_post.body,v_post.tags,v_post.media_url)
      is distinct from row(
        case when p_draft.content_kind='reel' then 'reel' else 'post' end,
        coalesce(p_draft.title,''),coalesce(p_draft.body,''),
        coalesce(p_draft.tags,''),coalesce(p_draft.media_url,'')
      ) then
    raise exception 'The staged page post was edited. Reconcile or remove it in page Review before rejecting or deleting its source draft.';
  end if;
  delete from public.posts post where post.id=v_post.id;
  return true;
end;
$$;

revoke all on function public.remove_exact_staged_native_post(public.drafts)
  from public,anon,authenticated;

-- Migration 011 exposed a bulk draft erasure helper that bypassed staged-page
-- reconciliation. Preserve explicit owner erasure, but lock every affected
-- persona first and remove only the exact staged page projection before the
-- source draft disappears.
create or replace function public.delete_my_drafts_for_erasure()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_persona_id uuid;
  v_draft public.drafts%rowtype;
  v_removed boolean;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051101)
  );
  for v_persona_id in
    select distinct draft.persona_id from public.drafts draft
    where draft.owner=v_owner and draft.persona_id is not null
    order by draft.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_persona_id::text,51051102)
    );
  end loop;
  for v_persona_id in
    select distinct draft.persona_id from public.drafts draft
    where draft.owner=v_owner and draft.persona_id is not null
    order by draft.persona_id
  loop
    perform public.lock_persona_publication_mutation(v_persona_id);
  end loop;
  for v_draft in
    select draft.* from public.drafts draft
    where draft.owner=v_owner order by draft.id for update
  loop
    v_removed:=public.remove_exact_staged_native_post(v_draft);
  end loop;
  delete from public.drafts draft where draft.owner=v_owner;
  return true;
end;
$$;
revoke all on function public.delete_my_drafts_for_erasure()
  from public,anon,authenticated,service_role;
grant execute on function public.delete_my_drafts_for_erasure()
  to authenticated;

create or replace function public.reject_agent_draft(p_draft_id uuid)
returns public.drafts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_persona_id uuid;
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
  v_removed boolean;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051101)
  );
  select draft.persona_id into v_persona_id from public.drafts draft
  where draft.id=p_draft_id and draft.owner=v_owner;
  if not found or v_persona_id is null then raise exception 'Draft not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_persona_id::text,51051102)
  );
  perform public.lock_persona_publication_mutation(v_persona_id);
  select * into v_draft from public.drafts draft
  where draft.id=p_draft_id and draft.owner=v_owner for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history cannot be rejected';
  end if;
  v_removed:=public.remove_exact_staged_native_post(v_draft);
  select binding.id into v_binding_id from public.agent_bindings binding
  where binding.persona_id=v_draft.persona_id and binding.owner=v_owner;
  update public.drafts set approval_state='rejected',approved_at=null,
    approved_content_hash='',publish_state='not_queued',publish_next_attempt_at=null,
    provider_post_id='',publish_error='',status='idea'
  where id=p_draft_id returning * into v_draft;
  insert into public.agent_actions(
    owner,persona_id,binding_id,action_type,entity_type,entity_id,detail
  ) values (
    v_owner,v_draft.persona_id,v_binding_id,'draft.rejected','draft',v_draft.id,
    jsonb_build_object('staged_post_removed',v_removed)
  );
  return v_draft;
end;
$$;

create or replace function public.delete_my_draft(p_draft_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_persona_id uuid;
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
  v_removed boolean;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051101)
  );
  select draft.persona_id into v_persona_id from public.drafts draft
  where draft.id=p_draft_id and draft.owner=v_owner;
  if not found or v_persona_id is null then raise exception 'Draft not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_persona_id::text,51051102)
  );
  perform public.lock_persona_publication_mutation(v_persona_id);
  select * into v_draft from public.drafts draft
  where draft.id=p_draft_id and draft.owner=v_owner for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing and published history cannot be deleted from the queue';
  end if;
  v_removed:=public.remove_exact_staged_native_post(v_draft);
  select binding.id into v_binding_id from public.agent_bindings binding
  where binding.persona_id=v_draft.persona_id and binding.owner=v_owner;
  delete from public.drafts draft where draft.id=p_draft_id;
  insert into public.agent_actions(
    owner,persona_id,binding_id,action_type,entity_type,entity_id,detail
  ) values (
    v_owner,v_draft.persona_id,v_binding_id,'draft.deleted','draft',v_draft.id,
    jsonb_build_object('staged_post_removed',v_removed)
  );
  return true;
end;
$$;

revoke all on function public.reject_agent_draft(uuid),public.delete_my_draft(uuid)
  from public,anon;
grant execute on function public.reject_agent_draft(uuid),public.delete_my_draft(uuid)
  to authenticated;

-- No queued native draft may continue toward the legacy publisher after this
-- migration. Published history and in-flight reconciliation records are left
-- untouched; only still-queued work is returned to owner review.
update public.drafts
set approval_state='pending',approved_at=null,approved_content_hash='',
    publish_state='not_queued',publish_next_attempt_at=null,
    publish_error='Native automatic publishing was paused for exact page-level review.'
where account_id is null and publish_state='queued'
  and public.normalize_agent_destination(platform) in (
    'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
  );
update public.agent_destinations
set mode='approval',updated_at=now()
where account_id is null and mode='auto'
  and public.normalize_agent_destination(destination) in (
    'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
  );

-- ---------------------------------------------------------------------------
-- Platform roles and owner-confirmed feature request queue
-- ---------------------------------------------------------------------------

create table if not exists public.platform_role_assignments (
  account_id   uuid not null references public.profiles(id) on delete cascade,
  role_key     text not null check (role_key in ('global_administrator','technician','security_auditor')),
  granted_by   uuid references public.profiles(id) on delete set null,
  reason       text not null default '' check (char_length(reason) <= 1000),
  active       boolean not null default true,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (account_id, role_key)
);

create or replace function public.has_platform_role(p_roles text[])
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.platform_role_assignments assignment
    where assignment.account_id = auth.uid()
      and assignment.active
      and (assignment.expires_at is null or assignment.expires_at > now())
      and assignment.role_key = any(coalesce(p_roles, '{}'::text[]))
  )
$$;

revoke all on function public.has_platform_role(text[]) from public, anon;
grant execute on function public.has_platform_role(text[]) to authenticated;

create table if not exists public.platform_feature_requests (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null references public.profiles(id) on delete cascade,
  persona_id          uuid references public.personas(id) on delete cascade,
  title               text not null check (char_length(title) between 3 and 300),
  intention           text not null default '' check (char_length(intention) <= 12000),
  description         text not null default '' check (char_length(description) <= 30000),
  source_context      jsonb not null default '{}'::jsonb
                      check (octet_length(source_context::text) <= 30000),
  status              text not null default 'draft'
                      check (status in ('draft','submitted','triaged','planned','declined','completed','withdrawn')),
  priority            text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assigned_to         uuid references public.profiles(id) on delete set null,
  staff_notes         text not null default '' check (char_length(staff_notes) <= 30000),
  submitted_at        timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);

create table if not exists public.platform_feature_request_events (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.platform_feature_requests(id) on delete cascade,
  actor_id       uuid references public.profiles(id) on delete set null,
  event_type     text not null check (event_type in ('created','submitted','withdrawn','triaged','assigned','planned','declined','completed','commented')),
  from_status    text not null default '',
  to_status      text not null default '',
  note           text not null default '' check (char_length(note) <= 12000),
  created_at     timestamptz not null default now()
);

create index if not exists platform_feature_requests_owner_idx
  on public.platform_feature_requests(owner, status, updated_at desc);
create index if not exists platform_feature_requests_staff_idx
  on public.platform_feature_requests(status, priority, submitted_at)
  where status <> 'draft';
create index if not exists platform_feature_requests_owner_created_idx
  on public.platform_feature_requests(owner,created_at desc);
create index if not exists platform_feature_requests_owner_submitted_idx
  on public.platform_feature_requests(owner,submitted_at desc)
  where submitted_at is not null;

-- ---------------------------------------------------------------------------
-- Follow and friend are deliberately different relationships
-- ---------------------------------------------------------------------------

create table if not exists public.persona_follows (
  follower_persona_id uuid not null references public.personas(id) on delete cascade,
  target_persona_id   uuid not null references public.personas(id) on delete cascade,
  visibility          text not null default 'public' check (visibility in ('public','private')),
  created_at          timestamptz not null default now(),
  primary key (follower_persona_id, target_persona_id),
  check (follower_persona_id <> target_persona_id)
);

create index if not exists persona_follows_target_idx
  on public.persona_follows(target_persona_id, created_at desc);
create index if not exists persona_follows_follower_created_quota_idx
  on public.persona_follows(follower_persona_id,created_at,target_persona_id);

create table if not exists public.persona_friend_settings (
  persona_id             uuid primary key,
  owner                  uuid not null references public.profiles(id) on delete cascade,
  request_mode           text not null default 'open'
                         check (request_mode in ('open','invite_proof','contact_proof','closed')),
  daily_request_limit    integer not null default 20 check (daily_request_limit between 1 and 100),
  pending_request_limit  integer not null default 100 check (pending_request_limit between 1 and 1000),
  note                   text not null default '' check (char_length(note) <= 1000),
  updated_at             timestamptz not null default now(),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);

create table if not exists public.persona_friend_invites (
  id                uuid primary key default gen_random_uuid(),
  target_persona_id uuid not null references public.personas(id) on delete cascade,
  owner             uuid not null references public.profiles(id) on delete cascade,
  token_hash        text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label             text not null default '' check (char_length(label) <= 200),
  max_uses          integer not null default 1 check (max_uses between 1 and 100),
  use_count         integer not null default 0 check (use_count >= 0),
  expires_at        timestamptz not null,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  foreign key (target_persona_id, owner) references public.personas(id, owner) on delete cascade
);
create index if not exists persona_friend_invites_owner_created_idx
  on public.persona_friend_invites(owner,created_at desc);
create index if not exists persona_friend_invites_active_idx
  on public.persona_friend_invites(owner,target_persona_id,expires_at)
  where revoked_at is null;

create table if not exists public.friend_request_security_events (
  id                   bigint generated always as identity primary key,
  requester_owner      uuid,
  follower_persona_id  uuid,
  target_persona_id    uuid,
  outcome              text not null check (outcome in (
                         'requested','blocked','rate_limited','invite_required',
                         'invalid_invite','contact_proof_unavailable','closed',
                         'target_unavailable','target_inbox_full'
                       )),
  created_at           timestamptz not null default now()
);

create index if not exists friend_request_security_events_requester_idx
  on public.friend_request_security_events(requester_owner, created_at desc);
create index if not exists friend_request_security_events_target_idx
  on public.friend_request_security_events(target_persona_id, created_at desc);
create index if not exists friend_request_security_events_requester_cursor_idx
  on public.friend_request_security_events(requester_owner, created_at desc, id desc);
create index if not exists friend_request_security_events_follower_cursor_idx
  on public.friend_request_security_events(follower_persona_id, created_at desc, id desc);
create index if not exists friend_request_security_events_target_cursor_idx
  on public.friend_request_security_events(target_persona_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Authenticated account feed-sync preferences (preferences only; no worker)
-- ---------------------------------------------------------------------------

create table if not exists public.persona_account_sync_settings (
  ledger_id            uuid not null,
  persona_id           uuid not null references public.personas(id) on delete cascade,
  owner                uuid not null references public.profiles(id) on delete cascade,
  enabled              boolean not null default false,
  direction            text not null default 'import_only'
                       check (direction in ('import_only','export_only','both')),
  post_kinds           text[] not null default array['post']::text[],
  include_replies      boolean not null default false,
  include_reposts      boolean not null default false,
  publication_policy   text not null default 'review_required'
                       check (publication_policy in ('draft_only','review_required','mirror_public')),
  since_at             timestamptz,
  last_sync_at         timestamptz,
  last_error           text not null default '' check (char_length(last_error) <= 2000),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (ledger_id, persona_id),
  foreign key (ledger_id, owner) references public.account_ledger(id, owner) on delete cascade,
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade,
  check (cardinality(post_kinds) between 1 and 12),
  check (post_kinds <@ array['post','image','video','reel','story','article','newsletter','reply','repost']::text[])
);

create index if not exists persona_account_sync_settings_persona_idx
  on public.persona_account_sync_settings(persona_id, enabled, updated_at desc);

create or replace function public.remove_stale_persona_account_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'account_persona_links' then
    if tg_op='DELETE'
       or new.ledger_id is distinct from old.ledger_id
       or new.persona_id is distinct from old.persona_id then
      delete from public.persona_account_sync_settings
      where ledger_id=old.ledger_id and persona_id=old.persona_id and owner=old.owner;
    end if;
  elsif old.persona_id is not null and new.persona_id is distinct from old.persona_id then
    delete from public.persona_account_sync_settings
    where ledger_id=old.id and persona_id=old.persona_id and owner=old.owner;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public.remove_stale_persona_account_sync()
  from public, anon, authenticated;
drop trigger if exists remove_stale_sync_after_account_persona_link on public.account_persona_links;
create trigger remove_stale_sync_after_account_persona_link
  after delete or update of ledger_id,persona_id on public.account_persona_links
  for each row execute function public.remove_stale_persona_account_sync();
drop trigger if exists remove_stale_sync_after_primary_persona_change on public.account_ledger;
create trigger remove_stale_sync_after_primary_persona_change
  after update of persona_id on public.account_ledger
  for each row execute function public.remove_stale_persona_account_sync();

-- ---------------------------------------------------------------------------
-- Moderated extension submissions. Source is inert until staff approval and a
-- separate sandboxed build/release; this table is never a runtime script source.
-- ---------------------------------------------------------------------------

create table if not exists public.persona_extension_submissions (
  id              uuid primary key default gen_random_uuid(),
  owner           uuid not null references public.profiles(id) on delete cascade,
  persona_id      uuid references public.personas(id) on delete cascade,
  title           text not null check (char_length(title) between 3 and 200),
  source_type     text not null check (source_type in ('component_json','html_css','typescript')),
  source_code     text not null check (octet_length(source_code) between 1 and 100000),
  requested_permissions text[] not null default '{}',
  status          text not null default 'draft'
                  check (status in ('draft','submitted','reviewing','approved','rejected','quarantined','withdrawn')),
  review_notes    text not null default '' check (char_length(review_notes) <= 12000),
  submitted_at    timestamptz,
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade,
  check (requested_permissions <@ array['none','persona_public_fields','theme_tokens','public_assets','outbound_links']::text[])
);

create index if not exists persona_extension_submissions_owner_idx
  on public.persona_extension_submissions(owner, status, updated_at desc);
create index if not exists persona_extension_submissions_staff_idx
  on public.persona_extension_submissions(status, submitted_at)
  where status in ('submitted','reviewing','quarantined');
create index if not exists persona_extension_submissions_owner_created_idx
  on public.persona_extension_submissions(owner,created_at desc);
create index if not exists persona_extension_submissions_owner_submitted_idx
  on public.persona_extension_submissions(owner,submitted_at desc)
  where submitted_at is not null;

-- ---------------------------------------------------------------------------
-- Security audit, progressive account state, and hashed network blocks
-- ---------------------------------------------------------------------------

create table if not exists public.account_security_states (
  user_id                   uuid primary key references auth.users(id) on delete cascade,
  password_failed_count     integer not null default 0 check (password_failed_count >= 0),
  password_window_started_at timestamptz,
  password_last_failed_at   timestamptz,
  mfa_failed_count          integer not null default 0 check (mfa_failed_count >= 0),
  mfa_window_started_at     timestamptz,
  mfa_last_failed_at        timestamptz,
  locked_until              timestamptz,
  locked_at                 timestamptz,
  lock_reason               text not null default '' check (char_length(lock_reason) <= 500),
  notification_pending      boolean not null default false,
  last_notified_at          timestamptz,
  updated_at                timestamptz not null default now()
);

create table if not exists public.platform_security_events (
  id               bigint generated always as identity primary key,
  actor_id         uuid,
  event_type       text not null check (char_length(event_type) between 1 and 100),
  severity         text not null default 'info' check (severity in ('info','warning','high','critical')),
  source           text not null default 'application'
                   check (source in ('application','auth_hook','waf','log_drain','edge_function','staff')),
  subject_type     text not null default '' check (char_length(subject_type) <= 80),
  subject_id       text not null default '' check (char_length(subject_id) <= 300),
  identifier_hash  text not null default '' check (identifier_hash = '' or identifier_hash ~ '^[0-9a-f]{64}$'),
  metadata         jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 20000),
  created_at       timestamptz not null default now()
);

alter table public.platform_security_events
  add column if not exists subject_account_id uuid references auth.users(id) on delete cascade;

create index if not exists platform_security_events_actor_idx
  on public.platform_security_events(actor_id, created_at desc);
create index if not exists platform_security_events_actor_cursor_idx
  on public.platform_security_events(actor_id, created_at desc, id desc);
create index if not exists platform_security_events_subject_cursor_idx
  on public.platform_security_events(subject_account_id, created_at desc, id desc)
  where subject_account_id is not null;
create index if not exists platform_security_events_queue_idx
  on public.platform_security_events(severity, created_at desc)
  where severity in ('high','critical');

create table if not exists public.security_network_blocks (
  identifier_hash text primary key check (identifier_hash ~ '^[0-9a-f]{64}$'),
  block_level     text not null check (block_level in ('timeout','account','network')),
  reason          text not null check (char_length(reason) between 1 and 1000),
  source          text not null default 'waf' check (source in ('waf','log_drain','staff','edge_function')),
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.security_network_blocks
  add column if not exists subject_account_id uuid references auth.users(id) on delete cascade;
alter table public.security_network_blocks
  drop constraint if exists security_network_blocks_account_subject_check;
alter table public.security_network_blocks
  add constraint security_network_blocks_account_subject_check
  check (block_level <> 'account' or subject_account_id is not null) not valid;
create index if not exists security_network_blocks_subject_account_idx
  on public.security_network_blocks(subject_account_id, updated_at desc)
  where subject_account_id is not null;
create index if not exists security_network_blocks_subject_cursor_idx
  on public.security_network_blocks(subject_account_id, updated_at desc, identifier_hash desc)
  where subject_account_id is not null;

alter table public.error_logs add column if not exists severity text not null default 'error';
alter table public.error_logs drop constraint if exists error_logs_severity_check;
alter table public.error_logs add constraint error_logs_severity_check
  check (severity in ('info','warning','error','critical'));
create index if not exists error_logs_created_idx on public.error_logs(created_at desc);
create index if not exists error_logs_user_created_idx on public.error_logs(user_id, created_at desc);

-- Replace the historical insert-open telemetry table with a bounded,
-- authenticated, server-authored report path. Callers cannot choose severity,
-- reporter, timestamp, or arbitrary JSON shape, and concurrent requests share
-- a per-account hourly cap. Signed-out errors stay in the local browser buffer.
drop policy if exists "error logs insert" on public.error_logs;
revoke insert,update,delete on public.error_logs from public,anon,authenticated;

create or replace function public.redact_client_error_text(
  p_value text,p_limit integer default 1000
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_limit integer:=greatest(0,least(coalesce(p_limit,1000),2000));
  v text:=left(coalesce(p_value,''),16000);
begin
  v:=regexp_replace(v,'-----BEGIN[^-]{0,80}PRIVATE KEY-----.*','[REDACTED PRIVATE KEY]','gis');
  v:=regexp_replace(v,'(bearer[[:space:]]+)?(sk-|gh[pousr]_|AIza|xox[baprs]-)[[:alnum:]_.-]{12,}','[REDACTED CREDENTIAL]','gi');
  v:=regexp_replace(v,'(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|authorization)[[:space:]]*[:=][[:space:]]*[^[:space:],;]+','[REDACTED CREDENTIAL FIELD]','gi');
  v:=regexp_replace(v,'[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}','[REDACTED EMAIL]','gi');
  v:=regexp_replace(v,'https?://[^[:space:]]+','[REDACTED URL]','gi');
  return left(v,v_limit);
end;
$$;

create or replace function public.report_client_error(
  p_message text default '',p_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid:=auth.uid();
  v_context jsonb:=case when jsonb_typeof(p_context)='object' then p_context else '{}'::jsonb end;
  v_recent jsonb:='[]'::jsonb;
  v_count integer;
  v_id uuid;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if octet_length(coalesce(p_message,''))>16384
     or octet_length(coalesce(p_context,'{}'::jsonb)::text)>65536 then
    raise exception 'Error report payload is too large';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text,51051));
  select count(*) into v_count from public.error_logs
  where user_id=v_uid and created_at>=now()-interval '1 hour';
  if v_count>=30 then raise exception 'Error report limit reached; try again later'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'kind',public.redact_client_error_text(item.value->>'kind',40),
    'message',public.redact_client_error_text(item.value->>'message',500)
  ) order by item.ordinality),'[]'::jsonb) into v_recent
  from jsonb_array_elements(
    case when jsonb_typeof(v_context->'recent')='array'
      then v_context->'recent' else '[]'::jsonb end
  ) with ordinality item(value,ordinality)
  where item.ordinality<=15 and jsonb_typeof(item.value)='object';

  insert into public.error_logs(user_id,message,context,severity,created_at)
  values(
    v_uid,public.redact_client_error_text(p_message,1000),
    jsonb_build_object(
      'page',public.redact_client_error_text(v_context->>'page',500),
      'user_agent',public.redact_client_error_text(v_context->>'user_agent',300),
      'recent',v_recent,'client_report',true
    ),
    'error',now()
  ) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.redact_client_error_text(text,integer)
  from public,anon,authenticated;
revoke all on function public.report_client_error(text,jsonb)
  from public,anon;
grant execute on function public.report_client_error(text,jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: browser reads are scoped; sensitive writes use narrowly-scoped RPCs.
-- ---------------------------------------------------------------------------

alter table public.persona_publication_reviews enable row level security;
alter table public.persona_publication_dependency_sets enable row level security;
alter table public.persona_publication_dependencies enable row level security;
alter table public.platform_role_assignments enable row level security;
alter table public.platform_feature_requests enable row level security;
alter table public.platform_feature_request_events enable row level security;
alter table public.persona_follows enable row level security;
alter table public.persona_friend_settings enable row level security;
alter table public.persona_friend_invites enable row level security;
alter table public.friend_request_security_events enable row level security;
alter table public.persona_account_sync_settings enable row level security;
alter table public.persona_extension_submissions enable row level security;
alter table public.account_security_states enable row level security;
alter table public.platform_security_events enable row level security;
alter table public.security_network_blocks enable row level security;

drop policy if exists "publication reviews owner or staff read" on public.persona_publication_reviews;
drop policy if exists "publication reviews owner read" on public.persona_publication_reviews;
drop policy if exists "publication dependency sets owner read" on public.persona_publication_dependency_sets;
drop policy if exists "publication dependencies owner read" on public.persona_publication_dependencies;
drop policy if exists "platform roles self read" on public.platform_role_assignments;
drop policy if exists "feature requests owner or staff read" on public.platform_feature_requests;
drop policy if exists "feature request events owner or staff read" on public.platform_feature_request_events;
drop policy if exists "persona follows visible read" on public.persona_follows;
drop policy if exists "friend settings owner read" on public.persona_friend_settings;
drop policy if exists "friend invites owner read" on public.persona_friend_invites;
drop policy if exists "account sync owner read" on public.persona_account_sync_settings;
drop policy if exists "extension submissions owner or staff read" on public.persona_extension_submissions;
drop policy if exists "account security self read" on public.account_security_states;
drop policy if exists "account security auth hook" on public.account_security_states;
drop policy if exists "security events staff read" on public.platform_security_events;
drop policy if exists "security events auth hook insert" on public.platform_security_events;
drop policy if exists "error logs staff read" on public.error_logs;

create policy "publication reviews owner read" on public.persona_publication_reviews
  for select to authenticated using (owner = auth.uid());
create policy "publication dependency sets owner read" on public.persona_publication_dependency_sets
  for select to authenticated using (owner = auth.uid());
create policy "publication dependencies owner read" on public.persona_publication_dependencies
  for select to authenticated using (owner = auth.uid());
create policy "platform roles self read" on public.platform_role_assignments
  for select to authenticated using (account_id = auth.uid());
create policy "feature requests owner or staff read" on public.platform_feature_requests
  for select to authenticated using (
    owner = auth.uid() or (
      status not in ('draft','withdrawn')
      and public.has_platform_role(array['global_administrator','technician']::text[])
    )
  );
create policy "feature request events owner or staff read" on public.platform_feature_request_events
  for select to authenticated using (exists (
    select 1 from public.platform_feature_requests request
    where request.id = request_id and (
      request.owner = auth.uid() or (
        request.status not in ('draft','withdrawn')
        and public.has_platform_role(array['global_administrator','technician']::text[])
      )
    )
  ));
create policy "persona follows visible read" on public.persona_follows
  for select using (
    public.owns_persona(follower_persona_id)
    or public.owns_persona(target_persona_id)
    or (
      visibility = 'public'
      and exists (
        select 1 from public.personas follower
        where follower.id=follower_persona_id
          and follower.publication_state='published'
          and follower.visibility in ('public','unlisted')
          and public.persona_visible(follower.id)
      )
      and exists (
        select 1 from public.personas target
        where target.id=target_persona_id
          and target.publication_state='published'
          and target.visibility in ('public','unlisted')
          and public.persona_visible(target.id)
      )
    )
  );
create policy "friend settings owner read" on public.persona_friend_settings
  for select to authenticated using (owner = auth.uid());
create policy "friend invites owner read" on public.persona_friend_invites
  for select to authenticated using (owner = auth.uid());
create policy "account sync owner read" on public.persona_account_sync_settings
  for select to authenticated using (owner = auth.uid());
create policy "extension submissions owner or staff read" on public.persona_extension_submissions
  for select to authenticated using (
    owner = auth.uid() or (
      status in ('submitted','reviewing','approved','rejected','quarantined')
      and public.has_platform_role(array['global_administrator','technician']::text[])
    )
  );
create policy "account security self read" on public.account_security_states
  for select to authenticated using (user_id = auth.uid());
create policy "account security auth hook" on public.account_security_states
  for all to supabase_auth_admin using (true) with check (true);
create policy "security events staff read" on public.platform_security_events
  for select to authenticated using (
    public.has_platform_role(array['global_administrator','technician','security_auditor']::text[])
  );
create policy "security events auth hook insert" on public.platform_security_events
  for insert to supabase_auth_admin with check (true);
create policy "error logs staff read" on public.error_logs
  for select to authenticated using (
    public.has_platform_role(array['global_administrator','technician','security_auditor']::text[])
  );

revoke all on public.persona_publication_reviews,
  public.persona_publication_dependency_sets, public.persona_publication_dependencies,
  public.platform_role_assignments,
  public.platform_feature_requests, public.platform_feature_request_events,
  public.persona_follows, public.persona_friend_settings, public.persona_friend_invites,
  public.friend_request_security_events, public.persona_account_sync_settings,
  public.persona_extension_submissions, public.account_security_states,
  public.platform_security_events, public.security_network_blocks
  from public, anon, authenticated;
grant select on public.persona_publication_reviews,
  public.persona_publication_dependency_sets, public.persona_publication_dependencies,
  public.platform_role_assignments,
  public.platform_feature_requests, public.platform_feature_request_events,
  public.persona_follows, public.persona_friend_settings, public.persona_friend_invites,
  public.persona_account_sync_settings, public.persona_extension_submissions,
  public.account_security_states, public.platform_security_events
  to authenticated;
grant all on public.persona_publication_reviews,
  public.persona_publication_dependency_sets, public.persona_publication_dependencies,
  public.platform_role_assignments,
  public.platform_feature_requests, public.platform_feature_request_events,
  public.persona_follows, public.persona_friend_settings, public.persona_friend_invites,
  public.friend_request_security_events, public.persona_account_sync_settings,
  public.persona_extension_submissions, public.account_security_states,
  public.platform_security_events, public.security_network_blocks
  to service_role;

-- Direct friend-request insertion/update is replaced by policy-aware RPCs.
drop policy if exists "follows read" on public.follows;
create policy "follows read" on public.follows for select
  using (public.owns_persona(follower) or public.owns_persona(target));
revoke insert, update on public.follows from authenticated;
grant select, delete on public.follows to authenticated;

-- ---------------------------------------------------------------------------
-- Publication RPCs and public visibility
-- ---------------------------------------------------------------------------

-- RLS and every public projection ultimately call persona_visible(), so this
-- fail-closed predicate prevents a legacy or bypassed write from exposing URL
-- userinfo (including embedded credentials) through either the UI or raw API.
create or replace function public.persona_public_urls_safe(p_persona_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.personas persona where persona.id=p_persona_id
      and public.is_safe_credential_free_https_url(persona.avatar_url,true)
      and public.is_safe_credential_free_https_url(persona.banner_url,true)
      and public.is_safe_credential_free_https_url(persona.bg_url,true)
      and public.is_safe_credential_free_https_url(persona.feed_img_url,true)
      and public.is_safe_credential_free_https_url(persona.music_url,true)
      and public.is_safe_credential_free_https_url(persona.live_url,true)
      and not exists (select 1 from public.persona_links link
        where link.persona_id=persona.id
          and not public.is_safe_credential_free_https_url(link.url,true))
      and not exists (select 1 from public.posts post
        where post.persona_id=persona.id
          and not public.is_safe_credential_free_https_url(post.media_url,true))
      and not exists (select 1 from public.album_items item
        join public.albums album on album.id=item.album_id
        where album.persona_id=persona.id and (
          not public.is_safe_credential_free_https_url(item.thumb_url,true)
          or not public.is_safe_credential_free_https_url(item.link_url,true)
        ))
      and not exists (select 1 from public.persona_page_layouts page
        cross join lateral jsonb_array_elements(case
          when jsonb_typeof(coalesce(page.layout->'widgets','[]'::jsonb))='array'
          then coalesce(page.layout->'widgets','[]'::jsonb) else '[]'::jsonb end) widget(value)
        where page.persona_id=persona.id and widget.value->>'kind'='link'
          and not public.is_safe_credential_free_https_url(widget.value->>'url',false))
      and not exists (select 1 from public.persona_affiliate_offers offer
        join public.affiliate_products product
          on product.id=offer.product_id and product.owner=offer.owner
        where offer.persona_id=persona.id and offer.owner=persona.owner
          and offer.status='active' and product.status='active' and (
            not public.is_safe_credential_free_https_url(product.affiliate_url,false)
            or not public.is_safe_credential_free_https_url(product.product_url,true)
            or not public.is_safe_credential_free_https_url(product.image_url,true)
          ))
  )
$$;
revoke all on function public.persona_public_urls_safe(uuid)
  from public,anon,authenticated;

create or replace function public.validate_persona_layout_public_urls()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from jsonb_array_elements(case
      when jsonb_typeof(coalesce(new.layout->'widgets','[]'::jsonb))='array'
      then coalesce(new.layout->'widgets','[]'::jsonb) else '[]'::jsonb end) widget(value)
    where widget.value->>'kind'='link'
      and not public.is_safe_credential_free_https_url(widget.value->>'url',false)) then
    raise exception 'Page link widgets require a credential-free HTTPS URL';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_persona_layout_public_urls()
  from public,anon,authenticated;
drop trigger if exists validate_persona_layout_public_urls on public.persona_page_layouts;
create trigger validate_persona_layout_public_urls
  before insert or update on public.persona_page_layouts for each row
  execute function public.validate_persona_layout_public_urls();

create or replace function public.persona_publication_review_manifest(p_persona_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_persona public.personas%rowtype;
  v_layout jsonb;
  v_assets jsonb;
  v_links jsonb;
  v_posts jsonb;
  v_albums jsonb;
  v_family jsonb;
  v_revenue jsonb;
  v_top8 jsonb;
  v_linked jsonb;
  v_dependencies jsonb;
  v_result jsonb;
  v_link_count integer;
  v_post_count integer;
  v_album_count integer;
  v_item_count integer;
  v_family_count integer;
  v_offer_count integer;
  v_family_rendered integer;
  v_top8_count integer;
  v_top8_rendered integer;
  v_linked_count integer;
  v_linked_rendered integer;
  v_payload_bytes bigint;
  v_oversized boolean;
  v_within_counts boolean;
  v_invalid_public_url boolean;
  v_invalid_modules boolean;
  v_complete boolean;
  v_link_limit constant integer := 100;
  v_post_limit constant integer := 500;
  v_album_limit constant integer := 100;
  v_item_limit constant integer := 1000;
  v_family_limit constant integer := 200;
  v_offer_limit constant integer := 100;
  v_linked_limit constant integer := 100;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_persona
  from public.personas persona
  where persona.id=p_persona_id and persona.owner=auth.uid();
  if not found then raise exception 'Owned persona not found'; end if;

  select count(*) into v_link_count from (
    select 1 from public.persona_links where persona_id=p_persona_id limit (v_link_limit+1)
  ) probe;
  select count(*) into v_post_count from (
    select 1 from public.posts where persona_id=p_persona_id limit (v_post_limit+1)
  ) probe;
  select count(*) into v_album_count from (
    select 1 from public.albums where persona_id=p_persona_id limit (v_album_limit+1)
  ) probe;
  select count(*) into v_item_count
  from (select 1 from public.album_items item join public.albums album on album.id=item.album_id
    where album.persona_id=p_persona_id limit (v_item_limit+1)) probe;
  select count(*) into v_family_count
  from (select 1 from public.persona_family_relationships relationship
    where relationship.visibility='public'
      and p_persona_id in (relationship.from_persona_id,relationship.to_persona_id)
    limit (v_family_limit+1)) probe;
  select count(*) into v_offer_count from (
    select 1 from public.persona_affiliate_offers offer
    join public.affiliate_products product
      on product.id=offer.product_id and product.owner=offer.owner
    where offer.persona_id=p_persona_id and offer.owner=v_persona.owner
      and offer.status='active' and product.status='active'
    limit (v_offer_limit+1)
  ) probe;
  v_top8_count := case when jsonb_typeof(coalesce(v_persona.top8,'[]'::jsonb))='array'
    then jsonb_array_length(coalesce(v_persona.top8,'[]'::jsonb)) else 9 end;
  v_linked_count := case when jsonb_typeof(coalesce(v_persona.linked,'[]'::jsonb))='array'
    then jsonb_array_length(coalesce(v_persona.linked,'[]'::jsonb)) else v_linked_limit+1 end;
  v_invalid_public_url:=not public.persona_public_urls_safe(p_persona_id);
  v_invalid_modules:=not public.persona_modules_are_canonical(v_persona.modules);
  v_within_counts := v_link_count<=v_link_limit and v_post_count<=v_post_limit
    and v_album_count<=v_album_limit and v_item_count<=v_item_limit
    and v_family_count<=v_family_limit and v_top8_count<=8
    and v_linked_count<=v_linked_limit and v_offer_count<=v_offer_limit;

  v_oversized :=
    char_length(coalesce(v_persona.name,''))>256
    or char_length(coalesce(v_persona.tagline,''))>1000
    or char_length(coalesce(v_persona.bio,''))>30000
    or char_length(coalesce(v_persona.topics,''))>4000
    or char_length(coalesce(v_persona.hashtags,''))>4000
    or char_length(coalesce(v_persona.title,''))>1000
    or char_length(coalesce(v_persona.focus,''))>4000
    or char_length(coalesce(v_persona.pet_project,''))>1000
    or char_length(coalesce(v_persona.theme,''))>100
    or octet_length(coalesce(v_persona.modules,'{}'::jsonb)::text)>30000
    or octet_length(coalesce(v_persona.top8,'[]'::jsonb)::text)>10000
    or octet_length(coalesce(v_persona.linked,'[]'::jsonb)::text)>10000
    or greatest(
      char_length(coalesce(v_persona.avatar_url,'')),char_length(coalesce(v_persona.banner_url,'')),
      char_length(coalesce(v_persona.bg_url,'')),char_length(coalesce(v_persona.feed_img_url,'')),
      char_length(coalesce(v_persona.music_url,'')),char_length(coalesce(v_persona.live_url,''))
    )>2048
    or exists(select 1 from public.persona_revenue_settings setting
      where setting.persona_id=p_persona_id and (
        char_length(coalesce(setting.default_disclosure,''))>2000
        or char_length(coalesce(setting.cta_label,''))>200
        or char_length(coalesce(setting.review_cta_label,''))>200
      ))
    ;

  if not v_oversized and v_within_counts then
    v_oversized:=
      exists(select 1 from public.persona_links link where link.persona_id=p_persona_id
        and (char_length(coalesce(link.platform,''))>100 or char_length(coalesce(link.handle,''))>500 or char_length(coalesce(link.url,''))>2048))
      or exists(select 1 from public.posts post where post.persona_id=p_persona_id
        and (char_length(coalesce(post.title,''))>1000 or char_length(coalesce(post.body,''))>30000
          or char_length(coalesce(post.tags,''))>4000 or char_length(coalesce(post.media_url,''))>2048))
      or exists(select 1 from public.albums album where album.persona_id=p_persona_id
        and char_length(coalesce(album.title,''))>1000)
      or exists(select 1 from public.album_items item join public.albums album on album.id=item.album_id
        where album.persona_id=p_persona_id and (char_length(coalesce(item.caption,''))>4000
          or char_length(coalesce(item.thumb_url,''))>2048 or char_length(coalesce(item.link_url,''))>2048))
      or exists(select 1 from public.persona_affiliate_offers offer
        join public.affiliate_products product
          on product.id=offer.product_id and product.owner=offer.owner
        where offer.persona_id=p_persona_id and offer.owner=v_persona.owner
          and offer.status='active' and product.status='active' and (
            char_length(coalesce(offer.cta_label,''))>200
            or char_length(coalesce(product.title,''))>500
            or char_length(coalesce(product.merchant,''))>500
            or char_length(coalesce(product.category,''))>200
            or char_length(coalesce(product.disclosure,''))>2000
            or greatest(char_length(coalesce(product.product_url,'')),
              char_length(coalesce(product.affiliate_url,'')),
              char_length(coalesce(product.image_url,'')))>2048
          ))
      or exists(
        select 1 from public.personas relative
        where relative.id in (
          select case when relationship.from_persona_id=p_persona_id
            then relationship.to_persona_id else relationship.from_persona_id end
          from public.persona_family_relationships relationship
          where relationship.visibility='public'
            and p_persona_id in (relationship.from_persona_id,relationship.to_persona_id)
          union
          select case when reference.raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then reference.raw_id::uuid else null end
          from jsonb_array_elements_text(coalesce(v_persona.top8,'[]'::jsonb)) reference(raw_id)
          union
          select case when reference.raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then reference.raw_id::uuid else null end
          from jsonb_array_elements_text(coalesce(v_persona.linked,'[]'::jsonb)) reference(raw_id)
        ) and (char_length(coalesce(relative.name,''))>256
          or char_length(coalesce(relative.tagline,''))>1000
          or char_length(coalesce(relative.avatar_url,''))>2048)
      );
  end if;

  select coalesce(layout.layout,'{"version":1,"order":["live","music","about","fan_chat","links","top8","linked","family","revenue","albums","feed"],"cards":{},"widgets":[]}'::jsonb)
  into v_layout from (select 1) seed
  left join public.persona_page_layouts layout on layout.persona_id=p_persona_id and layout.owner=auth.uid();

  v_payload_bytes:=0;
  if not v_oversized and v_within_counts then
  select coalesce(sum(payload.bytes),0) into v_payload_bytes from (
    select (octet_length(concat_ws('|',v_persona.name,v_persona.tagline,v_persona.bio,v_persona.topics,
      v_persona.hashtags,v_persona.title,v_persona.focus,v_persona.pet_project,v_persona.ai_disclosure,
      v_persona.avatar_url,v_persona.banner_url,v_persona.bg_url,v_persona.feed_img_url,
      v_persona.music_url,v_persona.live_url))+octet_length(coalesce(v_persona.modules,'{}'::jsonb)::text)
      +octet_length(coalesce(v_persona.top8,'[]'::jsonb)::text)+octet_length(coalesce(v_persona.linked,'[]'::jsonb)::text)
      +octet_length(coalesce(v_layout,'{}'::jsonb)::text))::bigint as bytes
    union all select coalesce(sum(octet_length(concat_ws('|',platform,handle,url))),0)::bigint from public.persona_links where persona_id=p_persona_id
    union all select coalesce(sum(octet_length(concat_ws('|',kind,title,body,tags,media_url))),0)::bigint from public.posts where persona_id=p_persona_id
    union all select coalesce(sum(octet_length(concat_ws('|',title,kind))),0)::bigint from public.albums where persona_id=p_persona_id
    union all select coalesce(sum(octet_length(concat_ws('|',item.caption,item.thumb_url,item.link_url))),0)::bigint
      from public.album_items item join public.albums album on album.id=item.album_id where album.persona_id=p_persona_id
    union all select coalesce(sum(octet_length(concat_ws('|',setting.default_disclosure,
      setting.cta_label,setting.review_cta_label))),0)::bigint
      from public.persona_revenue_settings setting where setting.persona_id=p_persona_id
    union all select coalesce(sum(octet_length(concat_ws('|',offer.cta_label,offer.placement,
      offer.priority::text,product.title,product.merchant,product.product_url,
      product.affiliate_url,product.category,product.disclosure,product.image_url))),0)::bigint
      from public.persona_affiliate_offers offer
      join public.affiliate_products product on product.id=offer.product_id and product.owner=offer.owner
      where offer.persona_id=p_persona_id and offer.owner=v_persona.owner
        and offer.status='active' and product.status='active'
  ) payload;
  end if;
  if v_payload_bytes>400000 then v_oversized:=true; end if;

  if not v_oversized and v_within_counts then
  select coalesce(jsonb_agg(jsonb_build_object(
    'label',asset.label,'kind',asset.kind,'url',asset.url
  ) order by asset.sort_order),'[]'::jsonb) into v_assets
  from (values
    ('Profile image','image',left(coalesce(v_persona.avatar_url,''),2048),1),
    ('Banner image','image',left(coalesce(v_persona.banner_url,''),2048),2),
    ('Page background','image',left(coalesce(v_persona.bg_url,''),2048),3),
    ('Feed header','image',left(coalesce(v_persona.feed_img_url,''),2048),4),
    ('Profile song','audio',left(coalesce(v_persona.music_url,''),2048),5),
    ('Live embed','embed',left(coalesce(v_persona.live_url,''),2048),6)
  ) asset(label,kind,url,sort_order)
  where trim(asset.url)<>'';

  select coalesce(jsonb_agg(jsonb_build_object(
    'platform',left(coalesce(link.platform,''),100),
    'handle',left(coalesce(link.handle,''),500),
    'url',left(coalesce(link.url,''),2048)
  ) order by link.sort,link.id),'[]'::jsonb) into v_links
  from (select * from public.persona_links where persona_id=p_persona_id
    order by sort,id limit v_link_limit) link;

  select coalesce(jsonb_agg(jsonb_build_object(
    'kind',post.kind,'title',left(coalesce(post.title,''),1000),
    'body',left(coalesce(post.body,''),30000),'tags',left(coalesce(post.tags,''),4000),
    'media_url',left(coalesce(post.media_url,''),2048),'created_at',post.created_at
  ) order by post.created_at,post.id),'[]'::jsonb) into v_posts
  from (select * from public.posts where persona_id=p_persona_id
    order by created_at,id limit v_post_limit) post;

  with selected_albums as (
    select * from public.albums where persona_id=p_persona_id
    order by sort,created_at,id limit v_album_limit
  ), selected_items as (
    select item.* from public.album_items item
    join selected_albums album on album.id=item.album_id
    order by album.sort,album.created_at,album.id,item.sort,item.created_at,item.id
    limit v_item_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'title',left(coalesce(album.title,''),1000),'kind',album.kind,
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'caption',left(coalesce(item.caption,''),4000),
      'thumb_url',left(coalesce(item.thumb_url,''),2048),
      'link_url',left(coalesce(item.link_url,''),2048)
    ) order by item.sort,item.created_at,item.id) from selected_items item
      where item.album_id=album.id),'[]'::jsonb)
  ) order by album.sort,album.created_at,album.id),'[]'::jsonb) into v_albums
  from selected_albums album;

  select jsonb_build_object(
    'settings',jsonb_build_object(
      'affiliate_enabled',setting.affiliate_enabled,
      'review_requests_enabled',setting.review_requests_enabled,
      'secure_request_intake_configured',exists(
        select 1 from public.product_review_settings request_setting
        where request_setting.persona_id=p_persona_id
          and request_setting.owner=v_persona.owner
          and request_setting.enabled and request_setting.destination_ledger_id is not null
      ),
      'default_disclosure',left(coalesce(setting.default_disclosure,''),2000),
      'cta_label',left(coalesce(setting.cta_label,''),200),
      'review_cta_label',left(coalesce(setting.review_cta_label,''),200)
    ),
    'offers',coalesce((select jsonb_agg(jsonb_build_object(
      'offer_id',reviewed.offer_id,'product_id',reviewed.product_id,
      'title',left(reviewed.title,500),'merchant',left(coalesce(reviewed.merchant,''),500),
      'product_url',left(coalesce(reviewed.product_url,''),2048),
      'affiliate_destination',left(reviewed.affiliate_url,2048),
      'image_url',left(coalesce(reviewed.image_url,''),2048),
      'category',left(coalesce(reviewed.category,''),200),
      'disclosure',left(coalesce(nullif(reviewed.disclosure,''),setting.default_disclosure),2000),
      'cta_label',left(coalesce(nullif(reviewed.cta_label,''),setting.cta_label),200),
      'placement',reviewed.placement,'priority',reviewed.priority
    ) order by reviewed.priority desc,reviewed.offer_id)
      from (select offer.id as offer_id,product.id as product_id,product.title,
          product.merchant,product.product_url,product.affiliate_url,product.image_url,
          product.category,product.disclosure,offer.cta_label,offer.placement,offer.priority
        from public.persona_affiliate_offers offer
        join public.affiliate_products product
          on product.id=offer.product_id and product.owner=offer.owner
        where offer.persona_id=p_persona_id and offer.owner=v_persona.owner
          and offer.status='active' and product.status='active'
        order by offer.priority desc,offer.id limit v_offer_limit) reviewed),'[]'::jsonb)
  ) into v_revenue
  from public.persona_revenue_settings setting
  where setting.persona_id=p_persona_id and setting.owner=v_persona.owner;
  v_revenue:=coalesce(v_revenue,jsonb_build_object(
    'settings',jsonb_build_object('affiliate_enabled',false,'review_requests_enabled',false,
      'secure_request_intake_configured',false,
      'default_disclosure','','cta_label','','review_cta_label',''),
    'offers','[]'::jsonb
  ));

  with edges as (
    select relative.handle,relative.name,relative.avatar_url,
      case when relationship.relationship_type='parent_of' then 'child' else 'partner' end as relationship_label
    from public.persona_family_relationships relationship
    join public.personas relative on relative.id=relationship.to_persona_id
    where relationship.from_persona_id=p_persona_id and relationship.visibility='public'
      and relative.visibility='public'
      and (relative.owner=auth.uid() or (
        relative.publication_state='published' and public.persona_visible(relative.id)
      ))
    union all
    select relative.handle,relative.name,relative.avatar_url,
      case when relationship.relationship_type='parent_of' then 'parent' else 'partner' end as relationship_label
    from public.persona_family_relationships relationship
    join public.personas relative on relative.id=relationship.from_persona_id
    where relationship.to_persona_id=p_persona_id and relationship.visibility='public'
      and relative.visibility='public'
      and (relative.owner=auth.uid() or (
        relative.publication_state='published' and public.persona_visible(relative.id)
      ))
  ), selected_edges as (
    select * from edges order by relationship_label,handle limit v_family_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'relationship',relationship_label,'handle',handle,'name',name,
    'avatar_url',left(coalesce(avatar_url,''),2048)
  ) order by relationship_label,handle),'[]'::jsonb),count(*)
  into v_family,v_family_rendered from selected_edges;

  select coalesce(jsonb_agg(jsonb_build_object(
      'handle',relative.handle,'name',left(relative.name,256),
      'avatar_url',left(coalesce(relative.avatar_url,''),2048)
    )
    order by reference.ord),'[]'::jsonb) into v_top8
  from jsonb_array_elements_text(case when jsonb_typeof(coalesce(v_persona.top8,'[]'::jsonb))='array'
    then coalesce(v_persona.top8,'[]'::jsonb) else '[]'::jsonb end) with ordinality reference(raw_id,ord)
  join public.personas relative on relative.id=case when reference.raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then reference.raw_id::uuid else null end
  where reference.ord<=8 and relative.visibility in ('public','unlisted')
    and (relative.owner=auth.uid() or (
      relative.publication_state='published' and public.persona_visible(relative.id)
    ));
  v_top8_rendered:=jsonb_array_length(v_top8);

  select coalesce(jsonb_agg(jsonb_build_object(
      'handle',relative.handle,'name',left(relative.name,256),
      'avatar_url',left(coalesce(relative.avatar_url,''),2048),
      'tagline',left(coalesce(relative.tagline,''),1000)
    )
    order by reference.ord),'[]'::jsonb) into v_linked
  from jsonb_array_elements_text(case when jsonb_typeof(coalesce(v_persona.linked,'[]'::jsonb))='array'
    then coalesce(v_persona.linked,'[]'::jsonb) else '[]'::jsonb end) with ordinality reference(raw_id,ord)
  join public.personas relative on relative.id=case when reference.raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then reference.raw_id::uuid else null end
  where reference.ord<=v_linked_limit and relative.visibility in ('public','unlisted')
    and (relative.owner=auth.uid() or (
      relative.publication_state='published' and public.persona_visible(relative.id)
    ));
  v_linked_rendered:=jsonb_array_length(v_linked);

  with dependency_candidates as (
    select distinct relative.id as dependency_persona_id,'top8'::text as dependency_kind,
      relative.publication_revision as dependency_revision
    from jsonb_array_elements_text(case
      when jsonb_typeof(coalesce(v_persona.top8,'[]'::jsonb))='array'
      then coalesce(v_persona.top8,'[]'::jsonb) else '[]'::jsonb end)
      with ordinality reference(raw_id,ord)
    join public.personas relative on relative.id=case
      when reference.raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then reference.raw_id::uuid else null end
    where reference.ord<=8 and relative.visibility in ('public','unlisted')
      and (relative.owner=auth.uid() or (
        relative.publication_state='published' and public.persona_visible(relative.id)
      ))
    union
    select distinct relative.id,'linked'::text,relative.publication_revision
    from jsonb_array_elements_text(case
      when jsonb_typeof(coalesce(v_persona.linked,'[]'::jsonb))='array'
      then coalesce(v_persona.linked,'[]'::jsonb) else '[]'::jsonb end)
      with ordinality reference(raw_id,ord)
    join public.personas relative on relative.id=case
      when reference.raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then reference.raw_id::uuid else null end
    where reference.ord<=v_linked_limit and relative.visibility in ('public','unlisted')
      and (relative.owner=auth.uid() or (
        relative.publication_state='published' and public.persona_visible(relative.id)
      ))
    union
    select distinct relative.id,'family'::text,relative.publication_revision
    from (select candidate.* from public.persona_family_relationships candidate
      where candidate.visibility='public'
        and p_persona_id in (candidate.from_persona_id,candidate.to_persona_id)
      order by candidate.id limit v_family_limit) relationship
    join public.personas relative on relative.id=case
      when relationship.from_persona_id=p_persona_id then relationship.to_persona_id
      else relationship.from_persona_id end
    where relative.visibility='public'
      and (relative.owner=auth.uid() or (
        relative.publication_state='published' and public.persona_visible(relative.id)
      ))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'persona_id',candidate.dependency_persona_id,
    'kind',candidate.dependency_kind,
    'dependency_revision',candidate.dependency_revision,
    'projection_sha256',public.persona_dependency_projection_hash(
      candidate.dependency_persona_id,candidate.dependency_kind
    )
  ) order by candidate.dependency_kind,candidate.dependency_persona_id),'[]'::jsonb)
  into v_dependencies
  from dependency_candidates candidate;
  else
    v_assets:='[]'::jsonb;v_links:='[]'::jsonb;v_posts:='[]'::jsonb;v_albums:='[]'::jsonb;
    v_family:='[]'::jsonb;v_top8:='[]'::jsonb;v_linked:='[]'::jsonb;
    v_revenue:=jsonb_build_object('settings','{}'::jsonb,'offers','[]'::jsonb);
    v_dependencies:='[]'::jsonb;
    v_family_rendered:=0;v_top8_rendered:=0;v_linked_rendered:=0;
  end if;

  v_complete := v_link_count<=v_link_limit and v_post_count<=v_post_limit
    and v_album_count<=v_album_limit and v_item_count<=v_item_limit
    and v_family_count<=v_family_limit and v_top8_count<=8
    and v_linked_count<=v_linked_limit and v_offer_count<=v_offer_limit
    and v_family_count=v_family_rendered and v_top8_count=v_top8_rendered
    and v_linked_count=v_linked_rendered
    and not v_oversized and not v_invalid_public_url and not v_invalid_modules;

  v_result := jsonb_build_object(
    'schema_version',1,'revision',v_persona.publication_revision,
    'target_publication_state','published','complete',v_complete,
    'limits',jsonb_build_object('links',v_link_limit,'posts',v_post_limit,'albums',v_album_limit,
      'album_items',v_item_limit,'family_edges',v_family_limit,'linked_personas',v_linked_limit,
      'active_affiliate_offers',v_offer_limit),
    'counts',jsonb_build_object('links',v_link_count,'posts',v_post_count,'albums',v_album_count,
      'album_items',v_item_count,'public_family_edges',v_family_count,
      'active_affiliate_offers',v_offer_count,
      'renderable_family_edges',v_family_rendered,'top8',v_top8_count,
      'renderable_top8',v_top8_rendered,'linked_personas',v_linked_count,
      'renderable_linked_personas',v_linked_rendered),
    'truncation_reasons',to_jsonb(array_remove(array[
      case when v_link_count>v_link_limit then 'Too many public links for one review packet' end,
      case when v_post_count>v_post_limit then 'Too many posts for one review packet' end,
      case when v_album_count>v_album_limit then 'Too many albums for one review packet' end,
      case when v_item_count>v_item_limit then 'Too many album items for one review packet' end,
      case when v_family_count>v_family_limit then 'Too many public family edges for one review packet' end,
      case when v_top8_count>8 then 'Top 8 contains more than eight references' end,
      case when v_linked_count>v_linked_limit then 'Too many linked personas for one review packet' end,
      case when v_offer_count>v_offer_limit then 'Too many active affiliate offers for one review packet' end,
      case when v_family_count<>v_family_rendered then 'A public family reference is blocked, unpublished, private, or invalid' end,
      case when v_top8_count<>v_top8_rendered then 'A Top 8 reference is blocked, unpublished, private, or invalid' end,
      case when v_linked_count<>v_linked_rendered then 'A linked persona reference is blocked, unpublished, private, or invalid' end,
      case when v_invalid_public_url then 'A public URL is not a credential-free HTTPS URL' end,
      case when v_invalid_modules then 'Page modules contain an unknown key or a non-boolean value' end,
      case when v_oversized then 'Public page content exceeds a field or 400000-byte review bound' end
    ]::text[],null)),
    'profile',jsonb_build_object(
      'handle',v_persona.handle,'name',left(v_persona.name,256),
      'tagline',left(coalesce(v_persona.tagline,''),1000),
      'bio',left(coalesce(v_persona.bio,''),30000),'nsfw',v_persona.nsfw,
      'visibility',v_persona.visibility,'theme',left(coalesce(v_persona.theme,''),100),
      'topics',left(coalesce(v_persona.topics,''),4000),
      'hashtags',left(coalesce(v_persona.hashtags,''),4000),
      'modules',public.canonical_persona_modules(v_persona.modules),
      'title',left(coalesce(v_persona.title,''),1000),
      'focus',left(coalesce(v_persona.focus,''),4000),
      'pet_project',left(coalesce(v_persona.pet_project,''),1000),
      'ai_disclosure',v_persona.ai_disclosure,
      'fan_agent_configuration',jsonb_build_object(
        'purpose_configured',trim(coalesce(v_persona.purpose,''))<>'',
        'voice_configured',trim(coalesce(v_persona.voice,''))<>'',
        'audience_configured',trim(coalesce(v_persona.audience,''))<>'',
        'hard_rules_configured',trim(coalesce(v_persona.dont,''))<>'',
        'backend_configured',exists(
          select 1 from public.ai_backends backend
          join public.ai_backend_credentials credential
            on credential.backend_id=backend.id and credential.owner=backend.owner
          join vault.secrets secret on secret.id=credential.vault_secret_id
          where backend.id=v_persona.ai_backend and backend.owner=v_persona.owner
        ),
        'fan_chat_configured',exists(
          select 1 from public.agent_bindings binding
          join public.ai_backends backend
            on backend.id=v_persona.ai_backend and backend.owner=v_persona.owner
          join public.ai_backend_credentials credential
            on credential.backend_id=backend.id and credential.owner=backend.owner
          join vault.secrets secret on secret.id=credential.vault_secret_id
          where binding.persona_id=v_persona.id and binding.owner=v_persona.owner
            and binding.status='active'
            and binding.claim_state in ('self_attested','verified')
            and binding.fan_chat_enabled
        ),
        'configuration_sha256',encode(extensions.digest(convert_to(concat_ws(E'\u001f',
          v_persona.purpose,v_persona.voice,v_persona.audience,v_persona.dont,
          coalesce(v_persona.ai_backend::text,''),
          coalesce((select concat_ws(E'\u001f',backend.provider,backend.base_url,
            backend.model,coalesce(backend.extra,'{}'::jsonb)::text,
            exists(select 1 from public.ai_backend_credentials credential
              join vault.secrets secret on secret.id=credential.vault_secret_id
              where credential.backend_id=backend.id and credential.owner=backend.owner)::text)
            from public.ai_backends backend
            where backend.id=v_persona.ai_backend and backend.owner=v_persona.owner),''),
          coalesce((select concat_ws(E'\u001f',binding.status,binding.claim_state,
            binding.fan_chat_enabled::text,binding.fan_daily_message_limit::text)
            from public.agent_bindings binding
            where binding.persona_id=v_persona.id and binding.owner=v_persona.owner),'')
          ),'UTF8'),'sha256'),'hex')
      )
    ),
    'assets',v_assets,'layout',v_layout,'links',v_links,'posts',v_posts,
    'albums',v_albums,'family',v_family,'top8',v_top8,'linked_personas',v_linked,
    'revenue',v_revenue,
    'dependencies',v_dependencies,
    'withheld',jsonb_build_array('owner identity','private purpose and voice','hard rules','private notes',
      'account and provider data','credentials and tokens','review notes','extension source')
  );
  if octet_length(v_result::text)>500000 then
    v_result := jsonb_set(v_result,'{complete}','false'::jsonb,true);
    v_result := v_result || jsonb_build_object('assets','[]'::jsonb,'links','[]'::jsonb,
      'posts','[]'::jsonb,'albums','[]'::jsonb,'family','[]'::jsonb,
      'top8','[]'::jsonb,'linked_personas','[]'::jsonb,
      'revenue',jsonb_build_object('settings','{}'::jsonb,'offers','[]'::jsonb));
    v_result := jsonb_set(v_result,'{truncation_reasons}',
      coalesce(v_result->'truncation_reasons','[]'::jsonb)
        || jsonb_build_array('The complete review manifest exceeds 500000 bytes'),true);
  end if;
  return v_result;
end;
$$;

create or replace function public.persona_publication_readiness(p_persona_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_persona public.personas%rowtype;
  v_intention text := '';
  v_checks jsonb;
  v_missing integer;
  v_manifest jsonb;
  v_manifest_hash text;
begin
  select * into v_persona
  from public.personas persona
  where persona.id = p_persona_id and persona.owner = auth.uid();
  if not found then raise exception 'Owned persona not found'; end if;

  select review.intention into v_intention
  from public.persona_publication_reviews review
  where review.persona_id = p_persona_id and review.owner = auth.uid();

  v_manifest := public.persona_publication_review_manifest(p_persona_id);
  v_manifest_hash := encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex');

  v_checks := jsonb_build_array(
    jsonb_build_object('key','name','label','Display name','required',true,'ok',trim(coalesce(v_persona.name,'')) <> ''),
    jsonb_build_object('key','handle','label','Public handle','required',true,'ok',coalesce(v_persona.handle,'') ~ '^[a-z0-9._]{3,30}$'),
    jsonb_build_object('key','tagline','label','Tagline','required',true,'ok',trim(coalesce(v_persona.tagline,'')) <> ''),
    jsonb_build_object('key','bio','label','Public bio','required',true,'ok',trim(coalesce(v_persona.bio,'')) <> ''),
    jsonb_build_object('key','avatar','label','Profile image','required',true,'ok',
      coalesce(v_persona.avatar_url,'')<>''
        and public.is_safe_credential_free_https_url(v_persona.avatar_url,false)),
    jsonb_build_object('key','ai_disclosure','label','Transparent AI disclosure','required',true,'ok',trim(coalesce(v_persona.ai_disclosure,'')) <> ''),
    jsonb_build_object('key','intention','label','Page intention','required',true,'ok',trim(coalesce(v_intention,'')) <> ''),
    jsonb_build_object('key','review_manifest','label','Complete bounded page review manifest','required',true,'ok',coalesce((v_manifest->>'complete')::boolean,false)),
    jsonb_build_object('key','purpose','label','Private persona purpose','required',false,'ok',trim(coalesce(v_persona.purpose,'')) <> ''),
    jsonb_build_object('key','voice','label','Private voice and behavior','required',false,'ok',trim(coalesce(v_persona.voice,'')) <> ''),
    jsonb_build_object('key','hard_rules','label','Private hard rules','required',false,'ok',trim(coalesce(v_persona.dont,'')) <> '')
  );

  select count(*) into v_missing
  from jsonb_array_elements(v_checks) item
  where coalesce((item->>'required')::boolean,false)
    and not coalesce((item->>'ok')::boolean,false);

  return jsonb_build_object(
    'persona_id', v_persona.id,
    'publication_state', v_persona.publication_state,
    'publication_revision', v_persona.publication_revision,
    'published_revision', v_persona.published_revision,
    'required_missing', v_missing,
    'review_manifest',v_manifest,
    'manifest_sha256',v_manifest_hash,
    'checks', v_checks,
    'warnings', to_jsonb(array_remove(array[
      case when v_persona.visibility = 'private'
        then 'This page is private; only accepted friends can view it after publication.' end,
      case when trim(coalesce(v_persona.banner_url,'')) = ''
        then 'No banner is set; publication is allowed but the page may look incomplete.' end,
      case when not coalesce((v_manifest->>'complete')::boolean,false)
        then 'The page review manifest is incomplete; resolve its truncation reasons before publication.' end,
      case when coalesce((v_manifest->'counts'->>'public_family_edges')::integer,0)
          > coalesce((v_manifest->'counts'->>'renderable_family_edges')::integer,0)
        then 'At least one public family edge points to a persona that is not currently public and published.' end
    ]::text[], null))
  );
end;
$$;

create or replace function public.save_persona_review_draft(
  p_persona_id uuid,
  p_ai_disclosure text,
  p_intention text default '',
  p_owner_review_notes text default ''
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_revision integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  if char_length(trim(coalesce(p_ai_disclosure,''))) not between 1 and 1000 then
    raise exception 'AI disclosure must be between 1 and 1000 characters';
  end if;
  if char_length(coalesce(p_intention,'')) > 12000
     or char_length(coalesce(p_owner_review_notes,'')) > 12000 then
    raise exception 'Review draft text is too long';
  end if;

  update public.personas persona
  set ai_disclosure=trim(p_ai_disclosure)
  where persona.id=p_persona_id and persona.owner=v_owner
  returning persona.publication_revision into v_revision;
  if not found then raise exception 'Owned persona not found'; end if;

  insert into public.persona_publication_reviews(
    persona_id,owner,intention,owner_review_notes,review_state,
    reviewed_revision,readiness_snapshot,required_missing,
    submitted_at,reviewed_at,published_at,updated_at
  ) values (
    p_persona_id,v_owner,left(coalesce(p_intention,''),12000),
    left(coalesce(p_owner_review_notes,''),12000),'draft',
    v_revision,'{}'::jsonb,0,null,null,null,now()
  ) on conflict(persona_id) do update set
    intention=excluded.intention,
    owner_review_notes=excluded.owner_review_notes,
    review_state='draft',
    reviewed_revision=excluded.reviewed_revision,
    readiness_snapshot='{}'::jsonb,
    required_missing=0,
    submitted_at=null,
    reviewed_at=null,
    published_at=null,
    updated_at=now();
  return true;
end;
$$;

create or replace function public.submit_persona_for_review(
  p_persona_id uuid,
  p_intention text,
  p_ai_disclosure text,
  p_owner_review_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_snapshot jsonb;
  v_missing integer;
  v_revision integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_persona_publication_mutation(p_persona_id);
  if char_length(trim(coalesce(p_intention,''))) < 10 then
    raise exception 'Describe the page intention in at least 10 characters';
  end if;
  if char_length(trim(coalesce(p_ai_disclosure,''))) < 10
     or char_length(p_ai_disclosure) > 1000 then
    raise exception 'Add a clear AI disclosure between 10 and 1000 characters';
  end if;
  if char_length(coalesce(p_owner_review_notes,'')) > 12000 then
    raise exception 'Review notes are too long';
  end if;

  perform set_config('app.persona_publication_transition','review',true);
  update public.personas persona
  set ai_disclosure = trim(p_ai_disclosure), publication_state = 'in_review'
  where persona.id = p_persona_id and persona.owner = v_owner
  returning persona.publication_revision into v_revision;
  if not found then raise exception 'Owned persona not found'; end if;

  insert into public.persona_publication_reviews (
    persona_id, owner, intention, owner_review_notes, review_state,
    reviewed_revision, submitted_at, updated_at
  ) values (
    p_persona_id, v_owner, trim(p_intention), trim(coalesce(p_owner_review_notes,'')),
    'in_review', v_revision, now(), now()
  ) on conflict (persona_id) do update set
    intention = excluded.intention,
    owner_review_notes = excluded.owner_review_notes,
    review_state = 'in_review',
    reviewed_revision = excluded.reviewed_revision,
    submitted_at = now(),
    updated_at = now();

  v_snapshot := public.persona_publication_readiness(p_persona_id);
  v_missing := coalesce((v_snapshot->>'required_missing')::integer, 0);

  update public.persona_publication_reviews
  set readiness_snapshot = v_snapshot,
      required_missing = v_missing,
      review_state = case when v_missing = 0 then 'ready' else 'changes_requested' end,
      reviewed_at = now(),
      updated_at = now()
  where persona_id = p_persona_id and owner = v_owner;

  if v_missing > 0 then
    update public.personas set publication_state = 'draft'
    where id = p_persona_id and owner = v_owner;
  end if;
  return v_snapshot;
end;
$$;

create or replace function public.publish_persona_page(p_persona_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_snapshot jsonb;
  v_review_manifest jsonb;
  v_manifest_hash text;
  v_dependency_count integer;
  v_revision integer;
  v_visibility text;
  v_dependency_gate_current boolean;
  v_published_at timestamptz:=now();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_persona_publication_mutation(p_persona_id);
  select publication_revision,visibility into v_revision,v_visibility from public.personas
  where id = p_persona_id and owner = v_owner for update;
  if not found then raise exception 'Owned persona not found'; end if;
  v_snapshot := public.persona_publication_readiness(p_persona_id);
  if coalesce((v_snapshot->>'required_missing')::integer, 1) <> 0 then
    raise exception 'Required publication checks are incomplete';
  end if;
  select review.readiness_snapshot->'review_manifest',
         review.readiness_snapshot->>'manifest_sha256'
  into v_review_manifest,v_manifest_hash
  from public.persona_publication_reviews review
    where review.persona_id = p_persona_id and review.owner = v_owner
      and review.review_state = 'ready' and trim(review.intention) <> ''
      and review.reviewed_revision = v_revision
      and review.readiness_snapshot->>'manifest_sha256' = v_snapshot->>'manifest_sha256'
      and (review.readiness_snapshot->'review_manifest'->>'revision')::integer = v_revision
  for update;
  if not found then
    raise exception 'Complete the page review for the current revision before publishing';
  end if;

  if jsonb_typeof(coalesce(v_review_manifest->'dependencies','null'::jsonb))<>'array' then
    raise exception 'The reviewed dependency manifest is missing or invalid';
  end if;
  v_dependency_count:=jsonb_array_length(v_review_manifest->'dependencies');
  if v_dependency_count>308 then raise exception 'The reviewed dependency manifest is too large'; end if;

  delete from public.persona_publication_dependency_sets dependency_set
  where dependency_set.persona_id=p_persona_id and dependency_set.owner=v_owner;
  insert into public.persona_publication_dependency_sets(
    persona_id,owner,reviewed_revision,manifest_sha256,dependency_count,captured_at
  ) values (
    p_persona_id,v_owner,v_revision,v_manifest_hash,v_dependency_count,v_published_at
  );
  insert into public.persona_publication_dependencies(
    persona_id,owner,dependency_persona_id,dependency_kind,
    projection_sha256,dependency_revision,created_at
  )
  select p_persona_id,v_owner,(dependency.item->>'persona_id')::uuid,
    dependency.item->>'kind',dependency.item->>'projection_sha256',
    (dependency.item->>'dependency_revision')::integer,v_published_at
  from jsonb_array_elements(v_review_manifest->'dependencies') dependency(item);
  if (select count(*) from public.persona_publication_dependencies dependency
      where dependency.persona_id=p_persona_id)<>v_dependency_count then
    raise exception 'The reviewed dependency manifest contains duplicate or invalid entries';
  end if;

  perform set_config('app.persona_publication_transition','publish',true);
  update public.personas
  set publication_state = 'published', published_revision = v_revision,
      published_at = v_published_at, unpublished_at = null
  where id = p_persona_id and owner = v_owner;
  update public.persona_publication_reviews
  set review_state = 'published', readiness_snapshot = v_snapshot,
      required_missing = 0, published_at = v_published_at, updated_at = v_published_at
  where persona_id = p_persona_id and owner = v_owner;
  v_dependency_gate_current:=public.persona_publication_is_current(p_persona_id);
  with finalized as (
    update public.drafts draft
    set status='posted',publish_state='published',posted_at=v_published_at,
        publish_next_attempt_at=null,publish_error=''
    where draft.owner=v_owner and draft.persona_id=p_persona_id
      and draft.publish_state='blocked'
      and draft.publish_error='Staged in the persona page draft. Publish the exact page revision from Review.'
      and v_dependency_gate_current
      and draft.approval_state='approved'
      and draft.approved_content_hash<>''
      and draft.approved_content_hash=public.agent_draft_hash(
        draft.title,draft.body,draft.tags,draft.media_url,draft.content_kind,
        draft.persona_id,draft.account_id,draft.platform,draft.publish_at
      )
      and coalesce(draft.provider_post_id,'') ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      and exists (
        select 1 from public.posts post
        where post.id=draft.provider_post_id::uuid and post.persona_id=p_persona_id
          and row(post.kind,post.title,post.body,post.tags,post.media_url)
            is not distinct from row(
              case when draft.content_kind='reel' then 'reel' else 'post' end,
              coalesce(draft.title,''),coalesce(draft.body,''),
              coalesce(draft.tags,''),coalesce(draft.media_url,'')
            )
      )
    returning draft.id
  )
  insert into public.agent_actions(
    owner,persona_id,binding_id,action_type,entity_type,entity_id,outcome,detail
  )
  select v_owner,p_persona_id,binding.id,'publish.completed_after_page_review',
    'draft',finalized.id,'ok',jsonb_build_object(
      'destination','aliaspaces','pageRevision',v_revision,'publishedAt',v_published_at
    )
  from finalized
  left join public.agent_bindings binding
    on binding.owner=v_owner and binding.persona_id=p_persona_id;
  update public.drafts draft
  set publish_error='The page was published after its staged post changed. Review the draft and stage it again to reconcile provenance.',
      publish_next_attempt_at=null
  where draft.owner=v_owner and draft.persona_id=p_persona_id
    and draft.publish_state='blocked'
    and draft.publish_error='Staged in the persona page draft. Publish the exact page revision from Review.'
    and coalesce(draft.provider_post_id,'') ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    and not exists (
      select 1 from public.posts post
      where post.id=draft.provider_post_id::uuid and post.persona_id=p_persona_id
        and draft.approval_state='approved'
        and draft.approved_content_hash<>''
        and draft.approved_content_hash=public.agent_draft_hash(
          draft.title,draft.body,draft.tags,draft.media_url,draft.content_kind,
          draft.persona_id,draft.account_id,draft.platform,draft.publish_at
        )
        and row(post.kind,post.title,post.body,post.tags,post.media_url)
          is not distinct from row(
            case when draft.content_kind='reel' then 'reel' else 'post' end,
            coalesce(draft.title,''),coalesce(draft.body,''),
            coalesce(draft.tags,''),coalesce(draft.media_url,'')
          )
    );
  return v_snapshot || jsonb_build_object(
    'publication_state','published',
    'published_revision',v_revision,
    'published_at',v_published_at,
    'dependency_gate_current',v_dependency_gate_current,
    'publicly_visible',v_dependency_gate_current and v_visibility in ('public','unlisted'),
    'activation_state',case
      when not v_dependency_gate_current then 'waiting_for_reviewed_dependencies'
      when v_visibility='private' then 'active_with_private_friend_policy'
      else 'live' end
  );
end;
$$;

-- A reciprocal dependency can become current only after the second publish
-- transaction commits. The client calls this owner-only reconciliation RPC as
-- a second transaction; only exact approved native drafts whose reviewed page
-- is now current are finalized. This keeps staged-post state truthful without
-- recursively locking dependent persona graphs inside publication.
create or replace function public.reconcile_staged_native_page_publications(
  p_persona_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_persona_id uuid;
  v_finalized integer:=0;
  v_count integer:=0;
  v_reconciled_at timestamptz:=now();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_persona_id is not null and not public.owns_persona(p_persona_id) then
    raise exception 'Owned persona not found';
  end if;

  for v_persona_id in
    select persona.id from public.personas persona
    where persona.owner=v_owner
      and (p_persona_id is null or persona.id=p_persona_id)
    order by persona.id
  loop
    perform public.lock_persona_publication_mutation(v_persona_id);
    perform 1 from public.personas persona
    where persona.id=v_persona_id and persona.owner=v_owner for update;
    if not public.persona_publication_is_current(v_persona_id) then continue; end if;

    with finalized as (
      update public.drafts draft
      set status='posted',publish_state='published',posted_at=v_reconciled_at,
          publish_next_attempt_at=null,publish_error=''
      where draft.owner=v_owner and draft.persona_id=v_persona_id
        and draft.publish_state='blocked'
        and draft.publish_error='Staged in the persona page draft. Publish the exact page revision from Review.'
        and draft.approval_state='approved'
        and draft.approved_content_hash<>''
        and draft.approved_content_hash=public.agent_draft_hash(
          draft.title,draft.body,draft.tags,draft.media_url,draft.content_kind,
          draft.persona_id,draft.account_id,draft.platform,draft.publish_at
        )
        and coalesce(draft.provider_post_id,'') ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        and exists (
          select 1 from public.posts post
          where post.id=draft.provider_post_id::uuid and post.persona_id=v_persona_id
            and row(post.kind,post.title,post.body,post.tags,post.media_url)
              is not distinct from row(
                case when draft.content_kind='reel' then 'reel' else 'post' end,
                coalesce(draft.title,''),coalesce(draft.body,''),
                coalesce(draft.tags,''),coalesce(draft.media_url,'')
              )
        )
      returning draft.id
    ), logged as (
      insert into public.agent_actions(
        owner,persona_id,binding_id,action_type,entity_type,entity_id,outcome,detail
      )
      select v_owner,v_persona_id,(
          select binding.id from public.agent_bindings binding
          where binding.owner=v_owner and binding.persona_id=v_persona_id
          order by binding.id limit 1
        ),'publish.completed_after_page_review','draft',finalized.id,'ok',
        jsonb_build_object('destination','aliaspaces','reconciledAt',v_reconciled_at)
      from finalized
      returning entity_id
    )
    select count(*) into v_count from finalized;
    v_finalized:=v_finalized+v_count;
  end loop;

  return jsonb_build_object('ok',true,'finalized_count',v_finalized,'reconciled_at',v_reconciled_at);
end;
$$;
revoke all on function public.reconcile_staged_native_page_publications(uuid)
  from public,anon;
grant execute on function public.reconcile_staged_native_page_publications(uuid)
  to authenticated;

create or replace function public.unpublish_persona_page(p_persona_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  perform set_config('app.persona_publication_transition','unpublish',true);
  update public.personas
  set publication_state = 'unpublished', unpublished_at = now()
  where id = p_persona_id and owner = auth.uid();
  if not found then raise exception 'Owned persona not found'; end if;
  update public.persona_publication_reviews
  set review_state = 'stale', updated_at = now()
  where persona_id = p_persona_id and owner = auth.uid();
  return true;
end;
$$;

-- Migration 049's general business writer could publish directly. Publication
-- needs a dedicated review workflow, so browser owners can now save only a
-- private draft. The old function remains for compatibility but is not
-- executable by browser roles after this migration.
update public.businesses
set page_status='draft',visibility='owner_only',published_at=null,updated_at=now()
where page_status='published' or visibility<>'owner_only';
revoke all on function public.save_business_profile(uuid,text,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.set_business_persona_membership(uuid,uuid,text,text,boolean,text,text,integer,boolean)
  from public, anon, authenticated;
revoke all on function public.save_business_mission_item(uuid,uuid,text,text,integer,boolean,text)
  from public, anon, authenticated;

create or replace function public.save_business_draft(
  p_business_id uuid,
  p_slug text,
  p_display_name text,
  p_short_bio text default '',
  p_mission text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_id uuid;
  v_slug text := lower(trim(coalesce(p_slug,'')));
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{2,79}$' then raise exception 'Invalid business slug'; end if;
  if trim(coalesce(p_display_name,'')) = '' or char_length(p_display_name) > 160 then
    raise exception 'Invalid business name';
  end if;

  if p_business_id is null then
    insert into public.businesses(
      owner,slug,display_name,short_bio,mission,page_status,visibility,published_at
    ) values (
      v_owner,v_slug,trim(p_display_name),left(coalesce(p_short_bio,''),4000),
      left(coalesce(p_mission,''),10000),'draft','owner_only',null
    ) returning id into v_id;
  else
    update public.businesses
    set slug=v_slug,
        display_name=trim(p_display_name),
        short_bio=left(coalesce(p_short_bio,''),4000),
        mission=left(coalesce(p_mission,''),10000),
        page_status='draft',
        visibility='owner_only',
        published_at=null,
        updated_at=now()
    where id=p_business_id and owner=v_owner
    returning id into v_id;
    if v_id is null then raise exception 'Owned business not found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.set_business_persona_membership_draft(
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
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform 1 from public.businesses
  where id=p_business_id and owner=auth.uid() for update;
  if not found then raise exception 'Owned business not found'; end if;
  update public.businesses
  set page_status='draft',visibility='owner_only',published_at=null,updated_at=now()
  where id=p_business_id and owner=auth.uid();
  return public.set_business_persona_membership(
    p_business_id,p_persona_id,p_membership_role,p_public_title,p_enabled,
    p_membership_visibility,p_title_visibility,p_sort_order,p_remove
  );
end;
$$;

create or replace function public.save_business_mission_item_draft(
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
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform 1 from public.businesses
  where id=p_business_id and owner=auth.uid() for update;
  if not found then raise exception 'Owned business not found'; end if;
  update public.businesses
  set page_status='draft',visibility='owner_only',published_at=null,updated_at=now()
  where id=p_business_id and owner=auth.uid();
  return public.save_business_mission_item(
    p_item_id,p_business_id,p_title,p_body,p_sort_order,p_enabled,p_visibility
  );
end;
$$;

-- Unpublished personas are owner-only. Published private pages still require an
-- accepted friend relationship. Public/unlisted pages remain direct-viewable.
create or replace function public.persona_publication_is_current(pid uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.personas persona
    where persona.id=pid
      and persona.publication_state='published'
      and persona.published_revision=persona.publication_revision
      and public.persona_public_urls_safe(persona.id)
      and public.persona_modules_are_canonical(persona.modules)
      and exists (
        select 1 from public.persona_publication_reviews review
        where review.persona_id=persona.id and review.owner=persona.owner
          and review.review_state='published'
          and review.reviewed_revision=persona.publication_revision
      )
      and exists (
        select 1 from public.persona_publication_dependency_sets dependency_set
        join public.persona_publication_reviews reviewed
          on reviewed.persona_id=dependency_set.persona_id
         and reviewed.owner=dependency_set.owner
        where dependency_set.persona_id=persona.id
          and dependency_set.owner=persona.owner
          and dependency_set.reviewed_revision=persona.publication_revision
          and dependency_set.manifest_sha256=reviewed.readiness_snapshot->>'manifest_sha256'
          and dependency_set.dependency_count=(
            select count(*) from public.persona_publication_dependencies counted
            where counted.persona_id=persona.id
          )
      )
      and not exists (
        select 1
        from public.persona_publication_dependencies dependency
        left join public.personas relative
          on relative.id=dependency.dependency_persona_id
        left join public.persona_publication_reviews relative_review
          on relative_review.persona_id=relative.id and relative_review.owner=relative.owner
        where dependency.persona_id=persona.id and (
          relative.id is null
          or relative.publication_state<>'published'
          or relative.publication_revision is distinct from dependency.dependency_revision
          or relative.published_revision is distinct from relative.publication_revision
          or relative_review.review_state is distinct from 'published'
          or relative_review.reviewed_revision is distinct from relative.publication_revision
          or public.persona_dependency_projection_hash(
            dependency.dependency_persona_id,dependency.dependency_kind
          ) is distinct from dependency.projection_sha256
          or (dependency.dependency_kind='family' and relative.visibility<>'public')
          or (dependency.dependency_kind in ('top8','linked')
            and relative.visibility not in ('public','unlisted'))
        )
      )
  )
$$;

revoke all on function public.persona_publication_is_current(uuid)
  from public,anon,authenticated;
grant execute on function public.persona_publication_is_current(uuid)
  to service_role;

-- Agent binding mutations must acquire the persona advisory lock before the
-- binding row lock. Older direct column grants acquired those locks in the
-- opposite order from fan reservation/review staging and could deadlock. Keep
-- owner and trusted-service mutations behind explicit lock-ordered RPCs.
create or replace function public.save_my_agent_binding_controls(
  p_persona_id uuid,p_status text,p_autonomy_level smallint,
  p_fan_chat_enabled boolean,p_fan_daily_message_limit integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_binding public.agent_bindings%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_status not in ('active','paused','withdrawn')
     or p_autonomy_level not between 0 and 3
     or p_fan_daily_message_limit not between 1 and 500 then
    raise exception 'Invalid agent binding controls';
  end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  select * into v_binding from public.agent_bindings binding
  where binding.persona_id=p_persona_id and binding.owner=v_owner for update;
  if not found then raise exception 'Owned persona binding not found'; end if;
  if v_binding.status='suspended' then
    raise exception 'Platform suspension state cannot be changed here';
  end if;
  update public.agent_bindings binding set
    status=p_status,autonomy_level=p_autonomy_level,
    fan_chat_enabled=coalesce(p_fan_chat_enabled,false),
    fan_daily_message_limit=p_fan_daily_message_limit
  where binding.id=v_binding.id and binding.owner=v_owner
  returning * into v_binding;
  return jsonb_build_object(
    'id',v_binding.id,'persona_id',v_binding.persona_id,'status',v_binding.status,
    'claim_state',v_binding.claim_state,'autonomy_level',v_binding.autonomy_level,
    'fan_chat_enabled',v_binding.fan_chat_enabled,
    'fan_daily_message_limit',v_binding.fan_daily_message_limit
  );
end;
$$;

create or replace function public.save_agent_binding_controls_service(
  p_owner uuid,p_persona_id uuid,p_status text default null,
  p_claim_state text default null,p_autonomy_level smallint default null,
  p_fan_chat_enabled boolean default null,p_fan_daily_message_limit integer default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_binding public.agent_bindings%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_status is not null and p_status not in ('active','paused','suspended','withdrawn')
     or p_claim_state is not null
       and p_claim_state not in ('self_attested','verified','revoked','suspended')
     or p_autonomy_level is not null and p_autonomy_level not between 0 and 3
     or p_fan_daily_message_limit is not null
       and p_fan_daily_message_limit not between 1 and 500 then
    raise exception 'Invalid service agent binding controls';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051101)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_persona_id::text,51051102)
  );
  perform public.lock_persona_publication_mutation(p_persona_id);
  select * into v_binding from public.agent_bindings binding
  where binding.persona_id=p_persona_id and binding.owner=p_owner for update;
  if not found then raise exception 'Agent binding not found'; end if;
  update public.agent_bindings binding set
    status=coalesce(p_status,v_binding.status),
    claim_state=coalesce(p_claim_state,v_binding.claim_state),
    autonomy_level=coalesce(p_autonomy_level,v_binding.autonomy_level),
    fan_chat_enabled=coalesce(p_fan_chat_enabled,v_binding.fan_chat_enabled),
    fan_daily_message_limit=coalesce(
      p_fan_daily_message_limit,v_binding.fan_daily_message_limit
    )
  where binding.id=v_binding.id and binding.owner=p_owner;
  return true;
end;
$$;

create or replace function public.delete_agent_bindings_for_account_service(p_owner uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_persona_id uuid;v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051101)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051056)
  );
  for v_persona_id in
    select binding.persona_id from public.agent_bindings binding
    where binding.owner=p_owner order by binding.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_persona_id::text,51051102)
    );
    perform public.lock_persona_publication_mutation(v_persona_id);
  end loop;
  delete from public.agent_bindings binding where binding.owner=p_owner;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

do $migration$
begin
  if to_regprocedure('public.delete_my_agent_data_legacy_011()') is null
     and to_regprocedure('public.delete_my_agent_data()') is not null then
    alter function public.delete_my_agent_data() rename to delete_my_agent_data_legacy_011;
  end if;
end
$migration$;

create or replace function public.delete_my_agent_data()
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_persona_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051101)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051056)
  );
  for v_persona_id in
    select binding.persona_id from public.agent_bindings binding
    where binding.owner=v_owner order by binding.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_persona_id::text,51051102)
    );
    perform public.lock_persona_publication_mutation(v_persona_id);
  end loop;
  return public.delete_my_agent_data_legacy_011();
end;
$$;

revoke update(status,autonomy_level,fan_chat_enabled,fan_daily_message_limit)
  on public.agent_bindings from authenticated;
revoke update,delete on public.agent_bindings from service_role;
revoke all on function public.save_my_agent_binding_controls(uuid,text,smallint,boolean,integer)
  from public,anon,authenticated;
grant execute on function public.save_my_agent_binding_controls(uuid,text,smallint,boolean,integer)
  to authenticated;
revoke all on function public.save_agent_binding_controls_service(
  uuid,uuid,text,text,smallint,boolean,integer
) from public,anon,authenticated;
grant execute on function public.save_agent_binding_controls_service(
  uuid,uuid,text,text,smallint,boolean,integer
) to service_role;
revoke all on function public.delete_agent_bindings_for_account_service(uuid)
  from public,anon,authenticated;
grant execute on function public.delete_agent_bindings_for_account_service(uuid)
  to service_role;
revoke all on function public.delete_my_agent_data_legacy_011()
  from public,anon,authenticated,service_role;
revoke all on function public.delete_my_agent_data() from public,anon,authenticated;
grant execute on function public.delete_my_agent_data() to authenticated;

-- Rebind older service helpers to the exact page-current contract. The fan
-- completion wrapper takes the persona mutation lock and row-locks every live
-- eligibility switch before its final check. That makes unpublish/content
-- edits, owner pause, binding suspension, claim revocation, and fan-chat disable
-- linearizable with the assistant-message insert.
create or replace function public.fan_chat_available(p_persona_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.agent_bindings binding
    join public.agent_owner_settings setting on setting.owner=binding.owner
    join public.personas persona
      on persona.id=binding.persona_id and persona.owner=binding.owner
    where binding.persona_id=p_persona_id
      and binding.status='active'
      and binding.claim_state in ('self_attested','verified')
      and binding.fan_chat_enabled and not setting.automation_paused
      and persona.visibility in ('public','unlisted') and not coalesce(persona.nsfw,false)
      and public.persona_publication_is_current(persona.id)
  )
$$;
revoke all on function public.fan_chat_available(uuid)
  from public,anon,authenticated;
grant execute on function public.fan_chat_available(uuid) to service_role;

do $migration$
begin
  if to_regprocedure('public.complete_fan_chat_reply_legacy_011(uuid,uuid,uuid,text,text,text[])') is null
     and to_regprocedure('public.complete_fan_chat_reply(uuid,uuid,uuid,text,text,text[])') is not null then
    alter function public.complete_fan_chat_reply(uuid,uuid,uuid,text,text,text[])
      rename to complete_fan_chat_reply_legacy_011;
  end if;
end
$migration$;

create or replace function public.complete_fan_chat_reply(
  p_session_id uuid,p_owner uuid,p_response_token uuid,p_reply text,
  p_outcome text,p_categories text[] default array[]::text[]
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_session public.fan_chat_sessions%rowtype;
  v_setting public.agent_owner_settings%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_setting_found boolean;
  v_binding_found boolean;
  v_persona_found boolean;
  v_persona_visibility text;
  v_persona_nsfw boolean;
  v_reason text;
begin
  if char_length(trim(coalesce(p_reply,''))) not between 1 and 4000
     or p_outcome not in ('ok','escalated','model_error')
     or cardinality(coalesce(p_categories,array[]::text[])) > 8
     or exists (
       select 1 from unnest(coalesce(p_categories,array[]::text[])) category
       where char_length(coalesce(category,'')) not between 1 and 50
     ) then
    raise exception 'Invalid fan reply completion'; end if;
  select * into v_session from public.fan_chat_sessions session
  where session.id=p_session_id and session.owner=p_owner;
  if not found then return false; end if;
  perform public.lock_persona_publication_mutation(v_session.persona_id);
  select * into v_session from public.fan_chat_sessions session
  where session.id=p_session_id and session.owner=p_owner for update;
  if not found or not v_session.response_pending
     or v_session.response_lease_token is distinct from p_response_token then return false; end if;

  -- Owners edit these rows directly through their RLS-scoped browser session.
  -- Share locks conflict with those updates without unnecessarily serializing
  -- completions for distinct personas owned by the same account.
  select * into v_setting from public.agent_owner_settings setting
  where setting.owner=p_owner for share;
  v_setting_found:=found;
  select * into v_binding from public.agent_bindings binding
  where binding.owner=p_owner and binding.persona_id=v_session.persona_id for share;
  v_binding_found:=found;
  select persona.visibility,coalesce(persona.nsfw,false)
    into v_persona_visibility,v_persona_nsfw
  from public.personas persona
  where persona.id=v_session.persona_id and persona.owner=p_owner for share;
  v_persona_found:=found;

  v_reason:=case
    when v_session.response_lease_expires_at is null
      or v_session.response_lease_expires_at<=now() then 'lease_expired'
    when not v_setting_found then 'owner_settings_unavailable'
    when v_setting.automation_paused then 'automation_paused'
    when not v_binding_found then 'binding_unavailable'
    when v_binding.status<>'active' then 'binding_inactive'
    when v_binding.claim_state not in ('self_attested','verified') then 'claim_inactive'
    when not v_binding.fan_chat_enabled then 'fan_chat_disabled'
    when not v_persona_found then 'persona_unavailable'
    when v_persona_visibility not in ('public','unlisted') then 'persona_not_public'
    when v_persona_nsfw then 'persona_ineligible'
    when not public.persona_publication_is_current(v_session.persona_id)
      then 'publication_closed'
    else null end;
  if v_reason is not null then
    update public.fan_chat_sessions session set response_pending=false,
      response_lease_token=null,response_lease_expires_at=null,last_seen_at=now()
    where session.id=p_session_id and session.owner=p_owner;
    insert into public.agent_actions(
      owner,persona_id,binding_id,action_type,entity_type,entity_id,outcome,detail
    ) values (
      p_owner,v_session.persona_id,case when v_binding_found then v_binding.id else null end,
      'fan_chat.response_suppressed','fan_chat_session',p_session_id,'blocked',
      jsonb_build_object('reason',v_reason)
    );
    return false;
  end if;
  return public.complete_fan_chat_reply_legacy_011(
    p_session_id,p_owner,p_response_token,p_reply,p_outcome,p_categories
  );
end;
$$;
revoke all on function public.complete_fan_chat_reply_legacy_011(uuid,uuid,uuid,text,text,text[])
  from public,anon,authenticated,service_role;
revoke all on function public.complete_fan_chat_reply(uuid,uuid,uuid,text,text,text[])
  from public,anon,authenticated;
grant execute on function public.complete_fan_chat_reply(uuid,uuid,uuid,text,text,text[])
  to service_role;

do $migration$
begin
  if to_regprocedure('public.accept_product_review_request_service_legacy_043(uuid,uuid,text,text,text,text,text,boolean,boolean,text,text)') is null
     and to_regprocedure('public.accept_product_review_request_service(uuid,uuid,text,text,text,text,text,boolean,boolean,text,text)') is not null then
    alter function public.accept_product_review_request_service(
      uuid,uuid,text,text,text,text,text,boolean,boolean,text,text
    ) rename to accept_product_review_request_service_legacy_043;
  end if;
end
$migration$;

create or replace function public.accept_product_review_request_service(
  p_persona_id uuid,p_idempotency_key uuid,p_requester_email text,
  p_requester_name text,p_product_name text,p_product_url text,p_reason text,
  p_consent_to_reply boolean,p_marketing_consent boolean,
  p_request_fingerprint text,p_requester_email_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required'; end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  if not public.persona_publication_is_current(p_persona_id) then
    return jsonb_build_object('disposition','suppressed');
  end if;
  return public.accept_product_review_request_service_legacy_043(
    p_persona_id,p_idempotency_key,p_requester_email,p_requester_name,
    p_product_name,p_product_url,p_reason,p_consent_to_reply,p_marketing_consent,
    p_request_fingerprint,p_requester_email_hash
  );
end;
$$;
revoke all on function public.accept_product_review_request_service_legacy_043(
  uuid,uuid,text,text,text,text,text,boolean,boolean,text,text
) from public,anon,authenticated,service_role;
revoke all on function public.accept_product_review_request_service(
  uuid,uuid,text,text,text,text,text,boolean,boolean,text,text
) from public,anon,authenticated;
grant execute on function public.accept_product_review_request_service(
  uuid,uuid,text,text,text,text,text,boolean,boolean,text,text
) to service_role;

-- Owner review inbox. Notification rows remain service-only; this projection
-- exposes only delivery-state evidence and never provider message identifiers.
drop function if exists public.my_product_review_notification_evidence(uuid);
create or replace function public.my_product_review_notification_evidence(
  p_persona_id uuid default null,
  p_before_updated_at timestamptz default null,
  p_before_request_id uuid default null,
  p_limit integer default 500
)
returns table(
  request_id uuid,persona_id uuid,notification_status text,attempt_count integer,
  available_at timestamptz,notification_updated_at timestamptz,last_error_code text,
  provider_message_recorded boolean
)
language sql security definer stable set search_path = '' as $$
  select notification.request_id,notification.persona_id,notification.status,
    notification.attempt_count,notification.available_at,notification.updated_at,
    notification.last_error_code,notification.provider_message_id_hash is not null
  from public.product_review_notifications notification
  where notification.owner=auth.uid()
    and (p_persona_id is null or notification.persona_id=p_persona_id)
    and (p_persona_id is null or public.owns_persona(p_persona_id))
    and (
      (p_before_updated_at is null and p_before_request_id is null)
      or (
        p_before_updated_at is not null and p_before_request_id is not null
        and (notification.updated_at,notification.request_id)
          < (p_before_updated_at,p_before_request_id)
      )
    )
  order by notification.updated_at desc,notification.request_id desc
  limit least(greatest(coalesce(p_limit,500),1),500)
$$;

create or replace function public.update_product_review_request_status(
  p_request_id uuid,p_status text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_request public.product_review_requests%rowtype;v_allowed text[];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select * into v_request from public.product_review_requests request
  where request.id=p_request_id and request.owner=auth.uid() for update;
  if not found then raise exception 'Owned review request not found'; end if;
  if p_status=v_request.status then return true; end if;
  v_allowed:=case v_request.status
    when 'request_received' then array['triaged','declined']
    when 'triaged' then array['owner_testing','declined']
    when 'owner_testing' then array['evidence_ready','declined']
    when 'evidence_ready' then array['owner_testing','persona_draft','declined']
    when 'persona_draft' then array['evidence_ready','owner_approved','declined']
    when 'owner_approved' then array['persona_draft','corrected_or_withdrawn']
    when 'published' then array['corrected_or_withdrawn']
    when 'declined' then array['corrected_or_withdrawn']
    else array[]::text[] end;
  if not p_status=any(v_allowed) then
    raise exception 'Invalid review request status transition';
  end if;
  update public.product_review_requests request set status=p_status,updated_at=now()
  where request.id=v_request.id and request.owner=v_request.owner;
  if p_status='corrected_or_withdrawn' then
    update public.product_review_notifications notification
    set status='cancelled',claimed_at=null,available_at=now(),last_error_code='owner_withdrew'
    where notification.request_id=v_request.id and notification.owner=v_request.owner
      and notification.status in ('queued','claimed','failed');
  end if;
  insert into public.product_review_events(
    request_id,owner,persona_id,event_type,actor_type,details
  ) values (
    v_request.id,v_request.owner,v_request.persona_id,'state_changed','owner',
    jsonb_build_object('from',v_request.status,'to',p_status)
  );
  return true;
end;
$$;

create or replace function public.erase_product_review_request_pii(p_request_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_request public.product_review_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select * into v_request from public.product_review_requests request
  where request.id=p_request_id and request.owner=auth.uid() for update;
  if not found then raise exception 'Owned review request not found'; end if;
  if v_request.requester_email is null and v_request.requester_name is null
     and v_request.reason is null and not v_request.consent_to_reply
     and not v_request.marketing_consent then
    update public.product_review_notifications notification
    set status='cancelled',claimed_at=null,available_at=now(),last_error_code='owner_erased_pii'
    where notification.request_id=v_request.id and notification.owner=v_request.owner
      and notification.status in ('queued','claimed','failed');
    return true;
  end if;
  update public.product_review_requests request
  set requester_email=null,requester_name=null,reason=null,
      consent_to_reply=false,marketing_consent=false,
      status='corrected_or_withdrawn',updated_at=now()
  where request.id=v_request.id and request.owner=v_request.owner;
  update public.product_review_notifications notification
  set status='cancelled',claimed_at=null,available_at=now(),last_error_code='owner_erased_pii'
  where notification.request_id=v_request.id and notification.owner=v_request.owner
    and notification.status in ('queued','claimed','failed');
  insert into public.product_review_events(
    request_id,owner,persona_id,event_type,actor_type,details
  ) values (v_request.id,v_request.owner,v_request.persona_id,'pii_erased','owner',
    jsonb_build_object('previous_status',v_request.status));
  return true;
end;
$$;

revoke all on function public.my_product_review_notification_evidence(uuid,timestamptz,uuid,integer),
  public.update_product_review_request_status(uuid,text),
  public.erase_product_review_request_pii(uuid)
  from public,anon;
grant execute on function public.my_product_review_notification_evidence(uuid,timestamptz,uuid,integer),
  public.update_product_review_request_status(uuid,text),
  public.erase_product_review_request_pii(uuid)
  to authenticated;

-- The phase-1 limiter deliberately records a rate_limited event. Without a
-- second boundary, a valid-CAPTCHA flood above quota could still create one
-- event row per request. Serialize by persona/scope/window and keep only the
-- first diagnostic event; counters continue to live in the bounded limiter.
create or replace function public.bound_product_review_rate_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_scope text;v_window timestamptz;v_lock_key text;
begin
  if new.event_type<>'rate_limited' then return new; end if;
  v_scope:=new.details->>'scope';
  if v_scope not in ('global_15m','global_day','fingerprint_15m','fingerprint_day','email_day','persona_day') then
    return null; end if;
  v_window:=case when v_scope in ('global_15m','fingerprint_15m') then
    date_trunc('hour',new.created_at)+floor(extract(minute from new.created_at)/15)*interval '15 minutes'
  else date_trunc('day',new.created_at at time zone 'UTC') at time zone 'UTC' end;
  v_lock_key:=new.owner::text||':'||new.persona_id::text||':'||v_scope||':'||v_window::text;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key,51051051));
  if exists (
    select 1 from public.product_review_events event
    where event.owner=new.owner and event.persona_id=new.persona_id
      and event.event_type='rate_limited' and event.details->>'scope'=v_scope
      and event.created_at>=v_window
  ) then return null; end if;
  return new;
end;
$$;
revoke all on function public.bound_product_review_rate_event()
  from public,anon,authenticated;
drop trigger if exists bound_product_review_rate_event on public.product_review_events;
create trigger bound_product_review_rate_event
  before insert on public.product_review_events
  for each row execute function public.bound_product_review_rate_event();
create index if not exists product_review_rate_event_window_idx
  on public.product_review_events(owner,persona_id,event_type,(details->>'scope'),created_at desc)
  where event_type='rate_limited';

create or replace function public.persona_visible(pid uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.personas persona
    where persona.id = pid and (
      persona.owner = auth.uid()
      or (
        public.persona_publication_is_current(persona.id)
        and not exists (
          select 1
          from public.persona_publication_dependencies dependency
          join public.personas relative
            on relative.id=dependency.dependency_persona_id
          where dependency.persona_id=persona.id and (
            exists (
              select 1 from public.blocks hidden_dependency
              where hidden_dependency.blocker=auth.uid()
                and hidden_dependency.blocked_persona=relative.id
                and hidden_dependency.kind in ('block','mute')
            )
            or exists (
              select 1 from public.blocks dependency_blocked_viewer
              join public.personas viewer_persona
                on viewer_persona.id=dependency_blocked_viewer.blocked_persona
               and viewer_persona.owner=auth.uid()
              where dependency_blocked_viewer.blocker=relative.owner
                and dependency_blocked_viewer.kind='block'
            )
          )
        )
        and not exists (
          select 1 from public.blocks hidden
          where hidden.blocker=auth.uid() and hidden.blocked_persona=persona.id
            and hidden.kind in ('block','mute')
        )
        and not exists (
          select 1 from public.blocks blocked
          join public.personas mine on mine.id=blocked.blocked_persona and mine.owner=auth.uid()
          where blocked.blocker=persona.owner and blocked.kind='block'
        )
        and (
          persona.visibility in ('public','unlisted')
          or (persona.visibility = 'private' and exists (
            select 1 from public.follows friendship
            join public.personas mine on (
              (friendship.follower=persona.id and mine.id=friendship.target)
              or (friendship.target=persona.id and mine.id=friendship.follower)
            )
            where friendship.status='accepted' and mine.owner=auth.uid()
          ))
        )
      )
    )
  )
$$;

-- Comments and reactions are public identity-bearing content. Legacy policies
-- checked only the target post, so a draft/private actor (or one muted by the
-- viewer) could leak an id and body/kind. Reads now require both identities to
-- be visible; writes are serialized RPCs restricted to exact-current public or
-- unlisted actor personas.
drop policy if exists "comments read" on public.comments;
drop policy if exists "comments insert" on public.comments;
drop policy if exists "comments delete" on public.comments;
create policy "comments read" on public.comments for select using (
  public.persona_visible(persona_id)
  and exists (
    select 1 from public.posts post
    where post.id=post_id and public.persona_visible(post.persona_id)
  )
);

drop policy if exists "reactions read" on public.reactions;
drop policy if exists "reactions write" on public.reactions;
drop policy if exists "reactions remove" on public.reactions;
create policy "reactions read" on public.reactions for select using (
  public.persona_visible(persona_id)
  and exists (
    select 1 from public.posts post
    where post.id=post_id and public.persona_visible(post.persona_id)
  )
);

create index if not exists comments_persona_created_idx
  on public.comments(persona_id,created_at desc);

create or replace function public.add_persona_comment(
  p_post_id uuid,p_persona_id uuid,p_body text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid:=auth.uid();v_target_persona_id uuid;v_lock_id uuid;v_comment_id uuid;
  v_body text:=trim(coalesce(p_body,''));v_hour_count integer;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'Comment must be between 1 and 2000 characters';
  end if;
  select post.persona_id into v_target_persona_id
  from public.posts post where post.id=p_post_id;
  if not found then raise exception 'Visible post not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text,51051052)
  );
  for v_lock_id in
    select distinct candidate.id
    from unnest(array[p_persona_id,v_target_persona_id]) candidate(id)
    order by candidate.id
  loop perform public.lock_persona_publication_mutation(v_lock_id); end loop;
  if not exists (
    select 1 from public.personas actor where actor.id=p_persona_id
      and actor.owner=v_uid and actor.visibility in ('public','unlisted')
      and public.persona_publication_is_current(actor.id)
  ) then raise exception 'Publish a public or unlisted persona before commenting'; end if;
  if not exists (
    select 1 from public.posts post where post.id=p_post_id
      and post.persona_id=v_target_persona_id
      and public.persona_visible(post.persona_id)
  ) then raise exception 'Visible post not found'; end if;
  select count(*) into v_hour_count
  from public.comments comment
  join public.personas actor on actor.id=comment.persona_id
  where actor.owner=v_uid and comment.created_at>=now()-interval '1 hour';
  if v_hour_count>=60 then raise exception 'Comment rate limit reached'; end if;
  insert into public.comments(post_id,persona_id,body)
  values(p_post_id,p_persona_id,v_body) returning id into v_comment_id;
  return v_comment_id;
end;
$$;

create or replace function public.delete_persona_comment(p_comment_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_uid uuid:=auth.uid();v_actor_owner uuid;v_target_owner uuid;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select actor.owner,target.owner into v_actor_owner,v_target_owner
  from public.comments comment
  join public.personas actor on actor.id=comment.persona_id
  join public.posts post on post.id=comment.post_id
  join public.personas target on target.id=post.persona_id
  where comment.id=p_comment_id;
  if not found or v_uid not in (v_actor_owner,v_target_owner) then
    raise exception 'Owned comment not found';
  end if;
  delete from public.comments where id=p_comment_id;
  return true;
end;
$$;

create or replace function public.toggle_persona_reaction(
  p_post_id uuid,p_persona_id uuid,p_kind text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid:=auth.uid();v_target_persona_id uuid;v_lock_id uuid;
  v_kind text:=lower(trim(coalesce(p_kind,'')));
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if v_kind not in ('like','love','fire','laugh','wow','sad') then
    raise exception 'Invalid reaction kind';
  end if;
  select post.persona_id into v_target_persona_id
  from public.posts post where post.id=p_post_id;
  if not found then raise exception 'Visible post not found'; end if;
  for v_lock_id in
    select distinct candidate.id
    from unnest(array[p_persona_id,v_target_persona_id]) candidate(id)
    order by candidate.id
  loop perform public.lock_persona_publication_mutation(v_lock_id); end loop;
  if not exists (
    select 1 from public.personas actor where actor.id=p_persona_id
      and actor.owner=v_uid and actor.visibility in ('public','unlisted')
      and public.persona_publication_is_current(actor.id)
  ) then raise exception 'Publish a public or unlisted persona before reacting'; end if;
  if not exists (
    select 1 from public.posts post where post.id=p_post_id
      and post.persona_id=v_target_persona_id
      and public.persona_visible(post.persona_id)
  ) then raise exception 'Visible post not found'; end if;
  delete from public.reactions reaction where reaction.post_id=p_post_id
    and reaction.persona_id=p_persona_id and reaction.kind=v_kind;
  if found then return false; end if;
  insert into public.reactions(post_id,persona_id,kind)
  values(p_post_id,p_persona_id,v_kind);
  return true;
end;
$$;

revoke insert,update,delete on public.comments,public.reactions
  from public,anon,authenticated;
revoke all on function public.add_persona_comment(uuid,uuid,text),
  public.delete_persona_comment(uuid),public.toggle_persona_reaction(uuid,uuid,text)
  from public,anon;
grant execute on function public.add_persona_comment(uuid,uuid,text),
  public.delete_persona_comment(uuid),public.toggle_persona_reaction(uuid,uuid,text)
  to authenticated;

-- Return reviewed direct identity cards without recursively requiring each
-- referenced persona's own dependency graph. This keeps cycles bounded and
-- makes the rendered Top 8 / linked / family card set match the source page's
-- reviewed one-hop dependency ledger.
create or replace function public.persona_relation_cards(p_source_id uuid)
returns table(
  dependency_kind text,
  relative_persona_id uuid,
  relative_handle text,
  relative_name text,
  relative_tagline text,
  relative_avatar_url text,
  relationship_label text,
  sort_order integer
)
language sql
security definer
stable
set search_path = ''
as $$
  with source as (
    select persona.* from public.personas persona
    where persona.id=p_source_id and (
      persona.owner=auth.uid() or public.persona_visible(persona.id)
    )
  ), top8_cards as (
    select 'top8'::text as dependency_kind,relative.id,relative.handle,relative.name,
      ''::text as tagline,relative.avatar_url,''::text as relationship_label,
      reference.ord::integer-1 as sort_order,source.owner as source_owner,
      dependency.persona_id as reviewed_dependency
    from source
    cross join lateral jsonb_array_elements_text(case
      when jsonb_typeof(coalesce(source.top8,'[]'::jsonb))='array'
      then coalesce(source.top8,'[]'::jsonb) else '[]'::jsonb end)
      with ordinality reference(raw_id,ord)
    join public.personas relative on relative.id=case
      when reference.raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then reference.raw_id::uuid else null end
    left join public.persona_publication_dependencies dependency
      on dependency.persona_id=source.id and dependency.dependency_persona_id=relative.id
     and dependency.dependency_kind='top8'
    where reference.ord<=8 and relative.visibility in ('public','unlisted')
  ), linked_cards as (
    select 'linked'::text,relative.id,relative.handle,relative.name,
      coalesce(relative.tagline,''),relative.avatar_url,''::text,
      reference.ord::integer-1,source.owner,dependency.persona_id
    from source
    cross join lateral jsonb_array_elements_text(case
      when jsonb_typeof(coalesce(source.linked,'[]'::jsonb))='array'
      then coalesce(source.linked,'[]'::jsonb) else '[]'::jsonb end)
      with ordinality reference(raw_id,ord)
    join public.personas relative on relative.id=case
      when reference.raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then reference.raw_id::uuid else null end
    left join public.persona_publication_dependencies dependency
      on dependency.persona_id=source.id and dependency.dependency_persona_id=relative.id
     and dependency.dependency_kind='linked'
    where reference.ord<=100 and relative.visibility in ('public','unlisted')
  ), family_cards as (
    select 'family'::text,relative.id,relative.handle,relative.name,
      ''::text,relative.avatar_url,
      case
        when relationship.relationship_type='partner' then 'partner'
        when relationship.from_persona_id=source.id then 'child'
        else 'parent' end,
      row_number() over (order by relationship.relationship_type,relative.handle)::integer-1,
      source.owner,dependency.persona_id
    from source
    join public.persona_family_relationships relationship
      on relationship.owner=source.owner and relationship.visibility='public'
     and source.id in (relationship.from_persona_id,relationship.to_persona_id)
    join public.personas relative on relative.id=case
      when relationship.from_persona_id=source.id then relationship.to_persona_id
      else relationship.from_persona_id end
    left join public.persona_publication_dependencies dependency
      on dependency.persona_id=source.id and dependency.dependency_persona_id=relative.id
     and dependency.dependency_kind='family'
    where relative.visibility='public'
  ), cards as (
    select * from top8_cards union all select * from linked_cards union all select * from family_cards
  )
  select card.dependency_kind,card.id,card.handle,card.name,card.tagline,
    card.avatar_url,card.relationship_label,card.sort_order
  from cards card
  where (
    card.source_owner=auth.uid()
    and (
      exists(select 1 from public.personas owned_relative
        where owned_relative.id=card.id and owned_relative.owner=auth.uid())
      or (
        public.persona_publication_is_current(card.id)
        and public.persona_visible(card.id)
      )
    )
  ) or (
    card.reviewed_dependency is not null
    and public.persona_publication_is_current(card.id)
    and public.persona_visible(card.id)
  )
  order by card.dependency_kind,card.sort_order,card.id
$$;

revoke all on function public.persona_relation_cards(uuid) from public;
grant execute on function public.persona_relation_cards(uuid) to anon,authenticated;

create or replace function public.public_reviewed_persona_sitemap()
returns table(handle text,last_modified_at timestamptz)
language sql security definer stable set search_path = '' as $$
  select persona.handle,coalesce(persona.published_at,persona.created_at)
  from public.personas persona
  where persona.visibility='public'
    and public.persona_publication_is_current(persona.id)
  order by persona.published_at desc nulls last,persona.id
  limit 50000
$$;
revoke all on function public.public_reviewed_persona_sitemap()
  from public,anon,authenticated;
grant execute on function public.public_reviewed_persona_sitemap()
  to service_role;

-- Revenue rails and public review requests were introduced before page-level
-- publication. Rebind every public/service path to the reviewed current-page
-- gate so an unpublished or dependency-stale persona cannot keep monetizing or
-- receiving public requests through a SECURITY DEFINER bypass.
create or replace function public.get_public_persona_revenue_rails(p_handle text)
returns table (
  persona_id uuid,affiliate_enabled boolean,review_requests_enabled boolean,
  default_disclosure text,cta_label text,review_cta_label text,offers jsonb
)
language sql security definer stable set search_path = '' as $$
  select p.id,rs.affiliate_enabled,
    (rs.review_requests_enabled
      and p.visibility='public'
      and coalesce(request_setting.enabled,false)
      and request_setting.destination_ledger_id is not null
      and coalesce(control.accepting_requests,false)
      and not coalesce(control.abuse_paused,true)
      and exists (
        select 1 from public.agent_bindings binding
        join public.account_ledger ledger
          on ledger.id=request_setting.destination_ledger_id
         and ledger.owner=p.owner and ledger.persona_id=p.id
        join public.gmail_credentials credential
          on credential.ledger_id=ledger.id and credential.owner=ledger.owner
        where binding.persona_id=p.id and binding.owner=p.owner
          and binding.status='active'
          and binding.claim_state not in ('revoked','suspended')
          and ledger.provider='gmail' and not ledger.suspended
          and trim(coalesce(ledger.login_email,''))<>''
      )) as review_requests_enabled,
    rs.default_disclosure,rs.cta_label,rs.review_cta_label,
    case when rs.affiliate_enabled then coalesce(jsonb_agg(jsonb_build_object(
      'offer_id',offer.id,'title',product.title,'merchant',product.merchant,
      'image_url',product.image_url,
      'cta_label',coalesce(nullif(offer.cta_label,''),rs.cta_label),
      'placement',offer.placement,'priority',offer.priority,
      'disclosure',coalesce(nullif(product.disclosure,''),rs.default_disclosure),
      'category',product.category
    ) order by offer.priority desc) filter (
      where product.id is not null and offer.id is not null
    ),'[]'::jsonb) else '[]'::jsonb end
  from public.personas p
  join public.persona_revenue_settings rs on rs.persona_id=p.id and rs.owner=p.owner
  left join public.product_review_settings request_setting
    on request_setting.persona_id=p.id and request_setting.owner=p.owner
  left join public.product_review_global_controls control on control.singleton=1
  left join public.persona_affiliate_offers offer
    on offer.persona_id=p.id and offer.owner=p.owner and offer.status='active'
  left join public.affiliate_products product
    on product.id=offer.product_id and product.owner=p.owner and product.status='active'
   and public.is_safe_credential_free_https_url(product.affiliate_url,false)
   and public.is_safe_credential_free_https_url(product.product_url,true)
   and public.is_safe_credential_free_https_url(product.image_url,true)
  where p.handle=lower(trim(p_handle))
    and p.publication_state='published'
    and p.visibility in ('public','unlisted')
    and public.persona_publication_is_current(p.id)
    and public.persona_visible(p.id)
  group by p.id,rs.affiliate_enabled,rs.review_requests_enabled,
    rs.default_disclosure,rs.cta_label,rs.review_cta_label,
    request_setting.enabled,request_setting.destination_ledger_id,
    control.accepting_requests,control.abuse_paused
$$;

create or replace function public.create_review_request(
  p_persona_handle text,p_product_name text,p_product_url text default '',
  p_requester_name text default '',p_requester_email text default '',p_notes text default ''
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_persona public.personas%rowtype;v_request_id uuid;
begin
  select * into v_persona from public.personas persona
  where persona.handle=lower(trim(p_persona_handle))
    and persona.visibility in ('public','unlisted')
    and public.persona_publication_is_current(persona.id);
  if not found then raise exception 'Persona not found or not publicly available'; end if;
  if not exists(select 1 from public.persona_revenue_settings setting
    where setting.persona_id=v_persona.id and setting.owner=v_persona.owner
      and setting.review_requests_enabled) then
    raise exception 'Review requests are not enabled for this persona';
  end if;
  if char_length(trim(coalesce(p_product_name,''))) not between 2 and 200 then
    raise exception 'Product name is required and must be 200 characters or less'; end if;
  if char_length(coalesce(p_requester_name,''))>100
     or char_length(coalesce(p_requester_email,''))>200
     or char_length(coalesce(p_notes,''))>2000 then
    raise exception 'Requester details are too long'; end if;
  if coalesce(p_product_url,'')<>'' and p_product_url !~* '^https?://[^[:space:]]+$' then
    raise exception 'Product URL must be a valid http or https URL'; end if;
  insert into public.persona_review_requests(
    owner,persona_id,product_name,product_url,requester_name,requester_email,notes,status
  ) values (
    v_persona.owner,v_persona.id,trim(p_product_name),coalesce(p_product_url,''),
    trim(coalesce(p_requester_name,'')),trim(coalesce(p_requester_email,'')),
    trim(coalesce(p_notes,'')),'new'
  ) returning id into v_request_id;
  return v_request_id;
end;
$$;

create or replace function public.get_public_affiliate_destination(p_offer_id uuid)
returns table(offer_id uuid,persona_id uuid,affiliate_url text)
language sql security definer stable set search_path = '' as $$
  select offer.id,offer.persona_id,product.affiliate_url
  from public.persona_affiliate_offers offer
  join public.affiliate_products product
    on product.id=offer.product_id and product.owner=offer.owner and product.status='active'
  join public.personas persona
    on persona.id=offer.persona_id and persona.owner=offer.owner
  join public.persona_revenue_settings setting
    on setting.persona_id=persona.id and setting.owner=persona.owner
  where offer.id=p_offer_id and offer.status='active' and setting.affiliate_enabled
    and persona.visibility in ('public','unlisted')
    and public.persona_publication_is_current(persona.id)
    and product.affiliate_url ~* '^https?://[^[:space:]]+$'
  limit 1
$$;

create or replace function public.record_affiliate_click(
  p_persona_id uuid,p_offer_id uuid,p_source text,p_referrer text,
  p_utm_source text,p_utm_medium text,p_utm_campaign text,
  p_ip_hash text,p_user_agent_hash text
)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;v_product_id uuid;v_persona_id uuid;
begin
  select offer.owner,offer.product_id,offer.persona_id
  into v_owner,v_product_id,v_persona_id
  from public.persona_affiliate_offers offer
  join public.personas persona on persona.id=offer.persona_id and persona.owner=offer.owner
  join public.persona_revenue_settings setting
    on setting.persona_id=persona.id and setting.owner=persona.owner
  where offer.id=p_offer_id and offer.status='active' and setting.affiliate_enabled
    and persona.visibility in ('public','unlisted')
    and public.persona_publication_is_current(persona.id);
  if not found then return; end if;
  insert into public.affiliate_click_events(
    owner,persona_id,offer_id,product_id,source,referrer,
    utm_source,utm_medium,utm_campaign,ip_hash,user_agent_hash
  ) values (
    v_owner,v_persona_id,p_offer_id,v_product_id,left(coalesce(p_source,''),100),
    left(coalesce(p_referrer,''),2000),left(coalesce(p_utm_source,''),200),
    left(coalesce(p_utm_medium,''),200),left(coalesce(p_utm_campaign,''),200),
    left(coalesce(p_ip_hash,''),128),left(coalesce(p_user_agent_hash,''),128)
  );
end;
$$;

-- Public redirect traffic is attacker-controlled. Resolve the exact reviewed
-- destination and admit at most one analytics event per daily keyed visitor /
-- offer pair inside one service-only transaction. Global and per-offer caps
-- bound storage growth even when the offer UUID is replayed. The Edge function
-- supplies rotating HMACs; raw or plain-SHA IP addresses are never accepted.
create table if not exists public.affiliate_click_rate_limits (
  scope text not null check (scope in ('global_day','offer_hour','fingerprint_offer_day')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hit_count integer not null default 1 check (hit_count > 0),
  expires_at timestamptz not null,
  primary key (scope,key_hash,window_start),
  check (expires_at>window_start)
);
create index if not exists affiliate_click_rate_limits_expiry_idx
  on public.affiliate_click_rate_limits(expires_at);
alter table public.affiliate_click_rate_limits enable row level security;
revoke all on public.affiliate_click_rate_limits from public,anon,authenticated;
grant all on public.affiliate_click_rate_limits to service_role;

create or replace function public.resolve_affiliate_redirect_service(
  p_offer_id uuid,p_source text,p_referrer_host text,
  p_utm_source text,p_utm_medium text,p_utm_campaign text,
  p_fingerprint_hash text,p_user_agent_hash text
)
returns table(affiliate_url text)
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz:=clock_timestamp();v_day timestamptz;v_hour timestamptz;
  v_owner uuid;v_persona_id uuid;v_product_id uuid;v_destination text;
  v_global_key text;v_offer_key text;v_fingerprint_key text;
  v_global_hits integer;v_offer_hits integer;v_fingerprint_hits integer;
  v_source text:=lower(trim(coalesce(p_source,'unknown')));v_record boolean:=true;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required'; end if;
  if p_offer_id is null or coalesce(p_fingerprint_hash,'')!~'^[0-9a-f]{64}$'
     or (coalesce(p_user_agent_hash,'')<>'' and p_user_agent_hash!~'^[0-9a-f]{64}$') then
    raise exception 'Invalid affiliate redirect proof'; end if;
  if char_length(coalesce(p_referrer_host,''))>253
     or coalesce(p_referrer_host,'')!~'^[A-Za-z0-9.-]*$'
     or greatest(char_length(coalesce(p_utm_source,'')),
       char_length(coalesce(p_utm_medium,'')),char_length(coalesce(p_utm_campaign,'')))>120
     or concat_ws('',p_utm_source,p_utm_medium,p_utm_campaign)~'[[:cntrl:]<>]' then
    raise exception 'Invalid affiliate attribution input'; end if;
  if v_source not in ('persona_page','album','campaign','unknown') then v_source:='unknown'; end if;

  select offer.persona_id into v_persona_id
  from public.persona_affiliate_offers offer where offer.id=p_offer_id;
  if not found then return; end if;
  perform public.lock_persona_publication_mutation(v_persona_id);
  select offer.owner,offer.persona_id,offer.product_id,product.affiliate_url
  into v_owner,v_persona_id,v_product_id,v_destination
  from public.persona_affiliate_offers offer
  join public.affiliate_products product
    on product.id=offer.product_id and product.owner=offer.owner and product.status='active'
  join public.personas persona
    on persona.id=offer.persona_id and persona.owner=offer.owner
  join public.persona_revenue_settings setting
    on setting.persona_id=persona.id and setting.owner=persona.owner
  where offer.id=p_offer_id and offer.status='active' and setting.affiliate_enabled
    and persona.visibility in ('public','unlisted')
    and public.persona_publication_is_current(persona.id)
    and public.is_safe_credential_free_https_url(product.affiliate_url,false)
    and public.is_safe_credential_free_https_url(product.product_url,true)
    and public.is_safe_credential_free_https_url(product.image_url,true);
  if not found then return; end if;

  -- Analytics are best-effort after the reviewed destination gate. Any
  -- telemetry storage failure suppresses the event, never the safe redirect.
  begin
    v_day:=date_trunc('day',v_now at time zone 'UTC') at time zone 'UTC';
    v_hour:=date_trunc('hour',v_now);
    v_global_key:=encode(extensions.digest(
      convert_to('affiliate-click:global','UTF8'),'sha256'),'hex');
    v_offer_key:=encode(extensions.digest(
      convert_to('affiliate-click:offer:'||p_offer_id::text,'UTF8'),'sha256'),'hex');
    v_fingerprint_key:=encode(extensions.digest(convert_to(
      'affiliate-click:fingerprint:'||p_offer_id::text||':'||p_fingerprint_hash,
      'UTF8'),'sha256'),'hex');

    insert into public.affiliate_click_rate_limits(scope,key_hash,window_start,hit_count,expires_at)
    values('global_day',v_global_key,v_day,1,v_day+interval '2 days')
    on conflict(scope,key_hash,window_start) do update set
      hit_count=case when public.affiliate_click_rate_limits.hit_count<2147483647
        then public.affiliate_click_rate_limits.hit_count+1
        else public.affiliate_click_rate_limits.hit_count end,
      expires_at=greatest(public.affiliate_click_rate_limits.expires_at,excluded.expires_at)
    returning hit_count into v_global_hits;
    if v_global_hits>5000 then v_record:=false; end if;

    if v_record then
      insert into public.affiliate_click_rate_limits(scope,key_hash,window_start,hit_count,expires_at)
      values('offer_hour',v_offer_key,v_hour,1,v_hour+interval '2 hours')
      on conflict(scope,key_hash,window_start) do update set
        hit_count=case when public.affiliate_click_rate_limits.hit_count<2147483647
          then public.affiliate_click_rate_limits.hit_count+1
          else public.affiliate_click_rate_limits.hit_count end,
        expires_at=greatest(public.affiliate_click_rate_limits.expires_at,excluded.expires_at)
      returning hit_count into v_offer_hits;
      if v_offer_hits>500 then v_record:=false; end if;
    end if;

    if v_record then
      insert into public.affiliate_click_rate_limits(scope,key_hash,window_start,hit_count,expires_at)
      values('fingerprint_offer_day',v_fingerprint_key,v_day,1,v_day+interval '2 days')
      on conflict(scope,key_hash,window_start) do update set
        hit_count=case when public.affiliate_click_rate_limits.hit_count<2147483647
          then public.affiliate_click_rate_limits.hit_count+1
          else public.affiliate_click_rate_limits.hit_count end,
        expires_at=greatest(public.affiliate_click_rate_limits.expires_at,excluded.expires_at)
      returning hit_count into v_fingerprint_hits;
      if v_fingerprint_hits>1 then v_record:=false; end if;
    end if;

    if v_record then
      delete from public.affiliate_click_rate_limits rate where rate.ctid in (
        select expired.ctid from public.affiliate_click_rate_limits expired
        where expired.expires_at<v_now order by expired.expires_at limit 100
      );
      delete from public.affiliate_click_events event where event.id in (
        select expired.id from public.affiliate_click_events expired
        where expired.created_at<v_now-interval '400 days'
        order by expired.created_at limit 25
      );
      insert into public.affiliate_click_events(
        owner,persona_id,offer_id,product_id,source,referrer,
        utm_source,utm_medium,utm_campaign,ip_hash,user_agent_hash
      ) values (
        v_owner,v_persona_id,p_offer_id,v_product_id,v_source,
        left(lower(coalesce(p_referrer_host,'')),253),left(coalesce(p_utm_source,''),120),
        left(coalesce(p_utm_medium,''),120),left(coalesce(p_utm_campaign,''),120),
        p_fingerprint_hash,coalesce(p_user_agent_hash,'')
      );
    end if;
  exception when others then
    null;
  end;
  return query select v_destination;
end;
$$;

create or replace function public.purge_affiliate_click_retention_service()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rate_count integer;v_event_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required'; end if;
  delete from public.affiliate_click_rate_limits where expires_at<clock_timestamp();
  get diagnostics v_rate_count=row_count;
  delete from public.affiliate_click_events where created_at<clock_timestamp()-interval '400 days';
  get diagnostics v_event_count=row_count;
  return jsonb_build_object('rate_rows_deleted',v_rate_count,'event_rows_deleted',v_event_count);
end;
$$;

revoke all on function public.get_public_persona_revenue_rails(text) from public;
grant execute on function public.get_public_persona_revenue_rails(text) to anon,authenticated;
-- The migration-041 intake lacks the phase-1 CAPTCHA/HMAC/atomic-limit
-- contract. Keep it unreachable; the hardened Edge function calls
-- accept_product_review_request_service instead.
revoke all on function public.create_review_request(text,text,text,text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.get_public_affiliate_destination(uuid),
  public.record_affiliate_click(uuid,uuid,text,text,text,text,text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.resolve_affiliate_redirect_service(
  uuid,text,text,text,text,text,text,text
),public.purge_affiliate_click_retention_service()
  from public,anon,authenticated;
grant execute on function public.resolve_affiliate_redirect_service(
  uuid,text,text,text,text,text,text,text
),public.purge_affiliate_click_retention_service()
  to service_role;

-- Migration 041 granted its owner review/analytics helpers to authenticated but
-- did not first remove PostgreSQL's default PUBLIC EXECUTE. One writer also used
-- `<> auth.uid()`, whose NULL result let an anonymous caller skip the denial if
-- both private UUIDs were known. Rebind the exact rows under locks, use a
-- NULL-safe owner check, and make the entire legacy owner-RPC family explicit.
create or replace function public.link_review_request_to_draft(
  p_request_id uuid,
  p_draft_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_persona_id uuid;
  v_draft_owner uuid;
  v_draft_persona uuid;
begin
  select request.owner,request.persona_id into v_owner,v_persona_id
  from public.persona_review_requests request
  where request.id=p_request_id
  for update;
  if not found then raise exception 'Review request not found'; end if;
  if auth.uid() is null or v_owner is distinct from auth.uid() then
    raise sqlstate '42501' using message='Not authorized';
  end if;

  select draft.owner,draft.persona_id into v_draft_owner,v_draft_persona
  from public.post_drafts draft
  where draft.id=p_draft_id
  for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft_owner is distinct from v_owner then
    raise exception 'Draft belongs to a different owner';
  end if;
  if v_draft_persona is not null and v_draft_persona is distinct from v_persona_id then
    raise exception 'Draft belongs to a different persona';
  end if;

  update public.persona_review_requests request
  set post_draft_id=p_draft_id,status='drafted',updated_at=now()
  where request.id=p_request_id and request.owner=v_owner;
  update public.post_drafts draft
  set review_request_id=p_request_id
  where draft.id=p_draft_id and draft.owner=v_owner;
end;
$$;

revoke all on function public.owner_review_request_queue(),
  public.link_review_request_to_draft(uuid,uuid),
  public.update_review_request_status(uuid,text),
  public.get_affiliate_analytics()
  from public,anon,authenticated,service_role;
grant execute on function public.owner_review_request_queue(),
  public.link_review_request_to_draft(uuid,uuid),
  public.update_review_request_status(uuid,text),
  public.get_affiliate_analytics()
  to authenticated;

drop policy if exists "personas visible read" on public.personas;
create policy "personas visible read" on public.personas for select
  using (
    owner=auth.uid()
    or public.persona_visible(id)
  );

create or replace function public.can_request(follower_id uuid,target_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select follower_id<>target_id
    and public.owns_persona(follower_id)
    and not exists (
      select 1 from public.blocks block
      join public.personas target on target.id=target_id
      join public.personas blocked_identity
        on blocked_identity.id=block.blocked_persona and blocked_identity.owner=auth.uid()
      where block.blocker=target.owner
        and block.kind='block'
    )
    and not exists (
      select 1 from public.blocks block
      where block.blocker=auth.uid()
        and block.blocked_persona=target_id
        and block.kind='block'
    )
$$;
revoke all on function public.can_request(uuid,uuid) from public, anon, authenticated;

-- Fan chat Edge functions run as service_role, so table RLS cannot enforce the
-- page publication gate. Preserve the 046 implementations under private legacy
-- names and wrap their public signatures with an explicit published-page check.
do $$
begin
  if to_regprocedure('public.ensure_fan_chat_session_legacy_046(uuid,uuid,uuid,text,text)') is null then
    execute 'alter function public.ensure_fan_chat_session(uuid,uuid,uuid,text,text) rename to ensure_fan_chat_session_legacy_046';
  end if;
  if to_regprocedure('public.reserve_fan_chat_message_legacy_046(uuid,uuid,uuid,text,text,text[],integer,uuid)') is null then
    execute 'alter function public.reserve_fan_chat_message(uuid,uuid,uuid,text,text,text[],integer,uuid) rename to reserve_fan_chat_message_legacy_046';
  end if;
end
$$;

create or replace function public.ensure_fan_chat_session(
  p_session_id uuid,p_persona_id uuid,p_owner uuid,p_visitor_key_hash text,p_retention_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.lock_persona_publication_mutation(p_persona_id);
  if not exists (
    select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=p_owner
      and persona.publication_state='published'
      and persona.visibility in ('public','unlisted')
      and not coalesce(persona.nsfw,false)
      and public.persona_visible(persona.id)
  ) then
    return jsonb_build_object('accepted',false,'code','persona_unavailable');
  end if;
  return public.ensure_fan_chat_session_legacy_046(
    p_session_id,p_persona_id,p_owner,p_visitor_key_hash,p_retention_mode
  );
end;
$$;

create or replace function public.reserve_fan_chat_message(
  p_session_id uuid,p_persona_id uuid,p_owner uuid,p_visitor_key_hash text,
  p_message text,p_flag_reasons text[],p_hourly_limit integer,p_response_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.lock_persona_publication_mutation(p_persona_id);
  if not exists (
    select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=p_owner
      and persona.publication_state='published'
      and persona.visibility in ('public','unlisted')
      and not coalesce(persona.nsfw,false)
      and public.persona_visible(persona.id)
  ) then
    return jsonb_build_object('accepted',false,'code','persona_unavailable');
  end if;
  return public.reserve_fan_chat_message_legacy_046(
    p_session_id,p_persona_id,p_owner,p_visitor_key_hash,p_message,
    p_flag_reasons,p_hourly_limit,p_response_token
  );
end;
$$;

revoke all on function public.ensure_fan_chat_session_legacy_046(uuid,uuid,uuid,text,text),
  public.reserve_fan_chat_message_legacy_046(uuid,uuid,uuid,text,text,text[],integer,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.ensure_fan_chat_session(uuid,uuid,uuid,text,text),
  public.reserve_fan_chat_message(uuid,uuid,uuid,text,text,text[],integer,uuid)
  from public, anon, authenticated;
grant execute on function public.ensure_fan_chat_session(uuid,uuid,uuid,text,text),
  public.reserve_fan_chat_message(uuid,uuid,uuid,text,text,text[],integer,uuid)
  to service_role;

drop function if exists public.discover_personas(text, int);
create function public.discover_personas(q text default null, lim int default 80)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, hashtags text,
  top8 jsonb, modules jsonb, linked jsonb, title text, focus text, pet_project text,
  ai_disclosure text, publication_state text, created_at timestamptz, updated_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  select persona.id, persona.handle, persona.name, persona.tagline, persona.bio,
    persona.nsfw, persona.visibility, persona.avatar_url, persona.banner_url,
    persona.bg_url, persona.feed_img_url, persona.music_url, persona.live_url,
    persona.theme, persona.topics, persona.hashtags, persona.top8,
    public.canonical_persona_modules(persona.modules),
    persona.linked, persona.title, persona.focus, persona.pet_project,
    persona.ai_disclosure, persona.publication_state, persona.created_at, persona.updated_at
  from public.personas persona
  where persona.visibility = 'public'
    and persona.publication_state = 'published'
    and public.persona_visible(persona.id)
    and (q is null or persona.name ilike '%'||q||'%' or persona.handle ilike '%'||q||'%'
      or persona.topics ilike '%'||q||'%' or persona.tagline ilike '%'||q||'%')
  order by persona.created_at desc
  limit greatest(1, least(coalesce(lim,80), 200));
$$;

drop function if exists public.persona_by_handle(text);
create function public.persona_by_handle(h text)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, hashtags text,
  top8 jsonb, modules jsonb, linked jsonb, title text, focus text, pet_project text,
  ai_disclosure text, publication_state text, created_at timestamptz, updated_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  select persona.id, persona.handle, persona.name, persona.tagline, persona.bio,
    persona.nsfw, persona.visibility, persona.avatar_url, persona.banner_url,
    persona.bg_url, persona.feed_img_url, persona.music_url, persona.live_url,
    persona.theme, persona.topics, persona.hashtags, persona.top8,
    public.canonical_persona_modules(persona.modules),
    persona.linked, persona.title, persona.focus, persona.pet_project,
    persona.ai_disclosure, persona.publication_state, persona.created_at, persona.updated_at
  from public.personas persona
  where persona.handle = h and public.persona_visible(persona.id)
  limit 1;
$$;

revoke all on function public.discover_personas(text,int), public.persona_by_handle(text)
  from public;
grant execute on function public.discover_personas(text,int), public.persona_by_handle(text)
  to anon, authenticated;
grant select (ai_disclosure, publication_state, title, focus, pet_project, updated_at)
  on public.personas to anon, authenticated;

-- Tighten migration 049's public organization projections so a public business
-- or family edge can never reveal a persona whose page is currently a draft.
create or replace function public.persona_family_by_handle(p_handle text)
returns table(
  relative_persona_id uuid,
  relative_handle text,
  relative_name text,
  relative_avatar_url text,
  relationship_label text
)
language sql security definer stable set search_path = '' as $$
  with subject as (
    select p.id,p.owner from public.personas p
    where p.handle=lower(trim(p_handle)) and p.visibility='public'
      and p.publication_state='published'
      and public.persona_visible(p.id)
  ), direct_edges as (
    select relative.id,relative.handle,relative.name,relative.avatar_url,
      case when relationship.relationship_type='parent_of' then 'child' else 'partner' end
    from public.persona_family_relationships relationship
    join subject on subject.owner=relationship.owner and subject.id=relationship.from_persona_id
    join public.personas relative on relative.id=relationship.to_persona_id
      and relative.visibility='public' and relative.publication_state='published'
      and public.persona_visible(relative.id)
    where relationship.visibility='public'
    union all
    select relative.id,relative.handle,relative.name,relative.avatar_url,
      case when relationship.relationship_type='parent_of' then 'parent' else 'partner' end
    from public.persona_family_relationships relationship
    join subject on subject.owner=relationship.owner and subject.id=relationship.to_persona_id
    join public.personas relative on relative.id=relationship.from_persona_id
      and relative.visibility='public' and relative.publication_state='published'
      and public.persona_visible(relative.id)
    where relationship.visibility='public'
  )
  select * from direct_edges;
$$;

create or replace function public.business_page_by_slug(p_slug text)
returns table (
  id uuid,slug text,display_name text,short_bio text,mission text,
  mission_items jsonb,personas jsonb
)
language sql security definer stable set search_path = '' as $$
  select business.id,business.slug,business.display_name,business.short_bio,business.mission,
    coalesce((select jsonb_agg(jsonb_build_object('title',item.title,'body',item.body)
      order by item.sort_order,item.created_at)
      from public.business_mission_items item
      where item.business_id=business.id and item.owner=business.owner
        and item.enabled and item.visibility='public'),'[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',persona.id,'handle',persona.handle,'name',persona.name,
      'avatar_url',persona.avatar_url,
      'title',case when membership.title_visibility='public' then membership.public_title else '' end
    ) order by membership.sort_order,persona.name)
      from public.business_persona_memberships membership
      join public.personas persona on persona.id=membership.persona_id
      where membership.business_id=business.id and membership.owner=business.owner
        and membership.enabled and membership.membership_visibility='public'
        and persona.visibility='public' and persona.publication_state='published'
        and public.persona_visible(persona.id)),'[]'::jsonb)
  from public.businesses business
  where business.slug=lower(trim(p_slug))
    and business.page_status='published' and business.visibility='public'
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Feature request RPCs
-- ---------------------------------------------------------------------------

create or replace function public.create_feature_request_draft(
  p_persona_id uuid,
  p_title text,
  p_intention text,
  p_description text,
  p_source_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_id uuid;
  v_total integer;v_created_day integer;v_drafts integer;v_active integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(p_title,''))) < 3 then raise exception 'Feature request title is required'; end if;
  if p_persona_id is not null and not exists (
    select 1 from public.personas where id = p_persona_id and owner = v_owner
  ) then raise exception 'Owned persona not found'; end if;
  if jsonb_typeof(coalesce(p_source_context,'{}'::jsonb))<>'object'
     or octet_length(coalesce(p_source_context,'{}'::jsonb)::text) > 30000 then
    raise exception 'Feature request context is too large';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051053)
  );
  select count(*),
    count(*) filter(where created_at>=now()-interval '24 hours'),
    count(*) filter(where status='draft'),
    count(*) filter(where status in ('draft','submitted','triaged','planned'))
  into v_total,v_created_day,v_drafts,v_active
  from public.platform_feature_requests where owner=v_owner;
  if v_total>=500 then raise exception 'Feature request storage limit reached; remove eligible old requests'; end if;
  if v_created_day>=10 then raise exception 'Feature request daily draft limit reached'; end if;
  if v_drafts>=25 then raise exception 'Feature request draft limit reached'; end if;
  if v_active>=50 then raise exception 'Feature request active limit reached'; end if;
  perform public.consume_owner_daily_rate(
    v_owner,'feature_request_drafts',10,1,v_created_day
  );
  insert into public.platform_feature_requests (
    owner, persona_id, title, intention, description, source_context
  ) values (
    v_owner, p_persona_id, left(trim(p_title),300), left(coalesce(p_intention,''),12000),
    left(coalesce(p_description,''),30000), coalesce(p_source_context,'{}'::jsonb)
  ) returning id into v_id;
  insert into public.platform_feature_request_events(request_id, actor_id, event_type, to_status)
  values (v_id, v_owner, 'created', 'draft');
  return v_id;
end;
$$;

create or replace function public.submit_feature_request(p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid:=auth.uid();v_submitted_day integer;v_active_queue integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051053)
  );
  if not exists(select 1 from public.platform_feature_requests request
    where request.id=p_request_id and request.owner=v_owner and request.status='draft'
    for update) then raise exception 'Editable feature request draft not found'; end if;
  select count(*) filter(where submitted_at>=now()-interval '24 hours'),
    count(*) filter(where status in ('submitted','triaged','planned'))
  into v_submitted_day,v_active_queue
  from public.platform_feature_requests where owner=v_owner;
  if v_submitted_day>=5 then raise exception 'Feature request daily submission limit reached'; end if;
  if v_active_queue>=20 then raise exception 'Feature request review queue limit reached'; end if;
  perform public.consume_owner_daily_rate(
    v_owner,'feature_request_submissions',5,1,v_submitted_day
  );
  update public.platform_feature_requests request
  set status = 'submitted', submitted_at = now(), updated_at = now()
  where request.id = p_request_id and request.owner = v_owner and request.status = 'draft';
  insert into public.platform_feature_request_events(request_id, actor_id, event_type, from_status, to_status)
  values (p_request_id, v_owner, 'submitted', 'draft', 'submitted');
  return true;
end;
$$;

create or replace function public.withdraw_feature_request(p_request_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_old_status text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051053)
  );
  select status into v_old_status from public.platform_feature_requests request
  where request.id=p_request_id and request.owner=v_owner
    and request.status in ('submitted','triaged','planned') for update;
  if not found then raise exception 'Withdrawable feature request not found'; end if;
  update public.platform_feature_requests set status='withdrawn',updated_at=now()
  where id=p_request_id and owner=v_owner;
  insert into public.platform_feature_request_events(
    request_id,actor_id,event_type,from_status,to_status
  ) values(p_request_id,v_owner,'withdrawn',v_old_status,'withdrawn');
  return true;
end;
$$;

create or replace function public.delete_feature_request(p_request_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051053)
  );
  delete from public.platform_feature_requests request
  where request.id=p_request_id and request.owner=v_owner
    and request.status in ('draft','withdrawn','declined','completed');
  if not found then raise exception 'Deletable feature request not found'; end if;
  return true;
end;
$$;

create or replace function public.staff_update_feature_request(
  p_request_id uuid,
  p_status text,
  p_priority text,
  p_assigned_to uuid,
  p_staff_notes text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_old text;v_old_assigned uuid;v_event_type text;
begin
  if not public.has_platform_role(array['global_administrator','technician']::text[]) then
    raise exception 'Staff role required';
  end if;
  perform public.require_aal2();
  if p_status not in ('submitted','triaged','planned','declined','completed') then raise exception 'Invalid staff status'; end if;
  if p_priority not in ('low','normal','high','urgent') then raise exception 'Invalid priority'; end if;
  if p_assigned_to is not null and not exists (
    select 1 from public.platform_role_assignments assignment
    where assignment.account_id=p_assigned_to and assignment.active
      and assignment.role_key in ('global_administrator','technician')
      and (assignment.expires_at is null or assignment.expires_at>now())
  ) then raise exception 'Assignee must be an active administrator or technician'; end if;
  select status,assigned_to into v_old,v_old_assigned
  from public.platform_feature_requests where id = p_request_id for update;
  if v_old is null or v_old in ('draft','withdrawn') then raise exception 'Submitted feature request not found'; end if;
  update public.platform_feature_requests
  set status = p_status, priority = p_priority, assigned_to = p_assigned_to,
      staff_notes = left(coalesce(p_staff_notes,''),30000),
      completed_at = case when p_status = 'completed' then now() else null end,
      updated_at = now()
  where id = p_request_id;
  v_event_type:=case
    when p_status='completed' and p_status is distinct from v_old then 'completed'
    when p_status='declined' and p_status is distinct from v_old then 'declined'
    when p_status='planned' and p_status is distinct from v_old then 'planned'
    when p_assigned_to is distinct from v_old_assigned then 'assigned'
    when p_status is distinct from v_old then 'triaged'
    else 'commented'
  end;
  insert into public.platform_feature_request_events(request_id, actor_id, event_type, from_status, to_status)
  values (p_request_id, auth.uid(), v_event_type, v_old, p_status);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Follow/friend RPCs
-- ---------------------------------------------------------------------------

create or replace function public.follow_persona(
  p_follower_persona_id uuid,
  p_target_persona_id uuid,
  p_visibility text default 'public'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_existing_visibility text;
  v_owner_total integer;
  v_owner_day integer;
  v_persona_total integer;
  v_day timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_visibility not in ('public','private') then raise exception 'Invalid follow visibility'; end if;
  if not public.owns_persona(p_follower_persona_id) then raise exception 'Requesting persona is not owned by this account'; end if;
  if p_follower_persona_id = p_target_persona_id then raise exception 'A persona cannot follow itself'; end if;

  -- Existing follows can change their private/public display preference without
  -- re-locking a popular target or consuming another creation allowance.
  select relationship.visibility into v_existing_visibility
  from public.persona_follows relationship
  where relationship.follower_persona_id=p_follower_persona_id
    and relationship.target_persona_id=p_target_persona_id
  for update;
  if found then
    if v_existing_visibility is distinct from p_visibility then
      update public.persona_follows relationship set visibility=p_visibility
      where relationship.follower_persona_id=p_follower_persona_id
        and relationship.target_persona_id=p_target_persona_id;
    end if;
    return true;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051060)
  );
  select count(*) into v_owner_total from (
    select 1 from public.persona_follows relationship
    join public.personas mine on mine.id=relationship.follower_persona_id
    where mine.owner=v_owner limit 5000
  ) quota;
  select count(*) into v_owner_day from (
    select 1 from public.persona_follows relationship
    join public.personas mine on mine.id=relationship.follower_persona_id
    where mine.owner=v_owner and relationship.created_at>=v_day
      and relationship.created_at<v_day+interval '1 day' limit 200
  ) quota;
  select count(*) into v_persona_total from (
    select 1 from public.persona_follows relationship
    where relationship.follower_persona_id=p_follower_persona_id limit 2000
  ) quota;
  if v_owner_total>=5000 then raise exception 'Follow account limit reached (5000)'; end if;
  if v_owner_day>=200 then raise exception 'Follow daily creation limit reached (200 UTC)'; end if;
  if v_persona_total>=2000 then raise exception 'Persona follow limit reached (2000)'; end if;
  perform public.consume_owner_daily_rate(v_owner,'persona_follows',200,1,v_owner_day);

  perform public.lock_persona_publication_mutation(p_target_persona_id);
  if not exists (
    select 1 from public.personas target
    where target.id = p_target_persona_id
      and target.publication_state = 'published'
      and target.visibility in ('public','unlisted')
      and public.persona_visible(target.id)
  ) then raise exception 'That persona is not followable'; end if;
  if not public.can_request(p_follower_persona_id,p_target_persona_id) then
    raise exception 'Follow is not allowed';
  end if;
  insert into public.persona_follows(follower_persona_id,target_persona_id,visibility)
  values (p_follower_persona_id,p_target_persona_id,p_visibility)
  on conflict (follower_persona_id,target_persona_id) do nothing;
  return true;
end;
$$;

revoke insert,update on public.persona_follows from service_role;

create or replace function public.unfollow_persona(p_follower_persona_id uuid,p_target_persona_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.owns_persona(p_follower_persona_id) then raise exception 'Requesting persona is not owned by this account'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(auth.uid()::text,51051060)
  );
  delete from public.persona_follows
  where follower_persona_id=p_follower_persona_id and target_persona_id=p_target_persona_id;
  return found;
end;
$$;

-- Ordinary unfriend/cancel is deliberately pair-scoped. It never changes the
-- independent public-follow graph or another persona owned by the same account.
create or replace function public.remove_persona_friendship(
  p_owned_persona_id uuid,
  p_other_persona_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_owned_persona_id=p_other_persona_id then raise exception 'Invalid friendship pair'; end if;
  if not public.owns_persona(p_owned_persona_id) then
    raise exception 'Requesting persona is not owned by this account';
  end if;
  delete from public.follows relationship
  where (relationship.follower=p_owned_persona_id and relationship.target=p_other_persona_id)
     or (relationship.target=p_owned_persona_id and relationship.follower=p_other_persona_id);
  return found;
end;
$$;

-- Blocking is account-wide by design: remove every social edge between all of
-- the caller's personas and the blocked persona, including independent follows.
create or replace function public.remove_persona_social_relationships(p_other_persona_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_follow_count integer;
  v_friend_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  delete from public.persona_follows relationship
  using public.personas mine
  where mine.owner=auth.uid() and (
    (relationship.follower_persona_id=mine.id and relationship.target_persona_id=p_other_persona_id)
    or (relationship.target_persona_id=mine.id and relationship.follower_persona_id=p_other_persona_id)
  );
  get diagnostics v_follow_count = row_count;

  delete from public.follows relationship
  using public.personas mine
  where mine.owner=auth.uid() and (
    (relationship.follower=mine.id and relationship.target=p_other_persona_id)
    or (relationship.target=mine.id and relationship.follower=p_other_persona_id)
  );
  get diagnostics v_friend_count = row_count;

  return jsonb_build_object('follows_removed',v_follow_count,'friendships_removed',v_friend_count);
end;
$$;

-- Block/mute changes and account-wide edge cleanup are one lock-ordered
-- transaction. This shares the persona lock used by follow/friend creation, so
-- a request cannot commit after a separate cleanup and reappear on unblock.
create or replace function public.set_persona_visibility_rule(
  p_other_persona_id uuid,p_kind text,p_enabled boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_other_owner uuid;v_lock_id uuid;
  v_follow_count integer:=0;v_friend_count integer:=0;v_rule_count integer:=0;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_kind not in ('block','mute') or p_enabled is null then raise exception 'Invalid visibility rule'; end if;
  select persona.owner into v_other_owner from public.personas persona
  where persona.id=p_other_persona_id;
  if not found or v_other_owner=v_owner then raise exception 'Another account persona is required'; end if;
  for v_lock_id in
    select distinct id from (
      select persona.id from public.personas persona where persona.owner=v_owner
      union all select p_other_persona_id
    ) targets order by id
  loop perform public.lock_persona_publication_mutation(v_lock_id); end loop;
  perform 1 from public.personas persona where persona.id=p_other_persona_id for update;
  if not found then raise exception 'Persona no longer exists'; end if;

  if p_enabled then
    insert into public.blocks(blocker,blocked_persona,kind)
    values(v_owner,p_other_persona_id,p_kind)
    on conflict(blocker,blocked_persona,kind) do nothing;
    get diagnostics v_rule_count=row_count;
    if p_kind='block' then
      delete from public.persona_follows relationship using public.personas mine
      where mine.owner=v_owner and (
        (relationship.follower_persona_id=mine.id and relationship.target_persona_id=p_other_persona_id)
        or (relationship.target_persona_id=mine.id and relationship.follower_persona_id=p_other_persona_id)
      );
      get diagnostics v_follow_count=row_count;
      delete from public.follows relationship using public.personas mine
      where mine.owner=v_owner and (
        (relationship.follower=mine.id and relationship.target=p_other_persona_id)
        or (relationship.target=mine.id and relationship.follower=p_other_persona_id)
      );
      get diagnostics v_friend_count=row_count;
    end if;
  else
    delete from public.blocks rule
    where rule.blocker=v_owner and rule.blocked_persona=p_other_persona_id and rule.kind=p_kind;
    get diagnostics v_rule_count=row_count;
  end if;
  return jsonb_build_object('enabled',p_enabled,'kind',p_kind,'rule_rows_changed',v_rule_count,
    'follows_removed',v_follow_count,'friendships_removed',v_friend_count);
end;
$$;
revoke insert,update,delete on public.blocks from authenticated;
grant select on public.blocks to authenticated;

create or replace function public.set_persona_friend_policy(
  p_persona_id uuid,
  p_request_mode text,
  p_daily_request_limit integer,
  p_pending_request_limit integer,
  p_note text default ''
)
returns public.persona_friend_settings
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_row public.persona_friend_settings%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform 1 from public.profiles where id=v_owner for update;
  if p_request_mode not in ('open','invite_proof','contact_proof','closed') then raise exception 'Invalid friend request mode'; end if;
  if not exists(select 1 from public.personas where id=p_persona_id and owner=v_owner) then raise exception 'Owned persona not found'; end if;
  insert into public.persona_friend_settings(persona_id,owner,request_mode,daily_request_limit,pending_request_limit,note,updated_at)
  values(p_persona_id,v_owner,p_request_mode,greatest(1,least(coalesce(p_daily_request_limit,20),100)),greatest(1,least(coalesce(p_pending_request_limit,100),1000)),left(coalesce(p_note,''),1000),now())
  on conflict(persona_id) do update set request_mode=excluded.request_mode,daily_request_limit=excluded.daily_request_limit,pending_request_limit=excluded.pending_request_limit,note=excluded.note,updated_at=now()
  returning * into v_row;return v_row;
end;
$$;

create or replace function public.issue_persona_friend_invite(
  p_target_persona_id uuid,
  p_label text default '',
  p_max_uses integer default 1,
  p_expires_at timestamptz default now()+interval '30 days'
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_token text;v_issued_day integer;
  v_active_owner integer;v_active_persona integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if not exists(select 1 from public.personas where id=p_target_persona_id and owner=v_owner) then raise exception 'Owned persona not found'; end if;
  if p_expires_at <= now() or p_expires_at > now()+interval '90 days' then raise exception 'Invite expiry must be within 90 days'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051054)
  );
  select count(*) into v_issued_day from public.persona_friend_invites
  where owner=v_owner and created_at>=now()-interval '24 hours';
  if v_issued_day>=10 then raise exception 'Friend invite daily issue limit reached'; end if;
  delete from public.persona_friend_invites
  where owner=v_owner and created_at<now()-interval '24 hours'
    and (revoked_at is not null or expires_at<=now() or use_count>=max_uses);
  select count(*),count(*) filter(where target_persona_id=p_target_persona_id)
  into v_active_owner,v_active_persona
  from public.persona_friend_invites
  where owner=v_owner and revoked_at is null and expires_at>now() and use_count<max_uses;
  if v_active_owner>=50 then raise exception 'Active friend invite account limit reached'; end if;
  if v_active_persona>=10 then raise exception 'Active friend invite persona limit reached'; end if;
  perform public.consume_owner_daily_rate(
    v_owner,'friend_invites',10,1,v_issued_day
  );
  v_token:=encode(extensions.gen_random_bytes(24),'hex');
  insert into public.persona_friend_invites(target_persona_id,owner,token_hash,label,max_uses,expires_at)
  values(p_target_persona_id,v_owner,encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex'),left(coalesce(p_label,''),200),greatest(1,least(coalesce(p_max_uses,1),100)),p_expires_at);
  return v_token;
end;
$$;

create or replace function public.revoke_persona_friend_invites(p_target_persona_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if not exists(select 1 from public.personas where id=p_target_persona_id and owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051054)
  );
  update public.persona_friend_invites
  set revoked_at=now()
  where target_persona_id=p_target_persona_id and owner=v_owner
    and revoked_at is null and expires_at>now() and use_count<max_uses;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

-- A friendship/request is one unordered persona pair. Fail closed instead of
-- silently choosing a direction if legacy reciprocal duplicates already exist.
do $$
begin
  if exists (
    select 1 from public.follows
    group by least(follower,target),greatest(follower,target)
    having count(*)>1
  ) then
    raise exception 'Resolve reciprocal duplicate friendship rows before applying migration 051';
  end if;
end
$$;
create unique index if not exists follows_unordered_persona_pair_uidx
  on public.follows(least(follower,target),greatest(follower,target));

create or replace function public.request_persona_friendship(
  p_follower_persona_id uuid,
  p_target_persona_id uuid,
  p_invite_token text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_mode text:='open';v_daily integer:=20;v_pending integer:=100;
  v_target_owner uuid;
  v_invite public.persona_friend_invites%rowtype;v_existing public.follows%rowtype;
  v_id uuid;v_recent integer;v_pending_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if not public.owns_persona(p_follower_persona_id) then raise exception 'Requesting persona is not owned by this account'; end if;
  if p_follower_persona_id=p_target_persona_id then raise exception 'A persona cannot friend itself'; end if;

  -- Bound even invalid/random target probes. The advisory lock serializes this
  -- requester's audit-budget decision without creating reciprocal row-lock order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text, 51051));
  perform public.lock_persona_publication_mutation(p_target_persona_id);
  select count(*) into v_recent
  from public.friend_request_security_events
  where requester_owner=v_owner and created_at>now()-interval '24 hours';
  if v_recent>=100 then
    return jsonb_build_object('ok',false,'code','rate_limited','message','Friend request limit reached; try again later');
  end if;

  select target.owner,
         coalesce(setting.request_mode,'open'),
         coalesce(setting.daily_request_limit,20),
         coalesce(setting.pending_request_limit,100)
  into v_target_owner,v_mode,v_daily,v_pending
  from public.personas target
  left join public.persona_friend_settings setting on setting.persona_id=target.id
  where target.id=p_target_persona_id
    and target.publication_state='published'
    and public.persona_publication_is_current(target.id)
    and (
      target.visibility in ('public','unlisted')
      or (
        target.visibility='private'
        and coalesce(setting.request_mode,'closed') in ('invite_proof','contact_proof')
      )
    );
  if not found then
    insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'target_unavailable');
    return jsonb_build_object('ok',false,'code','target_unavailable','message','Target persona is not available');
  end if;

  -- Serialize request-limit decisions for both accounts. Sorting the locks keeps
  -- concurrent reciprocal requests from deadlocking.
  perform profile.id
  from public.profiles profile
  where profile.id in (v_owner,v_target_owner)
  order by profile.id
  for update;

  select target.owner,
         coalesce(setting.request_mode,'open'),
         coalesce(setting.daily_request_limit,20),
         coalesce(setting.pending_request_limit,100)
  into v_target_owner,v_mode,v_daily,v_pending
  from public.personas target
  left join public.persona_friend_settings setting on setting.persona_id=target.id
  where target.id=p_target_persona_id
    and target.publication_state='published'
    and public.persona_publication_is_current(target.id)
    and (
      target.visibility in ('public','unlisted')
      or (
        target.visibility='private'
        and coalesce(setting.request_mode,'closed') in ('invite_proof','contact_proof')
      )
    );
  if not found then
    insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'target_unavailable');
    return jsonb_build_object('ok',false,'code','target_unavailable','message','Target persona is not available');
  end if;
  if not public.can_request(p_follower_persona_id,p_target_persona_id) then
    insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'blocked');
    return jsonb_build_object('ok',false,'code','blocked','message','Friend request is not allowed');
  end if;
  select * into v_existing from public.follows
  where least(follower,target)=least(p_follower_persona_id,p_target_persona_id)
    and greatest(follower,target)=greatest(p_follower_persona_id,p_target_persona_id)
  for update;
  if found then
    return jsonb_build_object(
      'ok',true,
      'code',case when v_existing.status='accepted' then 'already_friends'
        when v_existing.follower=p_follower_persona_id then 'request_pending'
        else 'incoming_request_pending' end,
      'message',case when v_existing.status='accepted' then 'These personas are already friends'
        when v_existing.follower=p_follower_persona_id then 'Friend request is already pending'
        else 'This persona has already sent you a friend request' end,
      'request_id',v_existing.id
    );
  end if;
  if v_mode='closed' then
    insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'closed');
    return jsonb_build_object('ok',false,'code','closed','message','This persona is not accepting friend requests');
  end if;
  select count(*) into v_recent from public.friend_request_security_events where requester_owner=v_owner and created_at>now()-interval '24 hours';
  if v_recent>=v_daily then
    insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'rate_limited');
    return jsonb_build_object('ok',false,'code','rate_limited','message','Friend request limit reached; try again later');
  end if;
  select count(*) into v_pending_count from public.follows where target=p_target_persona_id and status='pending';
  if v_pending_count>=v_pending then
    insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'target_inbox_full');
    return jsonb_build_object('ok',false,'code','target_inbox_full','message','This persona has paused new requests while the inbox is full');
  end if;
  if v_mode='contact_proof' then
    insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'contact_proof_unavailable');
    return jsonb_build_object('ok',false,'code','contact_proof_unavailable','message','Private contact proof is not configured yet');
  end if;
  if v_mode='invite_proof' then
    if trim(coalesce(p_invite_token,''))='' then
      insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'invite_required');
      return jsonb_build_object('ok',false,'code','invite_required','message','An owner-issued invite proof is required');
    end if;
    select * into v_invite from public.persona_friend_invites invite
    where invite.target_persona_id=p_target_persona_id
      and invite.token_hash=encode(extensions.digest(convert_to(trim(p_invite_token),'UTF8'),'sha256'),'hex')
      and invite.revoked_at is null and invite.expires_at>now() and invite.use_count<invite.max_uses
    for update;
    if not found then
      insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'invalid_invite');
      return jsonb_build_object('ok',false,'code','invalid_invite','message','Invite proof is invalid or expired');
    end if;
    update public.persona_friend_invites set use_count=use_count+1 where id=v_invite.id;
  end if;
  insert into public.follows(follower,target,status) values(p_follower_persona_id,p_target_persona_id,'pending')
  returning id into v_id;
  insert into public.friend_request_security_events(requester_owner,follower_persona_id,target_persona_id,outcome) values(v_owner,p_follower_persona_id,p_target_persona_id,'requested');
  return jsonb_build_object('ok',true,'code','request_created','message','Friend request sent','request_id',v_id);
end;
$$;

create or replace function public.respond_persona_friendship(p_request_id uuid,p_accept boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_follower uuid;v_target uuid;v_follower_owner uuid;v_lock_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select follower,target into v_follower,v_target from public.follows where id=p_request_id;
  if v_target is null or not public.owns_persona(v_target) then raise exception 'Owned friend request not found'; end if;
  for v_lock_id in select distinct id from unnest(array[v_follower,v_target]) id order by id
  loop perform public.lock_persona_publication_mutation(v_lock_id); end loop;
  select relationship.follower,relationship.target,follower.owner
  into v_follower,v_target,v_follower_owner
  from public.follows relationship
  join public.personas follower on follower.id=relationship.follower
  where relationship.id=p_request_id for update;
  if v_target is null or not public.owns_persona(v_target) then raise exception 'Owned friend request not found'; end if;
  if p_accept and (
    exists(select 1 from public.blocks rule where rule.blocker=auth.uid()
      and rule.blocked_persona=v_follower and rule.kind='block')
    or exists(select 1 from public.blocks rule join public.personas mine
      on mine.id=rule.blocked_persona and mine.owner=auth.uid()
      where rule.blocker=v_follower_owner and rule.kind='block')
  ) then
    delete from public.follows where id=p_request_id;
    return false;
  end if;
  if p_accept then update public.follows set status='accepted' where id=p_request_id;
  else delete from public.follows where id=p_request_id;end if;
  return true;
end;
$$;

create or replace function public.public_persona_friend_policy(p_persona_id uuid)
returns table(request_mode text, daily_request_limit integer, accepting_requests boolean)
language sql security definer stable set search_path = '' as $$
  select coalesce(setting.request_mode,'open'),coalesce(setting.daily_request_limit,20),coalesce(setting.request_mode,'open')<>'closed'
  from public.personas persona left join public.persona_friend_settings setting on setting.persona_id=persona.id
  where persona.id=p_persona_id and public.persona_visible(persona.id)
$$;

-- ---------------------------------------------------------------------------
-- Account sync and extension submission RPCs
-- ---------------------------------------------------------------------------

create or replace function public.set_persona_account_sync(
  p_ledger_id uuid,p_persona_id uuid,p_enabled boolean,p_direction text,p_post_kinds text[],
  p_include_replies boolean,p_include_reposts boolean,p_publication_policy text
)
returns public.persona_account_sync_settings
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_row public.persona_account_sync_settings%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_direction not in ('import_only','export_only','both') then raise exception 'Invalid sync direction'; end if;
  if p_publication_policy not in ('draft_only','review_required','mirror_public') then raise exception 'Invalid sync publication policy'; end if;
  if p_post_kinds is null or cardinality(p_post_kinds) not between 1 and 12 or not (p_post_kinds <@ array['post','image','video','reel','story','article','newsletter','reply','repost']::text[]) then raise exception 'Invalid post filters'; end if;
  if not exists(select 1 from public.personas where id=p_persona_id and owner=v_owner) then raise exception 'Owned persona not found'; end if;
  if not exists(
    select 1 from public.account_ledger ledger where ledger.id=p_ledger_id and ledger.owner=v_owner and ledger.persona_id=p_persona_id
    union all select 1 from public.account_persona_links link where link.ledger_id=p_ledger_id and link.persona_id=p_persona_id and link.owner=v_owner
  ) then raise exception 'This account is not assigned to that persona'; end if;
  insert into public.persona_account_sync_settings(ledger_id,persona_id,owner,enabled,direction,post_kinds,include_replies,include_reposts,publication_policy,updated_at)
  values(p_ledger_id,p_persona_id,v_owner,coalesce(p_enabled,false),p_direction,p_post_kinds,coalesce(p_include_replies,false),coalesce(p_include_reposts,false),p_publication_policy,now())
  on conflict(ledger_id,persona_id) do update set enabled=excluded.enabled,direction=excluded.direction,post_kinds=excluded.post_kinds,include_replies=excluded.include_replies,include_reposts=excluded.include_reposts,publication_policy=excluded.publication_policy,updated_at=now()
  returning * into v_row;return v_row;
end;
$$;

create or replace function public.create_extension_submission(
  p_persona_id uuid,p_title text,p_source_type text,p_source_code text,p_requested_permissions text[] default '{}'
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;v_total integer;v_created_day integer;
  v_drafts integer;v_active integer;v_stored_bytes bigint;v_source_bytes integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_persona_id is not null and not exists(select 1 from public.personas where id=p_persona_id and owner=v_owner) then raise exception 'Owned persona not found'; end if;
  if char_length(trim(coalesce(p_title,''))) not between 3 and 200 then raise exception 'Extension title must be between 3 and 200 characters'; end if;
  if p_source_type not in ('component_json','html_css','typescript') then raise exception 'Invalid source type'; end if;
  v_source_bytes:=octet_length(coalesce(p_source_code,''));
  if v_source_bytes not between 1 and 100000 then raise exception 'Extension source must be between 1 and 100000 bytes'; end if;
  if not (coalesce(p_requested_permissions,'{}') <@ array['none','persona_public_fields','theme_tokens','public_assets','outbound_links']::text[]) then raise exception 'Unsupported extension permission'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051055)
  );
  select count(*),
    count(*) filter(where created_at>=now()-interval '24 hours'),
    count(*) filter(where status='draft'),
    count(*) filter(where status in ('draft','submitted','reviewing')),
    coalesce(sum(octet_length(source_code)),0)
  into v_total,v_created_day,v_drafts,v_active,v_stored_bytes
  from public.persona_extension_submissions where owner=v_owner;
  if v_total>=100 then raise exception 'Extension storage row limit reached; remove eligible old submissions'; end if;
  if v_created_day>=5 then raise exception 'Extension daily draft limit reached'; end if;
  if v_drafts>=10 then raise exception 'Extension draft limit reached'; end if;
  if v_active>=20 then raise exception 'Extension active limit reached'; end if;
  if v_stored_bytes+v_source_bytes>1000000 then raise exception 'Extension source storage limit reached'; end if;
  perform public.consume_owner_daily_rate(
    v_owner,'extension_drafts',5,1,v_created_day
  );
  insert into public.persona_extension_submissions(owner,persona_id,title,source_type,source_code,requested_permissions)
  values(v_owner,p_persona_id,left(trim(p_title),200),p_source_type,p_source_code,coalesce(p_requested_permissions,'{}')) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.submit_extension_for_review(p_submission_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_submitted_day integer;v_active_queue integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051055)
  );
  if not exists(select 1 from public.persona_extension_submissions submission
    where submission.id=p_submission_id and submission.owner=v_owner
      and submission.status='draft' for update) then
    raise exception 'Editable extension draft not found';
  end if;
  select count(*) filter(where submitted_at>=now()-interval '24 hours'),
    count(*) filter(where status in ('submitted','reviewing'))
  into v_submitted_day,v_active_queue
  from public.persona_extension_submissions where owner=v_owner;
  if v_submitted_day>=3 then raise exception 'Extension daily submission limit reached'; end if;
  if v_active_queue>=10 then raise exception 'Extension review queue limit reached'; end if;
  perform public.consume_owner_daily_rate(
    v_owner,'extension_submissions',3,1,v_submitted_day
  );
  update public.persona_extension_submissions set status='submitted',submitted_at=now(),updated_at=now()
  where id=p_submission_id and owner=v_owner and status='draft';
  if not found then raise exception 'Editable extension draft not found'; end if;return true;
end;
$$;

create or replace function public.withdraw_extension_submission(p_submission_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051055)
  );
  update public.persona_extension_submissions submission
  set status='withdrawn',updated_at=now()
  where submission.id=p_submission_id and submission.owner=v_owner
    and submission.status='submitted';
  if not found then raise exception 'Withdrawable extension submission not found'; end if;
  return true;
end;
$$;

create or replace function public.delete_extension_submission(p_submission_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051055)
  );
  delete from public.persona_extension_submissions submission
  where submission.id=p_submission_id and submission.owner=v_owner
    and submission.status in ('draft','withdrawn','rejected');
  if not found then raise exception 'Deletable extension submission not found'; end if;
  return true;
end;
$$;

create or replace function public.staff_update_extension_submission(
  p_submission_id uuid,
  p_status text,
  p_review_notes text default ''
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_platform_role(array['global_administrator','technician']::text[]) then
    raise exception 'Staff role required';
  end if;
  perform public.require_aal2();
  if p_status not in ('reviewing','approved','rejected','quarantined') then
    raise exception 'Invalid extension review status';
  end if;
  if char_length(coalesce(p_review_notes,'')) > 12000 then
    raise exception 'Extension review notes are too long';
  end if;
  update public.persona_extension_submissions
  set status=p_status,
      review_notes=coalesce(p_review_notes,''),
      reviewed_by=auth.uid(),
      reviewed_at=now(),
      updated_at=now()
  where id=p_submission_id and status in ('submitted','reviewing');
  if not found then raise exception 'Submitted extension not found'; end if;
  return true;
end;
$$;

-- Privacy exports use bounded self-data RPCs. The underlying security tables
-- remain unavailable to browser roles.
drop function if exists public.my_friend_request_security_events();
create or replace function public.my_friend_request_security_events(
  p_before_created_at timestamptz default null,
  p_before_event_id bigint default null,
  p_limit integer default 500
)
returns table(
  event_id bigint,
  requester_is_self boolean,
  follower_persona_id uuid,
  target_persona_id uuid,
  outcome text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select event.id,
         event.requester_owner = auth.uid(),
         event.follower_persona_id,
         event.target_persona_id,
         event.outcome,
         event.created_at
  from public.friend_request_security_events event
  where auth.uid() is not null
    and (
      event.requester_owner = auth.uid()
      or exists (
        select 1 from public.personas persona
        where persona.owner = auth.uid()
          and persona.id in (event.follower_persona_id,event.target_persona_id)
      )
    )
    and (
      (p_before_created_at is null and p_before_event_id is null)
      or (
        p_before_created_at is not null and p_before_event_id is not null
        and (event.created_at,event.id) < (p_before_created_at,p_before_event_id)
      )
    )
  order by event.created_at desc, event.id desc
  limit least(greatest(coalesce(p_limit,500),1),500)
$$;

drop function if exists public.my_platform_security_events();
create or replace function public.my_platform_security_events(
  p_before_created_at timestamptz default null,
  p_before_event_id bigint default null,
  p_limit integer default 500
)
returns table(
  event_id bigint,
  event_type text,
  severity text,
  source text,
  subject_type text,
  subject_id text,
  metadata jsonb,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select event.id,event.event_type,event.severity,event.source,
         event.subject_type,event.subject_id,event.metadata,event.created_at
  from public.platform_security_events event
  where auth.uid() is not null
    and (event.actor_id = auth.uid() or event.subject_account_id = auth.uid())
    and (
      (p_before_created_at is null and p_before_event_id is null)
      or (
        p_before_created_at is not null and p_before_event_id is not null
        and (event.created_at,event.id) < (p_before_created_at,p_before_event_id)
      )
    )
  order by event.created_at desc, event.id desc
  limit least(greatest(coalesce(p_limit,500),1),500)
$$;

drop function if exists public.my_account_network_blocks();
create or replace function public.my_account_network_blocks(
  p_before_updated_at timestamptz default null,
  p_before_identifier_hash text default null,
  p_limit integer default 500
)
returns table(
  identifier_hash text,
  block_level text,
  reason text,
  source text,
  expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select block.identifier_hash,block.block_level,block.reason,block.source,
         block.expires_at,block.created_at,block.updated_at
  from public.security_network_blocks block
  where auth.uid() is not null and block.subject_account_id = auth.uid()
    and (
      (p_before_updated_at is null and p_before_identifier_hash is null)
      or (
        p_before_updated_at is not null and p_before_identifier_hash is not null
        and (block.updated_at,block.identifier_hash)
          < (p_before_updated_at,p_before_identifier_hash)
      )
    )
  order by block.updated_at desc,block.identifier_hash desc
  limit least(greatest(coalesce(p_limit,500),1),500)
$$;

-- ---------------------------------------------------------------------------
-- Optional Auth Hooks. These are inert until explicitly selected in the
-- Supabase dashboard. Password/MFA hooks currently require Teams/Enterprise.
-- The hook records no raw IP, password, token, email, or phone value.
-- ---------------------------------------------------------------------------

create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare v_user uuid;v_valid boolean;v_state public.account_security_states%rowtype;v_count integer;v_lock interval;
begin
  v_user:=(event->>'user_id')::uuid;v_valid:=coalesce((event->>'valid')::boolean,false);
  insert into public.account_security_states(user_id) values(v_user) on conflict(user_id) do nothing;
  select * into v_state from public.account_security_states where user_id=v_user for update;
  if v_state.locked_until is not null and v_state.locked_until>now() then return jsonb_build_object('decision','reject','message','Sign-in is temporarily locked. Use account recovery or try again later.','should_logout_user',false);end if;
  if v_valid then
    update public.account_security_states set password_failed_count=0,password_window_started_at=null,password_last_failed_at=null,locked_until=null,lock_reason='',updated_at=now() where user_id=v_user;
    return jsonb_build_object('decision','continue');
  end if;
  if v_state.password_window_started_at is null or v_state.password_window_started_at<now()-interval '48 hours' then v_count:=1;else v_count:=v_state.password_failed_count+1;end if;
  v_lock:=case when v_count>=20 then interval '24 hours' when v_count>=10 then interval '30 minutes' when v_count>=5 then interval '5 minutes' else null end;
  update public.account_security_states set password_failed_count=v_count,password_window_started_at=case when v_count=1 then now() else password_window_started_at end,password_last_failed_at=now(),locked_until=case when v_lock is null then null else now()+v_lock end,locked_at=case when v_lock is null then locked_at else now() end,lock_reason=case when v_lock is null then '' else 'progressive_password_failure_lock' end,notification_pending=notification_pending or v_count>=5,updated_at=now() where user_id=v_user;
  insert into public.platform_security_events(actor_id,event_type,severity,source,subject_type,subject_id,subject_account_id,metadata) values(v_user,'password_verification_failed',case when v_count>=20 then 'critical' when v_count>=10 then 'high' when v_count>=5 then 'warning' else 'info' end,'auth_hook','account',v_user::text,v_user,jsonb_build_object('failure_count',v_count,'lock_seconds',case when v_lock is null then 0 else extract(epoch from v_lock)::integer end));
  return jsonb_build_object('decision','continue');
exception when others then
  return jsonb_build_object('error',jsonb_build_object('http_code',500,'message','Security verification could not complete.'));
end;
$$;

create or replace function public.hook_mfa_verification_attempt(event jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare v_user uuid;v_valid boolean;v_state public.account_security_states%rowtype;v_count integer;v_lock interval;
begin
  v_user:=(event->>'user_id')::uuid;v_valid:=coalesce((event->>'valid')::boolean,false);
  insert into public.account_security_states(user_id) values(v_user) on conflict(user_id) do nothing;
  select * into v_state from public.account_security_states where user_id=v_user for update;
  if v_state.locked_until is not null and v_state.locked_until>now() then return jsonb_build_object('decision','reject','message','MFA verification is temporarily locked.');end if;
  if v_valid then update public.account_security_states set mfa_failed_count=0,mfa_window_started_at=null,mfa_last_failed_at=null,updated_at=now() where user_id=v_user;return jsonb_build_object('decision','continue');end if;
  if v_state.mfa_window_started_at is null or v_state.mfa_window_started_at<now()-interval '48 hours' then v_count:=1;else v_count:=v_state.mfa_failed_count+1;end if;
  v_lock:=case when v_count>=10 then interval '24 hours' when v_count>=6 then interval '30 minutes' when v_count>=3 then interval '5 minutes' else null end;
  update public.account_security_states set mfa_failed_count=v_count,mfa_window_started_at=case when v_count=1 then now() else mfa_window_started_at end,mfa_last_failed_at=now(),locked_until=case when v_lock is null then null else now()+v_lock end,locked_at=case when v_lock is null then locked_at else now() end,lock_reason=case when v_lock is null then lock_reason else 'progressive_mfa_failure_lock' end,notification_pending=notification_pending or v_count>=3,updated_at=now() where user_id=v_user;
  insert into public.platform_security_events(actor_id,event_type,severity,source,subject_type,subject_id,subject_account_id,metadata) values(v_user,'mfa_verification_failed',case when v_count>=10 then 'critical' when v_count>=6 then 'high' when v_count>=3 then 'warning' else 'info' end,'auth_hook','account',v_user::text,v_user,jsonb_build_object('failure_count',v_count,'factor_type',left(coalesce(event->>'factor_type',''),20)));
  if v_lock is not null then return jsonb_build_object('decision','reject','message','Too many MFA attempts. Verification is temporarily locked.');end if;
  return jsonb_build_object('decision','continue');
exception when others then
  return jsonb_build_object('error',jsonb_build_object('http_code',500,'message','Security verification could not complete.'));
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_password_verification_attempt(jsonb), public.hook_mfa_verification_attempt(jsonb) to supabase_auth_admin;
grant select,insert,update on public.account_security_states to supabase_auth_admin;
grant insert on public.platform_security_events to supabase_auth_admin;
revoke all on function public.hook_password_verification_attempt(jsonb), public.hook_mfa_verification_attempt(jsonb) from public, anon, authenticated;

-- Retention is deliberately exposed only to the service role. Scheduling it is
-- a separate owner-approved production operation.
create or replace function public.purge_governance_security_retention()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_friend_events integer;
  v_security_events integer;
  v_expired_invites integer;
  v_expired_blocks integer;
  v_expired_review_requests integer;
  v_expired_feature_requests integer;
  v_expired_extensions integer;
begin
  delete from public.friend_request_security_events
  where created_at < now() - interval '90 days';
  get diagnostics v_friend_events = row_count;

  delete from public.platform_security_events
  where created_at < now() - interval '400 days';
  get diagnostics v_security_events = row_count;

  delete from public.persona_friend_invites
  where created_at < now() - interval '30 days'
    and (expires_at<now() or revoked_at is not null or use_count>=max_uses);
  get diagnostics v_expired_invites = row_count;

  delete from public.security_network_blocks
  where expires_at is not null and expires_at < now() - interval '30 days';
  get diagnostics v_expired_blocks = row_count;

  delete from public.product_review_requests
  where retention_expires_at<=now();
  get diagnostics v_expired_review_requests = row_count;

  delete from public.platform_feature_requests
  where (status='draft' and updated_at<now()-interval '90 days')
     or (status in ('withdrawn','declined','completed') and updated_at<now()-interval '400 days');
  get diagnostics v_expired_feature_requests = row_count;

  delete from public.persona_extension_submissions
  where (status in ('draft','withdrawn') and updated_at<now()-interval '90 days')
     or (status='rejected' and updated_at<now()-interval '400 days');
  get diagnostics v_expired_extensions = row_count;

  return jsonb_build_object(
    'friend_request_events', v_friend_events,
    'security_events', v_security_events,
    'friend_invites', v_expired_invites,
    'network_blocks', v_expired_blocks,
    'product_review_requests', v_expired_review_requests,
    'feature_requests',v_expired_feature_requests,
    'extension_submissions',v_expired_extensions
  );
end;
$$;

revoke all on function public.purge_governance_security_retention() from public, anon, authenticated;
grant execute on function public.purge_governance_security_retention() to service_role;

-- ---------------------------------------------------------------------------
-- Inherited 011 owner storage hardening
--
-- Browser writes to agent destinations, content plans, schedules, review
-- drafts, and owner-chat messages now use bounded SECURITY DEFINER RPCs. Every
-- RPC takes the account lock before sorted persona locks and before row locks.
-- Service workers retain their existing server-owned scheduling/publication
-- mutations; browser roles cannot forge leases, approvals, publish results, or
-- timestamps through direct table DML.
-- ---------------------------------------------------------------------------

create table if not exists public.agent_storage_creation_counters(
  owner uuid not null references public.profiles(id) on delete cascade,
  resource text not null check(resource in (
    'agent_destinations','persona_content_plans','persona_content_plan_mutations',
    'ai_tasks','drafts','agent_messages'
  )),
  counter_date date not null default current_date,
  daily_count integer not null default 0 check(daily_count between 0 and 1000000),
  lifetime_count bigint not null default 0 check(lifetime_count>=0),
  updated_at timestamptz not null default now(),
  primary key(owner,resource)
);
alter table public.agent_storage_creation_counters
  drop constraint if exists agent_storage_creation_counters_resource_check;
alter table public.agent_storage_creation_counters
  add constraint agent_storage_creation_counters_resource_check check(resource in (
    'agent_destinations','persona_content_plans','persona_content_plan_mutations',
    'ai_tasks','drafts','agent_messages'
  ));
alter table public.agent_storage_creation_counters enable row level security;
drop policy if exists "agent storage counters owner read" on public.agent_storage_creation_counters;
create policy "agent storage counters owner read" on public.agent_storage_creation_counters
  for select to authenticated using(owner=auth.uid());
revoke all on public.agent_storage_creation_counters from public,anon,authenticated;
grant select on public.agent_storage_creation_counters to authenticated;

create index if not exists agent_destinations_owner_created_quota_idx
  on public.agent_destinations(owner,created_at desc,id);
create index if not exists persona_content_plans_owner_created_quota_idx
  on public.persona_content_plans(owner,created_at desc,persona_id);
create index if not exists ai_tasks_owner_created_quota_idx
  on public.ai_tasks(owner,created_at desc,id);
create index if not exists ai_tasks_owner_persona_quota_idx
  on public.ai_tasks(owner,persona_id,id);
create index if not exists drafts_owner_created_quota_idx
  on public.drafts(owner,created_at desc,id);
create index if not exists drafts_owner_persona_quota_idx
  on public.drafts(owner,persona_id,id);
create index if not exists agent_messages_owner_created_quota_idx
  on public.agent_messages(owner,created_at desc,id);
create index if not exists agent_messages_owner_persona_quota_idx
  on public.agent_messages(owner,persona_id,id);

create or replace function public.lock_owner_agent_storage(p_owner uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null then raise exception 'Owner id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051101)
  );
end;
$$;

create or replace function public.lock_persona_agent_storage(p_persona_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_persona_id is null then raise exception 'Persona id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_persona_id::text,51051102)
  );
end;
$$;

create or replace function public.assert_agent_storage_text(
  p_value text,p_field text,p_max_bytes integer,p_required boolean
)
returns text language plpgsql immutable set search_path = '' as $$
declare v_value text:=coalesce(p_value,'');
begin
  if p_max_bytes<0 or p_max_bytes>1048576 then
    raise exception 'Invalid storage text limit';
  end if;
  if p_required and btrim(v_value)='' then
    raise exception '% is required',p_field;
  end if;
  if pg_catalog.octet_length(v_value)>p_max_bytes then
    raise exception using errcode='22001',
      message=pg_catalog.format('%s may be at most %s UTF-8 bytes',p_field,p_max_bytes);
  end if;
  if pg_catalog.regexp_replace(v_value,E'[\r\n\t]','','g')~'[[:cntrl:]]' then
    raise exception '% contains unsupported control characters',p_field;
  end if;
  return v_value;
end;
$$;

revoke all on function public.lock_owner_agent_storage(uuid),
  public.lock_persona_agent_storage(uuid),
  public.assert_agent_storage_text(text,text,integer,boolean)
  from public,anon,authenticated,service_role;

create or replace function public.reserve_agent_storage_creations(
  p_owner uuid,p_resource text,p_amount integer,p_daily_limit integer,
  p_existing_recent integer
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_counter_date date;
  v_daily integer;
  v_lifetime bigint;
  v_plan_lifetime_limit constant bigint:=100000;
begin
  if p_owner is null or (
    p_owner is distinct from auth.uid() and coalesce(auth.role(),'')<>'service_role'
  ) then raise sqlstate '42501' using message='Agent storage counter access denied'; end if;
  if p_resource is null or p_resource not in (
    'agent_destinations','persona_content_plans','persona_content_plan_mutations',
    'ai_tasks','drafts','agent_messages'
  ) or p_amount is null or p_amount not between 1 and 50
     or p_daily_limit is null or p_daily_limit not between 1 and 10000
     or p_existing_recent is null
     or p_existing_recent not between 0 and p_daily_limit then
    raise exception 'Invalid agent storage counter reservation';
  end if;
  perform public.lock_owner_agent_storage(p_owner);
  select counter.counter_date,counter.daily_count,counter.lifetime_count
  into v_counter_date,v_daily,v_lifetime
  from public.agent_storage_creation_counters counter
  where counter.owner=p_owner and counter.resource=p_resource for update;
  if not found then
    v_daily:=p_existing_recent;
    if p_resource='persona_content_plan_mutations' then
      select count(*) into v_lifetime from (
        select 1 from public.agent_actions action
        where action.owner=p_owner and action.action_type='direction.updated'
          and action.entity_type='content_plan'
        limit 100001
      ) bounded;
    else
      v_lifetime:=p_existing_recent;
    end if;
  elsif v_counter_date<>current_date then
    v_daily:=p_existing_recent;
  end if;
  if v_daily+p_amount>p_daily_limit then
    raise exception '% daily creation limit reached (%)',
      pg_catalog.replace(p_resource,'_',' '),p_daily_limit;
  end if;
  if p_resource='persona_content_plan_mutations'
     and coalesce(v_lifetime,0)+p_amount>v_plan_lifetime_limit then
    raise exception 'Content plan lifetime audited-mutation limit reached (%); contact support for archival review',
      v_plan_lifetime_limit;
  end if;
  insert into public.agent_storage_creation_counters(
    owner,resource,counter_date,daily_count,lifetime_count,updated_at
  ) values (
    p_owner,p_resource,current_date,v_daily+p_amount,
    coalesce(v_lifetime,0)+p_amount,now()
  ) on conflict(owner,resource) do update set
    counter_date=excluded.counter_date,daily_count=excluded.daily_count,
    lifetime_count=excluded.lifetime_count,updated_at=excluded.updated_at;
  return v_daily+p_amount;
end;
$$;
revoke all on function public.reserve_agent_storage_creations(
  uuid,text,integer,integer,integer
) from public,anon,authenticated,service_role;

create or replace function public.save_agent_destination(
  p_destination_id uuid,p_binding_id uuid,p_persona_id uuid,p_account_id uuid,
  p_destination text,p_mode text,p_enabled boolean,p_allowed_content_types text[],
  p_daily_publish_limit integer,p_quiet_hours_start time,p_quiet_hours_end time
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_existing public.agent_destinations%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_old_persona_id uuid;
  v_account_provider text;
  v_account_persona_id uuid;
  v_destination text;
  v_allowed text[];
  v_id uuid;
  v_total integer;
  v_persona_total integer;
  v_created_day integer;
  v_stored_bytes bigint;
  v_old_bytes bigint:=0;
  v_new_bytes bigint;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_binding_id is null or p_persona_id is null then
    raise exception 'Binding and persona are required';
  end if;
  if p_mode is null or p_mode not in ('manual','approval','auto') then
    raise exception 'Invalid destination mode';
  end if;
  if p_mode='auto' then
    raise exception 'Automatic publication is paused pending exact page-review support';
  end if;
  if p_daily_publish_limit is null or p_daily_publish_limit not between 1 and 100 then
    raise exception 'Invalid daily publish limit';
  end if;
  if (p_quiet_hours_start is null)<>(p_quiet_hours_end is null) then
    raise exception 'Set both destination quiet hours or neither';
  end if;
  if coalesce(pg_catalog.cardinality(p_allowed_content_types),0) not between 1 and 6 then
    raise exception 'Choose between one and six allowed content types';
  end if;
  select pg_catalog.array_agg(item.value order by item.value) into v_allowed
  from (
    select distinct lower(btrim(source.value)) as value
    from pg_catalog.unnest(p_allowed_content_types) source(value)
  ) item;
  if pg_catalog.cardinality(v_allowed)<>pg_catalog.cardinality(p_allowed_content_types)
     or exists (
       select 1 from pg_catalog.unnest(v_allowed) item(value)
       where item.value not in ('post','reel','article','image','newsletter','promo')
     ) then
    raise exception 'Allowed content types must be unique supported values';
  end if;
  v_destination:=public.normalize_agent_destination(public.assert_agent_storage_text(
    p_destination,'Destination',128,true
  ));
  if pg_catalog.octet_length(v_destination)>128
     or v_destination!~'^[a-z0-9][a-z0-9._-]{0,127}$' then
    raise exception 'Destination must be a normalized provider key';
  end if;

  perform public.lock_owner_agent_storage(v_owner);
  if p_destination_id is not null then
    select destination.persona_id into v_old_persona_id
    from public.agent_destinations destination
    where destination.id=p_destination_id and destination.owner=v_owner;
    if not found then raise exception 'Owned destination not found'; end if;
    if v_old_persona_id is distinct from p_persona_id then
      raise exception 'Delete and recreate a destination to move it between personas';
    end if;
  end if;
  perform public.lock_persona_agent_storage(p_persona_id);

  if p_destination_id is not null then
    select * into v_existing from public.agent_destinations destination
    where destination.id=p_destination_id and destination.owner=v_owner for update;
    if not found or v_existing.persona_id is distinct from p_persona_id then
      raise exception 'Destination changed; retry the operation';
    end if;
    if v_existing.binding_id is distinct from p_binding_id
       or v_existing.account_id is distinct from p_account_id
       or public.normalize_agent_destination(v_existing.destination) is distinct from v_destination then
      raise exception 'Delete and recreate a destination to change its identity';
    end if;
  end if;

  select * into v_binding from public.agent_bindings binding
  where binding.id=p_binding_id and binding.owner=v_owner
    and binding.persona_id=p_persona_id for share;
  if not found then raise exception 'Owned persona binding not found'; end if;
  if p_account_id is null then
    if v_destination not in ('aliaspaces','aliaspaces.com','mypersonas','mypersonas.online') then
      raise exception 'A native destination must use an AliaSpaces provider key';
    end if;
  else
    select account.provider,account.persona_id
    into v_account_provider,v_account_persona_id
    from public.account_ledger account
    where account.id=p_account_id and account.owner=v_owner for share;
    if not found or v_account_persona_id is distinct from p_persona_id then
      raise exception 'Destination account must be assigned to the owned persona';
    end if;
    if public.normalize_agent_destination(v_account_provider) is distinct from v_destination then
      raise exception 'Destination provider does not match the selected account';
    end if;
  end if;

  if p_destination_id is null then
    select count(*) into v_total from (
      select 1 from public.agent_destinations destination
      where destination.owner=v_owner limit 200
    ) bounded;
    select count(*) into v_persona_total from (
      select 1 from public.agent_destinations destination
      where destination.owner=v_owner and destination.persona_id=p_persona_id limit 50
    ) bounded;
    select count(*) into v_created_day from (
      select 1 from public.agent_destinations destination
      where destination.owner=v_owner and destination.created_at>=now()-interval '24 hours'
      limit 50
    ) bounded;
    if v_total>=200 then raise exception 'Agent destination account limit reached (200)'; end if;
    if v_persona_total>=50 then raise exception 'Agent destination persona limit reached (50)'; end if;
    if v_created_day>=50 then raise exception 'Agent destination daily creation limit reached (50)'; end if;
    perform public.reserve_agent_storage_creations(
      v_owner,'agent_destinations',1,50,v_created_day
    );
  end if;
  select coalesce(sum(
    pg_catalog.octet_length(bounded.destination)
    +pg_catalog.octet_length(pg_catalog.array_to_string(bounded.allowed_content_types,','))
  ),0) into v_stored_bytes from (
    select destination.destination,destination.allowed_content_types
    from public.agent_destinations destination
    where destination.owner=v_owner order by destination.id limit 201
  ) bounded;
  if p_destination_id is not null then
    v_old_bytes:=pg_catalog.octet_length(v_existing.destination)
      +pg_catalog.octet_length(pg_catalog.array_to_string(v_existing.allowed_content_types,','));
  end if;
  v_new_bytes:=pg_catalog.octet_length(v_destination)
    +pg_catalog.octet_length(pg_catalog.array_to_string(v_allowed,','));
  if v_stored_bytes-v_old_bytes+v_new_bytes>262144 and v_new_bytes>=v_old_bytes then
    raise exception 'Agent destination storage limit reached (262144 bytes)';
  end if;

  if p_destination_id is null then
    insert into public.agent_destinations(
      owner,binding_id,persona_id,account_id,destination,mode,enabled,
      allowed_content_types,daily_publish_limit,quiet_hours_start,quiet_hours_end
    ) values (
      v_owner,p_binding_id,p_persona_id,p_account_id,v_destination,p_mode,
      coalesce(p_enabled,false),v_allowed,p_daily_publish_limit,
      p_quiet_hours_start,p_quiet_hours_end
    ) returning id into v_id;
  else
    update public.agent_destinations destination set
      mode=p_mode,enabled=coalesce(p_enabled,false),allowed_content_types=v_allowed,
      daily_publish_limit=p_daily_publish_limit,quiet_hours_start=p_quiet_hours_start,
      quiet_hours_end=p_quiet_hours_end,updated_at=now()
    where destination.id=p_destination_id and destination.owner=v_owner
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_agent_destination(p_destination_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_persona_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_owner_agent_storage(v_owner);
  select destination.persona_id into v_persona_id
  from public.agent_destinations destination
  where destination.id=p_destination_id and destination.owner=v_owner;
  if not found then raise exception 'Owned destination not found'; end if;
  perform public.lock_persona_agent_storage(v_persona_id);
  delete from public.agent_destinations destination
  where destination.id=p_destination_id and destination.owner=v_owner
    and destination.persona_id=v_persona_id;
  if not found then raise exception 'Destination changed; retry the operation'; end if;
  return true;
end;
$$;

create or replace function public.save_persona_content_plan(
  p_persona_id uuid,p_primary_goal text,p_success_metric text,p_audience_focus text,
  p_content_pillars text,p_current_campaign text,p_calls_to_action text,
  p_offers_and_links text,p_affiliate_disclosure text,p_source_notes text,
  p_platform_guidance text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_existing public.persona_content_plans%rowtype;
  v_has_existing boolean;
  v_total integer;v_created_day integer;v_stored_bytes bigint;
  v_old_bytes bigint:=0;v_new_bytes bigint;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.assert_agent_storage_text(p_primary_goal,'Primary goal',768,false);
  perform public.assert_agent_storage_text(p_success_metric,'Success metric',512,false);
  perform public.assert_agent_storage_text(p_audience_focus,'Audience focus',768,false);
  perform public.assert_agent_storage_text(p_content_pillars,'Content pillars',1024,false);
  perform public.assert_agent_storage_text(p_current_campaign,'Current campaign',768,false);
  perform public.assert_agent_storage_text(p_calls_to_action,'Calls to action',768,false);
  perform public.assert_agent_storage_text(p_offers_and_links,'Offers and links',1536,false);
  perform public.assert_agent_storage_text(p_affiliate_disclosure,'Affiliate disclosure',512,false);
  perform public.assert_agent_storage_text(p_source_notes,'Source notes',1536,false);
  perform public.assert_agent_storage_text(p_platform_guidance,'Platform guidance',1024,false);
  v_new_bytes:=pg_catalog.octet_length(coalesce(p_primary_goal,''))
    +pg_catalog.octet_length(coalesce(p_success_metric,''))
    +pg_catalog.octet_length(coalesce(p_audience_focus,''))
    +pg_catalog.octet_length(coalesce(p_content_pillars,''))
    +pg_catalog.octet_length(coalesce(p_current_campaign,''))
    +pg_catalog.octet_length(coalesce(p_calls_to_action,''))
    +pg_catalog.octet_length(coalesce(p_offers_and_links,''))
    +pg_catalog.octet_length(coalesce(p_affiliate_disclosure,''))
    +pg_catalog.octet_length(coalesce(p_source_notes,''))
    +pg_catalog.octet_length(coalesce(p_platform_guidance,''));

  perform public.lock_owner_agent_storage(v_owner);
  perform public.lock_persona_agent_storage(p_persona_id);
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner for share) then
    raise exception 'Owned persona not found';
  end if;
  select * into v_existing from public.persona_content_plans plan
  where plan.persona_id=p_persona_id and plan.owner=v_owner for update;
  v_has_existing:=found;
  select count(*) into v_created_day from (
    select 1 from public.agent_actions action
    where action.owner=v_owner and action.action_type='direction.updated'
      and action.entity_type='content_plan'
      and action.created_at>=now()-interval '24 hours'
    limit 50
  ) bounded;
  perform public.reserve_agent_storage_creations(
    v_owner,'persona_content_plan_mutations',1,50,v_created_day
  );
  if v_has_existing then
    v_old_bytes:=pg_catalog.octet_length(v_existing.primary_goal)
      +pg_catalog.octet_length(v_existing.success_metric)
      +pg_catalog.octet_length(v_existing.audience_focus)
      +pg_catalog.octet_length(v_existing.content_pillars)
      +pg_catalog.octet_length(v_existing.current_campaign)
      +pg_catalog.octet_length(v_existing.calls_to_action)
      +pg_catalog.octet_length(v_existing.offers_and_links)
      +pg_catalog.octet_length(v_existing.affiliate_disclosure)
      +pg_catalog.octet_length(v_existing.source_notes)
      +pg_catalog.octet_length(v_existing.platform_guidance);
  else
    select count(*) into v_total from (
      select 1 from public.persona_content_plans plan where plan.owner=v_owner limit 250
    ) bounded;
    if v_total>=250 then raise exception 'Content plan account limit reached (250)'; end if;
  end if;
  select coalesce(sum(
    pg_catalog.octet_length(bounded.primary_goal)
    +pg_catalog.octet_length(bounded.success_metric)
    +pg_catalog.octet_length(bounded.audience_focus)
    +pg_catalog.octet_length(bounded.content_pillars)
    +pg_catalog.octet_length(bounded.current_campaign)
    +pg_catalog.octet_length(bounded.calls_to_action)
    +pg_catalog.octet_length(bounded.offers_and_links)
    +pg_catalog.octet_length(bounded.affiliate_disclosure)
    +pg_catalog.octet_length(bounded.source_notes)
    +pg_catalog.octet_length(bounded.platform_guidance)
  ),0) into v_stored_bytes from (
    select * from public.persona_content_plans plan
    where plan.owner=v_owner order by plan.persona_id limit 251
  ) bounded;
  if v_stored_bytes-v_old_bytes+v_new_bytes>2097152 and v_new_bytes>=v_old_bytes then
    raise exception 'Content plan storage limit reached (2097152 bytes)';
  end if;
  insert into public.persona_content_plans(
    owner,persona_id,primary_goal,success_metric,audience_focus,content_pillars,
    current_campaign,calls_to_action,offers_and_links,affiliate_disclosure,
    source_notes,platform_guidance
  ) values (
    v_owner,p_persona_id,coalesce(p_primary_goal,''),coalesce(p_success_metric,''),
    coalesce(p_audience_focus,''),coalesce(p_content_pillars,''),
    coalesce(p_current_campaign,''),coalesce(p_calls_to_action,''),
    coalesce(p_offers_and_links,''),coalesce(p_affiliate_disclosure,''),
    coalesce(p_source_notes,''),coalesce(p_platform_guidance,'')
  ) on conflict(persona_id) do update set
    primary_goal=excluded.primary_goal,success_metric=excluded.success_metric,
    audience_focus=excluded.audience_focus,content_pillars=excluded.content_pillars,
    current_campaign=excluded.current_campaign,calls_to_action=excluded.calls_to_action,
    offers_and_links=excluded.offers_and_links,
    affiliate_disclosure=excluded.affiliate_disclosure,
    source_notes=excluded.source_notes,platform_guidance=excluded.platform_guidance,
    updated_at=now()
  where persona_content_plans.owner=v_owner;
  return true;
end;
$$;

create or replace function public.delete_persona_content_plan(p_persona_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_owner_agent_storage(v_owner);
  perform public.lock_persona_agent_storage(p_persona_id);
  delete from public.persona_content_plans plan
  where plan.persona_id=p_persona_id and plan.owner=v_owner;
  return found;
end;
$$;

create or replace function public.save_ai_task_definition(
  p_task_id uuid,p_persona_id uuid,p_backend_id uuid,p_name text,p_task_type text,
  p_instructions text,p_cadence text,p_active boolean,p_destination text,
  p_account_id uuid,p_content_kind text,p_schedule_day smallint,p_schedule_time time,
  p_timezone text,p_lead_minutes integer,p_approval_required boolean
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_existing public.ai_tasks%rowtype;
  v_old_persona_id uuid;
  v_lock_persona_id uuid;
  v_account_provider text;
  v_account_persona_id uuid;
  v_destination text;
  v_name text:=btrim(coalesce(p_name,''));
  v_task_type text:=lower(btrim(coalesce(p_task_type,'')));
  v_cadence text:=lower(btrim(coalesce(p_cadence,'')));
  v_content_kind text:=lower(btrim(coalesce(p_content_kind,'')));
  v_timezone text:=btrim(coalesce(p_timezone,''));
  v_id uuid;
  v_total integer;v_persona_total integer;v_created_day integer;
  v_stored_bytes bigint;v_old_bytes bigint:=0;v_new_bytes bigint;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_persona_id is null then raise exception 'Task persona is required'; end if;
  perform public.assert_agent_storage_text(v_name,'Task name',256,true);
  perform public.assert_agent_storage_text(p_instructions,'Task instructions',4096,false);
  perform public.assert_agent_storage_text(v_task_type,'Task type',32,true);
  perform public.assert_agent_storage_text(v_cadence,'Task cadence',16,true);
  perform public.assert_agent_storage_text(v_content_kind,'Task content kind',16,true);
  perform public.assert_agent_storage_text(v_timezone,'Task time zone',64,true);
  if v_task_type not in (
    'newsplan','original','repost','article','reel','image','newsletter','promo','custom'
  ) then raise exception 'Unsupported task type'; end if;
  if v_cadence not in ('manual','daily','weekly') then raise exception 'Unsupported task cadence'; end if;
  if v_content_kind not in ('post','reel','article','image','newsletter','promo') then
    raise exception 'Unsupported task content kind';
  end if;
  if p_schedule_time is null then raise exception 'Task schedule time is required'; end if;
  if v_cadence='weekly' and (
    p_schedule_day is null or p_schedule_day not between 0 and 6
  ) then
    raise exception 'Weekly tasks require a schedule day from 0 through 6';
  end if;
  if v_cadence<>'weekly' and p_schedule_day is not null then
    raise exception 'Only weekly tasks may set a schedule day';
  end if;
  if p_lead_minutes is null or p_lead_minutes not between 0 and 10080 then
    raise exception 'Invalid task lead time';
  end if;
  if p_approval_required is distinct from true then
    raise exception 'Owner approval is mandatory for every task';
  end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names zone where zone.name=v_timezone) then
    raise exception 'Choose a valid IANA time zone';
  end if;
  v_destination:=public.normalize_agent_destination(public.assert_agent_storage_text(
    p_destination,'Task destination',128,true
  ));
  if pg_catalog.octet_length(v_destination)>128
     or v_destination!~'^[a-z0-9][a-z0-9._-]{0,127}$' then
    raise exception 'Task destination must be a normalized provider key';
  end if;
  v_new_bytes:=pg_catalog.octet_length(v_name)
    +pg_catalog.octet_length(coalesce(p_instructions,''))
    +pg_catalog.octet_length(v_task_type)+pg_catalog.octet_length(v_cadence)
    +pg_catalog.octet_length(v_content_kind)+pg_catalog.octet_length(v_timezone)
    +pg_catalog.octet_length(v_destination);

  perform public.lock_owner_agent_storage(v_owner);
  if p_task_id is not null then
    select task.persona_id into v_old_persona_id from public.ai_tasks task
    where task.id=p_task_id and task.owner=v_owner;
    if not found then raise exception 'Owned task not found'; end if;
  end if;
  for v_lock_persona_id in
    select distinct candidate.persona_id
    from pg_catalog.unnest(array[v_old_persona_id,p_persona_id]) candidate(persona_id)
    where candidate.persona_id is not null order by candidate.persona_id
  loop
    perform public.lock_persona_agent_storage(v_lock_persona_id);
  end loop;
  if p_task_id is not null then
    select * into v_existing from public.ai_tasks task
    where task.id=p_task_id and task.owner=v_owner for update;
    if not found or v_existing.persona_id is distinct from v_old_persona_id then
      raise exception 'Task changed; retry the operation';
    end if;
  end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner for share) then
    raise exception 'Owned persona not found';
  end if;
  if not exists(select 1 from public.agent_bindings binding
    where binding.persona_id=p_persona_id and binding.owner=v_owner for share) then
    raise exception 'Owned persona binding not found';
  end if;
  if p_backend_id is not null and not exists(select 1 from public.ai_backends backend
    where backend.id=p_backend_id and backend.owner=v_owner for share) then
    raise exception 'Owned AI backend not found';
  end if;
  if p_account_id is null then
    if v_destination not in ('aliaspaces','aliaspaces.com','mypersonas','mypersonas.online') then
      raise exception 'Tasks without an account must target the native feed';
    end if;
  else
    select account.provider,account.persona_id into v_account_provider,v_account_persona_id
    from public.account_ledger account
    where account.id=p_account_id and account.owner=v_owner for share;
    if not found or v_account_persona_id is distinct from p_persona_id then
      raise exception 'Task account must be assigned to the owned persona';
    end if;
    if public.normalize_agent_destination(v_account_provider) is distinct from v_destination then
      raise exception 'Task destination does not match the selected account';
    end if;
  end if;
  if not exists(
    select 1 from public.agent_bindings binding
    join public.agent_destinations destination
      on destination.binding_id=binding.id and destination.owner=binding.owner
      and destination.persona_id=binding.persona_id
    where binding.owner=v_owner and binding.persona_id=p_persona_id
      and destination.enabled
      and destination.account_id is not distinct from p_account_id
      and public.normalize_agent_destination(destination.destination)=v_destination
      and v_content_kind=any(destination.allowed_content_types)
  ) then raise exception 'Save an enabled matching destination policy first'; end if;

  if p_task_id is null then
    select count(*) into v_total from (
      select 1 from public.ai_tasks task where task.owner=v_owner limit 500
    ) bounded;
    select count(*) into v_created_day from (
      select 1 from public.ai_tasks task
      where task.owner=v_owner and task.created_at>=now()-interval '24 hours' limit 100
    ) bounded;
    if v_total>=500 then raise exception 'AI task account limit reached (500)'; end if;
    if v_created_day>=100 then raise exception 'AI task daily creation limit reached (100)'; end if;
    perform public.reserve_agent_storage_creations(
      v_owner,'ai_tasks',1,100,v_created_day
    );
  end if;
  if p_task_id is null or v_old_persona_id is distinct from p_persona_id then
    select count(*) into v_persona_total from (
      select 1 from public.ai_tasks task
      where task.owner=v_owner and task.persona_id=p_persona_id
        and (p_task_id is null or task.id<>p_task_id) limit 100
    ) bounded;
    if v_persona_total>=100 then raise exception 'AI task persona limit reached (100)'; end if;
  end if;
  select coalesce(sum(
    pg_catalog.octet_length(bounded.name)
    +pg_catalog.octet_length(coalesce(bounded.instructions,''))
    +pg_catalog.octet_length(coalesce(bounded.task_type,''))
    +pg_catalog.octet_length(coalesce(bounded.cadence,''))
    +pg_catalog.octet_length(coalesce(bounded.content_kind,''))
    +pg_catalog.octet_length(coalesce(bounded.timezone,''))
    +pg_catalog.octet_length(coalesce(bounded.destination,''))
  ),0) into v_stored_bytes from (
    select task.name,task.instructions,task.task_type,task.cadence,
      task.content_kind,task.timezone,task.destination
    from public.ai_tasks task where task.owner=v_owner order by task.id limit 501
  ) bounded;
  if p_task_id is not null then
    v_old_bytes:=pg_catalog.octet_length(v_existing.name)
      +pg_catalog.octet_length(coalesce(v_existing.instructions,''))
      +pg_catalog.octet_length(coalesce(v_existing.task_type,''))
      +pg_catalog.octet_length(coalesce(v_existing.cadence,''))
      +pg_catalog.octet_length(coalesce(v_existing.content_kind,''))
      +pg_catalog.octet_length(coalesce(v_existing.timezone,''))
      +pg_catalog.octet_length(coalesce(v_existing.destination,''));
  end if;
  if v_stored_bytes-v_old_bytes+v_new_bytes>2097152 and v_new_bytes>=v_old_bytes then
    raise exception 'AI task storage limit reached (2097152 bytes)';
  end if;

  if p_task_id is null then
    insert into public.ai_tasks(
      owner,persona_id,backend_id,name,task_type,instructions,cadence,active,
      destination,account_id,content_kind,schedule_day,schedule_time,timezone,
      lead_minutes,approval_required
    ) values (
      v_owner,p_persona_id,p_backend_id,v_name,v_task_type,coalesce(p_instructions,''),
      v_cadence,coalesce(p_active,false),v_destination,p_account_id,v_content_kind,
      p_schedule_day,p_schedule_time,v_timezone,p_lead_minutes,true
    ) returning id into v_id;
  else
    update public.ai_tasks task set
      persona_id=p_persona_id,backend_id=p_backend_id,name=v_name,task_type=v_task_type,
      instructions=coalesce(p_instructions,''),cadence=v_cadence,
      active=coalesce(p_active,false),destination=v_destination,account_id=p_account_id,
      content_kind=v_content_kind,schedule_day=p_schedule_day,
      schedule_time=p_schedule_time,timezone=v_timezone,lead_minutes=p_lead_minutes,
      approval_required=true,updated_at=now()
    where task.id=p_task_id and task.owner=v_owner returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_ai_task_definition(p_task_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_persona_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_owner_agent_storage(v_owner);
  select task.persona_id into v_persona_id from public.ai_tasks task
  where task.id=p_task_id and task.owner=v_owner;
  if not found then raise exception 'Owned task not found'; end if;
  if v_persona_id is not null then perform public.lock_persona_agent_storage(v_persona_id); end if;
  delete from public.ai_tasks task
  where task.id=p_task_id and task.owner=v_owner
    and task.persona_id is not distinct from v_persona_id;
  if not found then raise exception 'Task changed; retry the operation'; end if;
  return true;
end;
$$;

create or replace function public.save_owner_draft(
  p_draft_id uuid,p_persona_id uuid,p_account_id uuid,p_platform text,
  p_content_kind text,p_title text,p_body text,p_tags text,p_media_url text,
  p_publish_at timestamptz
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_existing public.drafts%rowtype;
  v_old_persona_id uuid;
  v_lock_persona_id uuid;
  v_account_provider text;
  v_account_persona_id uuid;
  v_platform text;
  v_content_kind text:=lower(btrim(coalesce(p_content_kind,'')));
  v_id uuid;
  v_total integer;v_persona_total integer;v_created_day integer;
  v_stored_bytes bigint;v_old_bytes bigint:=0;v_new_bytes bigint;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_persona_id is null then raise exception 'Draft persona is required'; end if;
  perform public.assert_agent_storage_text(p_title,'Draft title',1000,false);
  perform public.assert_agent_storage_text(p_body,'Draft body',30000,false);
  perform public.assert_agent_storage_text(p_tags,'Draft tags',4000,false);
  perform public.assert_agent_storage_text(p_media_url,'Draft media URL',2048,false);
  perform public.assert_agent_storage_text(v_content_kind,'Draft content kind',16,true);
  if coalesce(p_title,'')='' and coalesce(p_body,'')='' and coalesce(p_media_url,'')='' then
    raise exception 'Draft content is empty';
  end if;
  if v_content_kind not in ('post','reel','article','image','newsletter','promo') then
    raise exception 'Unsupported draft content kind';
  end if;
  if not public.is_safe_credential_free_https_url(coalesce(p_media_url,''),true) then
    raise exception 'Draft media requires a credential-free HTTPS URL';
  end if;
  if p_publish_at is not null and (
    p_publish_at<now()-interval '1 day' or p_publish_at>now()+interval '2 years'
  ) then raise exception 'Draft publish time is outside the allowed window'; end if;
  v_platform:=public.normalize_agent_destination(public.assert_agent_storage_text(
    p_platform,'Draft platform',128,true
  ));
  if pg_catalog.octet_length(v_platform)>128
     or v_platform!~'^[a-z0-9][a-z0-9._-]{0,127}$' then
    raise exception 'Draft platform must be a normalized provider key';
  end if;
  v_new_bytes:=pg_catalog.octet_length(coalesce(p_title,''))
    +pg_catalog.octet_length(coalesce(p_body,''))
    +pg_catalog.octet_length(coalesce(p_tags,''))
    +pg_catalog.octet_length(coalesce(p_media_url,''))
    +pg_catalog.octet_length(v_platform)+pg_catalog.octet_length(v_content_kind);

  perform public.lock_owner_agent_storage(v_owner);
  if p_draft_id is not null then
    select draft.persona_id into v_old_persona_id from public.drafts draft
    where draft.id=p_draft_id and draft.owner=v_owner;
    if not found then raise exception 'Owned draft not found'; end if;
  end if;
  for v_lock_persona_id in
    select distinct candidate.persona_id
    from pg_catalog.unnest(array[v_old_persona_id,p_persona_id]) candidate(persona_id)
    where candidate.persona_id is not null order by candidate.persona_id
  loop
    perform public.lock_persona_agent_storage(v_lock_persona_id);
  end loop;
  if p_draft_id is not null then
    select * into v_existing from public.drafts draft
    where draft.id=p_draft_id and draft.owner=v_owner for update;
    if not found or v_existing.persona_id is distinct from v_old_persona_id then
      raise exception 'Draft changed; retry the operation';
    end if;
    if v_existing.publish_state in ('publishing','published')
       or coalesce(v_existing.provider_post_id,'')<>'' then
      raise exception 'Published, publishing, or staged drafts require reconciliation';
    end if;
  end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner for share) then
    raise exception 'Owned persona not found';
  end if;
  if p_account_id is not null then
    select account.provider,account.persona_id into v_account_provider,v_account_persona_id
    from public.account_ledger account
    where account.id=p_account_id and account.owner=v_owner for share;
    if not found or v_account_persona_id is distinct from p_persona_id then
      raise exception 'Draft account must be assigned to the owned persona';
    end if;
    if public.normalize_agent_destination(v_account_provider) is distinct from v_platform then
      raise exception 'Draft platform does not match the selected account';
    end if;
  end if;

  if p_draft_id is null then
    select count(*) into v_total from (
      select 1 from public.drafts draft where draft.owner=v_owner limit 5000
    ) bounded;
    select count(*) into v_created_day from (
      select 1 from public.drafts draft
      where draft.owner=v_owner and draft.created_at>=now()-interval '24 hours' limit 200
    ) bounded;
    if v_total>=5000 then raise exception 'Draft account limit reached (5000)'; end if;
    if v_created_day>=200 then raise exception 'Draft daily creation limit reached (200)'; end if;
    perform public.reserve_agent_storage_creations(
      v_owner,'drafts',1,200,v_created_day
    );
  end if;
  if p_draft_id is null or v_old_persona_id is distinct from p_persona_id then
    select count(*) into v_persona_total from (
      select 1 from public.drafts draft
      where draft.owner=v_owner and draft.persona_id=p_persona_id
        and (p_draft_id is null or draft.id<>p_draft_id) limit 1000
    ) bounded;
    if v_persona_total>=1000 then raise exception 'Draft persona limit reached (1000)'; end if;
  end if;
  select coalesce(sum(
    pg_catalog.octet_length(coalesce(bounded.title,''))
    +pg_catalog.octet_length(coalesce(bounded.body,''))
    +pg_catalog.octet_length(coalesce(bounded.tags,''))
    +pg_catalog.octet_length(coalesce(bounded.media_url,''))
    +pg_catalog.octet_length(coalesce(bounded.platform,''))
    +pg_catalog.octet_length(coalesce(bounded.content_kind,''))
  ),0) into v_stored_bytes from (
    select draft.title,draft.body,draft.tags,draft.media_url,draft.platform,draft.content_kind
    from public.drafts draft where draft.owner=v_owner order by draft.id limit 5001
  ) bounded;
  if p_draft_id is not null then
    v_old_bytes:=pg_catalog.octet_length(coalesce(v_existing.title,''))
      +pg_catalog.octet_length(coalesce(v_existing.body,''))
      +pg_catalog.octet_length(coalesce(v_existing.tags,''))
      +pg_catalog.octet_length(coalesce(v_existing.media_url,''))
      +pg_catalog.octet_length(coalesce(v_existing.platform,''))
      +pg_catalog.octet_length(coalesce(v_existing.content_kind,''));
  end if;
  if v_stored_bytes-v_old_bytes+v_new_bytes>67108864 and v_new_bytes>=v_old_bytes then
    raise exception 'Draft storage limit reached (67108864 bytes)';
  end if;

  if p_draft_id is null then
    insert into public.drafts(
      owner,persona_id,account_id,platform,content_kind,title,body,tags,media_url,
      publish_at,status,generated_by_agent
    ) values (
      v_owner,p_persona_id,p_account_id,v_platform,v_content_kind,
      coalesce(p_title,''),coalesce(p_body,''),coalesce(p_tags,''),
      coalesce(p_media_url,''),p_publish_at,'idea',false
    ) returning id into v_id;
  else
    update public.drafts draft set
      persona_id=p_persona_id,account_id=p_account_id,platform=v_platform,
      content_kind=v_content_kind,title=coalesce(p_title,''),body=coalesce(p_body,''),
      tags=coalesce(p_tags,''),media_url=coalesce(p_media_url,''),
      publish_at=p_publish_at,updated_at=now()
    where draft.id=p_draft_id and draft.owner=v_owner returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.append_agent_messages(p_messages jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_item jsonb;
  v_existing public.agent_messages%rowtype;
  v_persona_id uuid;
  v_workspace_id uuid;
  v_workspace_persona_id uuid;
  v_workspace_conversation text;
  v_client_message_id uuid;
  v_role text;
  v_content text;
  v_conversation text;
  v_persona_ids uuid[]:='{}'::uuid[];
  v_client_ids uuid[]:='{}'::uuid[];
  v_conversations text[]:='{}'::text[];
  v_lock_persona_id uuid;
  v_lock_conversation text;
  v_has_unscoped boolean:=false;
  v_new_count integer:=0;
  v_duplicate_count integer:=0;
  v_batch_count integer;
  v_total integer;
  v_daily integer;
  v_scoped_total integer;
  v_stored_bytes bigint;
  v_new_bytes bigint:=0;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_messages is null or pg_catalog.jsonb_typeof(p_messages)<>'array'
     or pg_catalog.jsonb_array_length(p_messages) not between 1 and 50 then
    raise exception 'Message batch must contain between one and 50 rows';
  end if;
  perform public.lock_owner_agent_storage(v_owner);

  for v_item in select item.value from pg_catalog.jsonb_array_elements(p_messages) item(value)
  loop
    if pg_catalog.jsonb_typeof(v_item)<>'object' or exists(
      select 1 from pg_catalog.jsonb_object_keys(v_item) keys(key_name)
      where keys.key_name not in (
        'persona_id','workspace_id','conversation_key','client_message_id','role','content'
      )
    ) then raise exception 'Message rows contain unsupported fields'; end if;
    if coalesce(v_item->>'client_message_id','')!~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
      raise exception 'A valid client message id is required';
    end if;
    v_client_message_id:=(v_item->>'client_message_id')::uuid;
    if v_client_message_id=any(v_client_ids) then
      raise exception 'Message batch contains a duplicate client message id';
    end if;
    v_client_ids:=pg_catalog.array_append(v_client_ids,v_client_message_id);

    v_persona_id:=null;
    if nullif(v_item->>'persona_id','') is not null then
      if (v_item->>'persona_id')!~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
        raise exception 'Invalid message persona id';
      end if;
      v_persona_id:=(v_item->>'persona_id')::uuid;
      if not v_persona_id=any(v_persona_ids) then
        v_persona_ids:=pg_catalog.array_append(v_persona_ids,v_persona_id);
      end if;
    else
      v_has_unscoped:=true;
    end if;
    v_workspace_id:=null;
    if nullif(v_item->>'workspace_id','') is not null then
      if (v_item->>'workspace_id')!~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
        raise exception 'Invalid message workspace id';
      end if;
      v_workspace_id:=(v_item->>'workspace_id')::uuid;
      if v_persona_id is null then raise exception 'Workspace messages require a persona'; end if;
    end if;
    v_conversation:=public.assert_agent_storage_text(
      v_item->>'conversation_key','Conversation key',200,true
    );
    if v_conversation!~'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$' then
      raise exception 'Conversation key contains unsupported characters';
    end if;
    if not v_conversation=any(v_conversations) then
      v_conversations:=pg_catalog.array_append(v_conversations,v_conversation);
    end if;
    v_role:=lower(btrim(coalesce(v_item->>'role','')));
    if v_role not in ('user','assistant') then
      raise exception 'Browser chat messages must use user or assistant role';
    end if;
    v_content:=public.assert_agent_storage_text(v_item->>'content','Message content',20000,true);
  end loop;

  for v_lock_persona_id in
    select candidate.persona_id from pg_catalog.unnest(v_persona_ids) candidate(persona_id)
    order by candidate.persona_id
  loop
    perform public.lock_persona_agent_storage(v_lock_persona_id);
    if not exists(select 1 from public.personas persona
      where persona.id=v_lock_persona_id and persona.owner=v_owner for share) then
      raise exception 'Owned message persona not found';
    end if;
  end loop;

  for v_item in select item.value from pg_catalog.jsonb_array_elements(p_messages) item(value)
  loop
    v_client_message_id:=(v_item->>'client_message_id')::uuid;
    v_persona_id:=nullif(v_item->>'persona_id','')::uuid;
    v_workspace_id:=nullif(v_item->>'workspace_id','')::uuid;
    v_conversation:=v_item->>'conversation_key';
    v_role:=lower(btrim(v_item->>'role'));
    v_content:=v_item->>'content';
    if v_workspace_id is not null then
      select workspace.persona_id,workspace.conversation_key
      into v_workspace_persona_id,v_workspace_conversation
      from public.chat_workspaces workspace
      where workspace.id=v_workspace_id and workspace.owner=v_owner for share;
      if not found or v_workspace_persona_id is distinct from v_persona_id
         or v_workspace_conversation is distinct from v_conversation then
        raise exception 'Owned message workspace does not match its persona and conversation';
      end if;
    end if;
    select * into v_existing from public.agent_messages message
    where message.owner=v_owner and message.client_message_id=v_client_message_id;
    if found then
      if row(v_existing.persona_id,v_existing.workspace_id,v_existing.conversation_key,
             v_existing.role,v_existing.content)
         is distinct from row(v_persona_id,v_workspace_id,v_conversation,v_role,v_content) then
        raise exception 'Client message id is already bound to different content';
      end if;
      v_duplicate_count:=v_duplicate_count+1;
    else
      v_new_count:=v_new_count+1;
      v_new_bytes:=v_new_bytes+pg_catalog.octet_length(v_conversation)
        +pg_catalog.octet_length(v_role)+pg_catalog.octet_length(v_content);
    end if;
  end loop;

  select count(*),coalesce(sum(
    pg_catalog.octet_length(bounded.conversation_key)
    +pg_catalog.octet_length(bounded.role)+pg_catalog.octet_length(bounded.content)
  ),0) into v_total,v_stored_bytes from (
    select message.conversation_key,message.role,message.content
    from public.agent_messages message
    where message.owner=v_owner order by message.id limit 20001
  ) bounded;
  select count(*) into v_daily from (
    select 1 from public.agent_messages message
    where message.owner=v_owner and message.created_at>=now()-interval '24 hours'
    limit 2000
  ) bounded;
  if v_total+v_new_count>20000 then raise exception 'Agent message account limit reached (20000)'; end if;
  if v_daily+v_new_count>2000 then raise exception 'Agent message daily creation limit reached (2000)'; end if;
  if v_stored_bytes+v_new_bytes>67108864 then
    raise exception 'Agent message storage limit reached (67108864 bytes)';
  end if;

  for v_lock_persona_id in
    select candidate.persona_id from pg_catalog.unnest(v_persona_ids) candidate(persona_id)
    order by candidate.persona_id
  loop
    select count(*) into v_scoped_total from (
      select 1 from public.agent_messages message
      where message.owner=v_owner and message.persona_id=v_lock_persona_id limit 5000
    ) bounded;
    select count(*) into v_batch_count
    from pg_catalog.jsonb_array_elements(p_messages) item(value)
    where item.value->>'persona_id'=v_lock_persona_id::text
      and not exists(
        select 1 from public.agent_messages message
        where message.owner=v_owner
          and message.client_message_id=(item.value->>'client_message_id')::uuid
      );
    if v_scoped_total+v_batch_count>5000 then
      raise exception 'Agent message persona limit reached (5000)';
    end if;
  end loop;
  if v_has_unscoped then
    select count(*) into v_scoped_total from (
      select 1 from public.agent_messages message
      where message.owner=v_owner and message.persona_id is null limit 2000
    ) bounded;
    select count(*) into v_batch_count
    from pg_catalog.jsonb_array_elements(p_messages) item(value)
    where nullif(item.value->>'persona_id','') is null
      and not exists(
        select 1 from public.agent_messages message
        where message.owner=v_owner
          and message.client_message_id=(item.value->>'client_message_id')::uuid
      );
    if v_scoped_total+v_batch_count>2000 then
      raise exception 'Unscoped agent message limit reached (2000)';
    end if;
  end if;
  for v_lock_conversation in
    select candidate.conversation from pg_catalog.unnest(v_conversations) candidate(conversation)
    order by candidate.conversation
  loop
    select count(*) into v_scoped_total from (
      select 1 from public.agent_messages message
      where message.owner=v_owner and message.conversation_key=v_lock_conversation limit 500
    ) bounded;
    select count(*) into v_batch_count
    from pg_catalog.jsonb_array_elements(p_messages) item(value)
    where item.value->>'conversation_key'=v_lock_conversation
      and not exists(
        select 1 from public.agent_messages message
        where message.owner=v_owner
          and message.client_message_id=(item.value->>'client_message_id')::uuid
      );
    if v_scoped_total+v_batch_count>500 then
      raise exception 'Agent message conversation limit reached (500)';
    end if;
  end loop;

  if v_new_count>0 then
    perform public.reserve_agent_storage_creations(
      v_owner,'agent_messages',v_new_count,2000,v_daily
    );
  end if;

  for v_item in select item.value from pg_catalog.jsonb_array_elements(p_messages) item(value)
  loop
    insert into public.agent_messages(
      owner,persona_id,workspace_id,conversation_key,client_message_id,role,content,created_at
    ) values (
      v_owner,nullif(v_item->>'persona_id','')::uuid,
      nullif(v_item->>'workspace_id','')::uuid,v_item->>'conversation_key',
      (v_item->>'client_message_id')::uuid,lower(btrim(v_item->>'role')),
      v_item->>'content',now()
    ) on conflict(owner,client_message_id) do nothing;
  end loop;
  return pg_catalog.jsonb_build_object(
    'inserted',v_new_count,'duplicates',v_duplicate_count,'accepted',true
  );
end;
$$;

create or replace function public.delete_agent_message_history(
  p_persona_id uuid,p_workspace_id uuid,p_conversation_key text
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_persona_id uuid:=p_persona_id;
  v_conversation text;
  v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if (p_workspace_id is null)=(nullif(p_conversation_key,'') is null) then
    raise exception 'Choose exactly one workspace or conversation to clear';
  end if;
  perform public.lock_owner_agent_storage(v_owner);
  if p_workspace_id is not null then
    select workspace.persona_id,workspace.conversation_key
    into v_persona_id,v_conversation from public.chat_workspaces workspace
    where workspace.id=p_workspace_id and workspace.owner=v_owner for share;
    if not found or (p_persona_id is not null and p_persona_id is distinct from v_persona_id) then
      raise exception 'Owned workspace not found';
    end if;
  else
    v_conversation:=public.assert_agent_storage_text(
      p_conversation_key,'Conversation key',200,true
    );
    if v_conversation!~'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$' then
      raise exception 'Conversation key contains unsupported characters';
    end if;
  end if;
  if v_persona_id is not null then
    perform public.lock_persona_agent_storage(v_persona_id);
    if not exists(select 1 from public.personas persona
      where persona.id=v_persona_id and persona.owner=v_owner for share) then
      raise exception 'Owned message persona not found';
    end if;
  end if;
  if p_workspace_id is not null then
    delete from public.agent_messages message
    where message.owner=v_owner and message.workspace_id=p_workspace_id
      and message.persona_id is not distinct from v_persona_id;
  else
    delete from public.agent_messages message
    where message.owner=v_owner and message.conversation_key=v_conversation
      and message.persona_id is not distinct from v_persona_id
      and message.workspace_id is null;
  end if;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

-- Remove the broad and column-level grants inherited from migrations 002/011.
-- SELECT remains available for owner RLS, export, and ordinary UI reads.
revoke insert,update,delete on public.agent_destinations,
  public.persona_content_plans,public.ai_tasks,public.drafts,public.agent_messages
  from public,anon,authenticated;
revoke insert(
  owner,persona_id,backend_id,name,task_type,instructions,cadence,active,
  destination,account_id,content_kind,schedule_day,schedule_time,timezone,
  lead_minutes,approval_required
) on public.ai_tasks from public,anon,authenticated;
revoke update(
  persona_id,backend_id,name,task_type,instructions,cadence,active,destination,
  account_id,content_kind,schedule_day,schedule_time,timezone,lead_minutes,
  approval_required
) on public.ai_tasks from public,anon,authenticated;
revoke insert(
  owner,persona_id,platform,title,body,tags,media_url,status,scheduled_for,
  account_id,content_kind,publish_at
) on public.drafts from public,anon,authenticated;
revoke update(
  persona_id,platform,title,body,tags,media_url,status,scheduled_for,
  account_id,content_kind,publish_at
) on public.drafts from public,anon,authenticated;
grant select on public.agent_destinations,public.persona_content_plans,
  public.ai_tasks,public.drafts,public.agent_messages to authenticated;

revoke all on function public.save_agent_destination(
  uuid,uuid,uuid,uuid,text,text,boolean,text[],integer,time,time
),public.delete_agent_destination(uuid),public.save_persona_content_plan(
  uuid,text,text,text,text,text,text,text,text,text,text
),public.delete_persona_content_plan(uuid),public.save_ai_task_definition(
  uuid,uuid,uuid,text,text,text,text,boolean,text,uuid,text,smallint,time,text,integer,boolean
),public.delete_ai_task_definition(uuid),public.save_owner_draft(
  uuid,uuid,uuid,text,text,text,text,text,text,timestamptz
),public.append_agent_messages(jsonb),public.delete_agent_message_history(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.save_agent_destination(
  uuid,uuid,uuid,uuid,text,text,boolean,text[],integer,time,time
),public.delete_agent_destination(uuid),public.save_persona_content_plan(
  uuid,text,text,text,text,text,text,text,text,text,text
),public.delete_persona_content_plan(uuid),public.save_ai_task_definition(
  uuid,uuid,uuid,text,text,text,text,boolean,text,uuid,text,smallint,time,text,integer,boolean
),public.delete_ai_task_definition(uuid),public.save_owner_draft(
  uuid,uuid,uuid,text,text,text,text,text,text,timestamptz
),public.append_agent_messages(jsonb),public.delete_agent_message_history(uuid,uuid,text)
  to authenticated;

-- End inherited 011 owner storage hardening.

-- ---------------------------------------------------------------------------
-- RPC grants
-- ---------------------------------------------------------------------------

revoke all on function public.persona_publication_review_manifest(uuid),
  public.persona_publication_readiness(uuid),
  public.save_persona_review_draft(uuid,text,text,text),
  public.submit_persona_for_review(uuid,text,text,text), public.publish_persona_page(uuid),
  public.unpublish_persona_page(uuid), public.create_feature_request_draft(uuid,text,text,text,jsonb),
  public.submit_feature_request(uuid), public.withdraw_feature_request(uuid),
  public.delete_feature_request(uuid), public.staff_update_feature_request(uuid,text,text,uuid,text),
  public.save_business_draft(uuid,text,text,text,text),
  public.set_business_persona_membership_draft(uuid,uuid,text,text,boolean,text,text,integer,boolean),
  public.save_business_mission_item_draft(uuid,uuid,text,text,integer,boolean,text),
  public.stage_native_agent_draft_for_review(uuid), public.report_client_error(text,jsonb),
  public.follow_persona(uuid,uuid,text), public.unfollow_persona(uuid,uuid),
  public.remove_persona_friendship(uuid,uuid),
  public.remove_persona_social_relationships(uuid), public.set_persona_visibility_rule(uuid,text,boolean),
  public.set_persona_friend_policy(uuid,text,integer,integer,text),
  public.issue_persona_friend_invite(uuid,text,integer,timestamptz),
  public.revoke_persona_friend_invites(uuid),
  public.request_persona_friendship(uuid,uuid,text), public.respond_persona_friendship(uuid,boolean),
  public.set_persona_account_sync(uuid,uuid,boolean,text,text[],boolean,boolean,text),
  public.create_extension_submission(uuid,text,text,text,text[]), public.submit_extension_for_review(uuid),
  public.withdraw_extension_submission(uuid),public.delete_extension_submission(uuid),
  public.staff_update_extension_submission(uuid,text,text),
  public.my_friend_request_security_events(timestamptz,bigint,integer),
  public.my_platform_security_events(timestamptz,bigint,integer),
  public.my_account_network_blocks(timestamptz,text,integer)
  from public, anon;

grant execute on function public.persona_publication_review_manifest(uuid),
  public.persona_publication_readiness(uuid),
  public.save_persona_review_draft(uuid,text,text,text),
  public.submit_persona_for_review(uuid,text,text,text), public.publish_persona_page(uuid),
  public.unpublish_persona_page(uuid), public.create_feature_request_draft(uuid,text,text,text,jsonb),
  public.submit_feature_request(uuid), public.withdraw_feature_request(uuid),
  public.delete_feature_request(uuid), public.staff_update_feature_request(uuid,text,text,uuid,text),
  public.save_business_draft(uuid,text,text,text,text),
  public.set_business_persona_membership_draft(uuid,uuid,text,text,boolean,text,text,integer,boolean),
  public.save_business_mission_item_draft(uuid,uuid,text,text,integer,boolean,text),
  public.stage_native_agent_draft_for_review(uuid), public.report_client_error(text,jsonb),
  public.follow_persona(uuid,uuid,text), public.unfollow_persona(uuid,uuid),
  public.remove_persona_friendship(uuid,uuid),
  public.set_persona_visibility_rule(uuid,text,boolean),
  public.set_persona_friend_policy(uuid,text,integer,integer,text),
  public.issue_persona_friend_invite(uuid,text,integer,timestamptz),
  public.revoke_persona_friend_invites(uuid),
  public.request_persona_friendship(uuid,uuid,text), public.respond_persona_friendship(uuid,boolean),
  public.set_persona_account_sync(uuid,uuid,boolean,text,text[],boolean,boolean,text),
  public.create_extension_submission(uuid,text,text,text,text[]), public.submit_extension_for_review(uuid),
  public.withdraw_extension_submission(uuid),public.delete_extension_submission(uuid),
  public.staff_update_extension_submission(uuid,text,text),
  public.my_friend_request_security_events(timestamptz,bigint,integer),
  public.my_platform_security_events(timestamptz,bigint,integer),
  public.my_account_network_blocks(timestamptz,text,integer)
  to authenticated;

revoke all on function public.remove_persona_social_relationships(uuid)
  from public,anon,authenticated,service_role;

revoke all on function public.public_persona_friend_policy(uuid) from public;
grant execute on function public.public_persona_friend_policy(uuid) to anon, authenticated;

comment on table public.platform_role_assignments is
  'Account-level platform maintenance roles. Browser users cannot grant or change roles; no seed is performed.';
comment on table public.persona_extension_submissions is
  'Inert owner source awaiting staff review and a separate sandboxed build. Never execute source_code directly.';
comment on table public.persona_account_sync_settings is
  'Owner preferences only. A provider-specific import/export worker and permission review are still required.';
comment on table public.security_network_blocks is
  'Hashed network identifiers for WAF/edge enforcement; raw IP addresses are deliberately not stored here.';

commit;
