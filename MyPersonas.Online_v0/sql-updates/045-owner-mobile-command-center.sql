-- 045-owner-mobile-command-center.sql
-- Owner-only briefing annotations, four-channel content kits, in-app review
-- notifications, and a MyPersonas-mediated activity trail.
--
-- Additive. No external provider write, cron, or push delivery is enabled here.
-- Apply only after reviewing and applying migration 044.

begin;

create extension if not exists pgcrypto with schema extensions;

-- Remove the deployment-specific backend UUID introduced by migration 044.
-- Research is opt-in and must resolve to a backend owned by the same owner.
update public.persona_research_settings s
set preferred_backend_id = null
where preferred_backend_id is not null
  and not exists (
    select 1 from public.ai_backends b
    where b.id = s.preferred_backend_id and b.owner = s.owner
  );

create or replace function public.auto_create_research_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.persona_research_settings (persona_id, owner, preferred_backend_id)
  values (new.id, new.owner, null)
  on conflict (persona_id) do nothing;
  return new;
end;
$$;

-- Website is a manually managed planning destination. It is deliberately not
-- added to post_drafts or any unattended publisher target list.
alter table public.persona_topic_post_plans
  drop constraint if exists persona_topic_post_plans_platform_check;
alter table public.persona_topic_post_plans
  add constraint persona_topic_post_plans_platform_check
  check (platform in ('','facebook','instagram','x','website','reddit','discord'));

-- Fix migration 044's owner-variable ambiguity and validate the platform before
-- creating an approval plan.
create or replace function public.approve_research_topic(
  p_topic_id uuid,
  p_post_type text default 'new',
  p_platform text default '',
  p_scheduled_for date default null,
  p_notes text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_persona_id uuid;
  v_plan_id uuid;
begin
  if v_caller is null then raise exception 'Authentication required'; end if;
  if p_post_type not in ('new','repost','remix','thread') then
    raise exception 'Invalid post type';
  end if;
  if p_platform not in ('','facebook','instagram','x','website','reddit','discord') then
    raise exception 'Invalid platform';
  end if;

  select t.persona_id into v_persona_id
  from public.persona_research_topics t
  where t.id = p_topic_id and t.owner = v_caller
  for update;
  if v_persona_id is null then raise exception 'Topic not found'; end if;

  update public.persona_research_topics
  set status = 'approved',
      approved_post_type = p_post_type,
      approved_platform = p_platform,
      approved_scheduled_for = p_scheduled_for,
      approved_notes = left(coalesce(p_notes,''), 4000),
      approved_at = now(),
      approved_by = v_caller,
      updated_at = now()
  where id = p_topic_id and owner = v_caller;

  insert into public.persona_topic_post_plans (
    owner, topic_id, persona_id, post_type, platform, scheduled_for,
    scheduled_time, status, notes
  ) values (
    v_caller, p_topic_id, v_persona_id, p_post_type, p_platform,
    p_scheduled_for, '09:00:00', 'planned', left(coalesce(p_notes,''), 4000)
  ) returning id into v_plan_id;

  return v_plan_id;
end;
$$;

-- ----------------------------------------------------------------------
-- Brief annotations
-- ----------------------------------------------------------------------
create unique index if not exists persona_research_briefs_id_owner_uidx
  on public.persona_research_briefs(id, owner);
create unique index if not exists persona_research_topics_id_owner_uidx
  on public.persona_research_topics(id, owner);

create table if not exists public.research_brief_annotations (
  id                    uuid primary key default gen_random_uuid(),
  owner                 uuid not null,
  persona_id            uuid not null references public.personas(id) on delete cascade,
  brief_id              uuid not null references public.persona_research_briefs(id) on delete cascade,
  topic_id              uuid references public.persona_research_topics(id) on delete cascade,
  annotation_type       text not null check (annotation_type in ('highlight','comment','image')),
  selected_text         text not null default '' check (char_length(selected_text) <= 4000),
  context_before        text not null default '' check (char_length(context_before) <= 500),
  context_after         text not null default '' check (char_length(context_after) <= 500),
  image_url             text not null default '' check (char_length(image_url) <= 2048),
  owner_comment         text not null default '' check (char_length(owner_comment) <= 4000),
  include_in_generation boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade,
  foreign key (brief_id, owner) references public.persona_research_briefs(id, owner) on delete cascade,
  foreign key (topic_id, owner) references public.persona_research_topics(id, owner) on delete cascade,
  check (
    (annotation_type = 'highlight' and selected_text <> '') or
    (annotation_type = 'comment' and owner_comment <> '') or
    (annotation_type = 'image' and image_url ~ '^https://')
  )
);

create index if not exists research_brief_annotations_owner_idx
  on public.research_brief_annotations(owner, created_at desc);
create index if not exists research_brief_annotations_brief_idx
  on public.research_brief_annotations(brief_id, created_at);

-- ----------------------------------------------------------------------
-- Four-channel content kits
-- ----------------------------------------------------------------------
create table if not exists public.persona_content_packages (
  id                uuid primary key default gen_random_uuid(),
  owner             uuid not null,
  persona_id        uuid not null references public.personas(id) on delete cascade,
  source_brief_id   uuid,
  source_topic_ids  uuid[] not null default '{}',
  title             text not null default '' check (char_length(title) <= 300),
  owner_guidance    text not null default '' check (char_length(owner_guidance) <= 6000),
  status            text not null default 'owner_review' check (status in
                      ('generating','owner_review','approved','scheduled','completed','rejected','archived')),
  scheduled_for     timestamptz,
  timezone          text not null default 'UTC' check (char_length(timezone) <= 80),
  approval_hash     text not null default '',
  approved_at       timestamptz,
  approved_by       uuid,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade,
  foreign key (source_brief_id, owner) references public.persona_research_briefs(id, owner) on delete cascade
);

create unique index if not exists persona_content_packages_id_owner_uidx
  on public.persona_content_packages(id, owner);

create table if not exists public.persona_content_variants (
  id                uuid primary key default gen_random_uuid(),
  owner             uuid not null,
  package_id        uuid not null references public.persona_content_packages(id) on delete cascade,
  persona_id        uuid not null references public.personas(id) on delete cascade,
  channel           text not null check (channel in ('x','instagram','facebook','website')),
  title             text not null default '' check (char_length(title) <= 300),
  body              text not null default '' check (char_length(body) <= 30000),
  description       text not null default '' check (char_length(description) <= 2000),
  alt_text          text not null default '' check (char_length(alt_text) <= 2000),
  media_plan        jsonb not null default '[]'::jsonb,
  status            text not null default 'draft' check (status in
                      ('draft','ready','approved','scheduled','manually_posted','published','skipped')),
  provider_id       text not null default '' check (char_length(provider_id) <= 1000),
  provider_url      text not null default '' check (char_length(provider_url) <= 2048),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (package_id, channel),
  foreign key (package_id, owner) references public.persona_content_packages(id, owner) on delete cascade,
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);

create index if not exists persona_content_packages_owner_idx
  on public.persona_content_packages(owner, status, created_at desc);
create index if not exists persona_content_packages_persona_idx
  on public.persona_content_packages(persona_id, created_at desc);
create index if not exists persona_content_packages_schedule_idx
  on public.persona_content_packages(scheduled_for)
  where status = 'scheduled';
create index if not exists persona_content_variants_package_idx
  on public.persona_content_variants(package_id, channel);

-- ----------------------------------------------------------------------
-- Account-wide in-app notifications and mediated activity receipts
-- ----------------------------------------------------------------------
create table if not exists public.owner_notifications (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null,
  persona_id    uuid references public.personas(id) on delete cascade,
  notification_type text not null check (notification_type in
                ('brief_ready','content_review','schedule_due','publish_attention','account_attention','system')),
  title         text not null check (char_length(title) <= 300),
  body          text not null default '' check (char_length(body) <= 2000),
  action_route  text not null default '' check (char_length(action_route) <= 300),
  subject_type  text not null default '' check (char_length(subject_type) <= 80),
  subject_id    uuid,
  dedupe_key    text not null default '' check (char_length(dedupe_key) <= 300),
  status        text not null default 'unread' check (status in ('unread','read','dismissed')),
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);

create unique index if not exists owner_notifications_dedupe_uidx
  on public.owner_notifications(owner, dedupe_key)
  where dedupe_key <> '';
create index if not exists owner_notifications_queue_idx
  on public.owner_notifications(owner, status, created_at desc);

create table if not exists public.persona_activity_events (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null,
  persona_id    uuid references public.personas(id) on delete cascade,
  event_type    text not null check (char_length(event_type) between 1 and 80),
  source        text not null default 'mypersonas' check (source in ('mypersonas','workroom_bridge','provider_receipt','owner')),
  summary       text not null check (char_length(summary) between 1 and 1000),
  subject_type  text not null default '' check (char_length(subject_type) <= 80),
  subject_id    uuid,
  metadata      jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);

create index if not exists persona_activity_events_owner_idx
  on public.persona_activity_events(owner, occurred_at desc);
create index if not exists persona_activity_events_persona_idx
  on public.persona_activity_events(persona_id, occurred_at desc);

-- ----------------------------------------------------------------------
-- RLS and grants
-- ----------------------------------------------------------------------
alter table public.research_brief_annotations enable row level security;
alter table public.persona_content_packages enable row level security;
alter table public.persona_content_variants enable row level security;
alter table public.owner_notifications enable row level security;
alter table public.persona_activity_events enable row level security;

create policy "owner all research annotations" on public.research_brief_annotations
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner all content packages" on public.persona_content_packages
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner all content variants" on public.persona_content_variants
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner all notifications" on public.owner_notifications
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner all activity events" on public.persona_activity_events
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

grant select, insert, update, delete on public.research_brief_annotations to authenticated;
grant select, insert, update, delete on public.persona_content_packages to authenticated;
grant select, insert, update, delete on public.persona_content_variants to authenticated;
grant select, insert, update, delete on public.owner_notifications to authenticated;
grant select, insert, update, delete on public.persona_activity_events to authenticated;

-- ----------------------------------------------------------------------
-- Timestamps and approval invalidation
-- ----------------------------------------------------------------------
create or replace function public.touch_owner_mobile_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'research_brief_annotations','persona_content_packages',
    'persona_content_variants','owner_notifications'
  ] loop
    execute format('drop trigger if exists touch_owner_mobile_updated_at on public.%I', v_table);
    execute format(
      'create trigger touch_owner_mobile_updated_at before update on public.%I '
      'for each row execute function public.touch_owner_mobile_updated_at()',
      v_table
    );
  end loop;
end;
$$;

create or replace function public.invalidate_content_package_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_package_id uuid := coalesce(new.package_id, old.package_id);
begin
  update public.persona_content_packages p
  set status = 'owner_review', scheduled_for = null, approval_hash = '',
      approved_at = null, approved_by = null, updated_at = now()
  where p.id = v_package_id and p.status in ('approved','scheduled');
  return coalesce(new, old);
end;
$$;

drop trigger if exists invalidate_content_package_approval on public.persona_content_variants;
create trigger invalidate_content_package_approval
after insert or update of title,body,description,alt_text,media_plan or delete
on public.persona_content_variants
for each row execute function public.invalidate_content_package_approval();

create or replace function public.guard_content_package_material_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('approved','scheduled') and (
    new.title is distinct from old.title or
    new.owner_guidance is distinct from old.owner_guidance or
    new.source_brief_id is distinct from old.source_brief_id or
    new.source_topic_ids is distinct from old.source_topic_ids
  ) then
    new.status := 'owner_review';
    new.scheduled_for := null;
    new.approval_hash := '';
    new.approved_at := null;
    new.approved_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_content_package_material_edit on public.persona_content_packages;
create trigger guard_content_package_material_edit
before update of title,owner_guidance,source_brief_id,source_topic_ids
on public.persona_content_packages
for each row execute function public.guard_content_package_material_edit();

create or replace function public.content_package_hash(p_package_id uuid)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(coalesce(string_agg(
    v.channel || chr(30) || v.title || chr(30) || v.body || chr(30) ||
    v.description || chr(30) || v.alt_text || chr(30) || v.media_plan::text,
    chr(29) order by v.channel
  ), ''), 'UTF8'), 'sha256'), 'hex')
  from public.persona_content_variants v
  where v.package_id = p_package_id;
$$;

revoke all on function public.content_package_hash(uuid) from public, anon, authenticated;
grant execute on function public.content_package_hash(uuid) to service_role;

create or replace function public.approve_content_package(p_package_id uuid)
returns public.persona_content_packages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_package public.persona_content_packages%rowtype;
  v_hash text;
  v_channels text[];
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select * into v_package from public.persona_content_packages
  where id = p_package_id and owner = v_owner for update;
  if not found then raise exception 'Content package not found'; end if;

  select array_agg(channel order by channel) into v_channels
  from public.persona_content_variants
  where package_id = p_package_id and owner = v_owner and body <> '';
  if v_channels is distinct from array['facebook','instagram','website','x']::text[] then
    raise exception 'A complete X, Instagram, Facebook, and website kit is required';
  end if;

  select public.content_package_hash(p_package_id) into v_hash;
  update public.persona_content_packages
  set status = 'approved', approval_hash = v_hash,
      approved_at = now(), approved_by = v_owner,
      scheduled_for = null, updated_at = now()
  where id = p_package_id
  returning * into v_package;

  update public.persona_content_variants
  set status = 'approved', updated_at = now()
  where package_id = p_package_id and owner = v_owner;
  return v_package;
end;
$$;

create or replace function public.schedule_content_package(
  p_package_id uuid,
  p_scheduled_for timestamptz,
  p_timezone text
)
returns public.persona_content_packages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_package public.persona_content_packages%rowtype;
  v_hash text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_scheduled_for is null or p_scheduled_for <= now() then
    raise exception 'Choose a future schedule time';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'Invalid time zone';
  end if;

  select * into v_package from public.persona_content_packages
  where id = p_package_id and owner = v_owner for update;
  if not found then raise exception 'Content package not found'; end if;
  if v_package.status <> 'approved' then
    raise exception 'Approve the exact content package before scheduling';
  end if;

  select public.content_package_hash(p_package_id) into v_hash;
  if v_package.approval_hash = '' or v_hash <> v_package.approval_hash then
    raise exception 'Content changed after approval; review and approve it again';
  end if;

  update public.persona_content_packages
  set status = 'scheduled', scheduled_for = p_scheduled_for,
      timezone = p_timezone, updated_at = now()
  where id = p_package_id
  returning * into v_package;
  update public.persona_content_variants
  set status = 'scheduled', updated_at = now()
  where package_id = p_package_id and owner = v_owner;
  return v_package;
end;
$$;

create or replace function public.unschedule_content_package(p_package_id uuid)
returns public.persona_content_packages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_package public.persona_content_packages%rowtype;
begin
  update public.persona_content_packages
  set status = 'owner_review', scheduled_for = null, approval_hash = '',
      approved_at = null, approved_by = null, updated_at = now()
  where id = p_package_id and owner = v_owner and status = 'scheduled'
  returning * into v_package;
  if not found then raise exception 'Scheduled content package not found'; end if;
  update public.persona_content_variants
  set status = 'ready', updated_at = now()
  where package_id = p_package_id and owner = v_owner;
  return v_package;
end;
$$;

grant execute on function public.approve_content_package(uuid) to authenticated;
grant execute on function public.schedule_content_package(uuid,timestamptz,text) to authenticated;
grant execute on function public.unschedule_content_package(uuid) to authenticated;

-- ----------------------------------------------------------------------
-- Notification and activity triggers
-- ----------------------------------------------------------------------
create or replace function public.notify_new_research_brief()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_name text;
begin
  select name into v_name from public.personas where id = new.persona_id;
  insert into public.owner_notifications (
    owner, persona_id, notification_type, title, body, action_route,
    subject_type, subject_id, dedupe_key
  ) values (
    new.owner, new.persona_id, 'brief_ready',
    'Brief ready for ' || coalesce(v_name, 'persona'),
    left(coalesce(new.executive_summary,''), 2000),
    'briefs/' || new.id, 'research_brief', new.id, 'brief:' || new.id
  ) on conflict do nothing;
  insert into public.persona_activity_events (
    owner, persona_id, event_type, summary, subject_type, subject_id
  ) values (
    new.owner, new.persona_id, 'brief_created',
    'Research briefing added for owner review', 'research_brief', new.id
  );
  return new;
end;
$$;

drop trigger if exists notify_new_research_brief on public.persona_research_briefs;
create trigger notify_new_research_brief
after insert on public.persona_research_briefs
for each row execute function public.notify_new_research_brief();

create or replace function public.notify_content_package_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'owner_review' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    insert into public.owner_notifications (
      owner, persona_id, notification_type, title, body, action_route,
      subject_type, subject_id, dedupe_key
    ) values (
      new.owner, new.persona_id, 'content_review',
      'Four-channel content kit needs review', left(new.title, 2000),
      'schedule/' || new.id, 'content_package', new.id, 'content:' || new.id
    ) on conflict do nothing;
    insert into public.persona_activity_events (
      owner, persona_id, event_type, summary, subject_type, subject_id
    ) values (
      new.owner, new.persona_id, 'content_review_requested',
      'Four-channel content kit is ready for owner review', 'content_package', new.id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists notify_content_package_review on public.persona_content_packages;
create trigger notify_content_package_review
after insert or update of status on public.persona_content_packages
for each row execute function public.notify_content_package_review();

-- Seed only recent unread briefs; never generate old notification noise.
insert into public.owner_notifications (
  owner, persona_id, notification_type, title, body, action_route,
  subject_type, subject_id, dedupe_key, created_at
)
select b.owner, b.persona_id, 'brief_ready',
       'Brief ready for ' || coalesce(p.name, 'persona'),
       left(coalesce(b.executive_summary,''), 2000),
       'briefs/' || b.id, 'research_brief', b.id, 'brief:' || b.id, b.created_at
from public.persona_research_briefs b
join public.personas p on p.id = b.persona_id
where b.status = 'new' and b.created_at >= now() - interval '30 days'
on conflict do nothing;

commit;

-- Verification (owner test account only):
-- select status, count(*) from owner_notifications group by status;
-- select channel, count(*) from persona_content_variants group by channel;
-- Verify an unrelated authenticated account cannot read any row above.
