-- 065-legacy-media-canonical-remediation.sql
-- Local-only second slice: exact preview-bound declarations, canonical
-- re-ingest, transactional CAS replacement/clear, and release readiness.
-- This migration never changes either Storage bucket's public flag and never
-- purges historical bytes.

begin;

alter table public.legacy_media_references
  drop constraint if exists legacy_media_references_state_check;
alter table public.legacy_media_references
  add constraint legacy_media_references_state_check check(state in(
    'pending','blocked_cross_owner','blocked_persona','blocked_shared_product',
    'stale','imported','cleared','erased'
  ));
do $migration$
declare v_constraint text;
begin
  for v_constraint in
    select constraint_row.conname from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid='public.legacy_media_references'::regclass
      and constraint_row.contype='c'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%blocked_cross_owner%'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%source_id%'
  loop
    execute format('alter table public.legacy_media_references drop constraint %I',v_constraint);
  end loop;
end
$migration$;
alter table public.legacy_media_references
  add constraint legacy_media_references_source_state_065_check check(
    (state='blocked_cross_owner' and source_id is null)
    or (state in('pending','blocked_persona','blocked_shared_product','imported')
      and source_id is not null)
    or state in('stale','cleared','erased')
  );

-- Composite owner-bound foreign keys below must never rely on a reference id
-- alone, because remediation authority is scoped to the inventory owner.
create unique index if not exists legacy_media_references_id_owner_065_idx
  on public.legacy_media_references(id,owner);
alter table public.legacy_media_references
  add column if not exists preview_revision uuid;

alter table public.persona_media_assets
  drop constraint if exists persona_media_assets_imported_static_065_check;
alter table public.persona_media_assets
  add constraint persona_media_assets_imported_static_065_check check(
    origin<>'imported' or (
      declaration_source='import' and source='sourced' and media_type='image'
      and mime_type in('image/png','image/jpeg','image/webp')
      and generation_event_id is null and not generated_on_site
    )
  );
alter table public.persona_media_assets
  drop constraint if exists persona_media_assets_authority_shape_065_check;
alter table public.persona_media_assets
  add constraint persona_media_assets_authority_shape_065_check check(
    (origin='uploaded' and declaration_source='owner'
      and not generated_on_site and generation_event_id is null)
    or (origin='imported' and declaration_source='import'
      and not generated_on_site and generation_event_id is null)
    or (origin='site_generated' and declaration_source='system'
      and generated_on_site and generation_event_id is not null)
    or (origin='legacy' and declaration_source='legacy'
      and not generated_on_site and generation_event_id is null)
  );

alter table public.legacy_media_sources
  add column if not exists preview_revision uuid;
update public.legacy_media_sources
set preview_revision=gen_random_uuid()
where previewed_at is not null and preview_revision is null;
alter table public.legacy_media_sources
  drop constraint if exists legacy_media_sources_preview_revision_check;
alter table public.legacy_media_sources
  add constraint legacy_media_sources_preview_revision_check check(
    (previewed_at is null and preview_revision is null)
    or (previewed_at is not null and preview_revision is not null)
  );

create table if not exists public.legacy_media_declarations_065 (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null references public.profiles(id) on delete cascade,
  reference_id        uuid not null,
  source_id           uuid not null,
  persona_id          uuid not null,
  preview_revision    uuid not null,
  legacy_url_sha256   text not null check(legacy_url_sha256~'^[0-9a-f]{64}$'),
  object_id           uuid not null,
  object_updated_at   timestamptz not null,
  source_sha256       text not null check(source_sha256~'^[0-9a-f]{64}$'),
  byte_size           bigint not null check(byte_size between 1 and 15728640),
  detected_mime       text not null check(detected_mime in(
    'image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm'
  )),
  ai_use              text not null check(ai_use in('none','assisted','generated','unknown')),
  state               text not null default 'active' check(state in('active','superseded','erased')),
  declared_by         uuid not null,
  declared_at         timestamptz not null default now(),
  superseded_at       timestamptz,
  foreign key(reference_id,owner)
    references public.legacy_media_references(id,owner) on delete cascade,
  foreign key(source_id,owner)
    references public.legacy_media_sources(id,owner) on delete cascade,
  foreign key(persona_id,owner)
    references public.personas(id,owner) on delete cascade,
  unique(owner,reference_id,preview_revision),
  unique(id,owner),
  check(declared_by=owner),
  check((state='active' and superseded_at is null)
    or (state in('superseded','erased') and superseded_at is not null))
);

create index if not exists legacy_media_declarations_owner_state_065_idx
  on public.legacy_media_declarations_065(owner,state,id);

create table if not exists public.legacy_media_imports_065 (
  id              uuid primary key default gen_random_uuid(),
  owner           uuid not null references public.profiles(id) on delete cascade,
  declaration_id  uuid not null,
  reference_id    uuid not null,
  source_id       uuid not null,
  persona_id      uuid not null,
  asset_id        uuid not null references public.persona_media_assets(id) on delete cascade,
  public_id       uuid not null references public.persona_public_media_handles(public_id) on delete cascade,
  state           text not null default 'applied' check(state in('applied','erased')),
  applied_at      timestamptz not null default now(),
  erased_at       timestamptz,
  foreign key(declaration_id,owner)
    references public.legacy_media_declarations_065(id,owner) on delete cascade,
  foreign key(reference_id,owner)
    references public.legacy_media_references(id,owner) on delete cascade,
  foreign key(source_id,owner)
    references public.legacy_media_sources(id,owner) on delete cascade,
  foreign key(persona_id,owner)
    references public.personas(id,owner) on delete cascade,
  unique(owner,declaration_id),
  unique(id,owner),
  check((state='applied' and erased_at is null)
    or (state='erased' and erased_at is not null))
);

create table if not exists public.legacy_media_actions_065 (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null references public.profiles(id) on delete cascade,
  reference_id        uuid not null,
  declaration_id      uuid,
  import_id           uuid,
  action              text not null check(action in('import_rewrite','clear')),
  affected_personas   integer not null check(affected_personas between 0 and 1000),
  created_at          timestamptz not null default now(),
  foreign key(reference_id,owner)
    references public.legacy_media_references(id,owner) on delete cascade,
  foreign key(declaration_id,owner)
    references public.legacy_media_declarations_065(id,owner) on delete cascade,
  foreign key(import_id,owner)
    references public.legacy_media_imports_065(id,owner) on delete cascade,
  check((action='import_rewrite' and declaration_id is not null and import_id is not null)
    or (action='clear' and declaration_id is null and import_id is null))
);

-- Storage uploads cannot hold the application transaction open. A short
-- service-only lease serializes one owner/path across upload, exact
-- re-download, registration, and cleanup. The Storage-row trigger below takes
-- the same owner advisory lock as erasure, so lease expiry alone can never let
-- a late object commit behind an already-completed prefix sweep.
create table if not exists public.persona_media_upload_leases_065 (
  lease_id       uuid primary key,
  owner          uuid not null references public.profiles(id) on delete cascade,
  storage_path   text not null check(char_length(storage_path) between 80 and 1024),
  operation      text not null check(operation in('media_ingest','legacy_import')),
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  unique(owner,storage_path),
  check(storage_path like lower(owner::text)||'/published/provenance/%')
);
create index if not exists persona_media_upload_leases_owner_expiry_065_idx
  on public.persona_media_upload_leases_065(owner,expires_at);

-- Keep no raw owner UUID after full account deletion. The one-way owner hash
-- enforces only a bounded post-erasure cooldown so a request that was already
-- in transport cannot land after the final Storage sweep. Deterministic
-- physical expiry is scheduled below when pg_cron is installed; readiness
-- remains false until hosted staging proves that job and this Storage trigger.
create table if not exists public.persona_media_erasure_tombstones_065 (
  owner_hash     text primary key check(owner_hash~'^[0-9a-f]{64}$'),
  lease_id       uuid not null,
  blocked_until  timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists persona_media_erasure_tombstone_expiry_065_idx
  on public.persona_media_erasure_tombstones_065(blocked_until);

alter table public.legacy_media_declarations_065 enable row level security;
alter table public.legacy_media_imports_065 enable row level security;
alter table public.legacy_media_actions_065 enable row level security;
alter table public.persona_media_upload_leases_065 enable row level security;
alter table public.persona_media_erasure_tombstones_065 enable row level security;
revoke all on public.legacy_media_declarations_065,
  public.legacy_media_imports_065,public.legacy_media_actions_065,
  public.persona_media_upload_leases_065,
  public.persona_media_erasure_tombstones_065
  from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.legacy_media_declarations_065,
  public.legacy_media_imports_065,public.legacy_media_actions_065
  to service_role;

comment on table public.legacy_media_declarations_065 is
  'Service-only owner declaration bound to one exact 064 preview revision; no URL, path, or hash is browser-readable.';
comment on table public.legacy_media_imports_065 is
  'Service-only audit binding from one exact declaration to one persona-bound canonical asset and opaque handle.';
comment on table public.persona_media_erasure_tombstones_065 is
  'Bounded hashed-owner cooldown preventing late persona-media writes after content/account erasure; contains no raw owner identifier.';

create or replace function public.persona_media_owner_hash_065(p_owner uuid)
returns text language sql immutable set search_path='' as $$
  select encode(extensions.digest(
    convert_to(lower(p_owner::text),'UTF8'),'sha256'),'hex')
$$;

create or replace function public.purge_expired_persona_media_erasure_tombstones_065()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  delete from public.persona_media_erasure_tombstones_065 tombstone
  where tombstone.blocked_until<=now();
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

-- Supabase Storage treats its schema as vendor-owned. This trigger is a
-- deliberate fail-closed staging gate, not a deploy-ready assertion. Hosted
-- staging must prove upload success, trigger rejection, and Storage cleanup
-- behavior before the owner accepts the vendor-maintenance risk.

-- Storage API writes participate in the owner-erasure lock at the database
-- boundary. Either the object commits before erasure claims the lock (and the
-- subsequent sweep sees it), or it waits and is rejected by the active lease
-- or bounded cooldown. This is stronger than relying on an HTTP timeout.
create or replace function public.guard_persona_media_erasure_write_065()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_owner_text text;v_owner uuid;v_hash text;v_paths text[]:='{}'::text[];
begin
  if new.bucket_id='persona-media' then v_paths:=array_append(v_paths,new.name); end if;
  if tg_op='UPDATE' and old.bucket_id='persona-media'
     and (old.name is distinct from new.name
       or old.bucket_id is distinct from new.bucket_id) then
    v_paths:=array_append(v_paths,old.name);
  end if;
  foreach v_owner_text in array v_paths loop
    v_owner_text:=split_part(v_owner_text,'/',1);
    if v_owner_text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       then continue; end if;
    v_owner:=v_owner_text::uuid;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('meta-owner:'||v_owner::text,0));
    v_hash:=public.persona_media_owner_hash_065(v_owner);
    delete from public.persona_media_erasure_tombstones_065 tombstone
    where tombstone.owner_hash=v_hash and tombstone.blocked_until<=now();
    if exists(select 1 from public.meta_owner_erasure_leases lease
        where lease.owner=v_owner and lease.expires_at>now())
       or exists(select 1 from public.persona_media_erasure_tombstones_065 tombstone
        where tombstone.owner_hash=v_hash and tombstone.blocked_until>now()) then
      raise exception 'Persona-media writes are blocked by owner erasure';
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists guard_persona_media_erasure_write_065
  on storage.objects;
create trigger guard_persona_media_erasure_write_065
  before insert or update on storage.objects
  for each row execute function public.guard_persona_media_erasure_write_065();

do $migration$
begin
  if exists(select 1 from pg_catalog.pg_extension extension
      where extension.extname='pg_cron')
     and pg_catalog.to_regclass('cron.job') is not null then
    execute $cron$
      select cron.schedule(
        'mypersonas-065-erasure-tombstone-expiry',
        '*/5 * * * *',
        'select public.purge_expired_persona_media_erasure_tombstones_065()'
      )
      where not exists(select 1 from cron.job
        where jobname='mypersonas-065-erasure-tombstone-expiry')
    $cron$;
  end if;
end
$migration$;

-- Audit authority is append-only. Coordinated erasure may physically DELETE
-- rows, but no service path may rewrite evidence or reactivate old authority.
create or replace function public.guard_legacy_media_declaration_audit_065()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if row(new.id,new.owner,new.reference_id,new.source_id,new.persona_id,
      new.preview_revision,new.legacy_url_sha256,new.object_id,
      new.object_updated_at,new.source_sha256,new.byte_size,new.detected_mime,
      new.ai_use,new.declared_by,new.declared_at)
     is distinct from
     row(old.id,old.owner,old.reference_id,old.source_id,old.persona_id,
      old.preview_revision,old.legacy_url_sha256,old.object_id,
      old.object_updated_at,old.source_sha256,old.byte_size,old.detected_mime,
      old.ai_use,old.declared_by,old.declared_at)
     or old.state<>'active' or new.state not in('superseded','erased')
     or new.superseded_at is null then
    raise exception 'Legacy declaration audit authority is immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_legacy_media_declaration_audit_065
  on public.legacy_media_declarations_065;
create trigger guard_legacy_media_declaration_audit_065
  before update on public.legacy_media_declarations_065
  for each row execute function public.guard_legacy_media_declaration_audit_065();

create or replace function public.guard_legacy_media_action_audit_065()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  raise exception 'Legacy remediation action audit rows are immutable';
end;
$$;
drop trigger if exists guard_legacy_media_action_audit_065
  on public.legacy_media_actions_065;
create trigger guard_legacy_media_action_audit_065
  before update on public.legacy_media_actions_065
  for each row execute function public.guard_legacy_media_action_audit_065();

-- A canonical import is the immutable authority behind its opaque consumer.
-- Archiving or deleting that asset independently would revoke/cascade the
-- evidence while leaving an unremediable opaque URL. Coordinated owner erasure
-- deletes the import audit rows first, after which normal asset deletion may
-- proceed.
create or replace function public.guard_bound_legacy_import_asset_065()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_asset_id uuid:=case when tg_op='DELETE' then old.id else new.id end;
begin
  if exists(select 1 from public.legacy_media_imports_065 imported
      where imported.asset_id=v_asset_id and imported.state='applied')
     and (tg_op='DELETE' or new.status is distinct from old.status) then
    raise exception 'A bound legacy import cannot be archived or deleted independently';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
drop trigger if exists guard_bound_legacy_import_asset_065
  on public.persona_media_assets;
create trigger guard_bound_legacy_import_asset_065
  before update of status or delete on public.persona_media_assets
  for each row execute function public.guard_bound_legacy_import_asset_065();

-- Every mutating 065 operation takes the same owner lock used by account and
-- content erasure, then the 064 inventory lock. This prevents remediation from
-- repopulating bytes while an erasure lease is active.
create or replace function public.assert_legacy_media_owner_available_065(p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_owner_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null or not exists(
    select 1 from public.profiles profile where profile.id=p_owner
  ) then raise exception 'Owner unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0));
  delete from public.meta_owner_erasure_leases lease
  where lease.owner=p_owner and lease.expires_at<=now();
  v_owner_hash:=public.persona_media_owner_hash_065(p_owner);
  delete from public.persona_media_erasure_tombstones_065 tombstone
  where tombstone.owner_hash=v_owner_hash and tombstone.blocked_until<=now();
  if exists(select 1 from public.meta_owner_erasure_leases lease
      where lease.owner=p_owner and lease.expires_at>now())
     or exists(select 1 from public.persona_media_erasure_tombstones_065 tombstone
      where tombstone.owner_hash=v_owner_hash and tombstone.blocked_until>now()) then
    raise exception 'Owner erasure is active';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'legacy-media-inventory'||E'\u001f'||p_owner::text,64064064));
end;
$$;

create or replace function public.claim_persona_media_upload_service_065(
  p_owner uuid,p_lease_id uuid,p_storage_path text,p_operation text,
  p_ttl_seconds integer default 180
)
returns text language plpgsql security definer set search_path='' as $$
declare
  v_existing public.persona_media_upload_leases_065%rowtype;v_owner_hash text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_owner is null or p_lease_id is null
     or p_operation not in('media_ingest','legacy_import')
     or p_ttl_seconds not between 60 and 300
     or char_length(coalesce(p_storage_path,'')) not between 80 and 1024
     or p_storage_path not like lower(p_owner::text)||'/published/provenance/%'
     or not exists(select 1 from public.profiles profile where profile.id=p_owner) then
    raise exception 'Invalid persona-media upload lease request';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0));
  delete from public.meta_owner_erasure_leases lease
  where lease.owner=p_owner and lease.expires_at<=now();
  v_owner_hash:=public.persona_media_owner_hash_065(p_owner);
  delete from public.persona_media_erasure_tombstones_065 tombstone
  where tombstone.owner_hash=v_owner_hash and tombstone.blocked_until<=now();
  if exists(select 1 from public.meta_owner_erasure_leases lease
      where lease.owner=p_owner and lease.expires_at>now())
     or exists(select 1 from public.persona_media_erasure_tombstones_065 tombstone
      where tombstone.owner_hash=v_owner_hash and tombstone.blocked_until>now()) then
    return 'erasure_active';
  end if;
  delete from public.persona_media_upload_leases_065 lease
  where lease.owner=p_owner and lease.expires_at<=now();
  select * into v_existing from public.persona_media_upload_leases_065 lease
  where lease.owner=p_owner and lease.storage_path=p_storage_path for update;
  if found then
    if v_existing.lease_id=p_lease_id and v_existing.operation=p_operation then
      update public.persona_media_upload_leases_065 lease
      set expires_at=now()+make_interval(secs=>p_ttl_seconds)
      where lease.lease_id=p_lease_id and lease.owner=p_owner;
      return 'claimed';
    end if;
    return 'busy';
  end if;
  insert into public.persona_media_upload_leases_065(
    lease_id,owner,storage_path,operation,expires_at
  ) values(
    p_lease_id,p_owner,p_storage_path,p_operation,
    now()+make_interval(secs=>p_ttl_seconds)
  );
  return 'claimed';
end;
$$;

create or replace function public.assert_persona_media_upload_lease_065(
  p_owner uuid,p_lease_id uuid,p_storage_path text
)
returns void language plpgsql security definer set search_path='' as $$
declare v_owner_hash text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0));
  delete from public.meta_owner_erasure_leases lease
  where lease.owner=p_owner and lease.expires_at<=now();
  v_owner_hash:=public.persona_media_owner_hash_065(p_owner);
  delete from public.persona_media_erasure_tombstones_065 tombstone
  where tombstone.owner_hash=v_owner_hash and tombstone.blocked_until<=now();
  if exists(select 1 from public.meta_owner_erasure_leases lease
      where lease.owner=p_owner and lease.expires_at>now())
    or exists(select 1 from public.persona_media_erasure_tombstones_065 tombstone
      where tombstone.owner_hash=v_owner_hash and tombstone.blocked_until>now())
    or not exists(select 1 from public.persona_media_upload_leases_065 lease
      where lease.owner=p_owner and lease.lease_id=p_lease_id
        and lease.storage_path=p_storage_path and lease.expires_at>now()
      for update) then
    raise exception 'Persona-media upload lease is unavailable';
  end if;
end;
$$;

create or replace function public.persona_media_upload_cleanup_allowed_065(
  p_owner uuid,p_lease_id uuid,p_storage_path text
)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform public.assert_persona_media_upload_lease_065(
    p_owner,p_lease_id,p_storage_path);
  perform 1 from storage.objects object
  where object.bucket_id='persona-media' and object.name=p_storage_path
  for update;
  if not found then return false; end if;
  return not exists(select 1 from public.persona_media_assets asset
    where asset.owner=p_owner and asset.storage_path=p_storage_path);
end;
$$;

create or replace function public.release_persona_media_upload_service_065(
  p_owner uuid,p_lease_id uuid
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0));
  delete from public.persona_media_upload_leases_065 lease
  where lease.owner=p_owner and lease.lease_id=p_lease_id;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;

-- Erasure and upload leases share one owner lock. Erasure cannot begin while a
-- Storage upload may still land after its prefix sweep; expired upload leases
-- are safe because erasure performs the sweep after claiming this lock.
do $migration$
begin
  if to_regprocedure('public.claim_meta_owner_erasure_core_018(uuid,uuid,integer)')
     is null then
    alter function public.claim_meta_owner_erasure(uuid,uuid,integer)
      rename to claim_meta_owner_erasure_core_018;
  end if;
end
$migration$;
create or replace function public.claim_meta_owner_erasure(
  p_owner uuid,p_lease_id uuid,p_ttl_seconds integer
)
returns text language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0));
  delete from public.persona_media_upload_leases_065 lease
  where lease.owner=p_owner and lease.expires_at<=now();
  if exists(select 1 from public.persona_media_upload_leases_065 lease
    where lease.owner=p_owner and lease.expires_at>now()) then
    return 'busy';
  end if;
  return public.claim_meta_owner_erasure_core_018(
    p_owner,p_lease_id,p_ttl_seconds);
end;
$$;

create or replace function public.arm_persona_media_erasure_tombstone_service_065(
  p_owner uuid,p_lease_id uuid
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_owner_hash text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0));
  if not exists(select 1 from public.meta_owner_erasure_leases lease
    where lease.owner=p_owner and lease.lease_id=p_lease_id
      and lease.expires_at>now() for update) then
    raise exception 'Active owner erasure lease required';
  end if;
  v_owner_hash:=public.persona_media_owner_hash_065(p_owner);
  insert into public.persona_media_erasure_tombstones_065 as tombstone(
    owner_hash,lease_id,blocked_until
  ) values(v_owner_hash,p_lease_id,now()+interval '10 minutes')
  on conflict(owner_hash) do update set
    lease_id=excluded.lease_id,
    blocked_until=greatest(tombstone.blocked_until,excluded.blocked_until),
    updated_at=now();
  return true;
end;
$$;

-- Every normal release leaves a bounded hashed-owner cooldown. Full account
-- erasure explicitly arms it before deleting the profile (and therefore the
-- FK-backed lease), while keep-account erasure reaches this wrapper.
do $migration$
begin
  if to_regprocedure('public.release_meta_owner_erasure_core_018(uuid,uuid)')
     is null then
    alter function public.release_meta_owner_erasure(uuid,uuid)
      rename to release_meta_owner_erasure_core_018;
  end if;
end
$migration$;
create or replace function public.release_meta_owner_erasure(
  p_owner uuid,p_lease_id uuid
)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform public.arm_persona_media_erasure_tombstone_service_065(
    p_owner,p_lease_id);
  return public.release_meta_owner_erasure_core_018(p_owner,p_lease_id);
end;
$$;

-- Forward-wrap the canonical 063 registrar so every normal upload is bound to
-- a live owner/path lease and therefore cannot repopulate during erasure.
do $migration$
begin
  if to_regprocedure(
    'public.register_persona_media_asset_core_063(uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,uuid,text)'
  ) is null then
    alter function public.register_persona_media_asset_service(
      uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,uuid,text
    ) rename to register_persona_media_asset_core_063;
  end if;
end
$migration$;
create or replace function public.register_persona_media_asset_service(
  p_owner uuid,p_persona_id uuid,p_media_type text,p_storage_path text,
  p_public_url text,p_mime_type text,p_byte_size bigint,p_origin text,
  p_ai_use text,p_source_sha256 text,p_content_sha256 text,
  p_watermark_state text,p_watermark_version text,p_watermark_asset_sha256 text,
  p_generation_event_id uuid,p_rendition text,p_upload_lease_id uuid
)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform public.assert_persona_media_upload_lease_065(
    p_owner,p_upload_lease_id,p_storage_path);
  return public.register_persona_media_asset_core_063(
    p_owner,p_persona_id,p_media_type,p_storage_path,p_public_url,p_mime_type,
    p_byte_size,p_origin,p_ai_use,p_source_sha256,p_content_sha256,
    p_watermark_state,p_watermark_version,p_watermark_asset_sha256,
    p_generation_event_id,p_rendition);
end;
$$;

-- The 064 inventory clears preview metadata when a Storage object changes or
-- disappears. Clear the new revision in the same row mutation, then supersede
-- every declaration that was bound to the retired preview.
create or replace function public.normalize_legacy_media_preview_revision_065()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.previewed_at is null then new.preview_revision:=null; end if;
  return new;
end;
$$;
drop trigger if exists normalize_legacy_media_preview_revision_065
  on public.legacy_media_sources;
create trigger normalize_legacy_media_preview_revision_065
  before insert or update on public.legacy_media_sources
  for each row execute function public.normalize_legacy_media_preview_revision_065();

create or replace function public.supersede_legacy_media_source_revision_065()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.preview_revision is distinct from old.preview_revision then
    update public.legacy_media_references reference set preview_revision=null
    where reference.owner=old.owner and reference.source_id=old.id
      and reference.state not in('imported','cleared','erased');
    update public.legacy_media_declarations_065 declaration set
      state='superseded',superseded_at=clock_timestamp()
    where declaration.owner=old.owner and declaration.source_id=old.id
      and declaration.state='active'
      and declaration.preview_revision is distinct from new.preview_revision;
  end if;
  return new;
end;
$$;
drop trigger if exists supersede_legacy_media_source_revision_065
  on public.legacy_media_sources;
create trigger supersede_legacy_media_source_revision_065
  after update of preview_revision on public.legacy_media_sources
  for each row execute function public.supersede_legacy_media_source_revision_065();

create or replace function public.guard_legacy_media_import_binding_065()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then raise exception 'Legacy import audit rows are immutable'; end if;
  if not exists(select 1
    from public.persona_media_assets asset
    join public.persona_public_media_handles handle on handle.public_id=new.public_id
    where asset.id=new.asset_id and asset.owner=new.owner
      and asset.persona_id=new.persona_id and asset.status='active'
      and asset.declaration_source='import' and asset.origin='imported'
      and handle.asset_id=asset.id and handle.owner=new.owner
      and handle.persona_id=new.persona_id and handle.state='active') then
    raise exception 'Imported asset and opaque handle binding is invalid';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_legacy_media_import_binding_065
  on public.legacy_media_imports_065;
create trigger guard_legacy_media_import_binding_065
  before insert or update on public.legacy_media_imports_065
  for each row execute function public.guard_legacy_media_import_binding_065();

-- Preserve the reviewed 064 inventory body behind an erasure-aware wrapper.
-- Reapplication detects the already-renamed core and only replaces the wrapper.
do $migration$
begin
  if to_regprocedure(
    'public.inventory_legacy_media_references_core_064(uuid,integer)'
  ) is null then
    alter function public.inventory_legacy_media_references_service(uuid,integer)
      rename to inventory_legacy_media_references_core_064;
  end if;
end
$migration$;

create or replace function public.inventory_legacy_media_references_service(
  p_owner uuid,p_limit integer default 250
)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform public.assert_legacy_media_owner_available_065(p_owner);
  return public.inventory_legacy_media_references_core_064(p_owner,p_limit);
end;
$$;
revoke all on function public.inventory_legacy_media_references_core_064(uuid,integer),
  public.inventory_legacy_media_references_service(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.inventory_legacy_media_references_service(uuid,integer)
  to service_role;

create or replace function public.list_legacy_media_references_service(
  p_owner uuid,p_after uuid default null,p_limit integer default 50
)
returns table(
  item_id uuid,source_item_id uuid,persona_id uuid,persona_label text,
  persona_handle text,consumer text,slot text,purpose text,rendition text,
  state text,can_preview boolean,previewed boolean,detected_mime text,
  byte_size bigint,shared_reference_count bigint
)
language plpgsql security definer stable set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_owner is null or p_limit not between 1 and 100 then
    raise exception 'Invalid legacy media list request';
  end if;
  if p_after is not null and not exists(select 1
    from public.legacy_media_references reference
    where reference.id=p_after and reference.owner=p_owner) then return; end if;
  return query
  select reference.id,source.id,reference.persona_id,
    left(coalesce(persona.name,''),160),coalesce(persona.handle,''),
    reference.consumer,reference.slot,reference.purpose,reference.rendition,
    case when reference.state='pending' and source.state='missing' then 'missing'
      else reference.state end,
    source.id is not null and source.state='available'
      and reference.state in('pending','blocked_persona','blocked_shared_product'),
    reference.preview_revision is not null,coalesce(source.detected_mime,''),
    coalesce(source.preview_byte_size,0),
    case when source.id is null then 1 else (
      select count(*) from public.legacy_media_references sibling
      where sibling.owner=p_owner and sibling.source_id=source.id
        and sibling.state not in('stale','erased')) end
  from public.legacy_media_references reference
  left join public.legacy_media_sources source
    on source.id=reference.source_id and source.owner=reference.owner
  left join public.personas persona
    on persona.id=reference.persona_id and persona.owner=reference.owner
  where reference.owner=p_owner and reference.state<>'erased'
    and (p_after is null or reference.id>p_after)
  order by reference.id limit p_limit;
end;
$$;

alter table public.legacy_media_remediation_rate_limits_064
  drop constraint if exists legacy_media_remediation_rate_limits_064_scope_check;
alter table public.legacy_media_remediation_rate_limits_064
  add constraint legacy_media_remediation_rate_limits_064_scope_check
  check(scope in('all','inventory','list','preview','declare','import','clear'));

create or replace function public.consume_legacy_media_remediation_rate_service(
  p_owner uuid,p_action text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  v_now timestamptz:=clock_timestamp();v_scope text;v_limit integer;v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_owner is null or p_action not in(
    'inventory','list','preview','declare','import','clear'
  ) or not exists(select 1 from public.profiles profile where profile.id=p_owner) then
    return false;
  end if;
  perform public.assert_legacy_media_owner_available_065(p_owner);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'legacy-media-rate'||E'\u001f'||p_owner::text,64064064));
  foreach v_scope in array array['all',p_action] loop
    v_limit:=case v_scope when 'all' then 90 when 'inventory' then 10
      when 'list' then 60 when 'preview' then 30 when 'declare' then 20
      when 'import' then 10 else 20 end;
    insert into public.legacy_media_remediation_rate_limits_064 as rate(
      owner,scope,window_started,request_count
    ) values(p_owner,v_scope,v_now,1)
    on conflict(owner,scope) do update set
      window_started=case when rate.window_started<=v_now-interval '1 minute'
        then v_now else rate.window_started end,
      request_count=case when rate.window_started<=v_now-interval '1 minute'
        then 1 else rate.request_count+1 end
    returning request_count into v_count;
    if v_count>v_limit then return false; end if;
  end loop;
  return true;
end;
$$;

-- A fresh successful preview always produces a fresh opaque revision. Any
-- earlier declaration is superseded even when the bytes happen to be equal;
-- the owner must declare the exact preview they are acting on.
create or replace function public.record_legacy_media_preview_service(
  p_owner uuid,p_item_id uuid,p_object_id uuid,p_object_updated_at timestamptz,
  p_source_sha256 text,p_byte_size bigint,p_detected_mime text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  v_count integer;v_source_id uuid;v_revision uuid:=gen_random_uuid();
  v_source_revision uuid:=gen_random_uuid();
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_source_sha256!~'^[0-9a-f]{64}$' or p_byte_size not between 1 and 15728640
     or p_detected_mime not in(
       'image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm'
     ) then return false; end if;
  perform public.assert_legacy_media_owner_available_065(p_owner);
  update public.legacy_media_sources source set
    object_id=p_object_id,object_updated_at=p_object_updated_at,
    storage_byte_size=p_byte_size,source_sha256=p_source_sha256,
    detected_mime=p_detected_mime,preview_byte_size=p_byte_size,
    previewed_at=clock_timestamp(),
    preview_revision=case when source.object_id is not distinct from p_object_id
        and source.object_updated_at is not distinct from p_object_updated_at
        and source.source_sha256=p_source_sha256
        and source.preview_byte_size=p_byte_size
        and source.detected_mime=p_detected_mime
      then coalesce(source.preview_revision,v_source_revision)
      else v_source_revision end,
    state='available',updated_at=clock_timestamp()
  from public.legacy_media_references reference,storage.objects object
  where reference.id=p_item_id and reference.owner=p_owner
    and reference.source_id=source.id and source.owner=p_owner
    and reference.state in('pending','blocked_persona','blocked_shared_product')
    and object.id=p_object_id and object.bucket_id='media'
    and object.name=source.storage_path
    and object.updated_at is not distinct from p_object_updated_at
    and exists(select 1 from public.legacy_media_candidates_service_064(p_owner) current_reference
      where current_reference.consumer=reference.consumer
        and current_reference.row_id=reference.row_id
        and current_reference.slot=reference.slot
        and current_reference.url=reference.legacy_url);
  get diagnostics v_count=row_count;
  if v_count<>1 then return false; end if;
  select reference.source_id into v_source_id
  from public.legacy_media_references reference
  where reference.id=p_item_id and reference.owner=p_owner;
  update public.legacy_media_references reference set
    preview_revision=v_revision,updated_at=clock_timestamp()
  where reference.id=p_item_id and reference.owner=p_owner
    and reference.source_id=v_source_id
    and reference.state in('pending','blocked_persona','blocked_shared_product');
  get diagnostics v_count=row_count;
  if v_count<>1 then return false; end if;
  update public.legacy_media_declarations_065 declaration set
    state='superseded',superseded_at=clock_timestamp()
  where declaration.owner=p_owner and declaration.reference_id=p_item_id
    and declaration.state='active' and declaration.preview_revision<>v_revision;
  return true;
end;
$$;

-- If inventory detects a different source, URL, or persona binding for a
-- stable item id, old authority becomes unusable before the new binding lands.
create or replace function public.supersede_legacy_media_binding_065()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if row(new.source_id,new.persona_id,new.legacy_url_sha256)
     is distinct from row(old.source_id,old.persona_id,old.legacy_url_sha256)
     or (old.state in('imported','cleared')
       and new.state not in('imported','cleared','erased','stale')) then
    update public.legacy_media_declarations_065 declaration set
      state='superseded',superseded_at=clock_timestamp()
    where declaration.owner=old.owner and declaration.reference_id=old.id
      and declaration.state='active';
    new.preview_revision:=null;
  elsif old.state not in('imported','cleared','stale','erased')
      and new.state='stale' then
    update public.legacy_media_declarations_065 declaration set
      state='superseded',superseded_at=clock_timestamp()
    where declaration.owner=old.owner and declaration.reference_id=old.id
      and declaration.state='active';
    new.preview_revision:=null;
  elsif old.state in('imported','cleared') and new.state='stale' then
    -- The 064 stale sweep means the legacy URL is no longer present. Preserve
    -- terminal audit/current-binding state; an actual URL restoration is an
    -- upsert to pending and takes the superseding branch above.
    new.state:=old.state;
  end if;
  return new;
end;
$$;
drop trigger if exists supersede_legacy_media_binding_065
  on public.legacy_media_references;
create trigger supersede_legacy_media_binding_065
  before update on public.legacy_media_references
  for each row execute function public.supersede_legacy_media_binding_065();

create or replace function public.declare_legacy_media_reference_service(
  p_owner uuid,p_item_id uuid,p_ai_use text
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_reference public.legacy_media_references%rowtype;
  v_source public.legacy_media_sources%rowtype;
  v_existing uuid;v_id uuid;v_object_size bigint;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_ai_use not in('none','assisted','generated','unknown') then
    raise exception 'An explicit AI-use declaration is required';
  end if;
  perform public.assert_legacy_media_owner_available_065(p_owner);
  select * into v_reference from public.legacy_media_references reference
  where reference.id=p_item_id and reference.owner=p_owner;
  if not found or v_reference.persona_id is null or v_reference.state<>'pending'
     or v_reference.source_id is null then raise exception 'Reference is not declarable'; end if;
  perform public.lock_persona_publication_mutation(v_reference.persona_id);
  select * into v_reference from public.legacy_media_references reference
  where reference.id=p_item_id and reference.owner=p_owner for update;
  select * into v_source from public.legacy_media_sources source
  where source.id=v_reference.source_id and source.owner=p_owner for update;
  if not found or v_reference.preview_revision is null
     or v_source.state<>'available' or v_source.preview_revision is null
     or v_source.previewed_at is null or v_source.source_sha256!~'^[0-9a-f]{64}$'
     or v_source.preview_byte_size not between 1 and 15728640 then
    raise exception 'Preview the current bytes before declaring';
  end if;
  if not exists(select 1 from public.legacy_media_candidates_service_064(p_owner) candidate
    where candidate.consumer=v_reference.consumer and candidate.row_id=v_reference.row_id
      and candidate.slot=v_reference.slot and candidate.url=v_reference.legacy_url
      and candidate.persona_id=v_reference.persona_id and candidate.blocking_reason='') then
    raise exception 'Reference changed after inventory';
  end if;
  select case when coalesce(object.metadata->>'size','')~'^[0-9]{1,18}$'
      then (object.metadata->>'size')::bigint else 0 end
  into v_object_size from storage.objects object
  where object.id=v_source.object_id and object.bucket_id='media'
    and object.name=v_source.storage_path
    and object.updated_at is not distinct from v_source.object_updated_at;
  if not found or v_object_size<>v_source.preview_byte_size then
    raise exception 'Preview revision is no longer current';
  end if;
  if v_source.detected_mime not in('image/png','image/jpeg','image/webp') then
    raise exception 'Legacy canonical import requires a static raster';
  end if;
  select declaration.id into v_existing
  from public.legacy_media_declarations_065 declaration
  where declaration.owner=p_owner and declaration.reference_id=p_item_id
    and declaration.preview_revision=v_reference.preview_revision;
  if found then
    if exists(select 1 from public.legacy_media_declarations_065 declaration
      where declaration.id=v_existing and declaration.ai_use=p_ai_use
        and declaration.state='active') then return v_existing; end if;
    raise exception 'Preview again before changing the declaration';
  end if;
  if exists(select 1 from public.legacy_media_declarations_065 declaration
    where declaration.owner=p_owner and declaration.source_id=v_source.id
      and declaration.object_id=v_source.object_id
      and declaration.object_updated_at is not distinct from v_source.object_updated_at
      and declaration.source_sha256=v_source.source_sha256
      and declaration.byte_size=v_source.preview_byte_size
      and declaration.detected_mime=v_source.detected_mime
      and declaration.state<>'erased' and declaration.ai_use<>p_ai_use) then
    raise exception 'This exact source revision already has a different AI-use authority';
  end if;
  update public.legacy_media_declarations_065 declaration set
    state='superseded',superseded_at=clock_timestamp()
  where declaration.owner=p_owner and declaration.reference_id=p_item_id
    and declaration.state='active';
  insert into public.legacy_media_declarations_065(
    owner,reference_id,source_id,persona_id,preview_revision,
    legacy_url_sha256,object_id,object_updated_at,source_sha256,byte_size,
    detected_mime,ai_use,declared_by
  ) values(
    p_owner,v_reference.id,v_source.id,v_reference.persona_id,v_reference.preview_revision,
    v_reference.legacy_url_sha256,v_source.object_id,v_source.object_updated_at,
    v_source.source_sha256,v_source.preview_byte_size,v_source.detected_mime,
    p_ai_use,p_owner
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.legacy_media_import_binding_current_065(
  p_owner uuid,p_import_id uuid
)
returns boolean language plpgsql security definer stable set search_path='' as $$
declare
  v_import public.legacy_media_imports_065%rowtype;
  v_reference public.legacy_media_references%rowtype;
  v_url text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select imported.* into v_import
  from public.legacy_media_imports_065 imported
  join public.legacy_media_declarations_065 declaration
    on declaration.id=imported.declaration_id and declaration.owner=imported.owner
  join public.persona_media_assets asset
    on asset.id=imported.asset_id and asset.owner=imported.owner
      and asset.persona_id=imported.persona_id and asset.status='active'
      and asset.origin='imported' and asset.declaration_source='import'
  join public.persona_public_media_handles handle
    on handle.public_id=imported.public_id and handle.asset_id=imported.asset_id
      and handle.owner=imported.owner and handle.persona_id=imported.persona_id
      and handle.state='active'
  where imported.id=p_import_id and imported.owner=p_owner
    and imported.state='applied';
  if not found then return false; end if;
  select * into v_reference from public.legacy_media_references reference
  where reference.id=v_import.reference_id and reference.owner=p_owner
    and reference.persona_id=v_import.persona_id and reference.state='imported';
  if not found then return false; end if;
  v_url:=public.public_media_delivery_url(v_import.public_id);
  return case v_reference.consumer
    when 'persona' then exists(select 1 from public.personas persona
      where persona.id=v_reference.row_id and persona.owner=p_owner and (
        v_reference.slot='avatar' and persona.avatar_url=v_url
          and persona.avatar_media_asset_id=v_import.asset_id
        or v_reference.slot='banner' and persona.banner_url=v_url
          and persona.banner_media_asset_id=v_import.asset_id
        or v_reference.slot='background' and persona.bg_url=v_url
          and persona.bg_media_asset_id=v_import.asset_id
        or v_reference.slot='feed_header' and persona.feed_img_url=v_url
          and persona.feed_media_asset_id=v_import.asset_id))
    when 'post' then exists(select 1 from public.posts post
      where post.id=v_reference.row_id and post.persona_id=v_import.persona_id
        and post.media_url=v_url and post.media_asset_id=v_import.asset_id)
    when 'album_item' then exists(select 1 from public.album_items item
      join public.albums album on album.id=item.album_id
      where item.id=v_reference.row_id and album.persona_id=v_import.persona_id
        and item.thumb_url=v_url and item.media_asset_id=v_import.asset_id)
    when 'draft' then exists(select 1 from public.drafts draft
      where draft.id=v_reference.row_id and draft.owner=p_owner
        and draft.persona_id=v_import.persona_id and draft.media_url=v_url
        and draft.media_asset_id=v_import.asset_id)
    when 'post_draft' then exists(select 1 from public.post_drafts draft
      where draft.id=v_reference.row_id and draft.owner=p_owner
        and draft.persona_id=v_import.persona_id and (
          v_reference.slot='source' and draft.source_image_url=v_url
            and draft.source_media_asset_id=v_import.asset_id
          or v_reference.slot='facebook' and draft.fb_image_url=v_url
            and draft.fb_media_asset_id=v_import.asset_id
          or v_reference.slot='instagram' and draft.ig_image_url=v_url
            and draft.ig_media_asset_id=v_import.asset_id
          or v_reference.slot='x' and draft.x_image_url=v_url
            and draft.x_media_asset_id=v_import.asset_id))
    when 'affiliate_product' then exists(select 1
      from public.affiliate_products product
      where product.id=v_reference.row_id and product.owner=p_owner
        and product.image_url=v_url
        and exists(select 1 from public.persona_affiliate_offers offer
          where offer.product_id=product.id and offer.owner=p_owner
            and offer.persona_id=v_import.persona_id and offer.status='active')
        and not exists(select 1 from public.persona_affiliate_offers other_offer
          where other_offer.product_id=product.id and other_offer.owner=p_owner
            and other_offer.persona_id<>v_import.persona_id
            and other_offer.status='active'))
    else false
  end;
end;
$$;

create or replace function public.legacy_media_import_status_service(
  p_owner uuid,p_declaration_id uuid
)
returns table(state text,import_id uuid)
language plpgsql security definer stable set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  return query
  select case when imported.id is not null and imported.state='applied'
        and public.legacy_media_import_binding_current_065(
          declaration.owner,imported.id) then 'applied'
      when declaration.state='active' and imported.id is null
        then 'declared' else 'superseded' end,
    imported.id
  from public.legacy_media_declarations_065 declaration
  left join public.legacy_media_imports_065 imported
    on imported.declaration_id=declaration.id and imported.owner=declaration.owner
  where declaration.id=p_declaration_id and declaration.owner=p_owner
  limit 1;
end;
$$;

create or replace function public.resolve_legacy_media_import_service(
  p_owner uuid,p_declaration_id uuid
)
returns table(
  bucket text,storage_path text,object_id uuid,object_updated_at timestamptz,
  expected_byte_size bigint,source_sha256 text,detected_mime text,
  ai_use text,persona_id uuid,purpose text,rendition text
)
language plpgsql security definer set search_path='' as $$
declare v_declaration public.legacy_media_declarations_065%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform public.assert_legacy_media_owner_available_065(p_owner);
  select * into v_declaration from public.legacy_media_declarations_065 declaration
  where declaration.id=p_declaration_id and declaration.owner=p_owner;
  if not found or v_declaration.state<>'active' then return; end if;
  perform public.lock_persona_publication_mutation(v_declaration.persona_id);
  return query
  select 'media'::text,source.storage_path,object.id,object.updated_at,
    declaration.byte_size,declaration.source_sha256,declaration.detected_mime,
    declaration.ai_use,declaration.persona_id,reference.purpose,reference.rendition
  from public.legacy_media_declarations_065 declaration
  join public.legacy_media_references reference
    on reference.id=declaration.reference_id and reference.owner=declaration.owner
  join public.legacy_media_sources source
    on source.id=declaration.source_id and source.owner=declaration.owner
  join storage.objects object on object.id=declaration.object_id
    and object.bucket_id='media' and object.name=source.storage_path
    and object.updated_at is not distinct from declaration.object_updated_at
  join public.legacy_media_candidates_service_064(p_owner) candidate
    on candidate.consumer=reference.consumer and candidate.row_id=reference.row_id
      and candidate.slot=reference.slot and candidate.url=reference.legacy_url
      and candidate.persona_id=declaration.persona_id and candidate.blocking_reason=''
  where declaration.id=p_declaration_id and declaration.owner=p_owner
    and declaration.state='active' and reference.state='pending'
    and reference.persona_id=declaration.persona_id
    and reference.source_id=declaration.source_id
    and reference.legacy_url_sha256=declaration.legacy_url_sha256
    and reference.preview_revision=declaration.preview_revision
    and source.preview_revision is not null
    and source.object_id=declaration.object_id
    and source.object_updated_at is not distinct from declaration.object_updated_at
    and source.source_sha256=declaration.source_sha256
    and source.preview_byte_size=declaration.byte_size
    and source.detected_mime=declaration.detected_mime
    and case when coalesce(object.metadata->>'size','')~'^[0-9]{1,18}$'
      then (object.metadata->>'size')::bigint else 0 end=declaration.byte_size
  limit 1;
end;
$$;

-- Imported assets have their own authority instead of being mislabeled as a
-- fresh browser upload. Physical paths, quotas, immutability, and provenance
-- hashing otherwise retain the 063 registrar contract.
create or replace function public.register_imported_persona_media_asset_service_065(
  p_owner uuid,p_persona_id uuid,p_media_type text,p_storage_path text,
  p_public_url text,p_mime_type text,p_byte_size bigint,p_ai_use text,
  p_source_sha256 text,p_content_sha256 text,p_watermark_state text,
  p_watermark_version text,p_watermark_asset_sha256 text,p_purpose text,
  p_rendition text,p_destination_object_id uuid,
  p_destination_updated_at timestamptz
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_id uuid;v_provenance text;v_expected_path text;v_extension text;
  v_daily_count bigint;v_total_bytes bigint;v_asset_count bigint;
  v_persona_bytes bigint;v_persona_count bigint;v_object_size bigint;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=p_owner) then
    raise exception 'Owned persona not found';
  end if;
  if p_media_type<>'image'
     or p_ai_use not in('none','assisted','generated','unknown')
     or p_source_sha256!~'^[0-9a-f]{64}$' or p_content_sha256!~'^[0-9a-f]{64}$'
     or p_mime_type not in('image/png','image/jpeg','image/webp')
     or p_byte_size not between 1 and 10485760
     or p_purpose!~'^[a-z0-9_-]{1,64}(/[a-z0-9_-]{1,64}){0,4}$'
     or p_rendition not in('original','facebook','instagram','x') then
    raise exception 'Invalid imported media provenance';
  end if;
  if p_ai_use='none' then
    if p_watermark_state<>'not_required' or p_watermark_version<>''
       or p_watermark_asset_sha256<>''
       or (p_source_sha256<>p_content_sha256 and (
         p_rendition not in('facebook','instagram','x')
         or p_mime_type not in('image/png','image/jpeg','image/webp')
       )) then raise exception 'No-AI import may differ only as an exact social rendition'; end if;
  elsif p_source_sha256=p_content_sha256
     or p_watermark_state<>'system_applied'
     or p_watermark_version<>'mypersonas-ai-watermark-v1'
     or p_watermark_asset_sha256<>'c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2'
     or p_mime_type not in('image/png','image/jpeg','image/webp') then
    raise exception 'AI-used import requires a distinct server-watermarked static raster';
  end if;
  v_extension:=case p_mime_type when 'image/png' then 'png'
    when 'image/jpeg' then 'jpg' when 'image/webp' then 'webp' else '' end;
  v_expected_path:=lower(p_owner::text)||'/published/provenance/'||p_ai_use
    ||'/imported/'||lower(p_persona_id::text)||'/'||p_purpose
    ||'/legacy_'||p_rendition||'/'||p_content_sha256||'.'||v_extension;
  if p_storage_path<>v_expected_path
     or p_public_url<>'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'
       ||p_storage_path then raise exception 'Imported media path is not canonical'; end if;
  select case when coalesce(object.metadata->>'size','')~'^[0-9]{1,18}$'
      then (object.metadata->>'size')::bigint else 0 end
  into v_object_size from storage.objects object
  where object.id=p_destination_object_id and object.bucket_id='persona-media'
    and object.name=p_storage_path
    and object.updated_at is not distinct from p_destination_updated_at;
  if not found or v_object_size<>p_byte_size or not exists(
    select 1 from storage.objects object
    where object.id=p_destination_object_id and object.bucket_id='persona-media'
      and object.name=p_storage_path
      and object.updated_at is not distinct from p_destination_updated_at
      and coalesce(object.metadata->>'mimetype','')=p_mime_type
  ) then
    raise exception 'Imported immutable bytes are missing or changed';
  end if;
  v_provenance:=encode(extensions.digest(convert_to(jsonb_build_array(
    p_owner,p_persona_id,p_media_type,p_storage_path,p_public_url,p_mime_type,
    p_byte_size,'imported',p_ai_use,'import',p_source_sha256,p_content_sha256,
    p_watermark_state,p_watermark_version,
    case when p_ai_use='none' then '' else 'bottom_right' end,
    p_watermark_asset_sha256,null,p_rendition
  )::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'persona-media-owner-quota'||E'\u001f'||p_owner::text,59059059));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner::text||E'\u001f'||p_public_url,59059059));
  select asset.id into v_id from public.persona_media_assets asset
  where asset.owner=p_owner and asset.public_url=p_public_url;
  if found then
    if not exists(select 1 from public.persona_media_assets asset
      where asset.id=v_id and asset.persona_id=p_persona_id
        and asset.content_sha256=p_content_sha256
        and asset.source_sha256=p_source_sha256 and asset.ai_use=p_ai_use
        and asset.origin='imported' and asset.declaration_source='import'
        and asset.provenance_sha256=v_provenance and asset.status='active') then
      raise exception 'Existing imported URL has different authority';
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
  insert into public.persona_media_assets(
    owner,persona_id,media_type,storage_path,public_url,source,
    generation_backend,metadata,status,origin,ai_use,declaration_source,
    declared_by,declared_at,generated_on_site,source_sha256,content_sha256,
    mime_type,byte_size,watermark_state,watermark_version,watermark_position,
    watermark_asset_sha256,provenance_sha256,generation_event_id,rendition
  ) values(
    p_owner,p_persona_id,p_media_type,p_storage_path,p_public_url,'sourced',
    null,jsonb_build_object('rendition',p_rendition,'legacy_remediation','065'),
    'active','imported',p_ai_use,'import',p_owner,now(),false,
    p_source_sha256,p_content_sha256,p_mime_type,p_byte_size,
    p_watermark_state,p_watermark_version,
    case when p_ai_use='none' then '' else 'bottom_right' end,
    p_watermark_asset_sha256,v_provenance,null,p_rendition
  ) returning id into v_id;
  return v_id;
end;
$$;

-- 062's canonical eligibility predated the explicit imported authority. The
-- only expansion is the new `/imported/` path segment; every other provenance,
-- byte, status, and persona binding remains unchanged.
create or replace function public.persona_media_asset_canonical_eligible_062(
  p_asset public.persona_media_assets
)
returns boolean language sql immutable set search_path='' as $$
  select p_asset.status='active' and p_asset.declaration_source<>'legacy'
    and p_asset.content_sha256~'^[0-9a-f]{64}$'
    and p_asset.provenance_sha256~'^[0-9a-f]{64}$'
    and p_asset.byte_size between 1 and 15728640
    and p_asset.mime_type in('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')
    and (p_asset.origin<>'imported' or (
      p_asset.declaration_source='import'
      and p_asset.media_type='image'
      and p_asset.mime_type in('image/png','image/jpeg','image/webp')
    ))
    and (p_asset.ai_use='none' and p_asset.watermark_state='not_required'
      or p_asset.ai_use<>'none' and p_asset.watermark_state='system_applied')
    and (
      p_asset.storage_path~(
        '^'||lower(p_asset.owner::text)
        ||'/published/provenance/(none|assisted|generated|unknown)/(uploaded|generated)/'
        ||lower(p_asset.persona_id::text)||'/(?:[a-z0-9_-]+/){1,6}'
        ||p_asset.content_sha256||'[.](png|jpg|webp|gif|mp4|webm)$')
      or p_asset.storage_path~(
        '^'||lower(p_asset.owner::text)
        ||'/published/provenance/(none|assisted|generated|unknown)/imported/'
        ||lower(p_asset.persona_id::text)||'/(?:[a-z0-9_-]+/){1,6}'
        ||p_asset.content_sha256||'[.](png|jpg|webp)$')
    )
    and p_asset.public_url=
      'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'
      ||p_asset.storage_path
$$;

create or replace function public.resolve_persona_media_asset_service(
  p_owner uuid,p_asset_id uuid
)
returns table(
  bucket text,storage_path text,mime_type text,byte_size bigint,
  content_sha256 text
)
language plpgsql security definer stable set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_owner is null or p_asset_id is null then return; end if;
  return query
  select 'persona-media'::text,asset.storage_path,asset.mime_type,
    asset.byte_size,asset.content_sha256
  from public.persona_media_assets asset
  join public.personas persona on persona.id=asset.persona_id and persona.owner=asset.owner
  where asset.id=p_asset_id and asset.owner=p_owner and asset.status='active'
    and asset.declaration_source<>'legacy'
    and asset.byte_size between 1 and 15728640
    and asset.mime_type in('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')
    and (asset.origin<>'imported' or (
      asset.declaration_source='import' and asset.media_type='image'
      and asset.mime_type in('image/png','image/jpeg','image/webp')
    ))
    and asset.content_sha256~'^[0-9a-f]{64}$'
    and asset.provenance_sha256~'^[0-9a-f]{64}$'
    and (asset.ai_use='none' and asset.watermark_state='not_required'
      or asset.ai_use<>'none' and asset.watermark_state='system_applied')
    and (
      asset.storage_path~(
        '^'||lower(asset.owner::text)
        ||'/published/provenance/(none|assisted|generated|unknown)/(uploaded|generated)/'
        ||lower(asset.persona_id::text)||'/(?:[a-z0-9_-]+/){1,6}'
        ||asset.content_sha256||'[.](png|jpg|webp|gif|mp4|webm)$')
      or asset.storage_path~(
        '^'||lower(asset.owner::text)
        ||'/published/provenance/(none|assisted|generated|unknown)/imported/'
        ||lower(asset.persona_id::text)||'/(?:[a-z0-9_-]+/){1,6}'
        ||asset.content_sha256||'[.](png|jpg|webp)$')
    )
    and asset.public_url=
      'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'
      ||asset.storage_path
  limit 1;
end;
$$;

-- Bind the exact immutable destination Storage row after upload and exact-byte
-- re-download. The commit RPC re-locks this identity and timestamp, closing the
-- verify/register TOCTOU window without exposing Storage details to a browser.
create or replace function public.resolve_legacy_media_destination_service_065(
  p_owner uuid,p_declaration_id uuid,p_storage_path text,
  p_content_sha256 text,p_content_byte_size bigint,p_mime_type text,
  p_upload_lease_id uuid
)
returns table(object_id uuid,object_updated_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare
  v_declaration public.legacy_media_declarations_065%rowtype;
  v_reference public.legacy_media_references%rowtype;
  v_extension text;v_expected_path text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform public.assert_legacy_media_owner_available_065(p_owner);
  perform public.assert_persona_media_upload_lease_065(
    p_owner,p_upload_lease_id,p_storage_path);
  select * into v_declaration from public.legacy_media_declarations_065 declaration
  where declaration.id=p_declaration_id and declaration.owner=p_owner
    and declaration.state='active';
  if not found then return; end if;
  select * into v_reference from public.legacy_media_references reference
  where reference.id=v_declaration.reference_id and reference.owner=p_owner
    and reference.persona_id=v_declaration.persona_id
    and reference.source_id=v_declaration.source_id and reference.state='pending';
  if not found or p_content_sha256!~'^[0-9a-f]{64}$'
     or p_content_byte_size not between 1 and 10485760
     or p_mime_type<>v_declaration.detected_mime
     or p_mime_type not in('image/png','image/jpeg','image/webp')
     or v_reference.purpose!~'^[a-z0-9_-]{1,64}(/[a-z0-9_-]{1,64}){0,4}$'
     or v_reference.rendition not in('original','facebook','instagram','x') then
    return;
  end if;
  v_extension:=case p_mime_type when 'image/png' then 'png'
    when 'image/jpeg' then 'jpg' when 'image/webp' then 'webp' else '' end;
  v_expected_path:=lower(p_owner::text)||'/published/provenance/'
    ||v_declaration.ai_use||'/imported/'||lower(v_declaration.persona_id::text)
    ||'/'||v_reference.purpose||'/legacy_'||v_reference.rendition||'/'
    ||p_content_sha256||'.'||v_extension;
  if p_storage_path<>v_expected_path then return; end if;
  return query
  select object.id,object.updated_at from storage.objects object
  where object.bucket_id='persona-media' and object.name=v_expected_path
    and case when coalesce(object.metadata->>'size','')~'^[0-9]{1,18}$'
      then (object.metadata->>'size')::bigint else 0 end=p_content_byte_size
    and coalesce(object.metadata->>'mimetype','')=p_mime_type
  limit 1;
end;
$$;

-- Upload happens immediately before this RPC. Registration, opaque-handle
-- issuance, exact current-reference CAS, approval clearing, review invalidation,
-- and audit insertion are one database transaction. Any exception rolls all of
-- them back; the Edge caller removes only a newly-created unregistered object.
create or replace function public.commit_legacy_media_import_service_065(
  p_owner uuid,p_declaration_id uuid,p_storage_path text,p_public_url text,
  p_content_sha256 text,p_content_byte_size bigint,p_mime_type text,
  p_watermark_state text,p_watermark_version text,p_watermark_asset_sha256 text,
  p_destination_object_id uuid,p_destination_updated_at timestamptz,
  p_upload_lease_id uuid
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_declaration public.legacy_media_declarations_065%rowtype;
  v_reference public.legacy_media_references%rowtype;
  v_source public.legacy_media_sources%rowtype;
  v_existing uuid;v_asset_id uuid;v_public_id uuid;v_url text;v_import_id uuid;
  v_count integer;v_media_type text;v_extension text;v_expected_path text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform public.assert_legacy_media_owner_available_065(p_owner);
  perform public.assert_persona_media_upload_lease_065(
    p_owner,p_upload_lease_id,p_storage_path);
  select imported.id into v_existing
  from public.legacy_media_imports_065 imported
  where imported.owner=p_owner and imported.declaration_id=p_declaration_id
    and imported.state='applied';
  if found then
    if public.legacy_media_import_binding_current_065(p_owner,v_existing) then
      return v_existing;
    end if;
    raise exception 'An earlier import no longer matches the exact consumer binding';
  end if;
  select * into v_declaration from public.legacy_media_declarations_065 declaration
  where declaration.id=p_declaration_id and declaration.owner=p_owner;
  if not found or v_declaration.state<>'active' then raise exception 'Declaration is unavailable'; end if;
  perform public.lock_persona_publication_mutation(v_declaration.persona_id);
  select * into v_declaration from public.legacy_media_declarations_065 declaration
  where declaration.id=p_declaration_id and declaration.owner=p_owner for update;
  select * into v_reference from public.legacy_media_references reference
  where reference.id=v_declaration.reference_id and reference.owner=p_owner for update;
  select * into v_source from public.legacy_media_sources source
  where source.id=v_declaration.source_id and source.owner=p_owner for update;
  if v_declaration.state<>'active' or v_reference.state<>'pending'
     or v_reference.persona_id is distinct from v_declaration.persona_id
     or v_reference.source_id is distinct from v_declaration.source_id
     or v_reference.legacy_url_sha256<>v_declaration.legacy_url_sha256
     or v_reference.preview_revision is distinct from v_declaration.preview_revision
     or v_source.preview_revision is null
     or v_source.object_id is distinct from v_declaration.object_id
     or v_source.object_updated_at is distinct from v_declaration.object_updated_at
     or v_source.source_sha256<>v_declaration.source_sha256
     or v_source.preview_byte_size<>v_declaration.byte_size
     or v_source.detected_mime<>v_declaration.detected_mime then
    raise exception 'Declaration revision changed';
  end if;
  if p_mime_type<>v_declaration.detected_mime then
    raise exception 'Final MIME must match the previewed source MIME';
  end if;
  v_extension:=case p_mime_type when 'image/png' then 'png'
    when 'image/jpeg' then 'jpg' when 'image/webp' then 'webp'
    when 'image/gif' then 'gif' when 'video/mp4' then 'mp4'
    when 'video/webm' then 'webm' else '' end;
  if v_extension='' or v_reference.purpose!~'^[a-z0-9_-]{1,64}(/[a-z0-9_-]{1,64}){0,4}$' then
    raise exception 'Legacy import purpose is not canonical';
  end if;
  v_expected_path:=lower(p_owner::text)||'/published/provenance/'
    ||v_declaration.ai_use||'/imported/'||lower(v_declaration.persona_id::text)
    ||'/'||v_reference.purpose||'/legacy_'||v_reference.rendition||'/'
    ||p_content_sha256||'.'||v_extension;
  if p_storage_path<>v_expected_path or p_public_url<>
    'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'
      ||v_expected_path then raise exception 'Legacy import path does not match its exact binding'; end if;
  -- Serialize the exact legacy Storage object revision through the consumer
  -- CAS. An overwrite cannot pass the Edge re-hash and then replace the
  -- source row before this transaction commits.
  perform 1 from storage.objects object
  where object.id=v_declaration.object_id and object.bucket_id='media'
    and object.name=v_source.storage_path
    and object.updated_at is not distinct from v_declaration.object_updated_at
    and case when coalesce(object.metadata->>'size','')~'^[0-9]{1,18}$'
      then (object.metadata->>'size')::bigint else 0 end=v_declaration.byte_size
  for update;
  if not found then
    raise exception 'Legacy source object changed after exact-byte verification';
  end if;
  if not exists(select 1 from public.legacy_media_candidates_service_064(p_owner) candidate
       where candidate.consumer=v_reference.consumer and candidate.row_id=v_reference.row_id
         and candidate.slot=v_reference.slot and candidate.url=v_reference.legacy_url
         and candidate.persona_id=v_declaration.persona_id and candidate.blocking_reason='') then
    raise exception 'Reference or source changed before import';
  end if;
  if v_reference.consumer='post_draft' then
    if not exists(select 1 from public.post_drafts draft
      where draft.id=v_reference.row_id and draft.owner=p_owner
        and draft.persona_id=v_declaration.persona_id and draft.status='draft'
        and draft.scheduled_for is null and draft.posted_at is null
        and draft.fb_published_at is null and draft.ig_published_at is null
        and draft.fb_post_id is null and draft.ig_media_id is null
        and draft.x_tweet_id is null and draft.publish_claimed_at is null
        and draft.publish_facebook_page_id='' and draft.publish_instagram_business_id=''
      for update) then raise exception 'Queued or historical post drafts cannot be remediated'; end if;
  end if;
  if p_mime_type not in('image/png','image/jpeg','image/webp') then
    raise exception 'Legacy canonical import requires a static raster';
  end if;
  perform 1 from storage.objects object
  where object.id=p_destination_object_id and object.bucket_id='persona-media'
    and object.name=p_storage_path
    and object.updated_at is not distinct from p_destination_updated_at
    and case when coalesce(object.metadata->>'size','')~'^[0-9]{1,18}$'
      then (object.metadata->>'size')::bigint else 0 end=p_content_byte_size
    and coalesce(object.metadata->>'mimetype','')=p_mime_type
  for update;
  if not found then
    raise exception 'Canonical destination changed after exact-byte verification';
  end if;
  v_media_type:='image';
  v_asset_id:=public.register_imported_persona_media_asset_service_065(
    p_owner,v_declaration.persona_id,v_media_type,p_storage_path,p_public_url,
    p_mime_type,p_content_byte_size,v_declaration.ai_use,
    v_declaration.source_sha256,p_content_sha256,p_watermark_state,
    p_watermark_version,p_watermark_asset_sha256,v_reference.purpose,
    v_reference.rendition,p_destination_object_id,p_destination_updated_at);
  v_public_id:=public.issue_persona_public_media_handle_service(v_asset_id,false);
  v_url:=public.public_media_delivery_url(v_public_id);

  if v_reference.consumer='persona' then
    update public.personas persona set
      avatar_url=case when v_reference.slot='avatar' then v_url else persona.avatar_url end,
      banner_url=case when v_reference.slot='banner' then v_url else persona.banner_url end,
      bg_url=case when v_reference.slot='background' then v_url else persona.bg_url end,
      feed_img_url=case when v_reference.slot='feed_header' then v_url else persona.feed_img_url end
    where persona.id=v_reference.row_id and persona.owner=p_owner
      and ((v_reference.slot='avatar' and persona.avatar_url=v_reference.legacy_url)
        or (v_reference.slot='banner' and persona.banner_url=v_reference.legacy_url)
        or (v_reference.slot='background' and persona.bg_url=v_reference.legacy_url)
        or (v_reference.slot='feed_header' and persona.feed_img_url=v_reference.legacy_url));
  elsif v_reference.consumer='post' then
    update public.posts post set media_url=v_url
    where post.id=v_reference.row_id and post.persona_id=v_declaration.persona_id
      and post.media_url=v_reference.legacy_url;
  elsif v_reference.consumer='album_item' then
    update public.album_items item set thumb_url=v_url
    from public.albums album where item.id=v_reference.row_id
      and item.album_id=album.id and album.persona_id=v_declaration.persona_id
      and item.thumb_url=v_reference.legacy_url;
  elsif v_reference.consumer='draft' then
    update public.drafts draft set media_url=v_url
    where draft.id=v_reference.row_id and draft.owner=p_owner
      and draft.persona_id=v_declaration.persona_id
      and draft.media_url=v_reference.legacy_url;
  elsif v_reference.consumer='post_draft' then
    update public.post_drafts draft set
      source_image_url=case when v_reference.slot='source' then v_url else draft.source_image_url end,
      fb_image_url=case when v_reference.slot='facebook' then v_url else draft.fb_image_url end,
      ig_image_url=case when v_reference.slot='instagram' then v_url else draft.ig_image_url end,
      x_image_url=case when v_reference.slot='x' then v_url else draft.x_image_url end,
      status='draft',scheduled_for=null,approved_at=null,approved_by=null,
      approved_content_hash='',approved_timezone='',approved_facebook_page_id='',
      approved_instagram_business_id='',approved_fb_media_sha256='',
      approved_fb_media_mime='',approved_fb_media_bytes=0,approved_fb_media_path='',
      approved_fb_media_url='',approved_ig_media_sha256='',approved_ig_media_mime='',
      approved_ig_media_bytes=0,approved_ig_media_path='',approved_ig_media_url='',
      approved_fb_delivery_id=null,approved_ig_delivery_id=null,
      approved_fb_provenance_sha256='',approved_ig_provenance_sha256='',
      publish_facebook_page_id='',publish_instagram_business_id='',
      publish_claimed_at=null,media_provenance_required=true,last_error=null,updated_at=now()
    where draft.id=v_reference.row_id and draft.owner=p_owner
      and draft.persona_id=v_declaration.persona_id and draft.status='draft'
      and draft.scheduled_for is null and draft.posted_at is null
      and draft.fb_published_at is null and draft.ig_published_at is null
      and draft.fb_post_id is null and draft.ig_media_id is null
      and draft.x_tweet_id is null and draft.publish_claimed_at is null
      and draft.publish_facebook_page_id='' and draft.publish_instagram_business_id=''
      and ((v_reference.slot='source' and draft.source_image_url=v_reference.legacy_url)
        or (v_reference.slot='facebook' and draft.fb_image_url=v_reference.legacy_url)
        or (v_reference.slot='instagram' and draft.ig_image_url=v_reference.legacy_url)
        or (v_reference.slot='x' and draft.x_image_url=v_reference.legacy_url));
  elsif v_reference.consumer='affiliate_product' then
    update public.affiliate_products product set image_url=v_url,updated_at=now()
    where product.id=v_reference.row_id and product.owner=p_owner
      and product.image_url=v_reference.legacy_url
      and exists(select 1 from public.persona_affiliate_offers offer
        where offer.product_id=product.id and offer.owner=p_owner
          and offer.persona_id=v_declaration.persona_id and offer.status='active')
      and not exists(select 1 from public.persona_affiliate_offers other_offer
        where other_offer.product_id=product.id and other_offer.owner=p_owner
          and other_offer.persona_id<>v_declaration.persona_id
          and other_offer.status='active');
  else raise exception 'Unsupported reference consumer'; end if;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Reference changed before compare-and-swap'; end if;
  if not (
    v_reference.consumer='persona' and exists(select 1 from public.personas persona
      where persona.id=v_reference.row_id and persona.owner=p_owner and (
        v_reference.slot='avatar' and persona.avatar_media_asset_id=v_asset_id
        or v_reference.slot='banner' and persona.banner_media_asset_id=v_asset_id
        or v_reference.slot='background' and persona.bg_media_asset_id=v_asset_id
        or v_reference.slot='feed_header' and persona.feed_media_asset_id=v_asset_id))
    or v_reference.consumer='post' and exists(select 1 from public.posts post
      where post.id=v_reference.row_id and post.media_asset_id=v_asset_id)
    or v_reference.consumer='album_item' and exists(select 1 from public.album_items item
      where item.id=v_reference.row_id and item.media_asset_id=v_asset_id)
    or v_reference.consumer='draft' and exists(select 1 from public.drafts draft
      where draft.id=v_reference.row_id and draft.media_asset_id=v_asset_id)
    or v_reference.consumer='post_draft' and exists(select 1 from public.post_drafts draft
      where draft.id=v_reference.row_id and (
        v_reference.slot='source' and draft.source_media_asset_id=v_asset_id
        or v_reference.slot='facebook' and draft.fb_media_asset_id=v_asset_id
        or v_reference.slot='instagram' and draft.ig_media_asset_id=v_asset_id
        or v_reference.slot='x' and draft.x_media_asset_id=v_asset_id))
    or v_reference.consumer='affiliate_product' and exists(
      select 1 from public.affiliate_products product
      where product.id=v_reference.row_id and product.owner=p_owner and product.image_url=v_url)
  ) then raise exception 'Reference trigger did not bind the exact imported asset'; end if;
  if v_reference.consumer in('persona','post','album_item','affiliate_product') then
    perform public.invalidate_persona_review_revision(v_declaration.persona_id);
  end if;
  insert into public.legacy_media_imports_065(
    owner,declaration_id,reference_id,source_id,persona_id,asset_id,public_id
  ) values(
    p_owner,v_declaration.id,v_reference.id,v_source.id,
    v_declaration.persona_id,v_asset_id,v_public_id
  ) returning id into v_import_id;
  insert into public.legacy_media_actions_065(
    owner,reference_id,declaration_id,import_id,action,affected_personas
  ) values(p_owner,v_reference.id,v_declaration.id,v_import_id,'import_rewrite',1);
  update public.legacy_media_references reference set state='imported',updated_at=now()
  where reference.id=v_reference.id and reference.owner=p_owner;
  return v_import_id;
end;
$$;

create or replace function public.clear_legacy_media_reference_service_065(
  p_owner uuid,p_item_id uuid
)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  v_reference public.legacy_media_references%rowtype;
  v_persona_ids uuid[]:='{}'::uuid[];v_persona_id uuid;v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform public.assert_legacy_media_owner_available_065(p_owner);
  select * into v_reference from public.legacy_media_references reference
  where reference.id=p_item_id and reference.owner=p_owner;
  if not found or v_reference.state in('stale','erased') then
    raise exception 'Reference is unavailable';
  end if;
  if v_reference.consumer='affiliate_product' then
    select coalesce(array_agg(distinct offer.persona_id order by offer.persona_id),'{}'::uuid[])
    into v_persona_ids from public.persona_affiliate_offers offer
    join public.personas persona on persona.id=offer.persona_id and persona.owner=offer.owner
    where offer.product_id=v_reference.row_id and offer.owner=p_owner
      and offer.status='active';
  elsif v_reference.persona_id is not null then
    v_persona_ids:=array[v_reference.persona_id];
  end if;
  foreach v_persona_id in array v_persona_ids loop
    perform public.lock_persona_publication_mutation(v_persona_id);
  end loop;
  select * into v_reference from public.legacy_media_references reference
  where reference.id=p_item_id and reference.owner=p_owner for update;
  if not exists(select 1 from public.legacy_media_candidates_service_064(p_owner) candidate
    where candidate.consumer=v_reference.consumer and candidate.row_id=v_reference.row_id
      and candidate.slot=v_reference.slot and candidate.url=v_reference.legacy_url) then
    raise exception 'Reference changed before clear';
  end if;
  if v_reference.consumer='post_draft' and not exists(
    select 1 from public.post_drafts draft
    where draft.id=v_reference.row_id and draft.owner=p_owner and draft.status='draft'
      and draft.scheduled_for is null and draft.posted_at is null
      and draft.fb_published_at is null and draft.ig_published_at is null
      and draft.fb_post_id is null and draft.ig_media_id is null
      and draft.x_tweet_id is null and draft.publish_claimed_at is null
      and draft.publish_facebook_page_id='' and draft.publish_instagram_business_id=''
    for update
  ) then raise exception 'Queued or historical post drafts cannot be cleared'; end if;

  if v_reference.consumer='persona' then
    update public.personas persona set
      avatar_url=case when v_reference.slot='avatar' then '' else persona.avatar_url end,
      banner_url=case when v_reference.slot='banner' then '' else persona.banner_url end,
      bg_url=case when v_reference.slot='background' then '' else persona.bg_url end,
      feed_img_url=case when v_reference.slot='feed_header' then '' else persona.feed_img_url end
    where persona.id=v_reference.row_id and persona.owner=p_owner
      and ((v_reference.slot='avatar' and persona.avatar_url=v_reference.legacy_url)
        or (v_reference.slot='banner' and persona.banner_url=v_reference.legacy_url)
        or (v_reference.slot='background' and persona.bg_url=v_reference.legacy_url)
        or (v_reference.slot='feed_header' and persona.feed_img_url=v_reference.legacy_url));
  elsif v_reference.consumer='post' then
    update public.posts post set media_url=''
    where post.id=v_reference.row_id and post.media_url=v_reference.legacy_url
      and (v_reference.persona_id is null or post.persona_id=v_reference.persona_id);
  elsif v_reference.consumer='album_item' then
    update public.album_items item set thumb_url=''
    from public.albums album where item.id=v_reference.row_id
      and item.album_id=album.id and item.thumb_url=v_reference.legacy_url
      and (v_reference.persona_id is null or album.persona_id=v_reference.persona_id);
  elsif v_reference.consumer='draft' then
    update public.drafts draft set media_url=''
    where draft.id=v_reference.row_id and draft.owner=p_owner
      and draft.media_url=v_reference.legacy_url
      and (v_reference.persona_id is null or draft.persona_id=v_reference.persona_id);
  elsif v_reference.consumer='post_draft' then
    update public.post_drafts draft set
      source_image_url=case when v_reference.slot='source' then '' else draft.source_image_url end,
      fb_image_url=case when v_reference.slot='facebook' then '' else draft.fb_image_url end,
      ig_image_url=case when v_reference.slot='instagram' then '' else draft.ig_image_url end,
      x_image_url=case when v_reference.slot='x' then '' else draft.x_image_url end,
      status='draft',scheduled_for=null,approved_at=null,approved_by=null,
      approved_content_hash='',approved_timezone='',approved_facebook_page_id='',
      approved_instagram_business_id='',approved_fb_media_sha256='',
      approved_fb_media_mime='',approved_fb_media_bytes=0,approved_fb_media_path='',
      approved_fb_media_url='',approved_ig_media_sha256='',approved_ig_media_mime='',
      approved_ig_media_bytes=0,approved_ig_media_path='',approved_ig_media_url='',
      approved_fb_delivery_id=null,approved_ig_delivery_id=null,
      approved_fb_provenance_sha256='',approved_ig_provenance_sha256='',
      publish_facebook_page_id='',publish_instagram_business_id='',
      publish_claimed_at=null,media_provenance_required=true,last_error=null,updated_at=now()
    where draft.id=v_reference.row_id and draft.owner=p_owner and draft.status='draft'
      and draft.scheduled_for is null and draft.posted_at is null
      and draft.fb_published_at is null and draft.ig_published_at is null
      and draft.fb_post_id is null and draft.ig_media_id is null
      and draft.x_tweet_id is null and draft.publish_claimed_at is null
      and draft.publish_facebook_page_id='' and draft.publish_instagram_business_id=''
      and ((v_reference.slot='source' and draft.source_image_url=v_reference.legacy_url)
        or (v_reference.slot='facebook' and draft.fb_image_url=v_reference.legacy_url)
        or (v_reference.slot='instagram' and draft.ig_image_url=v_reference.legacy_url)
        or (v_reference.slot='x' and draft.x_image_url=v_reference.legacy_url));
  elsif v_reference.consumer='affiliate_product' then
    update public.affiliate_products product set image_url='',updated_at=now()
    where product.id=v_reference.row_id and product.owner=p_owner
      and product.image_url=v_reference.legacy_url;
  else raise exception 'Unsupported reference consumer'; end if;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Reference changed before compare-and-swap clear'; end if;
  if v_reference.consumer in('persona','post','album_item','affiliate_product') then
    foreach v_persona_id in array v_persona_ids loop
      perform public.invalidate_persona_review_revision(v_persona_id);
    end loop;
  end if;
  update public.legacy_media_declarations_065 declaration set
    state='superseded',superseded_at=clock_timestamp()
  where declaration.owner=p_owner and declaration.reference_id=v_reference.id
    and declaration.state='active';
  update public.legacy_media_references reference set state='cleared',updated_at=now()
  where reference.id=v_reference.id and reference.owner=p_owner;
  insert into public.legacy_media_actions_065(
    owner,reference_id,action,affected_personas
  ) values(p_owner,v_reference.id,'clear',cardinality(v_persona_ids));
  return true;
end;
$$;

-- Safe aggregate only. Broad 062 counting intentionally includes signed,
-- rendered, queried, encoded, and non-image-field legacy references that 064
-- cannot preview/import. Those remain an explicit replace-or-clear blocker.
create or replace function public.legacy_media_release_readiness_service_065()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_opaque jsonb;v_broad bigint:=0;v_exact bigint:=0;v_unactionable bigint:=0;
  v_total_objects bigint:=0;v_uuid_prefix_objects bigint:=0;
  v_unapplied bigint:=0;v_applied bigint:=0;v_cleared bigint:=0;
  v_active_uploads bigint:=0;v_active_erasures bigint:=0;
  v_erasure_cooldowns bigint:=0;v_orphans bigint:=0;
  v_bucket_public boolean:=true;v_ready_private boolean:=false;
  v_tombstone_cleanup boolean:=false;
  -- Forward migrations must replace these only after hosted staging proves the
  -- vendor-owned Storage trigger and the coordinated write-freeze rollout.
  v_storage_barrier_verified boolean:=false;v_rollout_verified boolean:=false;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  v_opaque:=public.public_media_release_readiness_service();
  if coalesce(v_opaque->>'legacy_media_bucket_references','')~'^[0-9]+$' then
    v_broad:=(v_opaque->>'legacy_media_bucket_references')::bigint;
  end if;
  select count(*) into v_exact
  from public.profiles profile
  cross join lateral public.legacy_media_candidates_service_064(profile.id) candidate;
  v_unactionable:=greatest(v_broad-v_exact,0);
  select count(*),count(*) filter(where object.name~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/')
  into v_total_objects,v_uuid_prefix_objects
  from storage.objects object where object.bucket_id='media';
  select coalesce(bucket.public,true) into v_bucket_public
  from storage.buckets bucket where bucket.id='media';
  if not found then v_bucket_public:=true; end if;
  select count(*) filter(where declaration.state='active' and imported.id is null),
    count(*) filter(where imported.state='applied')
  into v_unapplied,v_applied
  from public.legacy_media_declarations_065 declaration
  left join public.legacy_media_imports_065 imported
    on imported.declaration_id=declaration.id and imported.owner=declaration.owner;
  select count(*) into v_cleared from public.legacy_media_actions_065 action
  where action.action='clear';
  select count(*) into v_active_uploads
  from public.persona_media_upload_leases_065 lease where lease.expires_at>now();
  select count(*) into v_active_erasures
  from public.meta_owner_erasure_leases lease where lease.expires_at>now();
  delete from public.persona_media_erasure_tombstones_065 tombstone
  where tombstone.blocked_until<=now();
  select count(*) into v_erasure_cooldowns
  from public.persona_media_erasure_tombstones_065 tombstone
  where tombstone.blocked_until>now();
  if exists(select 1 from pg_catalog.pg_extension extension
      where extension.extname='pg_cron')
     and pg_catalog.to_regclass('cron.job') is not null then
    execute 'select exists(select 1 from cron.job where jobname=$1 and active)'
      into v_tombstone_cleanup
      using 'mypersonas-065-erasure-tombstone-expiry';
  end if;
  select count(*) into v_orphans from storage.objects object
  where object.bucket_id='persona-media'
    and object.name~'^[0-9a-f-]+/published/provenance/'
    and not exists(select 1 from public.persona_media_assets asset
      where asset.storage_path=object.name);
  v_ready_private:=v_broad=0 and v_unapplied=0 and v_active_uploads=0
    and v_active_erasures=0 and v_erasure_cooldowns=0 and v_orphans=0
    and v_tombstone_cleanup and v_storage_barrier_verified
    and v_rollout_verified;
  return jsonb_build_object(
    'release_ready',coalesce((v_opaque->>'ready')::boolean,false)
      and v_ready_private and not v_bucket_public,
    'ready_to_privatize_legacy_bucket',v_ready_private,
    'legacy_bucket_public',v_bucket_public,
    'legacy_bucket_objects',v_total_objects,
    'legacy_bucket_uuid_prefix_objects',v_uuid_prefix_objects,
    'unresolved_broad_references',v_broad,
    'actionable_exact_references',v_exact,
    'blocked_unverifiable_references',v_unactionable,
    'active_unapplied_declarations',v_unapplied,
    'active_upload_leases',v_active_uploads,
    'active_owner_erasure_leases',v_active_erasures,
    'active_erasure_cooldowns',v_erasure_cooldowns,
    'tombstone_cleanup_installed',v_tombstone_cleanup,
    'storage_write_barrier_staging_verified',v_storage_barrier_verified,
    'write_maintenance_rollout_verified',v_rollout_verified,
    'write_maintenance_rollout_required',true,
    'storage_schema_vendor_risk_pending',true,
    'unregistered_canonical_objects',v_orphans,
    'applied_imports',v_applied,'explicit_clears',v_cleared,
    'finalizer_installed',false,'purge_performed',false
  );
end;
$$;

create or replace function public.revoke_persona_public_media_owner_service_065(
  p_owner uuid
)
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  update public.persona_public_media_handles handle
  set state='revoked',retired_at=coalesce(handle.retired_at,now())
  where handle.owner=p_owner and handle.state='active';
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

create or replace function public.erase_persona_media_upload_leases_owner_service_065(
  p_owner uuid
)
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0));
  if not exists(select 1 from public.meta_owner_erasure_leases lease
    where lease.owner=p_owner and lease.expires_at>now()) then
    raise exception 'Active owner erasure lease required';
  end if;
  if exists(select 1 from public.persona_media_upload_leases_065 lease
    where lease.owner=p_owner and lease.expires_at>now()) then
    raise exception 'Active persona-media upload blocks erasure';
  end if;
  delete from public.persona_media_upload_leases_065 lease
  where lease.owner=p_owner and lease.expires_at<=now();
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

revoke all on function public.assert_legacy_media_owner_available_065(uuid),
  public.persona_media_owner_hash_065(uuid),
  public.purge_expired_persona_media_erasure_tombstones_065(),
  public.guard_persona_media_erasure_write_065(),
  public.claim_persona_media_upload_service_065(uuid,uuid,text,text,integer),
  public.assert_persona_media_upload_lease_065(uuid,uuid,text),
  public.persona_media_upload_cleanup_allowed_065(uuid,uuid,text),
  public.release_persona_media_upload_service_065(uuid,uuid),
  public.claim_meta_owner_erasure_core_018(uuid,uuid,integer),
  public.claim_meta_owner_erasure(uuid,uuid,integer),
  public.arm_persona_media_erasure_tombstone_service_065(uuid,uuid),
  public.release_meta_owner_erasure_core_018(uuid,uuid),
  public.release_meta_owner_erasure(uuid,uuid),
  public.register_persona_media_asset_core_063(
    uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,uuid,text
  ),
  public.register_persona_media_asset_service(
    uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,uuid,text,uuid
  ),
  public.normalize_legacy_media_preview_revision_065(),
  public.supersede_legacy_media_source_revision_065(),
  public.guard_legacy_media_declaration_audit_065(),
  public.guard_legacy_media_action_audit_065(),
  public.guard_bound_legacy_import_asset_065(),
  public.guard_legacy_media_import_binding_065(),
  public.supersede_legacy_media_binding_065(),
  public.legacy_media_import_binding_current_065(uuid,uuid),
  public.declare_legacy_media_reference_service(uuid,uuid,text),
  public.legacy_media_import_status_service(uuid,uuid),
  public.resolve_legacy_media_import_service(uuid,uuid),
  public.resolve_legacy_media_destination_service_065(
    uuid,uuid,text,text,bigint,text,uuid
  ),
  public.register_imported_persona_media_asset_service_065(
    uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,
    text,uuid,timestamptz
  ),
  public.commit_legacy_media_import_service_065(
    uuid,uuid,text,text,text,bigint,text,text,text,text,uuid,timestamptz,uuid
  ),
  public.clear_legacy_media_reference_service_065(uuid,uuid),
  public.legacy_media_release_readiness_service_065(),
  public.revoke_persona_public_media_owner_service_065(uuid),
  public.erase_persona_media_upload_leases_owner_service_065(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.assert_legacy_media_owner_available_065(uuid),
  public.claim_persona_media_upload_service_065(uuid,uuid,text,text,integer),
  public.persona_media_upload_cleanup_allowed_065(uuid,uuid,text),
  public.release_persona_media_upload_service_065(uuid,uuid),
  public.claim_meta_owner_erasure(uuid,uuid,integer),
  public.arm_persona_media_erasure_tombstone_service_065(uuid,uuid),
  public.release_meta_owner_erasure(uuid,uuid),
  public.register_persona_media_asset_service(
    uuid,uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,uuid,text,uuid
  ),
  public.declare_legacy_media_reference_service(uuid,uuid,text),
  public.legacy_media_import_status_service(uuid,uuid),
  public.resolve_legacy_media_import_service(uuid,uuid),
  public.resolve_legacy_media_destination_service_065(
    uuid,uuid,text,text,bigint,text,uuid
  ),
  public.commit_legacy_media_import_service_065(
    uuid,uuid,text,text,text,bigint,text,text,text,text,uuid,timestamptz,uuid
  ),
  public.clear_legacy_media_reference_service_065(uuid,uuid),
  public.legacy_media_release_readiness_service_065(),
  public.revoke_persona_public_media_owner_service_065(uuid),
  public.erase_persona_media_upload_leases_owner_service_065(uuid)
  to service_role;

commit;
