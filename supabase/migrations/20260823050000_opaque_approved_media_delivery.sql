-- 063-opaque-approved-media-delivery.sql
-- Forward-only opaque provider delivery for immutable approved post media.
--
-- Expansion only: this migration deliberately leaves post-approved-media public
-- so the ledgered migration-035 functions and already-deployed workers remain
-- compatible until the gateway, Edge proxy, consumers, backfill, and provider
-- fetch tests are all verified. The final bucket contraction is exposed only as
-- an explicit service-role function at the end of this file.

begin;

create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists(select 1 from storage.buckets where id='post-approved-media') then
    raise exception 'Migration 063 requires the ledgered post-approved-media bucket';
  end if;
end $$;

create table if not exists public.post_approved_media_handles (
  public_id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null,
  sha256 text not null check(sha256~'^[0-9a-f]{64}$'),
  mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp')),
  byte_size bigint not null check(byte_size between 1 and 10485760),
  generation integer not null check(generation between 1 and 2147483647),
  state text not null default 'active' check(state in ('active','revoked')),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  unique(owner,storage_path,generation),
  check(public_id::text~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  check(storage_path=concat(
    'owners/',lower(owner::text),'/sha256/',left(sha256,2),'/',sha256,'.',
    case mime_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else 'webp' end
  )),
  check((state='active' and retired_at is null)
    or (state='revoked' and retired_at is not null))
);

create unique index if not exists post_approved_media_one_active_path_idx
  on public.post_approved_media_handles(owner,storage_path) where state='active';
create index if not exists post_approved_media_owner_state_idx
  on public.post_approved_media_handles(owner,state,created_at);

alter table public.post_approved_media_handles enable row level security;
revoke all on public.post_approved_media_handles
  from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.post_approved_media_handles
  to service_role;

comment on table public.post_approved_media_handles is
  'Private correlation map from an opaque provider URL to one exact immutable post-approved-media object. Browser and provider responses never expose owner or Storage path.';

alter table public.post_drafts
  add column if not exists approved_fb_delivery_id uuid,
  add column if not exists approved_ig_delivery_id uuid;

create index if not exists post_drafts_approved_fb_delivery_idx
  on public.post_drafts(approved_fb_delivery_id)
  where approved_fb_delivery_id is not null;
create index if not exists post_drafts_approved_ig_delivery_idx
  on public.post_drafts(approved_ig_delivery_id)
  where approved_ig_delivery_id is not null;

create table if not exists public.post_approved_media_release_controls_063 (
  singleton boolean primary key default true check(singleton),
  opaque_consumers_confirmed boolean not null default false,
  origin_gateway_confirmed boolean not null default false,
  evidence_reference text not null default '' check(char_length(evidence_reference)<=500),
  confirmed_at timestamptz,
  check(
    (opaque_consumers_confirmed and origin_gateway_confirmed
      and evidence_reference<>'' and confirmed_at is not null)
    or (not (opaque_consumers_confirmed and origin_gateway_confirmed)
      and evidence_reference='' and confirmed_at is null)
  )
);
insert into public.post_approved_media_release_controls_063(singleton)
values(true) on conflict(singleton) do nothing;
alter table public.post_approved_media_release_controls_063 enable row level security;
revoke all on public.post_approved_media_release_controls_063
  from public,anon,authenticated,service_role;
grant select,update on public.post_approved_media_release_controls_063 to service_role;

create or replace function public.approved_media_delivery_url(p_public_id uuid)
returns text language sql immutable set search_path='' as $$
  select case when p_public_id is null then null else
    'https://media.mypersonas.online/approved/v1/'||lower(p_public_id::text)
  end
$$;

create or replace function public.approved_media_delivery_id_from_url(p_url text)
returns uuid language plpgsql immutable set search_path='' as $$
declare v_id text;
begin
  if coalesce(p_url,'')!~
    '^https://media[.]mypersonas[.]online/approved/v1/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_id:=substring(p_url from '/approved/v1/([0-9a-f-]{36})$');
  return v_id::uuid;
exception when others then
  return null;
end;
$$;

revoke all on function public.approved_media_delivery_url(uuid),
  public.approved_media_delivery_id_from_url(text)
  from public,anon,authenticated;

create or replace function public.issue_post_approved_media_handle_service(
  p_owner uuid,p_storage_path text,p_sha256 text,p_mime_type text,p_byte_size bigint
)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_existing public.post_approved_media_handles%rowtype;
  v_generation integer;v_public_id uuid;v_expected_path text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_owner is null or coalesce(p_sha256,'')!~'^[0-9a-f]{64}$'
    or p_mime_type not in ('image/jpeg','image/png','image/webp')
    or coalesce(p_byte_size,0) not between 1 and 10485760 then
    raise exception 'Approved-media handle metadata is invalid';
  end if;
  v_expected_path:=concat(
    'owners/',lower(p_owner::text),'/sha256/',left(p_sha256,2),'/',p_sha256,'.',
    case p_mime_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else 'webp' end
  );
  if p_storage_path is distinct from v_expected_path then
    raise exception 'Approved-media handle path is not canonical';
  end if;
  if not exists(
    select 1 from storage.objects object
    where object.bucket_id='post-approved-media' and object.name=p_storage_path
      and coalesce(object.metadata->>'size','')=p_byte_size::text
      and lower(coalesce(object.metadata->>'mimetype',''))=p_mime_type
  ) then
    raise exception 'The exact approved-media object is missing from Storage';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    lower(p_owner::text)||E'\u001f'||p_storage_path,63063063
  ));
  select * into v_existing from public.post_approved_media_handles handle
  where handle.owner=p_owner and handle.storage_path=p_storage_path
    and handle.state='active' for update;
  if found then
    if v_existing.sha256<>p_sha256 or v_existing.mime_type<>p_mime_type
      or v_existing.byte_size<>p_byte_size then
      raise exception 'The active approved-media handle has different immutable metadata';
    end if;
    return v_existing.public_id;
  end if;

  select coalesce(max(handle.generation),0)+1 into v_generation
  from public.post_approved_media_handles handle
  where handle.owner=p_owner and handle.storage_path=p_storage_path;
  insert into public.post_approved_media_handles(
    owner,storage_path,sha256,mime_type,byte_size,generation,state
  ) values (
    p_owner,p_storage_path,p_sha256,p_mime_type,p_byte_size,v_generation,'active'
  ) returning public_id into v_public_id;
  return v_public_id;
end;
$$;

create or replace function public.resolve_post_approved_media_service(p_public_id uuid)
returns table(
  bucket text,storage_path text,mime_type text,byte_size bigint,content_sha256 text
)
language plpgsql security definer stable set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_public_id is null then return; end if;
  return query
  select 'post-approved-media'::text,handle.storage_path,handle.mime_type,
    handle.byte_size,handle.sha256
  from public.post_approved_media_handles handle
  where handle.public_id=p_public_id and handle.state='active'
    and exists(
      select 1 from storage.objects object
      where object.bucket_id='post-approved-media' and object.name=handle.storage_path
        and coalesce(object.metadata->>'size','')=handle.byte_size::text
        and lower(coalesce(object.metadata->>'mimetype',''))=handle.mime_type
    )
  limit 1;
end;
$$;

-- Provider-facing resolution adds a durable-reference boundary. Staging may
-- issue and verify a handle before the approval transaction commits, but the
-- public proxy must not serve it unless an immutable draft snapshot currently
-- binds that exact handle and metadata. Clearing/deleting the last reference
-- therefore makes a previously known URL stop resolving without racing handle
-- reuse by another draft that approved the same content-addressed object.
create or replace function public.resolve_post_approved_media_delivery_service(
  p_public_id uuid
)
returns table(
  bucket text,storage_path text,mime_type text,byte_size bigint,content_sha256 text
)
language plpgsql security definer stable set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_public_id is null then return; end if;
  return query
  select 'post-approved-media'::text,handle.storage_path,handle.mime_type,
    handle.byte_size,handle.sha256
  from public.post_approved_media_handles handle
  where handle.public_id=p_public_id and handle.state='active'
    and exists(
      select 1 from storage.objects object
      where object.bucket_id='post-approved-media' and object.name=handle.storage_path
        and coalesce(object.metadata->>'size','')=handle.byte_size::text
        and lower(coalesce(object.metadata->>'mimetype',''))=handle.mime_type
    )
    and exists(
      select 1 from public.post_drafts draft
      where draft.owner=handle.owner and (
        (draft.approved_fb_delivery_id=handle.public_id
          and draft.approved_fb_media_path=handle.storage_path
          and draft.approved_fb_media_sha256=handle.sha256
          and draft.approved_fb_media_mime=handle.mime_type
          and draft.approved_fb_media_bytes=handle.byte_size)
        or (draft.approved_ig_delivery_id=handle.public_id
          and draft.approved_ig_media_path=handle.storage_path
          and draft.approved_ig_media_sha256=handle.sha256
          and draft.approved_ig_media_mime=handle.mime_type
          and draft.approved_ig_media_bytes=handle.byte_size)
      )
    )
  limit 1;
end;
$$;

create or replace function public.revoke_post_approved_media_owner_service(p_owner uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_owner is null then raise exception 'Owner required'; end if;
  update public.post_approved_media_handles handle
  set state='revoked',retired_at=now()
  where handle.owner=p_owner and handle.state='active';
  get diagnostics v_count=row_count;
  if exists(select 1 from public.post_approved_media_handles handle
    where handle.owner=p_owner and handle.state='active') then
    raise exception 'Approved-media handle revocation could not be verified';
  end if;
  return v_count;
end;
$$;

revoke all on function public.issue_post_approved_media_handle_service(uuid,text,text,text,bigint),
  public.resolve_post_approved_media_service(uuid),
  public.resolve_post_approved_media_delivery_service(uuid),
  public.revoke_post_approved_media_owner_service(uuid)
  from public,anon,authenticated;
grant execute on function public.issue_post_approved_media_handle_service(uuid,text,text,text,bigint),
  public.resolve_post_approved_media_service(uuid),
  public.resolve_post_approved_media_delivery_service(uuid),
  public.revoke_post_approved_media_owner_service(uuid)
  to service_role;

create or replace function public.guard_post_draft_approved_delivery_063()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if coalesce(new.approved_fb_media_sha256,'')='' then
    new.approved_fb_delivery_id:=null;
  elsif new.approved_fb_delivery_id is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'Facebook approved delivery requires the approval service';
    end if;
    new.approved_fb_delivery_id:=public.issue_post_approved_media_handle_service(
      new.owner,new.approved_fb_media_path,new.approved_fb_media_sha256,
      new.approved_fb_media_mime,new.approved_fb_media_bytes
    );
  end if;
  if new.approved_fb_delivery_id is not null and not exists(
    select 1 from public.post_approved_media_handles handle
    where handle.public_id=new.approved_fb_delivery_id and handle.owner=new.owner
      and handle.storage_path=new.approved_fb_media_path
      and handle.sha256=new.approved_fb_media_sha256
      and handle.mime_type=new.approved_fb_media_mime
      and handle.byte_size=new.approved_fb_media_bytes and handle.state='active'
  ) then raise exception 'Facebook approved delivery does not match its immutable media'; end if;

  if coalesce(new.approved_ig_media_sha256,'')='' then
    new.approved_ig_delivery_id:=null;
  elsif new.approved_ig_delivery_id is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'Instagram approved delivery requires the approval service';
    end if;
    new.approved_ig_delivery_id:=public.issue_post_approved_media_handle_service(
      new.owner,new.approved_ig_media_path,new.approved_ig_media_sha256,
      new.approved_ig_media_mime,new.approved_ig_media_bytes
    );
  end if;
  if new.approved_ig_delivery_id is not null and not exists(
    select 1 from public.post_approved_media_handles handle
    where handle.public_id=new.approved_ig_delivery_id and handle.owner=new.owner
      and handle.storage_path=new.approved_ig_media_path
      and handle.sha256=new.approved_ig_media_sha256
      and handle.mime_type=new.approved_ig_media_mime
      and handle.byte_size=new.approved_ig_media_bytes and handle.state='active'
  ) then raise exception 'Instagram approved delivery does not match its immutable media'; end if;

  if tg_op='UPDATE' then
    if old.approved_fb_delivery_id is not null
      and new.approved_fb_delivery_id is distinct from old.approved_fb_delivery_id
      and not (new.approved_fb_delivery_id is null
        and new.approved_fb_media_sha256='' and new.status in ('draft','failed','skipped')
        and new.fb_post_id is null) then
      raise exception 'Facebook approved delivery is immutable until approval is cleared';
    end if;
    if old.approved_ig_delivery_id is not null
      and new.approved_ig_delivery_id is distinct from old.approved_ig_delivery_id
      and not (new.approved_ig_delivery_id is null
        and new.approved_ig_media_sha256='' and new.status in ('draft','failed','skipped')
        and new.ig_media_id is null) then
      raise exception 'Instagram approved delivery is immutable until approval is cleared';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_post_draft_approved_delivery_063()
  from public,anon,authenticated;
drop trigger if exists zzz_guard_post_draft_approved_delivery_063 on public.post_drafts;
create trigger zzz_guard_post_draft_approved_delivery_063
  before insert or update on public.post_drafts
  for each row execute function public.guard_post_draft_approved_delivery_063();

create or replace function public.approve_and_schedule_post_draft_opaque(
  p_owner uuid,p_draft_id uuid,p_scheduled_for timestamptz,p_timezone text,
  p_fb_caption text,p_ig_caption text,p_x_caption text,p_targets text[],
  p_fb_source_url text,p_ig_source_url text,
  p_fb_media_sha256 text,p_fb_media_mime text,p_fb_media_bytes bigint,
  p_fb_media_path text,p_fb_media_url text,p_fb_delivery_id uuid,
  p_ig_media_sha256 text,p_ig_media_mime text,p_ig_media_bytes bigint,
  p_ig_media_path text,p_ig_media_url text,p_ig_delivery_id uuid
)
returns public.post_drafts
language plpgsql security definer set search_path='' as $$
declare v_draft public.post_drafts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  v_draft:=public.approve_and_schedule_post_draft(
    p_owner,p_draft_id,p_scheduled_for,p_timezone,p_fb_caption,p_ig_caption,
    p_x_caption,p_targets,p_fb_source_url,p_ig_source_url,
    p_fb_media_sha256,p_fb_media_mime,p_fb_media_bytes,p_fb_media_path,p_fb_media_url,
    p_ig_media_sha256,p_ig_media_mime,p_ig_media_bytes,p_ig_media_path,p_ig_media_url
  );
  if ('facebook'=any(v_draft.targets)
      and v_draft.approved_fb_delivery_id is distinct from p_fb_delivery_id)
    or ('facebook'<>all(v_draft.targets) and p_fb_delivery_id is not null)
    or ('instagram'=any(v_draft.targets)
      and v_draft.approved_ig_delivery_id is distinct from p_ig_delivery_id)
    or ('instagram'<>all(v_draft.targets) and p_ig_delivery_id is not null) then
    raise exception 'Opaque approved delivery changed while the exact approval was saved';
  end if;
  return v_draft;
end;
$$;
revoke all on function public.approve_and_schedule_post_draft_opaque(
  uuid,uuid,timestamptz,text,text,text,text,text[],text,text,
  text,text,bigint,text,text,uuid,text,text,bigint,text,text,uuid
) from public,anon,authenticated;
grant execute on function public.approve_and_schedule_post_draft_opaque(
  uuid,uuid,timestamptz,text,text,text,text,text[],text,text,
  text,text,bigint,text,text,uuid,text,text,bigint,text,text,uuid
) to service_role;

create or replace function public.backfill_post_approved_media_handles_service(
  p_limit integer default 100
)
returns integer language plpgsql security definer set search_path='' as $$
declare v_row record;v_id uuid;v_count integer:=0;v_limit integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  v_limit:=greatest(1,least(coalesce(p_limit,100),500));
  for v_row in
    select draft.id,draft.owner,draft.approved_fb_media_sha256,
      draft.approved_fb_media_mime,draft.approved_fb_media_bytes,
      draft.approved_fb_media_path,draft.approved_fb_delivery_id,
      draft.approved_ig_media_sha256,draft.approved_ig_media_mime,
      draft.approved_ig_media_bytes,draft.approved_ig_media_path,
      draft.approved_ig_delivery_id
    from public.post_drafts draft
    where (draft.approved_fb_media_sha256<>'' and draft.approved_fb_delivery_id is null)
       or (draft.approved_ig_media_sha256<>'' and draft.approved_ig_delivery_id is null)
    order by draft.id for update skip locked limit v_limit
  loop
    if v_row.approved_fb_media_sha256<>'' and v_row.approved_fb_delivery_id is null then
      v_id:=public.issue_post_approved_media_handle_service(
        v_row.owner,v_row.approved_fb_media_path,v_row.approved_fb_media_sha256,
        v_row.approved_fb_media_mime,v_row.approved_fb_media_bytes
      );
      update public.post_drafts set approved_fb_delivery_id=v_id where id=v_row.id;
      v_count:=v_count+1;
    end if;
    if v_row.approved_ig_media_sha256<>'' and v_row.approved_ig_delivery_id is null then
      v_id:=public.issue_post_approved_media_handle_service(
        v_row.owner,v_row.approved_ig_media_path,v_row.approved_ig_media_sha256,
        v_row.approved_ig_media_mime,v_row.approved_ig_media_bytes
      );
      update public.post_drafts set approved_ig_delivery_id=v_id where id=v_row.id;
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.backfill_post_approved_media_handles_service(integer)
  from public,anon,authenticated;
grant execute on function public.backfill_post_approved_media_handles_service(integer)
  to service_role;

create or replace function public.set_post_approved_media_release_controls_service(
  p_opaque_consumers_confirmed boolean,p_origin_gateway_confirmed boolean,
  p_evidence_reference text default ''
)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if coalesce(p_opaque_consumers_confirmed,false)
    and coalesce(p_origin_gateway_confirmed,false)
    and (trim(coalesce(p_evidence_reference,''))='' or char_length(p_evidence_reference)>500) then
    raise exception 'Bounded release evidence is required';
  end if;
  update public.post_approved_media_release_controls_063 set
    opaque_consumers_confirmed=coalesce(p_opaque_consumers_confirmed,false),
    origin_gateway_confirmed=coalesce(p_origin_gateway_confirmed,false),
    evidence_reference=case when coalesce(p_opaque_consumers_confirmed,false)
      and coalesce(p_origin_gateway_confirmed,false)
      then trim(p_evidence_reference) else '' end,
    confirmed_at=case when coalesce(p_opaque_consumers_confirmed,false)
      and coalesce(p_origin_gateway_confirmed,false) then now() else null end
  where singleton;
  return coalesce(p_opaque_consumers_confirmed,false)
    and coalesce(p_origin_gateway_confirmed,false);
end;
$$;
revoke all on function public.set_post_approved_media_release_controls_service(boolean,boolean,text)
  from public,anon,authenticated;
grant execute on function public.set_post_approved_media_release_controls_service(boolean,boolean,text)
  to service_role;

create or replace function public.post_approved_media_release_readiness_service()
returns jsonb language plpgsql security definer stable set search_path='' as $$
declare v_missing integer;v_mismatch integer;v_orphans integer;
  v_controls boolean;v_public boolean;v_ready boolean;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  -- Any exact snapshot that can still be sent to a provider must have an
  -- opaque delivery before the legacy public bucket can be contracted. Rows
  -- whose provider id is already durable need no future media fetch.
  select count(*) into v_missing from (
    select draft.id from public.post_drafts draft
    where (
      ('facebook'=any(coalesce(draft.targets,array[]::text[]))
        and draft.fb_post_id is null and draft.approved_fb_media_sha256<>''
        and draft.approved_fb_delivery_id is null)
      or ('instagram'=any(coalesce(draft.targets,array[]::text[]))
        and draft.ig_media_id is null and draft.approved_ig_media_sha256<>''
        and draft.approved_ig_delivery_id is null)
    )
  ) missing;
  select count(*) into v_mismatch from (
    select draft.id from public.post_drafts draft
    where (draft.approved_fb_delivery_id is not null and not exists(
      select 1 from public.post_approved_media_handles handle
      where handle.public_id=draft.approved_fb_delivery_id and handle.owner=draft.owner
        and handle.storage_path=draft.approved_fb_media_path
        and handle.sha256=draft.approved_fb_media_sha256
        and handle.mime_type=draft.approved_fb_media_mime
        and handle.byte_size=draft.approved_fb_media_bytes and handle.state='active'))
      or (draft.approved_ig_delivery_id is not null and not exists(
      select 1 from public.post_approved_media_handles handle
      where handle.public_id=draft.approved_ig_delivery_id and handle.owner=draft.owner
        and handle.storage_path=draft.approved_ig_media_path
        and handle.sha256=draft.approved_ig_media_sha256
        and handle.mime_type=draft.approved_ig_media_mime
        and handle.byte_size=draft.approved_ig_media_bytes and handle.state='active'))
  ) mismatch;
  select count(*) into v_orphans from public.post_approved_media_handles handle
  where handle.state='active' and not exists(
    select 1 from storage.objects object
    where object.bucket_id='post-approved-media' and object.name=handle.storage_path
      and coalesce(object.metadata->>'size','')=handle.byte_size::text
      and lower(coalesce(object.metadata->>'mimetype',''))=handle.mime_type
  );
  select controls.opaque_consumers_confirmed and controls.origin_gateway_confirmed
    into v_controls from public.post_approved_media_release_controls_063 controls
    where controls.singleton;
  select bucket.public into v_public from storage.buckets bucket
    where bucket.id='post-approved-media';
  v_ready:=coalesce(v_controls,false) and v_missing=0 and v_mismatch=0 and v_orphans=0;
  return jsonb_build_object(
    'ready_to_finalize',v_ready,'bucket_public',coalesce(v_public,false),
    'release_controls_confirmed',coalesce(v_controls,false),
    'retryable_rows_missing_delivery',v_missing,
    'delivery_mapping_mismatches',v_mismatch,
    'active_handles_missing_storage',v_orphans
  );
end;
$$;
revoke all on function public.post_approved_media_release_readiness_service()
  from public,anon,authenticated;
grant execute on function public.post_approved_media_release_readiness_service()
  to service_role;

-- Defense in depth for the later private-bucket state. Public buckets bypass
-- object SELECT RLS, so this policy becomes effective only after the explicit
-- finalizer changes storage.buckets.public to false.
drop policy if exists "post approved media private read boundary" on storage.objects;
create policy "post approved media private read boundary" on storage.objects
  as restrictive for select to public
  using(bucket_id<>'post-approved-media' or auth.role()='service_role');

create or replace function public.finalize_post_approved_media_bucket_service()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_check jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  lock table public.post_drafts in share row exclusive mode;
  lock table public.post_approved_media_handles in share row exclusive mode;
  lock table storage.objects in share mode;
  lock table storage.buckets in share row exclusive mode;
  v_check:=public.post_approved_media_release_readiness_service();
  if coalesce((v_check->>'ready_to_finalize')::boolean,false) is not true then
    raise exception 'Approved-media bucket finalization is not ready: %',v_check::text;
  end if;
  update storage.buckets set public=false where id='post-approved-media';
  if not exists(select 1 from storage.buckets
    where id='post-approved-media' and public=false) then
    raise exception 'Approved-media bucket privacy change could not be verified';
  end if;
  return v_check||jsonb_build_object('bucket_public',false,'finalized',true);
end;
$$;
revoke all on function public.finalize_post_approved_media_bucket_service()
  from public,anon,authenticated;
grant execute on function public.finalize_post_approved_media_bucket_service()
  to service_role;

-- Allow deterministic server-authored social crops for declared no-AI raster
-- sources. The fixed rendition names are the versioned contract for
-- facebook=1200x628, instagram=1080x1080, and x=1080x1350 center-cover bytes.
alter table public.persona_media_assets
  drop constraint if exists persona_media_assets_provenance_shape_check;
alter table public.persona_media_assets
  add constraint persona_media_assets_provenance_shape_check check (
    (
      declaration_source='legacy' and origin='legacy' and source_sha256=''
      and content_sha256='' and mime_type='' and byte_size=0
      and watermark_state='legacy_unverified' and provenance_sha256=''
    ) or (
      declaration_source<>'legacy'
      and source_sha256~'^[0-9a-f]{64}$' and content_sha256~'^[0-9a-f]{64}$'
      and provenance_sha256~'^[0-9a-f]{64}$' and byte_size between 1 and 15728640
      and mime_type in ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')
      and declared_by is not null and declared_at is not null
      and (
        (ai_use='none' and watermark_state='not_required'
          and watermark_version='' and watermark_position=''
          and watermark_asset_sha256=''
          and (source_sha256=content_sha256 or (
            source_sha256<>content_sha256
            and rendition in ('facebook','instagram','x')
            and mime_type in ('image/png','image/jpeg','image/webp')
          )))
        or (ai_use<>'none' and source_sha256<>content_sha256
          and watermark_state='system_applied'
          and watermark_version='mypersonas-ai-watermark-v1'
          and watermark_position='bottom_right'
          and watermark_asset_sha256='c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2')
      )
      and (
        (origin='site_generated' and generated_on_site and ai_use='generated'
          and declaration_source='system' and generation_event_id is not null)
        or (origin in ('uploaded','imported') and not generated_on_site
          and declaration_source in ('owner','import') and generation_event_id is null)
      )
    )
  );

-- Complete forward replacement of the ledgered 060 service registrar. Only the
-- no-AI social-rendition rule changes; quotas, generation evidence, immutable
-- path checks, and provenance hashing are retained.
create or replace function public.register_persona_media_asset_service(
  p_owner uuid,p_persona_id uuid,p_media_type text,p_storage_path text,
  p_public_url text,p_mime_type text,p_byte_size bigint,p_origin text,
  p_ai_use text,p_source_sha256 text,p_content_sha256 text,
  p_watermark_state text,p_watermark_version text,p_watermark_asset_sha256 text,
  p_generation_event_id uuid,p_rendition text
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_id uuid;v_source text;v_declaration text;v_generated boolean;
  v_provenance text;v_backend uuid;v_expected_path text;
  v_daily_count bigint;v_total_bytes bigint;v_asset_count bigint;
  v_persona_bytes bigint;v_persona_count bigint;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=p_owner) then
    raise exception 'Owned persona not found';
  end if;
  if p_media_type not in ('image','video')
     or p_origin not in ('uploaded','site_generated')
     or p_ai_use not in ('none','assisted','generated','unknown')
     or p_source_sha256!~'^[0-9a-f]{64}$'
     or p_content_sha256!~'^[0-9a-f]{64}$'
     or p_mime_type not in ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')
     or p_byte_size not between 1 and 15728640
     or p_rendition!~'^[a-z0-9_-]{1,64}$' then
    raise exception 'Invalid media provenance input';
  end if;
  v_generated:=p_origin='site_generated';
  v_source:=case when v_generated then 'generated' else 'uploaded' end;
  v_declaration:=case when v_generated then 'system' else 'owner' end;
  if v_generated and (p_ai_use<>'generated' or p_generation_event_id is null) then
    raise exception 'Site-generated media must remain system-declared AI-generated';
  end if;
  if not v_generated and p_generation_event_id is not null then
    raise exception 'Owner uploads cannot claim a system generation event';
  end if;
  if p_ai_use='none' then
    if p_watermark_state<>'not_required' or p_watermark_version<>''
      or p_watermark_asset_sha256<>''
      or (p_source_sha256<>p_content_sha256 and (
        p_rendition not in ('facebook','instagram','x')
        or p_mime_type not in ('image/png','image/jpeg','image/webp')
      )) then
      raise exception 'No-AI media may differ only as an exact server social rendition';
    end if;
  elsif p_source_sha256=p_content_sha256
     or p_watermark_state<>'system_applied'
     or p_watermark_version<>'mypersonas-ai-watermark-v1'
     or p_watermark_asset_sha256<>'c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2'
     or p_mime_type not in ('image/png','image/jpeg','image/webp') then
    raise exception 'AI-used public media requires a distinct supported watermarked derivative';
  end if;
  if v_generated then
    select event.backend_id into v_backend from public.ai_media_generation_events event
    where event.id=p_generation_event_id and event.owner=p_owner
      and event.persona_id=p_persona_id and event.output_sha256=p_source_sha256
      and event.output_mime=p_mime_type;
    if not found then raise exception 'Matching generation evidence was not found'; end if;
  end if;
  v_expected_path:=lower(p_owner::text)||'/published/provenance/'||p_ai_use||'/'||v_source||'/'||lower(p_persona_id::text)||'/';
  if p_storage_path not like v_expected_path||'%'
     or p_storage_path!~('^'||lower(p_owner::text)||'/published/provenance/(none|assisted|generated|unknown)/(uploaded|generated)/'||lower(p_persona_id::text)||'/(?:[a-z0-9_-]+/){1,6}'||p_content_sha256||'\.(png|jpg|webp|gif|mp4|webm)$')
     or p_public_url!~'^https://[^/?#]+/storage/v1/object/public/persona-media/'
     or p_public_url<>'https://'||split_part(substring(p_public_url from 9),'/',1)
       ||'/storage/v1/object/public/persona-media/'||p_storage_path then
    raise exception 'Public media path and URL are not canonical';
  end if;
  v_provenance:=encode(extensions.digest(convert_to(jsonb_build_array(
    p_owner,p_persona_id,p_media_type,p_storage_path,p_public_url,p_mime_type,
    p_byte_size,p_origin,p_ai_use,v_declaration,p_source_sha256,p_content_sha256,
    p_watermark_state,p_watermark_version,
    case when p_ai_use='none' then '' else 'bottom_right' end,
    p_watermark_asset_sha256,p_generation_event_id,p_rendition
  )::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'persona-media-owner-quota'||E'\u001f'||p_owner::text,59059059));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner::text||E'\u001f'||p_public_url,59059059));
  select asset.id into v_id from public.persona_media_assets asset
  where asset.owner=p_owner and asset.public_url=p_public_url;
  if found then
    if not exists(select 1 from public.persona_media_assets asset where asset.id=v_id
      and asset.persona_id=p_persona_id and asset.content_sha256=p_content_sha256
      and asset.source_sha256=p_source_sha256 and asset.ai_use=p_ai_use
      and asset.provenance_sha256=v_provenance and asset.status='active') then
      raise exception 'An existing public URL is unavailable or has different provenance';
    end if;
    return v_id;
  end if;
  select count(*) filter(where asset.declared_at>=(
      date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')),
    coalesce(sum(asset.byte_size),0),count(*),
    coalesce(sum(asset.byte_size) filter(where asset.persona_id=p_persona_id),0),
    count(*) filter(where asset.persona_id=p_persona_id)
  into v_daily_count,v_total_bytes,v_asset_count,v_persona_bytes,v_persona_count
  from public.persona_media_assets asset where asset.owner=p_owner;
  if v_daily_count>=200 then raise exception 'Daily persona media registration safety limit reached'; end if;
  if v_total_bytes+p_byte_size>2147483648 then raise exception 'Persona media storage safety limit reached'; end if;
  if v_asset_count>=5000 then raise exception 'Persona media asset-count safety limit reached'; end if;
  if v_persona_bytes+p_byte_size>536870912 then raise exception 'Persona media per-persona storage safety limit reached'; end if;
  if v_persona_count>=1000 then raise exception 'Persona media per-persona asset-count safety limit reached'; end if;
  if v_generated then
    update public.ai_media_generation_events event
    set derivative_count=event.derivative_count+1
    where event.id=p_generation_event_id and event.owner=p_owner
      and event.persona_id=p_persona_id and event.output_sha256=p_source_sha256
      and event.output_mime=p_mime_type and event.expires_at>now()
      and event.derivative_count<8
    returning event.backend_id into v_backend;
    if not found then raise exception 'Generation evidence is expired, mismatched, or exhausted'; end if;
  end if;
  insert into public.persona_media_assets(
    owner,persona_id,media_type,storage_path,public_url,source,
    generation_backend,metadata,status,origin,ai_use,declaration_source,
    declared_by,declared_at,generated_on_site,source_sha256,content_sha256,
    mime_type,byte_size,watermark_state,watermark_version,watermark_position,
    watermark_asset_sha256,provenance_sha256,generation_event_id,rendition
  ) values (
    p_owner,p_persona_id,p_media_type,p_storage_path,p_public_url,v_source,
    v_backend,jsonb_build_object('rendition',p_rendition),'active',p_origin,p_ai_use,
    v_declaration,p_owner,now(),v_generated,p_source_sha256,p_content_sha256,
    p_mime_type,p_byte_size,p_watermark_state,p_watermark_version,
    case when p_ai_use='none' then '' else 'bottom_right' end,
    p_watermark_asset_sha256,v_provenance,p_generation_event_id,p_rendition
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.register_persona_media_asset_service(
  uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,uuid,text
) from public,anon,authenticated;
grant execute on function public.register_persona_media_asset_service(
  uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,uuid,text
) to service_role;

commit;
