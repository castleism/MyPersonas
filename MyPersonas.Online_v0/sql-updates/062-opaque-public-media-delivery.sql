-- 062-opaque-public-media-delivery.sql
-- Forward-only opaque delivery for reviewed persona media.
--
-- The immutable provenance registry keeps its private Storage path. Public page
-- references use an unguessable, independently generated UUID and are resolved
-- through the public-media Edge Function. Resolution is service-only and
-- rechecks the exact published review on every request. Do not enable rich
-- image/video widgets until the service backfill, owner re-review, and signed-in
-- two-account privacy tests are complete.

begin;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Opaque identity. This table is intentionally unavailable to browser roles:
-- an opaque id may be public, but its owner/persona/Storage correlation is not.
-- ---------------------------------------------------------------------------

create table if not exists public.persona_public_media_handles (
  public_id      uuid primary key default gen_random_uuid(),
  asset_id       uuid not null references public.persona_media_assets(id) on delete cascade,
  owner          uuid not null,
  persona_id     uuid not null references public.personas(id) on delete cascade,
  generation     integer not null check (generation between 1 and 2147483647),
  state          text not null default 'active'
                 check (state in ('active','rotated','revoked')),
  created_at     timestamptz not null default now(),
  retired_at     timestamptz,
  unique (asset_id,generation),
  check ((state='active' and retired_at is null)
    or (state in ('rotated','revoked') and retired_at is not null))
);

create unique index if not exists persona_public_media_one_active_asset_idx
  on public.persona_public_media_handles(asset_id) where state='active';
create index if not exists persona_public_media_persona_state_idx
  on public.persona_public_media_handles(persona_id,state,created_at);

alter table public.persona_public_media_handles enable row level security;
revoke all on public.persona_public_media_handles
  from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.persona_public_media_handles
  to service_role;

comment on table public.persona_public_media_handles is
  'Private correlation map from an unguessable public delivery id to one immutable persona_media_assets row. Browser roles receive only the public id in reviewed URLs.';

-- Atomic egress guard. It is intentionally global + per opaque handle rather
-- than trusting a caller-supplied IP header. This protects the byte/hash proxy;
-- an upstream WAF remains a separate production release requirement.
create table if not exists public.public_media_rate_limits_062(
  scope text primary key,
  window_started timestamptz not null,
  request_count integer not null check(request_count between 1 and 2147483647)
);
create index if not exists public_media_rate_limits_window_062_idx
  on public.public_media_rate_limits_062(window_started);
alter table public.public_media_rate_limits_062 enable row level security;
revoke all on public.public_media_rate_limits_062 from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.public_media_rate_limits_062 to service_role;

create or replace function public.consume_public_media_rate_limit_service(p_public_id uuid)
returns boolean language plpgsql security definer volatile set search_path='' as $$
declare v_now timestamptz:=clock_timestamp();v_global integer;v_asset integer;v_valid boolean;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_public_id is null then return false; end if;
  insert into public.public_media_rate_limits_062(scope,window_started,request_count)
  values ('global',v_now,1)
  on conflict(scope) do update set
    window_started=case when public.public_media_rate_limits_062.window_started<=v_now-interval '1 minute' then v_now else public.public_media_rate_limits_062.window_started end,
    request_count=case when public.public_media_rate_limits_062.window_started<=v_now-interval '1 minute' then 1 else public.public_media_rate_limits_062.request_count+1 end
  returning request_count into v_global;
  if v_global>6000 then return false; end if;
  -- Invalid UUID-shaped requests increment only the one bounded global row.
  -- Creating an attacker-controlled row before proving an active handle would
  -- turn this protection into a permanent high-cardinality storage DoS.
  select exists(select 1 from public.persona_public_media_handles handle
    where handle.public_id=p_public_id and handle.state='active') into v_valid;
  if not v_valid then return false; end if;
  insert into public.public_media_rate_limits_062(scope,window_started,request_count)
  values ('asset:'||p_public_id::text,v_now,1)
  on conflict(scope) do update set
    window_started=case when public.public_media_rate_limits_062.window_started<=v_now-interval '1 minute' then v_now else public.public_media_rate_limits_062.window_started end,
    request_count=case when public.public_media_rate_limits_062.window_started<=v_now-interval '1 minute' then 1 else public.public_media_rate_limits_062.request_count+1 end
  returning request_count into v_asset;
  -- Active-handle rows are bounded by the private handle registry. Retired
  -- rows are removed incrementally; a request can never choose the row key.
  if v_global%100=0 then
    delete from public.public_media_rate_limits_062 rate
    where rate.ctid in (
      select stale.ctid from public.public_media_rate_limits_062 stale
      where stale.scope<>'global' and stale.window_started<v_now-interval '10 minutes'
      order by stale.window_started limit 1000
    );
  end if;
  -- Default emergency ceiling: 100 verified object requests/second site-wide
  -- and 10/second for one object. The upstream WAF is still mandatory and
  -- production load testing must validate these conservative defaults.
  return v_asset<=600;
end;
$$;
revoke all on function public.consume_public_media_rate_limit_service(uuid)
  from public,anon,authenticated;
grant execute on function public.consume_public_media_rate_limit_service(uuid)
  to service_role;

create table if not exists public.public_media_release_controls_062(
  singleton boolean primary key default true check(singleton),
  waf_confirmed boolean not null default false,
  evidence_reference text not null default '' check(char_length(evidence_reference)<=500),
  confirmed_at timestamptz,
  check((waf_confirmed and confirmed_at is not null and evidence_reference<>'')
    or (not waf_confirmed and confirmed_at is null))
);
insert into public.public_media_release_controls_062(singleton)
values(true) on conflict(singleton) do nothing;
alter table public.public_media_release_controls_062 enable row level security;
revoke all on public.public_media_release_controls_062 from public,anon,authenticated,service_role;
grant select,update on public.public_media_release_controls_062 to service_role;
create or replace function public.set_public_media_waf_attestation_service(
  p_confirmed boolean,p_evidence_reference text default ''
)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if coalesce(p_confirmed,false) and (trim(coalesce(p_evidence_reference,''))=''
    or char_length(p_evidence_reference)>500) then
    raise exception 'A bounded WAF evidence reference is required';
  end if;
  update public.public_media_release_controls_062 set
    waf_confirmed=coalesce(p_confirmed,false),
    evidence_reference=case when coalesce(p_confirmed,false) then trim(p_evidence_reference) else '' end,
    confirmed_at=case when coalesce(p_confirmed,false) then now() else null end
  where singleton;
  return coalesce(p_confirmed,false);
end;
$$;
revoke all on function public.set_public_media_waf_attestation_service(boolean,text)
  from public,anon,authenticated;
grant execute on function public.set_public_media_waf_attestation_service(boolean,text)
  to service_role;

-- Private-bucket reads are authorized by storage.objects SELECT RLS. Keep one
-- permissive owner policy so an owner can use Storage APIs for their own prefix,
-- plus a restrictive boundary that prevents any broader/drifted permissive
-- policy from making a known cross-owner path readable. service_role bypasses
-- RLS and is the only identity used by the byte-verifying public proxy.
drop policy if exists "persona media public read" on storage.objects;
drop policy if exists "persona media owner select" on storage.objects;
create policy "persona media owner select" on storage.objects
  for select to authenticated
  using (
    bucket_id='persona-media'
    and split_part(name,'/',1)=auth.uid()::text
  );
drop policy if exists "persona media opaque read boundary" on storage.objects;
create policy "persona media opaque read boundary" on storage.objects
  as restrictive for select to public
  using (
    bucket_id<>'persona-media'
    or auth.role()='service_role'
    or (
      auth.role()='authenticated'
      and split_part(name,'/',1)=auth.uid()::text
    )
  );

-- The canonical public URL is deliberately bound to the protected media
-- gateway. An alternate host,
-- query string, fragment, credential, encoded path, or extra segment is not the
-- same reviewed reference.
create or replace function public.public_media_delivery_url(p_public_id uuid)
returns text language sql immutable set search_path='' as $$
  select case when p_public_id is null then null else
    'https://media.mypersonas.online/persona/v1/'||p_public_id::text
  end
$$;

create or replace function public.public_media_handle_from_url(p_url text)
returns uuid language plpgsql immutable set search_path='' as $$
declare v_id text;
begin
  if coalesce(p_url,'') !~
    '^https://media[.]mypersonas[.]online/persona/v1/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_id:=substring(p_url from '/persona/v1/([0-9a-f-]{36})$');
  return v_id::uuid;
exception when others then
  return null;
end;
$$;

-- Classify every spelling that tries to use the dedicated public gateway or
-- its private Supabase Edge origin. Only public_media_handle_from_url() may
-- accept a value; this broader helper makes malformed/encoded forms fail closed.
create or replace function public.is_public_media_delivery_reference_062(p_url text)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_text text:=lower(coalesce(p_url,''));v_hex text;v_loops integer:=0;
begin
  if v_text='' then return false; end if;
  if char_length(v_text)>8192 then
    return position('media.mypersonas.online' in v_text)>0
      or position('nwsqyuucwzihruszocge.supabase.co' in v_text)>0;
  end if;
  loop
    v_hex:=substring(v_text from '%([0-9a-f]{2})');
    exit when v_hex is null or v_loops>=256;
    v_text:=replace(v_text,'%'||v_hex,chr(get_byte(decode(v_hex,'hex'),0)));
    v_loops:=v_loops+1;
  end loop;
  v_text:=replace(v_text,E'\\','/');
  return position('media.mypersonas.online' in v_text)>0
    or (
      position('nwsqyuucwzihruszocge.supabase.co' in v_text)>0
      and (
        position('/functions/v1/public-media/' in v_text)>0
        or position('/functions/v1/approved-media/' in v_text)>0
      )
    );
exception when others then
  return position('media.mypersonas.online' in lower(coalesce(p_url,'')))>0
    or position('/functions/v1/public-media/' in lower(coalesce(p_url,'')))>0
    or position('/functions/v1/approved-media/' in lower(coalesce(p_url,'')))>0;
end;
$$;

revoke all on function public.public_media_delivery_url(uuid),
  public.public_media_handle_from_url(text),
  public.is_public_media_delivery_reference_062(text)
  from public,anon,authenticated;

-- Treat every project Storage spelling as private infrastructure, including
-- signed/authenticated endpoints and percent-encoded separators. This is a
-- classifier, not a URL normalizer: ambiguity fails closed.
create or replace function public.is_persona_media_storage_reference_062(p_url text)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_text text:=lower(coalesce(p_url,''));v_hex text;v_loops integer:=0;
begin
  if v_text='' then return false; end if;
  if char_length(v_text)>8192 then
    return position('nwsqyuucwzihruszocge.supabase.co' in v_text)>0;
  end if;
  loop
    v_hex:=substring(v_text from '%([0-9a-f]{2})');
    exit when v_hex is null or v_loops>=256;
    v_text:=replace(v_text,'%'||v_hex,
      chr(get_byte(decode(v_hex,'hex'),0)));
    v_loops:=v_loops+1;
  end loop;
  v_text:=replace(v_text,E'\\','/');
  return position('nwsqyuucwzihruszocge.supabase.co' in v_text)>0
    and position('/storage/v1/' in v_text)>0;
exception when others then
  return position('nwsqyuucwzihruszocge.supabase.co' in lower(coalesce(p_url,'')))>0
    and position('/storage' in lower(coalesce(p_url,'')))>0;
end;
$$;
revoke all on function public.is_persona_media_storage_reference_062(text)
  from public,anon,authenticated;

-- Keep the older `media` bucket visible as its own quantified no-go. These
-- objects cannot be rebound by URL alone because ownership, bytes, hash, and
-- reviewed persona/slot must be independently verified before import.
create or replace function public.is_legacy_media_bucket_reference_062(p_url text)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_text text:=lower(coalesce(p_url,''));v_hex text;v_loops integer:=0;
begin
  if v_text='' then return false; end if;
  if char_length(v_text)>8192 then
    return position('nwsqyuucwzihruszocge.supabase.co' in v_text)>0
      and position('/media/' in v_text)>0;
  end if;
  loop
    v_hex:=substring(v_text from '%([0-9a-f]{2})');
    exit when v_hex is null or v_loops>=256;
    v_text:=replace(v_text,'%'||v_hex,chr(get_byte(decode(v_hex,'hex'),0)));
    v_loops:=v_loops+1;
  end loop;
  v_text:=replace(v_text,E'\\','/');
  return position('nwsqyuucwzihruszocge.supabase.co' in v_text)>0
    and v_text~'/storage/v1/(object|render/image)/(public/|sign/|authenticated/)?media(/|$)';
exception when others then
  return position('nwsqyuucwzihruszocge.supabase.co' in lower(coalesce(p_url,'')))>0
    and position('/media/' in lower(coalesce(p_url,'')))>0;
end;
$$;
revoke all on function public.is_legacy_media_bucket_reference_062(text)
  from public,anon,authenticated;

-- Public media fields may use a normal credential-free external HTTPS URL or
-- the one exact branded opaque handle. Private Storage/proxy spellings and the
-- reserved approved-media namespace never qualify as a public field value.
create or replace function public.is_public_media_reference_url_062(
  p_url text,p_allow_empty boolean default false
)
returns boolean language sql immutable set search_path='' as $$
  select public.is_safe_credential_free_https_url(p_url,p_allow_empty)
    and not public.is_persona_media_storage_reference_062(p_url)
    and (
      coalesce(p_url,'')=''
      or not public.is_public_media_delivery_reference_062(p_url)
      or public.public_media_handle_from_url(p_url) is not null
    )
$$;

-- Navigation and embed destinations are external-only. They must never turn a
-- project Storage path or either media gateway namespace into a public link.
create or replace function public.is_external_reference_url_062(
  p_url text,p_allow_empty boolean default false
)
returns boolean language sql immutable set search_path='' as $$
  select public.is_safe_credential_free_https_url(p_url,p_allow_empty)
    and not public.is_persona_media_storage_reference_062(p_url)
    and not public.is_public_media_delivery_reference_062(p_url)
$$;

revoke all on function public.is_public_media_reference_url_062(text,boolean),
  public.is_external_reference_url_062(text,boolean)
  from public,anon,authenticated;

-- Replace the generic-HTTPS publication predicate from 051. Existing unsafe
-- rows are not rewritten: they make a published revision non-current until the
-- owner explicitly replaces or clears them and re-reviews the page.
create or replace function public.persona_public_urls_safe(p_persona_id uuid)
returns boolean language sql security definer stable set search_path='' as $$
  select exists (
    select 1 from public.personas persona where persona.id=p_persona_id
      and public.is_public_media_reference_url_062(persona.avatar_url,true)
      and public.is_public_media_reference_url_062(persona.banner_url,true)
      and public.is_public_media_reference_url_062(persona.bg_url,true)
      and public.is_public_media_reference_url_062(persona.feed_img_url,true)
      and public.is_external_reference_url_062(persona.music_url,true)
      and public.is_external_reference_url_062(persona.live_url,true)
      and not exists (select 1 from public.persona_links link
        where link.persona_id=persona.id
          and not public.is_external_reference_url_062(link.url,true))
      and not exists (select 1 from public.posts post
        where post.persona_id=persona.id
          and not public.is_public_media_reference_url_062(post.media_url,true))
      and not exists (select 1 from public.album_items item
        join public.albums album on album.id=item.album_id
        where album.persona_id=persona.id and (
          not public.is_public_media_reference_url_062(item.thumb_url,true)
          or not public.is_external_reference_url_062(item.link_url,true)
        ))
      and not exists (select 1 from public.persona_page_layouts page
        cross join lateral jsonb_array_elements(case
          when jsonb_typeof(coalesce(page.layout->'widgets','[]'::jsonb))='array'
          then coalesce(page.layout->'widgets','[]'::jsonb) else '[]'::jsonb end) widget(value)
        where page.persona_id=persona.id and widget.value->>'kind'='link'
          and not public.is_external_reference_url_062(widget.value->>'url',false))
      and not exists (select 1 from public.persona_affiliate_offers offer
        join public.affiliate_products product
          on product.id=offer.product_id and product.owner=offer.owner
        where offer.persona_id=persona.id and offer.owner=persona.owner
          and offer.status='active' and product.status='active' and (
            not public.is_external_reference_url_062(product.affiliate_url,false)
            or not public.is_external_reference_url_062(product.product_url,true)
            or not public.is_public_media_reference_url_062(product.image_url,true)
          ))
  )
$$;
revoke all on function public.persona_public_urls_safe(uuid)
  from public,anon,authenticated;

-- These forward guards preserve unchanged legacy values so owners can reach
-- and remediate them, but reject every new/changed public navigation value.
create or replace function public.guard_external_references_062()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_row jsonb:=to_jsonb(new);v_old jsonb;v_changed boolean;
begin
  if tg_op='UPDATE' then v_old:=to_jsonb(old); end if;
  if tg_table_name='persona_links' then
    v_changed:=tg_op='INSERT' or (v_row->>'url') is distinct from (v_old->>'url');
    if v_changed and not public.is_external_reference_url_062(v_row->>'url',true) then
      raise exception 'Persona links require an external HTTPS destination';
    end if;
  elsif tg_table_name='album_items' then
    v_changed:=tg_op='INSERT' or (v_row->>'link_url') is distinct from (v_old->>'link_url');
    if v_changed and not public.is_external_reference_url_062(v_row->>'link_url',true) then
      raise exception 'Album destinations require an external HTTPS URL';
    end if;
  elsif tg_table_name='persona_page_layouts' then
    v_changed:=tg_op='INSERT' or (v_row->'layout') is distinct from (v_old->'layout');
    if v_changed and exists (
      select 1 from jsonb_array_elements(case
        when jsonb_typeof(coalesce(v_row->'layout'->'widgets','[]'::jsonb))='array'
        then coalesce(v_row->'layout'->'widgets','[]'::jsonb) else '[]'::jsonb end) widget(value)
      where widget.value->>'kind'='link'
        and not public.is_external_reference_url_062(widget.value->>'url',false)
    ) then
      raise exception 'Page link widgets require an external HTTPS destination';
    end if;
  elsif tg_table_name='affiliate_products' and v_row->>'status'='active' then
    v_changed:=tg_op='INSERT' or (v_row->>'status') is distinct from (v_old->>'status')
      or (v_row->>'affiliate_url') is distinct from (v_old->>'affiliate_url')
      or (v_row->>'product_url') is distinct from (v_old->>'product_url');
    if v_changed and (
      not public.is_external_reference_url_062(v_row->>'affiliate_url',false)
      or not public.is_external_reference_url_062(v_row->>'product_url',true)
    ) then
      raise exception 'Active affiliate destinations must use external HTTPS URLs';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_external_references_062()
  from public,anon,authenticated;

drop trigger if exists guard_persona_link_external_reference_062 on public.persona_links;
create trigger guard_persona_link_external_reference_062 before insert or update
  on public.persona_links for each row execute function public.guard_external_references_062();
drop trigger if exists guard_album_link_external_reference_062 on public.album_items;
create trigger guard_album_link_external_reference_062 before insert or update
  on public.album_items for each row execute function public.guard_external_references_062();
drop trigger if exists guard_layout_external_reference_062 on public.persona_page_layouts;
create trigger guard_layout_external_reference_062 before insert or update
  on public.persona_page_layouts for each row execute function public.guard_external_references_062();
drop trigger if exists guard_affiliate_external_reference_062 on public.affiliate_products;
create trigger guard_affiliate_external_reference_062 before insert or update
  on public.affiliate_products for each row execute function public.guard_external_references_062();

create or replace function public.persona_media_asset_canonical_eligible_062(
  p_asset public.persona_media_assets
)
returns boolean language sql immutable set search_path='' as $$
  select p_asset.status='active' and p_asset.declaration_source<>'legacy'
    and p_asset.content_sha256~'^[0-9a-f]{64}$'
    and p_asset.provenance_sha256~'^[0-9a-f]{64}$'
    and p_asset.byte_size between 1 and 15728640
    and p_asset.mime_type in ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')
    and (p_asset.ai_use='none' and p_asset.watermark_state='not_required'
      or p_asset.ai_use<>'none' and p_asset.watermark_state='system_applied')
    and p_asset.storage_path~(
      '^'||lower(p_asset.owner::text)||'/published/provenance/(none|assisted|generated|unknown)/(uploaded|generated)/'
      ||lower(p_asset.persona_id::text)||'/(?:[a-z0-9_-]+/){1,6}'
      ||p_asset.content_sha256||'[.](png|jpg|webp|gif|mp4|webm)$'
    )
    and p_asset.public_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'
      ||p_asset.storage_path
$$;
revoke all on function public.persona_media_asset_canonical_eligible_062(public.persona_media_assets)
  from public,anon,authenticated;

-- Only server code can create or rotate handles. Issuance never makes draft
-- media anonymously readable: resolve_public_media_service still requires an
-- exact current published review containing the reference and provenance hash.
create or replace function public.issue_persona_public_media_handle_service(
  p_asset_id uuid,p_rotate boolean default false
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_asset public.persona_media_assets%rowtype;
  v_existing uuid;
  v_generation integer;
  v_public_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_asset_id is null then raise exception 'Asset is required'; end if;

  select * into v_asset from public.persona_media_assets asset
  where asset.id=p_asset_id for update;
  if not found then raise exception 'Media asset not found'; end if;
  if not public.persona_media_asset_canonical_eligible_062(v_asset) then
    raise exception 'Only active canonical media can receive a public handle';
  end if;

  select handle.public_id into v_existing
  from public.persona_public_media_handles handle
  where handle.asset_id=p_asset_id and handle.state='active' for update;
  if found and not coalesce(p_rotate,false) then return v_existing; end if;
  if found then
    update public.persona_public_media_handles
    set state='rotated',retired_at=now()
    where public_id=v_existing and state='active';
  end if;

  select coalesce(max(handle.generation),0)+1 into v_generation
  from public.persona_public_media_handles handle where handle.asset_id=p_asset_id;
  insert into public.persona_public_media_handles(
    asset_id,owner,persona_id,generation,state
  ) values (
    v_asset.id,v_asset.owner,v_asset.persona_id,v_generation,'active'
  ) returning public_id into v_public_id;
  return v_public_id;
end;
$$;

create or replace function public.backfill_persona_public_media_handles_service(
  p_limit integer default 100
)
returns integer language plpgsql security definer set search_path='' as $$
declare v_asset_id uuid;v_count integer:=0;v_limit integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  v_limit:=greatest(1,least(coalesce(p_limit,100),500));
  for v_asset_id in
    select asset.id from public.persona_media_assets asset
    where public.persona_media_asset_canonical_eligible_062(asset)
      and not exists(select 1 from public.persona_public_media_handles handle
        where handle.asset_id=asset.id and handle.state='active')
    order by asset.created_at,asset.id limit v_limit
    for update skip locked
  loop
    perform public.issue_persona_public_media_handle_service(v_asset_id,false);
    v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.issue_persona_public_media_handle_service(uuid,boolean),
  public.backfill_persona_public_media_handles_service(integer)
  from public,anon,authenticated;
grant execute on function public.issue_persona_public_media_handle_service(uuid,boolean),
  public.backfill_persona_public_media_handles_service(integer)
  to service_role;

-- Private workflow resolver. It is used by authenticated owner preview and the
-- approval pipeline, never exposed to a browser role. It does not require a
-- page publication because drafts must remain usable after the bucket is made
-- private, but it does require exact ownership and canonical immutable bytes.
create or replace function public.resolve_persona_media_asset_service(
  p_owner uuid,p_asset_id uuid
)
returns table(
  bucket text,storage_path text,mime_type text,byte_size bigint,
  content_sha256 text
)
language plpgsql security definer stable set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null or p_asset_id is null then return; end if;
  return query
  select 'persona-media'::text,asset.storage_path,asset.mime_type,
    asset.byte_size,asset.content_sha256
  from public.persona_media_assets asset
  join public.personas persona on persona.id=asset.persona_id and persona.owner=asset.owner
  where asset.id=p_asset_id and asset.owner=p_owner and asset.status='active'
    and asset.declaration_source<>'legacy'
    and asset.byte_size between 1 and 15728640
    and asset.mime_type in ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')
    and asset.content_sha256~'^[0-9a-f]{64}$'
    and asset.provenance_sha256~'^[0-9a-f]{64}$'
    and (asset.ai_use='none' and asset.watermark_state='not_required'
      or asset.ai_use<>'none' and asset.watermark_state='system_applied')
    and asset.storage_path~(
      '^'||lower(asset.owner::text)||'/published/provenance/(none|assisted|generated|unknown)/(uploaded|generated)/'
      ||lower(asset.persona_id::text)||'/(?:[a-z0-9_-]+/){1,6}'
      ||asset.content_sha256||'[.](png|jpg|webp|gif|mp4|webm)$'
    )
    and asset.public_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/'
      ||asset.storage_path
  limit 1;
end;
$$;
revoke all on function public.resolve_persona_media_asset_service(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.resolve_persona_media_asset_service(uuid,uuid)
  to service_role;

-- A reference binds either the immutable private Storage URL (draft/owner
-- compatibility) or its exact active opaque URL. Publication below rejects the
-- private Storage form, so it cannot escape through a newly reviewed page.
create or replace function public.persona_media_reference_matches_asset(
  p_url text,p_public_url text,p_ai_use text
)
returns boolean language sql security definer stable set search_path='' as $$
  select coalesce(p_url,'')=coalesce(p_public_url,'')
    or (
      p_ai_use='none'
      and public.is_safe_no_ai_persona_media_render_url(p_url)
      and replace(split_part(p_url,'?',1),
        '/storage/v1/render/image/public/','/storage/v1/object/public/')=p_public_url
    )
    or exists (
      select 1
      from public.persona_public_media_handles handle
      join public.persona_media_assets asset on asset.id=handle.asset_id
      where handle.public_id=public.public_media_handle_from_url(p_url)
        and handle.state='active' and asset.status='active'
        and asset.public_url=p_public_url
        and handle.owner=asset.owner and handle.persona_id=asset.persona_id
        and p_url=public.public_media_delivery_url(handle.public_id)
    )
$$;

create or replace function public.resolve_persona_media_asset_reference(
  p_persona_id uuid,p_url text
)
returns uuid language plpgsql security definer stable set search_path='' as $$
declare v_id uuid;v_ai_use text;v_public_url text;v_public_id uuid;
begin
  if coalesce(p_url,'')='' then return null; end if;

  v_public_id:=public.public_media_handle_from_url(p_url);
  if v_public_id is not null then
    select asset.id into v_id
    from public.persona_public_media_handles handle
    join public.persona_media_assets asset on asset.id=handle.asset_id
    join public.personas persona on persona.id=p_persona_id
    where handle.public_id=v_public_id and handle.state='active'
      and handle.asset_id=asset.id and handle.owner=asset.owner
      and handle.persona_id=asset.persona_id
      and asset.persona_id=p_persona_id and asset.owner=persona.owner
      and asset.status='active' and asset.declaration_source<>'legacy'
      and p_url=public.public_media_delivery_url(handle.public_id);
    if not found then raise exception 'Opaque media URL is not bound to this active persona asset'; end if;
    return v_id;
  end if;

  if public.is_public_media_delivery_reference_062(p_url) then
    raise exception 'Opaque media URL is malformed or uses an untrusted origin';
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
    if v_ai_use<>'none' then raise exception 'AI-used media must use its exact registered byte sequence'; end if;
    return v_id;
  end if;
  if p_url~'/storage/v1/object/public/persona-media/' then
    if p_url!~'/storage/v1/object/public/persona-media/[^/]+/published/provenance/'
       or p_url~'[?#]' then
      raise exception 'First-party persona media must use an exact canonical provenance URL';
    end if;
  else
    return null;
  end if;
  select asset.id into v_id from public.persona_media_assets asset
  join public.personas persona on persona.id=p_persona_id
  where asset.persona_id=p_persona_id and asset.owner=persona.owner
    and asset.public_url=p_url and asset.status='active'
    and asset.declaration_source<>'legacy';
  if not found then raise exception 'Canonical media URL is missing its active provenance record'; end if;
  return v_id;
end;
$$;

revoke all on function public.persona_media_reference_matches_asset(text,text,text),
  public.resolve_persona_media_asset_reference(uuid,text)
  from public,anon,authenticated;

-- Compose/approval consumers receive opaque URLs from browsers, but must make
-- provenance decisions from the canonical registry row. This service-only
-- bridge resolves one exact owned-persona reference without returning a raw
-- Storage URL to the browser.
create or replace function public.resolve_owned_persona_media_reference_service(
  p_owner uuid,p_persona_id uuid,p_url text
)
returns table(
  id uuid,source_sha256 text,content_sha256 text,ai_use text,
  declaration_source text,watermark_state text,provenance_sha256 text,
  rendition text,status text
)
language plpgsql security definer stable set search_path='' as $$
declare v_asset_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null or p_persona_id is null or coalesce(p_url,'')='' then return; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=p_owner) then return; end if;
  v_asset_id:=public.resolve_persona_media_asset_reference(p_persona_id,p_url);
  if v_asset_id is null then return; end if;
  return query
  select asset.id,asset.source_sha256,asset.content_sha256,asset.ai_use,
    asset.declaration_source,asset.watermark_state,asset.provenance_sha256,
    asset.rendition,asset.status
  from public.persona_media_assets asset
  where asset.id=v_asset_id and asset.owner=p_owner
    and asset.persona_id=p_persona_id and asset.status='active'
    and asset.declaration_source<>'legacy'
    and asset.source_sha256~'^[0-9a-f]{64}$'
    and asset.content_sha256~'^[0-9a-f]{64}$'
    and asset.provenance_sha256~'^[0-9a-f]{64}$'
  limit 1;
end;
$$;
revoke all on function public.resolve_owned_persona_media_reference_service(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.resolve_owned_persona_media_reference_service(uuid,uuid,text)
  to service_role;

-- Service-only cutover rewrites every page reference bound to one immutable
-- asset. Triggers make the persona draft/stale; the owner must review the new
-- exact opaque URL before it can resolve anonymously.
create or replace function public.bind_persona_public_media_handle_service(
  p_asset_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_asset public.persona_media_assets%rowtype;
  v_public_id uuid;
  v_url text;
  v_personas integer:=0;v_posts integer:=0;v_items integer:=0;
  v_drafts integer:=0;v_post_drafts integer:=0;v_products integer:=0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  select * into v_asset from public.persona_media_assets asset
  where asset.id=p_asset_id for update;
  if not found then raise exception 'Media asset not found'; end if;
  v_public_id:=public.issue_persona_public_media_handle_service(p_asset_id,false);
  v_url:=public.public_media_delivery_url(v_public_id);

  update public.personas persona set
    avatar_url=case when persona.avatar_media_asset_id=p_asset_id then v_url else persona.avatar_url end,
    banner_url=case when persona.banner_media_asset_id=p_asset_id then v_url else persona.banner_url end,
    bg_url=case when persona.bg_media_asset_id=p_asset_id then v_url else persona.bg_url end,
    feed_img_url=case when persona.feed_media_asset_id=p_asset_id then v_url else persona.feed_img_url end
  where persona.id=v_asset.persona_id and persona.owner=v_asset.owner and (
    persona.avatar_media_asset_id=p_asset_id or persona.banner_media_asset_id=p_asset_id
    or persona.bg_media_asset_id=p_asset_id or persona.feed_media_asset_id=p_asset_id
  );
  get diagnostics v_personas=row_count;
  update public.posts post set media_url=v_url
  where post.persona_id=v_asset.persona_id and post.media_asset_id=p_asset_id;
  get diagnostics v_posts=row_count;
  update public.album_items item set thumb_url=v_url
  from public.albums album
  where item.album_id=album.id and album.persona_id=v_asset.persona_id
    and item.media_asset_id=p_asset_id;
  get diagnostics v_items=row_count;

  update public.drafts draft set media_url=v_url
  where draft.persona_id=v_asset.persona_id
    and draft.media_asset_id=p_asset_id
    and public.is_persona_media_storage_reference_062(draft.media_url);
  get diagnostics v_drafts=row_count;

  -- Only unapproved editable post drafts are rewritten in place. Approved,
  -- scheduled, publishing, and terminal rows retain their exact audit URL, but
  -- remain usable through source_*_media_asset_id and the private resolver.
  update public.post_drafts draft set
    source_image_url=case when draft.source_media_asset_id=p_asset_id
      and public.is_persona_media_storage_reference_062(draft.source_image_url)
      then v_url else draft.source_image_url end,
    fb_image_url=case when draft.fb_media_asset_id=p_asset_id
      and public.is_persona_media_storage_reference_062(draft.fb_image_url)
      then v_url else draft.fb_image_url end,
    ig_image_url=case when draft.ig_media_asset_id=p_asset_id
      and public.is_persona_media_storage_reference_062(draft.ig_image_url)
      then v_url else draft.ig_image_url end,
    x_image_url=case when draft.x_media_asset_id=p_asset_id
      and public.is_persona_media_storage_reference_062(draft.x_image_url)
      then v_url else draft.x_image_url end
  where draft.owner=v_asset.owner and draft.persona_id=v_asset.persona_id
    and draft.status='draft' and (
      draft.source_media_asset_id=p_asset_id and public.is_persona_media_storage_reference_062(draft.source_image_url)
      or draft.fb_media_asset_id=p_asset_id and public.is_persona_media_storage_reference_062(draft.fb_image_url)
      or draft.ig_media_asset_id=p_asset_id and public.is_persona_media_storage_reference_062(draft.ig_image_url)
      or draft.x_media_asset_id=p_asset_id and public.is_persona_media_storage_reference_062(draft.x_image_url)
    );
  get diagnostics v_post_drafts=row_count;

  -- Affiliate images have no dedicated asset-id column. Rewrite only a product
  -- whose exact registered URL belongs to this persona and is not actively
  -- shared by another persona; ambiguous/shared rows remain a readiness blocker.
  update public.affiliate_products product set image_url=v_url,updated_at=now()
  where product.owner=v_asset.owner and product.image_url=v_asset.public_url
    and exists(select 1 from public.persona_affiliate_offers offer
      where offer.product_id=product.id and offer.owner=v_asset.owner
        and offer.persona_id=v_asset.persona_id and offer.status='active')
    and not exists(select 1 from public.persona_affiliate_offers other_offer
      where other_offer.product_id=product.id and other_offer.owner=v_asset.owner
        and other_offer.persona_id<>v_asset.persona_id and other_offer.status='active');
  get diagnostics v_products=row_count;

  return jsonb_build_object(
    'asset_id',p_asset_id,'public_id',v_public_id,'public_url',v_url,
    'personas',v_personas,'posts',v_posts,'album_items',v_items,
    'drafts',v_drafts,'post_drafts',v_post_drafts,
    'affiliate_products',v_products
  );
end;
$$;

create or replace function public.rotate_persona_public_media_handle_service(
  p_asset_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_new uuid;v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  v_new:=public.issue_persona_public_media_handle_service(p_asset_id,true);
  v_result:=public.bind_persona_public_media_handle_service(p_asset_id);
  if (v_result->>'public_id')::uuid is distinct from v_new then
    raise exception 'Opaque handle rotation did not bind the new generation';
  end if;
  return v_result||jsonb_build_object('rotated',true);
end;
$$;

create or replace function public.cutover_persona_public_media_batch_service(
  p_limit integer default 25
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_asset_id uuid;v_limit integer;v_count integer:=0;v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  v_limit:=greatest(1,least(coalesce(p_limit,25),100));
  for v_asset_id in
    select candidate.asset_id from (
      select persona.avatar_media_asset_id asset_id,persona.avatar_url url from public.personas persona
      union all select persona.banner_media_asset_id,persona.banner_url from public.personas persona
      union all select persona.bg_media_asset_id,persona.bg_url from public.personas persona
      union all select persona.feed_media_asset_id,persona.feed_img_url from public.personas persona
      union all select post.media_asset_id,post.media_url from public.posts post
      union all select item.media_asset_id,item.thumb_url from public.album_items item
      union all select draft.media_asset_id,draft.media_url from public.drafts draft
      union all select draft.source_media_asset_id,draft.source_image_url
        from public.post_drafts draft where draft.status='draft'
      union all select draft.fb_media_asset_id,draft.fb_image_url
        from public.post_drafts draft where draft.status='draft'
      union all select draft.ig_media_asset_id,draft.ig_image_url
        from public.post_drafts draft where draft.status='draft'
      union all select draft.x_media_asset_id,draft.x_image_url
        from public.post_drafts draft where draft.status='draft'
      union all select asset.id,product.image_url
        from public.affiliate_products product
        join public.persona_affiliate_offers offer on offer.product_id=product.id
          and offer.owner=product.owner and offer.status='active'
        join public.persona_media_assets asset on asset.owner=product.owner
          and asset.persona_id=offer.persona_id and asset.public_url=product.image_url
    ) candidate
    join public.persona_media_assets asset on asset.id=candidate.asset_id
    where public.is_persona_media_storage_reference_062(candidate.url)
      and asset.status='active' and asset.declaration_source<>'legacy'
    group by candidate.asset_id
    order by min(asset.created_at),candidate.asset_id
    limit v_limit
  loop
    v_result:=public.bind_persona_public_media_handle_service(v_asset_id);
    v_count:=v_count+1;
  end loop;
  return jsonb_build_object(
    'cutover_assets',v_count,
    'limit',v_limit,
    'more_owner_paths_remain',exists(
      select 1 from (
        select avatar_url url from public.personas union all select banner_url from public.personas
        union all select bg_url from public.personas union all select feed_img_url from public.personas
        union all select music_url from public.personas union all select live_url from public.personas
        union all select media_url from public.posts union all select thumb_url from public.album_items
        union all select media_url from public.drafts
        union all select source_image_url from public.post_drafts
        union all select fb_image_url from public.post_drafts
        union all select ig_image_url from public.post_drafts
        union all select x_image_url from public.post_drafts
        union all select image_url from public.affiliate_products
      ) reference where public.is_persona_media_storage_reference_062(reference.url)
    )
  );
end;
$$;

revoke all on function public.bind_persona_public_media_handle_service(uuid),
  public.rotate_persona_public_media_handle_service(uuid),
  public.cutover_persona_public_media_batch_service(integer)
  from public,anon,authenticated;
grant execute on function public.bind_persona_public_media_handle_service(uuid),
  public.rotate_persona_public_media_handle_service(uuid),
  public.cutover_persona_public_media_batch_service(integer)
  to service_role;

-- Archive/flag invalidates the handle in the same transaction. Reactivation
-- requires a fresh service-issued handle and a new owner review.
create or replace function public.revoke_public_media_handle_after_asset_status()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status is distinct from old.status and new.status<>'active' then
    update public.persona_public_media_handles handle
    set state='revoked',retired_at=now()
    where handle.asset_id=new.id and handle.state='active';
  end if;
  return null;
end;
$$;
revoke all on function public.revoke_public_media_handle_after_asset_status()
  from public,anon,authenticated;
drop trigger if exists revoke_public_media_handle_after_asset_status
  on public.persona_media_assets;
create trigger revoke_public_media_handle_after_asset_status
after update of status on public.persona_media_assets
for each row execute function public.revoke_public_media_handle_after_asset_status();

-- Once the bucket is private, old clients must not be able to reintroduce any
-- first-party Storage spelling. The finalizer locks these same tables before
-- its last readiness check, closing both the transition race and later writes.
create or replace function public.guard_private_persona_media_references_062()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_row jsonb:=to_jsonb(new);v_old jsonb;v_key text;
begin
  if tg_op='UPDATE' then v_old:=to_jsonb(old); end if;
  -- Music/live embeds remain external-URL-only until native audio/video assets
  -- have their own bound provenance columns and byte/range delivery contract.
  foreach v_key in array array['music_url','live_url'] loop
    if (tg_op='INSERT' or (v_row->>v_key) is distinct from (v_old->>v_key))
       and not public.is_external_reference_url_062(v_row->>v_key,true) then
      raise exception 'Music and live URLs must use an external HTTPS provider';
    end if;
  end loop;
  if coalesce((select not bucket.public from storage.buckets bucket
    where bucket.id='persona-media'),false) then
    foreach v_key in array array[
      'avatar_url','banner_url','bg_url','feed_img_url','media_url','thumb_url',
      'source_image_url','fb_image_url','ig_image_url','x_image_url','image_url'
    ] loop
      -- Reject every raw reference on INSERT and every newly introduced or
      -- changed raw reference on UPDATE. An unrelated queue status/error
      -- update must not be bricked by a grandfathered unchanged URL, while the
      -- finalizer still refuses to cross the private-bucket boundary with any
      -- such row present.
      if (tg_op='INSERT' or (v_row->>v_key) is distinct from (v_old->>v_key))
         and public.is_persona_media_storage_reference_062(v_row->>v_key) then
        raise exception 'Private persona media must use its exact opaque asset reference';
      end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_private_persona_media_references_062()
  from public,anon,authenticated;

drop trigger if exists guard_private_persona_media_personas_062 on public.personas;
create trigger guard_private_persona_media_personas_062 before insert or update
  on public.personas for each row execute function public.guard_private_persona_media_references_062();
drop trigger if exists guard_private_persona_media_posts_062 on public.posts;
create trigger guard_private_persona_media_posts_062 before insert or update
  on public.posts for each row execute function public.guard_private_persona_media_references_062();
drop trigger if exists guard_private_persona_media_album_items_062 on public.album_items;
create trigger guard_private_persona_media_album_items_062 before insert or update
  on public.album_items for each row execute function public.guard_private_persona_media_references_062();
drop trigger if exists guard_private_persona_media_drafts_062 on public.drafts;
create trigger guard_private_persona_media_drafts_062 before insert or update
  on public.drafts for each row execute function public.guard_private_persona_media_references_062();
drop trigger if exists guard_private_persona_media_post_drafts_062 on public.post_drafts;
create trigger guard_private_persona_media_post_drafts_062 before insert or update
  on public.post_drafts for each row execute function public.guard_private_persona_media_references_062();
drop trigger if exists guard_private_persona_media_products_062 on public.affiliate_products;
create trigger guard_private_persona_media_products_062 before insert or update
  on public.affiliate_products for each row execute function public.guard_private_persona_media_references_062();

-- ---------------------------------------------------------------------------
-- Exact page-review wrapper. Migration 061 may have replaced the manifest; 062
-- wraps whatever current function exists rather than replaying that migration.
-- ---------------------------------------------------------------------------

do $migration$
begin
  if to_regprocedure('public.persona_publication_review_manifest_legacy_062(uuid)') is null then
    alter function public.persona_publication_review_manifest(uuid)
      rename to persona_publication_review_manifest_legacy_062;
  end if;
end
$migration$;
revoke all on function public.persona_publication_review_manifest_legacy_062(uuid)
  from public,anon,authenticated;

create or replace function public.persona_publication_review_manifest(p_persona_id uuid)
returns jsonb language plpgsql security definer stable set search_path='' as $$
declare
  v_base jsonb;v_assets jsonb;v_invalid integer:=0;v_opaque integer:=0;
  v_storage_paths integer:=0;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=auth.uid()) then
    raise exception 'Owned persona not found';
  end if;
  v_base:=public.persona_publication_review_manifest_legacy_062(p_persona_id);

  with media_refs as (
    select 'profile'::text consumer,'avatar'::text slot,persona.avatar_url url,
      persona.avatar_media_asset_id asset_id from public.personas persona where persona.id=p_persona_id
    union all select 'profile','banner',persona.banner_url,persona.banner_media_asset_id from public.personas persona where persona.id=p_persona_id
    union all select 'profile','background',persona.bg_url,persona.bg_media_asset_id from public.personas persona where persona.id=p_persona_id
    union all select 'profile','feed_header',persona.feed_img_url,persona.feed_media_asset_id from public.personas persona where persona.id=p_persona_id
    union all select 'profile','music_external',persona.music_url,null::uuid from public.personas persona where persona.id=p_persona_id
    union all select 'profile','live_external',persona.live_url,null::uuid from public.personas persona where persona.id=p_persona_id
    union all select 'post',post.id::text,post.media_url,post.media_asset_id from public.posts post where post.persona_id=p_persona_id
    union all select 'album_item',item.id::text,item.thumb_url,item.media_asset_id
      from public.album_items item join public.albums album on album.id=item.album_id
      where album.persona_id=p_persona_id
    union all select 'affiliate_offer',offer.id::text,product.image_url,
      (select handle.asset_id from public.persona_public_media_handles handle
       where handle.public_id=public.public_media_handle_from_url(product.image_url)
         and handle.persona_id=p_persona_id and handle.owner=auth.uid()
         and handle.state='active' limit 1)
      from public.persona_affiliate_offers offer
      join public.affiliate_products product on product.id=offer.product_id
        and product.owner=offer.owner and product.status='active'
      where offer.persona_id=p_persona_id and offer.owner=auth.uid()
        and offer.status='active'
  ), inspected as (
    select reference.consumer,reference.slot,reference.url,reference.asset_id,
      public.public_media_handle_from_url(reference.url) public_id,
      asset.content_sha256,asset.provenance_sha256,asset.status asset_status,
      asset.declaration_source,asset.ai_use,asset.watermark_state,
      handle.state handle_state,
      public.is_persona_media_storage_reference_062(reference.url) storage_path,
      public.is_public_media_delivery_reference_062(reference.url) mentions_delivery
    from media_refs reference
    left join public.persona_media_assets asset on asset.id=reference.asset_id
      and asset.persona_id=p_persona_id and asset.owner=auth.uid()
    left join public.persona_public_media_handles handle
      on handle.public_id=public.public_media_handle_from_url(reference.url)
      and handle.asset_id=asset.id and handle.owner=asset.owner
      and handle.persona_id=asset.persona_id
    where coalesce(reference.url,'')<>''
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'consumer',consumer,'slot',slot,'asset_id',asset_id,'public_id',public_id,
      'content_sha256',coalesce(content_sha256,''),
      'provenance_sha256',coalesce(provenance_sha256,''),
      'delivery',case when public_id is not null then 'opaque_proxy'
        when storage_path then 'blocked_owner_path' else 'grandfathered_non_storage' end
    ) order by consumer,slot),'[]'::jsonb),
    count(*) filter(where storage_path
      or mentions_delivery and (
        public_id is null or asset_id is null
        or asset_status is distinct from 'active'
        or declaration_source is null or declaration_source='legacy'
        or handle_state is distinct from 'active'
        or url is distinct from public.public_media_delivery_url(public_id)
        or content_sha256 is null or content_sha256!~'^[0-9a-f]{64}$'
        or provenance_sha256 is null or provenance_sha256!~'^[0-9a-f]{64}$'
        or (ai_use='none' and watermark_state is distinct from 'not_required')
        or (ai_use is distinct from 'none' and watermark_state is distinct from 'system_applied')
      )
      or asset_id is not null and public_id is null
    ),
    count(*) filter(where public_id is not null and handle_state='active'),
    count(*) filter(where storage_path)
  into v_assets,v_invalid,v_opaque,v_storage_paths from inspected;

  v_base:=v_base||jsonb_build_object(
    'schema_version',greatest(coalesce((v_base->>'schema_version')::integer,1),3),
    'opaque_media',jsonb_build_object(
      'complete',v_invalid=0,'assets',coalesce(v_assets,'[]'::jsonb),
      'opaque_assets',v_opaque,'invalid_assets',v_invalid,
      'blocked_owner_storage_paths',v_storage_paths,
      'delivery','public-media-v1','cache_policy','no-store'
    )
  );
  if v_invalid>0 then
    v_base:=jsonb_set(v_base,'{complete}','false'::jsonb,true);
    v_base:=jsonb_set(v_base,'{truncation_reasons}',
      coalesce(v_base->'truncation_reasons','[]'::jsonb)
        ||jsonb_build_array('Public media must use an active opaque handle; owner-correlating Storage paths cannot be published'),true);
  end if;
  return v_base;
end;
$$;
revoke all on function public.persona_publication_review_manifest(uuid)
  from public,anon,authenticated;
grant execute on function public.persona_publication_review_manifest(uuid)
  to authenticated;

-- The Edge Function receives only an opaque id. This resolver returns a bounded
-- private Storage target only when the current row still matches the exact
-- reviewed consumer+slot+asset+provenance tuple of a current published page.
create or replace function public.resolve_public_media_service(p_public_id uuid)
returns table(
  bucket text,storage_path text,mime_type text,byte_size bigint,
  content_sha256 text
)
language plpgsql security definer stable set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_public_id is null then return; end if;
  if not exists(select 1 from public.public_media_release_controls_062 control
    where control.singleton and control.waf_confirmed) then return; end if;

  return query
  with candidate as (
    select handle.public_id,handle.asset_id,handle.owner,handle.persona_id,
      asset.storage_path,asset.mime_type,asset.byte_size,asset.content_sha256,
      asset.provenance_sha256
    from public.persona_public_media_handles handle
    join public.persona_media_assets asset on asset.id=handle.asset_id
      and asset.owner=handle.owner and asset.persona_id=handle.persona_id
    where handle.public_id=p_public_id and handle.state='active'
      and asset.status='active' and asset.declaration_source<>'legacy'
      and asset.byte_size between 1 and 15728640
      and asset.mime_type in ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')
      and asset.content_sha256~'^[0-9a-f]{64}$'
      and asset.provenance_sha256~'^[0-9a-f]{64}$'
      and (asset.ai_use='none' and asset.watermark_state='not_required'
        or asset.ai_use<>'none' and asset.watermark_state='system_applied')
  ), current_refs as (
    select 'profile'::text consumer,'avatar'::text slot,persona.avatar_url url,
      persona.avatar_media_asset_id asset_id,persona.id persona_id from public.personas persona
    union all select 'profile','banner',persona.banner_url,persona.banner_media_asset_id,persona.id from public.personas persona
    union all select 'profile','background',persona.bg_url,persona.bg_media_asset_id,persona.id from public.personas persona
    union all select 'profile','feed_header',persona.feed_img_url,persona.feed_media_asset_id,persona.id from public.personas persona
    union all select 'profile','music_external',persona.music_url,null::uuid,persona.id from public.personas persona
    union all select 'profile','live_external',persona.live_url,null::uuid,persona.id from public.personas persona
    union all select 'post',post.id::text,post.media_url,post.media_asset_id,post.persona_id from public.posts post
    union all select 'album_item',item.id::text,item.thumb_url,item.media_asset_id,album.persona_id
      from public.album_items item join public.albums album on album.id=item.album_id
    union all select 'affiliate_offer',offer.id::text,product.image_url,handle.asset_id,offer.persona_id
      from public.persona_affiliate_offers offer
      join public.affiliate_products product on product.id=offer.product_id
        and product.owner=offer.owner and product.status='active'
      join public.persona_public_media_handles handle
        on handle.public_id=public.public_media_handle_from_url(product.image_url)
        and handle.persona_id=offer.persona_id and handle.owner=offer.owner
        and handle.state='active'
      where offer.status='active'
  ), exact_reviewed as (
    select candidate.*
    from candidate
    join public.personas persona on persona.id=candidate.persona_id and persona.owner=candidate.owner
    join public.persona_publication_reviews review on review.persona_id=persona.id
      and review.owner=persona.owner and review.review_state='published'
      and review.reviewed_revision=persona.publication_revision
    join current_refs reference on reference.persona_id=persona.id
      and reference.asset_id=candidate.asset_id
      and reference.url=public.public_media_delivery_url(candidate.public_id)
    join lateral jsonb_array_elements(
      coalesce(review.readiness_snapshot->'review_manifest'->'opaque_media'->'assets','[]'::jsonb)
    ) reviewed(item) on reviewed.item->>'consumer'=reference.consumer
      and reviewed.item->>'slot'=reference.slot
      and reviewed.item->>'asset_id'=candidate.asset_id::text
      and reviewed.item->>'public_id'=candidate.public_id::text
      and reviewed.item->>'provenance_sha256'=candidate.provenance_sha256
    where persona.publication_state='published'
      and persona.visibility in ('public','unlisted')
      and not persona.nsfw
      and persona.published_revision=persona.publication_revision
      and public.persona_publication_is_current(persona.id)
  )
  select 'persona-media'::text,reviewed.storage_path,reviewed.mime_type,
    reviewed.byte_size,reviewed.content_sha256
  from exact_reviewed reviewed limit 1;
end;
$$;

revoke all on function public.resolve_public_media_service(uuid)
  from public,anon,authenticated;
grant execute on function public.resolve_public_media_service(uuid)
  to service_role;

-- Keep revenue image projection fail-closed during the transition. Raw
-- persona-media URLs are owner-correlating; an exact opaque URL or a normal
-- credential-free external image may pass through the legacy reviewed rail.
do $migration$
begin
  if to_regprocedure('public.get_public_persona_revenue_rails_legacy_062(text)') is null then
    alter function public.get_public_persona_revenue_rails(text)
      rename to get_public_persona_revenue_rails_legacy_062;
  end if;
end
$migration$;
revoke all on function public.get_public_persona_revenue_rails_legacy_062(text)
  from public,anon,authenticated;

create or replace function public.get_public_persona_revenue_rails(p_handle text)
returns table (
  persona_id uuid,affiliate_enabled boolean,review_requests_enabled boolean,
  default_disclosure text,cta_label text,review_cta_label text,offers jsonb
)
language sql security definer stable set search_path='' as $$
  select rail.persona_id,rail.affiliate_enabled,rail.review_requests_enabled,
    rail.default_disclosure,rail.cta_label,rail.review_cta_label,
    coalesce((
      select jsonb_agg((
        case when public.is_persona_media_storage_reference_062(item.value->>'image_url')
          or public.is_public_media_delivery_reference_062(item.value->>'image_url')
            and (
              public.public_media_handle_from_url(item.value->>'image_url') is null
              or not exists(
                select 1 from public.persona_public_media_handles handle
                join public.persona_media_assets asset on asset.id=handle.asset_id
                  and asset.owner=handle.owner and asset.persona_id=handle.persona_id
                join public.personas persona on persona.id=rail.persona_id
                  and persona.owner=handle.owner
                where handle.public_id=public.public_media_handle_from_url(item.value->>'image_url')
                  and handle.persona_id=rail.persona_id and handle.state='active'
                  and asset.status='active' and asset.declaration_source<>'legacy'
                  and item.value->>'image_url'=public.public_media_delivery_url(handle.public_id)
              )
            )
          then item.value||jsonb_build_object('image_url','')
          else item.value end
        )||jsonb_build_object('destination_safe',true)
        order by item.ordinality
      )
      from jsonb_array_elements(coalesce(rail.offers,'[]'::jsonb))
        with ordinality item(value,ordinality)
      where exists (
        select 1 from public.persona_affiliate_offers offer
        join public.affiliate_products product
          on product.id=offer.product_id and product.owner=offer.owner
        where offer.id::text=item.value->>'offer_id'
          and offer.persona_id=rail.persona_id and offer.status='active'
          and product.status='active'
          and public.is_external_reference_url_062(product.affiliate_url,false)
          and public.is_external_reference_url_062(product.product_url,true)
      )
    ),'[]'::jsonb)
  from public.get_public_persona_revenue_rails_legacy_062(p_handle) rail
$$;
revoke all on function public.get_public_persona_revenue_rails(text) from public;
grant execute on function public.get_public_persona_revenue_rails(text)
  to anon,authenticated;

-- Suppress every legacy affiliate destination that points back into project
-- Storage or either private media gateway. Public callers receive no row.
create or replace function public.get_public_affiliate_destination(p_offer_id uuid)
returns table(offer_id uuid,persona_id uuid,affiliate_url text)
language sql security definer stable set search_path='' as $$
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
    and public.is_external_reference_url_062(product.affiliate_url,false)
    and public.is_external_reference_url_062(product.product_url,true)
  limit 1
$$;
revoke all on function public.get_public_affiliate_destination(uuid) from public;
grant execute on function public.get_public_affiliate_destination(uuid)
  to anon,authenticated;

-- Preserve the bounded click/analytics implementation, but refuse unsafe
-- legacy destinations before invoking it. The public signature stays stable.
do $migration$
begin
  if to_regprocedure('public.resolve_affiliate_redirect_service_legacy_062(uuid,text,text,text,text,text,text,text)') is null
     and to_regprocedure('public.resolve_affiliate_redirect_service(uuid,text,text,text,text,text,text,text)') is not null then
    alter function public.resolve_affiliate_redirect_service(uuid,text,text,text,text,text,text,text)
      rename to resolve_affiliate_redirect_service_legacy_062;
  end if;
end
$migration$;
revoke all on function public.resolve_affiliate_redirect_service_legacy_062(
  uuid,text,text,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.resolve_affiliate_redirect_service_legacy_062(
  uuid,text,text,text,text,text,text,text
) to service_role;

create or replace function public.resolve_affiliate_redirect_service(
  p_offer_id uuid,p_source text,p_referrer_host text,
  p_utm_source text,p_utm_medium text,p_utm_campaign text,
  p_fingerprint_hash text,p_user_agent_hash text
)
returns table(affiliate_url text)
language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if not exists (
    select 1 from public.persona_affiliate_offers offer
    join public.affiliate_products product
      on product.id=offer.product_id and product.owner=offer.owner
    where offer.id=p_offer_id and offer.status='active' and product.status='active'
      and public.is_external_reference_url_062(product.affiliate_url,false)
      and public.is_external_reference_url_062(product.product_url,true)
  ) then return; end if;
  return query select resolved.affiliate_url
  from public.resolve_affiliate_redirect_service_legacy_062(
    p_offer_id,p_source,p_referrer_host,p_utm_source,p_utm_medium,
    p_utm_campaign,p_fingerprint_hash,p_user_agent_hash
  ) resolved
  where public.is_external_reference_url_062(resolved.affiliate_url,false);
end;
$$;
revoke all on function public.resolve_affiliate_redirect_service(
  uuid,text,text,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.resolve_affiliate_redirect_service(
  uuid,text,text,text,text,text,text,text
) to service_role;

-- Reuse the complete current persona visibility policy for an authenticated
-- viewer while keeping the Storage target inside service-only execution. The
-- caller identity is restored before return and the RPC transaction provides a
-- second containment boundary.
create or replace function public.persona_visible_to_account_service(
  p_persona_id uuid,p_viewer uuid
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_previous text;v_visible boolean:=false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_persona_id is null or p_viewer is null then return false; end if;
  v_previous:=coalesce(current_setting('request.jwt.claim.sub',true),'');
  perform set_config('request.jwt.claim.sub',p_viewer::text,true);
  v_visible:=public.persona_visible(p_persona_id);
  perform set_config('request.jwt.claim.sub',v_previous,true);
  return coalesce(v_visible,false);
exception when others then
  perform set_config('request.jwt.claim.sub',coalesce(v_previous,''),true);
  raise;
end;
$$;
revoke all on function public.persona_visible_to_account_service(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.persona_visible_to_account_service(uuid,uuid)
  to service_role;

-- Authenticated byte-preview resolver. Asset-id lookup is owner-only and keeps
-- drafts usable. Opaque-id lookup for another account requires the exact current
-- reviewed reference plus the complete viewer visibility policy. NSFW media is
-- owner-only until a server-verifiable adult access decision exists.
create or replace function public.resolve_authenticated_media_preview_service(
  p_viewer uuid,p_asset_id uuid default null,p_public_id uuid default null
)
returns table(
  bucket text,storage_path text,mime_type text,byte_size bigint,
  content_sha256 text
)
language plpgsql security definer set search_path='' as $$
declare v_asset_id uuid;v_owner uuid;v_persona_id uuid;v_nsfw boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_viewer is null or ((p_asset_id is null)=(p_public_id is null)) then return; end if;

  if p_asset_id is not null then
    return query select * from public.resolve_persona_media_asset_service(p_viewer,p_asset_id);
    return;
  end if;

  select asset.id,asset.owner,asset.persona_id,persona.nsfw
    into v_asset_id,v_owner,v_persona_id,v_nsfw
  from public.persona_public_media_handles handle
  join public.persona_media_assets asset on asset.id=handle.asset_id
    and asset.owner=handle.owner and asset.persona_id=handle.persona_id
  join public.personas persona on persona.id=asset.persona_id and persona.owner=asset.owner
  where handle.public_id=p_public_id and handle.state='active'
    and asset.status='active' and asset.declaration_source<>'legacy';
  if not found then return; end if;
  if v_owner=p_viewer then
    return query select * from public.resolve_persona_media_asset_service(p_viewer,v_asset_id);
    return;
  end if;
  if coalesce(v_nsfw,false)
     or not public.persona_visible_to_account_service(v_persona_id,p_viewer) then
    return;
  end if;

  return query
  with candidate as (
    select handle.public_id,handle.asset_id,handle.owner,handle.persona_id,
      asset.storage_path,asset.mime_type,asset.byte_size,asset.content_sha256,
      asset.provenance_sha256
    from public.persona_public_media_handles handle
    join public.persona_media_assets asset on asset.id=handle.asset_id
      and asset.owner=handle.owner and asset.persona_id=handle.persona_id
    where handle.public_id=p_public_id and handle.state='active'
      and asset.status='active' and asset.declaration_source<>'legacy'
      and asset.byte_size between 1 and 15728640
      and asset.mime_type in ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')
      and asset.content_sha256~'^[0-9a-f]{64}$'
      and asset.provenance_sha256~'^[0-9a-f]{64}$'
      and (asset.ai_use='none' and asset.watermark_state='not_required'
        or asset.ai_use<>'none' and asset.watermark_state='system_applied')
  ), current_refs as (
    select 'profile'::text consumer,'avatar'::text slot,persona.avatar_url url,
      persona.avatar_media_asset_id asset_id,persona.id persona_id from public.personas persona
    union all select 'profile','banner',persona.banner_url,persona.banner_media_asset_id,persona.id from public.personas persona
    union all select 'profile','background',persona.bg_url,persona.bg_media_asset_id,persona.id from public.personas persona
    union all select 'profile','feed_header',persona.feed_img_url,persona.feed_media_asset_id,persona.id from public.personas persona
    union all select 'profile','music_external',persona.music_url,null::uuid,persona.id from public.personas persona
    union all select 'profile','live_external',persona.live_url,null::uuid,persona.id from public.personas persona
    union all select 'post',post.id::text,post.media_url,post.media_asset_id,post.persona_id from public.posts post
    union all select 'album_item',item.id::text,item.thumb_url,item.media_asset_id,album.persona_id
      from public.album_items item join public.albums album on album.id=item.album_id
    union all select 'affiliate_offer',offer.id::text,product.image_url,handle.asset_id,offer.persona_id
      from public.persona_affiliate_offers offer
      join public.affiliate_products product on product.id=offer.product_id
        and product.owner=offer.owner and product.status='active'
      join public.persona_public_media_handles handle
        on handle.public_id=public.public_media_handle_from_url(product.image_url)
        and handle.persona_id=offer.persona_id and handle.owner=offer.owner
        and handle.state='active'
      where offer.status='active'
  )
  select 'persona-media'::text,candidate.storage_path,candidate.mime_type,
    candidate.byte_size,candidate.content_sha256
  from candidate
  join public.personas persona on persona.id=candidate.persona_id and persona.owner=candidate.owner
  join public.persona_publication_reviews review on review.persona_id=persona.id
    and review.owner=persona.owner and review.review_state='published'
    and review.reviewed_revision=persona.publication_revision
  join current_refs reference on reference.persona_id=persona.id
    and reference.asset_id=candidate.asset_id
    and reference.url=public.public_media_delivery_url(candidate.public_id)
  join lateral jsonb_array_elements(
    coalesce(review.readiness_snapshot->'review_manifest'->'opaque_media'->'assets','[]'::jsonb)
  ) reviewed(item) on reviewed.item->>'consumer'=reference.consumer
    and reviewed.item->>'slot'=reference.slot
    and reviewed.item->>'asset_id'=candidate.asset_id::text
    and reviewed.item->>'public_id'=candidate.public_id::text
    and reviewed.item->>'provenance_sha256'=candidate.provenance_sha256
  where persona.publication_state='published' and not persona.nsfw
    and persona.published_revision=persona.publication_revision
    and public.persona_publication_is_current(persona.id)
  limit 1;
end;
$$;
revoke all on function public.resolve_authenticated_media_preview_service(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.resolve_authenticated_media_preview_service(uuid,uuid,uuid)
  to service_role;

-- Service readiness never returns owner ids, persona ids, paths, or public ids.
create or replace function public.public_media_release_readiness_service()
returns jsonb language plpgsql security definer stable set search_path='' as $$
declare
  v_result jsonb;v_stale bigint;v_unresolved bigint;
  v_private_paths bigint;v_unbound_private bigint;v_blocked_products bigint;
  v_external_violations bigint;v_legacy_media_references bigint;
  v_storage_boundary boolean;v_waf_confirmed boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  select jsonb_build_object(
    'active_canonical_assets',count(*) filter(where public.persona_media_asset_canonical_eligible_062(asset)),
    'ineligible_active_assets',count(*) filter(where asset.status='active' and asset.declaration_source<>'legacy'
      and not public.persona_media_asset_canonical_eligible_062(asset)),
    'missing_active_handles',count(*) filter(where public.persona_media_asset_canonical_eligible_062(asset)
      and not exists(select 1 from public.persona_public_media_handles handle
        where handle.asset_id=asset.id and handle.state='active')),
    'owner_path_references',(
      select count(*) from (
        select avatar_url url from public.personas union all select banner_url from public.personas
        union all select bg_url from public.personas union all select feed_img_url from public.personas
        union all select music_url from public.personas union all select live_url from public.personas
        union all select media_url from public.posts union all select item.thumb_url
          from public.album_items item
      ) reference where public.is_persona_media_storage_reference_062(reference.url)
    ),
    'published_pages',(
      select count(*) from public.personas persona where persona.publication_state='published'
    )
  ) into v_result from public.persona_media_assets asset;

  select count(*) into v_stale from public.personas persona
  where persona.publication_state='published'
    and not public.persona_publication_is_current(persona.id);

  with published_refs as (
    select 'profile'::text consumer,'avatar'::text slot,persona.id persona_id,
      persona.avatar_url url,persona.avatar_media_asset_id asset_id from public.personas persona
    union all select 'profile','banner',persona.id,persona.banner_url,persona.banner_media_asset_id from public.personas persona
    union all select 'profile','background',persona.id,persona.bg_url,persona.bg_media_asset_id from public.personas persona
    union all select 'profile','feed_header',persona.id,persona.feed_img_url,persona.feed_media_asset_id from public.personas persona
    union all select 'profile','music_external',persona.id,persona.music_url,null::uuid from public.personas persona
    union all select 'profile','live_external',persona.id,persona.live_url,null::uuid from public.personas persona
    union all select 'post',post.id::text,post.persona_id,post.media_url,post.media_asset_id from public.posts post
    union all select 'album_item',item.id::text,album.persona_id,item.thumb_url,item.media_asset_id from public.album_items item
      join public.albums album on album.id=item.album_id
    union all select 'affiliate_offer',offer.id::text,offer.persona_id,product.image_url,
      (select handle.asset_id from public.persona_public_media_handles handle
       where handle.public_id=public.public_media_handle_from_url(product.image_url)
         and handle.owner=offer.owner and handle.persona_id=offer.persona_id
         and handle.state='active' limit 1)
      from public.persona_affiliate_offers offer
      join public.affiliate_products product on product.id=offer.product_id
        and product.owner=offer.owner and product.status='active'
      where offer.status='active'
  )
  select count(*) into v_unresolved
  from published_refs reference
  join public.personas persona on persona.id=reference.persona_id
  where persona.publication_state='published'
    and public.is_public_media_delivery_reference_062(reference.url)
    and (
      public.public_media_handle_from_url(reference.url) is null
      or reference.asset_id is null
      or not exists(
        select 1
        from public.persona_public_media_handles handle
        join public.persona_media_assets asset on asset.id=handle.asset_id
          and asset.owner=handle.owner and asset.persona_id=handle.persona_id
        join public.persona_publication_reviews review
          on review.persona_id=persona.id and review.owner=persona.owner
          and review.review_state='published'
          and review.reviewed_revision=persona.publication_revision
        join lateral jsonb_array_elements(
          coalesce(review.readiness_snapshot->'review_manifest'->'opaque_media'->'assets','[]'::jsonb)
        ) reviewed(item) on reviewed.item->>'consumer'=reference.consumer
          and reviewed.item->>'slot'=reference.slot
          and reviewed.item->>'asset_id'=reference.asset_id::text
          and reviewed.item->>'public_id'=handle.public_id::text
          and reviewed.item->>'provenance_sha256'=asset.provenance_sha256
        where handle.public_id=public.public_media_handle_from_url(reference.url)
          and handle.asset_id=reference.asset_id and handle.owner=persona.owner
          and handle.persona_id=persona.id and handle.state='active'
          and asset.status='active' and asset.declaration_source<>'legacy'
          and reference.url=public.public_media_delivery_url(handle.public_id)
          and persona.published_revision=persona.publication_revision
          and public.persona_publication_is_current(persona.id)
      )
      or persona.visibility in ('public','unlisted') and not persona.nsfw
        and not exists(select 1 from public.resolve_public_media_service(
          public.public_media_handle_from_url(reference.url)))
      or (persona.visibility not in ('public','unlisted') or persona.nsfw)
        and exists(select 1 from public.resolve_public_media_service(
          public.public_media_handle_from_url(reference.url)))
    );

  with private_refs as (
    select persona.owner,draft.persona_id,draft.media_url url,draft.media_asset_id asset_id
      from public.drafts draft join public.personas persona on persona.id=draft.persona_id
    union all select draft.owner,draft.persona_id,draft.source_image_url,draft.source_media_asset_id
      from public.post_drafts draft
    union all select draft.owner,draft.persona_id,draft.fb_image_url,draft.fb_media_asset_id
      from public.post_drafts draft
    union all select draft.owner,draft.persona_id,draft.ig_image_url,draft.ig_media_asset_id
      from public.post_drafts draft
    union all select draft.owner,draft.persona_id,draft.x_image_url,draft.x_media_asset_id
      from public.post_drafts draft
  )
  select count(*) filter(where public.is_persona_media_storage_reference_062(reference.url)),
    count(*) filter(where public.is_persona_media_storage_reference_062(reference.url)
      and not exists(select 1 from public.persona_media_assets asset
        where asset.id=reference.asset_id and asset.owner=reference.owner
          and asset.persona_id=reference.persona_id and asset.status<>'flagged'
          and asset.declaration_source<>'legacy'
          and public.persona_media_reference_matches_asset(
            reference.url,asset.public_url,asset.ai_use)))
  into v_private_paths,v_unbound_private from private_refs reference;

  -- Count every product row because the post-cutover write guard covers every
  -- product row, including dormant/unattached inventory that may later be
  -- edited or activated.
  select count(*) into v_blocked_products
  from public.affiliate_products product
  where public.is_persona_media_storage_reference_062(product.image_url);

  select count(*) into v_external_violations from (
    select persona.music_url url,true allow_empty from public.personas persona
    union all select persona.live_url,true from public.personas persona
    union all select link.url,true from public.persona_links link
    union all select item.link_url,true from public.album_items item
    union all select widget.value->>'url',false
      from public.persona_page_layouts page
      cross join lateral jsonb_array_elements(case
        when jsonb_typeof(coalesce(page.layout->'widgets','[]'::jsonb))='array'
        then coalesce(page.layout->'widgets','[]'::jsonb) else '[]'::jsonb end) widget(value)
      where widget.value->>'kind'='link'
    union all select product.affiliate_url,false from public.affiliate_products product
      where product.status='active'
    union all select product.product_url,true from public.affiliate_products product
      where product.status='active'
  ) reference
  where not public.is_external_reference_url_062(reference.url,reference.allow_empty);

  select count(*) into v_legacy_media_references from (
    select persona.avatar_url url from public.personas persona
    union all select persona.banner_url from public.personas persona
    union all select persona.bg_url from public.personas persona
    union all select persona.feed_img_url from public.personas persona
    union all select persona.music_url from public.personas persona
    union all select persona.live_url from public.personas persona
    union all select post.media_url from public.posts post
    union all select item.thumb_url from public.album_items item
    union all select draft.media_url from public.drafts draft
    union all select draft.source_image_url from public.post_drafts draft
    union all select draft.fb_image_url from public.post_drafts draft
    union all select draft.ig_image_url from public.post_drafts draft
    union all select draft.x_image_url from public.post_drafts draft
    union all select product.image_url from public.affiliate_products product
    union all select product.affiliate_url from public.affiliate_products product
    union all select product.product_url from public.affiliate_products product
    union all select link.url from public.persona_links link
    union all select item.link_url from public.album_items item
    union all select widget.value->>'url' from public.persona_page_layouts page
      cross join lateral jsonb_array_elements(case
        when jsonb_typeof(coalesce(page.layout->'widgets','[]'::jsonb))='array'
        then coalesce(page.layout->'widgets','[]'::jsonb) else '[]'::jsonb end) widget(value)
      where widget.value->>'kind'='link'
  ) reference
  where public.is_legacy_media_bucket_reference_062(reference.url);

  select exists(select 1 from pg_catalog.pg_policies policy
      where policy.schemaname='storage' and policy.tablename='objects'
        and policy.policyname='persona media opaque read boundary'
        and policy.permissive='RESTRICTIVE' and policy.cmd='SELECT'
        and policy.roles='{public}'::name[]
        and policy.qual~'bucket_id.*<>.*persona-media'
        and policy.qual~'auth[.]role.*service_role'
        and policy.qual~'split_part.*auth[.]uid')
    and exists(select 1 from pg_catalog.pg_policies policy
      where policy.schemaname='storage' and policy.tablename='objects'
        and policy.policyname='persona media owner select'
        and policy.permissive='PERMISSIVE' and policy.cmd='SELECT'
        and policy.roles='{authenticated}'::name[]
        and policy.qual~'bucket_id.*persona-media'
        and policy.qual~'split_part.*auth[.]uid')
  into v_storage_boundary;
  select coalesce((select control.waf_confirmed
    from public.public_media_release_controls_062 control where control.singleton),false)
  into v_waf_confirmed;

  return v_result||jsonb_build_object(
    'stale_published_pages',v_stale,
    'unresolved_published_media_references',v_unresolved,
    'private_owner_path_references',v_private_paths,
    'unbound_private_owner_path_references',v_unbound_private,
    'blocked_affiliate_owner_path_references',v_blocked_products,
    'blocked_external_reference_violations',v_external_violations,
    'legacy_media_bucket_references',v_legacy_media_references,
    'storage_read_boundary',coalesce(v_storage_boundary,false),
    'waf_confirmed',coalesce(v_waf_confirmed,false),
    'bucket_private',coalesce((select not bucket.public from storage.buckets bucket
      where bucket.id='persona-media'),false),
    'ready',coalesce((v_result->>'missing_active_handles')::integer,0)=0
      and coalesce((v_result->>'ineligible_active_assets')::integer,0)=0
      and coalesce((v_result->>'owner_path_references')::integer,0)=0
      and v_stale=0 and v_unresolved=0 and v_private_paths=0 and v_unbound_private=0
      and v_blocked_products=0 and v_external_violations=0
      and v_legacy_media_references=0 and coalesce(v_storage_boundary,false)
      and coalesce(v_waf_confirmed,false)
      and coalesce((select not bucket.public from storage.buckets bucket
        where bucket.id='persona-media'),false),
    'rich_media_widgets_enabled',false
  );
end;
$$;
revoke all on function public.public_media_release_readiness_service()
  from public,anon,authenticated;
grant execute on function public.public_media_release_readiness_service()
  to service_role;

-- Final cutover removes direct access to every historical owner-path object.
-- It is deliberately a separate service-only action because doing this before
-- every reference is rebound would break currently grandfathered pages. There
-- is no browser callable rollback that can make the bucket public again.
create or replace function public.finalize_opaque_public_media_bucket_service()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_check jsonb;v_changed integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  lock table public.persona_media_assets in share row exclusive mode;
  lock table public.persona_public_media_handles in share row exclusive mode;
  lock table public.personas in share row exclusive mode;
  lock table public.persona_links in share row exclusive mode;
  lock table public.persona_page_layouts in share row exclusive mode;
  lock table public.posts in share row exclusive mode;
  lock table public.albums in share row exclusive mode;
  lock table public.album_items in share row exclusive mode;
  lock table public.drafts in share row exclusive mode;
  lock table public.post_drafts in share row exclusive mode;
  lock table public.affiliate_products in share row exclusive mode;
  lock table public.persona_affiliate_offers in share row exclusive mode;
  lock table public.persona_publication_reviews in share row exclusive mode;
  lock table storage.buckets in share row exclusive mode;
  v_check:=public.public_media_release_readiness_service();
  if coalesce((v_check->>'ineligible_active_assets')::bigint,0)<>0
     or coalesce((v_check->>'missing_active_handles')::bigint,0)<>0
     or coalesce((v_check->>'owner_path_references')::bigint,0)<>0
     or coalesce((v_check->>'stale_published_pages')::bigint,0)<>0
     or coalesce((v_check->>'unresolved_published_media_references')::bigint,0)<>0
     or coalesce((v_check->>'private_owner_path_references')::bigint,0)<>0
     or coalesce((v_check->>'unbound_private_owner_path_references')::bigint,0)<>0
     or coalesce((v_check->>'blocked_affiliate_owner_path_references')::bigint,0)<>0
     or coalesce((v_check->>'blocked_external_reference_violations')::bigint,0)<>0
     or coalesce((v_check->>'legacy_media_bucket_references')::bigint,0)<>0
     or coalesce((v_check->>'storage_read_boundary')::boolean,false) is not true
     or coalesce((v_check->>'waf_confirmed')::boolean,false) is not true then
    raise exception 'Opaque media finalization blocked by readiness contract: %',v_check;
  end if;
  update storage.buckets bucket set public=false
  where bucket.id='persona-media' and bucket.public;
  get diagnostics v_changed=row_count;
  if not exists(select 1 from storage.buckets bucket
    where bucket.id='persona-media' and not bucket.public) then
    raise exception 'persona-media bucket was not found or could not be made private';
  end if;
  v_check:=public.public_media_release_readiness_service();
  return jsonb_build_object(
    'bucket','persona-media','private',true,'changed',v_changed=1,
    'readiness',v_check,'rich_media_widgets_enabled',false
  );
end;
$$;
revoke all on function public.finalize_opaque_public_media_bucket_service()
  from public,anon,authenticated;
grant execute on function public.finalize_opaque_public_media_bucket_service()
  to service_role;

commit;
