-- Private Persona Source Library.
--
-- Raw source images are private inputs, never publishable media. Browser roles
-- can read only owner-scoped metadata, notes, and study status. Object locators,
-- upload reservations, rate limits, and idempotency receipts remain in the
-- private schema and are reachable only through narrow RPCs. Nothing in this
-- migration publishes, schedules, watermarks, or sends a source to a provider.

begin;

create schema if not exists private;
revoke all on schema private from public,anon,authenticated;

insert into storage.buckets(
  id,name,public,file_size_limit,allowed_mime_types
) values (
  'persona-source-library','persona-source-library',false,10485760,
  array['image/png','image/jpeg','image/webp']::text[]
)
on conflict(id) do update set
  public=false,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create table if not exists public.persona_source_assets (
  id                       uuid primary key default gen_random_uuid(),
  owner                    uuid not null references public.profiles(id) on delete restrict,
  persona_id               uuid not null references public.personas(id) on delete restrict,
  intent                   text not null default 'unsorted'
    check (intent in ('research','content_later','unsorted','archive')),
  storage_mode             text not null default 'managed_private'
    check (storage_mode in ('managed_private','local_companion','external_reference')),
  source_sha256            text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  mime_type                text not null
    check (mime_type in ('image/png','image/jpeg','image/webp')),
  byte_size                bigint not null check (byte_size between 1 and 10485760),
  pixel_width              integer not null check (pixel_width between 1 and 20000),
  pixel_height             integer not null check (pixel_height between 1 and 20000),
  original_filename        text not null default ''
    check (char_length(original_filename) between 1 and 255
      and original_filename !~ '[\\/[:cntrl:]<>]'),
  title                    text not null default '' check (char_length(title)<=300),
  owner_notes              text not null default '' check (char_length(owner_notes)<=10000),
  owner_tags               text[] not null default '{}'::text[]
    check (coalesce(array_length(owner_tags,1),0)<=50),
  ai_use                   text not null default 'unknown'
    check (ai_use in ('none','assisted','generated','unknown')),
  rights_basis             text not null default 'unknown'
    check (rights_basis in ('owner_created','licensed','reference_only','unknown')),
  reuse_policy             text not null default 'reference_only'
    check (reuse_policy in ('reference_only','derivative_allowed','publish_allowed')),
  sensitivity              text not null default 'standard'
    check (sensitivity in ('standard','sensitive','restricted')),
  hosted_analysis_consent  boolean not null default false,
  persona_context_enabled  boolean not null default false,
  lifecycle_state          text not null default 'ready'
    check (lifecycle_state in (
      'ready','analysis_queued','analyzing','review_required',
      'analysis_failed','archived','deleting'
    )),
  publication_state        text not null default 'private_only'
    check (publication_state='private_only'),
  captured_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (captured_at is null or captured_at<=now()+interval '1 day'),
  -- Exact deduplication is intentionally persona-scoped. The same private
  -- source may be attached independently to two personas with distinct notes.
  unique(owner,persona_id,source_sha256,byte_size)
);

comment on table public.persona_source_assets is
  'Owner-only metadata for private persona research/reference inputs. This table deliberately contains no bucket, object path, public URL, provider secret, or publication target.';
comment on column public.persona_source_assets.publication_state is
  'Fail-closed invariant: source-library inputs are private_only. Promotion to publishable media must use the separate reviewed media-ingest pipeline.';

create table if not exists public.persona_source_notes (
  id                uuid primary key default gen_random_uuid(),
  asset_id          uuid not null references public.persona_source_assets(id) on delete cascade,
  owner             uuid not null references public.profiles(id) on delete restrict,
  persona_id        uuid not null references public.personas(id) on delete restrict,
  author_kind       text not null check (author_kind in ('owner','ai')),
  note_kind         text not null check (note_kind in (
    'description','research','content_idea','visual_reference','warning'
  )),
  review_state      text not null check (review_state in ('suggested','accepted','rejected')),
  body              text not null check (char_length(body) between 1 and 5000),
  confidence         numeric(4,3) check (confidence is null or confidence between 0 and 1),
  analysis_job_id   uuid,
  provider_label    text not null default '' check (char_length(provider_label)<=120),
  model_label       text not null default '' check (char_length(model_label)<=160),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  reviewed_at       timestamptz,
  check (
    (author_kind='owner' and review_state='accepted'
      and provider_label='' and model_label='' and analysis_job_id is null)
    or (author_kind='ai' and analysis_job_id is not null)
  ),
  check ((review_state='suggested' and reviewed_at is null)
    or (review_state in ('accepted','rejected') and reviewed_at is not null))
);

create table if not exists public.persona_source_analysis_jobs (
  id                       uuid primary key default gen_random_uuid(),
  asset_id                 uuid not null references public.persona_source_assets(id) on delete cascade,
  owner                    uuid not null references public.profiles(id) on delete restrict,
  persona_id               uuid not null references public.personas(id) on delete restrict,
  execution_mode           text not null check (execution_mode in ('local','hosted')),
  status                   text not null default 'queued'
    check (status in ('queued','claimed','completed','failed','cancelled')),
  hosted_consent_snapshot  boolean not null default false,
  hosted_consent_version   integer,
  hosted_consent_at        timestamptz,
  cancel_requested         boolean not null default false,
  lease_token              uuid,
  lease_expires_at         timestamptz,
  worker_label             text not null default '' check (char_length(worker_label)<=120),
  provider_label           text not null default '' check (char_length(provider_label)<=120),
  model_label              text not null default '' check (char_length(model_label)<=160),
  failure_code             text not null default ''
    check (failure_code ~ '^[a-z0-9_:-]{0,80}$'),
  auto_publish             boolean not null default false check (not auto_publish),
  worker_entitlement_recheck_required boolean not null default true
    check (worker_entitlement_recheck_required),
  created_at               timestamptz not null default now(),
  started_at               timestamptz,
  completed_at             timestamptz,
  updated_at               timestamptz not null default now(),
  check (
    (execution_mode='local' and not hosted_consent_snapshot
      and hosted_consent_version is null and hosted_consent_at is null)
    or (execution_mode='hosted' and hosted_consent_snapshot
      and hosted_consent_version=1 and hosted_consent_at is not null)
  ),
  check (
    (status='queued' and lease_token is null and lease_expires_at is null
      and started_at is null and completed_at is null)
    or (status='claimed' and lease_token is not null and lease_expires_at is not null
      and started_at is not null and completed_at is null)
    or (status in ('completed','failed','cancelled') and completed_at is not null)
  )
);
do $migration$
begin
  if not exists(
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid='public.persona_source_notes'::regclass
      and constraint_row.conname='persona_source_notes_job_fk'
  ) then
    alter table public.persona_source_notes
      add constraint persona_source_notes_job_fk
      foreign key(analysis_job_id)
      references public.persona_source_analysis_jobs(id) on delete cascade;
  end if;
end
$migration$;

create unique index if not exists persona_source_one_active_study_idx
  on public.persona_source_analysis_jobs(asset_id)
  where status in ('queued','claimed');
create index if not exists persona_source_assets_owner_persona_created_idx
  on public.persona_source_assets(owner,persona_id,created_at desc,id desc);
create index if not exists persona_source_assets_owner_intent_created_idx
  on public.persona_source_assets(owner,intent,created_at desc,id desc);
create index if not exists persona_source_notes_owner_asset_created_idx
  on public.persona_source_notes(owner,asset_id,created_at,id);
create index if not exists persona_source_jobs_owner_created_idx
  on public.persona_source_analysis_jobs(owner,created_at desc,id desc);
create index if not exists persona_source_jobs_claim_idx
  on public.persona_source_analysis_jobs(status,created_at,id)
  where status in ('queued','claimed');

create table if not exists private.persona_source_asset_locations (
  asset_id          uuid primary key references public.persona_source_assets(id) on delete cascade,
  owner             uuid not null,
  storage_mode      text not null
    check (storage_mode in ('managed_private','local_companion','external_reference')),
  bucket_id         text,
  storage_locator   text not null check (char_length(storage_locator) between 3 and 1024),
  created_at        timestamptz not null default now(),
  check (
    (storage_mode='managed_private' and bucket_id='persona-source-library'
      and storage_locator !~ '(^|/)\.\.(/|$)')
    or (storage_mode in ('local_companion','external_reference') and bucket_id is null
      and storage_locator ~ '^(local|external):[A-Za-z0-9._:-]{1,1000}$')
  )
);
comment on table private.persona_source_asset_locations is
  'Service-only locator map. Never select from this table in an owner/browser RPC or export.';

create table if not exists private.persona_source_quota_usage (
  owner                     uuid primary key references public.profiles(id) on delete restrict,
  active_asset_count        integer not null default 0 check (active_asset_count>=0),
  active_managed_bytes      bigint not null default 0 check (active_managed_bytes>=0),
  reserved_asset_count      integer not null default 0 check (reserved_asset_count>=0),
  reserved_managed_bytes    bigint not null default 0 check (reserved_managed_bytes>=0),
  window_day                date not null default ((now() at time zone 'UTC')::date),
  uploads_created_today     integer not null default 0 check (uploads_created_today>=0),
  uploads_created_lifetime  bigint not null default 0 check (uploads_created_lifetime>=0),
  updated_at                timestamptz not null default now()
);

create table if not exists private.persona_source_upload_reservations (
  id                 uuid primary key default gen_random_uuid(),
  idempotency_key    uuid not null unique,
  owner              uuid not null references public.profiles(id) on delete restrict,
  persona_id         uuid not null references public.personas(id) on delete restrict,
  expected_bytes     bigint not null check (expected_bytes between 1 and 10485760),
  source_sha256      text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  state              text not null default 'reserved'
    check (state in ('reserved','writing','registered','released','expired')),
  asset_id           uuid references public.persona_source_assets(id) on delete cascade,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (expires_at>created_at),
  check ((state='registered' and asset_id is not null)
    or (state<>'registered' and asset_id is null))
);
create index if not exists persona_source_reservations_owner_state_idx
  on private.persona_source_upload_reservations(owner,state,expires_at,id);
drop index if exists private.persona_source_one_reserved_exact_upload_idx;
create unique index if not exists persona_source_one_active_exact_upload_idx
  on private.persona_source_upload_reservations(
    owner,persona_id,source_sha256,expected_bytes
  ) where state in ('reserved','writing');

create table if not exists private.persona_source_idempotency_receipts (
  idempotency_key  uuid primary key,
  owner            uuid not null,
  asset_id         uuid not null references public.persona_source_assets(id) on delete cascade,
  request_sha256   text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_scope    text not null default 'register'
    check (receipt_scope in ('register','reserve_duplicate')),
  duplicate        boolean not null default false,
  created_at       timestamptz not null default now()
);

create table if not exists private.persona_source_request_rate_limits (
  owner           uuid not null,
  action          text not null check (action in ('upload','byte_read','delete')),
  window_started  timestamptz not null,
  hit_count       integer not null default 1 check (hit_count>0),
  expires_at      timestamptz not null,
  primary key(owner,action,window_started)
);
create index if not exists persona_source_rate_expiry_idx
  on private.persona_source_request_rate_limits(expires_at);

create table if not exists private.persona_source_deletion_guards (
  owner          uuid not null,
  persona_id     uuid not null,
  guard_token    uuid not null,
  state          text not null default 'active'
    check (state in ('active','metadata_deleted')),
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key(owner,persona_id),
  unique(guard_token),
  check (expires_at>created_at)
);
create index if not exists persona_source_deletion_guards_expiry_idx
  on private.persona_source_deletion_guards(expires_at);

create table if not exists private.persona_source_account_deletion_guards (
  owner          uuid primary key,
  guard_token    uuid not null unique,
  state          text not null default 'active'
    check (state in ('active','metadata_deleted')),
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (expires_at>created_at)
);
comment on table private.persona_source_account_deletion_guards is
  'Short-lived service-only deletion fence. No profile FK by design so a metadata_deleted tombstone survives account erasure.';
create index if not exists persona_source_account_deletion_guards_expiry_idx
  on private.persona_source_account_deletion_guards(expires_at);

alter table public.persona_source_assets enable row level security;
alter table public.persona_source_notes enable row level security;
alter table public.persona_source_analysis_jobs enable row level security;
alter table private.persona_source_asset_locations enable row level security;
alter table private.persona_source_quota_usage enable row level security;
alter table private.persona_source_upload_reservations enable row level security;
alter table private.persona_source_idempotency_receipts enable row level security;
alter table private.persona_source_request_rate_limits enable row level security;
alter table private.persona_source_deletion_guards enable row level security;
alter table private.persona_source_account_deletion_guards enable row level security;

drop policy if exists "persona source assets owner read" on public.persona_source_assets;
create policy "persona source assets owner read" on public.persona_source_assets
  for select to authenticated using (owner=auth.uid());
drop policy if exists "persona source notes owner read" on public.persona_source_notes;
create policy "persona source notes owner read" on public.persona_source_notes
  for select to authenticated using (owner=auth.uid());
drop policy if exists "persona source jobs owner read" on public.persona_source_analysis_jobs;
create policy "persona source jobs owner read" on public.persona_source_analysis_jobs
  for select to authenticated using (owner=auth.uid());

revoke all on public.persona_source_assets,public.persona_source_notes,
  public.persona_source_analysis_jobs from public,anon,authenticated,service_role;
grant select on public.persona_source_assets,public.persona_source_notes,
  public.persona_source_analysis_jobs to authenticated;
revoke all on private.persona_source_asset_locations,
  private.persona_source_quota_usage,
  private.persona_source_upload_reservations,
  private.persona_source_idempotency_receipts,
  private.persona_source_request_rate_limits,
  private.persona_source_deletion_guards,
  private.persona_source_account_deletion_guards
  from public,anon,authenticated,service_role;

create or replace function private.guard_persona_source_rpc_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if coalesce(current_setting('app.persona_source_rpc_writer',true),'')<>'1' then
    raise sqlstate '42501' using message='Persona source writes require an approved RPC';
  end if;
  if tg_op='DELETE' then return old;end if;
  return new;
end
$$;

create or replace function public.register_persona_source_asset_service(
  p_owner uuid,p_persona_id uuid,p_storage_path text,
  p_source_sha256 text,p_mime_type text,p_byte_size bigint,
  p_width integer,p_height integer,p_original_filename text,
  p_intent text,p_ai_use text,p_rights_basis text,p_reuse_policy text,
  p_sensitivity text,p_analysis_consent boolean,p_title text,
  p_owner_notes text,p_owner_tags text[],p_captured_at timestamptz,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_reservation private.persona_source_upload_reservations%rowtype;
  v_receipt private.persona_source_idempotency_receipts%rowtype;
  v_asset_id uuid;v_storage_size text;v_request_sha256 text;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
  v_day date:=(now() at time zone 'UTC')::date;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_persona_id is null or p_idempotency_key is null
     or p_source_sha256!~'^[0-9a-f]{64}$'
     or p_byte_size not between 1 and 10485760
     or p_width not between 1 and 20000 or p_height not between 1 and 20000
     or p_mime_type not in ('image/png','image/jpeg','image/webp')
     or p_intent not in ('research','content_later','unsorted','archive')
     or p_ai_use not in ('none','assisted','generated','unknown')
     or p_rights_basis not in ('owner_created','licensed','reference_only','unknown')
     or p_reuse_policy not in ('reference_only','derivative_allowed','publish_allowed')
     or p_sensitivity not in ('standard','sensitive','restricted')
     or p_analysis_consent is null
     or char_length(coalesce(p_original_filename,'')) not between 1 and 255
     or p_original_filename~'[\\/[:cntrl:]<>]'
     or char_length(coalesce(p_title,''))>300
     or char_length(coalesce(p_owner_notes,''))>10000
     or coalesce(array_length(p_owner_tags,1),0)>50
     or exists(select 1 from unnest(coalesce(p_owner_tags,'{}'::text[])) tag
       where tag is null or char_length(trim(tag)) not between 1 and 100
         or tag~'[[:cntrl:]<>]')
     or p_captured_at>now()+interval '1 day' then
    raise exception 'Invalid persona source asset metadata';
  end if;
  if p_storage_path is null or char_length(p_storage_path)>1024
     or p_storage_path~'(^|/)\.\.(/|$)'
     or p_storage_path!~(
       '^'||p_owner::text||'/personas/'||p_persona_id::text||
       '/source/'||p_idempotency_key::text||'-'||
       p_source_sha256||'\.(png|jpe?g|webp)$'
     ) then raise exception 'Invalid private storage path';end if;
  if (p_mime_type='image/png' and p_storage_path!~'\.png$')
     or (p_mime_type='image/jpeg' and p_storage_path!~'\.jpe?g$')
     or (p_mime_type='image/webp' and p_storage_path!~'\.webp$') then
    raise exception 'Private storage extension does not match MIME type';
  end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=p_owner) then
    raise exception 'Owned persona not found';
  end if;
  v_request_sha256:=encode(extensions.digest(convert_to(jsonb_build_object(
    'owner',p_owner,'persona_id',p_persona_id,'storage_path',p_storage_path,
    'source_sha256',p_source_sha256,'mime_type',p_mime_type,
    'byte_size',p_byte_size,'width',p_width,'height',p_height,
    'original_filename',p_original_filename,'intent',p_intent,
    'ai_use',p_ai_use,'rights_basis',p_rights_basis,
    'reuse_policy',p_reuse_policy,'sensitivity',p_sensitivity,
    'analysis_consent',p_analysis_consent,'title',coalesce(p_title,''),
    'owner_notes',coalesce(p_owner_notes,''),
    'owner_tags',coalesce(p_owner_tags,'{}'::text[]),
    'captured_at',p_captured_at,'idempotency_key',p_idempotency_key
  )::text,'UTF8'),'sha256'),'hex');

  perform private.lock_persona_source_owner(p_owner);
  if exists(select 1 from private.persona_source_account_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_ACCOUNT_DELETING';end if;
  if exists(select 1 from private.persona_source_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.persona_id=p_persona_id
      and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_PERSONA_DELETING';end if;
  select * into v_receipt
  from private.persona_source_idempotency_receipts receipt
  where receipt.idempotency_key=p_idempotency_key;
  if found then
    if v_receipt.owner<>p_owner then
      raise exception 'Idempotency key conflict';
    end if;
    if v_receipt.receipt_scope='reserve_duplicate' then
      return jsonb_build_object(
        'status','registered','asset_id',v_receipt.asset_id,
        'duplicate',true,'cleanup_required',true
      );
    end if;
    if v_receipt.request_sha256<>v_request_sha256 then
      raise exception 'Idempotency key conflict';end if;
    return jsonb_build_object(
      'status','registered','asset_id',v_receipt.asset_id,
      'duplicate',v_receipt.duplicate,
      'cleanup_required',v_receipt.duplicate
    );
  end if;
  select * into v_reservation
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.idempotency_key=p_idempotency_key
  for update;
  if not found or v_reservation.state<>'writing'
     or v_reservation.expires_at<=now()
     or v_reservation.persona_id<>p_persona_id
     or v_reservation.expected_bytes<>p_byte_size
     or v_reservation.source_sha256<>p_source_sha256 then
    raise exception 'Active storage-write reservation required';
  end if;
  if not exists(select 1 from storage.buckets bucket
    where bucket.id='persona-source-library' and not bucket.public) then
    raise exception 'Private source bucket is not fail-closed';
  end if;
  select object.metadata->>'size' into v_storage_size
  from storage.objects object
  where object.bucket_id='persona-source-library' and object.name=p_storage_path;
  if not found or coalesce(v_storage_size,'')!~'^[0-9]+$'
     or v_storage_size::bigint<>p_byte_size then
    raise exception 'Stored source object does not match reserved byte size';
  end if;
  select asset.id into v_asset_id
  from public.persona_source_assets asset
  where asset.owner=p_owner and asset.persona_id=p_persona_id
    and asset.source_sha256=p_source_sha256 and asset.byte_size=p_byte_size;
  if found then
    insert into private.persona_source_idempotency_receipts(
      idempotency_key,owner,asset_id,request_sha256,receipt_scope,duplicate
    ) values(p_idempotency_key,p_owner,v_asset_id,v_request_sha256,'register',true);
    update private.persona_source_upload_reservations reservation set
      state='registered',asset_id=v_asset_id,updated_at=now()
    where reservation.id=v_reservation.id;
    update private.persona_source_quota_usage usage set
      reserved_asset_count=greatest(0,reserved_asset_count-1),
      reserved_managed_bytes=greatest(0,reserved_managed_bytes-p_byte_size),
      updated_at=now()
    where usage.owner=p_owner;
    return jsonb_build_object(
      'status','registered','asset_id',v_asset_id,'duplicate',true,
      'cleanup_required',true
    );
  end if;

  perform set_config('app.persona_source_rpc_writer','1',true);
  insert into public.persona_source_assets(
    owner,persona_id,intent,storage_mode,source_sha256,mime_type,byte_size,
    pixel_width,pixel_height,original_filename,title,owner_notes,owner_tags,
    ai_use,rights_basis,reuse_policy,sensitivity,hosted_analysis_consent,
    lifecycle_state,captured_at
  ) values(
    p_owner,p_persona_id,p_intent,'managed_private',p_source_sha256,p_mime_type,
    p_byte_size,p_width,p_height,p_original_filename,coalesce(p_title,''),
    coalesce(p_owner_notes,''),coalesce(p_owner_tags,'{}'::text[]),p_ai_use,
    p_rights_basis,p_reuse_policy,p_sensitivity,p_analysis_consent,
    case when p_intent='archive' then 'archived' else 'ready' end,p_captured_at
  ) returning id into v_asset_id;
  insert into private.persona_source_asset_locations(
    asset_id,owner,storage_mode,bucket_id,storage_locator
  ) values(
    v_asset_id,p_owner,'managed_private','persona-source-library',p_storage_path
  );
  insert into private.persona_source_idempotency_receipts(
    idempotency_key,owner,asset_id,request_sha256,receipt_scope,duplicate
  ) values(p_idempotency_key,p_owner,v_asset_id,v_request_sha256,'register',false);
  update private.persona_source_upload_reservations reservation set
    state='registered',asset_id=v_asset_id,updated_at=now()
  where reservation.id=v_reservation.id;
  update private.persona_source_quota_usage usage set
    window_day=v_day,
    uploads_created_today=case when usage.window_day=v_day
      then usage.uploads_created_today+1 else 1 end,
    uploads_created_lifetime=uploads_created_lifetime+1,
    reserved_asset_count=greatest(0,reserved_asset_count-1),
    reserved_managed_bytes=greatest(0,reserved_managed_bytes-p_byte_size),
    active_asset_count=active_asset_count+1,
    active_managed_bytes=active_managed_bytes+p_byte_size,
    updated_at=now()
  where usage.owner=p_owner;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object(
    'status','registered','asset_id',v_asset_id,
    'duplicate',false,'cleanup_required',false
  );
end
$$;

create or replace function public.resolve_persona_source_asset_service(
  p_owner uuid,p_asset_id uuid
)
returns table(
  storage_path text,source_sha256 text,mime_type text,byte_size bigint,
  original_filename text
)
language plpgsql security definer stable set search_path='' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_asset_id is null then
    raise exception 'Owner and asset are required';end if;
  return query
  select location.storage_locator,asset.source_sha256,asset.mime_type,
    asset.byte_size,asset.original_filename
  from public.persona_source_assets asset
  join private.persona_source_asset_locations location
    on location.asset_id=asset.id and location.owner=asset.owner
  where asset.id=p_asset_id and asset.owner=p_owner;
  if not found then raise exception 'Owned persona source asset not found';end if;
end
$$;

create or replace function public.begin_persona_source_asset_deletion_service(
  p_owner uuid,p_asset_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_asset public.persona_source_assets%rowtype;v_active_studies integer:=0;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_asset_id is null then
    raise exception 'Owner and asset are required';end if;
  perform private.lock_persona_source_owner(p_owner);
  if exists(select 1 from private.persona_source_account_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_ACCOUNT_DELETING';end if;
  select * into v_asset from public.persona_source_assets asset
  where asset.id=p_asset_id and asset.owner=p_owner for update;
  if not found then raise exception 'Owned persona source asset not found';end if;
  if exists(select 1 from private.persona_source_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.persona_id=v_asset.persona_id
      and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_PERSONA_DELETING';end if;
  perform set_config('app.persona_source_rpc_writer','1',true);
  update public.persona_source_analysis_jobs job set
    status='cancelled',cancel_requested=true,completed_at=now(),updated_at=now()
  where job.asset_id=p_asset_id and job.owner=p_owner and job.status='queued';
  update public.persona_source_analysis_jobs job set
    cancel_requested=true,updated_at=now()
  where job.asset_id=p_asset_id and job.owner=p_owner and job.status='claimed';
  update public.persona_source_assets asset set
    lifecycle_state='deleting',updated_at=now()
  where asset.id=p_asset_id and asset.owner=p_owner;
  select count(*) into v_active_studies
  from public.persona_source_analysis_jobs job
  where job.asset_id=p_asset_id and job.owner=p_owner and job.status='claimed';
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object(
    'status','deleting','asset_id',p_asset_id,'active_studies',v_active_studies
  );
end
$$;

create or replace function public.delete_persona_source_asset_metadata_service(
  p_owner uuid,p_asset_id uuid,p_expected_storage_path text,
  p_expected_sha256 text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_asset public.persona_source_assets%rowtype;
  v_location private.persona_source_asset_locations%rowtype;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_asset_id is null
     or p_expected_sha256!~'^[0-9a-f]{64}$' then
    raise exception 'Invalid source deletion receipt';end if;
  perform private.lock_persona_source_owner(p_owner);
  select * into v_asset from public.persona_source_assets asset
  where asset.id=p_asset_id and asset.owner=p_owner for update;
  if not found then
    return jsonb_build_object('deleted',false,'status','missing');
  end if;
  if v_asset.lifecycle_state<>'deleting' then
    raise exception 'Persona source asset deletion preflight required';end if;
  select * into v_location from private.persona_source_asset_locations location
  where location.asset_id=p_asset_id and location.owner=p_owner for update;
  if not found or v_location.storage_locator<>p_expected_storage_path
     or v_asset.source_sha256<>p_expected_sha256 then
    raise exception 'Source deletion receipt mismatch';
  end if;
  if exists(select 1 from public.persona_source_analysis_jobs job
    where job.asset_id=p_asset_id and job.owner=p_owner and job.status='claimed') then
    raise exception 'PERSONA_SOURCE_ACTIVE_STUDIES_RETRY';end if;
  if v_location.storage_mode='managed_private' and exists(
    select 1 from storage.objects object
    where object.bucket_id=v_location.bucket_id
      and object.name=v_location.storage_locator
  ) then raise exception 'Delete private Storage bytes before metadata';end if;
  perform set_config('app.persona_source_rpc_writer','1',true);
  delete from public.persona_source_assets asset
  where asset.id=p_asset_id and asset.owner=p_owner;
  update private.persona_source_quota_usage usage set
    active_asset_count=greatest(0,active_asset_count-1),
    active_managed_bytes=greatest(0,active_managed_bytes-
      case when v_location.storage_mode='managed_private' then v_asset.byte_size else 0 end),
    updated_at=now()
  where usage.owner=p_owner;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object('deleted',true,'status','deleted','asset_id',p_asset_id);
end
$$;
revoke all on function private.guard_persona_source_rpc_write()
  from public,anon,authenticated,service_role;

drop trigger if exists guard_persona_source_assets_rpc_write on public.persona_source_assets;
create trigger guard_persona_source_assets_rpc_write
  before insert or update or delete on public.persona_source_assets
  for each row execute function private.guard_persona_source_rpc_write();
drop trigger if exists guard_persona_source_notes_rpc_write on public.persona_source_notes;
create trigger guard_persona_source_notes_rpc_write
  before insert or update or delete on public.persona_source_notes
  for each row execute function private.guard_persona_source_rpc_write();
drop trigger if exists guard_persona_source_jobs_rpc_write on public.persona_source_analysis_jobs;
create trigger guard_persona_source_jobs_rpc_write
  before insert or update or delete on public.persona_source_analysis_jobs
  for each row execute function private.guard_persona_source_rpc_write();

create or replace function private.lock_persona_source_owner(p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_owner is null then raise exception 'Owner is required';end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,70051001)
  );
end
$$;
revoke all on function private.lock_persona_source_owner(uuid)
  from public,anon,authenticated,service_role;

create or replace function private.reap_persona_source_reservations(p_owner uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer:=0;v_bytes bigint:=0;
begin
  select count(*),coalesce(sum(reservation.expected_bytes),0)
  into v_count,v_bytes
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.state in ('reserved','writing')
    and reservation.expires_at<=now();
  if v_count>0 then
    update private.persona_source_upload_reservations reservation set
      state='expired',updated_at=now()
    where reservation.owner=p_owner and reservation.state in ('reserved','writing')
      and reservation.expires_at<=now();
    update private.persona_source_quota_usage usage set
      reserved_asset_count=greatest(0,usage.reserved_asset_count-v_count),
      reserved_managed_bytes=greatest(0,usage.reserved_managed_bytes-v_bytes),
      updated_at=now()
    where usage.owner=p_owner;
  end if;
  return v_count;
end
$$;
revoke all on function private.reap_persona_source_reservations(uuid)
  from public,anon,authenticated,service_role;

create or replace function public.consume_persona_source_rate_limit_service(
  p_owner uuid,p_action text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_limit integer;v_window interval;v_started timestamptz;v_hits integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or not exists(
    select 1 from public.profiles profile where profile.id=p_owner
  ) then raise exception 'Owned account not found';end if;
  case p_action
    when 'upload' then v_limit:=120;v_window:=interval '10 minutes';
    when 'byte_read' then v_limit:=120;v_window:=interval '1 minute';
    when 'delete' then v_limit:=60;v_window:=interval '10 minutes';
    else raise exception 'Unsupported persona source action';
  end case;
  perform private.lock_persona_source_owner(p_owner);
  delete from private.persona_source_request_rate_limits limiter
  where limiter.owner=p_owner and limiter.expires_at<=now();
  v_started:=date_trunc('minute',now());
  if p_action in ('upload','delete') then
    v_started:=date_trunc('hour',now())
      + make_interval(mins=>(extract(minute from now())::integer/10)*10);
  end if;
  insert into private.persona_source_request_rate_limits(
    owner,action,window_started,hit_count,expires_at
  ) values(p_owner,p_action,v_started,1,v_started+v_window)
  on conflict(owner,action,window_started) do update set
    hit_count=private.persona_source_request_rate_limits.hit_count+1
  returning hit_count into v_hits;
  if v_hits>v_limit then
    raise sqlstate 'P0001' using message='PERSONA_SOURCE_RATE_LIMITED';
  end if;
  return jsonb_build_object(
    'allowed',true,'action',p_action,'limit',v_limit,
    'remaining',greatest(0,v_limit-v_hits),
    'retry_after_seconds',greatest(1,extract(epoch from (v_started+v_window-now()))::integer)
  );
end
$$;

create or replace function public.reserve_persona_source_upload_service(
  p_owner uuid,p_persona_id uuid,p_byte_size bigint,
  p_source_sha256 text,p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_usage private.persona_source_quota_usage%rowtype;
  v_reservation private.persona_source_upload_reservations%rowtype;
  v_receipt private.persona_source_idempotency_receipts%rowtype;
  v_persona_count integer;v_persona_reserved integer;
  v_persona_bytes bigint;v_persona_reserved_bytes bigint;
  v_asset_id uuid;v_reserve_sha256 text;
  v_existing_reservation boolean:=false;
  v_day date:=(now() at time zone 'UTC')::date;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_persona_id is null or p_idempotency_key is null
     or p_byte_size not between 1 and 10485760
     or p_source_sha256!~'^[0-9a-f]{64}$' then
    raise exception 'Invalid upload reservation';
  end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=p_owner) then
    raise exception 'Owned persona not found';
  end if;
  perform private.lock_persona_source_owner(p_owner);
  if exists(select 1 from private.persona_source_account_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_ACCOUNT_DELETING';end if;
  if exists(select 1 from private.persona_source_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.persona_id=p_persona_id
      and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_PERSONA_DELETING';end if;
  select * into v_receipt
  from private.persona_source_idempotency_receipts receipt
  where receipt.idempotency_key=p_idempotency_key;
  if found then
    if v_receipt.owner<>p_owner then raise exception 'Idempotency key conflict';end if;
    select asset.id into v_asset_id from public.persona_source_assets asset
    where asset.id=v_receipt.asset_id and asset.owner=p_owner
      and asset.persona_id=p_persona_id and asset.source_sha256=p_source_sha256
      and asset.byte_size=p_byte_size;
    if not found then raise exception 'Idempotency key conflict';end if;
    return jsonb_build_object(
      'status','registered','reservation_id',null,'idempotency_key',p_idempotency_key,
      'expires_at',null,'byte_size',p_byte_size,'asset_id',v_receipt.asset_id,
      'duplicate',v_receipt.duplicate
    );
  end if;
  insert into private.persona_source_quota_usage(owner,window_day)
  values(p_owner,v_day) on conflict(owner) do nothing;
  perform private.reap_persona_source_reservations(p_owner);
  select * into v_usage from private.persona_source_quota_usage usage
  where usage.owner=p_owner for update;
  if v_usage.window_day<>v_day then
    update private.persona_source_quota_usage usage set
      window_day=v_day,uploads_created_today=0,updated_at=now()
    where usage.owner=p_owner returning * into v_usage;
  end if;
  select * into v_reservation
  from private.persona_source_upload_reservations reservation
  where reservation.idempotency_key=p_idempotency_key for update;
  v_existing_reservation:=found;
  if found and (v_reservation.owner<>p_owner
      or v_reservation.persona_id<>p_persona_id
      or v_reservation.expected_bytes<>p_byte_size
      or v_reservation.source_sha256<>p_source_sha256) then
    raise exception 'Idempotency key conflict';
  end if;
  if found and v_reservation.state in ('reserved','writing')
     and v_reservation.expires_at>now() then
    return jsonb_build_object(
      'status',v_reservation.state,'reservation_id',v_reservation.id,
      'idempotency_key',p_idempotency_key,'expires_at',v_reservation.expires_at,
      'byte_size',p_byte_size,'asset_id',null
    );
  end if;
  select asset.id into v_asset_id from public.persona_source_assets asset
  where asset.owner=p_owner and asset.persona_id=p_persona_id
    and asset.source_sha256=p_source_sha256 and asset.byte_size=p_byte_size;
  if found then
    v_reserve_sha256:=encode(extensions.digest(convert_to(jsonb_build_object(
      'scope','reserve_duplicate','owner',p_owner,'persona_id',p_persona_id,
      'byte_size',p_byte_size,'source_sha256',p_source_sha256,
      'idempotency_key',p_idempotency_key
    )::text,'UTF8'),'sha256'),'hex');
    insert into private.persona_source_idempotency_receipts(
      idempotency_key,owner,asset_id,request_sha256,receipt_scope,duplicate
    ) values(
      p_idempotency_key,p_owner,v_asset_id,v_reserve_sha256,'reserve_duplicate',true
    );
    return jsonb_build_object(
      'status','registered','reservation_id',null,'idempotency_key',p_idempotency_key,
      'expires_at',null,'byte_size',p_byte_size,'asset_id',v_asset_id,'duplicate',true
    );
  end if;
  if exists(
    select 1 from private.persona_source_upload_reservations reservation
    where reservation.owner=p_owner and reservation.persona_id=p_persona_id
      and reservation.source_sha256=p_source_sha256
      and reservation.expected_bytes=p_byte_size
      and reservation.state in ('reserved','writing')
      and reservation.idempotency_key<>p_idempotency_key
  ) then raise exception 'PERSONA_SOURCE_DUPLICATE_UPLOAD_PENDING';end if;
  select count(*) into v_persona_count from public.persona_source_assets asset
  where asset.owner=p_owner and asset.persona_id=p_persona_id;
  select count(*) into v_persona_reserved
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.persona_id=p_persona_id
    and reservation.state in ('reserved','writing');
  select coalesce(sum(asset.byte_size),0) into v_persona_bytes
  from public.persona_source_assets asset
  where asset.owner=p_owner and asset.persona_id=p_persona_id
    and asset.storage_mode='managed_private';
  select coalesce(sum(reservation.expected_bytes),0) into v_persona_reserved_bytes
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.persona_id=p_persona_id
    and reservation.state in ('reserved','writing');
  -- These are conservative technical safety ceilings, not billing/product
  -- entitlements. Entitlement enforcement remains server-authoritative elsewhere.
  if v_usage.active_asset_count+v_usage.reserved_asset_count>=10000 then
    raise exception 'Persona source account asset limit reached';
  end if;
  if v_persona_count+v_persona_reserved>=5000 then
    raise exception 'Persona source persona asset limit reached';
  end if;
  if v_usage.active_managed_bytes+v_usage.reserved_managed_bytes+p_byte_size>2147483648 then
    raise exception 'Persona source managed byte limit reached';
  end if;
  if v_persona_bytes+v_persona_reserved_bytes+p_byte_size>1073741824 then
    raise exception 'Persona source persona managed byte limit reached';
  end if;
  if v_usage.uploads_created_today+v_usage.reserved_asset_count>=500 then
    raise exception 'Persona source daily upload limit reached';
  end if;
  if v_existing_reservation then
    update private.persona_source_upload_reservations reservation set
      state='reserved',asset_id=null,expires_at=now()+interval '15 minutes',updated_at=now()
    where reservation.id=v_reservation.id returning * into v_reservation;
  else
    insert into private.persona_source_upload_reservations(
      idempotency_key,owner,persona_id,expected_bytes,source_sha256,expires_at
    ) values(
      p_idempotency_key,p_owner,p_persona_id,p_byte_size,p_source_sha256,
      now()+interval '15 minutes'
    ) returning * into v_reservation;
  end if;
  update private.persona_source_quota_usage usage set
    reserved_asset_count=reserved_asset_count+1,
    reserved_managed_bytes=reserved_managed_bytes+p_byte_size,
    updated_at=now()
  where usage.owner=p_owner;
  return jsonb_build_object(
    'status','reserved','reservation_id',v_reservation.id,
    'idempotency_key',p_idempotency_key,'expires_at',v_reservation.expires_at,
    'byte_size',p_byte_size,'asset_id',null
  );
end
$$;

-- The service must enter writing immediately before touching Storage. This
-- closes the reserve-versus-delete race without exposing a storage locator.
create or replace function public.begin_persona_source_storage_write_service(
  p_owner uuid,p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_reservation private.persona_source_upload_reservations%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_idempotency_key is null then
    raise exception 'Owner and idempotency key are required';end if;
  perform private.lock_persona_source_owner(p_owner);
  if exists(select 1 from private.persona_source_account_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_ACCOUNT_DELETING';end if;
  select * into v_reservation
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.idempotency_key=p_idempotency_key
  for update;
  if not found then raise exception 'Upload reservation not found';end if;
  if exists(select 1 from private.persona_source_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.persona_id=v_reservation.persona_id
      and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_PERSONA_DELETING';end if;
  if v_reservation.state='registered' then
    return jsonb_build_object(
      'status','registered','reservation_id',v_reservation.id,
      'idempotency_key',p_idempotency_key,'persona_id',v_reservation.persona_id,
      'expires_at',null,'byte_size',v_reservation.expected_bytes,
      'source_sha256',v_reservation.source_sha256,'asset_id',v_reservation.asset_id
    );
  end if;
  if v_reservation.state not in ('reserved','writing')
     or v_reservation.expires_at<=now() then
    raise exception 'Active upload reservation required';end if;
  if v_reservation.state='reserved' then
    update private.persona_source_upload_reservations reservation set
      state='writing',expires_at=now()+interval '15 minutes',updated_at=now()
    where reservation.id=v_reservation.id returning * into v_reservation;
  end if;
  return jsonb_build_object(
    'status','writing','reservation_id',v_reservation.id,
    'idempotency_key',p_idempotency_key,'persona_id',v_reservation.persona_id,
    'expires_at',v_reservation.expires_at,'byte_size',v_reservation.expected_bytes,
    'source_sha256',v_reservation.source_sha256,'asset_id',null
  );
end
$$;

create or replace function public.release_persona_source_upload_service(
  p_owner uuid,p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_reservation private.persona_source_upload_reservations%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_idempotency_key is null then
    raise exception 'Owner and idempotency key are required';end if;
  perform private.lock_persona_source_owner(p_owner);
  select * into v_reservation
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.idempotency_key=p_idempotency_key
  for update;
  if not found then return jsonb_build_object('released',false,'status','missing');end if;
  if v_reservation.state='registered' then
    return jsonb_build_object('released',false,'status','registered','asset_id',v_reservation.asset_id);
  end if;
  if v_reservation.state in ('released','expired') then
    return jsonb_build_object('released',false,'status',v_reservation.state);
  end if;
  if v_reservation.state not in ('reserved','writing') then
    raise exception 'Unsupported upload reservation state';end if;
  update private.persona_source_upload_reservations reservation
  set state='released',updated_at=now()
  where reservation.id=v_reservation.id;
  update private.persona_source_quota_usage usage set
    reserved_asset_count=greatest(0,reserved_asset_count-1),
    reserved_managed_bytes=greatest(0,reserved_managed_bytes-v_reservation.expected_bytes),
    updated_at=now()
  where usage.owner=p_owner;
  return jsonb_build_object(
    'released',true,'status','released','previous_state',v_reservation.state
  );
end
$$;

create or replace function public.update_persona_source_asset(
  p_asset_id uuid,p_patch jsonb
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid:=auth.uid();v_asset public.persona_source_assets%rowtype;
  v_key text;v_tags text[];v_consent boolean;v_archived boolean;
  v_sensitivity text;v_block_hosted boolean;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if v_owner is null then raise exception 'Authentication required';end if;
  if p_asset_id is null or jsonb_typeof(coalesce(p_patch,'null'::jsonb))<>'object'
     or octet_length(p_patch::text)>20000 then raise exception 'Invalid source patch';end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in (
      'intent','title','owner_notes','owner_tags','ai_use','rights_basis',
      'reuse_policy','sensitivity','hosted_analysis_consent',
      'persona_context_enabled','archived'
    ) then raise exception 'Unsupported source patch field';end if;
  end loop;
  perform private.lock_persona_source_owner(v_owner);
  select * into v_asset from public.persona_source_assets asset
  where asset.id=p_asset_id and asset.owner=v_owner for update;
  if not found then raise exception 'Owned persona source asset not found';end if;
  if v_asset.lifecycle_state='deleting' then
    raise exception 'Persona source asset deletion is in progress';end if;
  if p_patch ? 'intent' and coalesce(p_patch->>'intent','') not in
      ('research','content_later','unsorted','archive') then
    raise exception 'Invalid source intent';end if;
  if p_patch ? 'title' and (
      jsonb_typeof(p_patch->'title')<>'string'
      or char_length(p_patch->>'title')>300) then raise exception 'Invalid source title';end if;
  if p_patch ? 'owner_notes' and (
      jsonb_typeof(p_patch->'owner_notes')<>'string'
      or char_length(p_patch->>'owner_notes')>10000) then
    raise exception 'Invalid source owner notes';end if;
  if p_patch ? 'owner_tags' then
    if jsonb_typeof(p_patch->'owner_tags')<>'array'
       or jsonb_array_length(p_patch->'owner_tags')>50 then
      raise exception 'Source tags must be a bounded array';end if;
    select coalesce(array_agg(trim(tag.value) order by tag.ordinality),'{}'::text[])
    into v_tags
    from jsonb_array_elements_text(p_patch->'owner_tags')
      with ordinality tag(value,ordinality);
    if exists(select 1 from unnest(v_tags) tag
      where char_length(tag) not between 1 and 100 or tag~'[[:cntrl:]<>]') then
      raise exception 'Invalid source tag';end if;
  else v_tags:=v_asset.owner_tags;end if;
  if p_patch ? 'ai_use' and coalesce(p_patch->>'ai_use','') not in
      ('none','assisted','generated','unknown') then raise exception 'Invalid AI-use declaration';end if;
  if p_patch ? 'rights_basis' and coalesce(p_patch->>'rights_basis','') not in
      ('owner_created','licensed','reference_only','unknown') then
    raise exception 'Invalid rights declaration';end if;
  if p_patch ? 'reuse_policy' and coalesce(p_patch->>'reuse_policy','') not in
      ('reference_only','derivative_allowed','publish_allowed') then
    raise exception 'Invalid reuse policy';end if;
  if p_patch ? 'sensitivity' and coalesce(p_patch->>'sensitivity','') not in
      ('standard','sensitive','restricted') then raise exception 'Invalid sensitivity';end if;
  v_sensitivity:=coalesce(p_patch->>'sensitivity',v_asset.sensitivity);
  if p_patch ? 'hosted_analysis_consent' then
    if jsonb_typeof(p_patch->'hosted_analysis_consent')<>'boolean' then
      raise exception 'Hosted-analysis consent must be boolean';end if;
    v_consent:=(p_patch->>'hosted_analysis_consent')::boolean;
  else v_consent:=v_asset.hosted_analysis_consent;end if;
  if p_patch ? 'persona_context_enabled'
     and jsonb_typeof(p_patch->'persona_context_enabled')<>'boolean' then
    raise exception 'Persona-context setting must be boolean';end if;
  if p_patch ? 'archived' then
    if jsonb_typeof(p_patch->'archived')<>'boolean' then
      raise exception 'Archived setting must be boolean';end if;
    v_archived:=(p_patch->>'archived')::boolean;
    if v_archived and exists(select 1 from public.persona_source_analysis_jobs job
      where job.asset_id=p_asset_id and job.status in ('queued','claimed')) then
      raise exception 'Cancel active source study before archiving';end if;
  else v_archived:=(v_asset.lifecycle_state='archived');end if;

  v_block_hosted:=not v_consent or v_sensitivity='restricted';
  perform set_config('app.persona_source_rpc_writer','1',true);
  if v_block_hosted then
    update public.persona_source_analysis_jobs job set
      status='cancelled',cancel_requested=true,completed_at=now(),updated_at=now()
    where job.asset_id=p_asset_id and job.owner=v_owner
      and job.execution_mode='hosted' and job.status='queued';
    update public.persona_source_analysis_jobs job set
      cancel_requested=true,updated_at=now()
    where job.asset_id=p_asset_id and job.owner=v_owner
      and job.execution_mode='hosted' and job.status='claimed';
  end if;
  update public.persona_source_assets asset set
    intent=coalesce(p_patch->>'intent',asset.intent),
    title=coalesce(p_patch->>'title',asset.title),
    owner_notes=coalesce(p_patch->>'owner_notes',asset.owner_notes),
    owner_tags=v_tags,
    ai_use=coalesce(p_patch->>'ai_use',asset.ai_use),
    rights_basis=coalesce(p_patch->>'rights_basis',asset.rights_basis),
    reuse_policy=coalesce(p_patch->>'reuse_policy',asset.reuse_policy),
    sensitivity=v_sensitivity,
    hosted_analysis_consent=v_consent,
    persona_context_enabled=case when p_patch ? 'persona_context_enabled'
      then (p_patch->>'persona_context_enabled')::boolean
      else asset.persona_context_enabled end,
    lifecycle_state=case
      when v_archived then 'archived'
      when asset.lifecycle_state='archived' then 'ready'
      when v_block_hosted
        and asset.lifecycle_state in ('analysis_queued','analyzing')
        and not exists(select 1 from public.persona_source_analysis_jobs job
          where job.asset_id=asset.id and job.status in ('queued','claimed')) then 'ready'
      else asset.lifecycle_state end,
    updated_at=now()
  where asset.id=p_asset_id and asset.owner=v_owner;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return p_asset_id;
end
$$;

create or replace function public.add_persona_source_note(
  p_asset_id uuid,p_note_kind text,p_body text
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid:=auth.uid();v_asset public.persona_source_assets%rowtype;v_note_id uuid;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if v_owner is null then raise exception 'Authentication required';end if;
  if p_note_kind not in ('description','research','content_idea','visual_reference','warning')
     or char_length(trim(coalesce(p_body,''))) not between 1 and 5000 then
    raise exception 'Invalid source note';end if;
  select * into v_asset from public.persona_source_assets asset
  where asset.id=p_asset_id and asset.owner=v_owner for update;
  if not found then raise exception 'Owned persona source asset not found';end if;
  if (select count(*) from public.persona_source_notes note
      where note.asset_id=p_asset_id)>=500 then
    raise exception 'Source note limit reached';end if;
  perform set_config('app.persona_source_rpc_writer','1',true);
  insert into public.persona_source_notes(
    asset_id,owner,persona_id,author_kind,note_kind,review_state,body,reviewed_at
  ) values(
    p_asset_id,v_owner,v_asset.persona_id,'owner',p_note_kind,'accepted',trim(p_body),now()
  ) returning id into v_note_id;
  update public.persona_source_assets asset set updated_at=now()
  where asset.id=p_asset_id;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return v_note_id;
end
$$;

create or replace function public.review_persona_source_note(
  p_note_id uuid,p_review_state text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid:=auth.uid();v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if v_owner is null then raise exception 'Authentication required';end if;
  if p_review_state not in ('accepted','rejected') then
    raise exception 'AI note review must be accepted or rejected';end if;
  perform set_config('app.persona_source_rpc_writer','1',true);
  update public.persona_source_notes note set
    review_state=p_review_state,reviewed_at=now(),updated_at=now()
  where note.id=p_note_id and note.owner=v_owner and note.author_kind='ai';
  if not found then raise exception 'Owned AI source note not found';end if;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return true;
end
$$;

create or replace function public.queue_persona_source_study(
  p_asset_id uuid,p_execution_mode text default 'local'
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid:=auth.uid();v_asset public.persona_source_assets%rowtype;v_job_id uuid;
  v_active_job public.persona_source_analysis_jobs%rowtype;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if v_owner is null then raise exception 'Authentication required';end if;
  if p_execution_mode not in ('local','hosted') then raise exception 'Invalid study mode';end if;
  perform private.lock_persona_source_owner(v_owner);
  select * into v_asset from public.persona_source_assets asset
  where asset.id=p_asset_id and asset.owner=v_owner for update;
  if not found then raise exception 'Studyable owned source asset not found';end if;
  if exists(select 1 from private.persona_source_account_deletion_guards guard_row
      where guard_row.owner=v_owner and guard_row.expires_at>now())
     or exists(select 1 from private.persona_source_deletion_guards guard_row
      where guard_row.owner=v_owner and guard_row.persona_id=v_asset.persona_id
        and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_DELETION_IN_PROGRESS';end if;
  select * into v_active_job from public.persona_source_analysis_jobs job
  where job.asset_id=p_asset_id and job.status in ('queued','claimed')
  order by job.created_at desc,job.id desc limit 1;
  if found then
    if v_active_job.execution_mode=p_execution_mode then return v_active_job.id;end if;
    raise exception 'A source study is already active in another mode';
  end if;
  if v_asset.lifecycle_state<>'ready' then
    raise exception 'Source asset must be ready before study';end if;
  if p_execution_mode='hosted' then
    if coalesce(auth.jwt()->>'aal','')<>'aal2' then
      raise sqlstate '42501' using message='Two-factor verification required';end if;
    if not v_asset.hosted_analysis_consent then
      raise exception 'Explicit hosted-analysis consent is required';end if;
    if v_asset.sensitivity='restricted' then
      raise exception 'Restricted sources cannot use hosted analysis';end if;
  end if;
  if (select count(*) from public.persona_source_analysis_jobs job
      where job.asset_id=p_asset_id)>=100 then
    raise exception 'Source study history limit reached';end if;
  perform set_config('app.persona_source_rpc_writer','1',true);
  insert into public.persona_source_analysis_jobs(
    asset_id,owner,persona_id,execution_mode,hosted_consent_snapshot,
    hosted_consent_version,hosted_consent_at
  ) values(
    p_asset_id,v_owner,v_asset.persona_id,p_execution_mode,
    p_execution_mode='hosted',
    case when p_execution_mode='hosted' then 1 else null end,
    case when p_execution_mode='hosted' then now() else null end
  ) returning id into v_job_id;
  update public.persona_source_assets asset set
    lifecycle_state='analysis_queued',updated_at=now()
  where asset.id=p_asset_id;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return v_job_id;
end
$$;

create or replace function public.cancel_persona_source_study(p_asset_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid:=auth.uid();v_job public.persona_source_analysis_jobs%rowtype;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if v_owner is null then raise exception 'Authentication required';end if;
  perform private.lock_persona_source_owner(v_owner);
  perform 1 from public.persona_source_assets asset
  where asset.id=p_asset_id and asset.owner=v_owner for update;
  if not found then raise exception 'Owned persona source asset not found';end if;
  select * into v_job from public.persona_source_analysis_jobs job
  where job.asset_id=p_asset_id and job.owner=v_owner
    and job.status in ('queued','claimed')
  order by job.created_at desc,job.id desc limit 1 for update;
  if not found then return 'none';end if;
  perform set_config('app.persona_source_rpc_writer','1',true);
  if v_job.status='queued' then
    update public.persona_source_analysis_jobs job set
      status='cancelled',cancel_requested=true,completed_at=now(),updated_at=now()
    where job.id=v_job.id;
    update public.persona_source_assets asset set
      lifecycle_state='ready',updated_at=now() where asset.id=p_asset_id;
  else
    update public.persona_source_analysis_jobs job set
      cancel_requested=true,updated_at=now() where job.id=v_job.id;
  end if;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return case when v_job.status='queued' then 'cancelled' else 'cancel_requested' end;
end
$$;

-- Claiming is deliberately separate from queueing. The database rechecks the
-- exact queued owner's current entitlement while selecting the job; a worker
-- cannot attest to access with a caller-controlled flag. SQL performs no
-- provider call and a queued row is never execution evidence.
create or replace function public.claim_persona_source_study_service(
  p_worker_label text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_candidate record;
  v_job public.persona_source_analysis_jobs%rowtype;
  v_asset public.persona_source_assets%rowtype;
  v_location private.persona_source_asset_locations%rowtype;
  v_lease uuid:=gen_random_uuid();
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if char_length(trim(coalesce(p_worker_label,''))) not between 3 and 120
     or p_worker_label~'[[:cntrl:]<>]' then raise exception 'Invalid worker label';end if;
  -- Candidate discovery is unlocked. The owner advisory lock is acquired
  -- before asset/job row locks so owner cancellation or consent revocation and
  -- worker finalization share one deadlock-safe serialization order.
  select job.id,job.owner,job.asset_id,job.persona_id into v_candidate
  from public.persona_source_analysis_jobs job
  where job.execution_mode='hosted' and (
      job.status='queued'
      or (job.status='claimed' and job.lease_expires_at<=now())
    )
    and not job.cancel_requested
    and public.account_has_billing_access(job.owner)
    and not exists(select 1
      from private.persona_source_account_deletion_guards guard_row
      where guard_row.owner=job.owner and guard_row.expires_at>now())
    and not exists(select 1 from private.persona_source_deletion_guards guard_row
      where guard_row.owner=job.owner and guard_row.persona_id=job.persona_id
        and guard_row.expires_at>now())
  order by job.created_at,job.id
  limit 1;
  if not found then return jsonb_build_object('status','empty');end if;
  perform private.lock_persona_source_owner(v_candidate.owner);
  select * into v_asset from public.persona_source_assets asset
  where asset.id=v_candidate.asset_id and asset.owner=v_candidate.owner for update;
  select * into v_job from public.persona_source_analysis_jobs job
  where job.id=v_candidate.id and job.owner=v_candidate.owner
    and job.execution_mode='hosted' and (
      job.status='queued'
      or (job.status='claimed' and job.lease_expires_at<=now())
    )
    and not job.cancel_requested
  for update;
  if not found or v_asset.id is null then
    return jsonb_build_object('status','empty');end if;
  if not public.account_has_billing_access(v_job.owner) then
    return jsonb_build_object('status','empty');end if;
  if exists(select 1 from private.persona_source_account_deletion_guards guard_row
      where guard_row.owner=v_job.owner and guard_row.expires_at>now())
     or exists(select 1 from private.persona_source_deletion_guards guard_row
      where guard_row.owner=v_job.owner and guard_row.persona_id=v_job.persona_id
        and guard_row.expires_at>now()) then
    return jsonb_build_object('status','empty');end if;
  if v_job.cancel_requested or v_asset.lifecycle_state in ('archived','deleting')
     or not v_asset.hosted_analysis_consent
     or v_asset.sensitivity='restricted' then
    perform set_config('app.persona_source_rpc_writer','1',true);
    update public.persona_source_analysis_jobs job set
      status='cancelled',cancel_requested=true,lease_token=null,
      lease_expires_at=null,completed_at=now(),updated_at=now()
    where job.id=v_job.id;
    if found then update public.persona_source_assets asset set
      lifecycle_state=case when asset.lifecycle_state='deleting'
        then 'deleting' else 'ready' end,
      updated_at=now() where asset.id=v_job.asset_id;end if;
    perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
    return jsonb_build_object('status','cancelled');
  end if;
  select * into v_location from private.persona_source_asset_locations location
  where location.asset_id=v_asset.id and location.owner=v_asset.owner;
  if not found then raise exception 'Source locator is unavailable';end if;
  perform set_config('app.persona_source_rpc_writer','1',true);
  update public.persona_source_analysis_jobs job set
    status='claimed',lease_token=v_lease,lease_expires_at=now()+interval '10 minutes',
    worker_label=trim(p_worker_label),started_at=coalesce(started_at,now()),updated_at=now()
  where job.id=v_job.id;
  update public.persona_source_assets asset set
    lifecycle_state='analyzing',updated_at=now() where asset.id=v_asset.id;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object(
    'status','claimed','job_id',v_job.id,'asset_id',v_asset.id,
    'owner',v_asset.owner,'persona_id',v_asset.persona_id,
    'execution_mode','hosted','lease_token',v_lease,
    'lease_expires_at',now()+interval '10 minutes',
    'storage_mode',v_location.storage_mode,'storage_path',v_location.storage_locator,
    'source_sha256',v_asset.source_sha256,'mime_type',v_asset.mime_type,
    'byte_size',v_asset.byte_size
  );
end
$$;

create or replace function public.finalize_persona_source_study_service(
  p_job_id uuid,p_lease_token uuid,p_outcome text,p_notes jsonb,
  p_provider_label text default '',p_model_label text default '',
  p_failure_code text default ''
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_job public.persona_source_analysis_jobs%rowtype;
  v_asset public.persona_source_assets%rowtype;v_note jsonb;v_key text;
  v_note_kind text;v_body text;v_confidence numeric;v_note_count integer:=0;
  v_outcome text:=p_outcome;v_forced_cancel boolean:=false;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_job_id is null or p_lease_token is null
     or p_outcome not in ('completed','failed','cancelled')
     or char_length(coalesce(p_provider_label,''))>120
     or char_length(coalesce(p_model_label,''))>160
     or coalesce(p_provider_label,'')~'[[:cntrl:]<>]'
     or coalesce(p_model_label,'')~'[[:cntrl:]<>]'
     or coalesce(p_failure_code,'')!~'^[a-z0-9_:-]{0,80}$' then
    raise exception 'Invalid source study completion';
  end if;
  if jsonb_typeof(coalesce(p_notes,'[]'::jsonb))<>'array'
     or jsonb_array_length(coalesce(p_notes,'[]'::jsonb))>20
     or octet_length(coalesce(p_notes,'[]'::jsonb)::text)>100000 then
    raise exception 'Source study notes are malformed or too large';
  end if;
  select * into v_job from public.persona_source_analysis_jobs job
  where job.id=p_job_id;
  if not found then raise exception 'Active source study lease not found';end if;
  perform private.lock_persona_source_owner(v_job.owner);
  select * into v_asset from public.persona_source_assets asset
  where asset.id=v_job.asset_id and asset.owner=v_job.owner for update;
  if not found then raise exception 'Source asset is unavailable';end if;
  select * into v_job from public.persona_source_analysis_jobs job
  where job.id=p_job_id for update;
  if not found or v_job.status<>'claimed' or v_job.lease_token<>p_lease_token then
    raise exception 'Active source study lease not found';end if;
  v_forced_cancel:=v_job.cancel_requested or (
    v_job.execution_mode='hosted' and (
      not v_asset.hosted_analysis_consent or v_asset.sensitivity='restricted'
    )
  );
  if v_forced_cancel then v_outcome:='cancelled';end if;
  if not v_forced_cancel and v_outcome<>'completed'
     and jsonb_array_length(coalesce(p_notes,'[]'::jsonb))<>0 then
    raise exception 'Only a completed study may create AI notes';end if;

  perform set_config('app.persona_source_rpc_writer','1',true);
  if v_outcome='completed' then
    for v_note in select value from jsonb_array_elements(coalesce(p_notes,'[]'::jsonb)) loop
      if jsonb_typeof(v_note)<>'object' then raise exception 'Study note must be an object';end if;
      for v_key in select jsonb_object_keys(v_note) loop
        if v_key not in ('note_kind','body','confidence') then
          raise exception 'Study note contains an unsupported field';end if;
      end loop;
      v_note_kind:=coalesce(v_note->>'note_kind','');
      v_body:=trim(coalesce(v_note->>'body',''));
      if v_note_kind not in ('description','research','content_idea','visual_reference','warning')
         or char_length(v_body) not between 1 and 5000 then
        raise exception 'Invalid AI source note';end if;
      if v_note ? 'confidence' then
        if jsonb_typeof(v_note->'confidence')<>'number' then
          raise exception 'AI source note confidence must be numeric';end if;
        v_confidence:=(v_note->>'confidence')::numeric;
        if v_confidence not between 0 and 1 then raise exception 'Invalid note confidence';end if;
      else v_confidence:=null;end if;
      insert into public.persona_source_notes(
        asset_id,owner,persona_id,author_kind,note_kind,review_state,body,
        confidence,analysis_job_id,provider_label,model_label
      ) values(
        v_job.asset_id,v_job.owner,v_job.persona_id,'ai',v_note_kind,'suggested',
        v_body,v_confidence,v_job.id,coalesce(p_provider_label,''),
        coalesce(p_model_label,'')
      );
      v_note_count:=v_note_count+1;
    end loop;
  end if;
  update public.persona_source_analysis_jobs job set
    status=v_outcome,lease_token=null,lease_expires_at=null,
    provider_label=case when v_outcome='completed' then coalesce(p_provider_label,'') else '' end,
    model_label=case when v_outcome='completed' then coalesce(p_model_label,'') else '' end,
    failure_code=case when v_outcome='failed'
      then coalesce(nullif(p_failure_code,''),'analysis_failed') else '' end,
    completed_at=now(),updated_at=now()
  where job.id=p_job_id;
  update public.persona_source_assets asset set
    lifecycle_state=case
      when v_asset.lifecycle_state='deleting' then 'deleting'
      when v_outcome='completed' and v_note_count>0 then 'review_required'
      when v_outcome='failed' then 'analysis_failed'
      else 'ready' end,
    updated_at=now()
  where asset.id=v_job.asset_id;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object(
    'status',v_outcome,'job_id',p_job_id,'asset_id',v_job.asset_id,
    'suggested_notes',v_note_count,'auto_publish',false
  );
end
$$;

create or replace function public.purge_persona_source_library_retention_batch_service(
  p_limit integer default 500
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_limit integer:=least(greatest(coalesce(p_limit,500),1),1000);
  v_reservations integer:=0;v_rate_rows integer:=0;
  v_stale_failed integer:=0;v_stale_cancelled integer:=0;
  v_deletion_guards integer:=0;v_account_deletion_guards integer:=0;
  v_expired_owner record;v_owner_reservations integer:=0;v_owner_bytes bigint:=0;
  v_stale_candidate record;v_stale_job public.persona_source_analysis_jobs%rowtype;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(70051009);
  -- Serialize expiry with reserve/write/register/release/deletion for each owner.
  for v_expired_owner in
    select reservation.owner,min(reservation.expires_at) as first_expiry
    from private.persona_source_upload_reservations reservation
    where reservation.state in ('reserved','writing')
      and reservation.expires_at<=now()
    group by reservation.owner
    order by first_expiry,reservation.owner
    limit v_limit
  loop
    exit when v_reservations>=v_limit;
    perform private.lock_persona_source_owner(v_expired_owner.owner);
    with expired as (
      select reservation.id,reservation.expected_bytes
      from private.persona_source_upload_reservations reservation
      where reservation.owner=v_expired_owner.owner
        and reservation.state in ('reserved','writing')
        and reservation.expires_at<=now()
      order by reservation.expires_at,reservation.id
      limit (v_limit-v_reservations) for update
    ), changed as (
      update private.persona_source_upload_reservations reservation set
        state='expired',updated_at=now()
      from expired where reservation.id=expired.id
      returning expired.expected_bytes
    )
    select count(*)::integer,coalesce(sum(expected_bytes),0)::bigint
    into v_owner_reservations,v_owner_bytes from changed;
    if v_owner_reservations>0 then
      update private.persona_source_quota_usage usage set
        reserved_asset_count=greatest(0,reserved_asset_count-v_owner_reservations),
        reserved_managed_bytes=greatest(0,reserved_managed_bytes-v_owner_bytes),
        updated_at=now()
      where usage.owner=v_expired_owner.owner;
      v_reservations:=v_reservations+v_owner_reservations;
    end if;
  end loop;

  with expired as (
    select limiter.owner,limiter.action,limiter.window_started
    from private.persona_source_request_rate_limits limiter
    where limiter.expires_at<=now()
    order by limiter.expires_at,limiter.owner,limiter.action,limiter.window_started
    limit v_limit for update skip locked
  )
  delete from private.persona_source_request_rate_limits limiter using expired
  where limiter.owner=expired.owner and limiter.action=expired.action
    and limiter.window_started=expired.window_started;
  get diagnostics v_rate_rows=row_count;

  with expired as (
    select guard_row.owner,guard_row.persona_id
    from private.persona_source_deletion_guards guard_row
    where guard_row.expires_at<=now()
    order by guard_row.expires_at,guard_row.owner,guard_row.persona_id
    limit v_limit for update skip locked
  )
  delete from private.persona_source_deletion_guards guard_row using expired
  where guard_row.owner=expired.owner and guard_row.persona_id=expired.persona_id;
  get diagnostics v_deletion_guards=row_count;

  with expired as (
    select guard_row.owner
    from private.persona_source_account_deletion_guards guard_row
    where guard_row.expires_at<=now()
    order by guard_row.expires_at,guard_row.owner
    limit v_limit for update skip locked
  )
  delete from private.persona_source_account_deletion_guards guard_row using expired
  where guard_row.owner=expired.owner;
  get diagnostics v_account_deletion_guards=row_count;

  perform set_config('app.persona_source_rpc_writer','1',true);
  for v_stale_candidate in
    select job.id,job.owner,job.asset_id
    from public.persona_source_analysis_jobs job
    where job.status='claimed' and job.lease_expires_at<=now()-interval '30 minutes'
    order by job.lease_expires_at,job.id
    limit v_limit
  loop
    perform private.lock_persona_source_owner(v_stale_candidate.owner);
    perform 1 from public.persona_source_assets asset
    where asset.id=v_stale_candidate.asset_id
      and asset.owner=v_stale_candidate.owner for update;
    if not found then continue;end if;
    select * into v_stale_job from public.persona_source_analysis_jobs job
    where job.id=v_stale_candidate.id and job.status='claimed'
      and job.lease_expires_at<=now()-interval '30 minutes'
    for update;
    if not found then continue;end if;
    update public.persona_source_analysis_jobs job set
      status=case when v_stale_job.cancel_requested then 'cancelled' else 'failed' end,
      lease_token=null,lease_expires_at=null,
      failure_code=case when v_stale_job.cancel_requested then '' else 'stale_worker_lease' end,
      completed_at=now(),updated_at=now()
    where job.id=v_stale_job.id;
    update public.persona_source_assets asset set
      lifecycle_state=case when asset.lifecycle_state='deleting' then 'deleting'
        when v_stale_job.cancel_requested
        then 'ready' else 'analysis_failed' end,
      updated_at=now()
    where asset.id=v_stale_job.asset_id;
    if v_stale_job.cancel_requested then
      v_stale_cancelled:=v_stale_cancelled+1;
    else v_stale_failed:=v_stale_failed+1;end if;
  end loop;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object(
    'expired_reservations',v_reservations,
    'expired_rate_rows',v_rate_rows,
    'stale_jobs_failed',v_stale_failed,
    'stale_jobs_cancelled',v_stale_cancelled,
    'expired_deletion_guards',v_deletion_guards,
    'expired_account_deletion_guards',v_account_deletion_guards
  );
end
$$;

create or replace function public.begin_persona_source_deletion_service(
  p_owner uuid,p_persona_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_guard private.persona_source_deletion_guards%rowtype;
  v_reserved integer:=0;v_reserved_bytes bigint:=0;v_active_writes integer:=0;
  v_active_studies integer:=0;
  v_token uuid:=gen_random_uuid();
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_persona_id is null
     or not exists(select 1 from public.personas persona
       where persona.id=p_persona_id and persona.owner=p_owner) then
    raise exception 'Owned persona not found';end if;
  perform private.lock_persona_source_owner(p_owner);
  if exists(select 1 from private.persona_source_account_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_ACCOUNT_DELETING';end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_persona_id::text,70051002)
  );
  select * into v_guard from private.persona_source_deletion_guards guard_row
  where guard_row.owner=p_owner and guard_row.persona_id=p_persona_id for update;
  if not found or v_guard.expires_at<=now() then
    insert into private.persona_source_deletion_guards(
      owner,persona_id,guard_token,state,expires_at
    ) values(p_owner,p_persona_id,v_token,'active',now()+interval '15 minutes')
    on conflict(owner,persona_id) do update set
      guard_token=excluded.guard_token,state='active',
      expires_at=excluded.expires_at,created_at=now(),updated_at=now()
    returning * into v_guard;
  end if;
  select count(*) into v_active_writes
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.persona_id=p_persona_id
    and reservation.state='writing';
  select count(*),coalesce(sum(reservation.expected_bytes),0)
  into v_reserved,v_reserved_bytes
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.persona_id=p_persona_id
    and reservation.state='reserved';
  update private.persona_source_upload_reservations reservation set
    state='released',updated_at=now()
  where reservation.owner=p_owner and reservation.persona_id=p_persona_id
    and reservation.state='reserved';
  update private.persona_source_quota_usage usage set
    reserved_asset_count=greatest(0,reserved_asset_count-v_reserved),
    reserved_managed_bytes=greatest(0,reserved_managed_bytes-v_reserved_bytes),
    updated_at=now()
  where usage.owner=p_owner;
  perform set_config('app.persona_source_rpc_writer','1',true);
  update public.persona_source_analysis_jobs job set
    status='cancelled',cancel_requested=true,completed_at=now(),updated_at=now()
  where job.owner=p_owner and job.persona_id=p_persona_id
    and job.execution_mode='hosted' and job.status='queued';
  update public.persona_source_analysis_jobs job set
    cancel_requested=true,updated_at=now()
  where job.owner=p_owner and job.persona_id=p_persona_id
    and job.execution_mode='hosted' and job.status='claimed';
  select count(*) into v_active_studies
  from public.persona_source_analysis_jobs job
  where job.owner=p_owner and job.persona_id=p_persona_id and job.status='claimed';
  update public.persona_source_assets asset set
    lifecycle_state='ready',updated_at=now()
  where asset.owner=p_owner and asset.persona_id=p_persona_id
    and asset.lifecycle_state in ('analysis_queued','analyzing')
    and not exists(select 1 from public.persona_source_analysis_jobs job
      where job.asset_id=asset.id and job.status in ('queued','claimed'));
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object(
    'status',v_guard.state,'guard_token',v_guard.guard_token,
    'expires_at',v_guard.expires_at,
    'persona_prefix',p_owner::text||'/personas/'||p_persona_id::text||'/',
    'active_writes',v_active_writes,'active_studies',v_active_studies,
    'released_reservations',v_reserved
  );
end
$$;

create or replace function public.begin_persona_source_account_deletion_service(
  p_owner uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_guard private.persona_source_account_deletion_guards%rowtype;
  v_reserved integer:=0;v_reserved_bytes bigint:=0;v_active_writes integer:=0;
  v_active_studies integer:=0;
  v_token uuid:=gen_random_uuid();
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required';end if;
  perform private.lock_persona_source_owner(p_owner);
  select * into v_guard
  from private.persona_source_account_deletion_guards guard_row
  where guard_row.owner=p_owner for update;
  if not found or v_guard.expires_at<=now() then
    if not exists(select 1 from public.profiles profile where profile.id=p_owner) then
      raise exception 'Owned account not found';end if;
    insert into private.persona_source_account_deletion_guards(
      owner,guard_token,state,expires_at
    ) values(p_owner,v_token,'active',now()+interval '15 minutes')
    on conflict(owner) do update set
      guard_token=excluded.guard_token,state='active',
      expires_at=excluded.expires_at,created_at=now(),updated_at=now()
    returning * into v_guard;
  end if;
  select count(*) into v_active_writes
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.state='writing';
  select count(*),coalesce(sum(reservation.expected_bytes),0)
  into v_reserved,v_reserved_bytes
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.state='reserved';
  update private.persona_source_upload_reservations reservation set
    state='released',updated_at=now()
  where reservation.owner=p_owner and reservation.state='reserved';
  update private.persona_source_quota_usage usage set
    reserved_asset_count=greatest(0,reserved_asset_count-v_reserved),
    reserved_managed_bytes=greatest(0,reserved_managed_bytes-v_reserved_bytes),
    updated_at=now()
  where usage.owner=p_owner;
  perform set_config('app.persona_source_rpc_writer','1',true);
  update public.persona_source_analysis_jobs job set
    status='cancelled',cancel_requested=true,completed_at=now(),updated_at=now()
  where job.owner=p_owner and job.execution_mode='hosted' and job.status='queued';
  update public.persona_source_analysis_jobs job set
    cancel_requested=true,updated_at=now()
  where job.owner=p_owner and job.execution_mode='hosted' and job.status='claimed';
  select count(*) into v_active_studies
  from public.persona_source_analysis_jobs job
  where job.owner=p_owner and job.status='claimed';
  update public.persona_source_assets asset set
    lifecycle_state='ready',updated_at=now()
  where asset.owner=p_owner
    and asset.lifecycle_state in ('analysis_queued','analyzing')
    and not exists(select 1 from public.persona_source_analysis_jobs job
      where job.asset_id=asset.id and job.status in ('queued','claimed'));
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object(
    'status',v_guard.state,'guard_token',v_guard.guard_token,
    'expires_at',v_guard.expires_at,'owner_prefix',p_owner::text||'/',
    'active_writes',v_active_writes,'active_studies',v_active_studies,
    'released_reservations',v_reserved
  );
end
$$;

create or replace function public.release_persona_source_account_deletion_guard_service(
  p_owner uuid,p_guard_token uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_guard_token is null then
    raise exception 'Owner and guard token are required';end if;
  perform private.lock_persona_source_owner(p_owner);
  delete from private.persona_source_account_deletion_guards guard_row
  where guard_row.owner=p_owner and guard_row.guard_token=p_guard_token;
  if not found then
    return jsonb_build_object('released',false,'status','missing');end if;
  return jsonb_build_object('released',true,'status','released');
end
$$;

create or replace function public.list_persona_source_paths_for_persona_service(
  p_owner uuid,p_persona_id uuid,p_after_asset_id uuid default null,
  p_limit integer default 100
)
returns table(
  asset_id uuid,storage_path text,source_sha256 text,byte_size bigint
)
language plpgsql security definer stable set search_path='' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_persona_id is null
     or not exists(select 1 from public.personas persona
       where persona.id=p_persona_id and persona.owner=p_owner) then
    raise exception 'Owned persona not found';end if;
  if not exists(select 1 from private.persona_source_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.persona_id=p_persona_id
      and guard_row.state='active' and guard_row.expires_at>now()) then
    raise exception 'Active persona source deletion guard required';end if;
  return query
  select asset.id,location.storage_locator,asset.source_sha256,asset.byte_size
  from public.persona_source_assets asset
  join private.persona_source_asset_locations location
    on location.asset_id=asset.id and location.owner=asset.owner
  where asset.owner=p_owner and asset.persona_id=p_persona_id
    and location.storage_mode='managed_private'
    and (p_after_asset_id is null or asset.id>p_after_asset_id)
  order by asset.id
  limit least(greatest(coalesce(p_limit,100),1),200);
end
$$;

create or replace function public.delete_persona_source_library_for_persona_service(
  p_owner uuid,p_persona_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_assets integer;v_managed_bytes bigint;v_reserved integer;v_reserved_bytes bigint;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_persona_id is null
     or not exists(select 1 from public.personas persona
       where persona.id=p_persona_id and persona.owner=p_owner) then
    raise exception 'Owned persona not found';end if;
  perform private.lock_persona_source_owner(p_owner);
  if exists(select 1 from private.persona_source_account_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.expires_at>now()) then
    raise exception 'PERSONA_SOURCE_ACCOUNT_DELETING';end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_persona_id::text,70051002)
  );
  if not exists(select 1 from private.persona_source_deletion_guards guard_row
    where guard_row.owner=p_owner and guard_row.persona_id=p_persona_id
      and guard_row.state in ('active','metadata_deleted')
      and guard_row.expires_at>now()) then
    raise exception 'Active persona source deletion guard required';end if;
  if exists(select 1 from private.persona_source_upload_reservations reservation
    where reservation.owner=p_owner and reservation.persona_id=p_persona_id
      and reservation.state='writing') then
    raise exception 'PERSONA_SOURCE_ACTIVE_WRITES_RETRY';end if;
  if exists(select 1 from public.persona_source_analysis_jobs job
    where job.owner=p_owner and job.persona_id=p_persona_id
      and job.status='claimed') then
    raise exception 'PERSONA_SOURCE_ACTIVE_STUDIES_RETRY';end if;
  if exists(
    select 1 from storage.objects object
    where object.bucket_id='persona-source-library'
      and object.name like
        p_owner::text||'/personas/'||p_persona_id::text||'/%'
  ) then raise exception 'Delete persona private Storage bytes before metadata';end if;
  select count(*),coalesce(sum(case when asset.storage_mode='managed_private'
    then asset.byte_size else 0 end),0)
  into v_assets,v_managed_bytes from public.persona_source_assets asset
  where asset.owner=p_owner and asset.persona_id=p_persona_id;
  select count(*),coalesce(sum(reservation.expected_bytes),0)
  into v_reserved,v_reserved_bytes
  from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.persona_id=p_persona_id
    and reservation.state in ('reserved','writing');
  perform set_config('app.persona_source_rpc_writer','1',true);
  delete from public.persona_source_assets asset
  where asset.owner=p_owner and asset.persona_id=p_persona_id;
  delete from private.persona_source_upload_reservations reservation
  where reservation.owner=p_owner and reservation.persona_id=p_persona_id;
  update private.persona_source_quota_usage usage set
    active_asset_count=greatest(0,active_asset_count-v_assets),
    active_managed_bytes=greatest(0,active_managed_bytes-v_managed_bytes),
    reserved_asset_count=greatest(0,reserved_asset_count-v_reserved),
    reserved_managed_bytes=greatest(0,reserved_managed_bytes-v_reserved_bytes),
    updated_at=now()
  where usage.owner=p_owner;
  update private.persona_source_deletion_guards guard_row set
    state='metadata_deleted',expires_at=now()+interval '1 hour',updated_at=now()
  where guard_row.owner=p_owner and guard_row.persona_id=p_persona_id;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object(
    'persona_id',p_persona_id,'assets_deleted',v_assets,
    'managed_bytes_released',v_managed_bytes,'reservations_deleted',v_reserved,
    'status','metadata_deleted'
  );
end
$$;

create or replace function public.delete_persona_source_library_for_account_service(
  p_owner uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_assets integer;v_notes integer;v_jobs integer;v_reservations integer;
  v_previous_writer text:=coalesce(
    current_setting('app.persona_source_rpc_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required';end if;
  perform private.lock_persona_source_owner(p_owner);
  if not exists(select 1 from private.persona_source_account_deletion_guards guard_row
    where guard_row.owner=p_owner
      and guard_row.state in ('active','metadata_deleted')
      and guard_row.expires_at>now()) then
    raise exception 'Active account source deletion guard required';end if;
  if exists(select 1 from private.persona_source_upload_reservations reservation
    where reservation.owner=p_owner and reservation.state='writing') then
    raise exception 'PERSONA_SOURCE_ACTIVE_WRITES_RETRY';end if;
  if exists(select 1 from public.persona_source_analysis_jobs job
    where job.owner=p_owner and job.status='claimed') then
    raise exception 'PERSONA_SOURCE_ACTIVE_STUDIES_RETRY';end if;
  if exists(
    select 1 from storage.objects object
    where object.bucket_id='persona-source-library'
      and object.name like p_owner::text||'/%'
  ) then raise exception 'Delete all private Storage bytes before account metadata';end if;
  select count(*) into v_assets from public.persona_source_assets asset where asset.owner=p_owner;
  select count(*) into v_notes from public.persona_source_notes note where note.owner=p_owner;
  select count(*) into v_jobs from public.persona_source_analysis_jobs job where job.owner=p_owner;
  select count(*) into v_reservations
  from private.persona_source_upload_reservations reservation where reservation.owner=p_owner;
  perform set_config('app.persona_source_rpc_writer','1',true);
  delete from public.persona_source_assets asset where asset.owner=p_owner;
  delete from private.persona_source_upload_reservations reservation where reservation.owner=p_owner;
  delete from private.persona_source_idempotency_receipts receipt where receipt.owner=p_owner;
  delete from private.persona_source_request_rate_limits limiter where limiter.owner=p_owner;
  delete from private.persona_source_deletion_guards guard_row where guard_row.owner=p_owner;
  delete from private.persona_source_quota_usage usage where usage.owner=p_owner;
  update private.persona_source_account_deletion_guards guard_row set
    state='metadata_deleted',expires_at=now()+interval '1 hour',updated_at=now()
  where guard_row.owner=p_owner;
  perform set_config('app.persona_source_rpc_writer',v_previous_writer,true);
  return jsonb_build_object(
    'assets_deleted',v_assets,'notes_deleted',v_notes,'jobs_deleted',v_jobs,
    'reservations_deleted',v_reservations,'status','metadata_deleted'
  );
end
$$;

revoke all on function public.update_persona_source_asset(uuid,jsonb),
  public.add_persona_source_note(uuid,text,text),
  public.review_persona_source_note(uuid,text),
  public.queue_persona_source_study(uuid,text),
  public.cancel_persona_source_study(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.update_persona_source_asset(uuid,jsonb),
  public.add_persona_source_note(uuid,text,text),
  public.review_persona_source_note(uuid,text),
  public.queue_persona_source_study(uuid,text),
  public.cancel_persona_source_study(uuid)
  to authenticated;

revoke all on function public.consume_persona_source_rate_limit_service(uuid,text),
  public.reserve_persona_source_upload_service(uuid,uuid,bigint,text,uuid),
  public.begin_persona_source_storage_write_service(uuid,uuid),
  public.release_persona_source_upload_service(uuid,uuid),
  public.register_persona_source_asset_service(
    uuid,uuid,text,text,text,bigint,integer,integer,text,text,text,text,text,text,
    boolean,text,text,text[],timestamptz,uuid
  ),
  public.resolve_persona_source_asset_service(uuid,uuid),
  public.begin_persona_source_asset_deletion_service(uuid,uuid),
  public.delete_persona_source_asset_metadata_service(uuid,uuid,text,text),
  public.claim_persona_source_study_service(text),
  public.finalize_persona_source_study_service(uuid,uuid,text,jsonb,text,text,text),
  public.purge_persona_source_library_retention_batch_service(integer),
  public.begin_persona_source_deletion_service(uuid,uuid),
  public.begin_persona_source_account_deletion_service(uuid),
  public.release_persona_source_account_deletion_guard_service(uuid,uuid),
  public.list_persona_source_paths_for_persona_service(uuid,uuid,uuid,integer),
  public.delete_persona_source_library_for_persona_service(uuid,uuid),
  public.delete_persona_source_library_for_account_service(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.consume_persona_source_rate_limit_service(uuid,text),
  public.reserve_persona_source_upload_service(uuid,uuid,bigint,text,uuid),
  public.begin_persona_source_storage_write_service(uuid,uuid),
  public.release_persona_source_upload_service(uuid,uuid),
  public.register_persona_source_asset_service(
    uuid,uuid,text,text,text,bigint,integer,integer,text,text,text,text,text,text,
    boolean,text,text,text[],timestamptz,uuid
  ),
  public.resolve_persona_source_asset_service(uuid,uuid),
  public.begin_persona_source_asset_deletion_service(uuid,uuid),
  public.delete_persona_source_asset_metadata_service(uuid,uuid,text,text),
  public.claim_persona_source_study_service(text),
  public.finalize_persona_source_study_service(uuid,uuid,text,jsonb,text,text,text),
  public.purge_persona_source_library_retention_batch_service(integer),
  public.begin_persona_source_deletion_service(uuid,uuid),
  public.begin_persona_source_account_deletion_service(uuid),
  public.release_persona_source_account_deletion_guard_service(uuid,uuid),
  public.list_persona_source_paths_for_persona_service(uuid,uuid,uuid,integer),
  public.delete_persona_source_library_for_persona_service(uuid,uuid),
  public.delete_persona_source_library_for_account_service(uuid)
  to service_role;

commit;
