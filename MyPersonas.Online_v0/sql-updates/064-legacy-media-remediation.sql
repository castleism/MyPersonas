-- 064-legacy-media-remediation.sql
-- Owner-scoped, AAL2-gated inventory foundation for the retired public
-- `media` bucket. This migration deliberately stops before declaration,
-- import, reference rewrite, bucket-policy changes, or finalization.

begin;

-- Historical browser writers used this one exact project Storage origin and
-- placed the authenticated owner UUID in the first path segment. Only the
-- unencoded, query-free public-object spelling is safe for automatic intake.
create or replace function public.legacy_media_storage_path_safe_064(
  p_path text,p_owner uuid
)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_segment text;
begin
  if p_owner is null or coalesce(p_path,'')='' or char_length(p_path)>1024
     or p_path~'[[:cntrl:][:space:]%?#<>]' or position(chr(92) in p_path)>0
     or p_path!~('^'||lower(p_owner::text)||
       '/[A-Za-z0-9_][A-Za-z0-9._-]{0,254}'||
       '(/[A-Za-z0-9_][A-Za-z0-9._-]{0,254}){0,7}$') then
    return false;
  end if;
  foreach v_segment in array string_to_array(p_path,'/') loop
    if v_segment in ('.','..') then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function public.legacy_media_exact_path_064(p_url text)
returns text language plpgsql immutable set search_path='' as $$
declare
  v_prefix constant text:=
    'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/';
  v_path text;v_owner uuid;
begin
  if coalesce(p_url,'')='' or char_length(p_url)>2048
     or left(p_url,char_length(v_prefix))<>v_prefix then
    return null;
  end if;
  v_path:=substr(p_url,char_length(v_prefix)+1);
  if v_path!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then
    return null;
  end if;
  begin v_owner:=split_part(v_path,'/',1)::uuid;
  exception when invalid_text_representation then return null;
  end;
  if not public.legacy_media_storage_path_safe_064(v_path,v_owner) then
    return null;
  end if;
  return v_path;
end;
$$;

revoke all on function public.legacy_media_storage_path_safe_064(text,uuid),
  public.legacy_media_exact_path_064(text)
  from public,anon,authenticated,service_role;
grant execute on function public.legacy_media_storage_path_safe_064(text,uuid),
  public.legacy_media_exact_path_064(text)
  to service_role;

create unique index if not exists personas_id_owner_idx
  on public.personas(id,owner);

create table if not exists public.legacy_media_sources (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null references public.profiles(id) on delete cascade,
  bucket              text not null default 'media' check(bucket='media'),
  storage_path        text not null check(char_length(storage_path) between 38 and 1024),
  storage_path_sha256 text not null check(storage_path_sha256~'^[0-9a-f]{64}$'),
  object_id           uuid,
  object_updated_at   timestamptz,
  storage_byte_size   bigint not null default 0
    check(storage_byte_size between 0 and 999999999999999999),
  state               text not null default 'missing'
    check(state in ('available','missing','erased')),
  source_sha256       text not null default ''
    check(source_sha256='' or source_sha256~'^[0-9a-f]{64}$'),
  detected_mime       text not null default ''
    check(detected_mime in ('','image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm')),
  preview_byte_size   bigint not null default 0
    check(preview_byte_size between 0 and 15728640),
  previewed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  unique(owner,storage_path_sha256),
  unique(id,owner),
  check(public.legacy_media_storage_path_safe_064(storage_path,owner)),
  check(storage_path_sha256=encode(extensions.digest(
    convert_to(storage_path,'UTF8'),'sha256'),'hex')),
  check(
    (previewed_at is null and source_sha256='' and detected_mime='' and preview_byte_size=0)
    or
    (previewed_at is not null and source_sha256~'^[0-9a-f]{64}$'
      and detected_mime<>'' and preview_byte_size between 1 and 15728640)
  )
);

create index if not exists legacy_media_sources_owner_state_idx
  on public.legacy_media_sources(owner,state,id);

create table if not exists public.legacy_media_references (
  id                  uuid primary key default gen_random_uuid(),
  source_id           uuid,
  owner               uuid not null references public.profiles(id) on delete cascade,
  persona_id          uuid,
  consumer            text not null
    check(consumer in ('persona','post','album_item','draft','post_draft','affiliate_product')),
  row_id              uuid not null,
  slot                text not null
    check(slot in ('avatar','banner','background','feed_header','media','thumbnail',
      'source','facebook','instagram','x','image')),
  purpose             text not null
    check(purpose~'^[a-z0-9_-]{1,64}(/[a-z0-9_-]{1,64}){0,5}$'),
  rendition           text not null default 'original'
    check(rendition in ('original','facebook','instagram','x')),
  legacy_url          text not null check(char_length(legacy_url) between 1 and 2048),
  legacy_url_sha256   text not null check(legacy_url_sha256~'^[0-9a-f]{64}$'),
  state               text not null default 'pending'
    check(state in ('pending','blocked_cross_owner','blocked_persona',
      'blocked_shared_product','stale','erased')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  foreign key(persona_id,owner)
    references public.personas(id,owner) on delete cascade,
  foreign key(source_id,owner)
    references public.legacy_media_sources(id,owner) on delete cascade,
  unique(owner,consumer,row_id,slot),
  check(public.legacy_media_exact_path_064(legacy_url) is not null),
  check(legacy_url_sha256=encode(extensions.digest(
    convert_to(legacy_url,'UTF8'),'sha256'),'hex')),
  check(
    (state='blocked_cross_owner' and source_id is null)
    or (state in ('pending','blocked_persona','blocked_shared_product')
      and source_id is not null)
    or state in ('stale','erased')
  ),
  check(
    (consumer='persona' and slot in ('avatar','banner','background','feed_header'))
    or (consumer in ('post','draft') and slot='media')
    or (consumer='album_item' and slot='thumbnail')
    or (consumer='post_draft' and slot in ('source','facebook','instagram','x'))
    or (consumer='affiliate_product' and slot='image')
  )
);

create index if not exists legacy_media_references_owner_state_idx
  on public.legacy_media_references(owner,state,id);
create index if not exists legacy_media_references_source_idx
  on public.legacy_media_references(source_id,id) where source_id is not null;

-- A compact retained per-owner minute counter protects all three Edge actions.
-- The table is not owner-readable: callers receive only a generic 429.
create table if not exists public.legacy_media_remediation_rate_limits_064 (
  owner          uuid not null references public.profiles(id) on delete cascade,
  scope          text not null check(scope in ('all','inventory','list','preview')),
  window_started timestamptz not null,
  request_count  integer not null check(request_count between 1 and 100000),
  primary key(owner,scope)
);

alter table public.legacy_media_sources enable row level security;
alter table public.legacy_media_references enable row level security;
alter table public.legacy_media_remediation_rate_limits_064 enable row level security;

revoke all on public.legacy_media_sources,
  public.legacy_media_references,
  public.legacy_media_remediation_rate_limits_064
  from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.legacy_media_sources,
  public.legacy_media_references,
  public.legacy_media_remediation_rate_limits_064
  to service_role;

comment on table public.legacy_media_sources is
  'Service-only exact legacy media objects. Raw paths and integrity hashes are never projected to browsers.';
comment on table public.legacy_media_references is
  'Service-only owner content references to exact legacy objects. Browser callers receive only a safe RPC projection.';

create or replace function public.consume_legacy_media_remediation_rate_service(
  p_owner uuid,p_action text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  v_now timestamptz:=clock_timestamp();v_scope text;v_limit integer;v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null or p_action not in ('inventory','list','preview')
     or not exists(select 1 from public.profiles profile where profile.id=p_owner) then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'legacy-media-rate'||E'\u001f'||p_owner::text,64064064));
  foreach v_scope in array array['all',p_action] loop
    v_limit:=case v_scope when 'all' then 90 when 'inventory' then 10
      when 'list' then 60 else 30 end;
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

-- Internal raw candidate enumeration. It is still service-role checked and is
-- never granted to browser roles. `blocking_reason` is bounded and contains no
-- identity data.
create or replace function public.legacy_media_candidates_service_064(p_owner uuid)
returns table(
  owner uuid,persona_id uuid,consumer text,row_id uuid,slot text,url text,
  purpose text,rendition text,blocking_reason text
)
language plpgsql security definer stable set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  return query
  with candidate as (
    select persona.owner,persona.id persona_id,'persona'::text consumer,
      persona.id row_id,'avatar'::text slot,persona.avatar_url url,
      'profile/avatar'::text purpose,'original'::text rendition,''::text blocking_reason
    from public.personas persona where persona.owner=p_owner
    union all select persona.owner,persona.id,'persona',persona.id,'banner',
      persona.banner_url,'profile/banner','original',''
      from public.personas persona where persona.owner=p_owner
    union all select persona.owner,persona.id,'persona',persona.id,'background',
      persona.bg_url,'profile/background','original',''
      from public.personas persona where persona.owner=p_owner
    union all select persona.owner,persona.id,'persona',persona.id,'feed_header',
      persona.feed_img_url,'profile/feed_header','original',''
      from public.personas persona where persona.owner=p_owner
    union all select persona.owner,persona.id,'post',post.id,'media',post.media_url,
      'post/media','original',''
      from public.posts post join public.personas persona on persona.id=post.persona_id
      where persona.owner=p_owner
    union all select persona.owner,persona.id,'album_item',item.id,'thumbnail',item.thumb_url,
      'album/thumbnail','original',''
      from public.album_items item join public.albums album on album.id=item.album_id
      join public.personas persona on persona.id=album.persona_id
      where persona.owner=p_owner
    union all select draft.owner,persona.id,'draft',draft.id,'media',draft.media_url,
      'draft/media','original',case when persona.id is null then 'persona_required' else '' end
      from public.drafts draft
      left join public.personas persona on persona.id=draft.persona_id and persona.owner=draft.owner
      where draft.owner=p_owner
    union all select draft.owner,persona.id,'post_draft',draft.id,'source',draft.source_image_url,
      'social/source','original',case when persona.id is null then 'persona_required' else '' end
      from public.post_drafts draft left join public.personas persona
        on persona.id=draft.persona_id and persona.owner=draft.owner
      where draft.owner=p_owner
    union all select draft.owner,persona.id,'post_draft',draft.id,'facebook',draft.fb_image_url,
      'social/facebook','facebook',case when persona.id is null then 'persona_required' else '' end
      from public.post_drafts draft left join public.personas persona
        on persona.id=draft.persona_id and persona.owner=draft.owner
      where draft.owner=p_owner
    union all select draft.owner,persona.id,'post_draft',draft.id,'instagram',draft.ig_image_url,
      'social/instagram','instagram',case when persona.id is null then 'persona_required' else '' end
      from public.post_drafts draft left join public.personas persona
        on persona.id=draft.persona_id and persona.owner=draft.owner
      where draft.owner=p_owner
    union all select draft.owner,persona.id,'post_draft',draft.id,'x',draft.x_image_url,
      'social/x','x',case when persona.id is null then 'persona_required' else '' end
      from public.post_drafts draft left join public.personas persona
        on persona.id=draft.persona_id and persona.owner=draft.owner
      where draft.owner=p_owner
    union all
    select product.owner,
      case when binding.binding_count=1 then binding.persona_id else null end,
      'affiliate_product',product.id,'image',product.image_url,
      'affiliate/product','original',case
        when binding.binding_count=0 then 'persona_required'
        when binding.binding_count>1 then 'shared_product'
        else '' end
    from public.affiliate_products product
    cross join lateral (
      select count(distinct offer.persona_id)::integer binding_count,
        (array_agg(distinct offer.persona_id order by offer.persona_id))[1] persona_id
      from public.persona_affiliate_offers offer
      join public.personas persona on persona.id=offer.persona_id
        and persona.owner=offer.owner
      where offer.product_id=product.id and offer.owner=product.owner
        and offer.status='active'
    ) binding
    where product.owner=p_owner
  )
  select candidate.owner,candidate.persona_id,candidate.consumer,candidate.row_id,
    candidate.slot,candidate.url,candidate.purpose,candidate.rendition,
    candidate.blocking_reason
  from candidate
  where public.legacy_media_exact_path_064(candidate.url) is not null;
end;
$$;

create or replace function public.inventory_legacy_media_references_service(
  p_owner uuid,p_limit integer default 250
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_started timestamptz:=clock_timestamp();v_total integer;v_candidate record;
  v_path text;v_path_owner uuid;v_path_hash text;v_url_hash text;v_source_id uuid;
  v_object_id uuid;v_object_updated timestamptz;v_object_size bigint;v_state text;
  v_current integer;v_previewable integer;v_blocked integer;v_missing integer;v_stale integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null or p_limit not between 1 and 500
     or not exists(select 1 from public.profiles profile where profile.id=p_owner) then
    raise exception 'Invalid owner inventory request';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'legacy-media-inventory'||E'\u001f'||p_owner::text,64064064));
  select count(*) into v_total
  from public.legacy_media_candidates_service_064(p_owner);
  if v_total>p_limit then
    raise exception 'Legacy media inventory limit is too low';
  end if;

  for v_candidate in
    select * from public.legacy_media_candidates_service_064(p_owner)
    order by consumer,row_id,slot
  loop
    v_path:=public.legacy_media_exact_path_064(v_candidate.url);
    v_path_owner:=split_part(v_path,'/',1)::uuid;
    v_path_hash:=encode(extensions.digest(convert_to(v_path,'UTF8'),'sha256'),'hex');
    v_url_hash:=encode(extensions.digest(convert_to(v_candidate.url,'UTF8'),'sha256'),'hex');
    v_source_id:=null;v_object_id:=null;v_object_updated:=null;v_object_size:=0;

    if v_path_owner=p_owner then
      select object.id,object.updated_at,
        case when coalesce(object.metadata->>'size','')~'^[0-9]{1,18}$'
          then (object.metadata->>'size')::bigint else 0 end
      into v_object_id,v_object_updated,v_object_size
      from storage.objects object
      where object.bucket_id='media' and object.name=v_path
      order by object.id limit 1;

      insert into public.legacy_media_sources as source(
        owner,bucket,storage_path,storage_path_sha256,object_id,
        object_updated_at,storage_byte_size,state,last_seen_at,updated_at
      ) values(
        p_owner,'media',v_path,v_path_hash,v_object_id,v_object_updated,
        coalesce(v_object_size,0),case when v_object_id is null then 'missing' else 'available' end,
        v_started,v_started
      )
      on conflict(owner,storage_path_sha256) do update set
        object_id=excluded.object_id,
        object_updated_at=excluded.object_updated_at,
        storage_byte_size=excluded.storage_byte_size,
        state=excluded.state,
        source_sha256=case when source.object_id is not distinct from excluded.object_id
          and source.object_updated_at is not distinct from excluded.object_updated_at
          then source.source_sha256 else '' end,
        detected_mime=case when source.object_id is not distinct from excluded.object_id
          and source.object_updated_at is not distinct from excluded.object_updated_at
          then source.detected_mime else '' end,
        preview_byte_size=case when source.object_id is not distinct from excluded.object_id
          and source.object_updated_at is not distinct from excluded.object_updated_at
          then source.preview_byte_size else 0 end,
        previewed_at=case when source.object_id is not distinct from excluded.object_id
          and source.object_updated_at is not distinct from excluded.object_updated_at
          then source.previewed_at else null end,
        last_seen_at=v_started,updated_at=v_started
      where source.storage_path=excluded.storage_path
      returning id into v_source_id;
      if v_source_id is null then
        raise exception 'Legacy media inventory integrity conflict';
      end if;
    end if;

    v_state:=case
      when v_path_owner<>p_owner then 'blocked_cross_owner'
      when v_candidate.blocking_reason='persona_required' then 'blocked_persona'
      when v_candidate.blocking_reason='shared_product' then 'blocked_shared_product'
      else 'pending' end;
    insert into public.legacy_media_references as reference(
      source_id,owner,persona_id,consumer,row_id,slot,purpose,rendition,
      legacy_url,legacy_url_sha256,state,last_seen_at,updated_at
    ) values(
      v_source_id,p_owner,v_candidate.persona_id,v_candidate.consumer,
      v_candidate.row_id,v_candidate.slot,v_candidate.purpose,v_candidate.rendition,
      v_candidate.url,v_url_hash,v_state,v_started,v_started
    )
    on conflict(owner,consumer,row_id,slot) do update set
      source_id=excluded.source_id,persona_id=excluded.persona_id,
      purpose=excluded.purpose,rendition=excluded.rendition,
      legacy_url=excluded.legacy_url,legacy_url_sha256=excluded.legacy_url_sha256,
      state=excluded.state,last_seen_at=v_started,updated_at=v_started;
  end loop;

  update public.legacy_media_references reference
  set state='stale',updated_at=v_started
  where reference.owner=p_owner and reference.last_seen_at<v_started
    and reference.state<>'stale';

  select count(*),
    count(*) filter(where reference.state<>'stale'),
    count(*) filter(where reference.state in ('pending','blocked_persona','blocked_shared_product')
      and source.state='available'),
    count(*) filter(where reference.state like 'blocked_%'),
    count(*) filter(where reference.state<>'stale' and source.state='missing'),
    count(*) filter(where reference.state='stale')
  into v_total,v_current,v_previewable,v_blocked,v_missing,v_stale
  from public.legacy_media_references reference
  left join public.legacy_media_sources source
    on source.id=reference.source_id and source.owner=reference.owner
  where reference.owner=p_owner and reference.state<>'erased';

  return jsonb_build_object(
    'references',coalesce(v_current,0),'previewable',coalesce(v_previewable,0),
    'blocked',coalesce(v_blocked,0),'missing',coalesce(v_missing,0),
    'stale',coalesce(v_stale,0),'limit',p_limit
  );
end;
$$;

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
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null or p_limit not between 1 and 100 then
    raise exception 'Invalid legacy media list request';
  end if;
  if p_after is not null and not exists(select 1
    from public.legacy_media_references reference
    where reference.id=p_after and reference.owner=p_owner) then
    return;
  end if;
  return query
  select reference.id,source.id,reference.persona_id,
    left(coalesce(persona.name,''),160),coalesce(persona.handle,''),
    reference.consumer,reference.slot,reference.purpose,reference.rendition,
    case when reference.state='pending' and source.state='missing' then 'missing'
      else reference.state end,
    source.id is not null and source.state='available'
      and reference.state in ('pending','blocked_persona','blocked_shared_product'),
    source.previewed_at is not null,coalesce(source.detected_mime,''),
    coalesce(source.preview_byte_size,0),
    case when source.id is null then 1 else (
      select count(*) from public.legacy_media_references sibling
      where sibling.owner=p_owner and sibling.source_id=source.id
        and sibling.state<>'stale' and sibling.state<>'erased'
    ) end
  from public.legacy_media_references reference
  left join public.legacy_media_sources source
    on source.id=reference.source_id and source.owner=reference.owner
  left join public.personas persona
    on persona.id=reference.persona_id and persona.owner=reference.owner
  where reference.owner=p_owner and reference.state<>'erased'
    and (p_after is null or reference.id>p_after)
  order by reference.id
  limit p_limit;
end;
$$;

-- Internal resolution returns a raw path only to the Edge service. It requires
-- a still-current exact DB reference and an object owned by the same account.
create or replace function public.resolve_legacy_media_preview_service(
  p_owner uuid,p_item_id uuid
)
returns table(
  bucket text,storage_path text,object_id uuid,object_updated_at timestamptz,
  expected_byte_size bigint
)
language plpgsql security definer stable set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  return query
  select 'media'::text,source.storage_path,object.id,object.updated_at,
    case when coalesce(object.metadata->>'size','')~'^[0-9]{1,18}$'
      then (object.metadata->>'size')::bigint else 0 end
  from public.legacy_media_references reference
  join public.legacy_media_sources source
    on source.id=reference.source_id and source.owner=reference.owner
  join storage.objects object
    on object.bucket_id='media' and object.name=source.storage_path
  join public.legacy_media_candidates_service_064(p_owner) current_reference
    on current_reference.consumer=reference.consumer
      and current_reference.row_id=reference.row_id
      and current_reference.slot=reference.slot
      and current_reference.url=reference.legacy_url
  where reference.id=p_item_id and reference.owner=p_owner
    and reference.state in ('pending','blocked_persona','blocked_shared_product')
    and source.owner=p_owner
    and public.legacy_media_storage_path_safe_064(source.storage_path,p_owner)
  order by object.id limit 1;
end;
$$;

create or replace function public.record_legacy_media_preview_service(
  p_owner uuid,p_item_id uuid,p_object_id uuid,p_object_updated_at timestamptz,
  p_source_sha256 text,p_byte_size bigint,p_detected_mime text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_source_sha256!~'^[0-9a-f]{64}$' or p_byte_size not between 1 and 15728640
     or p_detected_mime not in ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm') then
    return false;
  end if;
  update public.legacy_media_sources source set
    object_id=p_object_id,object_updated_at=p_object_updated_at,
    storage_byte_size=p_byte_size,source_sha256=p_source_sha256,
    detected_mime=p_detected_mime,preview_byte_size=p_byte_size,
    previewed_at=clock_timestamp(),state='available',updated_at=clock_timestamp()
  from public.legacy_media_references reference,storage.objects object
  where reference.id=p_item_id and reference.owner=p_owner
    and reference.source_id=source.id and source.owner=p_owner
    and reference.state in ('pending','blocked_persona','blocked_shared_product')
    and object.id=p_object_id and object.bucket_id='media'
    and object.name=source.storage_path
    and object.updated_at is not distinct from p_object_updated_at
    and exists(select 1
      from public.legacy_media_candidates_service_064(p_owner) current_reference
      where current_reference.consumer=reference.consumer
        and current_reference.row_id=reference.row_id
        and current_reference.slot=reference.slot
        and current_reference.url=reference.legacy_url);
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;

revoke all on function public.consume_legacy_media_remediation_rate_service(uuid,text),
  public.legacy_media_candidates_service_064(uuid),
  public.inventory_legacy_media_references_service(uuid,integer),
  public.list_legacy_media_references_service(uuid,uuid,integer),
  public.resolve_legacy_media_preview_service(uuid,uuid),
  public.record_legacy_media_preview_service(uuid,uuid,uuid,timestamptz,text,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.consume_legacy_media_remediation_rate_service(uuid,text),
  public.legacy_media_candidates_service_064(uuid),
  public.inventory_legacy_media_references_service(uuid,integer),
  public.list_legacy_media_references_service(uuid,uuid,integer),
  public.resolve_legacy_media_preview_service(uuid,uuid),
  public.record_legacy_media_preview_service(uuid,uuid,uuid,timestamptz,text,bigint,text)
  to service_role;

commit;
