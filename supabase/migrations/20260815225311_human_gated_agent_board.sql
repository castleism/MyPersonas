-- ======================================================================
-- Migration 042: Human-Gated Agent Board
-- Phase 4 of the Weekend Command Center Plan
-- ======================================================================

create table if not exists public.agent_board_settings (
  persona_id            uuid not null references public.personas(id) on delete cascade,
  owner                 uuid not null,
  proposals_enabled     boolean not null default false,
  execution_enabled     boolean not null default false,
  approval_required     boolean not null default true,
  allowed_task_types    text[]  not null default '{}',
  daily_proposal_limit  int     not null default 10,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (persona_id)
);

insert into public.agent_board_settings (persona_id, owner)
select id, owner from public.personas
on conflict (persona_id) do nothing;

create or replace function public.auto_create_agent_board_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_board_settings (persona_id, owner)
  values (new.id, new.owner)
  on conflict (persona_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_auto_board_settings on public.personas;
create trigger trg_auto_board_settings
  after insert on public.personas
  for each row execute function public.auto_create_agent_board_settings();

create table if not exists public.agent_board_requests (
  id                  uuid not null default gen_random_uuid() primary key,
  owner               uuid not null,
  source_persona_id   uuid not null references public.personas(id) on delete cascade,
  target_persona_id   uuid not null references public.personas(id) on delete cascade,
  target_backend_id   uuid,
  parent_request_id   uuid,
  task_type           text not null default 'review_draft',
  subject_type        text not null default 'post_draft',
  subject_id          uuid,
  instructions        text not null default '',
  context             jsonb not null default '{}'::jsonb,
  risk_level          text not null default 'low' check (risk_level in ('low','medium','high')),
  status              text not null default 'proposed' check (status in ('proposed','owner_review','approved','running','completed','failed','rejected','cancelled')),
  approved_by         uuid,
  approved_at         timestamptz,
  rejected_by         uuid,
  rejected_at         timestamptz,
  rejection_reason    text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.agent_board_runs (
  id                uuid not null default gen_random_uuid() primary key,
  owner             uuid not null,
  request_id        uuid not null references public.agent_board_requests(id) on delete cascade,
  backend_id        uuid,
  model             text not null default '',
  prompt_snapshot   text not null default '',
  result_text       text not null default '',
  result_json       jsonb not null default '{}'::jsonb,
  status            text not null default 'pending' check (status in ('pending','running','completed','failed','timeout')),
  error             text not null default '',
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz not null default now()
);

create table if not exists public.agent_board_decisions (
  id            uuid not null default gen_random_uuid() primary key,
  owner         uuid not null,
  request_id    uuid not null references public.agent_board_requests(id) on delete cascade,
  actor         uuid not null,
  decision      text not null check (decision in ('approved','rejected','cancelled','escalated')),
  notes         text not null default '',
  created_at    timestamptz not null default now()
);

create index if not exists idx_board_req_owner    on public.agent_board_requests(owner);
create index if not exists idx_board_req_source   on public.agent_board_requests(source_persona_id);
create index if not exists idx_board_req_target   on public.agent_board_requests(target_persona_id);
create index if not exists idx_board_req_status   on public.agent_board_requests(status);
create index if not exists idx_board_req_parent   on public.agent_board_requests(parent_request_id);
create index if not exists idx_board_runs_req     on public.agent_board_runs(request_id);
create index if not exists idx_board_runs_status  on public.agent_board_runs(status);
create index if not exists idx_board_dec_req      on public.agent_board_decisions(request_id);
create index if not exists idx_board_settings_p   on public.agent_board_settings(persona_id);

do $$
declare t text;
begin
  for t in select unnest(array['agent_board_settings','agent_board_requests'])
  loop
    execute format('drop trigger if exists trg_%I_touch on public.%I', t, t);
    execute format('create trigger trg_%I_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

alter table public.agent_board_settings   enable row level security;
alter table public.agent_board_requests   enable row level security;
alter table public.agent_board_runs        enable row level security;
alter table public.agent_board_decisions  enable row level security;

create policy "owner read board settings"  on public.agent_board_settings  for select using (owner = auth.uid());
create policy "owner write board settings" on public.agent_board_settings  for all    using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner read board requests" on public.agent_board_requests  for select using (owner = auth.uid());
create policy "owner write board requests" on public.agent_board_requests  for all    using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner read board runs"      on public.agent_board_runs     for select using (owner = auth.uid());
create policy "owner write board runs"     on public.agent_board_runs     for all    using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner read board decisions" on public.agent_board_decisions for select using (owner = auth.uid());
create policy "owner write board decisions" on public.agent_board_decisions for insert with check (owner = auth.uid());

-- RPCs
create or replace function public.propose_agent_board_request(
  p_source_persona_id uuid,
  p_target_persona_id uuid,
  p_task_type text,
  p_instructions text default '',
  p_subject_type text default 'post_draft',
  p_subject_id uuid default null,
  p_context jsonb default '{}'::jsonb,
  p_risk_level text default 'low',
  p_parent_request_id uuid default null,
  p_target_backend_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_source_persona_owner uuid;
  v_target_persona_owner uuid;
  v_source_settings public.agent_board_settings%rowtype;
  v_request_id uuid;
  v_today_count int;
begin
  v_owner := auth.uid();
  if v_owner is null then raise exception 'Authentication required'; end if;
  select owner into v_source_persona_owner from public.personas where id = p_source_persona_id;
  if v_source_persona_owner is null then raise exception 'Source persona not found'; end if;
  if v_source_persona_owner <> v_owner then raise exception 'Source persona does not belong to you'; end if;
  select owner into v_target_persona_owner from public.personas where id = p_target_persona_id;
  if v_target_persona_owner is null then raise exception 'Target persona not found'; end if;
  if v_target_persona_owner <> v_owner then raise exception 'Target persona does not belong to you'; end if;
  select * into v_source_settings from public.agent_board_settings where persona_id = p_source_persona_id;
  if not found or not v_source_settings.proposals_enabled then raise exception 'Proposals are not enabled for this persona'; end if;
  if array_length(v_source_settings.allowed_task_types, 1) > 0 and not (p_task_type = any(v_source_settings.allowed_task_types)) then raise exception 'Task type % is not allowed for this persona', p_task_type; end if;
  select count(*) into v_today_count from public.agent_board_requests where source_persona_id = p_source_persona_id and created_at >= current_date;
  if v_today_count >= v_source_settings.daily_proposal_limit then raise exception 'Daily proposal limit reached for this persona'; end if;
  if p_risk_level not in ('low','medium','high') then raise exception 'Invalid risk level'; end if;
  insert into public.agent_board_requests (owner, source_persona_id, target_persona_id, target_backend_id, parent_request_id, task_type, subject_type, subject_id, instructions, context, risk_level, status)
  values (v_owner, p_source_persona_id, p_target_persona_id, p_target_backend_id, p_parent_request_id, p_task_type, p_subject_type, p_subject_id, p_instructions, p_context, p_risk_level, 'owner_review')
  returning id into v_request_id;
  return v_request_id;
end;
$$;

create or replace function public.owner_agent_board_queue(p_status_filter text default null)
returns table (
  id uuid, source_persona_id uuid, source_persona_name text, source_persona_handle text,
  target_persona_id uuid, target_persona_name text, target_persona_handle text,
  task_type text, subject_type text, subject_id uuid, instructions text, risk_level text, status text, parent_request_id uuid, created_at timestamptz, updated_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  select r.id, r.source_persona_id, ps.name, ps.handle, r.target_persona_id, pt.name, pt.handle, r.task_type, r.subject_type, r.subject_id, r.instructions, r.risk_level, r.status, r.parent_request_id, r.created_at, r.updated_at
  from public.agent_board_requests r
  join public.personas ps on ps.id = r.source_persona_id
  join public.personas pt on pt.id = r.target_persona_id
  where r.owner = auth.uid() and (p_status_filter is null or r.status = p_status_filter)
  order by case r.status when 'owner_review' then 0 when 'proposed' then 1 when 'approved' then 2 when 'running' then 3 when 'completed' then 4 when 'failed' then 5 else 6 end, r.created_at desc;
$$;

create or replace function public.approve_agent_board_request(p_request_id uuid, p_notes text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_status text;
begin
  v_owner := auth.uid();
  if v_owner is null then raise exception 'Authentication required'; end if;
  select status into v_status from public.agent_board_requests where id = p_request_id and owner = v_owner;
  if not found then raise exception 'Request not found'; end if;
  if v_status <> 'owner_review' then raise exception 'Request is not in owner_review status (current: %)', v_status; end if;
  update public.agent_board_requests set status = 'approved', approved_by = v_owner, approved_at = now(), updated_at = now() where id = p_request_id;
  insert into public.agent_board_decisions (owner, request_id, actor, decision, notes) values (v_owner, p_request_id, v_owner, 'approved', p_notes);
end;
$$;

create or replace function public.reject_agent_board_request(p_request_id uuid, p_reason text default '', p_notes text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  v_owner := auth.uid();
  if v_owner is null then raise exception 'Authentication required'; end if;
  update public.agent_board_requests set status = 'rejected', rejected_by = v_owner, rejected_at = now(), rejection_reason = p_reason, updated_at = now() where id = p_request_id and owner = v_owner and status = 'owner_review';
  if not found then raise exception 'Request not found or not in owner_review status'; end if;
  insert into public.agent_board_decisions (owner, request_id, actor, decision, notes) values (v_owner, p_request_id, v_owner, 'rejected', p_notes);
end;
$$;

create or replace function public.cancel_agent_board_request(p_request_id uuid, p_notes text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_status text;
begin
  v_owner := auth.uid();
  if v_owner is null then raise exception 'Authentication required'; end if;
  select status into v_status from public.agent_board_requests where id = p_request_id and owner = v_owner;
  if not found then raise exception 'Request not found'; end if;
  if v_status in ('running','completed','failed') then raise exception 'Cannot cancel a request in % status', v_status; end if;
  update public.agent_board_requests set status = 'cancelled', updated_at = now() where id = p_request_id;
  insert into public.agent_board_decisions (owner, request_id, actor, decision, notes) values (v_owner, p_request_id, v_owner, 'cancelled', p_notes);
end;
$$;

create or replace function public.claim_next_approved_agent_request(p_owner uuid default null)
returns table (
  request_id uuid, source_persona_id uuid, target_persona_id uuid, target_backend_id uuid, task_type text, subject_type text, subject_id uuid, instructions text, context jsonb
)
language plpgsql security definer set search_path = '' as $$
declare
  v_request_id uuid; v_owner uuid; v_target_persona uuid; v_backend_id uuid; v_task_type text; v_subject_type text; v_subject_id uuid; v_instructions text; v_context jsonb; v_source_persona uuid;
begin
  select r.id, r.owner, r.target_persona_id, r.target_backend_id, r.task_type, r.subject_type, r.subject_id, r.instructions, r.context, r.source_persona_id
  into v_request_id, v_owner, v_target_persona, v_backend_id, v_task_type, v_subject_type, v_subject_id, v_instructions, v_context, v_source_persona
  from public.agent_board_requests r
  join public.agent_board_settings s on s.persona_id = r.target_persona_id
  where r.status = 'approved' and s.execution_enabled = true and (p_owner is null or r.owner = p_owner)
  order by r.approved_at limit 1 for update skip locked;
  if v_request_id is null then return; end if;
  update public.agent_board_requests set status = 'running', updated_at = now() where id = v_request_id;
  insert into public.agent_board_runs (owner, request_id, backend_id, status, started_at) values (v_owner, v_request_id, v_backend_id, 'running', now());
  return query select v_request_id, v_source_persona, v_target_persona, v_backend_id, v_task_type, v_subject_type, v_subject_id, v_instructions, v_context;
end;
$$;

create or replace function public.complete_agent_board_run(p_request_id uuid, p_run_id uuid, p_status text, p_result_text text default '', p_result_json jsonb default '{}'::jsonb, p_error text default '')
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('completed','failed','timeout') then raise exception 'Invalid run status'; end if;
  update public.agent_board_runs set status = p_status, result_text = p_result_text, result_json = p_result_json, error = p_error, completed_at = now() where id = p_run_id and request_id = p_request_id;
  if not found then raise exception 'Run not found'; end if;
  update public.agent_board_requests set status = case when p_status = 'completed' then 'completed' else 'failed' end, updated_at = now() where id = p_request_id and status = 'running';
end;
$$;

create or replace function public.get_agent_board_analytics()
returns table (total_requests bigint, pending_review bigint, approved bigint, completed bigint, failed bigint, rejected bigint, requests_by_type jsonb, recent_runs jsonb)
language sql security definer stable set search_path = '' as $$
  with type_counts as (select task_type, count(*) as cnt from public.agent_board_requests where owner = auth.uid() group by task_type),
  recent as (
    select jsonb_agg(jsonb_build_object('request_id', r.id, 'task_type', r.task_type, 'status', r.status, 'source', ps.handle, 'target', pt.handle, 'created_at', r.created_at) order by r.created_at desc) as runs
    from public.agent_board_requests r join public.personas ps on ps.id = r.source_persona_id join public.personas pt on pt.id = r.target_persona_id
    where r.owner = auth.uid() limit 20
  )
  select
    (select count(*) from public.agent_board_requests where owner = auth.uid()),
    (select count(*) from public.agent_board_requests where owner = auth.uid() and status = 'owner_review'),
    (select count(*) from public.agent_board_requests where owner = auth.uid() and status = 'approved'),
    (select count(*) from public.agent_board_requests where owner = auth.uid() and status = 'completed'),
    (select count(*) from public.agent_board_requests where owner = auth.uid() and status = 'failed'),
    (select count(*) from public.agent_board_requests where owner = auth.uid() and status = 'rejected'),
    coalesce((select jsonb_object_agg(task_type, cnt) from type_counts), '{}'::jsonb),
    coalesce((select runs from recent), '[]'::jsonb);
$$;

grant execute on function public.propose_agent_board_request(uuid,uuid,text,text,text,uuid,jsonb,text,uuid,uuid) to authenticated;
grant execute on function public.owner_agent_board_queue(text) to authenticated;
grant execute on function public.approve_agent_board_request(uuid,text) to authenticated;
grant execute on function public.reject_agent_board_request(uuid,text,text) to authenticated;
grant execute on function public.cancel_agent_board_request(uuid,text) to authenticated;
grant execute on function public.get_agent_board_analytics() to authenticated;
grant execute on function public.claim_next_approved_agent_request(uuid) to service_role;
grant execute on function public.complete_agent_board_run(uuid,uuid,text,text,jsonb,text) to service_role;;
