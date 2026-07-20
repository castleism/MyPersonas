-- Fair owner rotation and a bounded active-schedule surface.
-- Migrations 011 and 012 are already live and immutable. Apply this migration
-- before deploying the matching run-tasks worker.

begin;

-- Keep scheduling fairness in a service-only table so owners cannot reset their
-- place by editing or deleting tasks. An absent row means the owner has not yet
-- been served and therefore sorts ahead of previously served owners.
create table if not exists public.agent_generation_queue_state (
  owner uuid primary key references public.profiles(id) on delete cascade,
  last_claimed_at timestamptz not null default now(),
  claim_count bigint not null default 0 check (claim_count >= 0),
  updated_at timestamptz not null default now()
);
alter table public.agent_generation_queue_state enable row level security;
revoke all on table public.agent_generation_queue_state
  from public, anon, authenticated;
grant select, insert, update, delete on public.agent_generation_queue_state
  to service_role;

-- Return due work in rounds: every owner's oldest due task is considered before
-- any owner's second task, and least-recently-served owners lead each round.
-- Only the service worker may inspect this cross-owner queue.
create or replace function public.due_ai_generation_tasks(
  p_due_at timestamptz default now(),
  p_limit integer default 8
)
returns setof public.ai_tasks
language sql security definer stable set search_path = '' as $$
  with due as (
    select
      task.id,
      task.owner,
      task.next_run_at,
      row_number() over (
        partition by task.owner
        order by task.next_run_at asc, task.id asc
      ) as owner_rank
    from public.ai_tasks task
    where task.active
      and task.next_run_at is not null
      and task.next_run_at <= p_due_at
      and (
        task.lease_expires_at is null
        or task.lease_expires_at <= p_due_at
      )
  )
  select task.*
  from due
  join public.ai_tasks task on task.id = due.id
  left join public.agent_generation_queue_state queue
    on queue.owner = due.owner
  order by
    due.owner_rank asc,
    queue.last_claimed_at asc nulls first,
    due.next_run_at asc,
    due.owner asc,
    due.id asc
  limit least(100, greatest(1, coalesce(p_limit, 8)));
$$;
revoke all on function public.due_ai_generation_tasks(timestamptz,integer)
  from public, anon, authenticated;
grant execute on function public.due_ai_generation_tasks(timestamptz,integer)
  to service_role;

-- A successful lease claim is the durable fairness event. Failed or raced
-- claims do not move an owner to the back of the queue.
create or replace function public.claim_ai_task_generation(
  p_task_id uuid,
  p_due_at timestamptz,
  p_lease_token uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_claimed_at timestamptz;
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
  v_claimed_at := clock_timestamp();
  insert into public.agent_generation_queue_state (
    owner, last_claimed_at, claim_count, updated_at
  ) values (
    v_task.owner, v_claimed_at, 1, v_claimed_at
  )
  on conflict (owner) do update set
    last_claimed_at = greatest(
      public.agent_generation_queue_state.last_claimed_at,
      excluded.last_claimed_at
    ),
    claim_count = public.agent_generation_queue_state.claim_count + 1,
    updated_at = greatest(
      public.agent_generation_queue_state.updated_at,
      excluded.updated_at
    );
  return true;
end;
$$;
revoke all on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  to service_role;

-- Deterministic input violations cannot improve on retry. Pause the task and
-- release its lease so one bad field cannot consume quota or a worker slot on
-- every recurrence. Re-enabling after an owner edit recomputes its schedule.
create or replace function public.block_ai_task_input(
  p_task_id uuid,
  p_lease_token uuid,
  p_error text default 'Generation input exceeds the configured limit.'
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_task public.ai_tasks%rowtype;
begin
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found or p_lease_token is null
    or v_task.lease_token is distinct from p_lease_token
    or v_task.lease_expires_at is null or v_task.lease_expires_at <= now() then
    return false;
  end if;
  update public.ai_tasks set
    active = false,
    next_run_at = null,
    next_publish_at = null,
    last_run = now(),
    last_status = 'input_too_large',
    last_error = left(coalesce(p_error,''),1000),
    retry_count = 0,
    lease_token = null,
    lease_expires_at = null
  where id = p_task_id;
  return true;
end;
$$;
revoke all on function public.block_ai_task_input(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.block_ai_task_input(uuid,uuid,text)
  to service_role;

-- Bound new or changed provider-input fields at the data boundary. The trigger
-- compares updates field-by-field so an untouched oversized legacy value does
-- not prevent an owner from editing other settings; the worker separately
-- enforces the aggregate request budget before reserving or calling a model.
create or replace function public.enforce_agent_prompt_text_limits()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_limits jsonb;
  v_field text;
  v_limit integer;
  v_value text;
  v_changed boolean;
begin
  case tg_table_name
    when 'personas' then v_limits := '{
      "name": 256,
      "tagline": 512,
      "bio": 2048,
      "purpose": 1024,
      "voice": 2048,
      "topics": 1024,
      "audience": 1024,
      "hashtags": 1024,
      "dont": 3072
    }'::jsonb;
    when 'persona_content_plans' then v_limits := '{
      "primary_goal": 768,
      "success_metric": 512,
      "audience_focus": 768,
      "content_pillars": 1024,
      "current_campaign": 768,
      "calls_to_action": 768,
      "offers_and_links": 1536,
      "affiliate_disclosure": 512,
      "source_notes": 1536,
      "platform_guidance": 1024
    }'::jsonb;
    when 'ai_tasks' then v_limits := '{
      "name": 256,
      "instructions": 4096,
      "destination": 128
    }'::jsonb;
    when 'account_ledger' then v_limits := '{
      "provider": 128
    }'::jsonb;
    else
      raise exception 'Unsupported prompt-input table %', tg_table_name;
  end case;

  for v_field, v_limit in
    select entry.key, entry.value::integer
    from jsonb_each_text(v_limits) entry
    order by entry.key
  loop
    v_value := coalesce(to_jsonb(new) ->> v_field, '');
    if tg_op = 'INSERT' then
      v_changed := true;
    else
      v_changed := (to_jsonb(new) ->> v_field)
        is distinct from (to_jsonb(old) ->> v_field);
    end if;
    if v_changed and octet_length(v_value) > v_limit then
      raise exception using
        errcode = '22001',
        message = format(
          '%s.%s may be at most %s UTF-8 bytes',
          tg_table_name, v_field, v_limit
        );
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.enforce_agent_prompt_text_limits()
  from public, anon, authenticated;

drop trigger if exists enforce_agent_prompt_text_limits on public.personas;
create trigger enforce_agent_prompt_text_limits
  before insert or update on public.personas
  for each row execute function public.enforce_agent_prompt_text_limits();
drop trigger if exists enforce_agent_prompt_text_limits
  on public.persona_content_plans;
create trigger enforce_agent_prompt_text_limits
  before insert or update on public.persona_content_plans
  for each row execute function public.enforce_agent_prompt_text_limits();
drop trigger if exists enforce_agent_prompt_text_limits on public.ai_tasks;
create trigger enforce_agent_prompt_text_limits
  before insert or update on public.ai_tasks
  for each row execute function public.enforce_agent_prompt_text_limits();
drop trigger if exists enforce_agent_prompt_text_limits on public.account_ledger;
create trigger enforce_agent_prompt_text_limits
  before insert or update on public.account_ledger
  for each row execute function public.enforce_agent_prompt_text_limits();

-- Cap newly created or newly re-enabled schedules without disabling or blocking
-- edits to rows that were already active before this migration. Lock the owner
-- profile row so concurrent activations cannot both pass the count check.
create or replace function public.enforce_ai_task_active_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_enforce boolean := false;
  v_active_count integer := 0;
begin
  if new.active then
    if tg_op = 'INSERT' then
      v_enforce := true;
    elsif not coalesce(old.active, false) or new.owner is distinct from old.owner then
      v_enforce := true;
    end if;
  end if;
  if not v_enforce then return new; end if;

  perform 1 from public.profiles profile where profile.id = new.owner for update;
  select count(*) into v_active_count
  from public.ai_tasks task
  where task.owner = new.owner
    and task.active
    and (tg_op = 'INSERT' or task.id <> new.id);
  if v_active_count >= 100 then
    raise exception using
      errcode = '23514',
      message = 'An account may have at most 100 active schedules',
      hint = 'Pause an active schedule before enabling another one.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_ai_task_active_limit()
  from public, anon, authenticated;

drop trigger if exists enforce_ai_task_active_limit on public.ai_tasks;
create trigger enforce_ai_task_active_limit
  before insert or update of active, owner on public.ai_tasks
  for each row execute function public.enforce_ai_task_active_limit();

comment on table public.agent_generation_queue_state is
  'Service-only least-recently-served state for fair scheduled generation across owners.';

commit;
