-- Owner-visible platform-preview approval gate.
--
-- A scheduled post must be approved through the server wrapper after the
-- owner reviews the exact platform variants. The existing content hash still
-- binds captions, immutable media, provider destinations, and time; this
-- migration adds durable evidence of the renderer version used for review.
begin;

alter table public.post_drafts
  add column if not exists approved_preview_version text not null default '',
  add column if not exists approved_preview_hash text not null default '',
  add column if not exists approved_previewed_at timestamptz;

alter table public.post_drafts
  drop constraint if exists post_drafts_approved_preview_version_check,
  add constraint post_drafts_approved_preview_version_check check (
    approved_preview_version in ('','platform-preview-v1')
  ),
  drop constraint if exists post_drafts_approved_preview_hash_check,
  add constraint post_drafts_approved_preview_hash_check check (
    approved_preview_hash = '' or approved_preview_hash ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists post_drafts_approved_preview_evidence_check,
  add constraint post_drafts_approved_preview_evidence_check check (
    (approved_preview_version = '' and approved_preview_hash = '' and approved_previewed_at is null)
    or
    (approved_preview_version <> '' and approved_preview_hash <> '' and approved_previewed_at is not null)
  );

create or replace function public.post_draft_preview_hash(
  p_content_hash text,
  p_preview_version text,
  p_facebook_page_id text,
  p_instagram_business_id text,
  p_targets text[]
)
returns text
language sql stable set search_path = '' as $$
  select encode(extensions.digest(
    convert_to(jsonb_build_array(
      coalesce(p_content_hash,''),
      coalesce(p_preview_version,''),
      coalesce(p_facebook_page_id,''),
      coalesce(p_instagram_business_id,''),
      coalesce((
        select jsonb_agg(lower(trim(target)) order by lower(trim(target)))
        from unnest(coalesce(p_targets,array[]::text[])) target
      ),'[]'::jsonb)
    )::text,'UTF8'),
    'sha256'
  ),'hex');
$$;
revoke all on function public.post_draft_preview_hash(text,text,text,text,text[])
  from public, anon, authenticated;
grant execute on function public.post_draft_preview_hash(text,text,text,text,text[])
  to service_role;

-- Editing or unscheduling invalidates the prior visual review. Posted history
-- may retain it as evidence; an editable draft may not.
create or replace function public.clear_post_draft_preview_on_edit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('draft','approved','failed') and (
    old.status is distinct from new.status
    or old.persona_id is distinct from new.persona_id
    or old.facebook_ledger_id is distinct from new.facebook_ledger_id
    or old.targets is distinct from new.targets
    or old.scheduled_for is distinct from new.scheduled_for
    or old.fb_caption is distinct from new.fb_caption
    or old.ig_caption is distinct from new.ig_caption
    or old.x_caption is distinct from new.x_caption
    or old.fb_image_url is distinct from new.fb_image_url
    or old.ig_image_url is distinct from new.ig_image_url
    or old.x_image_url is distinct from new.x_image_url
    or old.source_image_url is distinct from new.source_image_url
    or old.approved_content_hash is distinct from new.approved_content_hash
  ) then
    new.approved_preview_version := '';
    new.approved_preview_hash := '';
    new.approved_previewed_at := null;
  end if;
  return new;
end;
$$;
revoke all on function public.clear_post_draft_preview_on_edit()
  from public, anon, authenticated;

drop trigger if exists clear_post_draft_preview_on_edit on public.post_drafts;
create trigger clear_post_draft_preview_on_edit
  before update on public.post_drafts
  for each row execute function public.clear_post_draft_preview_on_edit();

-- Deferred verification lets the wrapper call the existing immutable-media
-- scheduler and attach preview evidence inside the same transaction. A direct
-- call to the old scheduler still fails at commit.
create or replace function public.assert_scheduled_post_draft_preview()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.post_drafts%rowtype;
  v_expected text;
begin
  select * into v_draft from public.post_drafts where id = new.id;
  if not found or v_draft.status <> 'scheduled' then return null; end if;
  v_expected := public.post_draft_preview_hash(
    v_draft.approved_content_hash,
    v_draft.approved_preview_version,
    v_draft.approved_facebook_page_id,
    v_draft.approved_instagram_business_id,
    v_draft.targets
  );
  if v_draft.approved_preview_version <> 'platform-preview-v1'
    or v_draft.approved_previewed_at is null
    or v_draft.approved_previewed_at > clock_timestamp()
    or v_draft.approved_preview_hash = ''
    or v_draft.approved_preview_hash is distinct from v_expected then
    raise exception 'Scheduled drafts require a current owner-approved platform preview';
  end if;
  return null;
end;
$$;
revoke all on function public.assert_scheduled_post_draft_preview()
  from public, anon, authenticated;

drop trigger if exists assert_scheduled_post_draft_preview on public.post_drafts;
create constraint trigger assert_scheduled_post_draft_preview
  after insert or update on public.post_drafts
  deferrable initially deferred
  for each row execute function public.assert_scheduled_post_draft_preview();

create table if not exists public.post_draft_schedule_preview_receipts (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid not null references public.post_drafts(id) on delete cascade,
  action text not null check (action = 'post_draft.schedule'),
  target_id text not null check (char_length(target_id) between 1 and 1024),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  preview_payload jsonb not null check (jsonb_typeof(preview_payload) = 'object'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles(id) on delete set null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '5 minutes'),
  check (
    (acknowledged_at is null and acknowledged_by is null)
    or (acknowledged_at is not null and acknowledged_by is not null
      and acknowledged_at >= created_at and acknowledged_at < expires_at)
  )
);

create index if not exists post_draft_schedule_preview_receipts_current_idx
  on public.post_draft_schedule_preview_receipts(owner,draft_id,created_at desc)
  where consumed_at is null and invalidated_at is null;
alter table public.post_draft_schedule_preview_receipts enable row level security;
revoke all on public.post_draft_schedule_preview_receipts
  from public, anon, authenticated;

create or replace function public.post_draft_schedule_preview_snapshot(
  p_owner uuid,p_draft_id uuid,p_request jsonb
)
returns table(content_hash text,target_id text,preview_payload jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.post_drafts%rowtype;
  v_ledger public.account_ledger%rowtype;
  v_meta public.meta_page_connections%rowtype;
  v_targets text[];
  v_scheduled_for timestamptz;
  v_timezone text;
  v_week_start date;
  v_hash text;
  v_target text;
  v_items jsonb := '[]'::jsonb;
  v_fb_source text := coalesce(p_request->>'fbSourceUrl','');
  v_ig_source text := coalesce(p_request->>'igSourceUrl','');
  v_fb_sha text := coalesce(p_request->>'fbMediaSha256','');
  v_ig_sha text := coalesce(p_request->>'igMediaSha256','');
  v_fb_mime text := coalesce(p_request->>'fbMediaMime','');
  v_ig_mime text := coalesce(p_request->>'igMediaMime','');
  v_fb_bytes bigint := coalesce((p_request->>'fbMediaBytes')::bigint,0);
  v_ig_bytes bigint := coalesce((p_request->>'igMediaBytes')::bigint,0);
  v_fb_path text := coalesce(p_request->>'fbMediaPath','');
  v_ig_path text := coalesce(p_request->>'igMediaPath','');
  v_fb_url text := coalesce(p_request->>'fbMediaUrl','');
  v_ig_url text := coalesce(p_request->>'igMediaUrl','');
begin
  if jsonb_typeof(p_request) <> 'object'
    or jsonb_typeof(p_request->'targets') <> 'array' then
    raise exception 'The staged schedule request is invalid';
  end if;
  v_scheduled_for := (p_request->>'scheduledFor')::timestamptz;
  v_timezone := trim(coalesce(p_request->>'timezone',''));
  if v_scheduled_for is null or v_scheduled_for <= now() then
    raise exception 'Choose a future publish time';
  end if;
  if v_timezone = '' or not exists (
    select 1 from pg_catalog.pg_timezone_names where name = v_timezone
  ) then raise exception 'Choose a valid time zone'; end if;
  select coalesce(array_agg(target order by target),array[]::text[])
  into v_targets from (
    select distinct lower(trim(value)) target
    from jsonb_array_elements_text(p_request->'targets') value
    where trim(value) <> ''
  ) normalized;
  if cardinality(v_targets) = 0 or exists (
    select 1 from unnest(v_targets) target
    where target not in ('facebook','instagram')
  ) then raise exception 'Scheduling requires Facebook and/or Instagram only'; end if;
  if char_length(coalesce(p_request->>'fbCaption','')) > 5000
    or char_length(coalesce(p_request->>'igCaption','')) > 2200
    or char_length(coalesce(p_request->>'xCaption','')) > 280 then
    raise exception 'One or more captions exceed the platform limit';
  end if;

  select * into v_draft from public.post_drafts
  where id = p_draft_id and owner = p_owner for update;
  if not found then raise exception 'Owned draft not found'; end if;
  if v_draft.status not in ('draft','approved','failed')
    or v_draft.fb_post_id is not null or v_draft.ig_media_id is not null
    or v_draft.x_tweet_id is not null then
    raise exception 'This draft can no longer be scheduled';
  end if;
  if v_draft.persona_id is null or not exists (
    select 1 from public.personas where id = v_draft.persona_id and owner = p_owner
  ) then raise exception 'Choose an owned persona before scheduling'; end if;
  if trim(coalesce(v_draft.facebook_ledger_id,'')) = '' then
    raise exception 'Choose a paired Facebook Page before scheduling';
  end if;
  select * into v_ledger from public.account_ledger
  where id::text = v_draft.facebook_ledger_id and owner = p_owner
    and provider = 'facebook' and not coalesce(suspended,false);
  if not found then raise exception 'The selected Facebook Page is unavailable'; end if;
  select * into v_meta from public.meta_page_connections
  where owner = p_owner and facebook_ledger_id = v_ledger.id for share;
  if not found or nullif(trim(v_meta.facebook_page_id::text),'') is null then
    raise exception 'The exact Meta Page connection is unavailable';
  end if;
  if 'instagram' = any(v_targets)
    and nullif(trim(v_meta.instagram_business_id::text),'') is null then
    raise exception 'The selected Page has no linked professional Instagram account';
  end if;
  if 'facebook' = any(v_targets) then
    if coalesce(nullif(v_draft.fb_image_url,''),nullif(v_draft.source_image_url,''),'')
        is distinct from v_fb_source
      or v_fb_sha !~ '^[0-9a-f]{64}$'
      or v_fb_mime not in ('image/jpeg','image/png','image/webp')
      or v_fb_bytes not between 1 and 10485760
      or nullif(v_fb_path,'') is null or nullif(v_fb_url,'') is null
      or not exists (select 1 from storage.objects
        where bucket_id = 'post-approved-media' and name = v_fb_path
          and coalesce(metadata->>'size','') = v_fb_bytes::text
          and lower(coalesce(metadata->>'mimetype','')) = v_fb_mime) then
      raise exception 'The exact staged Facebook media is unavailable';
    end if;
  elsif concat(v_fb_source,v_fb_sha,v_fb_mime,v_fb_path,v_fb_url) <> '' or v_fb_bytes <> 0 then
    raise exception 'Unselected Facebook cannot receive staged media';
  end if;
  if 'instagram' = any(v_targets) then
    if coalesce(nullif(v_draft.ig_image_url,''),nullif(v_draft.source_image_url,''),'')
        is distinct from v_ig_source
      or v_ig_sha !~ '^[0-9a-f]{64}$'
      or v_ig_mime not in ('image/jpeg','image/png','image/webp')
      or v_ig_bytes not between 1 and 10485760
      or nullif(v_ig_path,'') is null or nullif(v_ig_url,'') is null
      or not exists (select 1 from storage.objects
        where bucket_id = 'post-approved-media' and name = v_ig_path
          and coalesce(metadata->>'size','') = v_ig_bytes::text
          and lower(coalesce(metadata->>'mimetype','')) = v_ig_mime) then
      raise exception 'The exact staged Instagram media is unavailable';
    end if;
  elsif concat(v_ig_source,v_ig_sha,v_ig_mime,v_ig_path,v_ig_url) <> '' or v_ig_bytes <> 0 then
    raise exception 'Unselected Instagram cannot receive staged media';
  end if;

  v_week_start := date_trunc('week',v_scheduled_for at time zone v_timezone)::date;
  v_target := concat_ws('|',
    case when 'facebook' = any(v_targets)
      then 'facebook:' || v_meta.facebook_page_id::text else null end,
    case when 'instagram' = any(v_targets)
      then 'instagram:' || v_meta.instagram_business_id::text else null end
  );
  v_hash := public.post_draft_hash(
    v_draft.persona_id,v_draft.facebook_ledger_id,v_targets,
    v_scheduled_for,v_week_start,v_timezone,v_meta.facebook_page_id::text,
    case when 'instagram' = any(v_targets) then v_meta.instagram_business_id::text else '' end,
    coalesce(p_request->>'fbCaption',''),coalesce(p_request->>'igCaption',''),
    coalesce(p_request->>'xCaption',''),
    case when 'facebook' = any(v_targets) then v_fb_url else v_draft.fb_image_url end,
    case when 'instagram' = any(v_targets) then v_ig_url else v_draft.ig_image_url end,
    v_draft.x_image_url,v_draft.source_image_url,
    case when 'facebook' = any(v_targets) then v_fb_sha else '' end,
    case when 'facebook' = any(v_targets) then v_fb_mime else '' end,
    case when 'facebook' = any(v_targets) then v_fb_bytes else 0 end,
    case when 'facebook' = any(v_targets) then v_fb_path else '' end,
    case when 'facebook' = any(v_targets) then v_fb_url else '' end,
    case when 'instagram' = any(v_targets) then v_ig_sha else '' end,
    case when 'instagram' = any(v_targets) then v_ig_mime else '' end,
    case when 'instagram' = any(v_targets) then v_ig_bytes else 0 end,
    case when 'instagram' = any(v_targets) then v_ig_path else '' end,
    case when 'instagram' = any(v_targets) then v_ig_url else '' end
  );
  if 'facebook' = any(v_targets) then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'provider','facebook','account',coalesce(nullif(v_meta.facebook_page_name,''),'Facebook Page'),
      'accountId',v_meta.facebook_page_id::text,'title','',
      'text',coalesce(p_request->>'fbCaption',''),'tags','',
      'mediaUrl',v_fb_url,'mediaKind','image','scheduledFor',v_scheduled_for,
      'timezone',v_timezone,
      'mode','Scheduled Meta post','timingLabel','At the exact approved time',
      'platformDetails',jsonb_build_array(
        'Exact Facebook Page ID: ' || v_meta.facebook_page_id::text,
        'Immutable media SHA-256: ' || v_fb_sha,
        'Server-staged bytes: ' || v_fb_bytes::text
      )
    ));
  end if;
  if 'instagram' = any(v_targets) then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'provider','instagram',
      'account',coalesce(nullif(v_meta.instagram_username,''),'Linked Instagram professional account'),
      'accountId',v_meta.instagram_business_id::text,'title','',
      'text',coalesce(p_request->>'igCaption',''),'tags','',
      'mediaUrl',v_ig_url,'mediaKind','image','scheduledFor',v_scheduled_for,
      'timezone',v_timezone,
      'mode','Scheduled Meta post','timingLabel','At the exact approved time',
      'platformDetails',jsonb_build_array(
        'Exact Instagram business ID: ' || v_meta.instagram_business_id::text,
        'Immutable media SHA-256: ' || v_ig_sha,
        'Server-staged bytes: ' || v_ig_bytes::text
      )
    ));
  end if;
  content_hash := v_hash;
  target_id := v_target;
  preview_payload := jsonb_build_object(
    'receiptVersion','post-draft-schedule-preview-v1','draftId',v_draft.id,
    'provider','meta','action','post_draft.schedule','targetId',v_target,
    'contentHash',v_hash,'scheduledFor',v_scheduled_for,
    'timezone',v_timezone,'items',v_items
  );
  return next;
end;
$$;
revoke all on function public.post_draft_schedule_preview_snapshot(uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.issue_post_draft_schedule_preview_receipt_service(
  p_owner uuid,p_draft_id uuid,p_scheduled_for timestamptz,p_timezone text,
  p_fb_caption text,p_ig_caption text,p_x_caption text,p_targets text[],
  p_fb_source_url text,p_ig_source_url text,
  p_fb_media_sha256 text,p_fb_media_mime text,p_fb_media_bytes bigint,
  p_fb_media_path text,p_fb_media_url text,
  p_ig_media_sha256 text,p_ig_media_mime text,p_ig_media_bytes bigint,
  p_ig_media_path text,p_ig_media_url text
)
returns table(
  receipt_id uuid,receipt_hash text,preview_payload jsonb,
  created_at timestamptz,expires_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_request jsonb;
  v_snapshot record;
  v_id uuid := gen_random_uuid();
  v_created timestamptz := clock_timestamp();
  v_expires timestamptz := v_created + interval '3 minutes';
  v_payload jsonb;
  v_hash text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Schedule preview receipts are service-only';
  end if;
  v_request := jsonb_build_object(
    'scheduledFor',p_scheduled_for,'timezone',p_timezone,
    'fbCaption',coalesce(p_fb_caption,''),'igCaption',coalesce(p_ig_caption,''),
    'xCaption',coalesce(p_x_caption,''),'targets',to_jsonb(coalesce(p_targets,array[]::text[])),
    'fbSourceUrl',coalesce(p_fb_source_url,''),'igSourceUrl',coalesce(p_ig_source_url,''),
    'fbMediaSha256',coalesce(p_fb_media_sha256,''),'fbMediaMime',coalesce(p_fb_media_mime,''),
    'fbMediaBytes',coalesce(p_fb_media_bytes,0),'fbMediaPath',coalesce(p_fb_media_path,''),
    'fbMediaUrl',coalesce(p_fb_media_url,''),'igMediaSha256',coalesce(p_ig_media_sha256,''),
    'igMediaMime',coalesce(p_ig_media_mime,''),'igMediaBytes',coalesce(p_ig_media_bytes,0),
    'igMediaPath',coalesce(p_ig_media_path,''),'igMediaUrl',coalesce(p_ig_media_url,'')
  );
  select * into v_snapshot from public.post_draft_schedule_preview_snapshot(
    p_owner,p_draft_id,v_request
  );
  v_payload := v_snapshot.preview_payload || jsonb_build_object(
    'receiptId',v_id,'createdAt',v_created,'expiresAt',v_expires
  );
  v_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_id,p_owner,p_draft_id,'post_draft.schedule',v_snapshot.target_id,
    v_snapshot.content_hash,v_request,v_payload,v_created,v_expires
  )::text,'UTF8'),'sha256'),'hex');
  v_payload := v_payload || jsonb_build_object('receiptHash',v_hash);
  update public.post_draft_schedule_preview_receipts set invalidated_at = v_created
  where owner = p_owner and draft_id = p_draft_id
    and consumed_at is null and invalidated_at is null;
  insert into public.post_draft_schedule_preview_receipts(
    id,owner,draft_id,action,target_id,content_hash,request_payload,
    receipt_hash,preview_payload,created_at,expires_at
  ) values (
    v_id,p_owner,p_draft_id,'post_draft.schedule',v_snapshot.target_id,
    v_snapshot.content_hash,v_request,v_hash,v_payload,v_created,v_expires
  );
  receipt_id := v_id; receipt_hash := v_hash; preview_payload := v_payload;
  created_at := v_created; expires_at := v_expires;
  return next;
end;
$$;
revoke all on function public.issue_post_draft_schedule_preview_receipt_service(
  uuid,uuid,timestamptz,text,text,text,text,text[],text,text,
  text,text,bigint,text,text,text,text,bigint,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.issue_post_draft_schedule_preview_receipt_service(
  uuid,uuid,timestamptz,text,text,text,text,text[],text,text,
  text,text,bigint,text,text,text,text,bigint,text,text
) to service_role;

create or replace function public.acknowledge_post_draft_schedule_preview_receipt(
  p_receipt_id uuid,p_draft_id uuid
)
returns table(
  receipt_id uuid,receipt_hash text,preview_payload jsonb,
  created_at timestamptz,expires_at timestamptz,acknowledged_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_receipt public.post_draft_schedule_preview_receipts%rowtype;
  v_snapshot record;
  v_expected_hash text;
  v_now timestamptz := clock_timestamp();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select * into v_receipt from public.post_draft_schedule_preview_receipts
  where id = p_receipt_id and owner = v_owner and draft_id = p_draft_id for update;
  if not found or v_receipt.consumed_at is not null
    or v_receipt.invalidated_at is not null or v_receipt.expires_at <= v_now
    or v_receipt.created_at > v_now then
    raise exception 'The schedule preview receipt is missing, expired, used, or invalidated';
  end if;
  select * into v_snapshot from public.post_draft_schedule_preview_snapshot(
    v_owner,p_draft_id,v_receipt.request_payload
  );
  v_expected_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_receipt.id,v_receipt.owner,v_receipt.draft_id,v_receipt.action,
    v_receipt.target_id,v_receipt.content_hash,v_receipt.request_payload,
    v_receipt.preview_payload - 'receiptHash',v_receipt.created_at,v_receipt.expires_at
  )::text,'UTF8'),'sha256'),'hex');
  if v_receipt.action <> 'post_draft.schedule'
    or v_receipt.target_id is distinct from v_snapshot.target_id
    or v_receipt.content_hash is distinct from v_snapshot.content_hash
    or v_receipt.receipt_hash is distinct from v_expected_hash
    or v_receipt.preview_payload ->> 'receiptHash' is distinct from v_receipt.receipt_hash then
    raise exception 'The exact staged media, content, target, or schedule changed after preview';
  end if;
  if v_receipt.acknowledged_at is null then
    update public.post_draft_schedule_preview_receipts as stored set
      acknowledged_at = v_now,acknowledged_by = v_owner
    where stored.id = v_receipt.id and stored.acknowledged_at is null
      and stored.consumed_at is null and stored.invalidated_at is null
    returning stored.* into v_receipt;
    if not found then raise exception 'The receipt changed before acknowledgement'; end if;
  elsif v_receipt.acknowledged_by is distinct from v_owner then
    raise exception 'The receipt was acknowledged by a different owner';
  end if;
  receipt_id := v_receipt.id; receipt_hash := v_receipt.receipt_hash;
  preview_payload := v_receipt.preview_payload; created_at := v_receipt.created_at;
  expires_at := v_receipt.expires_at; acknowledged_at := v_receipt.acknowledged_at;
  return next;
end;
$$;
revoke all on function public.acknowledge_post_draft_schedule_preview_receipt(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_post_draft_schedule_preview_receipt(uuid,uuid)
  to authenticated;

create or replace function public.consume_acknowledged_post_draft_schedule_preview_service(
  p_owner uuid,p_draft_id uuid,p_receipt_id uuid
)
returns public.post_drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_receipt public.post_draft_schedule_preview_receipts%rowtype;
  v_snapshot record;
  v_draft public.post_drafts%rowtype;
  v_expected_hash text;
  v_preview_hash text;
  v_now timestamptz := clock_timestamp();
  r jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Schedule receipt consumption is service-only';
  end if;
  select * into v_receipt from public.post_draft_schedule_preview_receipts
  where id = p_receipt_id and owner = p_owner and draft_id = p_draft_id for update;
  if not found or v_receipt.acknowledged_at is null
    or v_receipt.acknowledged_by is distinct from p_owner
    or v_receipt.consumed_at is not null or v_receipt.invalidated_at is not null
    or v_receipt.expires_at <= v_now or v_receipt.created_at > v_now then
    raise exception 'A current AAL2-acknowledged schedule preview receipt is required';
  end if;
  select * into v_snapshot from public.post_draft_schedule_preview_snapshot(
    p_owner,p_draft_id,v_receipt.request_payload
  );
  v_expected_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_receipt.id,v_receipt.owner,v_receipt.draft_id,v_receipt.action,
    v_receipt.target_id,v_receipt.content_hash,v_receipt.request_payload,
    v_receipt.preview_payload - 'receiptHash',v_receipt.created_at,v_receipt.expires_at
  )::text,'UTF8'),'sha256'),'hex');
  if v_receipt.action <> 'post_draft.schedule'
    or v_receipt.target_id is distinct from v_snapshot.target_id
    or v_receipt.content_hash is distinct from v_snapshot.content_hash
    or v_receipt.receipt_hash is distinct from v_expected_hash then
    raise exception 'The exact staged media, content, target, or schedule changed after acknowledgement';
  end if;
  update public.post_draft_schedule_preview_receipts set consumed_at = v_now
  where id = v_receipt.id and consumed_at is null and invalidated_at is null
    and acknowledged_at is not null and acknowledged_by = p_owner;
  if not found then raise exception 'The schedule preview receipt was already consumed'; end if;
  r := v_receipt.request_payload;
  -- The legacy scheduler records its terminal audit row directly. This
  -- receipt-aware wrapper is now the sole service entry point, so mark only
  -- this transaction as the narrow audited writer accepted by migration 055.
  perform set_config('app.agent_action_narrow_writer','1',true);
  v_draft := public.approve_and_schedule_post_draft(
    p_owner,p_draft_id,(r->>'scheduledFor')::timestamptz,r->>'timezone',
    r->>'fbCaption',r->>'igCaption',r->>'xCaption',
    array(select jsonb_array_elements_text(r->'targets')),
    r->>'fbSourceUrl',r->>'igSourceUrl',
    r->>'fbMediaSha256',r->>'fbMediaMime',(r->>'fbMediaBytes')::bigint,
    r->>'fbMediaPath',r->>'fbMediaUrl',
    r->>'igMediaSha256',r->>'igMediaMime',(r->>'igMediaBytes')::bigint,
    r->>'igMediaPath',r->>'igMediaUrl'
  );
  if v_draft.approved_content_hash is distinct from v_receipt.content_hash
    or concat_ws('|',
      case when 'facebook' = any(v_draft.targets)
        then 'facebook:' || v_draft.approved_facebook_page_id else null end,
      case when 'instagram' = any(v_draft.targets)
        then 'instagram:' || v_draft.approved_instagram_business_id else null end
    ) is distinct from v_receipt.target_id then
    raise exception 'The scheduled result no longer matches the acknowledged receipt';
  end if;
  v_preview_hash := public.post_draft_preview_hash(
    v_draft.approved_content_hash,'platform-preview-v1',
    v_draft.approved_facebook_page_id,v_draft.approved_instagram_business_id,
    v_draft.targets
  );
  update public.post_drafts set
    approved_preview_version = 'platform-preview-v1',
    approved_preview_hash = v_preview_hash,
    approved_previewed_at = v_receipt.acknowledged_at,
    updated_at = v_now
  where id = v_draft.id and owner = p_owner returning * into v_draft;
  if not found then raise exception 'The acknowledged schedule could not be finalized'; end if;
  insert into public.agent_actions(
    owner,persona_id,action_type,entity_type,entity_id,outcome,detail
  ) values (
    p_owner,v_draft.persona_id,'post_draft.preview_receipt_consumed','post_draft',
    v_draft.id,'approved',jsonb_build_object(
      'receipt_id',v_receipt.id,'receipt_hash',v_receipt.receipt_hash,
      'action',v_receipt.action,'target_id',v_receipt.target_id,
      'content_hash',v_receipt.content_hash,'scheduled_for',v_draft.scheduled_for,
      'acknowledged_at',v_receipt.acknowledged_at
    )
  );
  return v_draft;
end;
$$;
revoke all on function public.consume_acknowledged_post_draft_schedule_preview_service(
  uuid,uuid,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.consume_acknowledged_post_draft_schedule_preview_service(
  uuid,uuid,uuid
) to service_role;

drop function if exists public.approve_and_schedule_previewed_post_draft(
  uuid,uuid,timestamptz,text,text,text,text,text[],text,text,
  text,text,bigint,text,text,text,text,bigint,text,text,text,text,text
);

-- The owner approval service must use the preview-aware wrapper from now on.
revoke execute on function public.approve_and_schedule_post_draft(
  uuid,uuid,timestamptz,text,text,text,text,text[],text,text,
  text,text,bigint,text,text,text,text,bigint,text,text
) from service_role;

-- Do not silently grandfather a queued post that the owner never previewed.
do $$
begin
  if exists (select 1 from public.post_drafts where status = 'scheduled') then
    raise exception 'Unschedule existing post drafts and review their platform previews before applying this migration';
  end if;
end;
$$;

commit;
