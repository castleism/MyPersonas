-- ======================================================================
-- Migration 044: Persona Research Briefs
-- Daily Gemini research → topic approval → weekly content pipeline
-- ======================================================================

-- 1. persona_research_settings
create table if not exists public.persona_research_settings (
  persona_id              uuid not null references public.personas(id) on delete cascade,
  owner                   uuid not null,
  research_enabled        boolean not null default false,
  brief_frequency         text not null default 'daily' check (brief_frequency in ('daily','weekly','manual')),
  research_depth          text not null default 'standard' check (research_depth in ('quick','standard','deep')),
  preferred_backend_id    uuid,
  source_types            text[] not null default '{}'::text[],
  novelty_threshold       int not null default 5,
  max_findings_per_brief  int not null default 5,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (persona_id)
);

insert into public.persona_research_settings (persona_id, owner, preferred_backend_id)
select p.id, p.owner, 'ab285482-91cc-48ea-b67f-956179dea432'
from public.personas p
on conflict (persona_id) do nothing;

create or replace function public.auto_create_research_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.persona_research_settings (persona_id, owner, preferred_backend_id)
  values (new.id, new.owner, 'ab285482-91cc-48ea-b67f-956179dea432')
  on conflict (persona_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_auto_research_settings on public.personas;
create trigger trg_auto_research_settings
  after insert on public.personas
  for each row execute function public.auto_create_research_settings();

-- 2. persona_research_briefs
create table if not exists public.persona_research_briefs (
  id                  uuid not null default gen_random_uuid() primary key,
  owner               uuid not null,
  persona_id          uuid not null references public.personas(id) on delete cascade,
  brief_date          date not null default current_date,
  backend_id          uuid,
  model               text not null default '',
  executive_summary   text not null default '',
  key_findings        jsonb not null default '[]'::jsonb,
  sources             jsonb not null default '[]'::jsonb,
  finding_count       int not null default 0,
  status              text not null default 'new' check (status in ('new','reviewed','archived')),
  raw_response        text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- 3. persona_research_topics
create table if not exists public.persona_research_topics (
  id                      uuid not null default gen_random_uuid() primary key,
  owner                   uuid not null,
  brief_id                uuid not null references public.persona_research_briefs(id) on delete cascade,
  persona_id              uuid not null references public.personas(id) on delete cascade,
  title                   text not null,
  summary                 text not null default '',
  why_it_matters          text not null default '',
  novelty_score           int not null default 5 check (novelty_score between 1 and 10),
  relevance_score         int not null default 5 check (relevance_score between 1 and 10),
  source_urls             text[] not null default '{}',
  source_type             text not null default '' check (source_type in ('','research_paper','news_article','industry_report','social_trend','product_launch')),
  needs_verification      boolean not null default false,
  suggested_post_angle    text not null default '',
  suggested_post_type     text not null default 'new' check (suggested_post_type in ('new','repost','remix','thread')),
  status                  text not null default 'new' check (status in ('new','approved','rejected','drafted','scheduled','archived')),
  rejection_reason        text not null default '',
  approved_post_type      text,
  approved_platform       text,
  approved_scheduled_for  date,
  approved_notes          text not null default '',
  approved_at             timestamptz,
  approved_by             uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- 4. persona_topic_post_plans
create table if not exists public.persona_topic_post_plans (
  id                  uuid not null default gen_random_uuid() primary key,
  owner               uuid not null,
  topic_id            uuid not null references public.persona_research_topics(id) on delete cascade,
  persona_id          uuid not null references public.personas(id) on delete cascade,
  post_type           text not null default 'new' check (post_type in ('new','repost','remix','thread')),
  platform            text not null default '' check (platform in ('','facebook','instagram','x','reddit','discord')),
  scheduled_for       date,
  scheduled_time      time without time zone default '09:00:00',
  post_draft_id       uuid,
  status              text not null default 'planned' check (status in ('planned','drafted','scheduled','posted','failed','cancelled')),
  notes               text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Indexes
create index if not exists idx_research_briefs_persona on public.persona_research_briefs(persona_id);
create index if not exists idx_research_briefs_date on public.persona_research_briefs(brief_date);
create index if not exists idx_research_briefs_status on public.persona_research_briefs(status);
create index if not exists idx_research_topics_brief on public.persona_research_topics(brief_id);
create index if not exists idx_research_topics_persona on public.persona_research_topics(persona_id);
create index if not exists idx_research_topics_status on public.persona_research_topics(status);
create index if not exists idx_research_topics_novelty on public.persona_research_topics(novelty_score desc);
create index if not exists idx_topic_plans_topic on public.persona_topic_post_plans(topic_id);
create index if not exists idx_topic_plans_persona on public.persona_topic_post_plans(persona_id);
create index if not exists idx_topic_plans_status on public.persona_topic_post_plans(status);
create index if not exists idx_topic_plans_scheduled on public.persona_topic_post_plans(scheduled_for);
create index if not exists idx_research_settings_persona on public.persona_research_settings(persona_id);

-- updated_at triggers
do $$
declare t text;
begin
  for t in select unnest(array['persona_research_settings','persona_research_briefs','persona_research_topics','persona_topic_post_plans'])
  loop
    execute format('drop trigger if exists trg_%I_touch on public.%I', t, t);
    execute format('create trigger trg_%I_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- RLS
alter table public.persona_research_settings  enable row level security;
alter table public.persona_research_briefs    enable row level security;
alter table public.persona_research_topics    enable row level security;
alter table public.persona_topic_post_plans   enable row level security;

create policy "owner read research settings"  on public.persona_research_settings  for select using (owner = auth.uid());
create policy "owner write research settings" on public.persona_research_settings  for all    using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner read briefs"   on public.persona_research_briefs   for select using (owner = auth.uid());
create policy "owner write briefs"  on public.persona_research_briefs   for all    using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner read topics"   on public.persona_research_topics   for select using (owner = auth.uid());
create policy "owner write topics"  on public.persona_research_topics   for all    using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner read plans"    on public.persona_topic_post_plans  for select using (owner = auth.uid());
create policy "owner write plans"   on public.persona_topic_post_plans  for all    using (owner = auth.uid()) with check (owner = auth.uid());

-- RPCs

create or replace function public.save_research_brief(
  p_persona_id uuid,
  p_brief_date date,
  p_backend_id uuid,
  p_model text,
  p_executive_summary text,
  p_key_findings jsonb,
  p_sources jsonb,
  p_raw_response text
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_brief_id uuid;
  v_topic_id uuid;
  v_finding jsonb;
begin
  select owner into v_owner from public.personas where id = p_persona_id;
  if v_owner is null then raise exception 'Persona not found'; end if;

  insert into public.persona_research_briefs (
    owner, persona_id, brief_date, backend_id, model,
    executive_summary, key_findings, sources, finding_count, status, raw_response
  ) values (
    v_owner, p_persona_id, p_brief_date, p_backend_id, p_model,
    p_executive_summary, p_key_findings, p_sources,
    jsonb_array_length(p_key_findings), 'new', p_raw_response
  )
  returning id into v_brief_id;

  for v_finding in select * from jsonb_array_elements(p_key_findings)
  loop
    insert into public.persona_research_topics (
      owner, brief_id, persona_id,
      title, summary, why_it_matters,
      novelty_score, relevance_score,
      source_urls, source_type, needs_verification,
      suggested_post_angle, suggested_post_type, status
    ) values (
      v_owner, v_brief_id, p_persona_id,
      v_finding->>'title',
      v_finding->>'summary',
      v_finding->>'why_it_matters',
      coalesce((v_finding->>'novelty_score')::int, 5),
      coalesce((v_finding->>'relevance_score')::int, 5),
      coalesce(ARRAY(SELECT jsonb_array_elements_text(v_finding->'source_urls')), '{}'),
      v_finding->>'source_type',
      coalesce((v_finding->>'needs_verification')::boolean, false),
      v_finding->>'suggested_post_angle',
      coalesce(v_finding->>'suggested_post_type', 'new'),
      'new'
    )
    returning id into v_topic_id;
  end loop;

  return v_brief_id;
end;
$$;

create or replace function public.owner_research_brief_queue(
  p_date_filter date default null,
  p_status_filter text default null
)
returns table (
  id uuid,
  brief_date date,
  persona_id uuid,
  persona_name text,
  persona_handle text,
  executive_summary text,
  finding_count int,
  status text,
  created_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  select
    b.id, b.brief_date, b.persona_id, p.name, p.handle,
    b.executive_summary, b.finding_count, b.status, b.created_at
  from public.persona_research_briefs b
  join public.personas p on p.id = b.persona_id
  where b.owner = auth.uid()
    and (p_date_filter is null or b.brief_date = p_date_filter)
    and (p_status_filter is null or b.status = p_status_filter)
  order by b.brief_date desc, p.handle;
$$;

create or replace function public.approve_research_topic(
  p_topic_id uuid,
  p_post_type text default 'new',
  p_platform text default '',
  p_scheduled_for date default null,
  p_notes text default ''
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_persona_id uuid;
  v_plan_id uuid;
  v_suggested_time time := '09:00:00';
begin
  v_owner := auth.uid();
  if v_owner is null then raise exception 'Authentication required'; end if;

  select t.owner, t.persona_id into v_owner, v_persona_id
  from public.persona_research_topics t
  where t.id = p_topic_id and t.owner = v_owner;
  if v_persona_id is null then raise exception 'Topic not found'; end if;

  if p_post_type not in ('new','repost','remix','thread') then
    raise exception 'Invalid post type';
  end if;

  update public.persona_research_topics
  set status = 'approved',
      approved_post_type = p_post_type,
      approved_platform = p_platform,
      approved_scheduled_for = p_scheduled_for,
      approved_notes = p_notes,
      approved_at = now(),
      approved_by = auth.uid(),
      updated_at = now()
  where id = p_topic_id;

  insert into public.persona_topic_post_plans (
    owner, topic_id, persona_id,
    post_type, platform, scheduled_for, scheduled_time, status, notes
  ) values (
    v_owner, p_topic_id, v_persona_id,
    p_post_type, p_platform, p_scheduled_for, v_suggested_time,
    'planned', p_notes
  )
  returning id into v_plan_id;

  return v_plan_id;
end;
$$;

create or replace function public.reject_research_topic(
  p_topic_id uuid,
  p_reason text default ''
)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.persona_research_topics
  set status = 'rejected', rejection_reason = p_reason, updated_at = now()
  where id = p_topic_id and owner = auth.uid();
  if not found then raise exception 'Topic not found'; end if;
end;
$$;

create or replace function public.get_research_digest(
  p_persona_id uuid,
  p_days int default 7
)
returns table (
  persona_id uuid,
  persona_name text,
  persona_handle text,
  total_briefs bigint,
  total_topics bigint,
  approved_topics bigint,
  new_topics bigint,
  rejected_topics bigint,
  avg_novelty numeric,
  top_topics jsonb
)
language sql security definer stable set search_path = '' as $$
  with topic_stats as (
    select
      count(*) as total_topics,
      count(*) filter (where status = 'approved') as approved,
      count(*) filter (where status = 'new') as new_topics,
      count(*) filter (where status = 'rejected') as rejected,
      round(avg(novelty_score)::numeric, 1) as avg_novelty
    from public.persona_research_topics
    where persona_id = p_persona_id
      and owner = auth.uid()
      and created_at >= current_date - p_days
  ),
  top as (
    select jsonb_agg(jsonb_build_object(
      'topic_id', t.id,
      'title', t.title,
      'novelty_score', t.novelty_score,
      'relevance_score', t.relevance_score,
      'status', t.status,
      'suggested_post_type', t.suggested_post_type,
      'suggested_post_angle', t.suggested_post_angle
    ) order by t.novelty_score desc) as topics
    from public.persona_research_topics t
    where t.persona_id = p_persona_id
      and t.owner = auth.uid()
      and t.created_at >= current_date - p_days
    limit 10
  )
  select
    p_persona_id, p.name, p.handle,
    (select count(*) from public.persona_research_briefs
     where persona_id = p_persona_id and owner = auth.uid()
       and brief_date >= current_date - p_days),
    s.total_topics, s.approved, s.new_topics, s.rejected, s.avg_novelty,
    coalesce((select topics from top), '[]'::jsonb)
  from public.personas p, topic_stats s
  where p.id = p_persona_id;
$$;

grant execute on function public.owner_research_brief_queue(date,text) to authenticated;
grant execute on function public.approve_research_topic(uuid,text,text,date,text) to authenticated;
grant execute on function public.reject_research_topic(uuid,text) to authenticated;
grant execute on function public.get_research_digest(uuid,int) to authenticated;
grant execute on function public.save_research_brief(uuid,date,uuid,text,text,jsonb,jsonb,text) to service_role;;
