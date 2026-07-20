-- MyPersonas agent control plane: bindings, direction, precise schedules,
-- approval/publish state, synced owner chat, audit history, and fan-chat inbox.
-- Additive migration. External publishing remains gated by verified claims,
-- connected accounts, write scopes, and an implemented official connector.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;

create unique index if not exists personas_id_owner_idx
  on public.personas (id, owner);

-- AI provider credentials are accepted once through an owner-authenticated RPC,
-- encrypted in Supabase Vault, and resolved only by service-role Edge Functions.
-- The legacy api_key column is retained empty for compatibility during rollout.
revoke select on public.ai_backends from authenticated;
grant select (id, owner, name, base_url, model, provider, extra, created_at)
  on public.ai_backends to authenticated;
revoke insert, update, delete on public.ai_backends from authenticated;

create table if not exists public.ai_backend_credentials (
  backend_id uuid primary key references public.ai_backends(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ai_backend_credentials enable row level security;
revoke all on public.ai_backend_credentials from anon, authenticated;
grant all on public.ai_backend_credentials to service_role;

create or replace function public.delete_ai_backend_vault_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;
drop trigger if exists ai_backend_credentials_delete_vault_secret
  on public.ai_backend_credentials;
create trigger ai_backend_credentials_delete_vault_secret
  after delete on public.ai_backend_credentials
  for each row execute function public.delete_ai_backend_vault_secret();

create or replace function public.create_ai_backend(
  p_provider text,
  p_name text,
  p_base_url text,
  p_api_key text,
  p_model text,
  p_extra jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_backend_id uuid;
  v_secret_id uuid;
  v_secret_name text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if trim(coalesce(p_name,'')) = '' or char_length(p_name) > 160 then
    raise exception 'Model connection name is required';
  end if;
  if char_length(coalesce(p_provider,'')) > 80 then
    raise exception 'Provider name is too long';
  end if;
  if trim(coalesce(p_base_url,'')) !~* '^https://[^[:space:]]+$'
    or char_length(p_base_url) > 2048 then
    raise exception 'Hosted model connections require a valid HTTPS base URL';
  end if;
  if char_length(coalesce(p_model,'')) > 300 then
    raise exception 'Model id is too long';
  end if;
  if octet_length(coalesce(p_api_key,'')) > 32768 then
    raise exception 'Provider credential is too large';
  end if;
  if octet_length(coalesce(p_extra,'{}'::jsonb)::text) > 10000 then
    raise exception 'Provider options are too large';
  end if;

  insert into public.ai_backends (
    owner, provider, name, base_url, api_key, model, extra
  ) values (
    v_owner, lower(trim(coalesce(p_provider,''))), trim(p_name), trim(p_base_url),
    '', trim(coalesce(p_model,'')), coalesce(p_extra,'{}'::jsonb)
  ) returning id into v_backend_id;

  if trim(coalesce(p_api_key,'')) <> '' then
    v_secret_name := 'ai_backend_key_' || v_backend_id::text;
    select vault.create_secret(
      p_api_key,
      v_secret_name,
      'AI provider credential for backend ' || v_backend_id::text
    ) into v_secret_id;
    insert into public.ai_backend_credentials (
      backend_id, owner, vault_secret_id
    ) values (v_backend_id, v_owner, v_secret_id);
  end if;
  return v_backend_id;
end;
$$;

create or replace function public.update_ai_backend(
  p_backend_id uuid,
  p_name text,
  p_model text,
  p_extra jsonb default '{}'::jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if trim(coalesce(p_name,'')) = '' or char_length(p_name) > 160 then
    raise exception 'Model connection name is required';
  end if;
  if char_length(coalesce(p_model,'')) > 300 then
    raise exception 'Model id is too long';
  end if;
  if octet_length(coalesce(p_extra,'{}'::jsonb)::text) > 10000 then
    raise exception 'Provider options are too large';
  end if;
  update public.ai_backends set
    name = trim(p_name), model = trim(coalesce(p_model,'')),
    extra = coalesce(p_extra,'{}'::jsonb)
  where id = p_backend_id and owner = v_owner;
  if not found then raise exception 'Owned model connection not found'; end if;
  return true;
end;
$$;

create or replace function public.delete_ai_backend(p_backend_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  delete from public.ai_backends where id = p_backend_id and owner = v_owner;
  if not found then raise exception 'Owned model connection not found'; end if;
  return true;
end;
$$;

create or replace function public.delete_my_ai_backends()
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  delete from public.ai_backends where owner = v_owner;
  return true;
end;
$$;

create or replace function public.ai_backend_get_key(
  p_backend_id uuid,
  p_owner uuid
)
returns text language sql security definer stable set search_path = '' as $$
  select secret.decrypted_secret
  from public.ai_backend_credentials credential
  join vault.decrypted_secrets secret on secret.id = credential.vault_secret_id
  where credential.backend_id = p_backend_id and credential.owner = p_owner;
$$;

-- Move any legacy plaintext keys into Vault before clearing the old column.
do $$
declare
  v_row record;
  v_secret_id uuid;
  v_secret_name text;
begin
  for v_row in
    select id, owner, api_key from public.ai_backends
    where trim(coalesce(api_key,'')) <> ''
  loop
    select vault_secret_id into v_secret_id
    from public.ai_backend_credentials
    where backend_id = v_row.id for update;
    v_secret_name := 'ai_backend_key_' || v_row.id::text;
    if v_secret_id is null then
      select id into v_secret_id from vault.secrets where name = v_secret_name;
    end if;
    if v_secret_id is null then
      select vault.create_secret(
        v_row.api_key,
        v_secret_name,
        'AI provider credential for backend ' || v_row.id::text
      ) into v_secret_id;
    else
      perform vault.update_secret(
        v_secret_id,
        v_row.api_key,
        v_secret_name,
        'AI provider credential for backend ' || v_row.id::text
      );
    end if;
    insert into public.ai_backend_credentials (
      backend_id, owner, vault_secret_id, updated_at
    ) values (v_row.id, v_row.owner, v_secret_id, now())
    on conflict (backend_id) do update set
      owner = excluded.owner,
      vault_secret_id = excluded.vault_secret_id,
      updated_at = excluded.updated_at;
    update public.ai_backends set api_key = '' where id = v_row.id;
  end loop;
end;
$$;

revoke all on function public.create_ai_backend(text,text,text,text,text,jsonb)
  from public, anon;
revoke all on function public.update_ai_backend(uuid,text,text,jsonb)
  from public, anon;
revoke all on function public.delete_ai_backend(uuid) from public, anon;
revoke all on function public.delete_my_ai_backends() from public, anon;
grant execute on function public.create_ai_backend(text,text,text,text,text,jsonb)
  to authenticated;
grant execute on function public.update_ai_backend(uuid,text,text,jsonb)
  to authenticated;
grant execute on function public.delete_ai_backend(uuid) to authenticated;
grant execute on function public.delete_my_ai_backends() to authenticated;
revoke all on function public.ai_backend_get_key(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.delete_ai_backend_vault_secret()
  from public, anon, authenticated;
grant execute on function public.ai_backend_get_key(uuid,uuid) to service_role;

-- Privacy-safe persona reads. Public callers never receive the private owner
-- UUID; an owner reaches their full roster only through my_personas().
create or replace function public.my_personas()
returns setof public.personas language sql security definer stable
set search_path = '' as $$
  select * from public.personas where owner = auth.uid() order by created_at asc;
$$;

create or replace function public.discover_personas(q text default null, lim int default 80)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, hashtags text,
  top8 jsonb, modules jsonb, linked jsonb, created_at timestamptz
) language sql security definer stable set search_path = '' as $$
  select p.id, p.handle, p.name, p.tagline, p.bio, p.nsfw, p.visibility,
    p.avatar_url, p.banner_url, p.bg_url, p.feed_img_url, p.music_url,
    p.live_url, p.theme, p.topics, p.hashtags, p.top8, p.modules,
    p.linked, p.created_at
  from public.personas p
  where p.visibility = 'public'
    and (q is null or p.name ilike '%'||q||'%' or p.handle ilike '%'||q||'%'
      or p.topics ilike '%'||q||'%' or p.tagline ilike '%'||q||'%')
  order by p.created_at desc
  limit greatest(1, least(coalesce(lim,80),200));
$$;

create or replace function public.persona_by_handle(h text)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, purpose text, voice text,
  audience text, hashtags text, dont text, top8 jsonb, modules jsonb, linked jsonb,
  ai_backend uuid, created_at timestamptz
) language sql security definer stable set search_path = '' as $$
  select p.id, p.handle, p.name, p.tagline, p.bio, p.nsfw, p.visibility,
    p.avatar_url, p.banner_url, p.bg_url, p.feed_img_url, p.music_url,
    p.live_url, p.theme, p.topics, p.purpose, p.voice, p.audience,
    p.hashtags, p.dont, p.top8, p.modules, p.linked, p.ai_backend, p.created_at
  from public.personas p
  where p.handle = h and public.persona_visible(p.id)
  limit 1;
$$;
revoke all on function public.my_personas() from public, anon, authenticated;
grant execute on function public.my_personas() to authenticated;
grant execute on function public.discover_personas(text,int) to anon, authenticated;
grant execute on function public.persona_by_handle(text) to anon, authenticated;
-- A column-level revoke does not override an existing table-level SELECT grant.
-- Replace the broad grant with an explicit list that omits the private owner UUID.
revoke select on public.personas from anon, authenticated;
revoke select (owner) on public.personas from anon, authenticated;
grant select (
  id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
  bg_url, feed_img_url, music_url, live_url, theme, topics, purpose, voice,
  audience, hashtags, dont, top8, modules, linked, ai_backend, created_at
) on public.personas to anon, authenticated;

create table if not exists public.agent_owner_settings (
  owner uuid primary key references public.profiles(id) on delete cascade,
  automation_paused boolean not null default false,
  pause_reason text not null default '',
  paused_at timestamptz,
  default_timezone text not null default 'UTC',
  daily_draft_limit integer not null default 12
    check (daily_draft_limit between 1 and 100),
  quiet_hours_start time,
  quiet_hours_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.agent_owner_settings enable row level security;
drop policy if exists "agent owner settings owner only" on public.agent_owner_settings;
create policy "agent owner settings owner only" on public.agent_owner_settings for all
  using (auth.uid() = owner) with check (auth.uid() = owner);

-- Time-zone math is used by quotas, quiet hours, publishing, and the scheduler.
-- Reject unusable API values at the database boundary, not only in the UI.
update public.agent_owner_settings set
  default_timezone = 'UTC',
  automation_paused = true,
  pause_reason = 'Review the account time zone before resuming automation.',
  paused_at = coalesce(paused_at, now())
where not exists (
  select 1 from pg_catalog.pg_timezone_names z
  where z.name = agent_owner_settings.default_timezone
);
update public.agent_owner_settings set
  quiet_hours_start = null,
  quiet_hours_end = null
where (quiet_hours_start is null) <> (quiet_hours_end is null);

create or replace function public.guard_agent_owner_settings_timezone()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names z
    where z.name = new.default_timezone
  ) then
    raise exception 'Choose a valid IANA time zone';
  end if;
  if (new.quiet_hours_start is null) <> (new.quiet_hours_end is null) then
    raise exception 'Set both quiet-hour times, or leave both blank';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_agent_owner_settings_timezone
  on public.agent_owner_settings;
create trigger guard_agent_owner_settings_timezone
  before insert or update of default_timezone, quiet_hours_start, quiet_hours_end
  on public.agent_owner_settings for each row
  execute function public.guard_agent_owner_settings_timezone();

create table if not exists public.agent_bindings (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid not null unique,
  claim_ref text,
  claim_state text not null default 'self_attested'
    check (claim_state in ('self_attested','verified','revoked','suspended')),
  status text not null default 'active'
    check (status in ('active','paused','suspended','withdrawn')),
  autonomy_level smallint not null default 0
    check (autonomy_level between 0 and 3),
  fan_chat_enabled boolean not null default false,
  fan_daily_message_limit integer not null default 30
    check (fan_daily_message_limit between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.agent_bindings enable row level security;
drop policy if exists "agent bindings owner only" on public.agent_bindings;
create policy "agent bindings owner only" on public.agent_bindings for all
  using (auth.uid() = owner) with check (auth.uid() = owner);
revoke insert, update, delete on public.agent_bindings from anon, authenticated;
grant update (status, autonomy_level, fan_chat_enabled, fan_daily_message_limit)
  on public.agent_bindings to authenticated;

-- Owners can pause or withdraw their own agents, but a platform suspension
-- cannot be cleared (or forged) through the authenticated browser role.
create or replace function public.guard_agent_binding_suspension()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated' and new.status is distinct from old.status
    and (old.status = 'suspended' or new.status = 'suspended') then
    raise exception 'Platform suspension state cannot be changed here';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_agent_binding_suspension on public.agent_bindings;
create trigger guard_agent_binding_suspension
  before update of status on public.agent_bindings for each row
  execute function public.guard_agent_binding_suspension();
create index if not exists agent_bindings_owner_idx
  on public.agent_bindings (owner, status);
create unique index if not exists agent_bindings_id_owner_idx
  on public.agent_bindings (id, owner);

create table if not exists public.agent_destinations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  binding_id uuid not null,
  persona_id uuid not null,
  account_id uuid references public.account_ledger(id) on delete cascade,
  destination text not null default 'aliaspaces',
  mode text not null default 'manual'
    check (mode in ('manual','approval','auto')),
  enabled boolean not null default true,
  allowed_content_types text[] not null default array['post','reel','article','image','newsletter','promo']::text[],
  daily_publish_limit integer not null default 3
    check (daily_publish_limit between 1 and 100),
  quiet_hours_start time,
  quiet_hours_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (binding_id, owner)
    references public.agent_bindings(id, owner) on delete cascade,
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.agent_destinations enable row level security;
drop policy if exists "agent destinations owner only" on public.agent_destinations;
create policy "agent destinations owner only" on public.agent_destinations for all
  using (auth.uid() = owner) with check (auth.uid() = owner);
create unique index if not exists agent_destinations_target_idx
  on public.agent_destinations (
    binding_id,
    coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
    destination
  );
create index if not exists agent_destinations_owner_idx
  on public.agent_destinations (owner, persona_id, enabled);

create table if not exists public.persona_content_plans (
  persona_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  primary_goal text not null default '',
  success_metric text not null default '',
  audience_focus text not null default '',
  content_pillars text not null default '',
  current_campaign text not null default '',
  calls_to_action text not null default '',
  offers_and_links text not null default '',
  affiliate_disclosure text not null default '',
  source_notes text not null default '',
  platform_guidance text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.persona_content_plans enable row level security;
drop policy if exists "content plans owner only" on public.persona_content_plans;
create policy "content plans owner only" on public.persona_content_plans for all
  using (auth.uid() = owner) with check (auth.uid() = owner);

alter table public.ai_tasks add column if not exists active boolean not null default true;
alter table public.ai_tasks add column if not exists destination text not null default 'aliaspaces';
alter table public.ai_tasks add column if not exists account_id uuid;
alter table public.ai_tasks add column if not exists content_kind text not null default 'post';
alter table public.ai_tasks add column if not exists schedule_day smallint;
alter table public.ai_tasks add column if not exists schedule_time time not null default '09:00';
alter table public.ai_tasks add column if not exists timezone text not null default 'UTC';
alter table public.ai_tasks add column if not exists lead_minutes integer not null default 1440;
alter table public.ai_tasks add column if not exists next_run_at timestamptz;
alter table public.ai_tasks add column if not exists next_publish_at timestamptz;
alter table public.ai_tasks add column if not exists approval_required boolean not null default true;
alter table public.ai_tasks add column if not exists last_status text not null default '';
alter table public.ai_tasks add column if not exists last_error text not null default '';
alter table public.ai_tasks add column if not exists lease_token uuid;
alter table public.ai_tasks add column if not exists lease_expires_at timestamptz;
alter table public.ai_tasks add column if not exists updated_at timestamptz not null default now();

create table if not exists public.agent_daily_usage (
  owner uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null,
  generation_requests integer not null default 0
    check (generation_requests between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, usage_date)
);
alter table public.agent_daily_usage enable row level security;
revoke all on public.agent_daily_usage from anon, authenticated;
grant all on public.agent_daily_usage to service_role;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ai_tasks_content_kind_check'
    and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_content_kind_check
      check (content_kind in ('post','reel','article','image','newsletter','promo'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_tasks_schedule_day_check'
    and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_schedule_day_check
      check (schedule_day is null or schedule_day between 0 and 6);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_tasks_lead_minutes_check'
    and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_lead_minutes_check
      check (lead_minutes between 0 and 10080);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_tasks_account_owner_fkey'
    and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_account_owner_fkey
      foreign key (account_id)
      references public.account_ledger(id) on delete set null not valid;
  end if;
end $$;

-- Scheduling state, run leases, and results are server-owned. Owners may edit
-- only the human-authored task definition and may still delete their tasks.
revoke insert, update on public.ai_tasks from authenticated;
grant insert (
  owner, persona_id, backend_id, name, task_type, instructions, cadence,
  active, destination, account_id, content_kind, schedule_day, schedule_time,
  timezone, lead_minutes, approval_required
) on public.ai_tasks to authenticated;
grant update (
  persona_id, backend_id, name, task_type, instructions, cadence,
  active, destination, account_id, content_kind, schedule_day, schedule_time,
  timezone, lead_minutes, approval_required
) on public.ai_tasks to authenticated;

alter table public.drafts add column if not exists source_task_id uuid references public.ai_tasks(id) on delete set null;
alter table public.drafts add column if not exists account_id uuid;
alter table public.drafts add column if not exists content_kind text not null default 'post';
alter table public.drafts add column if not exists approval_state text not null default 'draft';
alter table public.drafts add column if not exists publish_state text not null default 'not_queued';
alter table public.drafts add column if not exists publish_at timestamptz;
alter table public.drafts add column if not exists approved_at timestamptz;
alter table public.drafts add column if not exists approved_content_hash text not null default '';
alter table public.drafts add column if not exists posted_at timestamptz;
alter table public.drafts add column if not exists provider_post_id text not null default '';
alter table public.drafts add column if not exists publish_error text not null default '';
alter table public.drafts add column if not exists generated_by_agent boolean not null default false;
alter table public.drafts add column if not exists updated_at timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'drafts_content_kind_check'
    and conrelid = 'public.drafts'::regclass) then
    alter table public.drafts add constraint drafts_content_kind_check
      check (content_kind in ('post','reel','article','image','newsletter','promo'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'drafts_approval_state_check'
    and conrelid = 'public.drafts'::regclass) then
    alter table public.drafts add constraint drafts_approval_state_check
      check (approval_state in ('draft','pending','approved','rejected'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'drafts_publish_state_check'
    and conrelid = 'public.drafts'::regclass) then
    alter table public.drafts add constraint drafts_publish_state_check
      check (publish_state in ('not_queued','queued','publishing','published','failed','blocked'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'drafts_account_owner_fkey'
    and conrelid = 'public.drafts'::regclass) then
    alter table public.drafts add constraint drafts_account_owner_fkey
      foreign key (account_id)
      references public.account_ledger(id) on delete set null not valid;
  end if;
end $$;

create table if not exists public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid,
  binding_id uuid references public.agent_bindings(id) on delete set null,
  action_type text not null,
  entity_type text not null default '',
  entity_id uuid,
  outcome text not null default 'ok',
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.agent_actions enable row level security;
drop policy if exists "agent actions owner read" on public.agent_actions;
drop policy if exists "agent actions owner insert" on public.agent_actions;
create policy "agent actions owner read" on public.agent_actions for select
  using (auth.uid() = owner);
revoke insert, update, delete on public.agent_actions from anon, authenticated;
create index if not exists agent_actions_owner_created_idx
  on public.agent_actions (owner, created_at desc);
create index if not exists agent_actions_persona_created_idx
  on public.agent_actions (persona_id, created_at desc);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid,
  conversation_key text not null,
  role text not null check (role in ('user','assistant','system')),
  content text not null check (char_length(content) between 1 and 20000),
  created_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.agent_messages enable row level security;
drop policy if exists "agent messages owner only" on public.agent_messages;
create policy "agent messages owner only" on public.agent_messages for all
  using (auth.uid() = owner) with check (
    auth.uid() = owner and (persona_id is null or public.owns_persona(persona_id))
  );
create index if not exists agent_messages_conversation_idx
  on public.agent_messages (owner, conversation_key, created_at);

create table if not exists public.fan_chat_sessions (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid not null,
  visitor_key_hash text not null,
  escalated boolean not null default false,
  escalation_reason text not null default '',
  inbox_state text not null default 'unread'
    check (inbox_state in ('unread','read','resolved')),
  response_pending boolean not null default false,
  response_lease_token uuid,
  response_lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.fan_chat_sessions
  add column if not exists response_pending boolean not null default false;
alter table public.fan_chat_sessions
  add column if not exists response_lease_token uuid;
alter table public.fan_chat_sessions
  add column if not exists response_lease_expires_at timestamptz;
alter table public.fan_chat_sessions enable row level security;
drop policy if exists "fan sessions owner read" on public.fan_chat_sessions;
drop policy if exists "fan sessions owner update" on public.fan_chat_sessions;
create policy "fan sessions owner read" on public.fan_chat_sessions for select
  using (auth.uid() = owner);
create policy "fan sessions owner update" on public.fan_chat_sessions for update
  using (auth.uid() = owner) with check (auth.uid() = owner);
revoke insert, delete on public.fan_chat_sessions from anon, authenticated;
revoke update on public.fan_chat_sessions from anon, authenticated;
grant update (inbox_state) on public.fan_chat_sessions to authenticated;
create index if not exists fan_chat_sessions_owner_idx
  on public.fan_chat_sessions (owner, inbox_state, last_seen_at desc);
create index if not exists fan_chat_sessions_visitor_idx
  on public.fan_chat_sessions (persona_id, visitor_key_hash, created_at desc);

create table if not exists public.fan_chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.fan_chat_sessions(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid not null,
  role text not null check (role in ('fan','assistant','system')),
  content text not null check (char_length(content) between 1 and 12000),
  flagged boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.fan_chat_messages enable row level security;
drop policy if exists "fan messages owner read" on public.fan_chat_messages;
create policy "fan messages owner read" on public.fan_chat_messages for select
  using (auth.uid() = owner);
revoke insert, update, delete on public.fan_chat_messages from anon, authenticated;
create index if not exists fan_chat_messages_session_idx
  on public.fan_chat_messages (session_id, created_at);

-- Reserve each public message, quota unit, response lease, session state, and
-- audit record in one transaction. The persona-wide daily lock is the hard
-- cost boundary even when a visitor rotates their browser token.
create or replace function public.reserve_fan_chat_message(
  p_session_id uuid,
  p_persona_id uuid,
  p_owner uuid,
  p_visitor_key_hash text,
  p_message text,
  p_flag_reasons text[],
  p_hourly_limit integer,
  p_response_token uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_persona public.personas%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_settings public.agent_owner_settings%rowtype;
  v_session public.fan_chat_sessions%rowtype;
  v_session_found boolean := false;
  v_reasons text[] := array[]::text[];
  v_awaiting_human boolean := false;
  v_escalated boolean := false;
  v_usage_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_daily_count integer := 0;
  v_hourly_count integer := 0;
begin
  if p_session_id is null or p_response_token is null or
     p_visitor_key_hash !~ '^[0-9a-f]{64}$' or
     char_length(trim(coalesce(p_message,''))) not between 1 and 2000 or
     p_hourly_limit not between 1 and 100 then
    return jsonb_build_object('accepted',false,'code','invalid_request');
  end if;

  select * into v_persona from public.personas
    where id = p_persona_id and owner = p_owner
      and visibility in ('public','unlisted') and not coalesce(nsfw,false)
    for share;
  if not found then
    return jsonb_build_object('accepted',false,'code','persona_unavailable');
  end if;
  select * into v_binding from public.agent_bindings
    where owner = p_owner and persona_id = p_persona_id for share;
  if not found or v_binding.status <> 'active' or
     v_binding.claim_state not in ('self_attested','verified') or
     not v_binding.fan_chat_enabled then
    return jsonb_build_object('accepted',false,'code','fan_chat_disabled');
  end if;
  select * into v_settings from public.agent_owner_settings
    where owner = p_owner for share;
  if not found or v_settings.automation_paused then
    return jsonb_build_object('accepted',false,'code','owner_paused');
  end if;

  v_usage_date := (now() at time zone v_settings.default_timezone)::date;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'fan-chat-day:' || p_persona_id::text || ':' || v_usage_date::text, 0
  ));
  v_day_start := v_usage_date::timestamp at time zone v_settings.default_timezone;
  v_day_end := (v_usage_date + 1)::timestamp at time zone v_settings.default_timezone;

  select * into v_session from public.fan_chat_sessions
    where id = p_session_id for update;
  v_session_found := found;
  if v_session_found and (
    v_session.owner <> p_owner or v_session.persona_id <> p_persona_id or
    v_session.visitor_key_hash <> p_visitor_key_hash
  ) then
    return jsonb_build_object('accepted',false,'code','invalid_session');
  end if;
  if v_session_found and v_session.response_pending and
     v_session.response_lease_expires_at > now() then
    return jsonb_build_object('accepted',false,'code','session_busy');
  end if;

  select count(*) into v_daily_count from public.fan_chat_messages
    where owner = p_owner and persona_id = p_persona_id and role = 'fan'
      and created_at >= v_day_start and created_at < v_day_end;
  if v_daily_count >= v_binding.fan_daily_message_limit then
    return jsonb_build_object(
      'accepted',false,'code','persona_daily_limit',
      'used',v_daily_count,'limit',v_binding.fan_daily_message_limit
    );
  end if;

  select count(*) into v_hourly_count
  from public.fan_chat_messages message
  join public.fan_chat_sessions session on session.id = message.session_id
  where session.persona_id = p_persona_id
    and session.visitor_key_hash = p_visitor_key_hash
    and message.role = 'fan'
    and message.created_at >= now() - interval '1 hour';
  if v_hourly_count >= p_hourly_limit then
    return jsonb_build_object(
      'accepted',false,'code','visitor_hourly_limit',
      'used',v_hourly_count,'limit',p_hourly_limit
    );
  end if;

  select coalesce(array_agg(reason),array[]::text[]) into v_reasons
  from (
    select left(trim(reason),50) as reason
    from unnest(coalesce(p_flag_reasons,array[]::text[])) reason
    where trim(reason) <> ''
    limit 8
  ) cleaned;
  v_awaiting_human := v_session_found and v_session.escalated
    and v_session.inbox_state <> 'resolved';
  v_escalated := cardinality(v_reasons) > 0 or v_awaiting_human;

  if not v_session_found then
    insert into public.fan_chat_sessions (
      id, owner, persona_id, visitor_key_hash, escalated,
      escalation_reason, inbox_state, response_pending,
      response_lease_token, response_lease_expires_at, last_seen_at
    ) values (
      p_session_id, p_owner, p_persona_id, p_visitor_key_hash, v_escalated,
      case when cardinality(v_reasons) > 0
        then left(array_to_string(v_reasons,','),200) else '' end,
      'unread', true, p_response_token, now() + interval '90 seconds', now()
    ) returning * into v_session;
  else
    update public.fan_chat_sessions set
      escalated = case
        when cardinality(v_reasons) > 0 then true
        when inbox_state = 'resolved' then false
        else escalated end,
      escalation_reason = case
        when cardinality(v_reasons) > 0 then left(array_to_string(v_reasons,','),200)
        when inbox_state = 'resolved' then ''
        else escalation_reason end,
      inbox_state = 'unread',
      last_seen_at = now(),
      response_pending = true,
      response_lease_token = p_response_token,
      response_lease_expires_at = now() + interval '90 seconds'
    where id = p_session_id returning * into v_session;
  end if;

  insert into public.fan_chat_messages (
    session_id, owner, persona_id, role, content, flagged
  ) values (
    p_session_id, p_owner, p_persona_id, 'fan', trim(p_message), v_escalated
  );
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, p_persona_id, v_binding.id, 'fan_chat.received',
    'fan_chat_session', p_session_id,
    case when v_escalated then 'escalated' else 'ok' end,
    jsonb_build_object('messageCharacters',char_length(trim(p_message)),
      'dailyMessageNumber',v_daily_count + 1,
      'categories',to_jsonb(v_reasons))
  );
  return jsonb_build_object(
    'accepted',true,'escalated',v_escalated,
    'awaitingHuman',v_awaiting_human,'categories',to_jsonb(v_reasons),
    'dailyMessageNumber',v_daily_count + 1
  );
end;
$$;

create or replace function public.complete_fan_chat_reply(
  p_session_id uuid,
  p_owner uuid,
  p_response_token uuid,
  p_reply text,
  p_outcome text,
  p_categories text[] default array[]::text[]
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_session public.fan_chat_sessions%rowtype;
  v_binding_id uuid;
  v_flagged boolean;
begin
  if char_length(trim(coalesce(p_reply,''))) not between 1 and 4000 or
     p_outcome not in ('ok','escalated','model_error') then
    raise exception 'Invalid fan reply completion';
  end if;
  select * into v_session from public.fan_chat_sessions
    where id = p_session_id and owner = p_owner for update;
  if not found or not v_session.response_pending or
     v_session.response_lease_token is distinct from p_response_token then
    return false;
  end if;
  select id into v_binding_id from public.agent_bindings
    where owner = p_owner and persona_id = v_session.persona_id;
  if not found then raise exception 'Persona binding is unavailable'; end if;
  v_flagged := p_outcome <> 'ok';
  insert into public.fan_chat_messages (
    session_id, owner, persona_id, role, content, flagged
  ) values (
    p_session_id, p_owner, v_session.persona_id, 'assistant', trim(p_reply),
    v_flagged
  );
  update public.fan_chat_sessions set
    response_pending = false,
    response_lease_token = null,
    response_lease_expires_at = null,
    last_seen_at = now(),
    inbox_state = 'unread',
    escalated = case when v_flagged then true else escalated end,
    escalation_reason = case
      when p_outcome = 'model_error' and escalation_reason = ''
        then 'model_unavailable'
      when p_outcome = 'escalated' and escalation_reason = '' then
        left(coalesce(nullif(array_to_string(p_categories, ','),''),
          'owner_review'), 500)
      else escalation_reason end
  where id = p_session_id;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, v_session.persona_id, v_binding_id, 'fan_chat.response',
    'fan_chat_session', p_session_id, p_outcome,
    jsonb_build_object('replyCharacters',char_length(trim(p_reply)),
      'categories',to_jsonb(coalesce(p_categories,array[]::text[])))
  );
  return true;
end;
$$;

revoke all on function public.reserve_fan_chat_message(
  uuid,uuid,uuid,text,text,text[],integer,uuid
) from public, anon, authenticated;
grant execute on function public.reserve_fan_chat_message(
  uuid,uuid,uuid,text,text,text[],integer,uuid
) to service_role;
revoke all on function public.complete_fan_chat_reply(
  uuid,uuid,uuid,text,text,text[]
) from public, anon, authenticated;
grant execute on function public.complete_fan_chat_reply(
  uuid,uuid,uuid,text,text,text[]
) to service_role;

create or replace function public.touch_agent_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_agent_owner_settings on public.agent_owner_settings;
create trigger touch_agent_owner_settings before update on public.agent_owner_settings
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_agent_bindings on public.agent_bindings;
create trigger touch_agent_bindings before update on public.agent_bindings
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_agent_destinations on public.agent_destinations;
create trigger touch_agent_destinations before update on public.agent_destinations
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_persona_content_plans on public.persona_content_plans;
create trigger touch_persona_content_plans before update on public.persona_content_plans
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_ai_tasks on public.ai_tasks;
create trigger touch_ai_tasks before update on public.ai_tasks
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_drafts on public.drafts;
create trigger touch_drafts before update on public.drafts
  for each row execute function public.touch_agent_updated_at();

-- Approval, publication, provenance, and audit state are server-owned. Owners may
-- edit draft content/target/time, but any such edit invalidates prior approval.
revoke insert on public.drafts from authenticated;
grant insert (
  owner, persona_id, platform, title, body, tags, media_url, status,
  scheduled_for, account_id, content_kind, publish_at
) on public.drafts to authenticated;
revoke update on public.drafts from authenticated;
grant update (
  persona_id, platform, title, body, tags, media_url, status,
  scheduled_for, account_id, content_kind, publish_at
) on public.drafts to authenticated;
revoke delete on public.drafts from authenticated;

create or replace function public.ensure_agent_owner_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_owner_settings (owner)
  values (new.id) on conflict (owner) do nothing;
  return new;
end;
$$;
drop trigger if exists ensure_agent_owner_settings on public.profiles;
create trigger ensure_agent_owner_settings after insert on public.profiles
  for each row execute function public.ensure_agent_owner_settings();

create or replace function public.ensure_persona_agent_binding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_owner_settings (owner)
  values (new.owner) on conflict (owner) do nothing;
  insert into public.agent_bindings (owner, persona_id)
  values (new.owner, new.id) on conflict (persona_id) do nothing;
  return new;
end;
$$;
drop trigger if exists ensure_persona_agent_binding on public.personas;
create trigger ensure_persona_agent_binding after insert on public.personas
  for each row execute function public.ensure_persona_agent_binding();

create or replace function public.guard_agent_destination()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_binding_persona uuid;
  v_provider text;
  v_autonomy smallint;
begin
  select persona_id, autonomy_level into v_binding_persona, v_autonomy
    from public.agent_bindings
    where id = new.binding_id and owner = new.owner;
  if not found or v_binding_persona <> new.persona_id then
    raise exception 'Destination binding does not match this persona';
  end if;
  if new.account_id is null then
    new.destination := 'aliaspaces';
    if new.mode = 'auto' and v_autonomy < 3 then
      raise exception 'Bounded native auto mode requires L3 autonomy';
    end if;
  else
    select provider into v_provider from public.account_ledger
      where id = new.account_id and owner = new.owner
        and persona_id = new.persona_id;
    if not found then
      raise exception 'Destination account must be assigned to this persona';
    end if;
    new.destination := v_provider;
    if new.mode = 'auto' then
      raise exception 'External auto mode requires a verified official connector and is not enabled';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists guard_agent_destination on public.agent_destinations;
create trigger guard_agent_destination before insert or update on public.agent_destinations
  for each row execute function public.guard_agent_destination();

create or replace function public.ensure_native_agent_destination()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_destinations (
    owner, binding_id, persona_id, destination, mode
  ) values (
    new.owner, new.id, new.persona_id, 'aliaspaces', 'approval'
  ) on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists ensure_native_agent_destination on public.agent_bindings;
create trigger ensure_native_agent_destination after insert on public.agent_bindings
  for each row execute function public.ensure_native_agent_destination();

insert into public.agent_owner_settings (owner)
select id from public.profiles on conflict (owner) do nothing;
insert into public.agent_bindings (owner, persona_id)
select owner, id from public.personas on conflict (persona_id) do nothing;
insert into public.agent_destinations (owner, binding_id, persona_id, destination, mode)
select owner, id, persona_id, 'aliaspaces', 'approval'
from public.agent_bindings on conflict do nothing;

create or replace function public.next_content_occurrence(
  p_cadence text,
  p_day smallint,
  p_time time,
  p_timezone text,
  p_after timestamptz
)
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_local_after timestamp;
  v_date date;
  v_days integer := 0;
  v_candidate timestamp;
begin
  if p_cadence = 'manual' then return null; end if;
  if p_cadence not in ('daily','weekly') then
    raise exception 'Unsupported cadence';
  end if;
  if trim(coalesce(p_timezone,'')) = '' then
    raise exception 'Time zone is required';
  end if;
  v_local_after := p_after at time zone p_timezone;
  v_date := v_local_after::date;
  if p_cadence = 'weekly' then
    if p_day is null or p_day < 0 or p_day > 6 then
      raise exception 'Weekly schedules require a day from 0 through 6';
    end if;
    v_days := (p_day - extract(dow from v_date)::integer + 7) % 7;
  end if;
  v_candidate := (v_date + v_days)::timestamp + p_time;
  if v_candidate <= v_local_after then
    v_candidate := v_candidate + case when p_cadence = 'daily'
      then interval '1 day' else interval '7 days' end;
  end if;
  return v_candidate at time zone p_timezone;
end;
$$;

create or replace function public.set_ai_task_schedule()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.lease_token := null;
  new.lease_expires_at := null;
  if not new.active or new.cadence = 'manual' then
    new.next_run_at := null;
    new.next_publish_at := null;
    return new;
  end if;
  new.next_publish_at := public.next_content_occurrence(
    new.cadence, new.schedule_day, new.schedule_time, new.timezone, now()
  );
  new.next_run_at := greatest(
    new.next_publish_at - make_interval(mins => new.lead_minutes),
    now() + interval '1 minute'
  );
  return new;
end;
$$;

-- Legacy tasks predate precise day/time controls. Keep ambiguous rows paused for
-- owner review instead of guessing a posting day or aborting this migration.
update public.ai_tasks set
  cadence = 'manual', active = false,
  last_status = 'needs_schedule_review',
  last_error = 'This legacy cadence needs to be reselected before automation can run.'
where cadence is null or cadence not in ('manual','daily','weekly');
alter table public.ai_tasks alter column cadence set default 'manual';
alter table public.ai_tasks alter column cadence set not null;
do $$ begin
  if not exists (select 1 from pg_constraint
    where conname = 'ai_tasks_cadence_check'
      and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_cadence_check
      check (cadence in ('manual','daily','weekly'));
  end if;
end $$;
update public.ai_tasks set
  active = false,
  last_status = 'needs_schedule_day',
  last_error = 'Choose a weekday before resuming this legacy weekly schedule.'
where cadence = 'weekly' and schedule_day is null;
update public.ai_tasks set
  timezone = 'UTC', active = false,
  last_status = 'needs_timezone_review',
  last_error = 'Choose a valid time zone before resuming this legacy schedule.'
where not exists (
  select 1 from pg_catalog.pg_timezone_names z where z.name = ai_tasks.timezone
);

drop trigger if exists set_ai_task_schedule on public.ai_tasks;
create trigger set_ai_task_schedule
  before insert or update of active, cadence, schedule_day, schedule_time, timezone, lead_minutes
  on public.ai_tasks for each row execute function public.set_ai_task_schedule();

drop function if exists public.advance_ai_task_schedule(
  uuid, timestamptz, text, text
);
create or replace function public.advance_ai_task_schedule(
  p_task_id uuid,
  p_finished_at timestamptz default now(),
  p_status text default 'drafted',
  p_error text default '',
  p_lease_token uuid default null
)
returns public.ai_tasks
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_after timestamptz;
begin
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  if p_lease_token is null then
    raise exception 'Task lease token is required';
  end if;
  if v_task.lease_token is distinct from p_lease_token then
    raise exception 'Task lease no longer belongs to this worker';
  end if;
  v_after := greatest(p_finished_at, coalesce(v_task.next_publish_at, p_finished_at)) + interval '1 second';
  update public.ai_tasks set
    last_run = p_finished_at,
    last_status = left(coalesce(p_status,''),80),
    last_error = left(coalesce(p_error,''),1000),
    next_publish_at = case when v_task.active and v_task.cadence <> 'manual'
      then public.next_content_occurrence(v_task.cadence, v_task.schedule_day,
        v_task.schedule_time, v_task.timezone, v_after) else null end,
    lease_token = null,
    lease_expires_at = null
  where id = p_task_id
  returning * into v_task;
  update public.ai_tasks set next_run_at = case
    when v_task.next_publish_at is null then null
    else greatest(v_task.next_publish_at - make_interval(mins => v_task.lead_minutes),
      p_finished_at + interval '1 minute') end
  where id = p_task_id returning * into v_task;
  return v_task;
end;
$$;
revoke all on function public.advance_ai_task_schedule(uuid,timestamptz,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.advance_ai_task_schedule(uuid,timestamptz,text,text,uuid)
  to service_role;

create or replace function public.claim_ai_task_generation(
  p_task_id uuid,
  p_due_at timestamptz,
  p_lease_token uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_task public.ai_tasks%rowtype;
begin
  if p_lease_token is null then raise exception 'Lease token is required'; end if;
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found or not v_task.active or v_task.next_run_at is null
    or v_task.next_run_at > p_due_at
    or (v_task.lease_expires_at is not null and v_task.lease_expires_at > now()) then
    return false;
  end if;
  update public.ai_tasks set
    lease_token = p_lease_token,
    lease_expires_at = now() + interval '5 minutes',
    last_status = 'processing',
    last_error = ''
  where id = p_task_id;
  return true;
end;
$$;
revoke all on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  to service_role;

create or replace function public.reserve_agent_generation(
  p_task_id uuid,
  p_owner uuid,
  p_lease_token uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_settings public.agent_owner_settings%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_usage_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_existing_drafts integer := 0;
  v_used integer := 0;
  v_next integer := 0;
begin
  select * into v_task from public.ai_tasks
    where id = p_task_id and owner = p_owner for update;
  if not found or v_task.lease_token is distinct from p_lease_token
    or v_task.lease_expires_at is null or v_task.lease_expires_at <= now() then
    return jsonb_build_object('reserved',false,'code','lease_lost');
  end if;

  select * into v_settings from public.agent_owner_settings
    where owner = p_owner for share;
  if not found then
    return jsonb_build_object('reserved',false,'code','settings_unavailable');
  end if;
  if v_settings.automation_paused then
    return jsonb_build_object('reserved',false,'code','owner_paused');
  end if;

  select * into v_binding from public.agent_bindings
    where owner = p_owner and persona_id = v_task.persona_id for share;
  if not found or v_binding.status <> 'active' or
     v_binding.claim_state not in ('self_attested','verified') or
     v_binding.autonomy_level < 1 then
    return jsonb_build_object('reserved',false,'code','binding_inactive');
  end if;

  v_usage_date := (now() at time zone v_settings.default_timezone)::date;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'agent-generation-day:' || p_owner::text || ':' || v_usage_date::text, 0
  ));
  v_day_start := v_usage_date::timestamp at time zone v_settings.default_timezone;
  v_day_end := (v_usage_date + 1)::timestamp at time zone v_settings.default_timezone;
  select count(*) into v_existing_drafts from public.drafts
    where owner = p_owner and generated_by_agent
      and created_at >= v_day_start and created_at < v_day_end;
  select generation_requests into v_used from public.agent_daily_usage
    where owner = p_owner and usage_date = v_usage_date for update;
  if not found then v_used := 0; end if;
  v_used := greatest(v_used, v_existing_drafts);
  if v_used >= v_settings.daily_draft_limit then
    return jsonb_build_object(
      'reserved',false,'code','daily_cap','used',v_used,
      'limit',v_settings.daily_draft_limit
    );
  end if;
  v_next := v_used + 1;
  insert into public.agent_daily_usage (
    owner, usage_date, generation_requests, updated_at
  ) values (p_owner, v_usage_date, v_next, now())
  on conflict (owner, usage_date) do update set
    generation_requests = excluded.generation_requests,
    updated_at = excluded.updated_at;

  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, v_task.persona_id, v_binding.id, 'ai.call.started',
    'ai_task', v_task.id, 'started',
    jsonb_build_object('generationRequest',v_next,
      'dailyLimit',v_settings.daily_draft_limit)
  );
  return jsonb_build_object(
    'reserved',true,'used',v_next,'limit',v_settings.daily_draft_limit
  );
end;
$$;
revoke all on function public.reserve_agent_generation(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_agent_generation(uuid,uuid,uuid)
  to service_role;

create or replace function public.guard_ai_task_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_provider text;
begin
  if new.persona_id is not null and not exists (
    select 1 from public.personas where id = new.persona_id and owner = new.owner
  ) then raise exception 'Task persona is not owned by this account'; end if;
  if new.backend_id is not null and not exists (
    select 1 from public.ai_backends where id = new.backend_id and owner = new.owner
  ) then raise exception 'Task model is not owned by this account'; end if;
  if new.account_id is not null then
    select provider into v_provider from public.account_ledger
      where id = new.account_id and owner = new.owner
        and persona_id = new.persona_id;
    if not found then
      raise exception 'Destination account must be assigned to the task persona';
    end if;
    new.destination := v_provider;
  elsif trim(coalesce(new.destination,'')) = '' then
    new.destination := 'aliaspaces';
  end if;
  -- Generation never approves its own output. L3 means an exact owner-approved
  -- native draft may publish automatically when due, not self-approval.
  new.approval_required := true;
  return new;
end;
$$;
drop trigger if exists guard_ai_task_assignment on public.ai_tasks;
create trigger guard_ai_task_assignment before insert or update on public.ai_tasks
  for each row execute function public.guard_ai_task_assignment();

create or replace function public.guard_draft_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.persona_id is not null and not exists (
    select 1 from public.personas where id = new.persona_id and owner = new.owner
  ) then raise exception 'Draft persona is not owned by this account'; end if;
  if new.account_id is not null and not exists (
    select 1 from public.account_ledger where id = new.account_id
      and owner = new.owner and persona_id = new.persona_id
  ) then raise exception 'Draft destination must be assigned to its persona'; end if;
  return new;
end;
$$;
drop trigger if exists guard_draft_assignment on public.drafts;
create trigger guard_draft_assignment before insert or update on public.drafts
  for each row execute function public.guard_draft_assignment();

create or replace function public.agent_draft_hash(
  p_title text,
  p_body text,
  p_tags text,
  p_media_url text,
  p_content_kind text,
  p_persona_id uuid,
  p_account_id uuid,
  p_platform text,
  p_publish_at timestamptz
)
returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(
    concat_ws(chr(31), coalesce(p_title,''), coalesce(p_body,''),
      coalesce(p_tags,''), coalesce(p_media_url,''), coalesce(p_content_kind,''),
      coalesce(p_persona_id::text,''), coalesce(p_account_id::text,'native'),
      coalesce(nullif(lower(trim(p_platform)),''),'aliaspaces'),
      coalesce(((extract(epoch from p_publish_at) * 1000000)::bigint)::text,'')),
    'sha256'
  ), 'hex');
$$;

create or replace function public.invalidate_changed_draft_approval()
returns trigger language plpgsql set search_path = '' as $$
declare v_hash text;
begin
  v_hash := public.agent_draft_hash(new.title, new.body, new.tags,
    new.media_url, new.content_kind, new.persona_id, new.account_id,
    new.platform, new.publish_at);
  -- The approval RPC deliberately changes publish_at and writes the matching
  -- content hash in one statement. Preserve that server-authored transition;
  -- browser edits cannot write either approval_state or the hash.
  if new.approval_state = 'approved'
    and new.approved_at is not null
    and new.approved_content_hash = v_hash then
    return new;
  end if;
  if old.approval_state = 'approved' then
    if v_hash is distinct from old.approved_content_hash then
      new.approval_state := 'draft';
      new.approved_at := null;
      new.approved_content_hash := '';
      new.publish_state := 'not_queued';
      new.publish_error := 'Approval was cleared because the content, target, or schedule changed.';
    end if;
  elsif old.approval_state = 'rejected' then
    new.approval_state := 'draft';
    new.approved_at := null;
    new.approved_content_hash := '';
    new.publish_state := 'not_queued';
    new.publish_error := '';
  end if;
  return new;
end;
$$;
drop trigger if exists invalidate_changed_draft_approval on public.drafts;
create trigger invalidate_changed_draft_approval
  before update of title, body, tags, media_url, content_kind, persona_id,
    account_id, platform, publish_at
  on public.drafts for each row execute function public.invalidate_changed_draft_approval();

create or replace function public.guard_publishing_draft_edit()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history is locked; copy it into a new draft instead';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_publishing_draft_edit on public.drafts;
create trigger guard_publishing_draft_edit
  before update of title, body, tags, media_url, content_kind, account_id,
    publish_at, persona_id, platform
  on public.drafts for each row execute function public.guard_publishing_draft_edit();

create or replace function public.audit_agent_binding_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
  ) values (
    new.owner, new.persona_id, new.id, 'binding.updated', 'binding', new.id,
    jsonb_build_object('status_from',old.status,'status_to',new.status,
      'autonomy_from',old.autonomy_level,'autonomy_to',new.autonomy_level,
      'fan_chat_from',old.fan_chat_enabled,'fan_chat_to',new.fan_chat_enabled,
      'claim_state_from',old.claim_state,'claim_state_to',new.claim_state,
      'claim_ref_changed',old.claim_ref is distinct from new.claim_ref)
  );
  return new;
end;
$$;
drop trigger if exists audit_agent_binding_change on public.agent_bindings;
create trigger audit_agent_binding_change after update on public.agent_bindings
  for each row when (
    old.status is distinct from new.status or
    old.autonomy_level is distinct from new.autonomy_level or
    old.fan_chat_enabled is distinct from new.fan_chat_enabled or
    old.fan_daily_message_limit is distinct from new.fan_daily_message_limit or
    old.claim_state is distinct from new.claim_state or
    old.claim_ref is distinct from new.claim_ref
  ) execute function public.audit_agent_binding_change();

create or replace function public.downgrade_native_auto_destination()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.autonomy_level >= 3 and new.autonomy_level < 3 then
    update public.agent_destinations set mode = 'approval'
    where binding_id = new.id and owner = new.owner and account_id is null
      and mode = 'auto';
  end if;
  return new;
end;
$$;
drop trigger if exists downgrade_native_auto_destination on public.agent_bindings;
create trigger downgrade_native_auto_destination
  after update of autonomy_level on public.agent_bindings
  for each row execute function public.downgrade_native_auto_destination();

create or replace function public.audit_agent_owner_settings_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_actions (
    owner, action_type, entity_type, entity_id, detail
  ) values (
    new.owner, 'owner_controls.updated', 'owner_controls', new.owner,
    jsonb_build_object('paused_from',old.automation_paused,
      'paused_to',new.automation_paused,'pause_reason',new.pause_reason,
      'timezone',new.default_timezone,'daily_draft_limit',new.daily_draft_limit)
  );
  return new;
end;
$$;
drop trigger if exists audit_agent_owner_settings_change on public.agent_owner_settings;
create trigger audit_agent_owner_settings_change after update on public.agent_owner_settings
  for each row execute function public.audit_agent_owner_settings_change();

create or replace function public.audit_agent_destination_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    insert into public.agent_actions (
      owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
    ) values (
      old.owner, old.persona_id, old.binding_id, 'destination.deleted',
      'destination', old.id,
      jsonb_build_object('destination',old.destination,'mode',old.mode,
        'enabled',old.enabled,'daily_publish_limit',old.daily_publish_limit)
    );
    return old;
  end if;
  if tg_op = 'INSERT' then
    insert into public.agent_actions (
      owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
    ) values (
      new.owner, new.persona_id, new.binding_id, 'destination.created',
      'destination', new.id,
      jsonb_build_object('destination',new.destination,'mode',new.mode,
        'enabled',new.enabled,'daily_publish_limit',new.daily_publish_limit)
    );
    return new;
  end if;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
  ) values (
    new.owner, new.persona_id, new.binding_id, 'destination.updated',
    'destination', new.id,
    jsonb_build_object('destination',new.destination,'mode_from',old.mode,
      'mode_to',new.mode,'enabled',new.enabled,
      'daily_publish_limit',new.daily_publish_limit)
  );
  return new;
end;
$$;
drop trigger if exists audit_agent_destination_change on public.agent_destinations;
create trigger audit_agent_destination_change
  after insert or update or delete on public.agent_destinations
  for each row execute function public.audit_agent_destination_change();

create or replace function public.audit_content_plan_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_binding_id uuid;
begin
  select id into v_binding_id from public.agent_bindings
    where persona_id = new.persona_id and owner = new.owner;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id
  ) values (
    new.owner, new.persona_id, v_binding_id, 'direction.updated',
    'content_plan', new.persona_id
  );
  return new;
end;
$$;
drop trigger if exists audit_content_plan_change on public.persona_content_plans;
create trigger audit_content_plan_change after insert or update on public.persona_content_plans
  for each row execute function public.audit_content_plan_change();

create or replace function public.approve_agent_draft(
  p_draft_id uuid,
  p_publish_at timestamptz default null
)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_hash text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history cannot be approved again';
  end if;
  if v_draft.persona_id is null then raise exception 'Choose a persona before approval'; end if;
  select * into v_binding from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  if not found or v_binding.status <> 'active' or v_binding.autonomy_level < 2 then
    raise exception 'This persona must have an active L2 or L3 agent before approval';
  end if;
  v_draft.publish_at := coalesce(p_publish_at, v_draft.publish_at, now());
  v_hash := public.agent_draft_hash(v_draft.title, v_draft.body, v_draft.tags,
    v_draft.media_url, v_draft.content_kind, v_draft.persona_id,
    v_draft.account_id, v_draft.platform, v_draft.publish_at);
  update public.drafts set
    approval_state = 'approved',
    approved_at = now(),
    approved_content_hash = v_hash,
    publish_at = v_draft.publish_at,
    publish_state = 'queued',
    publish_error = '',
    status = 'ready'
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
  ) values (
    auth.uid(), v_draft.persona_id, v_binding.id, 'draft.approved',
    'draft', v_draft.id, jsonb_build_object('publish_at',v_draft.publish_at,
      'content_hash',v_hash,'destination',v_draft.platform)
  );
  return v_draft;
end;
$$;
revoke all on function public.approve_agent_draft(uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.approve_agent_draft(uuid,timestamptz) to authenticated;

create or replace function public.reject_agent_draft(p_draft_id uuid)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history cannot be rejected';
  end if;
  select id into v_binding_id from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  update public.drafts set approval_state = 'rejected', approved_at = null,
    approved_content_hash = '', publish_state = 'not_queued', status = 'idea'
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id
  ) values (
    auth.uid(), v_draft.persona_id, v_binding_id, 'draft.rejected', 'draft', v_draft.id
  );
  return v_draft;
end;
$$;
revoke all on function public.reject_agent_draft(uuid)
  from public, anon, authenticated;
grant execute on function public.reject_agent_draft(uuid) to authenticated;

create or replace function public.delete_my_draft(p_draft_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing and published history cannot be deleted from the queue';
  end if;
  select id into v_binding_id from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  delete from public.drafts where id = p_draft_id;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id
  ) values (
    auth.uid(), v_draft.persona_id, v_binding_id, 'draft.deleted',
    'draft', v_draft.id
  );
  return true;
end;
$$;
revoke all on function public.delete_my_draft(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_my_draft(uuid) to authenticated;

-- Explicit erasure is separate from ordinary queue deletion so a user can still
-- remove all of their data, including immutable publication history.
create or replace function public.delete_my_drafts_for_erasure()
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  delete from public.drafts where owner = auth.uid();
  return true;
end;
$$;
revoke all on function public.delete_my_drafts_for_erasure()
  from public, anon, authenticated;
grant execute on function public.delete_my_drafts_for_erasure() to authenticated;

create or replace function public.mark_manual_draft_posted(p_draft_id uuid)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'This draft is already publishing or published';
  end if;
  if v_draft.account_id is null and
     coalesce(nullif(lower(trim(v_draft.platform)),''),'aliaspaces') in (
       'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
     ) then
    raise exception 'Native posts must use the publishing bridge';
  end if;
  select id into v_binding_id from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  update public.drafts set status = 'posted', publish_state = 'published',
    posted_at = now(), provider_post_id = 'manual', publish_error = ''
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    detail
  ) values (
    auth.uid(), v_draft.persona_id, v_binding_id, 'draft.manual_posted',
    'draft', v_draft.id, jsonb_build_object('destination',v_draft.platform)
  );
  return v_draft;
end;
$$;
revoke all on function public.mark_manual_draft_posted(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_manual_draft_posted(uuid) to authenticated;

create or replace function public.agent_in_quiet_hours(
  p_timezone text,
  p_start time,
  p_end time,
  p_at timestamptz default now()
)
returns boolean
language plpgsql stable set search_path = '' as $$
declare v_local_time time;
begin
  if p_start is null or p_end is null then return false; end if;
  v_local_time := (p_at at time zone p_timezone)::time;
  if p_start = p_end then return false; end if;
  if p_start < p_end then
    return v_local_time >= p_start and v_local_time < p_end;
  end if;
  return v_local_time >= p_start or v_local_time < p_end;
end;
$$;

-- Native publication is one database transaction: lock current controls, recheck
-- exact approval and limits, insert the post, finalize the draft, and write audit.
-- This removes the check/claim/insert gaps that can duplicate posts or exceed caps.
create or replace function public.publish_native_agent_draft(
  p_draft_id uuid,
  p_owner uuid,
  p_require_due boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_settings public.agent_owner_settings%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_target public.agent_destinations%rowtype;
  v_post public.posts%rowtype;
  v_hash text;
  v_required_autonomy smallint;
  v_local_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_published_count integer;
  v_now timestamptz := now();
begin
  if p_owner is null then raise exception 'Owner is required'; end if;

  select * into v_draft from public.drafts
    where id = p_draft_id and owner = p_owner for update;
  if not found then raise exception 'Draft not found'; end if;

  if v_draft.publish_state = 'published' then
    select * into v_post from public.posts
      where id::text = v_draft.provider_post_id
        and persona_id = v_draft.persona_id;
    if not found then
      raise exception 'Published draft requires reconciliation';
    end if;
    return jsonb_build_object(
      'published',true,'draftId',v_draft.id,'postId',v_post.id,
      'postedAt',v_draft.posted_at,'idempotent',true
    );
  end if;

  if v_draft.publish_state = 'publishing' then
    raise exception 'Another publisher is already handling this draft';
  end if;
  if v_draft.approval_state <> 'approved' or v_draft.approved_content_hash = '' then
    raise exception 'Exact owner approval is required';
  end if;
  if p_require_due and (v_draft.publish_at is null or v_draft.publish_at > v_now) then
    raise exception 'Draft is not due';
  end if;
  if v_draft.persona_id is null then raise exception 'Draft persona is required'; end if;
  if v_draft.account_id is not null or
     coalesce(nullif(lower(trim(v_draft.platform)),''),'aliaspaces')
       not in ('aliaspaces','mypersonas','mypersonas.online') then
    raise exception 'No official external write connector is enabled';
  end if;
  if coalesce(v_draft.title,'') = '' and coalesce(v_draft.body,'') = '' and
     coalesce(v_draft.media_url,'') = '' then
    raise exception 'Draft content is empty';
  end if;

  select * into v_settings from public.agent_owner_settings
    where owner = p_owner for share;
  if not found then raise exception 'Owner automation settings are unavailable'; end if;
  if v_settings.automation_paused then raise exception 'Owner automation is paused'; end if;

  select * into v_binding from public.agent_bindings
    where owner = p_owner and persona_id = v_draft.persona_id for share;
  if not found then raise exception 'Persona binding is unavailable'; end if;
  if v_binding.status <> 'active' then raise exception 'Persona binding is not active'; end if;
  if v_binding.claim_state not in ('self_attested','verified') then
    raise exception 'Persona claim is not active';
  end if;

  select * into v_target from public.agent_destinations
    where owner = p_owner and binding_id = v_binding.id
      and persona_id = v_draft.persona_id and account_id is null
      and destination in ('aliaspaces','mypersonas','mypersonas.online')
    for update;
  if not found then raise exception 'Native destination is unavailable'; end if;
  if not v_target.enabled then raise exception 'Native destination is disabled'; end if;
  if v_target.mode = 'manual' then raise exception 'Native destination is manual-only'; end if;
  if p_require_due and v_target.mode <> 'auto' then
    raise exception 'This destination needs an owner to press Publish now';
  end if;
  if not (v_draft.content_kind = any(v_target.allowed_content_types)) then
    raise exception 'Content type is not allowed for this destination';
  end if;
  v_required_autonomy := case when v_target.mode = 'auto' then 3 else 2 end;
  if v_binding.autonomy_level < v_required_autonomy then
    raise exception 'Persona autonomy is below the destination requirement';
  end if;

  v_hash := public.agent_draft_hash(
    v_draft.title, v_draft.body, v_draft.tags, v_draft.media_url,
    v_draft.content_kind, v_draft.persona_id, v_draft.account_id,
    v_draft.platform, v_draft.publish_at
  );
  if v_hash is distinct from v_draft.approved_content_hash then
    raise exception 'Approval no longer matches this exact draft';
  end if;

  if public.agent_in_quiet_hours(
    v_settings.default_timezone, v_settings.quiet_hours_start,
    v_settings.quiet_hours_end, v_now
  ) or public.agent_in_quiet_hours(
    v_settings.default_timezone, v_target.quiet_hours_start,
    v_target.quiet_hours_end, v_now
  ) then
    raise exception 'Publishing is paused during quiet hours';
  end if;

  v_local_date := (v_now at time zone v_settings.default_timezone)::date;
  v_day_start := v_local_date::timestamp at time zone v_settings.default_timezone;
  v_day_end := (v_local_date + 1)::timestamp at time zone v_settings.default_timezone;
  select count(*) into v_published_count from public.drafts d
    where d.owner = p_owner and d.persona_id = v_draft.persona_id
      and d.account_id is null and d.publish_state = 'published'
      and coalesce(nullif(lower(trim(d.platform)),''),'aliaspaces')
        in ('aliaspaces','mypersonas','mypersonas.online')
      and d.posted_at >= v_day_start and d.posted_at < v_day_end;
  if v_published_count >= v_target.daily_publish_limit then
    raise exception 'Destination daily publishing limit has been reached';
  end if;

  insert into public.posts (persona_id, kind, title, body, tags, media_url)
  values (
    v_draft.persona_id,
    case when v_draft.content_kind = 'reel' then 'reel' else 'post' end,
    coalesce(v_draft.title,''), coalesce(v_draft.body,''),
    coalesce(v_draft.tags,''), coalesce(v_draft.media_url,'')
  ) returning * into v_post;

  update public.drafts set
    status = 'posted', publish_state = 'published', posted_at = v_now,
    provider_post_id = v_post.id::text, publish_error = ''
  where id = v_draft.id returning * into v_draft;

  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, v_draft.persona_id, v_binding.id, 'publish.completed',
    'draft', v_draft.id, 'ok',
    jsonb_build_object('destination','aliaspaces','destinationId',v_target.id,
      'postId',v_post.id,'atomic',true)
  );

  return jsonb_build_object(
    'published',true,'draftId',v_draft.id,'postId',v_post.id,
    'postedAt',v_now,'idempotent',false
  );
end;
$$;
revoke all on function public.publish_native_agent_draft(uuid,uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.publish_native_agent_draft(uuid,uuid,boolean)
  to service_role;
revoke all on function public.agent_in_quiet_hours(text,time,time,timestamptz)
  from public, anon, authenticated;
grant execute on function public.agent_in_quiet_hours(text,time,time,timestamptz)
  to service_role;

create or replace function public.delete_my_agent_data()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  delete from public.fan_chat_sessions where owner = v_owner;
  delete from public.agent_messages where owner = v_owner;
  delete from public.agent_daily_usage where owner = v_owner;
  delete from public.persona_content_plans where owner = v_owner;
  delete from public.agent_destinations where owner = v_owner;
  delete from public.agent_bindings where owner = v_owner;
  delete from public.agent_owner_settings where owner = v_owner;
  delete from public.agent_actions where owner = v_owner;
  return true;
end;
$$;
revoke all on function public.delete_my_agent_data()
  from public, anon, authenticated;
grant execute on function public.delete_my_agent_data() to authenticated;

update public.ai_tasks set active = active
where cadence in ('manual','daily','weekly')
  and (cadence <> 'weekly' or schedule_day is not null)
  and exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = ai_tasks.timezone
  );

create index if not exists ai_tasks_due_idx
  on public.ai_tasks (active, next_run_at) where active and next_run_at is not null;
create index if not exists ai_tasks_persona_idx
  on public.ai_tasks (persona_id, created_at);
create index if not exists drafts_publish_queue_idx
  on public.drafts (publish_state, publish_at)
  where publish_state = 'queued' and approval_state = 'approved';
create index if not exists drafts_source_task_idx
  on public.drafts (source_task_id);
create unique index if not exists drafts_agent_slot_idx
  on public.drafts (
    source_task_id,
    publish_at,
    coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where generated_by_agent and source_task_id is not null;

create or replace function public.fan_chat_available(p_persona_id uuid)
returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1
    from public.agent_bindings b
    join public.agent_owner_settings s on s.owner = b.owner
    join public.personas p on p.id = b.persona_id and p.owner = b.owner
    where b.persona_id = p_persona_id
      and b.status = 'active'
      and b.claim_state in ('self_attested','verified')
      and b.fan_chat_enabled
      and not s.automation_paused
      and p.visibility in ('public','unlisted')
      and not coalesce(p.nsfw,false)
  );
$$;
revoke all on function public.fan_chat_available(uuid)
  from public, anon, authenticated;
grant execute on function public.fan_chat_available(uuid) to service_role;

-- Supabase projects may have default function grants for anon/authenticated.
-- Explicitly close older owner-only and trigger-only SECURITY DEFINER helpers.
revoke all on function public.verify_account_ledger_email(uuid)
  from public, anon, authenticated;
grant execute on function public.verify_account_ledger_email(uuid) to authenticated;
revoke all on function public.handle_new_user()
  from public, anon, authenticated;

-- Supabase default table privileges can include TRUNCATE, REFERENCES, and
-- TRIGGER. Replace them with the exact browser surface; service_role keeps its
-- server privileges and every owner-facing operation remains RLS-protected.
revoke all on table public.ai_backends from anon, authenticated;
grant select (id, owner, name, base_url, model, provider, extra, created_at)
  on public.ai_backends to authenticated;

revoke all on table public.agent_owner_settings from anon, authenticated;
grant select, insert, update on public.agent_owner_settings to authenticated;

revoke all on table public.agent_bindings from anon, authenticated;
grant select on public.agent_bindings to authenticated;
grant update (status, autonomy_level, fan_chat_enabled, fan_daily_message_limit)
  on public.agent_bindings to authenticated;

revoke all on table public.agent_destinations from anon, authenticated;
grant select, insert, update, delete on public.agent_destinations to authenticated;

revoke all on table public.persona_content_plans from anon, authenticated;
grant select, insert, update, delete on public.persona_content_plans to authenticated;

revoke all on table public.ai_tasks from anon, authenticated;
grant select, delete on public.ai_tasks to authenticated;
grant insert (
  owner, persona_id, backend_id, name, task_type, instructions, cadence,
  active, destination, account_id, content_kind, schedule_day, schedule_time,
  timezone, lead_minutes, approval_required
) on public.ai_tasks to authenticated;
grant update (
  persona_id, backend_id, name, task_type, instructions, cadence,
  active, destination, account_id, content_kind, schedule_day, schedule_time,
  timezone, lead_minutes, approval_required
) on public.ai_tasks to authenticated;

revoke all on table public.drafts from anon, authenticated;
grant select on public.drafts to authenticated;
grant insert (
  owner, persona_id, platform, title, body, tags, media_url, status,
  scheduled_for, account_id, content_kind, publish_at
) on public.drafts to authenticated;
grant update (
  persona_id, platform, title, body, tags, media_url, status,
  scheduled_for, account_id, content_kind, publish_at
) on public.drafts to authenticated;

revoke all on table public.agent_actions from anon, authenticated;
grant select on public.agent_actions to authenticated;

revoke all on table public.agent_messages from anon, authenticated;
grant select, insert, delete on public.agent_messages to authenticated;

revoke all on table public.fan_chat_sessions from anon, authenticated;
grant select on public.fan_chat_sessions to authenticated;
grant update (inbox_state) on public.fan_chat_sessions to authenticated;

revoke all on table public.fan_chat_messages from anon, authenticated;
grant select on public.fan_chat_messages to authenticated;

revoke all on function public.ensure_agent_owner_settings() from public, anon, authenticated;
revoke all on function public.ensure_persona_agent_binding() from public, anon, authenticated;
revoke all on function public.ensure_native_agent_destination() from public, anon, authenticated;
revoke all on function public.set_ai_task_schedule() from public, anon, authenticated;
revoke all on function public.guard_agent_destination() from public, anon, authenticated;
revoke all on function public.guard_agent_owner_settings_timezone()
  from public, anon, authenticated;
revoke all on function public.guard_agent_binding_suspension()
  from public, anon, authenticated;
revoke all on function public.guard_ai_task_assignment() from public, anon, authenticated;
revoke all on function public.guard_draft_assignment() from public, anon, authenticated;
revoke all on function public.invalidate_changed_draft_approval() from public, anon, authenticated;
revoke all on function public.guard_publishing_draft_edit() from public, anon, authenticated;
revoke all on function public.audit_agent_binding_change() from public, anon, authenticated;
revoke all on function public.downgrade_native_auto_destination() from public, anon, authenticated;
revoke all on function public.audit_agent_owner_settings_change() from public, anon, authenticated;
revoke all on function public.audit_agent_destination_change() from public, anon, authenticated;
revoke all on function public.audit_content_plan_change() from public, anon, authenticated;

comment on table public.agent_bindings is
  'Consent and autonomy boundary for one MyPersonas agent bound to one owner-controlled persona.';
comment on table public.persona_content_plans is
  'Owner-authored strategic direction injected into scheduled content generation.';
comment on table public.agent_destinations is
  'Per-persona destination intent and bounds; connector readiness is still attested server-side.';
comment on table public.agent_actions is
  'Append-only owner-visible audit trail for agent generation, approval, publishing, and safety actions.';
comment on table public.agent_messages is
  'Synced owner-to-agent chat history; replaces browser-only localStorage as the durable source of truth.';
comment on table public.fan_chat_sessions is
  'Owner-visible fan-chat inbox. The public reaches it only through the rate-limited fan-chat Edge Function.';
