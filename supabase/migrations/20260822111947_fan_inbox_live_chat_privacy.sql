-- ======================================================================
-- Migration 046: Owner fan inbox, bounded live takeover, and fan privacy
--
-- Saved mode: the owner can review the transcript until it is deleted.
-- Ephemeral mode: messages exist only while the session is open so the AI
-- and a live owner can reply. Closing deletes the session; idle sessions
-- expire after 30 minutes and are removed by the cleanup job.
--
-- This migration does not enable fan chat or any external provider.
-- Apply only after migrations 011 and 045.
-- ======================================================================

begin;

alter table public.fan_chat_sessions
  add column if not exists retention_mode text not null default 'saved',
  add column if not exists privacy_notice_version text not null default 'legacy-owner-review-v1',
  add column if not exists privacy_acknowledged_at timestamptz,
  add column if not exists ephemeral_expires_at timestamptz,
  add column if not exists owner_live_until timestamptz,
  add column if not exists owner_live_started_at timestamptz,
  add column if not exists owner_live_started_by uuid;

alter table public.fan_chat_sessions
  drop constraint if exists fan_chat_sessions_retention_mode_check;
alter table public.fan_chat_sessions
  add constraint fan_chat_sessions_retention_mode_check
  check (retention_mode in ('saved','ephemeral'));

alter table public.fan_chat_sessions
  drop constraint if exists fan_chat_sessions_privacy_notice_check;
alter table public.fan_chat_sessions
  add constraint fan_chat_sessions_privacy_notice_check check (
    privacy_notice_version in ('legacy-owner-review-v1','owner-visible-v2') and
    (privacy_notice_version <> 'owner-visible-v2' or privacy_acknowledged_at is not null)
  );

alter table public.fan_chat_sessions
  drop constraint if exists fan_chat_sessions_ephemeral_expiry_check;
alter table public.fan_chat_sessions
  add constraint fan_chat_sessions_ephemeral_expiry_check check (
    (retention_mode = 'saved' and ephemeral_expires_at is null) or
    (retention_mode = 'ephemeral' and ephemeral_expires_at is not null)
  );

alter table public.fan_chat_messages
  drop constraint if exists fan_chat_messages_role_check;
alter table public.fan_chat_messages
  add constraint fan_chat_messages_role_check
  check (role in ('fan','assistant','owner','system'));

create index if not exists fan_chat_sessions_ephemeral_expiry_idx
  on public.fan_chat_sessions(ephemeral_expires_at)
  where retention_mode = 'ephemeral';
create index if not exists fan_chat_sessions_owner_live_idx
  on public.fan_chat_sessions(owner, owner_live_until desc)
  where owner_live_until is not null;

-- Content-free quota receipts survive ephemeral transcript deletion long
-- enough to enforce hourly and persona-daily model-cost limits. No message
-- text, generated reply, or raw visitor token is stored here.
create table if not exists public.fan_chat_usage_receipts (
  id uuid primary key default gen_random_uuid(),
  source_message_id uuid not null unique,
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid not null,
  visitor_key_hash text not null check (visitor_key_hash ~ '^[0-9a-f]{64}$'),
  message_characters integer not null check (message_characters between 1 and 2000),
  created_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.fan_chat_usage_receipts enable row level security;
revoke all on public.fan_chat_usage_receipts from public, anon, authenticated;
grant select, insert, delete on public.fan_chat_usage_receipts to service_role;
create index if not exists fan_chat_usage_persona_time_idx
  on public.fan_chat_usage_receipts(owner, persona_id, created_at);
create index if not exists fan_chat_usage_visitor_time_idx
  on public.fan_chat_usage_receipts(persona_id, visitor_key_hash, created_at);

insert into public.fan_chat_usage_receipts (
  source_message_id, owner, persona_id, visitor_key_hash,
  message_characters, created_at
)
select m.id, m.owner, m.persona_id, s.visitor_key_hash,
       char_length(m.content), m.created_at
from public.fan_chat_messages m
join public.fan_chat_sessions s on s.id = m.session_id
where m.role = 'fan' and m.created_at >= now() - interval '48 hours'
on conflict (source_message_id) do nothing;

-- Create or validate the privacy mode before the first message. The visitor
-- token is represented only by its server-side HMAC hash.
create or replace function public.ensure_fan_chat_session(
  p_session_id uuid,
  p_persona_id uuid,
  p_owner uuid,
  p_visitor_key_hash text,
  p_retention_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.fan_chat_sessions%rowtype;
begin
  if p_session_id is null or p_persona_id is null or p_owner is null or
     p_visitor_key_hash !~ '^[0-9a-f]{64}$' or
     p_retention_mode not in ('saved','ephemeral') then
    return jsonb_build_object('accepted',false,'code','invalid_request');
  end if;

  if not exists (
    select 1
    from public.personas p
    join public.agent_bindings b
      on b.persona_id = p.id and b.owner = p.owner
    join public.agent_owner_settings s on s.owner = p.owner
    where p.id = p_persona_id and p.owner = p_owner
      and p.visibility in ('public','unlisted')
      and not coalesce(p.nsfw,false)
      and b.status = 'active'
      and b.claim_state in ('self_attested','verified')
      and b.fan_chat_enabled
      and not s.automation_paused
  ) then
    return jsonb_build_object('accepted',false,'code','persona_unavailable');
  end if;

  select * into v_session from public.fan_chat_sessions
    where id = p_session_id for update;
  if found then
    if v_session.owner <> p_owner or
       v_session.persona_id <> p_persona_id or
       v_session.visitor_key_hash <> p_visitor_key_hash then
      return jsonb_build_object('accepted',false,'code','invalid_session');
    end if;
    if v_session.privacy_notice_version <> 'owner-visible-v2' or
       v_session.privacy_acknowledged_at is null then
      return jsonb_build_object('accepted',false,'code','legacy_session');
    end if;
    if v_session.retention_mode <> p_retention_mode then
      return jsonb_build_object('accepted',false,'code','privacy_mode_mismatch');
    end if;
    if v_session.retention_mode = 'ephemeral' and
       v_session.ephemeral_expires_at <= now() then
      delete from public.fan_chat_sessions where id = p_session_id;
      return jsonb_build_object('accepted',false,'code','session_expired');
    end if;
    if v_session.retention_mode = 'ephemeral' then
      update public.fan_chat_sessions set
        ephemeral_expires_at = now() + interval '30 minutes',
        last_seen_at = now()
      where id = p_session_id;
    end if;
    return jsonb_build_object('accepted',true,'created',false);
  end if;

  insert into public.fan_chat_sessions (
    id, owner, persona_id, visitor_key_hash, retention_mode,
    privacy_notice_version, privacy_acknowledged_at,
    ephemeral_expires_at, inbox_state, last_seen_at
  ) values (
    p_session_id, p_owner, p_persona_id, p_visitor_key_hash, p_retention_mode,
    'owner-visible-v2', now(),
    case when p_retention_mode = 'ephemeral'
      then now() + interval '30 minutes' else null end,
    'unread', now()
  );
  return jsonb_build_object('accepted',true,'created',true);
end;
$$;

-- Replace the original reservation with owner-live awareness while retaining
-- the original signature for deployed clients.
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
  v_owner_live boolean := false;
  v_usage_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_daily_count integer := 0;
  v_hourly_count integer := 0;
  v_message_id uuid;
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
  if v_session_found and v_session.retention_mode = 'ephemeral' and
     v_session.ephemeral_expires_at <= now() then
    delete from public.fan_chat_sessions where id = p_session_id;
    return jsonb_build_object('accepted',false,'code','session_expired');
  end if;
  if v_session_found and v_session.response_pending and
     v_session.response_lease_expires_at > now() then
    return jsonb_build_object('accepted',false,'code','session_busy');
  end if;

  select count(*) into v_daily_count from public.fan_chat_usage_receipts
    where owner = p_owner and persona_id = p_persona_id
      and created_at >= v_day_start and created_at < v_day_end;
  if v_daily_count >= v_binding.fan_daily_message_limit then
    return jsonb_build_object(
      'accepted',false,'code','persona_daily_limit',
      'used',v_daily_count,'limit',v_binding.fan_daily_message_limit
    );
  end if;

  select count(*) into v_hourly_count
  from public.fan_chat_usage_receipts receipt
  where receipt.persona_id = p_persona_id
    and receipt.visitor_key_hash = p_visitor_key_hash
    and receipt.created_at >= now() - interval '1 hour';
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
  v_owner_live := v_session_found and v_session.owner_live_until > now();
  v_awaiting_human := v_session_found and v_session.escalated
    and v_session.inbox_state <> 'resolved';
  v_escalated := cardinality(v_reasons) > 0 or v_awaiting_human;

  if not v_session_found then
    -- Backward-compatible saved session for an older client that did not call
    -- ensure_fan_chat_session first.
    insert into public.fan_chat_sessions (
      id, owner, persona_id, visitor_key_hash, escalated,
      escalation_reason, inbox_state, response_pending,
      response_lease_token, response_lease_expires_at, last_seen_at,
      retention_mode
    ) values (
      p_session_id, p_owner, p_persona_id, p_visitor_key_hash, v_escalated,
      case when cardinality(v_reasons) > 0
        then left(array_to_string(v_reasons,','),200) else '' end,
      'unread', true, p_response_token, now() + interval '90 seconds', now(),
      'saved'
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
      ephemeral_expires_at = case when retention_mode = 'ephemeral'
        then now() + interval '30 minutes' else null end,
      response_pending = not v_owner_live,
      response_lease_token = case when v_owner_live then null else p_response_token end,
      response_lease_expires_at = case when v_owner_live then null else now() + interval '90 seconds' end
    where id = p_session_id returning * into v_session;
  end if;

  insert into public.fan_chat_messages (
    session_id, owner, persona_id, role, content, flagged
  ) values (
    p_session_id, p_owner, p_persona_id, 'fan', trim(p_message), v_escalated
  ) returning id into v_message_id;
  insert into public.fan_chat_usage_receipts (
    source_message_id, owner, persona_id, visitor_key_hash, message_characters
  ) values (
    v_message_id, p_owner, p_persona_id, p_visitor_key_hash,
    char_length(trim(p_message))
  );
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, p_persona_id, v_binding.id, 'fan_chat.received',
    'fan_chat_session', p_session_id,
    case when v_owner_live then 'owner_live'
      when v_escalated then 'escalated' else 'ok' end,
    jsonb_build_object('messageCharacters',char_length(trim(p_message)),
      'dailyMessageNumber',v_daily_count + 1,
      'retentionMode',v_session.retention_mode,
      'categories',to_jsonb(v_reasons))
  );
  return jsonb_build_object(
    'accepted',true,'escalated',v_escalated,
    'awaitingHuman',v_awaiting_human,'ownerLive',v_owner_live,
    'categories',to_jsonb(v_reasons),
    'retentionMode',v_session.retention_mode,
    'dailyMessageNumber',v_daily_count + 1
  );
end;
$$;

-- Authenticated owner controls. The time limit is finite and the owner cannot
-- start while an AI response lease is active, avoiding mixed human/AI replies.
create or replace function public.start_fan_chat_live(
  p_session_id uuid,
  p_minutes integer
)
returns public.fan_chat_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_session public.fan_chat_sessions%rowtype;
begin
  if v_owner is null then
    raise sqlstate '28000' using message = 'Authentication required';
  end if;
  if p_minutes not in (5,15,30,60) then
    raise sqlstate '22023' using message = 'Live chat duration must be 5, 15, 30, or 60 minutes';
  end if;
  select * into v_session from public.fan_chat_sessions
    where id = p_session_id and owner = v_owner for update;
  if not found then raise sqlstate 'P0002' using message = 'Fan chat not found'; end if;
  if not exists (
    select 1 from public.agent_bindings b
    join public.agent_owner_settings s on s.owner = b.owner
    where b.owner = v_owner and b.persona_id = v_session.persona_id
      and b.status = 'active' and b.fan_chat_enabled
      and b.claim_state in ('self_attested','verified')
      and not s.automation_paused
  ) then
    raise sqlstate '55000' using message = 'Fan chat is disabled or globally paused';
  end if;
  if v_session.retention_mode = 'ephemeral' and v_session.ephemeral_expires_at <= now() then
    delete from public.fan_chat_sessions where id = p_session_id;
    raise sqlstate 'P0002' using message = 'Ephemeral fan chat expired';
  end if;
  if v_session.privacy_notice_version <> 'owner-visible-v2' or
     v_session.privacy_acknowledged_at is null then
    raise sqlstate '42501' using message = 'This legacy chat did not record the current owner-visibility consent; ask the fan to start a new chat';
  end if;
  if v_session.response_pending and v_session.response_lease_expires_at > now() then
    raise sqlstate '55000' using message = 'Wait for the current AI reply before starting live chat';
  end if;

  update public.fan_chat_sessions set
    owner_live_started_at = now(), owner_live_started_by = v_owner,
    owner_live_until = now() + make_interval(mins => p_minutes),
    response_pending = false, response_lease_token = null,
    response_lease_expires_at = null, inbox_state = 'read',
    ephemeral_expires_at = case when retention_mode = 'ephemeral'
      then greatest(ephemeral_expires_at, now() + make_interval(mins => p_minutes) + interval '5 minutes')
      else null end
  where id = p_session_id returning * into v_session;

  insert into public.fan_chat_messages (
    session_id, owner, persona_id, role, content
  ) values (
    v_session.id, v_session.owner, v_session.persona_id, 'system',
    'The human persona owner joined live chat. Human replies are labeled Owner.'
  );
  insert into public.agent_actions (
    owner, persona_id, action_type, entity_type, entity_id, outcome, detail
  ) values (
    v_owner, v_session.persona_id, 'fan_chat.owner_live_started',
    'fan_chat_session', v_session.id, 'owner_live',
    jsonb_build_object('minutes',p_minutes,'retentionMode',v_session.retention_mode)
  );
  return v_session;
end;
$$;

create or replace function public.stop_fan_chat_live(p_session_id uuid)
returns public.fan_chat_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_session public.fan_chat_sessions%rowtype;
  v_was_live boolean := false;
begin
  if v_owner is null then raise sqlstate '28000' using message = 'Authentication required'; end if;
  select * into v_session from public.fan_chat_sessions
    where id = p_session_id and owner = v_owner for update;
  if not found then raise sqlstate 'P0002' using message = 'Fan chat not found'; end if;
  v_was_live := v_session.owner_live_until > now();
  update public.fan_chat_sessions set owner_live_until = null
    where id = p_session_id returning * into v_session;
  if v_was_live then
    insert into public.fan_chat_messages (
      session_id, owner, persona_id, role, content
    ) values (
      v_session.id, v_session.owner, v_session.persona_id, 'system',
      'Live owner chat ended. New replies will come from the disclosed AI assistant.'
    );
  end if;
  insert into public.agent_actions (
    owner, persona_id, action_type, entity_type, entity_id, outcome
  ) values (
    v_owner, v_session.persona_id, 'fan_chat.owner_live_stopped',
    'fan_chat_session', v_session.id, 'ok'
  );
  return v_session;
end;
$$;

create or replace function public.send_owner_fan_chat_message(
  p_session_id uuid,
  p_content text
)
returns public.fan_chat_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_session public.fan_chat_sessions%rowtype;
  v_message public.fan_chat_messages%rowtype;
begin
  if v_owner is null then raise sqlstate '28000' using message = 'Authentication required'; end if;
  if char_length(trim(coalesce(p_content,''))) not between 1 and 4000 then
    raise sqlstate '22023' using message = 'Owner message must be between 1 and 4000 characters';
  end if;
  select * into v_session from public.fan_chat_sessions
    where id = p_session_id and owner = v_owner for update;
  if not found then raise sqlstate 'P0002' using message = 'Fan chat not found'; end if;
  if not exists (
    select 1 from public.agent_bindings b
    join public.agent_owner_settings s on s.owner = b.owner
    where b.owner = v_owner and b.persona_id = v_session.persona_id
      and b.status = 'active' and b.fan_chat_enabled
      and b.claim_state in ('self_attested','verified')
      and not s.automation_paused
  ) then
    raise sqlstate '55000' using message = 'Fan chat is disabled or globally paused';
  end if;
  if v_session.owner_live_until is null or v_session.owner_live_until <= now() then
    raise sqlstate '55000' using message = 'Start a live-chat window before replying as the owner';
  end if;
  insert into public.fan_chat_messages (
    session_id, owner, persona_id, role, content
  ) values (
    v_session.id, v_owner, v_session.persona_id, 'owner', trim(p_content)
  ) returning * into v_message;
  update public.fan_chat_sessions set
    last_seen_at = now(), inbox_state = 'read',
    ephemeral_expires_at = case when retention_mode = 'ephemeral'
      then greatest(ephemeral_expires_at, owner_live_until + interval '5 minutes')
      else null end
  where id = v_session.id;
  insert into public.agent_actions (
    owner, persona_id, action_type, entity_type, entity_id, outcome, detail
  ) values (
    v_owner, v_session.persona_id, 'fan_chat.owner_message',
    'fan_chat_session', v_session.id, 'sent',
    jsonb_build_object('messageCharacters',char_length(trim(p_content)),
      'retentionMode',v_session.retention_mode)
  );
  return v_message;
end;
$$;

-- Visitor-authorized hard deletion for ephemeral chat close. Saved chats are
-- intentionally not affected by this helper.
create or replace function public.close_ephemeral_fan_chat(
  p_session_id uuid,
  p_persona_id uuid,
  p_visitor_key_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_deleted uuid;
begin
  delete from public.fan_chat_sessions
  where id = p_session_id and persona_id = p_persona_id
    and visitor_key_hash = p_visitor_key_hash
    and retention_mode = 'ephemeral'
  returning id into v_deleted;
  return v_deleted is not null;
end;
$$;

create or replace function public.discard_empty_fan_chat_session(
  p_session_id uuid,
  p_persona_id uuid,
  p_visitor_key_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_deleted uuid;
begin
  delete from public.fan_chat_sessions s
  where s.id = p_session_id and s.persona_id = p_persona_id
    and s.visitor_key_hash = p_visitor_key_hash
    and not exists (
      select 1 from public.fan_chat_messages m where m.session_id = s.id
    )
  returning s.id into v_deleted;
  return v_deleted is not null;
end;
$$;

create or replace function public.purge_expired_ephemeral_fan_chats()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_deleted integer := 0;
begin
  delete from public.fan_chat_sessions
    where retention_mode = 'ephemeral' and ephemeral_expires_at <= now();
  get diagnostics v_deleted = row_count;
  delete from public.fan_chat_sessions s
    where s.created_at < now() - interval '10 minutes'
      and not exists (
        select 1 from public.fan_chat_messages m where m.session_id = s.id
      );
  delete from public.fan_chat_usage_receipts
    where created_at < now() - interval '48 hours';
  return v_deleted;
end;
$$;

-- Account-wide, content-free notification: private message text is never
-- copied into a notification record.
alter table public.owner_notifications
  drop constraint if exists owner_notifications_notification_type_check;
alter table public.owner_notifications
  add constraint owner_notifications_notification_type_check check (
    notification_type in (
      'brief_ready','content_review','schedule_due','publish_attention',
      'account_attention','fan_message','system'
    )
  );

create or replace function public.notify_owner_fan_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_name text;
begin
  if new.role <> 'fan' then return new; end if;
  select name into v_name from public.personas where id = new.persona_id;
  insert into public.owner_notifications (
    owner, persona_id, notification_type, title, body, action_route,
    subject_type, subject_id, dedupe_key, status, read_at, updated_at
  ) values (
    new.owner, new.persona_id, 'fan_message',
    'New fan message for ' || coalesce(v_name,'persona'),
    'Open the private fan inbox to review the conversation.',
    'fan-inbox/' || new.session_id, 'fan_chat_session', new.session_id,
    'fan-chat:' || new.session_id, 'unread', null, now()
  ) on conflict (owner,dedupe_key) where dedupe_key <> '' do update set
    title = excluded.title, body = excluded.body,
    action_route = excluded.action_route, status = 'unread', read_at = null,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists notify_owner_fan_message on public.fan_chat_messages;
create trigger notify_owner_fan_message
after insert on public.fan_chat_messages
for each row execute function public.notify_owner_fan_message();

create or replace function public.cleanup_deleted_fan_chat_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.owner_notifications
    where owner = old.owner and subject_type = 'fan_chat_session'
      and subject_id = old.id;
  return old;
end;
$$;

drop trigger if exists cleanup_deleted_fan_chat_notification on public.fan_chat_sessions;
create trigger cleanup_deleted_fan_chat_notification
after delete on public.fan_chat_sessions
for each row execute function public.cleanup_deleted_fan_chat_notification();

revoke all on function public.ensure_fan_chat_session(uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.ensure_fan_chat_session(uuid,uuid,uuid,text,text)
  to service_role;
revoke all on function public.close_ephemeral_fan_chat(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.close_ephemeral_fan_chat(uuid,uuid,text)
  to service_role;
revoke all on function public.discard_empty_fan_chat_session(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.discard_empty_fan_chat_session(uuid,uuid,text)
  to service_role;
revoke all on function public.purge_expired_ephemeral_fan_chats()
  from public, anon, authenticated;
grant execute on function public.purge_expired_ephemeral_fan_chats()
  to service_role;

revoke all on function public.start_fan_chat_live(uuid,integer)
  from public, anon, authenticated;
grant execute on function public.start_fan_chat_live(uuid,integer)
  to authenticated;
revoke all on function public.stop_fan_chat_live(uuid)
  from public, anon, authenticated;
grant execute on function public.stop_fan_chat_live(uuid)
  to authenticated;
revoke all on function public.send_owner_fan_chat_message(uuid,text)
  from public, anon, authenticated;
grant execute on function public.send_owner_fan_chat_message(uuid,text)
  to authenticated;

-- Owners keep read-only table access. Live state and owner messages flow only
-- through the authenticated RPCs above.
revoke update on public.fan_chat_sessions from authenticated;
grant update (inbox_state) on public.fan_chat_sessions to authenticated;
revoke insert, update, delete on public.fan_chat_messages from authenticated;

comment on column public.fan_chat_sessions.retention_mode is
  'saved retains an owner-visible transcript; ephemeral is temporarily visible while open and hard-deleted on close or idle expiry.';
comment on column public.fan_chat_sessions.owner_live_until is
  'Finite server-enforced window during which AI replies pause and authenticated owner messages are allowed.';

-- Required privacy backstop. Explicit close remains the immediate deletion
-- path; pg_cron removes abandoned ephemeral tabs. Fail the migration if that
-- promise cannot be scheduled.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'Migration 046 requires pg_cron for the ephemeral-chat deletion promise';
  end if;
  begin
    perform cron.unschedule('fan-chat-ephemeral-cleanup')
    where exists (select 1 from cron.job where jobname = 'fan-chat-ephemeral-cleanup');
  exception when others then null;
  end;
  perform cron.schedule(
    'fan-chat-ephemeral-cleanup',
    '*/5 * * * *',
    'select public.purge_expired_ephemeral_fan_chats();'
  );
end $$;

commit;

-- Deployment order:
-- 1. Apply 046 in an approved non-production environment.
-- 2. Deploy the matching fan-chat Edge Function.
-- 3. Test saved close, ephemeral close, idle expiry, owner live expiry,
--    concurrent AI/live takeover, unrelated-owner denial, and account erasure.
