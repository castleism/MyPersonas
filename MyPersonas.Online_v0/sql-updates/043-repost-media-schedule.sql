-- ======================================================================
-- Migration 043: Repost + Media + Schedule Scaffolding
-- Phase 5 of the Weekend Command Center Plan
--
-- Adds:
-- 1. persona_reposts — cross-persona repost/reshare tracking with attribution
-- 2. persona_media_assets — general media library (post images, not character concepts)
-- 3. RPCs for content calendar view and repost management
--
-- Builds ON TOP of existing:
--   - ai_tasks (scheduling already exists)
--   - post_drafts (approval gate)
--   - concept_images (character image storage)
--   - run-post-queue / run-publish-queue edge functions
--
-- No auto-publishing. All reposts go through owner approval.
-- Covers ALL 28 personas.
-- ======================================================================

-- ======================================================================
-- 1. persona_reposts — track when one persona reposts another's content
-- ======================================================================
create table if not exists public.persona_reposts (
  id                  uuid not null default gen_random_uuid() primary key,
  owner               uuid not null,
  persona_id          uuid not null references public.personas(id) on delete cascade,
  source_persona_id   uuid references public.personas(id) on delete set null,
  source_post_draft_id uuid references public.post_drafts(id) on delete set null,
  source_url          text not null default '',
  source_platform     text not null default '',
  attribution_text    text not null default '',
  repost_type         text not null default 'quote' check (repost_type in ('quote','share','remix','response')),
  status              text not null default 'draft' check (status in ('draft','queued','posted','archived')),
  post_draft_id       uuid references public.post_drafts(id) on delete set null,
  notes               text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ======================================================================
-- 2. persona_media_assets — general media library for post content
-- ======================================================================
create table if not exists public.persona_media_assets (
  id              uuid not null default gen_random_uuid() primary key,
  owner           uuid not null,
  persona_id      uuid not null references public.personas(id) on delete cascade,
  post_draft_id   uuid references public.post_drafts(id) on delete set null,
  media_type      text not null default 'image' check (media_type in ('image','video','audio','document')),
  storage_path    text not null default '',
  public_url      text not null default '',
  alt_text        text not null default '',
  caption         text not null default '',
  source          text not null default 'generated' check (source in ('generated','uploaded','sourced','remixed')),
  generation_prompt text not null default '',
  generation_backend uuid,
  tags            text[] not null default '{}',
  metadata        jsonb not null default '{}'::jsonb,
  status          text not null default 'active' check (status in ('active','archived','flagged')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ======================================================================
-- Indexes
-- ======================================================================
create index if not exists idx_reposts_persona   on public.persona_reposts(persona_id);
create index if not exists idx_reposts_source     on public.persona_reposts(source_persona_id);
create index if not exists idx_reposts_status     on public.persona_reposts(status);
create index if not exists idx_media_persona      on public.persona_media_assets(persona_id);
create index if not exists idx_media_draft         on public.persona_media_assets(post_draft_id);
create index if not exists idx_media_status        on public.persona_media_assets(status);
create index if not exists idx_media_type         on public.persona_media_assets(media_type);

-- ======================================================================
-- updated_at triggers
-- ======================================================================
do $$
declare t text;
begin
  for t in select unnest(array['persona_reposts','persona_media_assets'])
  loop
    execute format('drop trigger if exists trg_%I_touch on public.%I', t, t);
    execute format(
      'create trigger trg_%I_touch before update on public.%I '
      'for each row execute function public.touch_updated_at()',
      t, t
    );
  end loop;
end $$;

-- ======================================================================
-- Row Level Security
-- ======================================================================
alter table public.persona_reposts      enable row level security;
alter table public.persona_media_assets  enable row level security;

-- Owner-only policies
create policy "owner read reposts"  on public.persona_reposts      for select using (owner = auth.uid());
create policy "owner write reposts" on public.persona_reposts      for all    using (owner = auth.uid()) with check (owner = auth.uid());

create policy "owner read media"   on public.persona_media_assets for select using (owner = auth.uid());
create policy "owner write media"  on public.persona_media_assets for all    using (owner = auth.uid()) with check (owner = auth.uid());

-- ======================================================================
-- RPCs
-- ======================================================================

-- 1. create_repost — creates a repost draft linking source and target personas
create or replace function public.create_repost(
  p_persona_id uuid,
  p_source_persona_id uuid default null,
  p_source_url text default '',
  p_source_platform text default '',
  p_attribution_text text default '',
  p_repost_type text default 'quote',
  p_notes text default ''
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_persona_owner uuid;
  v_source_owner uuid;
  v_repost_id uuid;
begin
  v_owner := auth.uid();
  if v_owner is null then raise exception 'Authentication required'; end if;

  -- Validate persona belongs to caller
  select owner into v_persona_owner from public.personas where id = p_persona_id;
  if v_persona_owner is null then raise exception 'Persona not found'; end if;
  if v_persona_owner <> v_owner then raise exception 'Persona does not belong to you'; end if;

  -- Validate source persona if provided
  if p_source_persona_id is not null then
    select owner into v_source_owner from public.personas where id = p_source_persona_id;
    if v_source_owner is null then raise exception 'Source persona not found'; end if;
    if v_source_owner <> v_owner then raise exception 'Source persona does not belong to you'; end if;
  end if;

  if p_repost_type not in ('quote','share','remix','response') then
    raise exception 'Invalid repost type';
  end if;

  insert into public.persona_reposts (
    owner, persona_id, source_persona_id, source_url, source_platform,
    attribution_text, repost_type, status, notes
  ) values (
    v_owner, p_persona_id, p_source_persona_id, p_source_url, p_source_platform,
    p_attribution_text, p_repost_type, 'draft', p_notes
  )
  returning id into v_repost_id;

  return v_repost_id;
end;
$$;

-- 2. link_repost_to_draft — connect a repost to a post draft
create or replace function public.link_repost_to_draft(
  p_repost_id uuid,
  p_draft_id uuid
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_draft_owner uuid;
begin
  v_owner := auth.uid();
  if v_owner is null then raise exception 'Authentication required'; end if;

  select owner into v_owner from public.persona_reposts where id = p_repost_id and owner = v_owner;
  if not found then raise exception 'Repost not found'; end if;

  select owner into v_draft_owner from public.post_drafts where id = p_draft_id;
  if v_draft_owner is null then raise exception 'Draft not found'; end if;
  if v_draft_owner <> v_owner then raise exception 'Draft belongs to a different owner'; end if;

  update public.persona_reposts
  set post_draft_id = p_draft_id, status = 'queued', updated_at = now()
  where id = p_repost_id;
end;
$$;

-- 3. get_content_calendar — aggregated view of all scheduled content
--    Returns upcoming scheduled tasks + approved drafts across all personas
create or replace function public.get_content_calendar(
  p_days_ahead int default 7
)
returns table (
  cal_date date,
  persona_id uuid,
  persona_name text,
  persona_handle text,
  item_type text,
  task_name text,
  content_kind text,
  platform text,
  scheduled_time text,
  status text,
  draft_id uuid,
  task_id uuid
)
language sql security definer stable set search_path = '' as $$
  -- Scheduled ai_tasks
  select
    d.cal_date,
    t.persona_id,
    p.name,
    p.handle,
    'scheduled_task' as item_type,
    t.name as task_name,
    t.content_kind,
    t.destination as platform,
    to_char(t.schedule_time, 'HH24:MI') as scheduled_time,
    t.last_status as status,
    null::uuid as draft_id,
    t.id as task_id
  from generate_series(
    current_date,
    current_date + (p_days_ahead - 1),
    '1 day'::interval
  ) as d(cal_date)
  join public.ai_tasks t on
    t.active = true and
    t.owner = auth.uid() and
    (
      (t.cadence = 'daily') or
      (t.cadence = 'weekly' and extract(dow from d.cal_date) = coalesce(t.schedule_day, extract(dow from current_date))) or
      (t.cadence = 'manual' and t.next_run_at::date = d.cal_date)
    )
  join public.personas p on p.id = t.persona_id

  union all

  -- Approved post drafts
  select
    coalesce(pd.approved_at::date, pd.updated_at::date) as cal_date,
    pd.persona_id,
    p.name,
    p.handle,
    'post_draft' as item_type,
    left(coalesce(pd.brief, ''), 60) as task_name,
    '' as content_kind,
    '' as platform,
    to_char(pd.approved_at, 'HH24:MI') as scheduled_time,
    pd.status,
    pd.id as draft_id,
    null::uuid as task_id
  from public.post_drafts pd
  join public.personas p on p.id = pd.persona_id
  where pd.owner = auth.uid()
    and pd.status in ('approved','posted')
    and coalesce(pd.approved_at, pd.updated_at) >= current_date
    and coalesce(pd.approved_at, pd.updated_at) < current_date + p_days_ahead

  order by cal_date, scheduled_time;
$$;

-- 4. add_media_asset — add a media asset to a persona's library
create or replace function public.add_media_asset(
  p_persona_id uuid,
  p_media_type text default 'image',
  p_storage_path text default '',
  p_public_url text default '',
  p_alt_text text default '',
  p_caption text default '',
  p_source text default 'generated',
  p_generation_prompt text default '',
  p_generation_backend uuid default null,
  p_tags text[] default '{}',
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_persona_owner uuid;
  v_asset_id uuid;
begin
  v_owner := auth.uid();
  if v_owner is null then raise exception 'Authentication required'; end if;

  select owner into v_persona_owner from public.personas where id = p_persona_id;
  if v_persona_owner is null then raise exception 'Persona not found'; end if;
  if v_persona_owner <> v_owner then raise exception 'Persona does not belong to you'; end if;

  if p_media_type not in ('image','video','audio','document') then
    raise exception 'Invalid media type';
  end if;
  if p_source not in ('generated','uploaded','sourced','remixed') then
    raise exception 'Invalid source';
  end if;

  insert into public.persona_media_assets (
    owner, persona_id, media_type, storage_path, public_url,
    alt_text, caption, source, generation_prompt, generation_backend,
    tags, metadata
  ) values (
    v_owner, p_persona_id, p_media_type, p_storage_path, p_public_url,
    p_alt_text, p_caption, p_source, p_generation_prompt, p_generation_backend,
    p_tags, p_metadata
  )
  returning id into v_asset_id;

  return v_asset_id;
end;
$$;

-- 5. get_persona_media_library — get all media for a persona
create or replace function public.get_persona_media_library(
  p_persona_id uuid,
  p_media_type text default null
)
returns table (
  id uuid,
  media_type text,
  storage_path text,
  public_url text,
  alt_text text,
  caption text,
  source text,
  tags text[],
  status text,
  created_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  select
    m.id, m.media_type, m.storage_path, m.public_url,
    m.alt_text, m.caption, m.source, m.tags, m.status, m.created_at
  from public.persona_media_assets m
  where m.owner = auth.uid()
    and m.persona_id = p_persona_id
    and (p_media_type is null or m.media_type = p_media_type)
    and m.status = 'active'
  order by m.created_at desc;
$$;

-- ======================================================================
-- Grant permissions
-- ======================================================================
grant execute on function public.create_repost(uuid,uuid,text,text,text,text,text) to authenticated;
grant execute on function public.link_repost_to_draft(uuid,uuid) to authenticated;
grant execute on function public.get_content_calendar(int) to authenticated;
grant execute on function public.add_media_asset(uuid,text,text,text,text,text,text,text,uuid,text[],jsonb) to authenticated;
grant execute on function public.get_persona_media_library(uuid,text) to authenticated;

-- ======================================================================
-- Verification queries
-- ======================================================================
-- Verify tables exist:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('persona_reposts','persona_media_assets');
--
-- Verify NO public policies:
--   SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('persona_reposts','persona_media_assets')
--     AND policyname LIKE 'public%';
--   Should return 0 rows.
