-- 075-native-business-page-publish-preview-gate.sql
-- Native business pages publish only from a short-lived, server-authored exact
-- revision preview. Preparing a preview never publishes. A separate AAL2 owner
-- acknowledgement must be consumed once in the same transaction as publication.

begin;

create table if not exists public.business_page_publish_preview_evidence (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null,
  owner                 uuid not null references public.profiles(id) on delete cascade,
  preview_version       text not null check (preview_version='native-business-page-preview-v1'),
  preview_hash          text not null check (preview_hash~'^[0-9a-f]{64}$'),
  preview_revision      integer not null check (preview_revision>0),
  preview_target_id     text not null check (char_length(preview_target_id) between 1 and 200),
  manifest_sha256       text not null check (manifest_sha256~'^[0-9a-f]{64}$'),
  preview_payload       jsonb not null check (jsonb_typeof(preview_payload)='object'),
  prepared_at           timestamptz not null default now(),
  preview_session_id    text not null default '',
  expires_at            timestamptz not null,
  acknowledged_at       timestamptz,
  consumed_at           timestamptz,
  invalidated_at        timestamptz,
  invalidation_reason   text not null default '' check (char_length(invalidation_reason)<=300),
  published_revision    integer check (published_revision is null or published_revision>0),
  published_at          timestamptz,
  publish_result        jsonb not null default '{}'::jsonb check (jsonb_typeof(publish_result)='object'),
  created_at            timestamptz not null default now(),
  foreign key (business_id,owner) references public.businesses(id,owner) on delete cascade,
  constraint business_page_publish_preview_lifetime_check check (
    expires_at>prepared_at and expires_at<=prepared_at+interval '15 minutes'
  ),
  constraint business_page_publish_preview_lifecycle_check check (
    (consumed_at is null and published_revision is null and published_at is null)
    or (consumed_at is not null and acknowledged_at is not null
        and published_revision is not null and published_at is not null)
  ),
  constraint business_page_publish_preview_ack_time_check check (
    acknowledged_at is null
    or (acknowledged_at>=prepared_at and acknowledged_at<expires_at)
  ),
  constraint business_page_publish_preview_consume_time_check check (
    consumed_at is null
    or (consumed_at>=acknowledged_at and consumed_at<expires_at)
  )
);

create index if not exists business_page_publish_preview_pending_idx
  on public.business_page_publish_preview_evidence(owner,business_id,prepared_at desc)
  where consumed_at is null and invalidated_at is null;

alter table public.business_page_publish_preview_evidence enable row level security;
drop policy if exists "business page publish evidence owner read"
  on public.business_page_publish_preview_evidence;
create policy "business page publish evidence owner read"
  on public.business_page_publish_preview_evidence for select
  to authenticated
  using ((select auth.uid())=owner);

revoke all on public.business_page_publish_preview_evidence
  from public,anon,authenticated,service_role;
grant select on public.business_page_publish_preview_evidence to authenticated;
grant all on public.business_page_publish_preview_evidence to service_role;

create or replace function public.native_business_page_publish_preview_payload(
  p_business_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path=''
as $$
declare
  v_owner uuid:=auth.uid();
  v_business public.businesses%rowtype;
  v_snapshot jsonb;
  v_manifest jsonb;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select * into v_business from public.businesses business
  where business.id=p_business_id and business.owner=v_owner;
  if not found then raise exception 'Owned business not found'; end if;

  v_snapshot:=public.business_publication_readiness(p_business_id);
  v_manifest:=v_snapshot->'review_manifest';
  if v_business.page_status<>'draft'
     or v_business.visibility<>'owner_only'
     or coalesce((v_snapshot->>'required_missing')::integer,1)<>0
     or coalesce((v_snapshot->>'review_manifest_current')::boolean,false) is not true
     or coalesce(v_snapshot->>'review_state','')<>'ready'
     or coalesce((v_manifest->>'complete')::boolean,false) is not true
     or coalesce((v_snapshot->>'publication_revision')::integer,0)<>v_business.publication_revision
     or coalesce((v_manifest->>'revision')::integer,0)<>v_business.publication_revision
     or coalesce(v_manifest->>'business_id','')<>v_business.id::text
     or coalesce(v_manifest#>>'{publication_target,page_status}','')<>'published'
     or coalesce(v_manifest#>>'{publication_target,visibility}','')<>'public' then
    raise exception 'The current business page revision is not ready for an exact preview';
  end if;

  perform 1 from public.business_publication_reviews review
  where review.business_id=p_business_id and review.owner=v_owner
    and review.review_state='ready' and trim(review.intention)<>''
    and review.required_missing=0
    and review.reviewed_revision=v_business.publication_revision
    and review.readiness_snapshot->>'manifest_sha256'=v_snapshot->>'manifest_sha256'
    and review.readiness_snapshot->'review_manifest'=v_manifest;
  if not found then
    raise exception 'Complete the business review for the current revision before previewing publication';
  end if;

  return jsonb_build_object(
    'preview_version','native-business-page-preview-v1',
    'target',jsonb_build_object(
      'provider','aliaspaces',
      'target_id','aliaspaces:business:'||v_business.id::text,
      'business_id',v_business.id,
      'slug',v_business.slug,
      'display_name',v_business.display_name,
      'public_route','#/b/'||v_business.slug,
      'page_status','published',
      'visibility','public'
    ),
    'action',jsonb_build_object(
      'type','publish_business_page',
      'timing','immediately_after_approval',
      'automated',false
    ),
    'revision',v_business.publication_revision,
    'manifest_sha256',v_snapshot->>'manifest_sha256',
    'manifest',v_manifest
  );
end;
$$;

create or replace function public.prepare_native_business_page_publish_preview(
  p_business_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_owner uuid:=auth.uid();
  v_payload jsonb;
  v_hash text;
  v_preview_id uuid;
  v_revision integer;
  v_target_id text;
  v_manifest_hash text;
  v_prepared_at timestamptz:=clock_timestamp();
  v_expires_at timestamptz;
  v_session_id text:=coalesce(auth.jwt()->>'session_id','');
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_business_publication_mutation(p_business_id);
  select business.publication_revision into v_revision
  from public.businesses business
  where business.id=p_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;

  v_payload:=public.native_business_page_publish_preview_payload(p_business_id);
  v_hash:=encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  v_target_id:=v_payload#>>'{target,target_id}';
  v_manifest_hash:=v_payload->>'manifest_sha256';
  v_expires_at:=v_prepared_at+interval '15 minutes';

  update public.business_page_publish_preview_evidence evidence
  set invalidated_at=v_prepared_at,invalidation_reason='superseded_by_new_preview'
  where evidence.business_id=p_business_id and evidence.owner=v_owner
    and evidence.consumed_at is null and evidence.invalidated_at is null;

  insert into public.business_page_publish_preview_evidence(
    business_id,owner,preview_version,preview_hash,preview_revision,
    preview_target_id,manifest_sha256,preview_payload,prepared_at,
    preview_session_id,expires_at
  ) values (
    p_business_id,v_owner,'native-business-page-preview-v1',v_hash,v_revision,
    v_target_id,v_manifest_hash,v_payload,v_prepared_at,v_session_id,v_expires_at
  ) returning id into v_preview_id;

  return jsonb_build_object(
    'preview_id',v_preview_id,
    'preview_version','native-business-page-preview-v1',
    'preview_hash',v_hash,
    'preview_revision',v_revision,
    'preview_target_id',v_target_id,
    'manifest_sha256',v_manifest_hash,
    'prepared_at',v_prepared_at,
    'expires_at',v_expires_at,
    'preview_payload',v_payload
  );
end;
$$;

create or replace function public.invalidate_native_business_page_previews_after_revision()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.publication_revision is distinct from old.publication_revision then
    update public.business_page_publish_preview_evidence evidence
    set invalidated_at=now(),invalidation_reason='business_revision_changed'
    where evidence.business_id=new.id and evidence.owner=new.owner
      and evidence.consumed_at is null and evidence.invalidated_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists invalidate_native_business_page_previews_after_revision on public.businesses;
create trigger invalidate_native_business_page_previews_after_revision
  after update of publication_revision on public.businesses
  for each row execute function public.invalidate_native_business_page_previews_after_revision();

create or replace function public.invalidate_native_business_page_previews_after_review()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_business_id uuid:=case when tg_op='DELETE' then old.business_id else new.business_id end;
  v_owner uuid:=case when tg_op='DELETE' then old.owner else new.owner end;
begin
  if tg_op='UPDATE' and row(
    new.intention,new.owner_review_notes,new.readiness_snapshot,
    new.required_missing,new.review_state,new.reviewed_revision
  ) is not distinct from row(
    old.intention,old.owner_review_notes,old.readiness_snapshot,
    old.required_missing,old.review_state,old.reviewed_revision
  ) then return new; end if;
  update public.business_page_publish_preview_evidence evidence
  set invalidated_at=now(),invalidation_reason='business_publication_review_changed'
  where evidence.business_id=v_business_id and evidence.owner=v_owner
    and evidence.consumed_at is null and evidence.invalidated_at is null;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists invalidate_native_business_page_previews_after_review
  on public.business_publication_reviews;
create trigger invalidate_native_business_page_previews_after_review
  after insert or update or delete on public.business_publication_reviews
  for each row execute function public.invalidate_native_business_page_previews_after_review();

create or replace function public.acknowledge_native_business_page_publish_preview(
  p_business_id uuid,
  p_preview_id uuid,
  p_preview_version text,
  p_preview_hash text,
  p_preview_revision integer,
  p_preview_target_id text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_owner uuid:=auth.uid();
  v_evidence public.business_page_publish_preview_evidence%rowtype;
  v_payload jsonb;
  v_expected_hash text;
  v_revision integer;
  v_acknowledged_at timestamptz:=clock_timestamp();
  v_session_id text:=coalesce(auth.jwt()->>'session_id','');
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_preview_id is null
     or coalesce(p_preview_version,'')<>'native-business-page-preview-v1'
     or coalesce(p_preview_hash,'')!~'^[0-9a-f]{64}$'
     or coalesce(p_preview_revision,0)<=0
     or trim(coalesce(p_preview_target_id,''))='' then
    raise exception 'Exact native business page preview evidence is required';
  end if;

  perform public.lock_business_publication_mutation(p_business_id);
  select business.publication_revision into v_revision
  from public.businesses business
  where business.id=p_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;

  select * into v_evidence
  from public.business_page_publish_preview_evidence evidence
  where evidence.id=p_preview_id and evidence.business_id=p_business_id
    and evidence.owner=v_owner for update;
  if not found then raise exception 'Prepared native business page preview evidence was not found'; end if;
  if v_evidence.acknowledged_at is not null or v_evidence.consumed_at is not null then
    raise exception 'That native business page preview was already acknowledged or consumed';
  end if;
  if v_evidence.invalidated_at is not null then
    raise exception 'That native business page preview was invalidated; review the current revision again';
  end if;
  if v_evidence.expires_at<=v_acknowledged_at then
    raise exception 'That native business page preview expired; open a fresh preview';
  end if;
  if v_evidence.preview_session_id is distinct from v_session_id then
    raise exception 'The authenticated session changed after preview; open a fresh preview';
  end if;
  if row(p_preview_version,p_preview_hash,p_preview_revision,p_preview_target_id)
     is distinct from row(v_evidence.preview_version,v_evidence.preview_hash,
       v_evidence.preview_revision,v_evidence.preview_target_id) then
    raise exception 'The acknowledged business preview proof does not match the prepared evidence';
  end if;

  v_payload:=public.native_business_page_publish_preview_payload(p_business_id);
  v_expected_hash:=encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  if v_revision<>p_preview_revision
     or v_payload#>>'{target,target_id}'<>p_preview_target_id
     or v_payload->>'preview_version'<>p_preview_version
     or v_expected_hash<>p_preview_hash
     or v_evidence.manifest_sha256<>v_payload->>'manifest_sha256'
     or v_evidence.preview_payload is distinct from v_payload then
    raise exception 'The business target, route, page revision, public copy, or persona projection changed after preview';
  end if;

  update public.business_page_publish_preview_evidence evidence
  set acknowledged_at=v_acknowledged_at
  where evidence.id=p_preview_id and evidence.owner=v_owner
    and evidence.acknowledged_at is null and evidence.consumed_at is null
    and evidence.invalidated_at is null and evidence.expires_at>v_acknowledged_at;
  if not found then raise exception 'The native business page preview could not be acknowledged atomically'; end if;
  return jsonb_build_object(
    'preview_evidence_id',p_preview_id,'preview_version',p_preview_version,
    'preview_hash',p_preview_hash,'preview_target_id',p_preview_target_id,
    'acknowledged_at',v_acknowledged_at,'expires_at',v_evidence.expires_at
  );
end;
$$;

create or replace function public.approve_and_publish_previewed_business_page(
  p_business_id uuid,
  p_preview_id uuid,
  p_preview_version text,
  p_preview_hash text,
  p_preview_revision integer,
  p_preview_target_id text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_owner uuid:=auth.uid();
  v_evidence public.business_page_publish_preview_evidence%rowtype;
  v_payload jsonb;
  v_expected_hash text;
  v_revision integer;
  v_result jsonb;
  v_consumed_at timestamptz:=clock_timestamp();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_preview_id is null
     or coalesce(p_preview_version,'')<>'native-business-page-preview-v1'
     or coalesce(p_preview_hash,'')!~'^[0-9a-f]{64}$'
     or coalesce(p_preview_revision,0)<=0
     or trim(coalesce(p_preview_target_id,''))='' then
    raise exception 'Exact native business page preview evidence is required';
  end if;

  perform public.lock_business_publication_mutation(p_business_id);
  select business.publication_revision into v_revision
  from public.businesses business
  where business.id=p_business_id and business.owner=v_owner for update;
  if not found then raise exception 'Owned business not found'; end if;

  select * into v_evidence
  from public.business_page_publish_preview_evidence evidence
  where evidence.id=p_preview_id and evidence.business_id=p_business_id
    and evidence.owner=v_owner for update;
  if not found then raise exception 'Prepared native business page preview evidence was not found'; end if;
  if v_evidence.consumed_at is not null then
    raise exception 'That native business page preview was already consumed';
  end if;
  if v_evidence.acknowledged_at is null then
    raise exception 'A separate owner acknowledgement of the exact native business page preview is required';
  end if;
  if v_evidence.invalidated_at is not null then
    raise exception 'That native business page preview was invalidated; review the current revision again';
  end if;
  if v_evidence.expires_at<=v_consumed_at then
    raise exception 'That native business page preview expired; open a fresh preview';
  end if;
  if v_evidence.preview_session_id is distinct from coalesce(auth.jwt()->>'session_id','') then
    raise exception 'The authenticated session changed after preview; open a fresh preview';
  end if;
  if row(p_preview_version,p_preview_hash,p_preview_revision,p_preview_target_id)
     is distinct from row(v_evidence.preview_version,v_evidence.preview_hash,
       v_evidence.preview_revision,v_evidence.preview_target_id) then
    raise exception 'The acknowledged business preview proof does not match the prepared evidence';
  end if;

  v_payload:=public.native_business_page_publish_preview_payload(p_business_id);
  v_expected_hash:=encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  if v_revision<>p_preview_revision
     or v_payload#>>'{target,target_id}'<>p_preview_target_id
     or v_payload->>'preview_version'<>p_preview_version
     or v_expected_hash<>p_preview_hash
     or v_evidence.manifest_sha256<>v_payload->>'manifest_sha256'
     or v_evidence.preview_payload is distinct from v_payload then
    raise exception 'The business target, route, page revision, public copy, or persona projection changed after preview';
  end if;

  update public.business_page_publish_preview_evidence evidence
  set consumed_at=v_consumed_at,
      published_revision=v_revision,published_at=v_consumed_at
  where evidence.id=p_preview_id and evidence.owner=v_owner
    and evidence.acknowledged_at is not null and evidence.consumed_at is null
    and evidence.invalidated_at is null and evidence.expires_at>v_consumed_at;
  if not found then raise exception 'The native business page preview could not be consumed atomically'; end if;

  v_result:=public.publish_business_page(p_business_id);
  v_result:=v_result||jsonb_build_object(
    'publication_current',public.business_publication_is_current(p_business_id)
  );
  if coalesce((v_result->>'publication_current')::boolean,false) is not true then
    raise exception 'Published business failed the exact-current receipt check';
  end if;
  update public.business_page_publish_preview_evidence evidence
  set publish_result=jsonb_build_object(
    'page_status',v_result->>'page_status',
    'published_revision',v_result->'published_revision',
    'published_at',v_result->'published_at',
    'publication_current',v_result->'publication_current',
    'manifest_sha256',v_result->>'manifest_sha256'
  )
  where evidence.id=p_preview_id and evidence.owner=v_owner;

  return v_result||jsonb_build_object(
    'preview_evidence_id',p_preview_id,
    'preview_version',p_preview_version,
    'preview_hash',p_preview_hash,
    'preview_target_id',p_preview_target_id,
    'preview_consumed_at',v_consumed_at
  );
end;
$$;

revoke all on function public.native_business_page_publish_preview_payload(uuid),
  public.prepare_native_business_page_publish_preview(uuid),
  public.acknowledge_native_business_page_publish_preview(uuid,uuid,text,text,integer,text),
  public.invalidate_native_business_page_previews_after_revision(),
  public.invalidate_native_business_page_previews_after_review(),
  public.approve_and_publish_previewed_business_page(uuid,uuid,text,text,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function public.prepare_native_business_page_publish_preview(uuid),
  public.acknowledge_native_business_page_publish_preview(uuid,uuid,text,text,integer,text),
  public.approve_and_publish_previewed_business_page(uuid,uuid,text,text,integer,text)
  to authenticated;

-- Keep the reviewed publisher as an internal primitive. Browser and service API
-- roles cannot call it directly to skip server preview evidence.
revoke execute on function public.publish_business_page(uuid)
  from public,anon,authenticated,service_role;
comment on function public.publish_business_page(uuid) is
  'Deprecated internal publication primitive. Browser publication must use approve_and_publish_previewed_business_page with current durable preview evidence.';
comment on table public.business_page_publish_preview_evidence is
  'Owner-readable audit evidence for exact native business page previews. Browser roles cannot insert, update, or delete evidence directly.';

commit;
