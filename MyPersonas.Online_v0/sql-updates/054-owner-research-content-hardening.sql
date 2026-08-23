-- 054-owner-research-content-hardening.sql
-- Bounded owner drafting and server-authored approval/provenance for the
-- research and four-channel content surfaces introduced by 044/045.
--
-- This migration does not publish, call a provider, or enable a schedule.
-- Browser clients retain owner-scoped reads but write only through the narrow
-- RPCs below. Provider receipt fields remain service-only.

begin;

-- Durable counters prevent delete/recreate churn from bypassing daily and
-- lifetime creation limits. The row is private implementation state.
create table if not exists public.owner_research_content_usage (
  owner uuid primary key references public.profiles(id) on delete cascade,
  window_day date not null default ((now() at time zone 'UTC')::date),
  briefs_created_today integer not null default 0 check (briefs_created_today >= 0),
  briefs_created_lifetime bigint not null default 0 check (briefs_created_lifetime >= 0),
  topics_created_today integer not null default 0 check (topics_created_today >= 0),
  topics_created_lifetime bigint not null default 0 check (topics_created_lifetime >= 0),
  plans_created_today integer not null default 0 check (plans_created_today >= 0),
  plans_created_lifetime bigint not null default 0 check (plans_created_lifetime >= 0),
  annotations_created_today integer not null default 0 check (annotations_created_today >= 0),
  annotations_created_lifetime bigint not null default 0 check (annotations_created_lifetime >= 0),
  packages_created_today integer not null default 0 check (packages_created_today >= 0),
  packages_created_lifetime bigint not null default 0 check (packages_created_lifetime >= 0),
  owner_activity_created_today integer not null default 0 check (owner_activity_created_today >= 0),
  owner_activity_created_lifetime bigint not null default 0 check (owner_activity_created_lifetime >= 0),
  updated_at timestamptz not null default now()
);
alter table public.owner_research_content_usage enable row level security;
revoke all on public.owner_research_content_usage from public,anon,authenticated,service_role;

-- Backfill retained rows once. Reapplying 054 never resets a durable counter.
insert into public.owner_research_content_usage (
  owner,window_day,
  briefs_created_today,briefs_created_lifetime,
  topics_created_today,topics_created_lifetime,
  plans_created_today,plans_created_lifetime,
  annotations_created_today,annotations_created_lifetime,
  packages_created_today,packages_created_lifetime,
  owner_activity_created_today,owner_activity_created_lifetime
)
select owners.owner,(now() at time zone 'UTC')::date,
  (select count(*) from public.persona_research_briefs row
    where row.owner=owners.owner and row.created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
  (select count(*) from public.persona_research_briefs row where row.owner=owners.owner),
  (select count(*) from public.persona_research_topics row
    where row.owner=owners.owner and row.created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
  (select count(*) from public.persona_research_topics row where row.owner=owners.owner),
  (select count(*) from public.persona_topic_post_plans row
    where row.owner=owners.owner and row.created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
  (select count(*) from public.persona_topic_post_plans row where row.owner=owners.owner),
  (select count(*) from public.research_brief_annotations row
    where row.owner=owners.owner and row.created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
  (select count(*) from public.research_brief_annotations row where row.owner=owners.owner),
  (select count(*) from public.persona_content_packages row
    where row.owner=owners.owner and row.created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
  (select count(*) from public.persona_content_packages row where row.owner=owners.owner),
  (select count(*) from public.persona_activity_events row
    where row.owner=owners.owner and row.event_type in ('portal_opened','ai_workroom_opened','manual_post_confirmed')
      and row.created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
  (select count(*) from public.persona_activity_events row
    where row.owner=owners.owner and row.event_type in ('portal_opened','ai_workroom_opened','manual_post_confirmed'))
from (
  select owner from public.persona_research_briefs
  union select owner from public.persona_research_topics
  union select owner from public.persona_topic_post_plans
  union select owner from public.research_brief_annotations
  union select owner from public.persona_content_packages
  union select owner from public.persona_activity_events
) owners
where owners.owner is not null
on conflict(owner) do nothing;

-- Quota probes and owner timeline reads use deterministic keyset indexes.
create index if not exists research_briefs_owner_created_quota_idx
  on public.persona_research_briefs(owner,created_at desc,id);
create index if not exists research_topics_owner_created_quota_idx
  on public.persona_research_topics(owner,created_at desc,id);
create index if not exists topic_post_plans_owner_created_quota_idx
  on public.persona_topic_post_plans(owner,created_at desc,id);
create index if not exists topic_post_plans_owner_persona_quota_idx
  on public.persona_topic_post_plans(owner,persona_id,created_at desc,id);
create index if not exists research_annotations_owner_created_quota_idx
  on public.research_brief_annotations(owner,created_at desc,id);
create index if not exists research_annotations_owner_brief_quota_idx
  on public.research_brief_annotations(owner,brief_id,created_at desc,id);
create index if not exists content_packages_owner_created_quota_idx
  on public.persona_content_packages(owner,created_at desc,id);
create index if not exists content_packages_owner_persona_quota_idx
  on public.persona_content_packages(owner,persona_id,created_at desc,id);
create index if not exists content_variants_owner_created_quota_idx
  on public.persona_content_variants(owner,created_at desc,id);
create index if not exists owner_notifications_owner_subject_idx
  on public.owner_notifications(owner,subject_type,subject_id,status,id);
create index if not exists activity_events_owner_created_quota_idx
  on public.persona_activity_events(owner,created_at desc,id);

-- Reads stay owner-RLS scoped. Remove the old all-operation policies and every
-- browser table privilege capable of forging content, approval, or history.
drop policy if exists "owner write research settings" on public.persona_research_settings;
drop policy if exists "owner write briefs" on public.persona_research_briefs;
drop policy if exists "owner write topics" on public.persona_research_topics;
drop policy if exists "owner write plans" on public.persona_topic_post_plans;
drop policy if exists "owner all research annotations" on public.research_brief_annotations;
drop policy if exists "owner all content packages" on public.persona_content_packages;
drop policy if exists "owner all content variants" on public.persona_content_variants;
drop policy if exists "owner all notifications" on public.owner_notifications;
drop policy if exists "owner all activity events" on public.persona_activity_events;

drop policy if exists "owner read research annotations" on public.research_brief_annotations;
create policy "owner read research annotations" on public.research_brief_annotations
  for select to authenticated using (owner=auth.uid());
drop policy if exists "owner read content packages" on public.persona_content_packages;
create policy "owner read content packages" on public.persona_content_packages
  for select to authenticated using (owner=auth.uid());
drop policy if exists "owner read content variants" on public.persona_content_variants;
create policy "owner read content variants" on public.persona_content_variants
  for select to authenticated using (owner=auth.uid());
drop policy if exists "owner read notifications" on public.owner_notifications;
create policy "owner read notifications" on public.owner_notifications
  for select to authenticated using (owner=auth.uid());
drop policy if exists "owner read activity events" on public.persona_activity_events;
create policy "owner read activity events" on public.persona_activity_events
  for select to authenticated using (owner=auth.uid());

revoke insert,update,delete on public.persona_research_settings,
  public.persona_research_briefs,public.persona_research_topics,
  public.persona_topic_post_plans,public.research_brief_annotations,
  public.persona_content_packages,public.persona_content_variants,
  public.owner_notifications,public.persona_activity_events
  from authenticated;

-- One account lock serializes row, byte, daily, and lifetime probes. This uses
-- the shared owner-content seed already established by migration 051.
create or replace function public.lock_owner_research_content(p_owner uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null then raise exception 'Owner is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051056)
  );
end;
$$;
revoke all on function public.lock_owner_research_content(uuid)
  from public,anon,authenticated,service_role;

create or replace function public.reserve_owner_research_content_creation(
  p_owner uuid,p_kind text,p_amount integer default 1
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_day date:=(now() at time zone 'UTC')::date;
  v_today bigint;v_lifetime bigint;v_daily_limit integer;v_lifetime_limit bigint;
begin
  if p_owner is null or p_amount is null or p_amount not between 1 and 12 then
    raise exception 'Invalid creation reservation';
  end if;
  case p_kind
    when 'briefs' then v_daily_limit:=20;v_lifetime_limit:=20000;
    when 'topics' then v_daily_limit:=240;v_lifetime_limit:=240000;
    when 'plans' then v_daily_limit:=200;v_lifetime_limit:=50000;
    when 'annotations' then v_daily_limit:=200;v_lifetime_limit:=50000;
    when 'packages' then v_daily_limit:=50;v_lifetime_limit:=10000;
    when 'owner_activity' then v_daily_limit:=500;v_lifetime_limit:=100000;
    else raise exception 'Unknown creation reservation';
  end case;

  perform public.lock_owner_research_content(p_owner);
  insert into public.owner_research_content_usage(owner,window_day)
  values(p_owner,v_day) on conflict(owner) do nothing;
  update public.owner_research_content_usage set
    window_day=v_day,
    briefs_created_today=case when window_day=v_day then briefs_created_today else 0 end,
    topics_created_today=case when window_day=v_day then topics_created_today else 0 end,
    plans_created_today=case when window_day=v_day then plans_created_today else 0 end,
    annotations_created_today=case when window_day=v_day then annotations_created_today else 0 end,
    packages_created_today=case when window_day=v_day then packages_created_today else 0 end,
    owner_activity_created_today=case when window_day=v_day then owner_activity_created_today else 0 end,
    updated_at=now()
  where owner=p_owner and window_day is distinct from v_day;

  select
    case p_kind
      when 'briefs' then briefs_created_today
      when 'topics' then topics_created_today
      when 'plans' then plans_created_today
      when 'annotations' then annotations_created_today
      when 'packages' then packages_created_today
      when 'owner_activity' then owner_activity_created_today end,
    case p_kind
      when 'briefs' then briefs_created_lifetime
      when 'topics' then topics_created_lifetime
      when 'plans' then plans_created_lifetime
      when 'annotations' then annotations_created_lifetime
      when 'packages' then packages_created_lifetime
      when 'owner_activity' then owner_activity_created_lifetime end
  into v_today,v_lifetime
  from public.owner_research_content_usage where owner=p_owner for update;
  if v_today+p_amount>v_daily_limit then
    raise exception 'Daily % creation limit reached (%)',p_kind,v_daily_limit;
  end if;
  if v_lifetime+p_amount>v_lifetime_limit then
    raise exception 'Lifetime % creation limit reached (%)',p_kind,v_lifetime_limit;
  end if;

  update public.owner_research_content_usage set
    briefs_created_today=briefs_created_today+case when p_kind='briefs' then p_amount else 0 end,
    briefs_created_lifetime=briefs_created_lifetime+case when p_kind='briefs' then p_amount else 0 end,
    topics_created_today=topics_created_today+case when p_kind='topics' then p_amount else 0 end,
    topics_created_lifetime=topics_created_lifetime+case when p_kind='topics' then p_amount else 0 end,
    plans_created_today=plans_created_today+case when p_kind='plans' then p_amount else 0 end,
    plans_created_lifetime=plans_created_lifetime+case when p_kind='plans' then p_amount else 0 end,
    annotations_created_today=annotations_created_today+case when p_kind='annotations' then p_amount else 0 end,
    annotations_created_lifetime=annotations_created_lifetime+case when p_kind='annotations' then p_amount else 0 end,
    packages_created_today=packages_created_today+case when p_kind='packages' then p_amount else 0 end,
    packages_created_lifetime=packages_created_lifetime+case when p_kind='packages' then p_amount else 0 end,
    owner_activity_created_today=owner_activity_created_today+case when p_kind='owner_activity' then p_amount else 0 end,
    owner_activity_created_lifetime=owner_activity_created_lifetime+case when p_kind='owner_activity' then p_amount else 0 end,
    updated_at=now()
  where owner=p_owner;
end;
$$;
revoke all on function public.reserve_owner_research_content_creation(uuid,text,integer)
  from public,anon,authenticated,service_role;

create or replace function public.assert_owner_media_plan(p_plan jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_item jsonb;v_key text;v_url text;
begin
  if p_plan is null or jsonb_typeof(p_plan)<>'array'
     or jsonb_array_length(p_plan)>12 or octet_length(p_plan::text)>20000 then
    raise exception 'Media plan is malformed or too large';
  end if;
  for v_item in select value from jsonb_array_elements(p_plan)
  loop
    if jsonb_typeof(v_item)<>'object' then raise exception 'Media plan entries must be objects'; end if;
    for v_key in select jsonb_object_keys(v_item)
    loop
      if v_key not in ('type','brief','size','source_url') then
        raise exception 'Media plan contains unsupported fields';
      end if;
    end loop;
    if coalesce(v_item->>'type','image') not in ('image','video','audio','document')
       or char_length(coalesce(v_item->>'brief',''))>1200
       or char_length(coalesce(v_item->>'size',''))>80
       or char_length(coalesce(v_item->>'source_url',''))>2048 then
      raise exception 'Media plan entry is invalid';
    end if;
    v_url:=coalesce(v_item->>'source_url','');
    if not public.is_safe_credential_free_https_url(v_url,true) then
      raise exception 'Media plan source URL is not a safe public HTTPS URL';
    end if;
  end loop;
end;
$$;
revoke all on function public.assert_owner_media_plan(jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.assert_owner_content_variants(p_variants jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  v_item jsonb;v_key text;v_channel text;v_body text;
  v_channels text[]:='{}'::text[];v_sorted text[];
begin
  if p_variants is null or jsonb_typeof(p_variants)<>'array'
     or jsonb_array_length(p_variants)<>4
     or octet_length(p_variants::text)>180000 then
    raise exception 'Exactly four bounded content variants are required';
  end if;
  for v_item in select value from jsonb_array_elements(p_variants)
  loop
    if jsonb_typeof(v_item)<>'object' then raise exception 'Content variants must be objects'; end if;
    for v_key in select jsonb_object_keys(v_item)
    loop
      if v_key not in ('channel','title','body','description','alt_text','media_plan') then
        raise exception 'Content variant contains unsupported or protected fields';
      end if;
    end loop;
    v_channel:=coalesce(v_item->>'channel','');
    v_body:=coalesce(v_item->>'body','');
    if v_channel not in ('x','instagram','facebook','website')
       or v_channel=any(v_channels) then
      raise exception 'Content variant channels are invalid or duplicated';
    end if;
    if char_length(coalesce(v_item->>'title',''))>300
       or char_length(v_body)<1
       or char_length(v_body)>(case v_channel when 'x' then 280 when 'instagram' then 5000 when 'facebook' then 10000 else 30000 end)
       or char_length(coalesce(v_item->>'description',''))>2000
       or char_length(coalesce(v_item->>'alt_text',''))>2000
       or octet_length(coalesce(v_item->>'title',''))>1200
       or octet_length(v_body)>120000
       or octet_length(coalesce(v_item->>'description',''))>8000
       or octet_length(coalesce(v_item->>'alt_text',''))>8000 then
      raise exception 'Content variant text is empty or too large';
    end if;
    perform public.assert_owner_media_plan(coalesce(v_item->'media_plan','[]'::jsonb));
    v_channels:=array_append(v_channels,v_channel);
  end loop;
  select array_agg(channel order by channel) into v_sorted from unnest(v_channels) channel;
  if v_sorted is distinct from array['facebook','instagram','website','x']::text[] then
    raise exception 'X, Instagram, Facebook, and website variants are required';
  end if;
end;
$$;
revoke all on function public.assert_owner_content_variants(jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.owner_content_variants_bytes(p_variants jsonb)
returns bigint language sql immutable set search_path = '' as $$
  select coalesce(sum(
    octet_length(coalesce(item->>'title',''))+
    octet_length(coalesce(item->>'body',''))+
    octet_length(coalesce(item->>'description',''))+
    octet_length(coalesce(item->>'alt_text',''))+
    octet_length(coalesce(item->'media_plan','[]'::jsonb)::text)
  ),0)::bigint from jsonb_array_elements(coalesce(p_variants,'[]'::jsonb)) item
$$;
revoke all on function public.owner_content_variants_bytes(jsonb)
  from public,anon,authenticated,service_role;

-- Service-created research is still owner-scoped and bounded. Both the model
-- runner and owner-reviewed JSON import already call this service-only RPC.
create or replace function public.save_research_brief(
  p_persona_id uuid,p_brief_date date,p_backend_id uuid,p_model text,
  p_executive_summary text,p_key_findings jsonb,p_sources jsonb,p_raw_response text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;v_brief_id uuid;v_finding jsonb;v_topic_count integer;
  v_brief_count integer;v_existing_topics integer;v_existing_bytes bigint;v_incoming_bytes bigint;
  v_source_type text;v_urls jsonb;v_url text;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  select persona.owner into v_owner from public.personas persona where persona.id=p_persona_id;
  if v_owner is null then raise exception 'Persona not found'; end if;
  perform public.lock_owner_research_content(v_owner);
  if p_backend_id is not null and not exists(
    select 1 from public.ai_backends backend where backend.id=p_backend_id and backend.owner=v_owner
  ) then raise exception 'Owned research backend not found'; end if;
  if p_brief_date is null or p_brief_date<current_date-3650 or p_brief_date>current_date+1
     or char_length(coalesce(p_model,''))>300
     or char_length(coalesce(p_executive_summary,''))>6000
     or octet_length(coalesce(p_executive_summary,''))>24000
     or char_length(coalesce(p_raw_response,''))>220000
     or octet_length(coalesce(p_raw_response,''))>880000
     or jsonb_typeof(coalesce(p_key_findings,'null'::jsonb))<>'array'
     or jsonb_array_length(p_key_findings) not between 1 and 12
     or octet_length(p_key_findings::text)>180000
     or jsonb_typeof(coalesce(p_sources,'null'::jsonb))<>'array'
     or jsonb_array_length(p_sources)>96
     or octet_length(p_sources::text)>100000 then
    raise exception 'Research brief payload is malformed or too large';
  end if;
  v_topic_count:=jsonb_array_length(p_key_findings);
  for v_finding in select value from jsonb_array_elements(p_key_findings)
  loop
    if jsonb_typeof(v_finding)<>'object'
       or char_length(trim(coalesce(v_finding->>'title',''))) not between 1 and 300
       or char_length(coalesce(v_finding->>'summary',''))>4000
       or char_length(coalesce(v_finding->>'why_it_matters',''))>4000
       or char_length(coalesce(v_finding->>'suggested_post_angle',''))>2000
       or coalesce(v_finding->>'novelty_score','5')!~'^(10|[1-9])$'
       or coalesce(v_finding->>'relevance_score','5')!~'^(10|[1-9])$'
       or coalesce(v_finding->>'suggested_post_type','new') not in ('new','repost','remix','thread') then
      raise exception 'Research finding is malformed or too large';
    end if;
    v_source_type:=coalesce(v_finding->>'source_type','');
    if v_source_type not in ('','research_paper','news_article','industry_report','social_trend','product_launch') then
      raise exception 'Research finding source type is invalid';
    end if;
    v_urls:=coalesce(v_finding->'source_urls','[]'::jsonb);
    if jsonb_typeof(v_urls)<>'array' or jsonb_array_length(v_urls)>8 or octet_length(v_urls::text)>20000 then
      raise exception 'Research finding URLs are malformed or too large';
    end if;
    for v_url in select value from jsonb_array_elements_text(v_urls)
    loop
      if not public.is_safe_credential_free_https_url(v_url,false) then
        raise exception 'Research finding URL is not a safe public HTTPS URL';
      end if;
    end loop;
  end loop;

  select count(*) into v_brief_count from (
    select 1 from public.persona_research_briefs row where row.owner=v_owner limit 2001
  ) bounded;
  if v_brief_count>=2000 then raise exception 'Research brief storage limit reached (2000)'; end if;
  select count(*) into v_existing_topics from (
    select 1 from public.persona_research_topics row where row.owner=v_owner limit 20001
  ) bounded;
  if v_existing_topics+v_topic_count>20000 then
    raise exception 'Research topic storage limit reached (20000)';
  end if;
  select coalesce(sum(row_bytes),0) into v_existing_bytes from (
    select octet_length(coalesce(row.executive_summary,''))+
      octet_length(coalesce(row.key_findings,'[]'::jsonb)::text)+
      octet_length(coalesce(row.sources,'[]'::jsonb)::text)+
      octet_length(coalesce(row.raw_response,'')) as row_bytes
    from public.persona_research_briefs row where row.owner=v_owner limit 2001
  ) bounded;
  v_incoming_bytes:=octet_length(coalesce(p_executive_summary,''))+
    octet_length(p_key_findings::text)+octet_length(p_sources::text)+
    octet_length(coalesce(p_raw_response,''));
  if v_existing_bytes+v_incoming_bytes>157286400 then
    raise exception 'Research brief byte limit reached (157286400 bytes)';
  end if;
  perform public.reserve_owner_research_content_creation(v_owner,'briefs',1);
  perform public.reserve_owner_research_content_creation(v_owner,'topics',v_topic_count);

  insert into public.persona_research_briefs(
    owner,persona_id,brief_date,backend_id,model,executive_summary,
    key_findings,sources,finding_count,status,raw_response
  ) values(
    v_owner,p_persona_id,p_brief_date,p_backend_id,coalesce(p_model,''),
    coalesce(p_executive_summary,''),p_key_findings,p_sources,v_topic_count,'new',
    coalesce(p_raw_response,'')
  ) returning id into v_brief_id;

  for v_finding in select value from jsonb_array_elements(p_key_findings)
  loop
    v_urls:=coalesce(v_finding->'source_urls','[]'::jsonb);
    insert into public.persona_research_topics(
      owner,brief_id,persona_id,title,summary,why_it_matters,novelty_score,
      relevance_score,source_urls,source_type,needs_verification,
      suggested_post_angle,suggested_post_type,status
    ) values(
      v_owner,v_brief_id,p_persona_id,trim(v_finding->>'title'),
      coalesce(v_finding->>'summary',''),coalesce(v_finding->>'why_it_matters',''),
      coalesce((v_finding->>'novelty_score')::integer,5),
      coalesce((v_finding->>'relevance_score')::integer,5),
      array(select value from jsonb_array_elements_text(v_urls)),
      coalesce(v_finding->>'source_type',''),
      case when jsonb_typeof(v_finding->'needs_verification')='boolean'
        then (v_finding->>'needs_verification')::boolean else true end,
      coalesce(v_finding->>'suggested_post_angle',''),
      coalesce(v_finding->>'suggested_post_type','new'),'new'
    );
  end loop;
  return v_brief_id;
end;
$$;

create or replace function public.save_owner_research_settings(
  p_persona_id uuid,p_research_enabled boolean,p_brief_frequency text,
  p_research_depth text,p_max_findings_per_brief integer,p_preferred_backend_id uuid default null
)
returns public.persona_research_settings
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_row public.persona_research_settings%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_brief_frequency not in ('daily','weekly','manual')
     or p_research_depth not in ('quick','standard','deep')
     or p_max_findings_per_brief not between 1 and 8 then
    raise exception 'Research settings are invalid';
  end if;
  perform public.lock_owner_research_content(v_owner);
  if not exists(select 1 from public.personas persona where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  if p_preferred_backend_id is not null and not exists(
    select 1 from public.ai_backends backend
    where backend.id=p_preferred_backend_id and backend.owner=v_owner
  ) then raise exception 'Owned research backend not found'; end if;
  insert into public.persona_research_settings(
    persona_id,owner,research_enabled,brief_frequency,research_depth,
    preferred_backend_id,max_findings_per_brief,updated_at
  ) values(
    p_persona_id,v_owner,coalesce(p_research_enabled,false),p_brief_frequency,
    p_research_depth,p_preferred_backend_id,p_max_findings_per_brief,now()
  ) on conflict(persona_id) do update set
    research_enabled=excluded.research_enabled,
    brief_frequency=excluded.brief_frequency,research_depth=excluded.research_depth,
    preferred_backend_id=excluded.preferred_backend_id,
    max_findings_per_brief=excluded.max_findings_per_brief,updated_at=now()
  where persona_research_settings.owner=v_owner
  returning * into v_row;
  if v_row.persona_id is null then raise exception 'Owned research settings not found'; end if;
  return v_row;
end;
$$;

create or replace function public.set_owner_research_brief_status(
  p_brief_id uuid,p_status text
)
returns public.persona_research_briefs
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_row public.persona_research_briefs%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_status not in ('reviewed','archived') then raise exception 'Invalid brief status'; end if;
  perform public.lock_owner_research_content(v_owner);
  select * into v_row from public.persona_research_briefs brief
  where brief.id=p_brief_id and brief.owner=v_owner for update;
  if not found then raise exception 'Owned research brief not found'; end if;
  if v_row.status='archived' and p_status<>'archived' then
    raise exception 'Archived briefs cannot be reopened';
  end if;
  update public.persona_research_briefs set status=p_status,updated_at=now()
  where id=p_brief_id and owner=v_owner returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.approve_research_topic(
  p_topic_id uuid,p_post_type text default 'new',p_platform text default '',
  p_scheduled_for date default null,p_notes text default ''
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_topic public.persona_research_topics%rowtype;
  v_plan_id uuid;v_total integer;v_persona_total integer;v_bytes bigint;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_post_type not in ('new','repost','remix','thread')
     or p_platform not in ('','facebook','instagram','x','website','reddit','discord')
     or char_length(coalesce(p_notes,''))>4000 or octet_length(coalesce(p_notes,''))>16000
     or (p_scheduled_for is not null and (p_scheduled_for<current_date or p_scheduled_for>current_date+1825)) then
    raise exception 'Topic approval fields are invalid or too large';
  end if;
  perform public.lock_owner_research_content(v_owner);
  select * into v_topic from public.persona_research_topics topic
  where topic.id=p_topic_id and topic.owner=v_owner for update;
  if not found then raise exception 'Owned research topic not found'; end if;
  if v_topic.status in ('approved','drafted','scheduled') then
    select plan.id into v_plan_id from public.persona_topic_post_plans plan
    where plan.topic_id=p_topic_id and plan.owner=v_owner and plan.status<>'cancelled'
    order by plan.created_at desc,plan.id desc limit 1;
    if v_plan_id is not null then return v_plan_id; end if;
    raise exception 'Approved topic is missing its owner plan';
  end if;
  if v_topic.status not in ('new','rejected') then raise exception 'Topic cannot be approved in its current state'; end if;
  select count(*) into v_total from (
    select 1 from public.persona_topic_post_plans plan where plan.owner=v_owner limit 5001
  ) bounded;
  if v_total>=5000 then raise exception 'Topic plan storage limit reached (5000)'; end if;
  select count(*) into v_persona_total from (
    select 1 from public.persona_topic_post_plans plan
    where plan.owner=v_owner and plan.persona_id=v_topic.persona_id limit 501
  ) bounded;
  if v_persona_total>=500 then raise exception 'Persona topic plan limit reached (500)'; end if;
  select coalesce(sum(octet_length(coalesce(notes,''))),0) into v_bytes from (
    select plan.notes from public.persona_topic_post_plans plan where plan.owner=v_owner limit 5001
  ) bounded;
  if v_bytes+octet_length(coalesce(p_notes,''))>10485760 then
    raise exception 'Topic plan byte limit reached (10485760 bytes)';
  end if;
  perform public.reserve_owner_research_content_creation(v_owner,'plans',1);
  update public.persona_research_topics set
    status='approved',rejection_reason='',approved_post_type=p_post_type,
    approved_platform=p_platform,approved_scheduled_for=p_scheduled_for,
    approved_notes=coalesce(p_notes,''),approved_at=now(),approved_by=v_owner,updated_at=now()
  where id=p_topic_id and owner=v_owner;
  insert into public.persona_topic_post_plans(
    owner,topic_id,persona_id,post_type,platform,scheduled_for,scheduled_time,status,notes
  ) values(
    v_owner,p_topic_id,v_topic.persona_id,p_post_type,p_platform,p_scheduled_for,
    '09:00:00','planned',coalesce(p_notes,'')
  ) returning id into v_plan_id;
  return v_plan_id;
end;
$$;

create or replace function public.reject_research_topic(
  p_topic_id uuid,p_reason text default ''
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_status text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if char_length(coalesce(p_reason,''))>2000 or octet_length(coalesce(p_reason,''))>8000 then
    raise exception 'Rejection reason is too large';
  end if;
  perform public.lock_owner_research_content(v_owner);
  select topic.status into v_status from public.persona_research_topics topic
  where topic.id=p_topic_id and topic.owner=v_owner for update;
  if not found then raise exception 'Owned research topic not found'; end if;
  if v_status not in ('new','approved','rejected') then
    raise exception 'Topic cannot be rejected in its current state';
  end if;
  update public.persona_topic_post_plans set status='cancelled',updated_at=now()
  where topic_id=p_topic_id and owner=v_owner and status in ('planned','drafted','scheduled');
  update public.persona_research_topics set
    status='rejected',rejection_reason=coalesce(p_reason,''),
    approved_post_type=null,approved_platform=null,approved_scheduled_for=null,
    approved_notes='',approved_at=null,approved_by=null,updated_at=now()
  where id=p_topic_id and owner=v_owner;
end;
$$;

create or replace function public.save_owner_research_annotation(
  p_annotation_id uuid,p_brief_id uuid,p_topic_id uuid,p_annotation_type text,
  p_selected_text text default '',p_context_before text default '',
  p_context_after text default '',p_image_url text default '',
  p_owner_comment text default '',p_include_in_generation boolean default true
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_brief public.persona_research_briefs%rowtype;
  v_existing public.research_brief_annotations%rowtype;v_id uuid;
  v_total integer;v_brief_total integer;v_total_bytes bigint;v_old_bytes bigint:=0;
  v_new_bytes bigint;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_annotation_type not in ('highlight','comment','image')
     or char_length(coalesce(p_selected_text,''))>4000
     or char_length(coalesce(p_context_before,''))>500
     or char_length(coalesce(p_context_after,''))>500
     or char_length(coalesce(p_image_url,''))>2048
     or char_length(coalesce(p_owner_comment,''))>4000
     or octet_length(coalesce(p_selected_text,''))>16000
     or octet_length(coalesce(p_owner_comment,''))>16000 then
    raise exception 'Annotation fields are invalid or too large';
  end if;
  if (p_annotation_type='highlight' and trim(coalesce(p_selected_text,''))='')
     or (p_annotation_type='comment' and trim(coalesce(p_owner_comment,''))='')
     or (p_annotation_type='image' and not public.is_safe_credential_free_https_url(coalesce(p_image_url,''),false)) then
    raise exception 'Annotation content does not match its type';
  end if;
  perform public.lock_owner_research_content(v_owner);
  select * into v_brief from public.persona_research_briefs brief
  where brief.id=p_brief_id and brief.owner=v_owner;
  if not found then raise exception 'Owned research brief not found'; end if;
  if p_topic_id is not null and not exists(
    select 1 from public.persona_research_topics topic
    where topic.id=p_topic_id and topic.owner=v_owner
      and topic.brief_id=p_brief_id and topic.persona_id=v_brief.persona_id
  ) then raise exception 'Owned research topic does not belong to this brief'; end if;

  if p_annotation_id is not null then
    select * into v_existing from public.research_brief_annotations annotation
    where annotation.id=p_annotation_id and annotation.owner=v_owner for update;
    if not found then raise exception 'Owned annotation not found'; end if;
    if v_existing.brief_id<>p_brief_id then raise exception 'Annotations cannot be moved between briefs'; end if;
    v_old_bytes:=octet_length(v_existing.selected_text)+octet_length(v_existing.context_before)+
      octet_length(v_existing.context_after)+octet_length(v_existing.image_url)+
      octet_length(v_existing.owner_comment);
  else
    select count(*) into v_total from (
      select 1 from public.research_brief_annotations annotation
      where annotation.owner=v_owner limit 5001
    ) bounded;
    if v_total>=5000 then raise exception 'Annotation storage limit reached (5000)'; end if;
    select count(*) into v_brief_total from (
      select 1 from public.research_brief_annotations annotation
      where annotation.owner=v_owner and annotation.brief_id=p_brief_id limit 501
    ) bounded;
    if v_brief_total>=500 then raise exception 'Brief annotation limit reached (500)'; end if;
  end if;
  select coalesce(sum(row_bytes),0) into v_total_bytes from (
    select octet_length(annotation.selected_text)+octet_length(annotation.context_before)+
      octet_length(annotation.context_after)+octet_length(annotation.image_url)+
      octet_length(annotation.owner_comment) as row_bytes
    from public.research_brief_annotations annotation where annotation.owner=v_owner limit 5001
  ) bounded;
  v_new_bytes:=octet_length(coalesce(p_selected_text,''))+
    octet_length(coalesce(p_context_before,''))+octet_length(coalesce(p_context_after,''))+
    octet_length(coalesce(p_image_url,''))+octet_length(coalesce(p_owner_comment,''));
  if v_total_bytes-v_old_bytes+v_new_bytes>20971520 and v_new_bytes>=v_old_bytes then
    raise exception 'Annotation byte limit reached (20971520 bytes)';
  end if;

  if p_annotation_id is null then
    perform public.reserve_owner_research_content_creation(v_owner,'annotations',1);
    insert into public.research_brief_annotations(
      owner,persona_id,brief_id,topic_id,annotation_type,selected_text,
      context_before,context_after,image_url,owner_comment,include_in_generation
    ) values(
      v_owner,v_brief.persona_id,p_brief_id,p_topic_id,p_annotation_type,
      coalesce(p_selected_text,''),coalesce(p_context_before,''),
      coalesce(p_context_after,''),coalesce(p_image_url,''),
      coalesce(p_owner_comment,''),coalesce(p_include_in_generation,true)
    ) returning id into v_id;
  else
    update public.research_brief_annotations set
      topic_id=p_topic_id,annotation_type=p_annotation_type,
      selected_text=coalesce(p_selected_text,''),context_before=coalesce(p_context_before,''),
      context_after=coalesce(p_context_after,''),image_url=coalesce(p_image_url,''),
      owner_comment=coalesce(p_owner_comment,''),
      include_in_generation=coalesce(p_include_in_generation,true),updated_at=now()
    where id=p_annotation_id and owner=v_owner returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_owner_research_annotation(p_annotation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_owner_research_content(v_owner);
  delete from public.research_brief_annotations annotation
  where annotation.id=p_annotation_id and annotation.owner=v_owner;
  if not found then raise exception 'Owned annotation not found'; end if;
  return true;
end;
$$;

create or replace function public.create_owner_content_package(
  p_persona_id uuid,p_source_brief_id uuid,p_source_topic_ids uuid[],
  p_title text,p_owner_guidance text,p_timezone text,p_variants jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_package_id uuid;v_brief_status text;
  v_total integer;v_persona_total integer;v_topic_count integer;
  v_existing_bytes bigint;v_incoming_bytes bigint;v_item jsonb;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if char_length(coalesce(p_title,''))>300 or octet_length(coalesce(p_title,''))>1200
     or char_length(coalesce(p_owner_guidance,''))>6000
     or octet_length(coalesce(p_owner_guidance,''))>24000
     or char_length(coalesce(p_timezone,'')) not between 1 and 80
     or not exists(select 1 from pg_catalog.pg_timezone_names zone where zone.name=p_timezone)
     or cardinality(coalesce(p_source_topic_ids,'{}'::uuid[])) not between 1 and 12 then
    raise exception 'Content package fields are invalid or too large';
  end if;
  perform public.assert_owner_content_variants(p_variants);
  perform public.lock_owner_research_content(v_owner);
  if not exists(select 1 from public.personas persona where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  select brief.status into v_brief_status from public.persona_research_briefs brief
  where brief.id=p_source_brief_id and brief.owner=v_owner and brief.persona_id=p_persona_id
  for update;
  if not found then raise exception 'Owned source brief not found'; end if;
  select count(*) into v_topic_count from public.persona_research_topics topic
  where topic.owner=v_owner and topic.brief_id=p_source_brief_id
    and topic.persona_id=p_persona_id and topic.id=any(p_source_topic_ids);
  if v_topic_count<>cardinality(p_source_topic_ids)
     or cardinality(array(select distinct value from unnest(p_source_topic_ids) value))<>cardinality(p_source_topic_ids) then
    raise exception 'Source topics must be distinct findings from the owned brief';
  end if;
  select count(*) into v_total from (
    select 1 from public.persona_content_packages package where package.owner=v_owner limit 1001
  ) bounded;
  if v_total>=1000 then raise exception 'Content package storage limit reached (1000)'; end if;
  select count(*) into v_persona_total from (
    select 1 from public.persona_content_packages package
    where package.owner=v_owner and package.persona_id=p_persona_id limit 101
  ) bounded;
  if v_persona_total>=100 then raise exception 'Persona content package limit reached (100)'; end if;
  select coalesce(sum(row_bytes),0) into v_existing_bytes from (
    select octet_length(package.title)+octet_length(package.owner_guidance)+coalesce((
      select sum(octet_length(variant.title)+octet_length(variant.body)+
        octet_length(variant.description)+octet_length(variant.alt_text)+
        octet_length(variant.media_plan::text))
      from public.persona_content_variants variant where variant.package_id=package.id
    ),0) as row_bytes
    from public.persona_content_packages package where package.owner=v_owner limit 1001
  ) bounded;
  v_incoming_bytes:=octet_length(coalesce(p_title,''))+octet_length(coalesce(p_owner_guidance,''))+
    public.owner_content_variants_bytes(p_variants);
  if v_existing_bytes+v_incoming_bytes>52428800 then
    raise exception 'Content package byte limit reached (52428800 bytes)';
  end if;
  perform public.reserve_owner_research_content_creation(v_owner,'packages',1);
  insert into public.persona_content_packages(
    owner,persona_id,source_brief_id,source_topic_ids,title,owner_guidance,
    status,scheduled_for,timezone,approval_hash,approved_at,approved_by,completed_at
  ) values(
    v_owner,p_persona_id,p_source_brief_id,p_source_topic_ids,
    coalesce(p_title,''),coalesce(p_owner_guidance,''),'owner_review',null,p_timezone,
    '',null,null,null
  ) returning id into v_package_id;
  for v_item in select value from jsonb_array_elements(p_variants)
  loop
    insert into public.persona_content_variants(
      owner,package_id,persona_id,channel,title,body,description,alt_text,
      media_plan,status,provider_id,provider_url
    ) values(
      v_owner,v_package_id,p_persona_id,v_item->>'channel',
      coalesce(v_item->>'title',''),v_item->>'body',
      coalesce(v_item->>'description',''),coalesce(v_item->>'alt_text',''),
      coalesce(v_item->'media_plan','[]'::jsonb),'ready','',''
    );
  end loop;
  if v_brief_status='new' then
    update public.persona_research_briefs set status='reviewed',updated_at=now()
    where id=p_source_brief_id and owner=v_owner and status='new';
  end if;
  return v_package_id;
end;
$$;

create or replace function public.save_owner_content_package_draft(
  p_package_id uuid,p_title text,p_owner_guidance text,p_variants jsonb
)
returns public.persona_content_packages
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_package public.persona_content_packages%rowtype;
  v_item jsonb;v_total_bytes bigint;v_old_bytes bigint;v_new_bytes bigint;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if char_length(coalesce(p_title,''))>300 or octet_length(coalesce(p_title,''))>1200
     or char_length(coalesce(p_owner_guidance,''))>6000
     or octet_length(coalesce(p_owner_guidance,''))>24000 then
    raise exception 'Content package fields are too large';
  end if;
  perform public.assert_owner_content_variants(p_variants);
  perform public.lock_owner_research_content(v_owner);
  select * into v_package from public.persona_content_packages package
  where package.id=p_package_id and package.owner=v_owner for update;
  if not found then raise exception 'Owned content package not found'; end if;
  if v_package.status in ('completed','archived') or exists(
    select 1 from public.persona_content_variants variant
    where variant.package_id=p_package_id and variant.owner=v_owner
      and (variant.status in ('manually_posted','published') or variant.provider_id<>'' or variant.provider_url<>'')
  ) then raise exception 'Posted or archived content must remain immutable'; end if;
  if v_package.status in ('approved','scheduled') then
    perform public.require_aal2();
  end if;
  select octet_length(v_package.title)+octet_length(v_package.owner_guidance)+coalesce(sum(
    octet_length(variant.title)+octet_length(variant.body)+octet_length(variant.description)+
    octet_length(variant.alt_text)+octet_length(variant.media_plan::text)
  ),0) into v_old_bytes
  from public.persona_content_variants variant where variant.package_id=p_package_id;
  select coalesce(sum(row_bytes),0) into v_total_bytes from (
    select octet_length(package.title)+octet_length(package.owner_guidance)+coalesce((
      select sum(octet_length(variant.title)+octet_length(variant.body)+
        octet_length(variant.description)+octet_length(variant.alt_text)+
        octet_length(variant.media_plan::text))
      from public.persona_content_variants variant where variant.package_id=package.id
    ),0) as row_bytes
    from public.persona_content_packages package where package.owner=v_owner limit 1001
  ) bounded;
  v_new_bytes:=octet_length(coalesce(p_title,''))+octet_length(coalesce(p_owner_guidance,''))+
    public.owner_content_variants_bytes(p_variants);
  if v_total_bytes-v_old_bytes+v_new_bytes>52428800 and v_new_bytes>=v_old_bytes then
    raise exception 'Content package byte limit reached (52428800 bytes)';
  end if;
  update public.persona_content_packages set
    title=coalesce(p_title,''),owner_guidance=coalesce(p_owner_guidance,''),
    status='owner_review',scheduled_for=null,approval_hash='',approved_at=null,
    approved_by=null,completed_at=null,updated_at=now()
  where id=p_package_id and owner=v_owner;
  for v_item in select value from jsonb_array_elements(p_variants)
  loop
    insert into public.persona_content_variants(
      owner,package_id,persona_id,channel,title,body,description,alt_text,
      media_plan,status,provider_id,provider_url
    ) values(
      v_owner,p_package_id,v_package.persona_id,v_item->>'channel',
      coalesce(v_item->>'title',''),v_item->>'body',coalesce(v_item->>'description',''),
      coalesce(v_item->>'alt_text',''),coalesce(v_item->'media_plan','[]'::jsonb),
      'ready','',''
    ) on conflict(package_id,channel) do update set
      title=excluded.title,body=excluded.body,description=excluded.description,
      alt_text=excluded.alt_text,media_plan=excluded.media_plan,status='ready',updated_at=now();
  end loop;
  select * into v_package from public.persona_content_packages package
  where package.id=p_package_id and package.owner=v_owner;
  return v_package;
end;
$$;

create or replace function public.delete_owner_content_package_draft(p_package_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.lock_owner_research_content(v_owner);
  delete from public.persona_content_packages package
  where package.id=p_package_id and package.owner=v_owner
    and package.status in ('owner_review','rejected','archived')
    and not exists(select 1 from public.persona_content_variants variant
      where variant.package_id=package.id and (variant.provider_id<>'' or variant.provider_url<>''
        or variant.status in ('manually_posted','published')));
  if not found then raise exception 'Deletable owner draft package not found'; end if;
  return true;
end;
$$;

create or replace function public.approve_content_package(p_package_id uuid)
returns public.persona_content_packages
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_package public.persona_content_packages%rowtype;
  v_hash text;v_channels text[];v_count integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_owner_research_content(v_owner);
  select * into v_package from public.persona_content_packages package
  where package.id=p_package_id and package.owner=v_owner for update;
  if not found then raise exception 'Owned content package not found'; end if;
  select public.content_package_hash(p_package_id) into v_hash;
  if v_package.status='approved' then
    if v_package.approval_hash=v_hash and
       (select count(*)=4 and bool_and(variant.status='approved' and variant.provider_id='' and variant.provider_url='')
        from public.persona_content_variants variant
        where variant.package_id=p_package_id and variant.owner=v_owner) then
      return v_package;
    end if;
    raise exception 'Approved content no longer matches its exact server hash';
  end if;
  select count(*),array_agg(variant.channel order by variant.channel)
  into v_count,v_channels from public.persona_content_variants variant
  where variant.package_id=p_package_id and variant.owner=v_owner
    and variant.body<>'' and variant.status in ('draft','ready')
    and variant.provider_id='' and variant.provider_url='';
  if v_count<>4 or v_channels is distinct from array['facebook','instagram','website','x']::text[] then
    raise exception 'A complete unposted X, Instagram, Facebook, and website kit is required';
  end if;
  if v_package.status<>'owner_review' then
    raise exception 'Only an owner-review package can be approved';
  end if;
  update public.persona_content_packages set
    status='approved',approval_hash=v_hash,approved_at=now(),approved_by=v_owner,
    scheduled_for=null,completed_at=null,updated_at=now()
  where id=p_package_id and owner=v_owner returning * into v_package;
  update public.persona_content_variants set status='approved',updated_at=now()
  where package_id=p_package_id and owner=v_owner;
  return v_package;
end;
$$;

create or replace function public.schedule_content_package(
  p_package_id uuid,p_scheduled_for timestamptz,p_timezone text
)
returns public.persona_content_packages
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_package public.persona_content_packages%rowtype;v_hash text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_scheduled_for is null or p_scheduled_for<=now()
     or p_scheduled_for>now()+interval '5 years'
     or char_length(coalesce(p_timezone,'')) not between 1 and 80
     or not exists(select 1 from pg_catalog.pg_timezone_names zone where zone.name=p_timezone) then
    raise exception 'Choose a valid future schedule time and time zone';
  end if;
  perform public.lock_owner_research_content(v_owner);
  select * into v_package from public.persona_content_packages package
  where package.id=p_package_id and package.owner=v_owner for update;
  if not found then raise exception 'Owned content package not found'; end if;
  if v_package.status<>'approved' then
    raise exception 'Approve the exact content package before scheduling';
  end if;
  select public.content_package_hash(p_package_id) into v_hash;
  if v_package.approval_hash='' or v_hash<>v_package.approval_hash then
    raise exception 'Content changed after approval; review and approve it again';
  end if;
  if exists(select 1 from public.persona_content_variants variant
    where variant.package_id=p_package_id and variant.owner=v_owner
      and (variant.status<>'approved' or variant.provider_id<>'' or variant.provider_url<>'')) then
    raise exception 'Only exact unposted approved variants can be scheduled';
  end if;
  update public.persona_content_packages set
    status='scheduled',scheduled_for=p_scheduled_for,timezone=p_timezone,updated_at=now()
  where id=p_package_id and owner=v_owner returning * into v_package;
  update public.persona_content_variants set status='scheduled',updated_at=now()
  where package_id=p_package_id and owner=v_owner;
  return v_package;
end;
$$;

create or replace function public.unschedule_content_package(p_package_id uuid)
returns public.persona_content_packages
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_package public.persona_content_packages%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_owner_research_content(v_owner);
  select * into v_package from public.persona_content_packages package
  where package.id=p_package_id and package.owner=v_owner for update;
  if not found or v_package.status<>'scheduled' then
    raise exception 'Owned scheduled content package not found';
  end if;
  update public.persona_content_packages set
    status='owner_review',scheduled_for=null,approval_hash='',approved_at=null,
    approved_by=null,updated_at=now()
  where id=p_package_id and owner=v_owner returning * into v_package;
  update public.persona_content_variants set status='ready',updated_at=now()
  where package_id=p_package_id and owner=v_owner and status='scheduled';
  return v_package;
end;
$$;

create or replace function public.reserve_owner_activity_event(
  p_owner uuid,p_incoming_bytes integer,p_owner_authored boolean
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_total integer;v_owner_total integer;v_bytes bigint;
begin
  if p_owner is null or p_incoming_bytes is null or p_incoming_bytes not between 1 and 8192 then
    raise exception 'Invalid activity event reservation';
  end if;
  perform public.lock_owner_research_content(p_owner);
  select count(*) into v_total from (
    select 1 from public.persona_activity_events event where event.owner=p_owner limit 100001
  ) bounded;
  if v_total>=100000 then raise exception 'Activity event storage limit reached (100000)'; end if;
  select coalesce(sum(row_bytes),0) into v_bytes from (
    select octet_length(event.event_type)+octet_length(event.source)+
      octet_length(event.summary)+octet_length(event.subject_type)+
      octet_length(event.metadata::text) as row_bytes
    from public.persona_activity_events event where event.owner=p_owner limit 100001
  ) bounded;
  if v_bytes+p_incoming_bytes>67108864 then
    raise exception 'Activity event byte limit reached (67108864 bytes)';
  end if;
  if coalesce(p_owner_authored,false) then
    select count(*) into v_owner_total from (
      select 1 from public.persona_activity_events event
      where event.owner=p_owner and event.source='owner' limit 10001
    ) bounded;
    if v_owner_total>=10000 then raise exception 'Owner activity storage limit reached (10000)'; end if;
    perform public.reserve_owner_research_content_creation(p_owner,'owner_activity',1);
  end if;
end;
$$;
revoke all on function public.reserve_owner_activity_event(uuid,integer,boolean)
  from public,anon,authenticated,service_role;

create or replace function public.record_owner_local_activity(
  p_persona_id uuid,p_event_type text,p_subject_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_id uuid;v_summary text;v_subject_type text;
  v_provider text;v_account_persona uuid;v_key text;v_metadata jsonb;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(coalesce(p_metadata,'null'::jsonb))<>'object'
     or octet_length(coalesce(p_metadata,'{}'::jsonb)::text)>2048 then
    raise exception 'Activity metadata is malformed or too large';
  end if;
  perform public.lock_owner_research_content(v_owner);
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;
  if p_event_type='portal_opened' then
    if p_subject_id is null then raise exception 'Owned account subject is required'; end if;
    for v_key in select jsonb_object_keys(coalesce(p_metadata,'{}'::jsonb))
    loop
      if v_key not in ('account_ledger_id','provider') then
        raise exception 'Portal activity metadata contains unsupported fields';
      end if;
    end loop;
    select account.provider,account.persona_id into v_provider,v_account_persona
    from public.account_ledger account
    where account.id=p_subject_id and account.owner=v_owner;
    if not found or v_account_persona is distinct from p_persona_id then
      raise exception 'Owned persona account not found';
    end if;
    v_summary:='Opened '||left(coalesce(v_provider,'account'),80)||' management portal';
    v_subject_type:='account_ledger';
    v_metadata:=jsonb_build_object('account_ledger_id',p_subject_id,'provider',left(coalesce(v_provider,''),80));
  elsif p_event_type='ai_workroom_opened' then
    if p_subject_id is not null then raise exception 'AI workroom activity has no external subject'; end if;
    for v_key in select jsonb_object_keys(coalesce(p_metadata,'{}'::jsonb))
    loop
      if v_key not in ('provider','copied') then
        raise exception 'AI workroom metadata contains unsupported fields';
      end if;
    end loop;
    v_provider:=lower(coalesce(p_metadata->>'provider',''));
    if v_provider not in ('gemini','chatgpt','claude','grok','perplexity')
       or coalesce(p_metadata->>'copied','') not in ('prompt','image') then
      raise exception 'AI workroom activity is invalid';
    end if;
    v_summary:='Opened '||case v_provider when 'chatgpt' then 'ChatGPT'
      when 'gemini' then 'Gemini' when 'claude' then 'Claude'
      when 'grok' then 'Grok' else 'Perplexity' end||' manual workroom';
    v_subject_type:='';
    v_metadata:=jsonb_build_object('provider',v_provider,'copied',p_metadata->>'copied');
  else
    raise exception 'Owner-local activity type is not allowed';
  end if;
  perform public.reserve_owner_activity_event(v_owner,
    octet_length(p_event_type)+octet_length(v_summary)+octet_length(v_subject_type)+octet_length(v_metadata::text),true);
  insert into public.persona_activity_events(
    owner,persona_id,event_type,source,summary,subject_type,subject_id,metadata,
    occurred_at,created_at
  ) values(
    v_owner,p_persona_id,p_event_type,'owner',v_summary,v_subject_type,p_subject_id,
    v_metadata,now(),now()
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.mark_owner_content_variant_manually_posted(p_variant_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();v_variant public.persona_content_variants%rowtype;
  v_package public.persona_content_packages%rowtype;v_package_id uuid;v_complete boolean;
  v_metadata jsonb;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_owner_research_content(v_owner);
  select variant.package_id into v_package_id from public.persona_content_variants variant
  where variant.id=p_variant_id and variant.owner=v_owner;
  if not found then raise exception 'Owned content variant not found'; end if;
  select * into v_package from public.persona_content_packages package
  where package.id=v_package_id and package.owner=v_owner for update;
  if not found then raise exception 'Owned content package not found'; end if;
  select * into v_variant from public.persona_content_variants variant
  where variant.id=p_variant_id and variant.owner=v_owner for update;
  if v_variant.status='manually_posted' then
    return jsonb_build_object('variant_id',p_variant_id,'package_id',v_package_id,
      'variant_status',v_variant.status,'package_status',v_package.status);
  end if;
  if v_package.status not in ('approved','scheduled')
     or v_variant.status not in ('approved','scheduled')
     or v_variant.provider_id<>'' or v_variant.provider_url<>'' then
    raise exception 'Only an exact approved unposted variant can receive an owner attestation';
  end if;
  v_metadata:=jsonb_build_object('attestation','owner_manual','content_variant_id',p_variant_id,
    'package_id',v_package_id,'channel',v_variant.channel);
  perform public.reserve_owner_activity_event(v_owner,
    octet_length('manual_post_confirmed')+
    octet_length(v_variant.channel||' variant confirmed manually posted')+
    octet_length('content_variant')+octet_length(v_metadata::text),true);
  update public.persona_content_variants set status='manually_posted',updated_at=now()
  where id=p_variant_id and owner=v_owner;
  insert into public.persona_activity_events(
    owner,persona_id,event_type,source,summary,subject_type,subject_id,metadata,
    occurred_at,created_at
  ) values(
    v_owner,v_variant.persona_id,'manual_post_confirmed','owner',
    v_variant.channel||' variant confirmed manually posted','content_variant',
    p_variant_id,v_metadata,now(),now()
  );
  select count(*)=4 and bool_and(variant.status in ('manually_posted','published','skipped'))
  into v_complete from public.persona_content_variants variant
  where variant.package_id=v_package_id and variant.owner=v_owner;
  if coalesce(v_complete,false) then
    update public.persona_content_packages set
      status='completed',completed_at=coalesce(completed_at,now()),scheduled_for=null,updated_at=now()
    where id=v_package_id and owner=v_owner;
  end if;
  select * into v_package from public.persona_content_packages package
  where package.id=v_package_id and package.owner=v_owner;
  return jsonb_build_object('variant_id',p_variant_id,'package_id',v_package_id,
    'variant_status','manually_posted','package_status',v_package.status);
end;
$$;

create or replace function public.mark_owner_notifications_read(
  p_ids uuid[] default null,p_subject_type text default null,p_subject_id uuid default null
)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_count integer:=0;v_distinct integer;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_ids is not null then
    if p_subject_type is not null or p_subject_id is not null
       or cardinality(p_ids) not between 1 and 500 then
      raise exception 'Choose one bounded notification selector';
    end if;
    select count(distinct value) into v_distinct from unnest(p_ids) value;
    if v_distinct<>cardinality(p_ids) then raise exception 'Notification ids must be distinct'; end if;
  elsif p_subject_type is null or p_subject_id is null
     or char_length(p_subject_type) not between 1 and 80 then
    raise exception 'Choose one bounded notification selector';
  end if;
  perform public.lock_owner_research_content(v_owner);
  if p_ids is not null then
    with candidates as (
      select notification.id from public.owner_notifications notification
      where notification.owner=v_owner and notification.status='unread'
        and notification.id=any(p_ids)
      order by notification.id limit 500 for update
    )
    update public.owner_notifications notification set status='read',read_at=now(),updated_at=now()
    from candidates where notification.id=candidates.id;
  else
    with candidates as (
      select notification.id from public.owner_notifications notification
      where notification.owner=v_owner and notification.status='unread'
        and notification.subject_type=p_subject_type and notification.subject_id=p_subject_id
      order by notification.id limit 100 for update
    )
    update public.owner_notifications notification set status='read',read_at=now(),updated_at=now()
    from candidates where notification.id=candidates.id;
  end if;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

-- The only writer for provider receipt columns. It cannot be called with an
-- owner session, and timestamps/provenance are authored on the server.
create or replace function public.record_content_variant_provider_receipt_service(
  p_variant_id uuid,p_provider_id text,p_provider_url text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;v_package_id uuid;v_variant public.persona_content_variants%rowtype;
  v_package public.persona_content_packages%rowtype;v_complete boolean;v_metadata jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if char_length(trim(coalesce(p_provider_id,''))) not between 1 and 1000
     or octet_length(coalesce(p_provider_id,''))>4000
     or not public.is_safe_credential_free_https_url(coalesce(p_provider_url,''),false) then
    raise exception 'Provider receipt is invalid or too large';
  end if;
  select variant.owner,variant.package_id into v_owner,v_package_id
  from public.persona_content_variants variant where variant.id=p_variant_id;
  if not found then raise exception 'Content variant not found'; end if;
  perform public.lock_owner_research_content(v_owner);
  select * into v_package from public.persona_content_packages package
  where package.id=v_package_id and package.owner=v_owner for update;
  if not found then raise exception 'Content package not found'; end if;
  select * into v_variant from public.persona_content_variants variant
  where variant.id=p_variant_id and variant.owner=v_owner for update;
  if v_variant.status='published' and v_variant.provider_id=p_provider_id
     and v_variant.provider_url=p_provider_url then
    return jsonb_build_object('variant_id',p_variant_id,'package_id',v_package_id,'status','published');
  end if;
  if v_package.status not in ('approved','scheduled')
     or v_variant.status not in ('approved','scheduled')
     or v_variant.provider_id<>'' or v_variant.provider_url<>'' then
    raise exception 'Only an exact approved variant can receive a provider receipt';
  end if;
  v_metadata:=jsonb_build_object('content_variant_id',p_variant_id,'package_id',v_package_id,
    'channel',v_variant.channel,'provider_id',p_provider_id,'provider_url',p_provider_url);
  perform public.reserve_owner_activity_event(v_owner,
    octet_length('provider_publish_receipt')+
    octet_length(v_variant.channel||' provider publication receipt recorded')+
    octet_length('content_variant')+octet_length(v_metadata::text),false);
  update public.persona_content_variants set
    status='published',provider_id=p_provider_id,provider_url=p_provider_url,updated_at=now()
  where id=p_variant_id and owner=v_owner;
  insert into public.persona_activity_events(
    owner,persona_id,event_type,source,summary,subject_type,subject_id,metadata,
    occurred_at,created_at
  ) values(
    v_owner,v_variant.persona_id,'provider_publish_receipt','provider_receipt',
    v_variant.channel||' provider publication receipt recorded','content_variant',
    p_variant_id,v_metadata,now(),now()
  );
  select count(*)=4 and bool_and(variant.status in ('manually_posted','published','skipped'))
  into v_complete from public.persona_content_variants variant
  where variant.package_id=v_package_id and variant.owner=v_owner;
  if coalesce(v_complete,false) then
    update public.persona_content_packages set
      status='completed',completed_at=coalesce(completed_at,now()),scheduled_for=null,updated_at=now()
    where id=v_package_id and owner=v_owner;
  end if;
  return jsonb_build_object('variant_id',p_variant_id,'package_id',v_package_id,'status','published');
end;
$$;

-- Explicit ACL: public has no implicit EXECUTE; authenticated gets only owner
-- drafting/review transitions; service gets only bounded provenance writers.
revoke all on function public.save_research_brief(uuid,date,uuid,text,text,jsonb,jsonb,text),
  public.save_owner_research_settings(uuid,boolean,text,text,integer,uuid),
  public.set_owner_research_brief_status(uuid,text),
  public.approve_research_topic(uuid,text,text,date,text),
  public.reject_research_topic(uuid,text),
  public.save_owner_research_annotation(uuid,uuid,uuid,text,text,text,text,text,text,boolean),
  public.delete_owner_research_annotation(uuid),
  public.create_owner_content_package(uuid,uuid,uuid[],text,text,text,jsonb),
  public.save_owner_content_package_draft(uuid,text,text,jsonb),
  public.delete_owner_content_package_draft(uuid),
  public.approve_content_package(uuid),
  public.schedule_content_package(uuid,timestamptz,text),
  public.unschedule_content_package(uuid),
  public.record_owner_local_activity(uuid,text,uuid,jsonb),
  public.mark_owner_content_variant_manually_posted(uuid),
  public.mark_owner_notifications_read(uuid[],text,uuid),
  public.record_content_variant_provider_receipt_service(uuid,text,text)
  from public,anon,authenticated,service_role;

grant execute on function public.save_owner_research_settings(uuid,boolean,text,text,integer,uuid),
  public.set_owner_research_brief_status(uuid,text),
  public.approve_research_topic(uuid,text,text,date,text),
  public.reject_research_topic(uuid,text),
  public.save_owner_research_annotation(uuid,uuid,uuid,text,text,text,text,text,text,boolean),
  public.delete_owner_research_annotation(uuid),
  public.create_owner_content_package(uuid,uuid,uuid[],text,text,text,jsonb),
  public.save_owner_content_package_draft(uuid,text,text,jsonb),
  public.delete_owner_content_package_draft(uuid),
  public.approve_content_package(uuid),
  public.schedule_content_package(uuid,timestamptz,text),
  public.unschedule_content_package(uuid),
  public.record_owner_local_activity(uuid,text,uuid,jsonb),
  public.mark_owner_content_variant_manually_posted(uuid),
  public.mark_owner_notifications_read(uuid[],text,uuid)
  to authenticated;
grant execute on function public.save_research_brief(uuid,date,uuid,text,text,jsonb,jsonb,text),
  public.record_content_variant_provider_receipt_service(uuid,text,text)
  to service_role;

commit;
