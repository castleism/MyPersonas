-- Post-live safety and durability hardening for the agent control plane.
-- Migration 011 is already live and immutable. Pause both cron workers before
-- applying this delta, then deploy the matching workers and client before resume.

begin;

-- Error reports remain available signed out, but cannot be forged as another
-- user and new payloads are bounded. Existing oversized rows stay readable.
drop policy if exists "error logs insert" on public.error_logs;
create policy "error logs insert" on public.error_logs for insert with check (
  (auth.uid() is null and user_id is null)
  or (auth.uid() is not null and user_id = auth.uid())
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'error_logs_message_size_check'
    and conrelid = 'public.error_logs'::regclass) then
    alter table public.error_logs add constraint error_logs_message_size_check
      check (char_length(message) <= 2000) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'error_logs_context_size_check'
    and conrelid = 'public.error_logs'::regclass) then
    alter table public.error_logs add constraint error_logs_context_size_check
      check (octet_length(context::text) <= 20000) not valid;
  end if;
end $$;
create or replace function public.my_error_logs()
returns setof public.error_logs language sql security definer stable
set search_path = '' as $$
  select * from public.error_logs where user_id = auth.uid()
  order by created_at asc, id asc;
$$;
revoke all on function public.my_error_logs() from public, anon, authenticated;
grant execute on function public.my_error_logs() to authenticated;

-- Vault-backed model connections must have a credential, while browser clients
-- receive only a boolean readiness signal.
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
  if trim(coalesce(p_api_key,'')) = '' then
    raise exception 'A provider credential is required';
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
revoke all on function public.create_ai_backend(text,text,text,text,text,jsonb)
  from public, anon;
grant execute on function public.create_ai_backend(text,text,text,text,text,jsonb)
  to authenticated;

create or replace function public.my_ai_backend_status()
returns table(backend_id uuid, has_credential boolean)
language sql security definer stable set search_path = '' as $$
  select backend.id,
    trim(coalesce(backend.api_key,'')) <> '' or exists (
      select 1 from public.ai_backend_credentials credential
      join vault.decrypted_secrets secret
        on secret.id = credential.vault_secret_id
      where credential.backend_id = backend.id
        and credential.owner = auth.uid()
        and trim(coalesce(secret.decrypted_secret,'')) <> ''
    )
  from public.ai_backends backend
  where backend.owner = auth.uid();
$$;
revoke all on function public.my_ai_backend_status()
  from public, anon, authenticated;
grant execute on function public.my_ai_backend_status() to authenticated;

-- Narrow public persona reads after the already-live column grants.
drop function if exists public.persona_by_handle(text);
create function public.persona_by_handle(h text)
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
  where p.handle = h and public.persona_visible(p.id)
  limit 1;
$$;
grant execute on function public.persona_by_handle(text) to anon, authenticated;
revoke select on public.personas from anon, authenticated;
revoke select (owner, purpose, voice, audience, dont, ai_backend)
  on public.personas from anon, authenticated;
grant select (
  id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
  bg_url, feed_img_url, music_url, live_url, theme, topics, hashtags,
  top8, modules, linked, created_at
) on public.personas to anon, authenticated;

-- Retry state, fair publish due-times, and durable client message ids.
alter table public.ai_tasks
  add column if not exists retry_count integer not null default 0;
alter table public.drafts
  add column if not exists publish_next_attempt_at timestamptz;
alter table public.agent_messages
  add column if not exists client_message_id uuid;

do $$ begin
  if exists (
    select 1
    from public.agent_messages
    where client_message_id is not null
    group by owner, client_message_id
    having count(*) > 1
  ) then
    raise exception 'Duplicate agent message client ids must be resolved before migration 012';
  end if;
end $$;

create unique index if not exists agent_messages_client_message_idx
  on public.agent_messages (owner, client_message_id);
create index if not exists drafts_auto_publish_due_idx
  on public.drafts (publish_next_attempt_at, publish_at, owner)
  where publish_state = 'queued' and approval_state = 'approved'
    and publish_next_attempt_at is not null;

-- Owners may erase a complete fan conversation without exposing visitor hashes.
create or replace function public.delete_my_fan_chat_session(p_session_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_deleted integer := 0;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  delete from public.fan_chat_sessions
  where id = p_session_id and owner = auth.uid();
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;
revoke all on function public.delete_my_fan_chat_session(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_my_fan_chat_session(uuid)
  to authenticated;

revoke all on table public.fan_chat_sessions from anon, authenticated;
grant select (
  id, owner, persona_id, escalated, escalation_reason, inbox_state,
  created_at, last_seen_at
) on public.fan_chat_sessions to authenticated;
grant update (inbox_state) on public.fan_chat_sessions to authenticated;

-- Scheduled generation keeps its intended slot through bounded transient retries.
create or replace function public.set_ai_task_schedule()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.lease_token := null;
  new.lease_expires_at := null;
  new.retry_count := 0;
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
revoke all on function public.set_ai_task_schedule()
  from public, anon, authenticated;

update public.ai_tasks set
  active = false,
  last_status = 'needs_persona',
  last_error = 'Choose a persona and review this legacy schedule before resuming it.'
where persona_id is null;

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
    retry_count = 0,
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

create or replace function public.retry_ai_task_generation(
  p_task_id uuid,
  p_lease_token uuid,
  p_status text default 'retry_wait',
  p_error text default '',
  p_retry_seconds integer default 300
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_after timestamptz;
  v_attempt integer;
  v_base_seconds integer := least(900, greatest(60, coalesce(p_retry_seconds,300)));
  v_retry_seconds integer;
begin
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  if p_lease_token is null or v_task.lease_token is distinct from p_lease_token
    or v_task.lease_expires_at is null or v_task.lease_expires_at <= now() then
    raise exception 'Task lease no longer belongs to this worker';
  end if;
  v_attempt := coalesce(v_task.retry_count,0) + 1;
  if v_attempt > 3 then
    v_after := greatest(now(), coalesce(v_task.next_publish_at, now())) + interval '1 second';
    update public.ai_tasks set
      last_run = now(), last_status = 'retry_exhausted',
      last_error = left(coalesce(p_error,''),1000), retry_count = 0,
      next_publish_at = case when v_task.active and v_task.cadence <> 'manual'
        then public.next_content_occurrence(v_task.cadence, v_task.schedule_day,
          v_task.schedule_time, v_task.timezone, v_after) else null end,
      lease_token = null, lease_expires_at = null
    where id = p_task_id returning * into v_task;
    update public.ai_tasks set next_run_at = case
      when v_task.next_publish_at is null then null
      else greatest(v_task.next_publish_at - make_interval(mins => v_task.lead_minutes),
        now() + interval '1 minute') end
    where id = p_task_id returning * into v_task;
    return jsonb_build_object('scheduled',false,'exhausted',true,
      'retryCount',3,'nextPublishAt',v_task.next_publish_at);
  end if;
  v_retry_seconds := least(3600, v_base_seconds * case v_attempt
    when 1 then 1 when 2 then 2 else 4 end);
  update public.ai_tasks set
    last_run = now(),
    last_status = left(coalesce(p_status,'retry_wait'),80),
    last_error = left(coalesce(p_error,''),1000),
    next_run_at = now() + make_interval(secs => v_retry_seconds),
    retry_count = v_attempt,
    lease_token = null,
    lease_expires_at = null
  where id = p_task_id returning * into v_task;
  return jsonb_build_object('scheduled',true,'exhausted',false,
    'retryCount',v_attempt,'retrySeconds',v_retry_seconds,
    'nextRunAt',v_task.next_run_at,'nextPublishAt',v_task.next_publish_at);
end;
$$;
revoke all on function public.retry_ai_task_generation(uuid,uuid,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.retry_ai_task_generation(uuid,uuid,text,text,integer)
  to service_role;

-- Exact approvals are invalidated when content, consent, or native targets change.
create or replace function public.normalize_agent_destination(p_destination text)
returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(
    regexp_replace(regexp_replace(regexp_replace(
      lower(trim(coalesce(p_destination,''))), '^https?://', ''
    ), '^www\.', ''), '/$', ''),
    ''
  ), 'aliaspaces');
$$;
revoke all on function public.normalize_agent_destination(text)
  from public, anon, authenticated;

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
      new.publish_next_attempt_at := null;
      new.publish_error := 'Approval was cleared because the content, target, or schedule changed.';
    end if;
  elsif old.approval_state = 'rejected' then
    new.approval_state := 'draft';
    new.approved_at := null;
    new.approved_content_hash := '';
    new.publish_state := 'not_queued';
    new.publish_next_attempt_at := null;
    new.publish_error := '';
  end if;
  return new;
end;
$$;
revoke all on function public.invalidate_changed_draft_approval()
  from public, anon, authenticated;

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
  v_auto_queue boolean := false;
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
  if not found or v_binding.status <> 'active'
    or v_binding.claim_state not in ('self_attested','verified')
    or v_binding.autonomy_level < 2 then
    raise exception 'This persona must have an active, valid L2 or L3 agent before approval';
  end if;
  v_draft.publish_at := coalesce(p_publish_at, v_draft.publish_at, now());
  v_hash := public.agent_draft_hash(v_draft.title, v_draft.body, v_draft.tags,
    v_draft.media_url, v_draft.content_kind, v_draft.persona_id,
    v_draft.account_id, v_draft.platform, v_draft.publish_at);
  v_auto_queue := v_binding.autonomy_level >= 3
    and v_draft.account_id is null
    and public.normalize_agent_destination(v_draft.platform) in (
      'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
    )
    and exists (
      select 1 from public.agent_destinations target
      where target.owner = auth.uid() and target.binding_id = v_binding.id
        and target.persona_id = v_draft.persona_id
        and target.account_id is null and target.enabled and target.mode = 'auto'
        and public.normalize_agent_destination(target.destination) in (
          'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
        )
        and v_draft.content_kind = any(target.allowed_content_types)
    );
  update public.drafts set
    approval_state = 'approved',
    approved_at = now(),
    approved_content_hash = v_hash,
    publish_at = v_draft.publish_at,
    publish_state = case when v_auto_queue then 'queued' else 'not_queued' end,
    publish_next_attempt_at = case when v_auto_queue then v_draft.publish_at else null end,
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
grant execute on function public.approve_agent_draft(uuid,timestamptz)
  to authenticated;

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
    approved_content_hash = '', publish_state = 'not_queued',
    publish_next_attempt_at = null, status = 'idea'
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
     public.normalize_agent_destination(v_draft.platform) in (
       'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
     ) then
    raise exception 'Native posts must use the publishing bridge';
  end if;
  select id into v_binding_id from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  update public.drafts set status = 'posted', publish_state = 'published',
    publish_next_attempt_at = null, posted_at = now(),
    provider_post_id = 'manual', publish_error = ''
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

-- Only currently valid L3 native-auto approvals enter the fair worker queue.
create or replace function public.due_auto_publish_drafts(p_limit integer default 50)
returns setof public.drafts
language sql security definer stable set search_path = '' as $$
  with ranked as (
    select d.id,
      row_number() over (
        partition by d.owner
        order by d.publish_next_attempt_at, d.publish_at, d.id
      ) as owner_rank
    from public.drafts d
    join public.agent_bindings binding
      on binding.owner = d.owner and binding.persona_id = d.persona_id
    join public.agent_owner_settings settings on settings.owner = d.owner
    where d.approval_state = 'approved' and d.publish_state = 'queued'
      and d.publish_at is not null and d.publish_at <= now()
      and d.publish_next_attempt_at is not null
      and d.publish_next_attempt_at <= now()
      and d.account_id is null
      and public.normalize_agent_destination(d.platform) in (
        'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
      )
      and not settings.automation_paused
      and binding.status = 'active'
      and binding.claim_state in ('self_attested','verified')
      and binding.autonomy_level >= 3
      and exists (
        select 1 from public.agent_destinations target
        where target.owner = d.owner and target.binding_id = binding.id
          and target.persona_id = d.persona_id and target.account_id is null
          and target.enabled and target.mode = 'auto'
          and public.normalize_agent_destination(target.destination) in (
            'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
          )
          and d.content_kind = any(target.allowed_content_types)
          and not public.agent_in_quiet_hours(
            settings.default_timezone, target.quiet_hours_start,
            target.quiet_hours_end, now()
          )
      )
      and not public.agent_in_quiet_hours(
        settings.default_timezone, settings.quiet_hours_start,
        settings.quiet_hours_end, now()
      )
  )
  select draft.*
  from ranked
  join public.drafts draft on draft.id = ranked.id
  order by ranked.owner_rank, draft.publish_next_attempt_at,
    draft.publish_at, draft.id
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function public.due_auto_publish_drafts(integer)
  from public, anon, authenticated;
grant execute on function public.due_auto_publish_drafts(integer) to service_role;

-- Repair older approvals: only enabled L3 native-auto rows belong in cron.
update public.drafts draft set
  approval_state = 'pending', approved_at = null, approved_content_hash = '',
  publish_state = 'not_queued', publish_next_attempt_at = null,
  publish_error = 'Automatic publishing was cleared because current agent consent is not valid.'
where draft.approval_state = 'approved' and draft.publish_state = 'queued'
  and not (
    draft.account_id is null
    and public.normalize_agent_destination(draft.platform) in (
      'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
    )
    and exists (
      select 1 from public.agent_bindings binding
      join public.agent_destinations target
        on target.binding_id = binding.id and target.owner = binding.owner
        and target.persona_id = binding.persona_id
      where binding.owner = draft.owner
        and binding.persona_id = draft.persona_id
        and binding.status = 'active'
        and binding.claim_state in ('self_attested','verified')
        and binding.autonomy_level >= 3
        and target.account_id is null and target.enabled and target.mode = 'auto'
        and public.normalize_agent_destination(target.destination) in (
          'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
        )
        and draft.content_kind = any(target.allowed_content_types)
    )
  );
update public.drafts set
  publish_next_attempt_at = coalesce(publish_next_attempt_at, publish_at)
where approval_state = 'approved' and publish_state = 'queued'
  and publish_at is not null;

create or replace function public.dequeue_drafts_after_destination_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.drafts set
      approval_state = 'pending', approved_at = null,
      approved_content_hash = '', publish_state = 'not_queued',
      publish_next_attempt_at = null,
      publish_error = 'Automatic publishing was cleared because the target changed.'
    where owner = old.owner and persona_id = old.persona_id
      and account_id is not distinct from old.account_id
      and approval_state = 'approved' and publish_state = 'queued';
    return old;
  end if;
  if (
    old.owner, old.persona_id, old.account_id, old.destination
  ) is distinct from (
    new.owner, new.persona_id, new.account_id, new.destination
  ) then
    update public.drafts set
      approval_state = 'pending', approved_at = null,
      approved_content_hash = '', publish_state = 'not_queued',
      publish_next_attempt_at = null,
      publish_error = 'Automatic publishing was cleared because the target changed.'
    where owner = old.owner and persona_id = old.persona_id
      and account_id is not distinct from old.account_id
      and approval_state = 'approved' and publish_state = 'queued';
  end if;
  update public.drafts draft set
    approval_state = 'pending', approved_at = null,
    approved_content_hash = '', publish_state = 'not_queued',
    publish_next_attempt_at = null,
    publish_error = 'Automatic publishing was cleared because the target policy changed.'
  where draft.owner = new.owner and draft.persona_id = new.persona_id
    and draft.account_id is not distinct from new.account_id
    and draft.approval_state = 'approved' and draft.publish_state = 'queued'
    and (
      not new.enabled or new.mode <> 'auto' or new.account_id is not null
      or public.normalize_agent_destination(new.destination) not in (
        'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
      )
      or not (draft.content_kind = any(new.allowed_content_types))
    );
  return new;
end;
$$;
drop trigger if exists dequeue_drafts_after_destination_change
  on public.agent_destinations;
create trigger dequeue_drafts_after_destination_change
  after update or delete on public.agent_destinations
  for each row execute function public.dequeue_drafts_after_destination_change();
revoke all on function public.dequeue_drafts_after_destination_change()
  from public, anon, authenticated;

create or replace function public.dequeue_drafts_after_binding_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.drafts set
      approval_state = 'pending', approved_at = null,
      approved_content_hash = '', publish_state = 'not_queued',
      publish_next_attempt_at = null,
      publish_error = 'Automatic publishing was cleared because L3 consent changed.'
    where owner = old.owner and persona_id = old.persona_id
      and approval_state = 'approved' and publish_state = 'queued';
    return old;
  end if;
  if (old.owner, old.persona_id) is distinct from (new.owner, new.persona_id)
    or (old.autonomy_level >= 3 and new.autonomy_level < 3)
    or (new.status <> 'active' and old.status is distinct from new.status)
    or (
      new.claim_state not in ('self_attested','verified')
      and old.claim_state is distinct from new.claim_state
    ) then
    update public.drafts set
      approval_state = 'pending', approved_at = null,
      approved_content_hash = '', publish_state = 'not_queued',
      publish_next_attempt_at = null,
      publish_error = 'Automatic publishing was cleared because L3 consent changed.'
    where owner = old.owner and persona_id = old.persona_id
      and approval_state = 'approved' and publish_state = 'queued';
  end if;
  return new;
end;
$$;
drop trigger if exists dequeue_drafts_after_binding_change on public.agent_bindings;
create trigger dequeue_drafts_after_binding_change
  after update of owner, persona_id, autonomy_level, status, claim_state
    or delete on public.agent_bindings
  for each row execute function public.dequeue_drafts_after_binding_change();
revoke all on function public.dequeue_drafts_after_binding_change()
  from public, anon, authenticated;

-- Native publication rechecks normalized destination, exact consent, quiet hours,
-- and per-day limits in the same transaction as the post.
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
     public.normalize_agent_destination(v_draft.platform) not in (
       'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
     ) then
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
      and public.normalize_agent_destination(destination) in (
        'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
      )
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
      and public.normalize_agent_destination(d.platform) in (
        'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
      )
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
    publish_next_attempt_at = null, provider_post_id = v_post.id::text,
    publish_error = ''
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

commit;
