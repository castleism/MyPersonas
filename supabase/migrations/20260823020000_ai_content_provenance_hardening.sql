-- 060-ai-content-provenance-hardening.sql
-- Forward-only hardening for the immutable, already-ledgered migration 059.
--
-- This deliberately replays the complete idempotent provenance contract over
-- the frozen production 059 shape. Internal legacy_059 and snapshot identifiers
-- remain unchanged so an upgrade wraps the original review manifest exactly
-- once and reapplication stays safe. Never replace or re-run ledgered 059.
-- Canonical, fail-closed provenance and final-byte identity for new media.
--
-- This is an expansion/contract migration. It does not guess whether legacy
-- assets used AI. New public media writes are service-only, each new URL binds
-- to persona_media_assets, and the exact page review manifest includes the safe
-- provenance snapshot. Apply only with the matching media-ingest, gemini-image,
-- compose-post, frontend, and verification release.

begin;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Canonical asset provenance
-- ---------------------------------------------------------------------------

alter table public.persona_media_assets
  add column if not exists origin text not null default 'legacy',
  add column if not exists ai_use text not null default 'unknown',
  add column if not exists declaration_source text not null default 'legacy',
  add column if not exists declared_by uuid,
  add column if not exists declared_at timestamptz,
  add column if not exists generated_on_site boolean not null default false,
  add column if not exists source_sha256 text not null default '',
  add column if not exists content_sha256 text not null default '',
  add column if not exists mime_type text not null default '',
  add column if not exists byte_size bigint not null default 0,
  add column if not exists watermark_state text not null default 'legacy_unverified',
  add column if not exists watermark_version text not null default '',
  add column if not exists watermark_position text not null default '',
  add column if not exists watermark_asset_sha256 text not null default '',
  add column if not exists provenance_sha256 text not null default '',
  add column if not exists generation_event_id uuid,
  add column if not exists rendition text not null default 'legacy';

-- Never reinterpret old source labels or /generated/ paths as proof.
update public.persona_media_assets
set origin='legacy',ai_use='unknown',declaration_source='legacy',declared_by=null,
    declared_at=null,generated_on_site=false,source_sha256='',content_sha256='',
    mime_type='',byte_size=0,watermark_state='legacy_unverified',
    watermark_version='',watermark_position='',watermark_asset_sha256='',
    provenance_sha256='',generation_event_id=null,rendition='legacy'
where declaration_source='legacy';

alter table public.persona_media_assets drop constraint if exists persona_media_assets_origin_check;
alter table public.persona_media_assets add constraint persona_media_assets_origin_check
  check (origin in ('legacy','uploaded','imported','site_generated'));
alter table public.persona_media_assets drop constraint if exists persona_media_assets_ai_use_check;
alter table public.persona_media_assets add constraint persona_media_assets_ai_use_check
  check (ai_use in ('none','assisted','generated','unknown'));
alter table public.persona_media_assets drop constraint if exists persona_media_assets_declaration_source_check;
alter table public.persona_media_assets add constraint persona_media_assets_declaration_source_check
  check (declaration_source in ('legacy','owner','system','import'));
alter table public.persona_media_assets drop constraint if exists persona_media_assets_watermark_state_check;
alter table public.persona_media_assets add constraint persona_media_assets_watermark_state_check
  check (watermark_state in ('legacy_unverified','not_required','system_applied','display_overlay','unsupported'));
alter table public.persona_media_assets drop constraint if exists persona_media_assets_rendition_check;
alter table public.persona_media_assets add constraint persona_media_assets_rendition_check
  check (rendition ~ '^[a-z0-9_-]{1,64}$');
alter table public.persona_media_assets drop constraint if exists persona_media_assets_provenance_shape_check;
alter table public.persona_media_assets add constraint persona_media_assets_provenance_shape_check check (
  (
    declaration_source='legacy' and origin='legacy' and source_sha256=''
    and content_sha256='' and mime_type='' and byte_size=0
    and watermark_state='legacy_unverified' and provenance_sha256=''
  ) or (
    declaration_source<>'legacy'
    and source_sha256 ~ '^[0-9a-f]{64}$'
    and content_sha256 ~ '^[0-9a-f]{64}$'
    and provenance_sha256 ~ '^[0-9a-f]{64}$'
    and byte_size between 1 and 15728640
    and mime_type in ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')
    and declared_by is not null and declared_at is not null
    and (
      (ai_use='none' and source_sha256=content_sha256
        and watermark_state='not_required' and watermark_version=''
        and watermark_position='' and watermark_asset_sha256='')
      or
      (ai_use<>'none' and source_sha256<>content_sha256
        and watermark_state='system_applied'
        and watermark_version='mypersonas-ai-watermark-v1'
        and watermark_position='bottom_right'
        and watermark_asset_sha256='c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2')
    )
    and (
      (origin='site_generated' and generated_on_site and ai_use='generated'
        and declaration_source='system' and generation_event_id is not null)
      or
      (origin in ('uploaded','imported') and not generated_on_site
        and declaration_source in ('owner','import') and generation_event_id is null)
    )
  )
);

create index if not exists persona_media_assets_owner_public_url_idx
  on public.persona_media_assets(owner,public_url) where public_url<>'';
create index if not exists persona_media_assets_content_provenance_idx
  on public.persona_media_assets(owner,persona_id,content_sha256,provenance_sha256)
  where declaration_source<>'legacy';

create or replace function public.guard_persona_media_asset_provenance()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' and new.declaration_source='legacy' then
    raise exception 'New media assets require canonical provenance';
  end if;
  if tg_op='UPDATE' and row(
    new.owner,new.persona_id,new.storage_path,new.public_url,new.media_type,
    new.origin,new.ai_use,new.declaration_source,new.declared_by,new.declared_at,
    new.generated_on_site,new.source_sha256,new.content_sha256,new.mime_type,
    new.byte_size,new.watermark_state,new.watermark_version,
    new.watermark_position,new.watermark_asset_sha256,new.provenance_sha256,
    new.generation_event_id,new.rendition
  ) is distinct from row(
    old.owner,old.persona_id,old.storage_path,old.public_url,old.media_type,
    old.origin,old.ai_use,old.declaration_source,old.declared_by,old.declared_at,
    old.generated_on_site,old.source_sha256,old.content_sha256,old.mime_type,
    old.byte_size,old.watermark_state,old.watermark_version,
    old.watermark_position,old.watermark_asset_sha256,old.provenance_sha256,
    old.generation_event_id,old.rendition
  ) then
    raise exception 'Media provenance authority is immutable; create a corrected derivative';
  end if;
  if tg_op='UPDATE' and new.status is distinct from old.status then
    perform public.invalidate_persona_review_revision(new.persona_id);
  end if;
  return new;
end;
$$;
revoke all on function public.guard_persona_media_asset_provenance()
  from public,anon,authenticated;
drop trigger if exists guard_persona_media_asset_provenance on public.persona_media_assets;
create trigger guard_persona_media_asset_provenance
  before insert or update on public.persona_media_assets
  for each row execute function public.guard_persona_media_asset_provenance();

-- Archiving or flagging a bound asset changes what the published page is
-- allowed to serve. Treat that status transition as content: require AAL2 and
-- make every affected publication/review revision stale in the same transaction.
create or replace function public.set_persona_media_asset_status(
  p_asset_id uuid,p_status text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required';end if;
  perform public.require_aal2();
  if p_status not in('active','archived','flagged') then
    raise exception 'Invalid media asset status';end if;
  update public.persona_media_assets asset
  set status=p_status,updated_at=now()
  where asset.id=p_asset_id and asset.owner=v_owner
    and asset.status is distinct from p_status;
  get diagnostics v_count=row_count;
  if v_count=0 and not exists(
    select 1 from public.persona_media_assets asset
    where asset.id=p_asset_id and asset.owner=v_owner and asset.status=p_status
  ) then raise exception 'Owned media asset not found';end if;
  return true;
end;
$$;
revoke all on function public.set_persona_media_asset_status(uuid,text)
  from public,anon,service_role;
grant execute on function public.set_persona_media_asset_status(uuid,text)
  to authenticated;

-- The generic owner-authored RPC cannot establish byte or system authority.
revoke all on function public.add_media_asset(uuid,text,text,text,text,text,text,text,uuid,text[],jsonb)
  from public,anon,authenticated,service_role;
-- The canonical registry is service-authored too. Existing owner RLS policies
-- are not sufficient because a browser can otherwise fabricate provenance
-- fields that only media-ingest is qualified to assert.
revoke insert,update,delete on table public.persona_media_assets
  from anon,authenticated;
grant select,insert,update,delete on table public.persona_media_assets
  to service_role;

-- ---------------------------------------------------------------------------
-- Short-lived, service-authored generation evidence
-- ---------------------------------------------------------------------------

create table if not exists public.ai_media_generation_events (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid not null references public.personas(id) on delete cascade,
  backend_id uuid references public.ai_backends(id) on delete set null,
  provider text not null check (provider in ('google','openai','other')),
  model text not null check (char_length(model) between 1 and 300),
  prompt_sha256 text not null check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  output_sha256 text not null check (output_sha256 ~ '^[0-9a-f]{64}$'),
  output_mime text not null check (output_mime in ('image/png','image/jpeg','image/webp')),
  derivative_count integer not null default 0 check (derivative_count between 0 and 8),
  expires_at timestamptz not null default (now()+interval '10 minutes'),
  created_at timestamptz not null default now(),
  unique(id,owner,persona_id)
);
alter table public.ai_media_generation_events enable row level security;
revoke all on public.ai_media_generation_events from public,anon,authenticated;
grant select,insert,update,delete on public.ai_media_generation_events to service_role;
create index if not exists ai_media_generation_events_expiry_idx
  on public.ai_media_generation_events(expires_at,id);

create or replace function public.use_ai_media_generation_event_service(
  p_event_id uuid,p_owner uuid,p_persona_id uuid,p_source_sha256 text,p_mime_type text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  update public.ai_media_generation_events event
  set derivative_count=event.derivative_count+1
  where event.id=p_event_id and event.owner=p_owner and event.persona_id=p_persona_id
    and event.output_sha256=p_source_sha256 and event.output_mime=p_mime_type
    and event.expires_at>now() and event.derivative_count<8;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.use_ai_media_generation_event_service(uuid,uuid,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.use_ai_media_generation_event_service(uuid,uuid,uuid,text,text)
  to service_role;

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
    if p_source_sha256<>p_content_sha256 or p_watermark_state<>'not_required'
       or p_watermark_version<>'' or p_watermark_asset_sha256<>'' then
      raise exception 'No-AI media must preserve its source bytes and need no watermark';
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

  -- Serialize the owner's registrations so concurrent service requests cannot
  -- each observe capacity and collectively exceed the abuse limits. These are
  -- safety ceilings, not billing entitlements.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'persona-media-owner-quota'||E'\u001f'||p_owner::text,59059059
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner::text||E'\u001f'||p_public_url,59059059
  ));
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
  if v_daily_count>=200 then
    raise exception 'Daily persona media registration safety limit reached';
  end if;
  if v_total_bytes+p_byte_size>2147483648 then
    raise exception 'Persona media storage safety limit reached';
  end if;
  if v_asset_count>=5000 then
    raise exception 'Persona media asset-count safety limit reached';
  end if;
  if v_persona_bytes+p_byte_size>536870912 then
    raise exception 'Persona media per-persona storage safety limit reached';
  end if;
  if v_persona_count>=1000 then
    raise exception 'Persona media per-persona asset-count safety limit reached';
  end if;
  if v_generated then
    update public.ai_media_generation_events event
    set derivative_count=event.derivative_count+1
    where event.id=p_generation_event_id and event.owner=p_owner
      and event.persona_id=p_persona_id and event.output_sha256=p_source_sha256
      and event.output_mime=p_mime_type and event.expires_at>now()
      and event.derivative_count<8
    returning event.backend_id into v_backend;
    if not found then
      raise exception 'Generation evidence is expired, mismatched, or exhausted';
    end if;
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

-- Public objects must not outlive their accounting row. The legacy owner RPC
-- removed only the registry row, not the immutable Storage object, which could
-- bypass byte quotas and provenance lookup. Archive/flag remains available;
-- physical purge and account erasure require a coordinated service operation.
do $migration$
begin
  if to_regprocedure('public.delete_persona_media_asset(uuid)') is not null then
    revoke all on function public.delete_persona_media_asset(uuid)
      from public,anon,authenticated;
    comment on function public.delete_persona_media_asset(uuid) is
      'Disabled for browser sessions by migration 059; use AAL2 archive/flag or a coordinated service purge that removes Storage and registry state.';
  end if;
end
$migration$;

-- New public media bytes are written only by media-ingest/service_role. Public
-- object reads remain available; browser insert/update/delete are removed.
drop policy if exists "persona media owner insert" on storage.objects;
drop policy if exists "persona media owner update" on storage.objects;
drop policy if exists "persona media owner delete" on storage.objects;
drop policy if exists "persona media service insert" on storage.objects;
create policy "persona media service insert" on storage.objects
  as restrictive for insert to public
  with check (bucket_id<>'persona-media' or auth.role()='service_role');
drop policy if exists "persona media service update" on storage.objects;
create policy "persona media service update" on storage.objects
  as restrictive for update to public
  using (bucket_id<>'persona-media' or auth.role()='service_role')
  with check (bucket_id<>'persona-media' or auth.role()='service_role');
drop policy if exists "persona media service delete" on storage.objects;
create policy "persona media service delete" on storage.objects
  as restrictive for delete to public
  using (bucket_id<>'persona-media' or auth.role()='service_role');

-- ---------------------------------------------------------------------------
-- Bind every currently writable first-party media consumer to its asset row.
-- Legacy/external URLs remain null; page review later distinguishes the one-time
-- external grandfather snapshot from new references that must fail closed.
-- ---------------------------------------------------------------------------

alter table public.personas
  add column if not exists avatar_media_asset_id uuid references public.persona_media_assets(id) on delete set null,
  add column if not exists banner_media_asset_id uuid references public.persona_media_assets(id) on delete set null,
  add column if not exists bg_media_asset_id uuid references public.persona_media_assets(id) on delete set null,
  add column if not exists feed_media_asset_id uuid references public.persona_media_assets(id) on delete set null;
alter table public.posts
  add column if not exists media_asset_id uuid references public.persona_media_assets(id) on delete set null;
alter table public.album_items
  add column if not exists media_asset_id uuid references public.persona_media_assets(id) on delete set null;
alter table public.drafts
  add column if not exists media_asset_id uuid references public.persona_media_assets(id) on delete set null;
alter table public.post_drafts
  add column if not exists source_media_asset_id uuid references public.persona_media_assets(id) on delete set null,
  add column if not exists fb_media_asset_id uuid references public.persona_media_assets(id) on delete set null,
  add column if not exists ig_media_asset_id uuid references public.persona_media_assets(id) on delete set null,
  add column if not exists x_media_asset_id uuid references public.persona_media_assets(id) on delete set null,
  add column if not exists approved_fb_provenance_sha256 text not null default '',
  add column if not exists approved_ig_provenance_sha256 text not null default '',
  add column if not exists media_provenance_required boolean not null default true;
alter table public.post_drafts alter column media_provenance_required set default true;
-- This flag used to be mutable and default false. Backfill every dormant row,
-- then make false structurally impossible so no caller can bypass the guard.
-- A partially applied predecessor may already have the binding/guard triggers;
-- remove them inside this transaction so the flag-only backfill cannot be
-- mistaken for a media edit. Both triggers are recreated below.
drop trigger if exists aa_bind_post_draft_media_asset_references on public.post_drafts;
drop trigger if exists zz_guard_post_draft_media_provenance on public.post_drafts;
update public.post_drafts set media_provenance_required=true
where media_provenance_required is not true;
alter table public.post_drafts drop constraint if exists post_drafts_media_provenance_required_check;
alter table public.post_drafts add constraint post_drafts_media_provenance_required_check
  check (media_provenance_required);
alter table public.post_drafts drop constraint if exists post_drafts_approved_provenance_hash_check;
alter table public.post_drafts add constraint post_drafts_approved_provenance_hash_check check (
  (approved_fb_provenance_sha256='' or approved_fb_provenance_sha256~'^[0-9a-f]{64}$')
  and (approved_ig_provenance_sha256='' or approved_ig_provenance_sha256~'^[0-9a-f]{64}$')
);

create or replace function public.is_safe_no_ai_persona_media_render_url(p_url text)
returns boolean language plpgsql immutable set search_path='' as $$
declare
  v_part text;v_key text;v_value text;v_width integer:=0;v_height integer:=0;
  v_resize integer:=0;v_quality integer:=0;v_format integer:=0;
begin
  -- Only the bounded transform shape used by the composer is accepted. This is
  -- intentionally unavailable to AI-used media because a transformed response
  -- is not the exact registered watermarked byte sequence.
  if coalesce(p_url,'')!~'^https://[^/?#]+/storage/v1/render/image/public/persona-media/[^?#]+/published/provenance/none/[^?#]+\?[^#]+$' then
    return false;
  end if;
  if cardinality(string_to_array(split_part(p_url,'?',2),'&'))>5 then return false; end if;
  foreach v_part in array string_to_array(split_part(p_url,'?',2),'&') loop
    v_key:=split_part(v_part,'=',1);v_value:=split_part(v_part,'=',2);
    if v_part<>v_key||'='||v_value then return false; end if;
    if v_key='width' then
      v_width:=v_width+1;
      if v_width>1 or v_value!~'^[1-9][0-9]{0,3}$' or v_value::integer>4096 then return false; end if;
    elsif v_key='height' then
      v_height:=v_height+1;
      if v_height>1 or v_value!~'^[1-9][0-9]{0,3}$' or v_value::integer>4096 then return false; end if;
    elsif v_key='resize' then
      v_resize:=v_resize+1;
      if v_resize>1 or v_value not in ('cover','contain','fill') then return false; end if;
    elsif v_key='quality' then
      v_quality:=v_quality+1;
      if v_quality>1 or v_value!~'^(?:[2-9][0-9]|100)$' then return false; end if;
    elsif v_key='format' then
      v_format:=v_format+1;
      if v_format>1 or v_value not in ('origin','webp') then return false; end if;
    else return false;
    end if;
  end loop;
  return v_width=1 and v_height=1;
end;
$$;
revoke all on function public.is_safe_no_ai_persona_media_render_url(text)
  from public,anon,authenticated;

create or replace function public.persona_media_reference_matches_asset(
  p_url text,p_public_url text,p_ai_use text
)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_url,'')=coalesce(p_public_url,'')
    or (
      p_ai_use='none'
      and public.is_safe_no_ai_persona_media_render_url(p_url)
      and replace(split_part(p_url,'?',1),
        '/storage/v1/render/image/public/','/storage/v1/object/public/')=p_public_url
    )
$$;
revoke all on function public.persona_media_reference_matches_asset(text,text,text)
  from public,anon,authenticated;

create or replace function public.resolve_persona_media_asset_reference(
  p_persona_id uuid,p_url text
)
returns uuid language plpgsql security definer stable set search_path='' as $$
declare v_id uuid;v_ai_use text;v_public_url text;
begin
  if coalesce(p_url,'')='' then
    return null;
  end if;
  if p_url~'/storage/v1/render/image/public/persona-media/' then
    if not public.is_safe_no_ai_persona_media_render_url(p_url) then
      raise exception 'Persona media transform URL is not an allowed bounded no-AI rendition';
    end if;
    v_public_url:=replace(split_part(p_url,'?',1),
      '/storage/v1/render/image/public/','/storage/v1/object/public/');
    select asset.id,asset.ai_use into v_id,v_ai_use
    from public.persona_media_assets asset
    join public.personas persona on persona.id=p_persona_id
    where asset.persona_id=p_persona_id and asset.owner=persona.owner
      and asset.public_url=v_public_url and asset.status='active'
      and asset.declaration_source<>'legacy';
    if not found then raise exception 'Canonical media URL is missing its active provenance record'; end if;
    if v_ai_use<>'none' then
      raise exception 'AI-used media must use its exact registered public URL';
    end if;
    return v_id;
  end if;
  if p_url~'/storage/v1/object/public/persona-media/' then
    if p_url!~'/storage/v1/object/public/persona-media/[^/]+/published/provenance/'
       or p_url~'[?#]' then
      raise exception 'First-party persona media must use an exact canonical provenance URL';
    end if;
  else
    -- External HTTPS embeds predate the registry. They remain unbound here and
    -- are reported explicitly by the review manifest; callers must not treat a
    -- null binding as evidence about their AI provenance.
    return null;
  end if;
  select asset.id into v_id from public.persona_media_assets asset
  join public.personas persona on persona.id=p_persona_id
  where asset.persona_id=p_persona_id and asset.owner=persona.owner
    and asset.public_url=p_url
    and asset.status='active' and asset.declaration_source<>'legacy';
  if not found then raise exception 'Canonical media URL is missing its active provenance record'; end if;
  return v_id;
end;
$$;
revoke all on function public.resolve_persona_media_asset_reference(uuid,text)
  from public,anon,authenticated;

create or replace function public.bind_persona_media_asset_references()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  new.avatar_media_asset_id:=public.resolve_persona_media_asset_reference(new.id,new.avatar_url);
  new.banner_media_asset_id:=public.resolve_persona_media_asset_reference(new.id,new.banner_url);
  new.bg_media_asset_id:=public.resolve_persona_media_asset_reference(new.id,new.bg_url);
  new.feed_media_asset_id:=public.resolve_persona_media_asset_reference(new.id,new.feed_img_url);
  return new;
end;
$$;
revoke all on function public.bind_persona_media_asset_references() from public,anon,authenticated;
drop trigger if exists aa_bind_persona_media_asset_references on public.personas;
create trigger aa_bind_persona_media_asset_references before insert or update
  on public.personas for each row execute function public.bind_persona_media_asset_references();

create or replace function public.bind_post_media_asset_reference()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  new.media_asset_id:=public.resolve_persona_media_asset_reference(new.persona_id,new.media_url);
  return new;
end;
$$;
revoke all on function public.bind_post_media_asset_reference() from public,anon,authenticated;
drop trigger if exists aa_bind_post_media_asset_reference on public.posts;
create trigger aa_bind_post_media_asset_reference before insert or update
  on public.posts for each row execute function public.bind_post_media_asset_reference();

create or replace function public.bind_album_item_media_asset_reference()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_persona_id uuid;
begin
  select album.persona_id into v_persona_id from public.albums album where album.id=new.album_id;
  if v_persona_id is null then raise exception 'Album not found'; end if;
  new.media_asset_id:=public.resolve_persona_media_asset_reference(v_persona_id,new.thumb_url);
  return new;
end;
$$;
revoke all on function public.bind_album_item_media_asset_reference() from public,anon,authenticated;
drop trigger if exists aa_bind_album_item_media_asset_reference on public.album_items;
create trigger aa_bind_album_item_media_asset_reference before insert or update
  on public.album_items for each row execute function public.bind_album_item_media_asset_reference();

create or replace function public.bind_draft_media_asset_reference()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  new.media_asset_id:=public.resolve_persona_media_asset_reference(new.persona_id,new.media_url);
  return new;
end;
$$;
revoke all on function public.bind_draft_media_asset_reference() from public,anon,authenticated;
drop trigger if exists aa_bind_draft_media_asset_reference on public.drafts;
create trigger aa_bind_draft_media_asset_reference before insert or update
  on public.drafts for each row execute function public.bind_draft_media_asset_reference();

create or replace function public.bind_post_draft_media_asset_references()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_source uuid;v_fb uuid;v_ig uuid;v_x uuid;
begin
  v_source:=public.resolve_persona_media_asset_reference(new.persona_id,new.source_image_url);
  v_fb:=public.resolve_persona_media_asset_reference(new.persona_id,new.fb_image_url);
  v_ig:=public.resolve_persona_media_asset_reference(new.persona_id,new.ig_image_url);
  v_x:=public.resolve_persona_media_asset_reference(new.persona_id,new.x_image_url);
  if tg_op='UPDATE' and new.fb_image_url~'/post-approved-media/' then v_fb:=old.fb_media_asset_id; end if;
  if tg_op='UPDATE' and new.ig_image_url~'/post-approved-media/' then v_ig:=old.ig_media_asset_id; end if;
  new.source_media_asset_id:=v_source;
  new.fb_media_asset_id:=coalesce(v_fb,v_source);
  new.ig_media_asset_id:=coalesce(v_ig,v_source);
  new.x_media_asset_id:=coalesce(v_x,v_source);
  return new;
end;
$$;
revoke all on function public.bind_post_draft_media_asset_references() from public,anon,authenticated;
drop trigger if exists aa_bind_post_draft_media_asset_references on public.post_drafts;
create trigger aa_bind_post_draft_media_asset_references before insert or update
  on public.post_drafts for each row execute function public.bind_post_draft_media_asset_references();

create or replace function public.guard_post_draft_media_provenance()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_fb text;v_ig text;v_fb_url text;v_ig_url text;
begin
  if new.status in ('scheduled','publishing','posted') then
    if 'facebook'=any(new.targets) then
      v_fb_url:=coalesce(nullif(new.fb_image_url,''),new.source_image_url);
      select asset.provenance_sha256 into v_fb from public.persona_media_assets asset
      where asset.id=new.fb_media_asset_id and asset.persona_id=new.persona_id
        and asset.owner=new.owner and asset.status='active'
        and asset.declaration_source<>'legacy'
        and (asset.ai_use='none' or asset.watermark_state='system_applied')
        and (
          public.persona_media_reference_matches_asset(v_fb_url,asset.public_url,asset.ai_use)
          or (
            -- Migration 035 replaces a reviewed source URL with a content-addressed
            -- approval snapshot. AI-used bytes must retain the registered final
            -- hash. A no-AI Supabase render may differ, so its first transition
            -- must bind OLD's bounded render URL; later transitions may preserve
            -- only that already-frozen snapshot.
            v_fb_url~'/storage/v1/object/public/post-approved-media/'
            and v_fb_url=new.approved_fb_media_url
            and new.approved_fb_media_sha256~'^[0-9a-f]{64}$'
            and (
              new.approved_fb_media_sha256=asset.content_sha256
              or (
                asset.ai_use='none' and tg_op='UPDATE'
                and public.is_safe_no_ai_persona_media_render_url(
                  coalesce(nullif(old.fb_image_url,''),old.source_image_url))
                and public.persona_media_reference_matches_asset(
                  coalesce(nullif(old.fb_image_url,''),old.source_image_url),
                  asset.public_url,asset.ai_use)
              )
              or (
                tg_op='UPDATE' and old.fb_image_url=new.fb_image_url
                and old.approved_fb_media_url=old.fb_image_url
                and old.approved_fb_media_sha256=new.approved_fb_media_sha256
                and old.fb_media_asset_id=new.fb_media_asset_id
              )
            )
          )
        );
      if v_fb is null then raise exception 'Facebook media lacks canonical AI provenance'; end if;
      if new.status='scheduled' then new.approved_fb_provenance_sha256:=v_fb;
      elsif new.approved_fb_provenance_sha256 is distinct from v_fb then
        raise exception 'Facebook media provenance changed after approval'; end if;
    else new.approved_fb_provenance_sha256:=''; end if;
    if 'instagram'=any(new.targets) then
      v_ig_url:=coalesce(nullif(new.ig_image_url,''),new.source_image_url);
      select asset.provenance_sha256 into v_ig from public.persona_media_assets asset
      where asset.id=new.ig_media_asset_id and asset.persona_id=new.persona_id
        and asset.owner=new.owner and asset.status='active'
        and asset.declaration_source<>'legacy'
        and (asset.ai_use='none' or asset.watermark_state='system_applied')
        and (
          public.persona_media_reference_matches_asset(v_ig_url,asset.public_url,asset.ai_use)
          or (
            v_ig_url~'/storage/v1/object/public/post-approved-media/'
            and v_ig_url=new.approved_ig_media_url
            and new.approved_ig_media_sha256~'^[0-9a-f]{64}$'
            and (
              new.approved_ig_media_sha256=asset.content_sha256
              or (
                asset.ai_use='none' and tg_op='UPDATE'
                and public.is_safe_no_ai_persona_media_render_url(
                  coalesce(nullif(old.ig_image_url,''),old.source_image_url))
                and public.persona_media_reference_matches_asset(
                  coalesce(nullif(old.ig_image_url,''),old.source_image_url),
                  asset.public_url,asset.ai_use)
              )
              or (
                tg_op='UPDATE' and old.ig_image_url=new.ig_image_url
                and old.approved_ig_media_url=old.ig_image_url
                and old.approved_ig_media_sha256=new.approved_ig_media_sha256
                and old.ig_media_asset_id=new.ig_media_asset_id
              )
            )
          )
        );
      if v_ig is null then raise exception 'Instagram media lacks canonical AI provenance'; end if;
      if new.status='scheduled' then new.approved_ig_provenance_sha256:=v_ig;
      elsif new.approved_ig_provenance_sha256 is distinct from v_ig then
        raise exception 'Instagram media provenance changed after approval'; end if;
    else new.approved_ig_provenance_sha256:=''; end if;
  elsif new.status in ('draft','failed','skipped') then
    new.approved_fb_provenance_sha256:='';new.approved_ig_provenance_sha256:='';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_post_draft_media_provenance() from public,anon,authenticated;
drop trigger if exists zz_guard_post_draft_media_provenance on public.post_drafts;
create trigger zz_guard_post_draft_media_provenance before insert or update
  on public.post_drafts for each row execute function public.guard_post_draft_media_provenance();

-- ---------------------------------------------------------------------------
-- Exact page review: wrap the reviewed migration-051 manifest rather than
-- duplicating it. Every new media reference fails closed unless it binds to
-- valid provenance. External HTTPS media that existed at the first 059 apply is
-- snapshotted once and remains visibly unverified until re-ingested; reapplying
-- this migration never grandfathers later references.
-- ---------------------------------------------------------------------------

create table if not exists public.persona_media_reference_grandfathers(
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  persona_id uuid not null references public.personas(id) on delete cascade,
  consumer text not null,slot text not null,url text not null,
  url_sha256 text not null check(url_sha256~'^[0-9a-f]{64}$'),
  snapshotted_at timestamptz not null default now(),
  unique(owner,persona_id,consumer,slot,url_sha256)
);
create table if not exists public.persona_media_reference_grandfather_snapshots(
  version text primary key,snapshotted_at timestamptz not null default now()
);
alter table public.persona_media_reference_grandfathers enable row level security;
alter table public.persona_media_reference_grandfather_snapshots enable row level security;
revoke all on public.persona_media_reference_grandfathers,
  public.persona_media_reference_grandfather_snapshots
  from public,anon,authenticated;

do $migration$
begin
  if not exists(select 1 from public.persona_media_reference_grandfather_snapshots
    where version='059-initial-external-media') then
    insert into public.persona_media_reference_grandfathers(
      owner,persona_id,consumer,slot,url,url_sha256
    )
    select reference.owner,reference.persona_id,reference.consumer,reference.slot,
      reference.url,encode(extensions.digest(convert_to(reference.url,'UTF8'),'sha256'),'hex')
    from (
      select persona.owner,persona.id as persona_id,'profile'::text as consumer,
        'avatar'::text as slot,persona.avatar_url as url from public.personas persona
      union all select persona.owner,persona.id,'profile','banner',persona.banner_url from public.personas persona
      union all select persona.owner,persona.id,'profile','background',persona.bg_url from public.personas persona
      union all select persona.owner,persona.id,'profile','feed_header',persona.feed_img_url from public.personas persona
      union all select persona.owner,persona.id,'post',post.id::text,post.media_url
        from public.posts post join public.personas persona on persona.id=post.persona_id
      union all select persona.owner,persona.id,'album_item',item.id::text,item.thumb_url
        from public.album_items item join public.albums album on album.id=item.album_id
        join public.personas persona on persona.id=album.persona_id
    ) reference
    where coalesce(reference.url,'')~*'^https://'
      and reference.url!~'/storage/v1/(object|render/image)/public/persona-media/'
    on conflict(owner,persona_id,consumer,slot,url_sha256) do nothing;
    insert into public.persona_media_reference_grandfather_snapshots(version)
      values('059-initial-external-media');
  end if;
end
$migration$;

do $migration$
begin
  if to_regprocedure('public.persona_publication_review_manifest_legacy_059(uuid)') is null then
    alter function public.persona_publication_review_manifest(uuid)
      rename to persona_publication_review_manifest_legacy_059;
  end if;
end
$migration$;

create or replace function public.persona_publication_review_manifest(p_persona_id uuid)
returns jsonb language plpgsql security definer stable set search_path='' as $$
declare
  v_base jsonb;v_safe jsonb;v_invalid integer:=0;v_legacy integer:=0;
  v_external integer:=0;v_external_grandfathered integer:=0;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=auth.uid()) then
    raise exception 'Owned persona not found';
  end if;
  v_base:=public.persona_publication_review_manifest_legacy_059(p_persona_id);
  with media_refs as (
    select 'profile'::text as consumer,'avatar'::text as slot,persona.avatar_url as url,
      persona.avatar_media_asset_id as asset_id from public.personas persona where persona.id=p_persona_id
    union all select 'profile','banner',persona.banner_url,persona.banner_media_asset_id from public.personas persona where persona.id=p_persona_id
    union all select 'profile','background',persona.bg_url,persona.bg_media_asset_id from public.personas persona where persona.id=p_persona_id
    union all select 'profile','feed_header',persona.feed_img_url,persona.feed_media_asset_id from public.personas persona where persona.id=p_persona_id
    union all select 'post',post.id::text,post.media_url,post.media_asset_id from public.posts post where post.persona_id=p_persona_id
    union all select 'album_item',item.id::text,item.thumb_url,item.media_asset_id
      from public.album_items item join public.albums album on album.id=item.album_id where album.persona_id=p_persona_id
  ), inspected as (
    select reference.consumer,reference.slot,reference.url,reference.asset_id,
      asset.ai_use,asset.declaration_source,asset.content_sha256,
      asset.watermark_state,asset.watermark_version,asset.provenance_sha256,
      asset.status,asset.public_url,
      reference.url~'/storage/v1/(object|render/image)/public/persona-media/[^/]+/published/provenance/' as canonical,
      reference.url~'/storage/v1/(object|render/image)/public/persona-media/' as first_party,
      reference.url!~*'^https://' as local_reference,
      grandfather.id is not null as grandfathered_external
    from media_refs reference left join public.persona_media_assets asset
      on asset.id=reference.asset_id and asset.persona_id=p_persona_id and asset.owner=auth.uid()
    left join public.persona_media_reference_grandfathers grandfather
      on grandfather.owner=auth.uid() and grandfather.persona_id=p_persona_id
      and grandfather.consumer=reference.consumer and grandfather.slot=reference.slot
      and grandfather.url=reference.url
      and grandfather.url_sha256=encode(extensions.digest(convert_to(reference.url,'UTF8'),'sha256'),'hex')
    where coalesce(reference.url,'')<>''
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'consumer',consumer,'slot',slot,'asset_id',asset_id,
      'reference_scope',case when first_party then 'first_party'
        when local_reference then 'local_unbound' else 'external_embed' end,
      'ai_use',coalesce(ai_use,case when first_party or local_reference then 'missing' else 'external_unverified' end),
      'declaration_source',coalesce(declaration_source,'legacy'),
      'grandfathered_external',grandfathered_external,
      'content_sha256',coalesce(content_sha256,''),
      'watermark_state',coalesce(watermark_state,'legacy_unverified'),
      'watermark_version',coalesce(watermark_version,''),
      'provenance_sha256',coalesce(provenance_sha256,'')
    ) order by consumer,slot),'[]'::jsonb),
    count(*) filter(where (
      (first_party or local_reference or asset_id is not null) and (
        asset_id is null or public_url is null or status<>'active' or declaration_source='legacy'
        or not public.persona_media_reference_matches_asset(url,public_url,ai_use)
        or content_sha256!~'^[0-9a-f]{64}$' or provenance_sha256!~'^[0-9a-f]{64}$'
        or (ai_use='none' and watermark_state<>'not_required')
        or (ai_use<>'none' and watermark_state<>'system_applied')
      )
    ) or (not first_party and not local_reference and asset_id is null and not grandfathered_external)),
    count(*) filter(where first_party and not canonical),
    count(*) filter(where not first_party and not local_reference and asset_id is null),
    count(*) filter(where not first_party and not local_reference and asset_id is null and grandfathered_external)
  into v_safe,v_invalid,v_legacy,v_external,v_external_grandfathered from inspected;

  v_base:=v_base||jsonb_build_object(
    'schema_version',2,
    'ai_provenance',jsonb_build_object(
      'complete',v_invalid=0,'assets',coalesce(v_safe,'[]'::jsonb),
      'invalid_new_assets',v_invalid,'legacy_unverified_assets',v_legacy,
      'external_unverified_assets',v_external,
      'grandfathered_external_assets',v_external_grandfathered,
      'blocked_external_assets',v_external-v_external_grandfathered,
      'watermark_version','mypersonas-ai-watermark-v1',
      'watermark_asset_sha256','c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2'
    )
  );
  if v_invalid>0 then
    v_base:=jsonb_set(v_base,'{complete}','false'::jsonb,true);
    v_base:=jsonb_set(v_base,'{truncation_reasons}',
      coalesce(v_base->'truncation_reasons','[]'::jsonb)
        ||jsonb_build_array('A new media URL is missing canonical AI provenance, an allowed legacy snapshot, or its required final watermark'),true);
  end if;
  return v_base;
end;
$$;
revoke all on function public.persona_publication_review_manifest(uuid)
  from public,anon,authenticated;
grant execute on function public.persona_publication_review_manifest(uuid)
  to authenticated;

comment on table public.ai_media_generation_events is
  'Short-lived service evidence binding a generated source hash to its owner, persona, model, and derivative budget; raw prompts and image bytes are not stored here.';
comment on column public.persona_media_assets.provenance_sha256 is
  'Server-authored hash of the immutable safe provenance fields. It is evidence binding, not a claim that the derivative carries a cryptographically signed C2PA manifest.';

commit;
