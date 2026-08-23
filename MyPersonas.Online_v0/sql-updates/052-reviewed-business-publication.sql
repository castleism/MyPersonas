-- 052-reviewed-business-publication.sql
-- Exact-revision review and publication for business bio/mission pages.
--
-- This migration is additive and does not publish a business. Existing rows that
-- predate the revision columns are normalized once to owner-only drafts. Apply it
-- only after migrations 049, 050, and 051.

begin;

-- ---------------------------------------------------------------------------
-- Lifecycle state and owner-private review evidence
-- ---------------------------------------------------------------------------

alter table public.businesses add column if not exists publication_revision integer;
alter table public.businesses add column if not exists published_revision integer;
alter table public.businesses add column if not exists unpublished_at timestamptz;

-- Only legacy rows have a null revision. This makes the migration safe to reapply
-- without taking an already-reviewed page offline.
update public.businesses
set publication_revision=1,
    published_revision=null,
    page_status='draft',
    visibility='owner_only',
    published_at=null,
    unpublished_at=coalesce(unpublished_at,now()),
    updated_at=now()
where publication_revision is null;

alter table public.businesses alter column publication_revision set default 1;
alter table public.businesses alter column publication_revision set not null;
alter table public.businesses drop constraint if exists businesses_publication_revision_check;
alter table public.businesses add constraint businesses_publication_revision_check
  check (publication_revision > 0 and (published_revision is null or published_revision > 0));

create table if not exists public.business_publication_reviews (
  business_id          uuid primary key,
  owner                uuid not null references public.profiles(id) on delete cascade,
  intention            text not null default '' check (char_length(intention) <= 12000),
  owner_review_notes   text not null default '' check (char_length(owner_review_notes) <= 12000),
  readiness_snapshot   jsonb not null default '{}'::jsonb,
  required_missing     integer not null default 0 check (required_missing >= 0),
  review_state         text not null default 'draft'
                       check (review_state in (
                         'draft','in_review','changes_requested','ready','published','stale'
                       )),
  reviewed_revision    integer not null default 0 check (reviewed_revision >= 0),
  submitted_at         timestamptz,
  reviewed_at          timestamptz,
  published_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (business_id,owner)
    references public.businesses(id,owner) on delete cascade
);

create index if not exists business_publication_reviews_owner_idx
  on public.business_publication_reviews(owner,review_state,updated_at desc);
create index if not exists businesses_owner_created_idx
  on public.businesses(owner,created_at,id);

alter table public.business_publication_reviews enable row level security;
drop policy if exists "owner read business publication reviews"
  on public.business_publication_reviews;
create policy "owner read business publication reviews"
  on public.business_publication_reviews for select to authenticated
  using (owner=auth.uid());

revoke all on public.business_publication_reviews from public,anon,authenticated;
grant select on public.business_publication_reviews to authenticated;
grant all on public.business_publication_reviews to service_role;

-- One transaction-scoped lock serializes review, publication, and every owner UI
-- mutation for a business without serializing unrelated accounts.
create or replace function public.lock_business_publication_mutation(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_business_id is null then raise exception 'Business id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text,52052052)
  );
end;
$$;

revoke all on function public.lock_business_publication_mutation(uuid)
  from public,anon,authenticated;

-- The top-level row is the lifecycle authority. Ordinary edits fail closed to a
-- private draft and increment the exact public revision. The transition setting is
-- used only by SECURITY DEFINER functions below and is restored before they return.
create or replace function public.guard_business_publication_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transition text:=coalesce(current_setting('app.business_publication_transition',true),'');
  v_material_change boolean;
begin
  perform public.lock_business_publication_mutation(new.id);

  if tg_op='INSERT' then
    new.page_status:='draft';
    new.visibility:='owner_only';
    new.publication_revision:=greatest(coalesce(new.publication_revision,1),1);
    new.published_revision:=null;
    new.published_at:=null;
    new.unpublished_at:=null;
    new.updated_at:=now();
    return new;
  end if;

  if row(new.id,new.owner,new.created_at) is distinct from row(old.id,old.owner,old.created_at) then
    raise exception 'Business identity, owner, and creation time are immutable';
  end if;

  if v_transition='publish' then
    if new.page_status<>'published' or new.visibility<>'public'
       or new.publication_revision<>old.publication_revision
       or new.published_revision is distinct from old.publication_revision
       or new.published_at is null then
      raise exception 'Invalid reviewed business publication transition';
    end if;
    new.unpublished_at:=null;
    new.updated_at:=now();
    return new;
  elsif v_transition='unpublish' then
    if new.page_status<>'draft' or new.visibility<>'owner_only'
       or new.publication_revision<>old.publication_revision
       or new.published_revision is not null or new.published_at is not null
       or new.unpublished_at is null then
      raise exception 'Invalid business unpublish transition';
    end if;
    new.updated_at:=now();
    return new;
  elsif v_transition='child_edit' then
    if new.page_status<>'draft' or new.visibility<>'owner_only'
       or new.publication_revision<>old.publication_revision+1
       or new.published_revision is not null or new.published_at is not null then
      raise exception 'Invalid business child-edit transition';
    end if;
    new.unpublished_at:=case when old.page_status='published'
      then coalesce(new.unpublished_at,now()) else old.unpublished_at end;
    new.updated_at:=now();
    update public.business_publication_reviews review
    set review_state='stale',readiness_snapshot='{}'::jsonb,required_missing=0,
        submitted_at=null,reviewed_at=null,published_at=null,updated_at=now()
    where review.business_id=old.id and review.owner=old.owner;
    return new;
  elsif v_transition<>'' then
    raise exception 'Unknown business publication transition';
  end if;

  v_material_change:=row(
    new.slug,new.display_name,new.short_bio,new.mission,
    new.page_status,new.visibility,new.publication_revision,
    new.published_revision,new.published_at,new.unpublished_at
  ) is distinct from row(
    old.slug,old.display_name,old.short_bio,old.mission,
    old.page_status,old.visibility,old.publication_revision,
    old.published_revision,old.published_at,old.unpublished_at
  );

  if v_material_change then
    new.publication_revision:=old.publication_revision+1;
    new.page_status:='draft';
    new.visibility:='owner_only';
    new.published_revision:=null;
    new.published_at:=null;
    new.unpublished_at:=case when old.page_status='published' then now() else old.unpublished_at end;
    new.updated_at:=now();
    update public.business_publication_reviews review
    set review_state='stale',readiness_snapshot='{}'::jsonb,required_missing=0,
        submitted_at=null,reviewed_at=null,published_at=null,updated_at=now()
    where review.business_id=old.id and review.owner=old.owner;
  else
    new.page_status:=old.page_status;
    new.visibility:=old.visibility;
    new.publication_revision:=old.publication_revision;
    new.published_revision:=old.published_revision;
    new.published_at:=old.published_at;
    new.unpublished_at:=old.unpublished_at;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_business_publication_lifecycle on public.businesses;
create trigger guard_business_publication_lifecycle
before insert or update on public.businesses
for each row execute function public.guard_business_publication_lifecycle();

revoke all on function public.guard_business_publication_lifecycle()
  from public,anon,authenticated;

create or replace function public.invalidate_business_publication(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous text:=current_setting('app.business_publication_transition',true);
begin
  if p_business_id is null then return; end if;
  perform public.lock_business_publication_mutation(p_business_id);
  perform set_config('app.business_publication_transition','child_edit',true);
  update public.businesses business
  set publication_revision=business.publication_revision+1,
      page_status='draft',visibility='owner_only',published_revision=null,
      published_at=null,
      unpublished_at=case when business.page_status='published' then now()
        else business.unpublished_at end,
      updated_at=now()
  where business.id=p_business_id;
  perform set_config('app.business_publication_transition',coalesce(v_previous,''),true);
exception when others then
  perform set_config('app.business_publication_transition',coalesce(v_previous,''),true);
  raise;
end;
$$;

revoke all on function public.invalidate_business_publication(uuid)
  from public,anon,authenticated;

-- Child changes invalidate both the old and new business if privileged maintenance ever
-- reparents a row. UUID order keeps multi-business lock acquisition deterministic.
create or replace function public.invalidate_business_after_child_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_business uuid;
  v_new_business uuid;
  v_changed boolean:=true;
begin
  if tg_op='UPDATE' then
    if tg_table_name='business_mission_items' then
      v_changed:=row(new.business_id,new.owner,new.title,new.body,new.sort_order,new.enabled,new.visibility)
        is distinct from
        row(old.business_id,old.owner,old.title,old.body,old.sort_order,old.enabled,old.visibility);
    else
      v_changed:=row(new.business_id,new.persona_id,new.owner,new.membership_role,
        new.public_title,new.enabled,new.membership_visibility,new.title_visibility,new.sort_order)
        is distinct from
        row(old.business_id,old.persona_id,old.owner,old.membership_role,
        old.public_title,old.enabled,old.membership_visibility,old.title_visibility,old.sort_order);
    end if;
    if not v_changed then return null; end if;
  end if;

  v_old_business:=case when tg_op in ('UPDATE','DELETE') then old.business_id else null end;
  v_new_business:=case when tg_op in ('INSERT','UPDATE') then new.business_id else null end;

  if v_old_business is not null and v_new_business is not null
     and v_old_business<>v_new_business then
    if v_old_business::text<v_new_business::text then
      perform public.invalidate_business_publication(v_old_business);
      perform public.invalidate_business_publication(v_new_business);
    else
      perform public.invalidate_business_publication(v_new_business);
      perform public.invalidate_business_publication(v_old_business);
    end if;
  else
    perform public.invalidate_business_publication(coalesce(v_new_business,v_old_business));
  end if;
  return null;
end;
$$;

drop trigger if exists invalidate_business_after_mission_edit on public.business_mission_items;
create trigger invalidate_business_after_mission_edit
after insert or update or delete on public.business_mission_items
for each row execute function public.invalidate_business_after_child_edit();

drop trigger if exists invalidate_business_after_membership_edit on public.business_persona_memberships;
create trigger invalidate_business_after_membership_edit
after insert or update or delete on public.business_persona_memberships
for each row execute function public.invalidate_business_after_child_edit();

revoke all on function public.invalidate_business_after_child_edit()
  from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- Locked owner mutation RPCs
-- ---------------------------------------------------------------------------

-- The migration-049 general writers could directly publish. Keep them unavailable;
-- even trusted automation must use a reviewed transition or explicit service SQL.
revoke all on function public.save_business_profile(uuid,text,text,text,text,text,text),
  public.set_business_persona_membership(uuid,uuid,text,text,boolean,text,text,integer,boolean),
  public.save_business_mission_item(uuid,uuid,text,text,integer,boolean,text)
  from public,anon,authenticated,service_role;

revoke insert,update,delete on public.businesses,public.business_mission_items,
  public.business_persona_memberships,public.business_publication_reviews
  from public,anon,authenticated,service_role;

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
  v_owner uuid:=auth.uid();
  v_id uuid;
  v_slug text:=lower(trim(coalesce(p_slug,'')));
  v_status text;
  v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if v_slug!~'^[a-z0-9][a-z0-9-]{2,79}$' then raise exception 'Invalid business slug'; end if;
  if trim(coalesce(p_display_name,''))='' or char_length(p_display_name)>160 then
    raise exception 'Invalid business name';
  end if;

  if p_business_id is null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_owner::text,52000001)
    );
    select count(*) into v_count from (
      select 1 from public.businesses business
      where business.owner=v_owner limit 100
    ) bounded;
    if v_count>=100 then raise exception 'An account can have at most 100 businesses'; end if;
    insert into public.businesses(
      owner,slug,display_name,short_bio,mission,page_status,visibility,published_at
    ) values (
      v_owner,v_slug,trim(p_display_name),left(coalesce(p_short_bio,''),4000),
      left(coalesce(p_mission,''),10000),'draft','owner_only',null
    ) returning id into v_id;
    return v_id;
  end if;

  perform public.lock_business_publication_mutation(p_business_id);
  select business.page_status into v_status from public.businesses business
  where business.id=p_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;
  if v_status='published' then perform public.require_aal2(); end if;

  update public.businesses business
  set slug=v_slug,display_name=trim(p_display_name),
      short_bio=left(coalesce(p_short_bio,''),4000),
      mission=left(coalesce(p_mission,''),10000),updated_at=now()
  where business.id=p_business_id and business.owner=v_owner
  returning business.id into v_id;
  return v_id;
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
declare
  v_owner uuid:=auth.uid();
  v_id uuid;
  v_status text;
  v_existing_business uuid;
  v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if trim(coalesce(p_title,''))='' or char_length(p_title)>200 then
    raise exception 'Invalid mission item title';
  end if;
  if p_sort_order not between 0 and 10000 then raise exception 'Invalid sort order'; end if;
  if p_visibility not in ('owner_only','friends','followers','public') then
    raise exception 'Invalid mission item visibility';
  end if;
  perform public.lock_business_publication_mutation(p_business_id);
  select business.page_status into v_status from public.businesses business
  where business.id=p_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;
  if v_status='published' then perform public.require_aal2(); end if;

  if p_item_id is null then
    select count(*) into v_count from (
      select 1 from public.business_mission_items item
      where item.business_id=p_business_id and item.owner=v_owner limit 100
    ) bounded;
    if v_count>=100 then raise exception 'A business can have at most 100 mission items'; end if;
    insert into public.business_mission_items(
      business_id,owner,title,body,sort_order,enabled,visibility
    ) values (
      p_business_id,v_owner,trim(p_title),left(coalesce(p_body,''),6000),
      p_sort_order,p_enabled,p_visibility
    ) returning id into v_id;
  else
    select item.business_id into v_existing_business
    from public.business_mission_items item
    where item.id=p_item_id and item.owner=v_owner for update;
    if not found then raise exception 'Owned mission item not found'; end if;
    if v_existing_business<>p_business_id then raise exception 'Mission items cannot be reparented'; end if;
    update public.business_mission_items item
    set title=trim(p_title),body=left(coalesce(p_body,''),6000),
        sort_order=p_sort_order,enabled=p_enabled,visibility=p_visibility,updated_at=now()
    where item.id=p_item_id and item.owner=v_owner
    returning item.id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_business_mission_item_draft(p_item_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_business_id uuid;
  v_status text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select item.business_id into v_business_id from public.business_mission_items item
  where item.id=p_item_id and item.owner=v_owner;
  if not found then raise exception 'Owned mission item not found'; end if;
  perform public.lock_business_publication_mutation(v_business_id);
  select business.page_status into v_status from public.businesses business
  where business.id=v_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;
  if v_status='published' then perform public.require_aal2(); end if;
  delete from public.business_mission_items item
  where item.id=p_item_id and item.owner=v_owner and item.business_id=v_business_id;
  return found;
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
declare
  v_owner uuid:=auth.uid();
  v_status text;
  v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_membership_role not in ('manager','member','creator','representative') then
    raise exception 'Invalid business role';
  end if;
  if p_membership_visibility not in ('owner_only','friends','followers','public')
     or p_title_visibility not in ('owner_only','friends','followers','public') then
    raise exception 'Invalid membership visibility';
  end if;
  if p_sort_order not between 0 and 10000 then raise exception 'Invalid sort order'; end if;
  perform public.lock_business_publication_mutation(p_business_id);
  select business.page_status into v_status from public.businesses business
  where business.id=p_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;
  if v_status='published' then perform public.require_aal2(); end if;
  if not exists (
    select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner
  ) then raise exception 'Owned persona not found'; end if;

  if p_remove then
    delete from public.business_persona_memberships membership
    where membership.business_id=p_business_id and membership.persona_id=p_persona_id
      and membership.owner=v_owner;
  else
    if not exists (
      select 1 from public.business_persona_memberships membership
      where membership.business_id=p_business_id and membership.persona_id=p_persona_id
        and membership.owner=v_owner
    ) then
      select count(*) into v_count from (
        select 1 from public.business_persona_memberships membership
        where membership.business_id=p_business_id and membership.owner=v_owner limit 200
      ) bounded;
      if v_count>=200 then
        raise exception 'A business can have at most 200 persona memberships';
      end if;
    end if;
    insert into public.business_persona_memberships(
      business_id,persona_id,owner,membership_role,public_title,enabled,
      membership_visibility,title_visibility,sort_order
    ) values (
      p_business_id,p_persona_id,v_owner,p_membership_role,
      left(coalesce(p_public_title,''),120),p_enabled,
      p_membership_visibility,p_title_visibility,p_sort_order
    ) on conflict(business_id,persona_id) do update set
      membership_role=excluded.membership_role,
      public_title=excluded.public_title,
      enabled=excluded.enabled,
      membership_visibility=excluded.membership_visibility,
      title_visibility=excluded.title_visibility,
      sort_order=excluded.sort_order,
      updated_at=now();
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deterministic bounded review manifest and exact-current gate
-- ---------------------------------------------------------------------------

create or replace function public.business_publication_review_manifest(p_business_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_business public.businesses%rowtype;
  v_mission_count integer;
  v_membership_count integer;
  v_public_mission_count integer:=0;
  v_public_membership_count integer:=0;
  v_ineligible_public_persona_count integer:=0;
  v_mission_items jsonb:='[]'::jsonb;
  v_memberships jsonb:='[]'::jsonb;
  v_reasons jsonb:='[]'::jsonb;
  v_complete boolean:=true;
  v_result jsonb;
begin
  select * into v_business from public.businesses business
  where business.id=p_business_id;
  if not found then raise exception 'Business not found'; end if;

  select count(*) into v_mission_count from (
    select 1 from public.business_mission_items item
    where item.business_id=v_business.id and item.owner=v_business.owner limit 101
  ) bounded;
  select count(*) into v_membership_count from (
    select 1 from public.business_persona_memberships membership
    where membership.business_id=v_business.id and membership.owner=v_business.owner limit 201
  ) bounded;

  if v_mission_count>100 then
    v_complete:=false;
    v_reasons:=v_reasons||jsonb_build_array('More than 100 mission items');
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',item.id,'title',item.title,'body',item.body,'sort_order',item.sort_order,
      'enabled',item.enabled,'visibility',item.visibility
    ) order by item.sort_order,item.id),'[]'::jsonb)
    into v_mission_items
    from public.business_mission_items item
    where item.business_id=v_business.id and item.owner=v_business.owner;
  end if;

  if v_membership_count>200 then
    v_complete:=false;
    v_reasons:=v_reasons||jsonb_build_array('More than 200 persona memberships');
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'persona_id',membership.persona_id,
      'membership_role',membership.membership_role,
      'public_title',membership.public_title,
      'enabled',membership.enabled,
      'membership_visibility',membership.membership_visibility,
      'title_visibility',membership.title_visibility,
      'sort_order',membership.sort_order,
      'persona_card',jsonb_build_object(
        'handle',persona.handle,'name',persona.name,'avatar_url',coalesce(persona.avatar_url,''),
        'publication_revision',persona.publication_revision,
        'published_revision',persona.published_revision,
        'visibility',persona.visibility,
        'exact_current',public.persona_publication_is_current(persona.id),
        'public_eligible',persona.visibility='public'
          and public.persona_publication_is_current(persona.id)
      )
    ) order by membership.sort_order,membership.persona_id),'[]'::jsonb)
    into v_memberships
    from public.business_persona_memberships membership
    join public.personas persona
      on persona.id=membership.persona_id and persona.owner=membership.owner
    where membership.business_id=v_business.id and membership.owner=v_business.owner;
  end if;

  select count(*) into v_public_mission_count from (
    select 1 from public.business_mission_items item
    where item.business_id=v_business.id and item.owner=v_business.owner
      and item.enabled and item.visibility='public' limit 101
  ) bounded;
  select count(*) into v_public_membership_count from (
    select 1 from public.business_persona_memberships membership
    where membership.business_id=v_business.id and membership.owner=v_business.owner
      and membership.enabled and membership.membership_visibility='public' limit 201
  ) bounded;
  select count(*) into v_ineligible_public_persona_count from (
    select 1
    from public.business_persona_memberships membership
    join public.personas persona
      on persona.id=membership.persona_id and persona.owner=membership.owner
    where membership.business_id=v_business.id and membership.owner=v_business.owner
      and membership.enabled and membership.membership_visibility='public'
      and not (persona.visibility='public'
        and public.persona_publication_is_current(persona.id))
    limit 201
  ) bounded;

  v_result:=jsonb_build_object(
    'schema_version',1,
    'business_id',v_business.id,
    'revision',v_business.publication_revision,
    'publication_target',jsonb_build_object('page_status','published','visibility','public'),
    'profile',jsonb_build_object(
      'slug',v_business.slug,'display_name',v_business.display_name,
      'short_bio',v_business.short_bio,'mission',v_business.mission
    ),
    'mission_items',v_mission_items,
    'persona_memberships',v_memberships,
    'counts',jsonb_build_object(
      'mission_items',v_mission_count,'persona_memberships',v_membership_count,
      'public_mission_items',v_public_mission_count,
      'public_persona_memberships',v_public_membership_count,
      'ineligible_public_personas',v_ineligible_public_persona_count
    ),
    'complete',v_complete,
    'truncation_reasons',v_reasons,
    'withheld',jsonb_build_array(
      'owner identity','private review notes','authentication roles','provider credentials'
    )
  );

  if octet_length(v_result::text)>250000 then
    v_result:=v_result||jsonb_build_object(
      'complete',false,
      'mission_items','[]'::jsonb,
      'persona_memberships','[]'::jsonb,
      'truncation_reasons',v_reasons||jsonb_build_array(
        'The complete business review manifest exceeds 250000 bytes'
      )
    );
  end if;
  return v_result;
end;
$$;

revoke all on function public.business_publication_review_manifest(uuid)
  from public,anon,authenticated;

create or replace function public.business_publication_readiness(p_business_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_business public.businesses%rowtype;
  v_intention text:='';
  v_manifest jsonb;
  v_manifest_hash text;
  v_checks jsonb;
  v_missing integer;
  v_review_state text:='draft';
  v_review_manifest_current boolean:=false;
  v_publication_current boolean:=false;
begin
  select * into v_business from public.businesses business
  where business.id=p_business_id and business.owner=auth.uid();
  if not found then raise exception 'Owned business not found'; end if;
  select review.intention into v_intention from public.business_publication_reviews review
  where review.business_id=p_business_id and review.owner=auth.uid();

  v_manifest:=public.business_publication_review_manifest(p_business_id);
  v_manifest_hash:=encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex');
  select review.review_state,
    review.review_state in ('ready','published')
      and review.reviewed_revision=v_business.publication_revision
      and review.required_missing=0
      and review.readiness_snapshot->'review_manifest'=v_manifest
      and review.readiness_snapshot->>'manifest_sha256'=v_manifest_hash
  into v_review_state,v_review_manifest_current
  from public.business_publication_reviews review
  where review.business_id=p_business_id and review.owner=v_business.owner;
  if v_business.page_status='published' then
    v_publication_current:=public.business_publication_is_current(p_business_id);
  end if;
  v_checks:=jsonb_build_array(
    jsonb_build_object('key','display_name','label','Business display name','required',true,
      'ok',trim(coalesce(v_business.display_name,''))<>''),
    jsonb_build_object('key','slug','label','Public business slug','required',true,
      'ok',coalesce(v_business.slug,'')~'^[a-z0-9][a-z0-9-]{2,79}$'),
    jsonb_build_object('key','short_bio','label','Short business bio','required',true,
      'ok',trim(coalesce(v_business.short_bio,''))<>''),
    jsonb_build_object('key','mission','label','Business mission','required',true,
      'ok',trim(coalesce(v_business.mission,''))<>''),
    jsonb_build_object('key','intention','label','Page intention','required',true,
      'ok',char_length(trim(coalesce(v_intention,'')))>=10),
    jsonb_build_object('key','review_manifest','label','Complete bounded review manifest','required',true,
      'ok',v_manifest->>'complete'='true'),
    jsonb_build_object('key','public_personas','label','Public persona cards are currently eligible','required',true,
      'ok',coalesce((v_manifest->'counts'->>'ineligible_public_personas')::integer,0)=0)
  );
  select count(*) into v_missing from jsonb_array_elements(v_checks) item
  where item->>'required'='true' and item->>'ok'<>'true';
  return jsonb_build_object(
    'business_id',v_business.id,
    'page_status',v_business.page_status,
    'publication_revision',v_business.publication_revision,
    'published_revision',v_business.published_revision,
    'review_state',v_review_state,
    'review_manifest_current',v_review_manifest_current,
    'publication_current',v_publication_current,
    'required_missing',v_missing,
    'review_manifest',v_manifest,
    'manifest_sha256',v_manifest_hash,
    'checks',v_checks,
    'warnings',to_jsonb(array_remove(array[
      case when coalesce((v_manifest->'counts'->>'public_mission_items')::integer,0)=0
        then 'No mission pieces are public; the main mission statement can still publish.' end,
      case when exists (
        select 1 from public.business_persona_memberships membership
        where membership.business_id=v_business.id and membership.owner=v_business.owner
          and membership.title_visibility='public'
          and membership.membership_visibility<>'public'
      ) then 'A public title is attached to a non-public membership and will stay hidden.' end,
      case when v_business.page_status='published' and not v_publication_current
        then 'The stored lifecycle says published, but exact review drift is keeping the public page offline.' end
    ]::text[],null))
  );
end;
$$;

create or replace function public.save_business_review_draft(
  p_business_id uuid,p_intention text default '',p_owner_review_notes text default ''
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_revision integer;
  v_status text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if char_length(coalesce(p_intention,''))>12000
     or char_length(coalesce(p_owner_review_notes,''))>12000 then
    raise exception 'Review draft text is too long';
  end if;
  perform public.lock_business_publication_mutation(p_business_id);
  select business.publication_revision,business.page_status into v_revision,v_status
  from public.businesses business
  where business.id=p_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;
  if v_status='published' then
    raise exception 'Unpublish the business before changing its publication review';
  end if;
  insert into public.business_publication_reviews(
    business_id,owner,intention,owner_review_notes,review_state,reviewed_revision,
    readiness_snapshot,required_missing,submitted_at,reviewed_at,published_at,updated_at
  ) values (
    p_business_id,v_owner,left(coalesce(p_intention,''),12000),
    left(coalesce(p_owner_review_notes,''),12000),'draft',v_revision,
    '{}'::jsonb,0,null,null,null,now()
  ) on conflict(business_id) do update set
    intention=excluded.intention,owner_review_notes=excluded.owner_review_notes,
    review_state='draft',reviewed_revision=excluded.reviewed_revision,
    readiness_snapshot='{}'::jsonb,required_missing=0,
    submitted_at=null,reviewed_at=null,published_at=null,updated_at=now();
  return true;
end;
$$;

create or replace function public.submit_business_for_review(
  p_business_id uuid,p_intention text,p_owner_review_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_revision integer;
  v_status text;
  v_snapshot jsonb;
  v_missing integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if char_length(trim(coalesce(p_intention,'')))<10 then
    raise exception 'Describe the business page intention in at least 10 characters';
  end if;
  if char_length(coalesce(p_owner_review_notes,''))>12000 then
    raise exception 'Review notes are too long';
  end if;
  perform public.lock_business_publication_mutation(p_business_id);
  select business.publication_revision,business.page_status into v_revision,v_status
  from public.businesses business
  where business.id=p_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;
  if v_status='published' then raise exception 'The current business page is already published'; end if;

  insert into public.business_publication_reviews(
    business_id,owner,intention,owner_review_notes,review_state,reviewed_revision,
    submitted_at,updated_at
  ) values (
    p_business_id,v_owner,trim(p_intention),trim(coalesce(p_owner_review_notes,'')),
    'in_review',v_revision,now(),now()
  ) on conflict(business_id) do update set
    intention=excluded.intention,owner_review_notes=excluded.owner_review_notes,
    review_state='in_review',reviewed_revision=excluded.reviewed_revision,
    submitted_at=now(),reviewed_at=null,published_at=null,updated_at=now();

  v_snapshot:=public.business_publication_readiness(p_business_id);
  v_missing:=coalesce((v_snapshot->>'required_missing')::integer,1);
  update public.business_publication_reviews review
  set readiness_snapshot=v_snapshot,required_missing=v_missing,
      review_state=case when v_missing=0 then 'ready' else 'changes_requested' end,
      reviewed_at=now(),updated_at=now()
  where review.business_id=p_business_id and review.owner=v_owner;
  return v_snapshot;
end;
$$;

create or replace function public.publish_business_page(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_revision integer;
  v_snapshot jsonb;
  v_review_snapshot jsonb;
  v_published_at timestamptz:=now();
  v_previous text:=current_setting('app.business_publication_transition',true);
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_business_publication_mutation(p_business_id);
  select business.publication_revision into v_revision from public.businesses business
  where business.id=p_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;

  v_snapshot:=public.business_publication_readiness(p_business_id);
  if coalesce((v_snapshot->>'required_missing')::integer,1)<>0 then
    raise exception 'Required business publication checks are incomplete';
  end if;
  select review.readiness_snapshot into v_review_snapshot
  from public.business_publication_reviews review
  where review.business_id=p_business_id and review.owner=v_owner
    and review.review_state='ready' and trim(review.intention)<>''
    and review.reviewed_revision=v_revision
    and review.readiness_snapshot->>'manifest_sha256'=v_snapshot->>'manifest_sha256'
    and review.readiness_snapshot->'review_manifest'=v_snapshot->'review_manifest'
    and review.readiness_snapshot->>'required_missing'='0'
  for update;
  if not found then
    raise exception 'Complete the business review for the current revision before publishing';
  end if;

  perform set_config('app.business_publication_transition','publish',true);
  update public.businesses business
  set page_status='published',visibility='public',published_revision=v_revision,
      published_at=v_published_at,unpublished_at=null,updated_at=v_published_at
  where business.id=p_business_id and business.owner=v_owner;
  perform set_config('app.business_publication_transition',coalesce(v_previous,''),true);
  update public.business_publication_reviews review
  set review_state='published',readiness_snapshot=v_snapshot,required_missing=0,
      published_at=v_published_at,updated_at=v_published_at
  where review.business_id=p_business_id and review.owner=v_owner;

  if not public.business_publication_is_current(p_business_id) then
    raise exception 'Published business failed the exact-current check';
  end if;
  return v_snapshot||jsonb_build_object(
    'page_status','published','published_revision',v_revision,'published_at',v_published_at
  );
exception when others then
  perform set_config('app.business_publication_transition',coalesce(v_previous,''),true);
  raise;
end;
$$;

create or replace function public.unpublish_business_page(p_business_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid:=auth.uid();
  v_previous text:=current_setting('app.business_publication_transition',true);
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_business_publication_mutation(p_business_id);
  perform set_config('app.business_publication_transition','unpublish',true);
  update public.businesses business
  set page_status='draft',visibility='owner_only',published_revision=null,
      published_at=null,unpublished_at=now(),updated_at=now()
  where business.id=p_business_id and business.owner=v_owner;
  if not found then raise exception 'Owned business not found'; end if;
  perform set_config('app.business_publication_transition',coalesce(v_previous,''),true);
  update public.business_publication_reviews review
  set review_state='stale',readiness_snapshot='{}'::jsonb,required_missing=0,
      submitted_at=null,reviewed_at=null,published_at=null,updated_at=now()
  where review.business_id=p_business_id and review.owner=v_owner;
  return true;
exception when others then
  perform set_config('app.business_publication_transition',coalesce(v_previous,''),true);
  raise;
end;
$$;

-- Defined after the publisher in source order through a temporary declaration.
-- PostgreSQL resolves PL/pgSQL function bodies at invocation; the exact-current
-- function exists before any browser role can call publish after commit.
create or replace function public.business_publication_is_current(p_business_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.businesses business
    join public.business_publication_reviews review
      on review.business_id=business.id and review.owner=business.owner
    cross join lateral (
      select public.business_publication_review_manifest(business.id) as manifest
    ) current_review
    where business.id=p_business_id
      and business.page_status='published' and business.visibility='public'
      and business.published_at is not null
      and business.published_revision=business.publication_revision
      and review.review_state='published'
      and review.reviewed_revision=business.publication_revision
      and review.required_missing=0
      and review.published_at is not null
      and current_review.manifest->>'complete'='true'
      and review.readiness_snapshot->'review_manifest'=current_review.manifest
      and review.readiness_snapshot->>'manifest_sha256'=
        encode(extensions.digest(convert_to(current_review.manifest::text,'UTF8'),'sha256'),'hex')
  )
$$;

revoke all on function public.business_publication_is_current(uuid)
  from public,anon,authenticated;
grant execute on function public.business_publication_is_current(uuid) to service_role;

-- Public reads expose only the exact current public projection. Presentation roles
-- and titles are strings only; no business membership is consulted by any auth check.
create or replace function public.business_page_by_slug(p_slug text)
returns table (
  id uuid,slug text,display_name text,short_bio text,mission text,
  mission_items jsonb,personas jsonb
)
language sql
security definer
stable
set search_path = ''
as $$
  select business.id,business.slug,business.display_name,business.short_bio,business.mission,
    coalesce((
      select jsonb_agg(jsonb_build_object('title',item.title,'body',item.body)
        order by item.sort_order,item.id)
      from public.business_mission_items item
      where item.business_id=business.id and item.owner=business.owner
        and item.enabled and item.visibility='public'
    ),'[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',persona.id,'handle',persona.handle,'name',persona.name,
        'avatar_url',persona.avatar_url,
        'title',case when membership.title_visibility='public'
          then membership.public_title else '' end
      ) order by membership.sort_order,membership.persona_id)
      from public.business_persona_memberships membership
      join public.personas persona
        on persona.id=membership.persona_id and persona.owner=membership.owner
      where membership.business_id=business.id and membership.owner=business.owner
        and membership.enabled and membership.membership_visibility='public'
        and persona.visibility='public'
        and public.persona_publication_is_current(persona.id)
        and public.persona_visible(persona.id)
    ),'[]'::jsonb)
  from public.businesses business
  where business.slug=lower(trim(p_slug))
    and public.business_publication_is_current(business.id)
  limit 1
$$;

revoke all on function public.business_page_by_slug(text) from public;
grant execute on function public.business_page_by_slug(text) to anon,authenticated;

-- ---------------------------------------------------------------------------
-- Browser RPC grants and documentation
-- ---------------------------------------------------------------------------

revoke all on function public.save_business_draft(uuid,text,text,text,text),
  public.save_business_mission_item_draft(uuid,uuid,text,text,integer,boolean,text),
  public.delete_business_mission_item_draft(uuid),
  public.set_business_persona_membership_draft(uuid,uuid,text,text,boolean,text,text,integer,boolean),
  public.business_publication_review_manifest(uuid),
  public.business_publication_readiness(uuid),
  public.save_business_review_draft(uuid,text,text),
  public.submit_business_for_review(uuid,text,text),
  public.publish_business_page(uuid),
  public.unpublish_business_page(uuid)
  from public,anon;

grant execute on function public.save_business_draft(uuid,text,text,text,text),
  public.save_business_mission_item_draft(uuid,uuid,text,text,integer,boolean,text),
  public.delete_business_mission_item_draft(uuid),
  public.set_business_persona_membership_draft(uuid,uuid,text,text,boolean,text,text,integer,boolean),
  public.business_publication_readiness(uuid),
  public.save_business_review_draft(uuid,text,text),
  public.submit_business_for_review(uuid,text,text),
  public.publish_business_page(uuid),
  public.unpublish_business_page(uuid)
  to authenticated;

comment on table public.business_publication_reviews is
  'Owner-private exact-revision business review evidence. A ready review never publishes automatically.';
comment on function public.business_publication_is_current(uuid) is
  'Fail-closed exact-current gate for reviewed public business pages.';
comment on column public.business_persona_memberships.membership_role is
  'Presentation and organization metadata only. It never grants authentication, staff, provider, or database authority.';
comment on column public.business_persona_memberships.public_title is
  'Optional presentation text such as Spokesperson. It never grants authentication, staff, provider, or database authority.';

commit;
