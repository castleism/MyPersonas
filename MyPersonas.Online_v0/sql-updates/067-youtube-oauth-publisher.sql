-- First-class YouTube OAuth and exact-approved private-first video uploads.
-- Tokens and resumable-session URLs are capabilities and therefore live only
-- in Supabase Vault. Browser roles can read owner-scoped status/approvals but
-- cannot write credentials, upload sessions, or approval receipts directly.

begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;

create table if not exists public.youtube_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  code_verifier text not null check (char_length(code_verifier) between 43 and 128),
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  return_origin text not null check (char_length(return_origin) between 1 and 255),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);

create unique index if not exists youtube_oauth_transactions_owner_ledger_idx
  on public.youtube_oauth_transactions(owner,ledger_id);
create index if not exists youtube_oauth_transactions_expiry_idx
  on public.youtube_oauth_transactions(expires_at);

create table if not exists public.youtube_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  google_subject text not null check (google_subject ~ '^[0-9]{1,64}$'),
  provider_email text not null check (char_length(provider_email) between 3 and 320),
  channel_id text not null check (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  channel_title text not null default '' check (char_length(channel_title) <= 100),
  vault_secret_id uuid not null unique,
  updated_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade,
  unique(owner,channel_id)
);

create table if not exists public.youtube_token_operation_leases (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  lease_id uuid not null,
  operation_kind text not null check (operation_kind in ('connect','refresh','disconnect','publish','verify')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);
create index if not exists youtube_token_operation_leases_expiry_idx
  on public.youtube_token_operation_leases(expires_at);

create table if not exists public.youtube_upload_approvals (
  draft_id uuid primary key references public.drafts(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  channel_id text not null check (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  video_asset_id uuid not null references public.persona_media_assets(id) on delete restrict,
  video_sha256 text not null check (video_sha256 ~ '^[0-9a-f]{64}$'),
  video_byte_size bigint not null check (video_byte_size between 1 and 15728640),
  video_mime text not null check (video_mime in ('video/mp4','video/webm')),
  title text not null check (char_length(title) between 1 and 100 and title !~ '[<>]'),
  description text not null check (octet_length(description) between 1 and 5000 and description !~ '[<>]'),
  made_for_kids boolean not null,
  contains_synthetic_media boolean not null,
  privacy_status text not null default 'private' check (privacy_status = 'private'),
  category_id text not null default '22' check (category_id = '22'),
  preview_version text not null check (preview_version = 'youtube-preview-v1'),
  draft_content_hash text not null check (draft_content_hash ~ '^[0-9a-f]{64}$'),
  approval_hash text not null check (approval_hash ~ '^[0-9a-f]{64}$'),
  preview_hash text not null check (preview_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid not null,
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade,
  foreign key (approved_by) references public.profiles(id) on delete cascade,
  check (approved_by=owner),
  unique(owner,approval_hash)
);
create index if not exists youtube_upload_approvals_owner_idx
  on public.youtube_upload_approvals(owner,approved_at desc);

-- One shared, provider-action-time receipt contract for the remaining native
-- connectors.  Edge Functions prepare these rows exclusively from current
-- database/provider state.  The owner can only read and AAL2-acknowledge the
-- exact immutable snapshot; a service writer must then rederive the same
-- target/content/action hashes and consume it once before any provider action
-- or native-editor handoff.
create table if not exists public.provider_action_preview_receipts (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid not null references public.drafts(id) on delete cascade,
  ledger_id uuid not null,
  provider text not null check (provider in (
    'youtube','tiktok','wix','wordpress','twitch','patreon'
  )),
  action text not null check (char_length(action) between 3 and 100),
  target_id text not null check (char_length(target_id) between 1 and 1024),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  action_hash text not null check (action_hash ~ '^[0-9a-f]{64}$'),
  preview_version text not null check (char_length(preview_version) between 3 and 100),
  preview_payload jsonb not null check (jsonb_typeof(preview_payload)='object'),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  prepared_at timestamptz not null,
  expires_at timestamptz not null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles(id) on delete set null,
  consumed_at timestamptz,
  consumed_claim_id uuid,
  consumed_claim_kind text,
  invalidated_at timestamptz,
  invalidation_reason text not null default '' check (char_length(invalidation_reason)<=160),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade,
  constraint provider_action_preview_receipts_lifetime_check
    check (expires_at>prepared_at and expires_at<=prepared_at+interval '5 minutes'),
  constraint provider_action_preview_receipts_acknowledgement_check check (
    (acknowledged_at is null and acknowledged_by is null)
    or (acknowledged_at is not null and acknowledged_by=owner
      and acknowledged_at>=prepared_at and acknowledged_at<expires_at)
  ),
  constraint provider_action_preview_receipts_consumption_check
    check (consumed_at is null or (acknowledged_at is not null and acknowledged_by=owner))
);
alter table public.provider_action_preview_receipts
  add column if not exists acknowledged_by uuid references public.profiles(id) on delete set null,
  add column if not exists consumed_claim_id uuid,
  add column if not exists consumed_claim_kind text;
update public.provider_action_preview_receipts
set acknowledged_by=owner
where acknowledged_at is not null and acknowledged_by is null;
alter table public.provider_action_preview_receipts
  drop constraint if exists provider_action_preview_receipts_lifetime_check,
  add constraint provider_action_preview_receipts_lifetime_check
    check (expires_at>prepared_at and expires_at<=prepared_at+interval '5 minutes'),
  drop constraint if exists provider_action_preview_receipts_acknowledgement_check,
  add constraint provider_action_preview_receipts_acknowledgement_check check (
    (acknowledged_at is null and acknowledged_by is null)
    or (acknowledged_at is not null and acknowledged_by=owner
      and acknowledged_at>=prepared_at and acknowledged_at<expires_at)
  ),
  drop constraint if exists provider_action_preview_receipts_consumption_check,
  add constraint provider_action_preview_receipts_consumption_check
    check (consumed_at is null or (acknowledged_at is not null and acknowledged_by=owner)),
  drop constraint if exists provider_action_preview_receipts_claim_binding_check,
  add constraint provider_action_preview_receipts_claim_binding_check check (
    (consumed_claim_id is null and consumed_claim_kind is null)
    or (consumed_at is not null and consumed_claim_id is not null
      and char_length(consumed_claim_kind) between 3 and 80)
  );
create index if not exists provider_action_preview_receipts_owner_draft_idx
  on public.provider_action_preview_receipts(owner,draft_id,provider,prepared_at desc);
create index if not exists provider_action_preview_receipts_open_idx
  on public.provider_action_preview_receipts(expires_at)
  where consumed_at is null and invalidated_at is null;

create table if not exists public.youtube_upload_sessions (
  draft_id uuid primary key references public.drafts(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  approval_hash text not null check (approval_hash ~ '^[0-9a-f]{64}$'),
  vault_secret_id uuid not null unique,
  byte_total bigint not null check (byte_total between 1 and 15728640),
  uploaded_through bigint not null default -1,
  state text not null default 'initiated'
    check (state in ('initiated','uploading','processing','processed','failed','reconciliation_required')),
  provider_video_id text not null default ''
    check (provider_video_id = '' or provider_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  processing_status text not null default ''
    check (processing_status in ('','processing','succeeded','failed','terminated')),
  last_error text not null default '' check (char_length(last_error) <= 1000),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade,
  foreign key (owner,approval_hash) references public.youtube_upload_approvals(owner,approval_hash) on delete cascade,
  check (uploaded_through between -1 and byte_total-1),
  check (state not in ('processing','processed') or provider_video_id<>'')
);

alter table public.youtube_oauth_transactions enable row level security;
alter table public.youtube_credentials enable row level security;
alter table public.youtube_token_operation_leases enable row level security;
alter table public.youtube_upload_approvals enable row level security;
alter table public.youtube_upload_sessions enable row level security;
alter table public.provider_action_preview_receipts enable row level security;

revoke all on public.youtube_oauth_transactions,public.youtube_credentials,
  public.youtube_token_operation_leases,public.youtube_upload_sessions
  from anon,authenticated;
grant all on public.youtube_oauth_transactions,public.youtube_credentials,
  public.youtube_token_operation_leases,public.youtube_upload_sessions to service_role;
revoke all on public.youtube_upload_approvals from anon,authenticated;
grant select on public.youtube_upload_approvals to authenticated;
grant all on public.youtube_upload_approvals to service_role;
revoke all on public.provider_action_preview_receipts from public,anon,authenticated;
grant select on public.provider_action_preview_receipts to authenticated;
grant all on public.provider_action_preview_receipts to service_role;

drop policy if exists "youtube upload approvals owner read" on public.youtube_upload_approvals;
create policy "youtube upload approvals owner read" on public.youtube_upload_approvals
  for select using (owner=auth.uid());
drop policy if exists "provider action preview receipts owner read"
  on public.provider_action_preview_receipts;
create policy "provider action preview receipts owner read"
  on public.provider_action_preview_receipts for select to authenticated
  using ((select auth.uid())=owner);

create or replace function public.prepare_provider_action_preview_service(
  p_owner uuid,p_draft_id uuid,p_ledger_id uuid,p_provider text,p_action text,
  p_target_id text,p_content_hash text,p_action_hash text,p_preview_version text,
  p_preview_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_id uuid:=gen_random_uuid();
  v_prepared timestamptz:=clock_timestamp();
  v_expires timestamptz:=v_prepared+interval '5 minutes';
  v_provider text:=lower(trim(coalesce(p_provider,'')));
  v_action text:=lower(trim(coalesce(p_action,'')));
  v_payload jsonb;
  v_hash text;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role'
    then raise exception 'Provider preview preparation is service-only'; end if;
  if v_provider not in ('youtube','tiktok','wix','wordpress','twitch','patreon')
    or trim(coalesce(p_target_id,''))=''
    or p_content_hash!~'^[0-9a-f]{64}$' or p_action_hash!~'^[0-9a-f]{64}$'
    or trim(coalesce(p_preview_version,''))=''
    or jsonb_typeof(p_preview_payload)<>'object' then
    raise exception 'Exact provider preview evidence is required';
  end if;
  if not exists(select 1 from public.drafts d
    where d.id=p_draft_id and d.owner=p_owner and d.account_id=p_ledger_id)
    then raise exception 'Owned provider draft and destination are required'; end if;
  if not (
    (v_provider='youtube' and v_action='youtube.publish_private')
    or (v_provider='tiktok' and v_action in ('tiktok.upload_inbox','tiktok.direct_post'))
    or (v_provider='wix' and v_action='wix.create_draft')
    or (v_provider='wordpress' and v_action='wordpress.create_draft')
    or (v_provider='twitch' and v_action in (
      'twitch.channel_update','twitch.schedule_segment_create','twitch.chat_announcement'
    ))
    or (v_provider='patreon' and v_action in (
      'patreon.save_draft','patreon.publish_now','patreon.schedule'
    ))
  ) then raise exception 'Unsupported provider preview action'; end if;

  v_payload:=p_preview_payload||jsonb_build_object(
    'receiptVersion','provider-action-preview-receipt-v1','receiptId',v_id,
    'provider',v_provider,'action',v_action,'targetId',trim(p_target_id),
    'contentHash',p_content_hash,'actionHash',p_action_hash,
    'previewVersion',p_preview_version,'preparedAt',v_prepared,'expiresAt',v_expires
  );
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_array(
    v_id,p_owner,p_draft_id,p_ledger_id,v_provider,v_action,trim(p_target_id),
    p_content_hash,p_action_hash,p_preview_version,v_payload,v_prepared,v_expires
  )::text,'UTF8'),'sha256'),'hex');
  v_payload:=v_payload||jsonb_build_object('receiptHash',v_hash);

  update public.provider_action_preview_receipts r
  set invalidated_at=v_prepared,invalidation_reason='superseded_by_new_preview'
  where r.owner=p_owner and r.draft_id=p_draft_id and r.provider=v_provider
    and r.consumed_at is null and r.invalidated_at is null;
  insert into public.provider_action_preview_receipts(
    id,owner,draft_id,ledger_id,provider,action,target_id,content_hash,action_hash,
    preview_version,preview_payload,receipt_hash,prepared_at,expires_at
  ) values (
    v_id,p_owner,p_draft_id,p_ledger_id,v_provider,v_action,trim(p_target_id),
    p_content_hash,p_action_hash,p_preview_version,v_payload,v_hash,v_prepared,v_expires
  );
  return jsonb_build_object(
    'receiptId',v_id,'receiptHash',v_hash,'previewVersion',p_preview_version,
    'preparedAt',v_prepared,'expiresAt',v_expires,'preview',v_payload
  );
end; $$;

create or replace function public.acknowledge_provider_action_preview(
  p_receipt_id uuid,p_receipt_hash text,p_preview_version text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid:=(select auth.uid());
  r public.provider_action_preview_receipts%rowtype;
  v_expected text;
  v_now timestamptz:=clock_timestamp();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select * into r from public.provider_action_preview_receipts receipt
  where receipt.id=p_receipt_id and receipt.owner=v_owner for update;
  if not found or r.invalidated_at is not null or r.consumed_at is not null
    or r.expires_at<=v_now or r.prepared_at>v_now then
    raise exception 'The provider preview receipt is missing, expired, used, or invalidated';
  end if;
  if p_receipt_hash is distinct from r.receipt_hash
    or p_preview_version is distinct from r.preview_version then
    raise exception 'The acknowledged provider preview does not match the server snapshot';
  end if;
  v_expected:=encode(extensions.digest(convert_to(jsonb_build_array(
    r.id,r.owner,r.draft_id,r.ledger_id,r.provider,r.action,r.target_id,
    r.content_hash,r.action_hash,r.preview_version,
    r.preview_payload-'receiptHash',r.prepared_at,r.expires_at
  )::text,'UTF8'),'sha256'),'hex');
  if v_expected is distinct from r.receipt_hash
    or r.preview_payload->>'receiptHash' is distinct from r.receipt_hash then
    raise exception 'The provider preview receipt failed integrity verification';
  end if;
  if r.acknowledged_at is not null and r.acknowledged_by is distinct from v_owner then
    raise exception 'The provider preview receipt was acknowledged by a different owner';
  end if;
  update public.provider_action_preview_receipts receipt
  set acknowledged_at=v_now,acknowledged_by=v_owner
  where receipt.id=r.id and receipt.owner=v_owner
    and receipt.acknowledged_at is null and receipt.acknowledged_by is null
    and receipt.consumed_at is null
    and receipt.invalidated_at is null and receipt.expires_at>v_now;
  if not found and r.acknowledged_at is null then
    raise exception 'The provider preview could not be acknowledged';
  end if;
  return jsonb_build_object(
    'acknowledged',true,'receiptId',r.id,'receiptHash',r.receipt_hash,
    'previewVersion',r.preview_version,'expiresAt',r.expires_at
  );
end; $$;

create or replace function public.consume_provider_action_preview_service(
  p_owner uuid,p_draft_id uuid,p_ledger_id uuid,p_provider text,p_action text,
  p_receipt_id uuid,p_target_id text,p_content_hash text,p_action_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  r public.provider_action_preview_receipts%rowtype;
  v_expected text;
  v_now timestamptz:=clock_timestamp();
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role'
    then raise exception 'Provider preview consumption is service-only'; end if;
  select * into r from public.provider_action_preview_receipts receipt
  where receipt.id=p_receipt_id and receipt.owner=p_owner
    and receipt.draft_id=p_draft_id and receipt.ledger_id=p_ledger_id
    and receipt.provider=lower(trim(p_provider)) and receipt.action=lower(trim(p_action))
  for update;
  if not found or r.acknowledged_at is null or r.acknowledged_by is distinct from p_owner
    or r.acknowledged_at>=r.expires_at or r.consumed_at is not null
    or r.invalidated_at is not null or r.expires_at<=v_now or r.prepared_at>v_now
    or r.target_id is distinct from trim(p_target_id)
    or r.content_hash is distinct from p_content_hash
    or r.action_hash is distinct from p_action_hash then
    raise exception 'A current acknowledged one-shot provider preview receipt is required';
  end if;
  v_expected:=encode(extensions.digest(convert_to(jsonb_build_array(
    r.id,r.owner,r.draft_id,r.ledger_id,r.provider,r.action,r.target_id,
    r.content_hash,r.action_hash,r.preview_version,
    r.preview_payload-'receiptHash',r.prepared_at,r.expires_at
  )::text,'UTF8'),'sha256'),'hex');
  if v_expected is distinct from r.receipt_hash
    or r.preview_payload->>'receiptHash' is distinct from r.receipt_hash then
    raise exception 'The provider preview receipt failed integrity verification';
  end if;
  update public.provider_action_preview_receipts receipt set consumed_at=v_now
  where receipt.id=r.id and receipt.acknowledged_at is not null
    and receipt.acknowledged_by=p_owner
    and receipt.consumed_at is null and receipt.invalidated_at is null
    and receipt.expires_at>v_now;
  if not found then raise exception 'The provider preview receipt was already consumed'; end if;
  return r.preview_payload;
end; $$;

-- Internal-only claim binding. Provider wrappers call this helper and then
-- create their durable claim/attempt in the same transaction. Any later error
-- rolls both the receipt consumption and the provider claim back together.
create or replace function public.consume_provider_action_preview_for_claim_service(
  p_owner uuid,p_draft_id uuid,p_ledger_id uuid,p_provider text,p_action text,
  p_receipt_id uuid,p_target_id text,p_content_hash text,p_action_hash text,
  p_claim_id uuid,p_claim_kind text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_payload jsonb; v_count integer;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role'
    then raise exception 'Provider preview claim binding is service-only'; end if;
  if p_claim_id is null or char_length(trim(coalesce(p_claim_kind,''))) not between 3 and 80
    then raise exception 'A durable provider claim binding is required'; end if;
  v_payload:=public.consume_provider_action_preview_service(
    p_owner,p_draft_id,p_ledger_id,p_provider,p_action,p_receipt_id,
    p_target_id,p_content_hash,p_action_hash
  );
  update public.provider_action_preview_receipts receipt
  set consumed_claim_id=p_claim_id,consumed_claim_kind=trim(p_claim_kind)
  where receipt.id=p_receipt_id and receipt.owner=p_owner
    and receipt.consumed_at is not null and receipt.consumed_claim_id is null
    and receipt.consumed_claim_kind is null;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'The provider preview receipt claim could not be bound'; end if;
  return v_payload;
end; $$;

create or replace function public.invalidate_provider_action_previews_on_draft_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if row(new.owner,new.persona_id,new.account_id,new.platform,new.title,new.body,new.tags,
      new.media_url,new.content_kind,new.publish_at,new.approval_state,new.approved_content_hash,
      new.approved_preview_hash,new.approved_preview_target_id)
    is distinct from row(old.owner,old.persona_id,old.account_id,old.platform,old.title,old.body,old.tags,
      old.media_url,old.content_kind,old.publish_at,old.approval_state,old.approved_content_hash,
      old.approved_preview_hash,old.approved_preview_target_id) then
    update public.provider_action_preview_receipts receipt
    set invalidated_at=now(),invalidation_reason='draft_changed_after_preview'
    where receipt.draft_id=new.id and receipt.owner=old.owner
      and receipt.consumed_at is null and receipt.invalidated_at is null;
  end if;
  return new;
end; $$;
drop trigger if exists invalidate_provider_action_previews_on_draft_change on public.drafts;
create trigger invalidate_provider_action_previews_on_draft_change
  after update on public.drafts for each row
  execute function public.invalidate_provider_action_previews_on_draft_change();

create or replace function public.youtube_upload_approval_hash(
  p_draft_content_hash text,p_channel_id text,p_video_asset_id uuid,
  p_video_sha256 text,p_video_byte_size bigint,p_video_mime text,
  p_title text,p_description text,p_category_id text,p_made_for_kids boolean,
  p_contains_synthetic_media boolean,p_privacy_status text,p_preview_version text
) returns text language sql immutable set search_path='' as $$
  select encode(extensions.digest(convert_to(jsonb_build_array(
    coalesce(p_draft_content_hash,''),coalesce(p_channel_id,''),
    coalesce(p_video_asset_id::text,''),coalesce(p_video_sha256,''),
    coalesce(p_video_byte_size,0),coalesce(p_video_mime,''),coalesce(p_title,''),
    coalesce(p_description,''),coalesce(p_category_id,''),coalesce(p_made_for_kids,false),
    coalesce(p_contains_synthetic_media,false),coalesce(p_privacy_status,''),
    coalesce(p_preview_version,'')
  )::text,'UTF8'),'sha256'),'hex');
$$;

create or replace function public.claim_youtube_token_operation(
  p_ledger_id uuid,p_owner uuid,p_lease_id uuid,p_operation_kind text,p_ttl_seconds integer
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_operation_kind not in ('connect','refresh','disconnect','publish','verify')
    or p_ttl_seconds not between 15 and 300 then raise exception 'Invalid YouTube lease'; end if;
  delete from public.youtube_token_operation_leases where expires_at<=now();
  insert into public.youtube_token_operation_leases(ledger_id,owner,lease_id,operation_kind,expires_at)
  values(p_ledger_id,p_owner,p_lease_id,p_operation_kind,now()+make_interval(secs=>p_ttl_seconds))
  on conflict(ledger_id) do update set owner=excluded.owner,lease_id=excluded.lease_id,
    operation_kind=excluded.operation_kind,expires_at=excluded.expires_at,created_at=now()
  where public.youtube_token_operation_leases.expires_at<=now();
  return exists(select 1 from public.youtube_token_operation_leases
    where ledger_id=p_ledger_id and owner=p_owner and lease_id=p_lease_id and expires_at>now());
end; $$;

create or replace function public.release_youtube_token_operation(
  p_ledger_id uuid,p_owner uuid,p_lease_id uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  delete from public.youtube_token_operation_leases
    where ledger_id=p_ledger_id and owner=p_owner and lease_id=p_lease_id;
  get diagnostics v_count=row_count; return v_count>0;
end; $$;

create or replace function public.youtube_store_token_bundle(
  p_ledger_id uuid,p_owner uuid,p_google_subject text,p_provider_email text,
  p_channel_id text,p_channel_title text,p_access_token text,p_refresh_token text,
  p_token_type text,p_scope text,p_expires_at timestamptz
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_secret_id uuid; v_name text:='youtube_oauth_'||p_ledger_id::text;
  v_bundle text; v_provider text; v_login_email text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_google_subject!~'^[0-9]{1,64}$' or lower(trim(p_provider_email))!~'^[^@[:space:]]+@[^@[:space:]]+$'
    or p_channel_id!~'^UC[A-Za-z0-9_-]{22}$' then raise exception 'Invalid YouTube identity'; end if;
  if trim(coalesce(p_access_token,''))='' or trim(coalesce(p_refresh_token,''))=''
    or char_length(p_access_token)>16384 or char_length(p_refresh_token)>16384
    or lower(trim(p_token_type))<>'bearer' or p_expires_at<=now()
    or position('https://www.googleapis.com/auth/youtube.upload' in p_scope)=0 then
    raise exception 'Invalid YouTube token bundle';
  end if;
  select provider,lower(trim(coalesce(login_email,''))) into v_provider,v_login_email
    from public.account_ledger where id=p_ledger_id and owner=p_owner for update;
  if not found or v_provider<>'youtube' then raise exception 'Owned YouTube ledger changed'; end if;
  if v_login_email<>'' and v_login_email<>lower(trim(p_provider_email)) then
    raise exception 'YouTube login email does not match the ledger';
  end if;
  v_bundle:=jsonb_build_object('access_token',p_access_token,'refresh_token',p_refresh_token,
    'token_type','bearer','scope',trim(p_scope),'expires_at',p_expires_at,'stored_at',now())::text;
  select vault_secret_id into v_secret_id from public.youtube_credentials
    where ledger_id=p_ledger_id and owner=p_owner for update;
  if v_secret_id is null then select id into v_secret_id from vault.secrets where name=v_name; end if;
  if v_secret_id is null then
    select vault.create_secret(v_bundle,v_name,'YouTube OAuth token bundle for ledger '||p_ledger_id::text)
      into v_secret_id;
  else
    perform vault.update_secret(v_secret_id,v_bundle,v_name,
      'YouTube OAuth token bundle for ledger '||p_ledger_id::text);
  end if;
  insert into public.youtube_credentials as c(
    ledger_id,owner,google_subject,provider_email,channel_id,channel_title,vault_secret_id,updated_at
  ) values(p_ledger_id,p_owner,p_google_subject,lower(trim(p_provider_email)),p_channel_id,
    left(coalesce(p_channel_title,''),100),v_secret_id,now())
  on conflict(ledger_id) do update set google_subject=excluded.google_subject,
    provider_email=excluded.provider_email,channel_id=excluded.channel_id,
    channel_title=excluded.channel_title,vault_secret_id=excluded.vault_secret_id,updated_at=now();
  insert into public.account_connections as ac(
    ledger_id,owner,provider,provider_subject,provider_email,granted_scopes,
    connection_state,verification_method,verified_at,connected_at,last_checked_at,expires_at,error_code,updated_at
  ) values(p_ledger_id,p_owner,'youtube',p_channel_id,lower(trim(p_provider_email)),
    regexp_split_to_array(trim(p_scope),'[[:space:]]+'),'connected','youtube_oauth2_pkce',now(),now(),now(),p_expires_at,'',now())
  on conflict(ledger_id) do update set owner=excluded.owner,provider='youtube',
    provider_subject=excluded.provider_subject,provider_email=excluded.provider_email,
    granted_scopes=excluded.granted_scopes,connection_state='connected',
    verification_method='youtube_oauth2_pkce',verified_at=excluded.verified_at,
    connected_at=coalesce(ac.connected_at,excluded.connected_at),last_checked_at=excluded.last_checked_at,
    expires_at=excluded.expires_at,error_code='',updated_at=now();
  return v_secret_id;
end; $$;

create or replace function public.youtube_get_token_bundle(p_ledger_id uuid,p_owner uuid)
returns table(google_subject text,provider_email text,channel_id text,channel_title text,token_bundle jsonb)
language plpgsql security definer set search_path='' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  return query select c.google_subject,c.provider_email,c.channel_id,c.channel_title,
    s.decrypted_secret::jsonb from public.youtube_credentials c
    join vault.decrypted_secrets s on s.id=c.vault_secret_id
    where c.ledger_id=p_ledger_id and c.owner=p_owner;
end; $$;

create or replace function public.youtube_delete_token_bundle(p_ledger_id uuid,p_owner uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  delete from public.youtube_credentials where ledger_id=p_ledger_id and owner=p_owner;
  get diagnostics v_count=row_count; return v_count>0;
end; $$;

create or replace function public.delete_youtube_credential_vault_secret()
returns trigger language plpgsql security definer set search_path='' as $$
begin delete from vault.secrets where id=old.vault_secret_id; return old; end; $$;
drop trigger if exists youtube_credentials_delete_vault_secret on public.youtube_credentials;
create trigger youtube_credentials_delete_vault_secret after delete on public.youtube_credentials
  for each row execute function public.delete_youtube_credential_vault_secret();

-- Never let a browser delete or retarget a connected ledger row while a
-- revocable Google grant still exists. Disconnect first; account erasure then
-- either proves revocation or fails closed instead of orphaning provider access.
create or replace function public.guard_connected_youtube_ledger_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.provider='youtube' and exists(
    select 1 from public.youtube_credentials where ledger_id=old.id and owner=old.owner
  ) and (
    tg_op='DELETE' or new.owner is distinct from old.owner
    or new.provider is distinct from old.provider
    or new.username is distinct from old.username
    or new.login_email is distinct from old.login_email
    or new.url is distinct from old.url
  ) then
    raise exception 'Disconnect and revoke the YouTube grant before deleting or retargeting this ledger entry';
  end if;
  return case when tg_op='DELETE' then old else new end;
end; $$;
drop trigger if exists guard_connected_youtube_ledger_change on public.account_ledger;
create trigger guard_connected_youtube_ledger_change before update or delete on public.account_ledger
  for each row execute function public.guard_connected_youtube_ledger_change();

create or replace function public.youtube_record_preview_approval_service(
  p_owner uuid,p_draft_id uuid,p_video_asset_id uuid,p_made_for_kids boolean,
  p_contains_synthetic_media boolean,p_privacy_status text,p_preview_version text
) returns public.youtube_upload_approvals language plpgsql security definer set search_path='' as $$
declare d public.drafts%rowtype; l public.account_ledger%rowtype;
  a public.persona_media_assets%rowtype; c public.account_connections%rowtype;
  result public.youtube_upload_approvals%rowtype; v_hash text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_privacy_status<>'private' or p_preview_version<>'youtube-preview-v1'
    then raise exception 'Invalid YouTube preview settings'; end if;
  select * into d from public.drafts where id=p_draft_id and owner=p_owner for update;
  if not found or lower(trim(coalesce(d.platform,'')))<>'youtube' or d.account_id is null
    or d.approval_state<>'approved' or d.approved_content_hash=''
    or d.approved_content_hash<>public.agent_draft_hash(d.title,d.body,d.tags,d.media_url,
      d.content_kind,d.persona_id,d.account_id,d.platform,d.publish_at)
    or trim(coalesce(d.title,''))='' or char_length(d.title)>100 or d.title~'[<>]'
    or octet_length(coalesce(d.body,'')) not between 1 and 5000 or coalesce(d.body,'')~'[<>]' then
    raise exception 'Approve the exact valid YouTube draft before its platform preview';
  end if;
  select * into l from public.account_ledger where id=d.account_id and owner=p_owner
    and provider='youtube' and not suspended;
  if not found then raise exception 'YouTube destination is unavailable'; end if;
  select * into c from public.account_connections where ledger_id=l.id and owner=p_owner
    and provider='youtube' and connection_state='connected' and verification_method='youtube_oauth2_pkce';
  if not found or not ('https://www.googleapis.com/auth/youtube.upload'=any(c.granted_scopes))
    or c.provider_subject!~'^UC[A-Za-z0-9_-]{22}$' then raise exception 'YouTube upload authorization is unavailable'; end if;
  select * into a from public.persona_media_assets where id=p_video_asset_id and owner=p_owner
    and persona_id=d.persona_id and media_type='video' and status='active';
  if not found or a.public_url<>d.media_url or a.declaration_source='legacy'
    or a.content_sha256!~'^[0-9a-f]{64}$' or a.provenance_sha256!~'^[0-9a-f]{64}$'
    or a.mime_type not in ('video/mp4','video/webm') or a.byte_size not between 1 and 15728640 then
    raise exception 'Use one verified owner-scoped video asset for this draft';
  end if;
  v_hash:=public.youtube_upload_approval_hash(d.approved_content_hash,c.provider_subject,a.id,
    a.content_sha256,a.byte_size,a.mime_type,d.title,coalesce(d.body,''),'22',p_made_for_kids,
    p_contains_synthetic_media,p_privacy_status,p_preview_version);
  insert into public.youtube_upload_approvals as y(
    draft_id,owner,ledger_id,channel_id,video_asset_id,video_sha256,video_byte_size,video_mime,
    title,description,category_id,made_for_kids,contains_synthetic_media,privacy_status,preview_version,
    draft_content_hash,approval_hash,preview_hash,approved_by,approved_at,updated_at
  ) values(d.id,p_owner,l.id,c.provider_subject,a.id,a.content_sha256,a.byte_size,a.mime_type,
    d.title,coalesce(d.body,''),'22',p_made_for_kids,p_contains_synthetic_media,p_privacy_status,
    p_preview_version,d.approved_content_hash,v_hash,v_hash,p_owner,now(),now())
  on conflict(draft_id) do update set ledger_id=excluded.ledger_id,channel_id=excluded.channel_id,
    video_asset_id=excluded.video_asset_id,video_sha256=excluded.video_sha256,
    video_byte_size=excluded.video_byte_size,video_mime=excluded.video_mime,title=excluded.title,
    description=excluded.description,category_id=excluded.category_id,made_for_kids=excluded.made_for_kids,
    contains_synthetic_media=excluded.contains_synthetic_media,privacy_status=excluded.privacy_status,
    preview_version=excluded.preview_version,draft_content_hash=excluded.draft_content_hash,
    approval_hash=excluded.approval_hash,preview_hash=excluded.preview_hash,
    approved_by=excluded.approved_by,approved_at=excluded.approved_at,updated_at=now()
  returning * into result;
  delete from public.youtube_upload_sessions where draft_id=d.id;
  insert into public.agent_actions(owner,persona_id,action_type,entity_type,entity_id,outcome,detail)
    values(p_owner,d.persona_id,'youtube.preview_approved','draft',d.id,'approved',
      jsonb_build_object('approval_hash',v_hash,'preview_version',p_preview_version,
        'channel_id',c.provider_subject,'video_sha256',a.content_sha256,
        'category_id','22',
        'privacy_status',p_privacy_status,'made_for_kids',p_made_for_kids,
        'contains_synthetic_media',p_contains_synthetic_media));
  return result;
end; $$;

-- Consume the owner-acknowledged action-time snapshot and durably claim the
-- exact YouTube draft as one transaction. The claimed draft id is retained
-- on the one-shot receipt so the transition is auditable and non-replayable.
create or replace function public.claim_youtube_upload_with_preview_service(
  p_owner uuid,p_draft_id uuid,p_receipt_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  d public.drafts%rowtype;
  claimed public.drafts%rowtype;
  y public.youtube_upload_approvals%rowtype;
  l public.account_ledger%rowtype;
  c public.account_connections%rowtype;
  credential public.youtube_credentials%rowtype;
  asset public.persona_media_assets%rowtype;
  v_claim_id uuid:=p_draft_id;
  v_draft_hash text;
  v_preview_hash text;
  v_approval_hash text;
begin
  if coalesce(auth.role(),'')<>'service_role'
    then raise exception 'YouTube preview claims are service-only'; end if;

  -- Lock order is draft -> platform approval -> owner/account state -> receipt.
  select * into d from public.drafts
  where id=p_draft_id and owner=p_owner for update;
  if not found or lower(trim(coalesce(d.platform,'')))<>'youtube'
    or d.account_id is null or d.persona_id is null
    or d.approval_state<>'approved'
    or coalesce(d.approved_content_hash,'')!~'^[0-9a-f]{64}$'
    or d.publish_state not in ('not_queued','queued','failed','blocked')
    or coalesce(d.provider_post_id,'')<>''
    or (d.publish_at is not null and d.publish_at>now()) then
    raise exception 'The exact approved YouTube draft is not claimable';
  end if;
  v_draft_hash:=public.agent_draft_hash(
    d.title,d.body,d.tags,d.media_url,d.content_kind,d.persona_id,
    d.account_id,d.platform,d.publish_at
  );
  if v_draft_hash is distinct from d.approved_content_hash then
    raise exception 'The YouTube draft changed after approval'; end if;

  select * into y from public.youtube_upload_approvals
  where draft_id=d.id and owner=p_owner for update;
  if not found or y.ledger_id is distinct from d.account_id
    or y.draft_content_hash is distinct from d.approved_content_hash
    or y.approved_by is distinct from p_owner
    or y.approved_at>now() or y.preview_version<>'youtube-preview-v1'
    or y.privacy_status<>'private' or y.category_id<>'22'
    or y.title is distinct from d.title or y.description is distinct from coalesce(d.body,'') then
    raise exception 'The exact YouTube platform approval is unavailable';
  end if;

  if not exists(select 1 from public.agent_owner_settings settings
    where settings.owner=p_owner and not settings.automation_paused for share)
    then raise exception 'Owner automation is paused or unavailable'; end if;
  select * into l from public.account_ledger
  where id=d.account_id and owner=p_owner and provider='youtube'
    and not coalesce(suspended,false) for share;
  if not found or (l.persona_id is distinct from d.persona_id and not exists(
    select 1 from public.account_persona_links link
    where link.owner=p_owner and link.ledger_id=l.id and link.persona_id=d.persona_id
  )) then raise exception 'The YouTube destination is no longer assigned to this persona'; end if;
  select * into c from public.account_connections
  where ledger_id=l.id and owner=p_owner and provider='youtube' for share;
  if not found or c.connection_state<>'connected'
    or c.verification_method<>'youtube_oauth2_pkce'
    or c.provider_subject is distinct from y.channel_id
    or not ('https://www.googleapis.com/auth/youtube.upload'=any(coalesce(c.granted_scopes,array[]::text[]))) then
    raise exception 'The exact YouTube channel authorization is unavailable';
  end if;
  select * into credential from public.youtube_credentials
  where ledger_id=l.id and owner=p_owner for share;
  if not found or credential.channel_id is distinct from y.channel_id then
    raise exception 'The exact YouTube credential is unavailable'; end if;
  select * into asset from public.persona_media_assets
  where id=y.video_asset_id and owner=p_owner and persona_id=d.persona_id for share;
  if not found or asset.status<>'active' or asset.media_type<>'video'
    or asset.declaration_source='legacy' or asset.public_url is distinct from d.media_url
    or asset.content_sha256 is distinct from y.video_sha256
    or asset.byte_size is distinct from y.video_byte_size
    or asset.mime_type is distinct from y.video_mime then
    raise exception 'The exact verified YouTube video asset is unavailable';
  end if;

  v_preview_hash:=public.agent_draft_preview_hash(
    d.approved_content_hash,d.approved_preview_version,d.approved_preview_target_id
  );
  if d.approved_preview_version<>'platform-preview-v1'
    or d.approved_preview_target_id is distinct from y.channel_id
    or d.approved_preview_target_id is distinct from public.agent_draft_expected_preview_target(
      p_owner,d.persona_id,d.account_id,d.platform
    )
    or d.approved_preview_hash is distinct from v_preview_hash
    or d.approved_previewed_at is null or d.approved_previewed_at>now() then
    raise exception 'The exact YouTube destination preview changed';
  end if;
  v_approval_hash:=public.youtube_upload_approval_hash(
    y.draft_content_hash,y.channel_id,y.video_asset_id,y.video_sha256,y.video_byte_size,
    y.video_mime,y.title,y.description,y.category_id,y.made_for_kids,
    y.contains_synthetic_media,y.privacy_status,y.preview_version
  );
  if y.approval_hash is distinct from v_approval_hash
    or y.preview_hash is distinct from v_approval_hash then
    raise exception 'The YouTube approval failed integrity verification'; end if;

  perform public.consume_provider_action_preview_for_claim_service(
    p_owner,d.id,l.id,'youtube','youtube.publish_private',p_receipt_id,
    y.channel_id,d.approved_content_hash,y.approval_hash,v_claim_id,'youtube_upload'
  );
  update public.drafts set publish_state='publishing',publish_error='',updated_at=now()
  where id=d.id and owner=p_owner and approval_state='approved'
    and approved_content_hash=d.approved_content_hash
    and coalesce(provider_post_id,'')=''
    and publish_state in ('not_queued','queued','failed','blocked')
  returning * into claimed;
  if not found then raise exception 'The exact YouTube draft claim conflicted'; end if;
  return jsonb_build_object('claimId',v_claim_id,'draft',to_jsonb(claimed));
end; $$;

create or replace function public.youtube_store_upload_session_service(
  p_owner uuid,p_draft_id uuid,p_approval_hash text,p_session_url text
) returns uuid language plpgsql security definer set search_path='' as $$
declare y public.youtube_upload_approvals%rowtype; v_id uuid;
  v_name text:='youtube_upload_session_'||p_draft_id::text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_session_url!~'^https://www\.googleapis\.com/upload/youtube/v3/videos\?'
    or char_length(p_session_url)>4096 then raise exception 'Invalid YouTube resumable session URL'; end if;
  select * into y from public.youtube_upload_approvals
    where draft_id=p_draft_id and owner=p_owner and approval_hash=p_approval_hash for update;
  if not found then raise exception 'YouTube approval changed'; end if;
  select vault_secret_id into v_id from public.youtube_upload_sessions
    where draft_id=p_draft_id and owner=p_owner for update;
  if v_id is null then select id into v_id from vault.secrets where name=v_name; end if;
  if v_id is null then select vault.create_secret(p_session_url,v_name,
    'YouTube resumable upload session for draft '||p_draft_id::text) into v_id;
  else perform vault.update_secret(v_id,p_session_url,v_name,
    'YouTube resumable upload session for draft '||p_draft_id::text); end if;
  insert into public.youtube_upload_sessions as s(
    draft_id,owner,ledger_id,approval_hash,vault_secret_id,byte_total,state,updated_at
  ) values(p_draft_id,p_owner,y.ledger_id,p_approval_hash,v_id,y.video_byte_size,'initiated',now())
  on conflict(draft_id) do update set ledger_id=excluded.ledger_id,approval_hash=excluded.approval_hash,
    vault_secret_id=excluded.vault_secret_id,byte_total=excluded.byte_total,uploaded_through=-1,
    state='initiated',provider_video_id='',processing_status='',last_error='',last_checked_at=null,updated_at=now();
  return v_id;
end; $$;

create or replace function public.youtube_get_upload_session_service(p_owner uuid,p_draft_id uuid)
returns table(session_url text,approval_hash text,uploaded_through bigint,state text,
  provider_video_id text,processing_status text,byte_total bigint)
language plpgsql security definer set search_path='' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  return query select secret.decrypted_secret,s.approval_hash,s.uploaded_through,s.state,
    s.provider_video_id,s.processing_status,s.byte_total from public.youtube_upload_sessions s
    join vault.decrypted_secrets secret on secret.id=s.vault_secret_id
    where s.owner=p_owner and s.draft_id=p_draft_id;
end; $$;

create or replace function public.delete_youtube_upload_session_vault_secret()
returns trigger language plpgsql security definer set search_path='' as $$
begin delete from vault.secrets where id=old.vault_secret_id; return old; end; $$;
drop trigger if exists youtube_upload_sessions_delete_vault_secret on public.youtube_upload_sessions;
create trigger youtube_upload_sessions_delete_vault_secret after delete on public.youtube_upload_sessions
  for each row execute function public.delete_youtube_upload_session_vault_secret();

create or replace function public.invalidate_youtube_approval_on_draft_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.approval_state<>'approved' or new.approved_content_hash=''
    or new.approved_content_hash is distinct from old.approved_content_hash
    or new.account_id is distinct from old.account_id or new.platform is distinct from old.platform
    or new.media_url is distinct from old.media_url or new.title is distinct from old.title
    or new.body is distinct from old.body or new.publish_at is distinct from old.publish_at then
    delete from public.youtube_upload_approvals where draft_id=new.id;
  end if;
  return new;
end; $$;
drop trigger if exists invalidate_youtube_approval_on_draft_change on public.drafts;
create trigger invalidate_youtube_approval_on_draft_change after update on public.drafts
  for each row execute function public.invalidate_youtube_approval_on_draft_change();

revoke all on function public.youtube_upload_approval_hash(text,text,uuid,text,bigint,text,text,text,text,boolean,boolean,text,text)
  from public,anon,authenticated;
revoke all on function public.claim_youtube_token_operation(uuid,uuid,uuid,text,integer),
  public.release_youtube_token_operation(uuid,uuid,uuid),
  public.youtube_store_token_bundle(uuid,uuid,text,text,text,text,text,text,text,text,timestamptz),
  public.youtube_get_token_bundle(uuid,uuid),public.youtube_delete_token_bundle(uuid,uuid),
  public.youtube_record_preview_approval_service(uuid,uuid,uuid,boolean,boolean,text,text),
  public.claim_youtube_upload_with_preview_service(uuid,uuid,uuid),
  public.youtube_store_upload_session_service(uuid,uuid,text,text),
  public.youtube_get_upload_session_service(uuid,uuid)
  from public,anon,authenticated;
revoke all on function public.guard_connected_youtube_ledger_change()
  from public,anon,authenticated;
revoke all on function public.prepare_provider_action_preview_service(
  uuid,uuid,uuid,text,text,text,text,text,text,jsonb
), public.consume_provider_action_preview_service(
  uuid,uuid,uuid,text,text,uuid,text,text,text
), public.consume_provider_action_preview_for_claim_service(
  uuid,uuid,uuid,text,text,uuid,text,text,text,uuid,text
), public.invalidate_provider_action_previews_on_draft_change()
  from public,anon,authenticated,service_role;
revoke all on function public.acknowledge_provider_action_preview(uuid,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.youtube_upload_approval_hash(text,text,uuid,text,bigint,text,text,text,text,boolean,boolean,text,text),
  public.claim_youtube_token_operation(uuid,uuid,uuid,text,integer),
  public.release_youtube_token_operation(uuid,uuid,uuid),
  public.youtube_store_token_bundle(uuid,uuid,text,text,text,text,text,text,text,text,timestamptz),
  public.youtube_get_token_bundle(uuid,uuid),public.youtube_delete_token_bundle(uuid,uuid),
  public.youtube_record_preview_approval_service(uuid,uuid,uuid,boolean,boolean,text,text),
  public.claim_youtube_upload_with_preview_service(uuid,uuid,uuid),
  public.youtube_store_upload_session_service(uuid,uuid,text,text),
  public.youtube_get_upload_session_service(uuid,uuid)
  to service_role;
grant execute on function public.prepare_provider_action_preview_service(
  uuid,uuid,uuid,text,text,text,text,text,text,jsonb
) to service_role;
grant execute on function public.acknowledge_provider_action_preview(uuid,text,text)
  to authenticated;

comment on table public.youtube_upload_approvals is
  'Owner-visible immutable YouTube platform-preview receipt binding exact approved draft, destination, verified video bytes, People and Blogs category 22, audience, synthetic-media disclosure, and privacy.';
comment on table public.youtube_upload_sessions is
  'Service-only resumable-upload checkpoint; its capability URL is encrypted in Vault.';
comment on table public.provider_action_preview_receipts is
  'Server-authored immutable short-lived exact provider snapshots. A separate AAL2 owner acknowledgement and one-shot unchanged service consumption are required before action or handoff.';

commit;
