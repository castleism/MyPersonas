-- 055-agent-action-retention-hardening.sql
-- One bounded, retained reservation boundary for every agent audit INSERT or
-- UPDATE. Recent evidence is never pruned implicitly: writes fail closed when
-- an account reaches a daily, lifetime, stored-row, or stored-byte boundary.
-- Apply after canonical migrations 051, 053, and 054. This source does not
-- deploy Edge Functions or apply itself to any hosted database.

begin;

-- Audit evidence keeps the historical binding UUID after a binding/persona is
-- deleted. The inherited ON DELETE SET NULL relationship would otherwise
-- rewrite every matching audit row, consume the mutation allowance, and could
-- block owner deletion at the cap. New references are validated by the guard
-- below; historical identifiers deliberately remain immutable after deletion.
alter table public.agent_actions
  drop constraint if exists agent_actions_binding_id_fkey;
comment on column public.agent_actions.binding_id is
  'Immutable historical binding identifier. New references are trigger-validated; deleted bindings do not rewrite audit evidence.';

-- Reapplication may encounter the guard installed by an earlier local build.
-- The ACCESS EXCLUSIVE lock taken by the ALTER above is retained until commit,
-- so removing the trigger here cannot open an unguarded concurrent-write gap.
drop trigger if exists guard_agent_action_storage on public.agent_actions;

-- Before 055, scheduled generation wrote a started row and a second, separate
-- completed/failed row. A recent unmatched start can nevertheless be an old
-- worker already across the provider boundary while this migration applies.
-- Preserve that bounded window as a version-1 in-flight candidate so the old
-- terminal INSERT can finish it exactly; stale reconciliation will retain an
-- explicit unknown outcome if the worker disappeared.
update public.agent_actions action set
  detail=(case when jsonb_typeof(action.detail)='object' then action.detail
    else jsonb_build_object('legacy_detail',action.detail) end)
    || jsonb_build_object(
      'auditLifecycleVersion',1,
      'retention_migration','055',
      'legacy_lifecycle','possible_inflight_at_upgrade'
    )
where action.action_type='ai.call.started' and action.outcome='started'
  and action.entity_type='ai_task'
  and coalesce(action.detail->>'auditLifecycleVersion','')=''
  and action.created_at>=now()-interval '15 minutes'
  and not exists(
    select 1 from public.agent_actions terminal
    where terminal.owner=action.owner
      and terminal.persona_id is not distinct from action.persona_id
      and terminal.entity_type='ai_task'
      and terminal.entity_id is not distinct from action.entity_id
      and terminal.created_at>=action.created_at
      and (
        (terminal.action_type='ai.call.completed' and terminal.outcome='ok')
        or (terminal.action_type='ai.call.failed' and terminal.outcome='error')
      )
  );

-- All remaining unversioned ai_task starts are historical events, not live
-- reservations. Mark them transparently so established append-only history
-- cannot consume 64 KiB per row. Version-1/2 rows must survive reapplication.
update public.agent_actions action set
  action_type='ai.call.legacy_started',
  outcome='legacy_unreserved',
  detail=(case when jsonb_typeof(action.detail)='object' then action.detail
    else jsonb_build_object('legacy_detail',action.detail) end)
    || jsonb_build_object(
      'retention_migration','055',
      'legacy_lifecycle','separate_terminal_or_unknown'
    )
where action.action_type='ai.call.started' and action.outcome='started'
  and action.entity_type='ai_task'
  and coalesce(action.detail->>'auditLifecycleVersion','') not in ('1','2');

create table if not exists public.agent_action_storage_usage(
  owner uuid primary key references public.profiles(id) on delete cascade,
  usage_date date not null default current_date,
  owner_mutations_today integer not null default 0
    check(owner_mutations_today between 0 and 1000000),
  system_mutations_today integer not null default 0
    check(system_mutations_today between 0 and 1000000),
  lifetime_mutations bigint not null default 0 check(lifetime_mutations>=0),
  stored_rows integer not null default 0 check(stored_rows between 0 and 100001),
  stored_bytes bigint not null default 0 check(stored_bytes>=0),
  pending_terminal_mutations integer not null default 0
    check(pending_terminal_mutations between 0 and 100001),
  pending_terminal_bytes bigint not null default 0
    check(pending_terminal_bytes>=0),
  over_limit boolean not null default false,
  initialized_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_action_storage_usage
  add column if not exists pending_terminal_mutations integer not null default 0
    check(pending_terminal_mutations between 0 and 100001),
  add column if not exists pending_terminal_bytes bigint not null default 0
    check(pending_terminal_bytes>=0);

alter table public.agent_action_storage_usage enable row level security;
drop policy if exists "agent action usage owner read"
  on public.agent_action_storage_usage;
create policy "agent action usage owner read"
  on public.agent_action_storage_usage for select to authenticated
  using(owner=auth.uid());
revoke all on public.agent_action_storage_usage
  from public,anon,authenticated,service_role;
grant select on public.agent_action_storage_usage to authenticated;

create or replace function public.agent_action_storage_bytes(
  p_action_type text,p_entity_type text,p_outcome text,p_detail jsonb
)
returns bigint language sql immutable set search_path = '' as $$
  select 256::bigint
    +pg_catalog.octet_length(coalesce(p_action_type,''))
    +pg_catalog.octet_length(coalesce(p_entity_type,''))
    +pg_catalog.octet_length(coalesce(p_outcome,''))
    +pg_catalog.octet_length(coalesce(p_detail,'{}'::jsonb)::text)
$$;

revoke all on function public.agent_action_storage_bytes(text,text,text,jsonb)
  from public,anon,authenticated,service_role;

-- Seed exact counters for ordinary accounts and an explicit fail-closed marker
-- for any inherited account already beyond the 100,000-row hard boundary.
with owners as (
  select distinct action.owner from public.agent_actions action
), bounded as (
  select owner_row.owner,action.action_type,action.entity_type,
    action.outcome,action.detail
  from owners owner_row
  cross join lateral (
    select existing.action_type,existing.entity_type,
      existing.outcome,existing.detail
    from public.agent_actions existing
    where existing.owner=owner_row.owner
    order by existing.created_at desc,existing.id desc
    limit 100001
  ) action
), totals as (
  select bounded.owner,count(*)::integer as stored_rows,
    coalesce(sum(public.agent_action_storage_bytes(
      bounded.action_type,bounded.entity_type,bounded.outcome,bounded.detail
    )),0)::bigint as stored_bytes,
    count(*) filter(where bounded.action_type='ai.call.started'
      and bounded.outcome='started')::integer as pending_terminal_mutations,
    coalesce(sum(case when bounded.action_type='ai.call.started'
      and bounded.outcome='started' then greatest(0::bigint,65536-
        public.agent_action_storage_bytes(
          bounded.action_type,bounded.entity_type,bounded.outcome,bounded.detail
        )) else 0 end),0)::bigint as pending_terminal_bytes
  from bounded group by bounded.owner
)
insert into public.agent_action_storage_usage(
  owner,usage_date,owner_mutations_today,system_mutations_today,
  lifetime_mutations,stored_rows,stored_bytes,pending_terminal_mutations,
  pending_terminal_bytes,over_limit,
  initialized_at,updated_at
)
select totals.owner,current_date,0,0,
  totals.stored_rows+totals.pending_terminal_mutations,
  totals.stored_rows,totals.stored_bytes,totals.pending_terminal_mutations,
  totals.pending_terminal_bytes,
  totals.stored_rows>100000
    or totals.stored_bytes+totals.pending_terminal_bytes>67108864,
  now(),now()
from totals
on conflict(owner) do update set
  stored_rows=case when excluded.stored_rows<=100000
    then excluded.stored_rows
    else greatest(agent_action_storage_usage.stored_rows,excluded.stored_rows)
  end,
  stored_bytes=case when excluded.stored_rows<=100000
    then excluded.stored_bytes
    else greatest(agent_action_storage_usage.stored_bytes,excluded.stored_bytes)
  end,
  pending_terminal_mutations=excluded.pending_terminal_mutations,
  pending_terminal_bytes=excluded.pending_terminal_bytes,
  lifetime_mutations=greatest(
    agent_action_storage_usage.lifetime_mutations,
    excluded.stored_rows+excluded.pending_terminal_mutations
  ),
  over_limit=case when excluded.stored_rows<=100000 then
      excluded.stored_bytes+excluded.pending_terminal_bytes>67108864
    else true end,
  updated_at=now();

-- A receipt with no physical evidence is exactly knowable even if an earlier
-- interrupted local build left its derived counters populated.
update public.agent_action_storage_usage usage set
  stored_rows=0,stored_bytes=0,pending_terminal_mutations=0,
  pending_terminal_bytes=0,over_limit=false,updated_at=now()
where not exists(select 1 from public.agent_actions action
  where action.owner=usage.owner);

drop function if exists public.reserve_agent_action_mutation(
  uuid,bigint,integer,boolean
);
create or replace function public.reserve_agent_action_mutation(
  p_owner uuid,p_bytes_delta bigint,p_row_delta integer,
  p_owner_mutation boolean,p_terminal_kind text default '',
  p_terminal_reservation_bytes bigint default 0
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_usage public.agent_action_storage_usage%rowtype;
  v_owner_today integer;
  v_system_today integer;
  v_mutation_cost integer;
  v_rows integer;
  v_bytes bigint;
  v_pending_mutations integer;
  v_pending_bytes bigint;
  v_effective_bytes bigint;
begin
  if p_owner is null or p_bytes_delta is null
     or p_bytes_delta not between -65536 and 65536
     or p_row_delta is null or p_row_delta not in (0,1)
     or p_owner_mutation is null
     or coalesce(p_terminal_kind,'') not in ('','reserve','consume')
     or p_terminal_reservation_bytes is null
     or p_terminal_reservation_bytes not between 0 and 65536
     or (p_terminal_kind='reserve' and (p_owner_mutation or p_row_delta<>1))
     or (p_terminal_kind='consume' and (p_owner_mutation or p_row_delta<>0))
     or (p_terminal_kind='' and p_terminal_reservation_bytes<>0) then
    raise exception 'Invalid agent action storage reservation';
  end if;
  -- A dedicated audit-writer lock serializes direct service writes with both
  -- erasure RPCs without changing the established owner/persona lock order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051103)
  );
  insert into public.agent_action_storage_usage(owner)
  values(p_owner) on conflict(owner) do nothing;
  select * into v_usage from public.agent_action_storage_usage usage
  where usage.owner=p_owner for update;
  if v_usage.usage_date<>current_date then
    v_usage.usage_date:=current_date;
    v_usage.owner_mutations_today:=0;
    v_usage.system_mutations_today:=0;
  end if;
  v_mutation_cost:=case when p_terminal_kind='reserve' then 2
    when p_terminal_kind='consume' then 0 else 1 end;
  v_owner_today:=v_usage.owner_mutations_today
    +case when p_owner_mutation then v_mutation_cost else 0 end;
  v_system_today:=v_usage.system_mutations_today
    +case when p_owner_mutation then 0 else v_mutation_cost end;
  v_rows:=v_usage.stored_rows+p_row_delta;
  v_bytes:=greatest(0::bigint,v_usage.stored_bytes+p_bytes_delta);
  v_pending_mutations:=v_usage.pending_terminal_mutations
    +case when p_terminal_kind='reserve' then 1
      when p_terminal_kind='consume' then -1 else 0 end;
  v_pending_bytes:=v_usage.pending_terminal_bytes
    +case when p_terminal_kind='reserve' then p_terminal_reservation_bytes
      when p_terminal_kind='consume' then -p_terminal_reservation_bytes else 0 end;
  if v_pending_mutations<0 or v_pending_bytes<0 then
    if not v_usage.over_limit or p_terminal_kind<>'consume' then
      raise exception 'Agent-audit terminal reservation is missing';
    end if;
    -- A pre-055 owner beyond the bounded 100001-row seed may have an open
    -- lifecycle outside the counted slice. Permit only its one terminal
    -- transition, without clearing the sticky over-limit receipt.
    v_pending_mutations:=greatest(0,v_pending_mutations);
    v_pending_bytes:=greatest(0::bigint,v_pending_bytes);
  end if;
  v_effective_bytes:=v_bytes+v_pending_bytes;

  if v_owner_today>500 then
    raise exception 'Owner agent-audit mutation limit reached for today (500)';
  end if;
  if v_system_today>10000 then
    raise exception 'System agent-audit mutation limit reached for today (10000)';
  end if;
  if v_usage.lifetime_mutations+v_mutation_cost>1000000 then
    raise exception 'Agent-audit lifetime mutation limit reached (1000000); archival review is required';
  end if;
  if v_usage.over_limit and p_terminal_kind<>'consume'
     and (p_row_delta>0 or p_bytes_delta>0 or p_terminal_reservation_bytes>0) then
    raise exception 'Agent-audit storage is already over its hard boundary; export and archival review are required';
  end if;
  if v_rows>100000 and p_terminal_kind<>'consume' then
    raise exception 'Agent-audit stored-row limit reached (100000)';
  end if;
  if v_effective_bytes>67108864 and p_terminal_kind<>'consume' then
    raise exception 'Agent-audit stored-byte limit reached (67108864)';
  end if;
  -- System traffic cannot consume the final owner/security evidence reserve.
  if not p_owner_mutation and p_terminal_kind<>'consume'
     and (v_rows>90000 or v_effective_bytes>58720256) then
    raise exception 'System agent-audit reserve reached; owner evidence capacity is protected';
  end if;

  update public.agent_action_storage_usage usage set
    usage_date=v_usage.usage_date,
    owner_mutations_today=v_owner_today,
    system_mutations_today=v_system_today,
    lifetime_mutations=v_usage.lifetime_mutations+v_mutation_cost,
    stored_rows=v_rows,stored_bytes=v_bytes,
    pending_terminal_mutations=v_pending_mutations,
    pending_terminal_bytes=v_pending_bytes,updated_at=now()
  where usage.owner=p_owner;
end;
$$;

revoke all on function public.reserve_agent_action_mutation(
  uuid,bigint,integer,boolean,text,bigint
) from public,anon,authenticated,service_role;

create or replace function public.guard_agent_action_storage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role text:=coalesce(auth.role(),'');
  v_owner_mutation boolean;
  v_new_bytes bigint;
  v_old_bytes bigint:=0;
  v_terminal_kind text:='';
  v_terminal_reservation_bytes bigint:=0;
  v_legacy_started_id uuid;
  v_narrow_service_writer boolean:=coalesce(
    current_setting('app.agent_action_narrow_writer',true),'')='1';
  v_erasure boolean:=coalesce(
    current_setting('app.agent_action_erasure',true),'')='1';
begin
  if new.owner is null then raise exception 'Agent action owner is required'; end if;
  if v_role='authenticated' and new.owner is distinct from auth.uid() then
    raise sqlstate '42501' using message='Agent action owner mismatch';
  end if;
  if btrim(coalesce(new.action_type,'')) is distinct from coalesce(new.action_type,'')
     or pg_catalog.octet_length(coalesce(new.action_type,'')) not between 1 and 96
     or new.action_type!~'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$' then
    raise exception 'Invalid agent action type';
  end if;
  if btrim(coalesce(new.entity_type,'')) is distinct from coalesce(new.entity_type,'')
     or pg_catalog.octet_length(coalesce(new.entity_type,''))>64
     or (new.entity_type<>'' and new.entity_type!~'^[a-z][a-z0-9_]{0,63}$') then
    raise exception 'Invalid agent action entity type';
  end if;
  if btrim(coalesce(new.outcome,'')) is distinct from coalesce(new.outcome,'')
     or pg_catalog.octet_length(coalesce(new.outcome,'')) not between 1 and 128
     or pg_catalog.regexp_replace(new.outcome,E'[\r\n\t]','','g')~'[[:cntrl:]]' then
    raise exception 'Invalid agent action outcome';
  end if;
  if new.detail is null or jsonb_typeof(new.detail)<>'object'
     or pg_catalog.octet_length(new.detail::text)>49152 then
    raise exception 'Agent action detail must be an object of at most 49152 UTF-8 bytes';
  end if;

  -- The old scheduler used a direct service-role INSERT for terminal events.
  -- During a database-first rolling deploy, serialize that compatibility call
  -- in the same owner -> persona -> audit order as every narrow writer. A
  -- direct call is accepted only when it consumes the exact open versioned task
  -- below; all other direct service inserts remain fail-closed.
  if tg_op='INSERT' and v_role='service_role' and not v_narrow_service_writer then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.owner::text,51051101)
    );
    if new.persona_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(new.persona_id::text,51051102)
      );
    end if;
  end if;

  if tg_op='INSERT' then
    if new.binding_id is not null and not exists (
      select 1 from public.agent_bindings binding
      where binding.id=new.binding_id and binding.owner=new.owner
        and binding.persona_id=new.persona_id
    ) then
      raise exception 'Agent action binding does not match its owner and persona';
    end if;
    new.created_at:=now();
    -- Deployment-order bridge: database-first releases can briefly receive the
    -- old worker's separate terminal INSERT. Consume the one versioned start
    -- for this task in place and suppress the duplicate terminal row. Legacy
    -- starts were normalized above, and the replacement reservation function
    -- closes a stale prior attempt before creating a new one, so this match is
    -- unambiguous.
    if new.entity_type='ai_task' and new.entity_id is not null and (
         (new.action_type='ai.call.completed' and new.outcome='ok')
         or (new.action_type='ai.call.failed' and new.outcome='error')
       ) then
      select action.id into v_legacy_started_id
      from public.agent_actions action
      where action.owner=new.owner
        and action.persona_id is not distinct from new.persona_id
        and action.entity_type='ai_task' and action.entity_id=new.entity_id
        and action.action_type='ai.call.started' and action.outcome='started'
        and coalesce(action.detail->>'auditLifecycleVersion','') in ('1','2')
        and not exists(
          select 1 from public.agent_actions prior
          where prior.owner=action.owner
            and prior.persona_id is not distinct from action.persona_id
            and prior.entity_type=action.entity_type
            and prior.entity_id=action.entity_id and prior.id<>action.id
            and coalesce(prior.detail->>'legacyTerminalBridge','false')='true'
        )
      order by action.created_at desc,action.id desc limit 1 for update;
      if found then
        update public.agent_actions action set
          action_type=new.action_type,outcome=new.outcome,
          detail=action.detail || new.detail || jsonb_build_object(
            'legacyTerminalBridge',true,'legacyTerminalBridgeAt',now()
          )
        where action.id=v_legacy_started_id and action.owner=new.owner;
        return null;
      end if;
    end if;
    if v_role='service_role' and not v_narrow_service_writer
       and pg_catalog.pg_trigger_depth()=1 then
      raise sqlstate '42501' using message=
        'Direct service insert requires an exact open versioned task terminal';
    end if;
  else
    -- Exact lifecycle writers may perform one started-to-terminal transition.
    -- Permit that transition exactly once; terminal evidence and every other
    -- action remain append-only rather than alterable in place.
    if old.action_type<>'ai.call.started' or old.outcome<>'started'
       or not (
         (new.action_type='ai.call.completed' and new.outcome='ok')
         or (new.action_type='ai.call.failed' and new.outcome='error')
         or (new.action_type='ai.call.denied' and new.outcome='denied')
         or (new.action_type='ai.call.abandoned' and new.outcome='unknown')
       ) then
      raise exception 'Agent action lifecycle is immutable after its one terminal transition';
    end if;
    if row(new.id,new.owner,new.persona_id,new.binding_id,
      new.entity_type,new.entity_id,new.created_at)
      is distinct from row(old.id,old.owner,old.persona_id,old.binding_id,
      old.entity_type,old.entity_id,old.created_at) then
      raise exception 'Agent action identity and creation time are immutable';
    end if;
    v_old_bytes:=public.agent_action_storage_bytes(
      old.action_type,old.entity_type,old.outcome,old.detail
    );
  end if;
  v_new_bytes:=public.agent_action_storage_bytes(
    new.action_type,new.entity_type,new.outcome,new.detail
  );
  if v_new_bytes>65536 then
    raise exception 'Agent action row exceeds 65536 stored bytes';
  end if;
  if tg_op='INSERT' and new.action_type='ai.call.started'
     and new.outcome='started' then
    v_terminal_kind:='reserve';
    v_terminal_reservation_bytes:=greatest(0::bigint,65536-v_new_bytes);
  elsif tg_op='UPDATE' then
    v_terminal_kind:='consume';
    v_terminal_reservation_bytes:=greatest(0::bigint,65536-v_old_bytes);
  end if;

  -- Explicit agent-data erasure deliberately suppresses transient destination
  -- deletion events that the same transaction would immediately erase.
  if v_erasure and tg_op='INSERT' then return null; end if;

  v_owner_mutation:=v_role='authenticated';
  if v_owner_mutation and (
    new.action_type like 'draft.%'
    or new.action_type like 'publish.%'
    or new.action_type like 'fan_chat.owner_%'
    or new.action_type in (
      'binding.updated','owner_controls.updated','destination.created',
      'destination.updated','destination.deleted','direction.updated',
      'post_draft.scheduled','post_draft.unscheduled','post_draft.deleted',
      'publish_external_reddit'
    )
  ) then
    perform public.require_aal2();
  end if;
  perform public.reserve_agent_action_mutation(
    new.owner,v_new_bytes-v_old_bytes,
    case when tg_op='INSERT' then 1 else 0 end,v_owner_mutation,
    v_terminal_kind,v_terminal_reservation_bytes
  );
  return new;
end;
$$;

create or replace function public.reconcile_agent_action_storage_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old_bytes bigint;
  v_remaining integer;
  v_was_over_limit boolean;
  v_terminal_pending integer:=0;
  v_terminal_reservation_bytes bigint:=0;
begin
  if coalesce(current_setting('app.agent_action_erasure',true),'')='1' then
    return old;
  end if;
  v_old_bytes:=public.agent_action_storage_bytes(
    old.action_type,old.entity_type,old.outcome,old.detail
  );
  if old.action_type='ai.call.started' and old.outcome='started' then
    v_terminal_pending:=1;
    v_terminal_reservation_bytes:=greatest(0::bigint,65536-v_old_bytes);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(old.owner::text,51051103)
  );
  update public.agent_action_storage_usage usage set
    stored_rows=greatest(0,usage.stored_rows-1),
    stored_bytes=greatest(0::bigint,usage.stored_bytes-v_old_bytes),
    pending_terminal_mutations=greatest(0,
      usage.pending_terminal_mutations-v_terminal_pending),
    pending_terminal_bytes=greatest(0::bigint,
      usage.pending_terminal_bytes-v_terminal_reservation_bytes),
    over_limit=usage.over_limit,
    updated_at=now()
  where usage.owner=old.owner
  returning stored_rows,over_limit into v_remaining,v_was_over_limit;
  -- A legacy over-limit receipt counts only a bounded recent slice. It may
  -- recover only after an exact owner-row absence check proves no hidden audit
  -- evidence remains; partial cascades can never clear the marker.
  if coalesce(v_was_over_limit,false) and v_remaining=0
     and not exists(select 1 from public.agent_actions action
       where action.owner=old.owner limit 1) then
    update public.agent_action_storage_usage usage set
      stored_rows=0,stored_bytes=0,pending_terminal_mutations=0,
      pending_terminal_bytes=0,over_limit=false,updated_at=now()
    where usage.owner=old.owner and usage.over_limit;
  end if;
  return old;
end;
$$;

drop trigger if exists guard_agent_action_storage
  on public.agent_actions;
create trigger guard_agent_action_storage
  before insert or update on public.agent_actions
  for each row execute function public.guard_agent_action_storage();
drop trigger if exists reconcile_agent_action_storage_delete
  on public.agent_actions;
create trigger reconcile_agent_action_storage_delete
  after delete on public.agent_actions
  for each row execute function public.reconcile_agent_action_storage_delete();

revoke all on function public.guard_agent_action_storage(),
  public.reconcile_agent_action_storage_delete()
  from public,anon,authenticated,service_role;
revoke all on public.agent_actions
  from public,anon,authenticated,service_role;
grant select on public.agent_actions to authenticated;
grant select on public.agent_actions to service_role;
-- Temporary rolling-deploy compatibility for the old scheduler's direct
-- terminal INSERT. The guard rejects every direct service insert except an
-- exact versioned ai_task terminal and serializes that bridge with erasure.
grant insert(owner,persona_id,binding_id,action_type,entity_type,entity_id,
  outcome,detail) on public.agent_actions to service_role;

-- Edge workers receive no broad mutation path. These narrow service boundaries
-- take the owner lock first, then the optional persona lock, and finally the
-- audit-writer lock inside the storage trigger.
create or replace function public.insert_agent_action_service(
  p_owner uuid,p_persona_id uuid,p_binding_id uuid,p_action_type text,
  p_entity_type text,p_entity_id uuid,p_outcome text,p_detail jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;v_previous_writer text:=coalesce(
  current_setting('app.agent_action_narrow_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051101)
  );
  if p_persona_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_persona_id::text,51051102)
    );
  end if;
  -- A worker can disappear after the provider boundary. Before opening another
  -- lifecycle for the same persona, close only clearly stale starts as
  -- abandoned/unknown. This releases the pre-reserved terminal capacity
  -- without inventing a provider success or failure.
  if p_action_type='ai.call.started' and p_outcome='started' then
    with stale as (
      select action.id from public.agent_actions action
      where action.owner=p_owner
        and action.persona_id is not distinct from p_persona_id
        and action.action_type='ai.call.started' and action.outcome='started'
        and action.created_at<now()-interval '15 minutes'
      order by action.created_at,action.id limit 32 for update skip locked
    )
    update public.agent_actions action set
      action_type='ai.call.abandoned',outcome='unknown',
      detail=action.detail || jsonb_build_object(
        'code','stale_audit_lifecycle',
        'provider_outcome','unknown',
        'reconciliation_required',true,
        'reconciled_at',now()
      )
    from stale where action.id=stale.id;
  end if;
  perform set_config('app.agent_action_narrow_writer','1',true);
  insert into public.agent_actions(
    owner,persona_id,binding_id,action_type,entity_type,entity_id,outcome,detail
  ) values(
    p_owner,p_persona_id,p_binding_id,p_action_type,p_entity_type,p_entity_id,
    p_outcome,coalesce(p_detail,'{}'::jsonb)
  ) returning id into v_id;
  perform set_config('app.agent_action_narrow_writer',v_previous_writer,true);
  return v_id;
end;
$$;

create or replace function public.finish_agent_action_service(
  p_action_id uuid,p_owner uuid,p_action_type text,p_outcome text,p_detail jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_persona_id uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_action_id is null or p_owner is null then
    raise exception 'Action and owner are required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051101)
  );
  select action.persona_id into v_persona_id from public.agent_actions action
  where action.id=p_action_id and action.owner=p_owner;
  if not found then raise exception 'Owned started action not found'; end if;
  if v_persona_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_persona_id::text,51051102)
    );
  end if;
  update public.agent_actions action set action_type=p_action_type,
    outcome=p_outcome,detail=coalesce(p_detail,'{}'::jsonb)
  where action.id=p_action_id and action.owner=p_owner;
  if not found then raise exception 'Owned started action not found'; end if;
  return true;
end;
$$;

-- Bounded crash recovery. "abandoned/unknown" is deliberately distinct from
-- provider failure: a worker may have disappeared after the external request
-- crossed the network boundary. The row remains retained and reviewable while
-- its already-reserved terminal capacity is released.
create or replace function public.reconcile_stale_agent_action_starts_service(
  p_owner uuid,p_before timestamptz,p_limit integer default 100
)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_persona_id uuid;v_count integer:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null or p_before is null or p_limit not between 1 and 100
     or p_before>now()-interval '5 minutes' then
    raise exception 'Invalid stale agent-action reconciliation boundary';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051101)
  );
  for v_persona_id in
    select distinct action.persona_id from public.agent_actions action
    where action.owner=p_owner and action.persona_id is not null
      and action.action_type='ai.call.started' and action.outcome='started'
      and action.created_at<p_before
    order by action.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_persona_id::text,51051102)
    );
  end loop;
  with stale as (
    select action.id from public.agent_actions action
    where action.owner=p_owner
      and action.action_type='ai.call.started' and action.outcome='started'
      and action.created_at<p_before
    order by action.created_at,action.id limit p_limit for update skip locked
  )
  update public.agent_actions action set
    action_type='ai.call.abandoned',outcome='unknown',
    detail=action.detail || jsonb_build_object(
      'code','stale_audit_lifecycle',
      'provider_outcome','unknown',
      'reconciliation_required',true,
      'reconciled_at',now()
    )
  from stale where action.id=stale.id;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

-- Replace the inherited scheduler reservation in place. The returned exact
-- audit UUID lets the new worker consume the same row; the version marker lets
-- reapplication distinguish genuine open lifecycles from pre-055 append-only
-- task history. Closing any prior open row for the same leased task makes the
-- database-new/worker-old compatibility bridge unambiguous.
create or replace function public.reserve_agent_generation(
  p_task_id uuid,p_owner uuid,p_lease_token uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_settings public.agent_owner_settings%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_usage_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_existing_drafts integer:=0;
  v_used integer:=0;
  v_next integer:=0;
  v_action_id uuid:=pg_catalog.gen_random_uuid();
  v_previous_writer text:=coalesce(
    current_setting('app.agent_action_narrow_writer',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_task_id is null or p_owner is null or p_lease_token is null then
    raise exception 'Task, owner, and lease are required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051101)
  );
  select * into v_task from public.ai_tasks
    where id=p_task_id and owner=p_owner for update;
  if not found or v_task.lease_token is distinct from p_lease_token
     or v_task.lease_expires_at is null or v_task.lease_expires_at<=now() then
    return jsonb_build_object('reserved',false,'code','lease_lost');
  end if;
  if v_task.persona_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_task.persona_id::text,51051102)
    );
  end if;

  select * into v_settings from public.agent_owner_settings
    where owner=p_owner for share;
  if not found then
    return jsonb_build_object('reserved',false,'code','settings_unavailable');
  end if;
  if v_settings.automation_paused then
    return jsonb_build_object('reserved',false,'code','owner_paused');
  end if;
  select * into v_binding from public.agent_bindings
    where owner=p_owner and persona_id=v_task.persona_id for share;
  if not found or v_binding.status<>'active'
     or v_binding.claim_state not in ('self_attested','verified')
     or v_binding.autonomy_level<1 then
    return jsonb_build_object('reserved',false,'code','binding_inactive');
  end if;

  -- A task lease is single-writer. Any older open lifecycle for this exact task
  -- belongs to an interrupted attempt and cannot be mistaken for the new one.
  update public.agent_actions action set
    action_type='ai.call.abandoned',outcome='unknown',
    detail=action.detail || jsonb_build_object(
      'code','superseded_stale_generation_attempt',
      'provider_outcome','unknown',
      'reconciliation_required',true,
      'superseded_by_lease',p_lease_token,
      'reconciled_at',now()
    )
  where action.owner=p_owner
    and action.persona_id is not distinct from v_task.persona_id
    and action.entity_type='ai_task' and action.entity_id=v_task.id
    and action.action_type='ai.call.started' and action.outcome='started';

  v_usage_date:=(now() at time zone v_settings.default_timezone)::date;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'agent-generation-day:'||p_owner::text||':'||v_usage_date::text,0
  ));
  v_day_start:=v_usage_date::timestamp at time zone v_settings.default_timezone;
  v_day_end:=(v_usage_date+1)::timestamp at time zone v_settings.default_timezone;
  select count(*) into v_existing_drafts from public.drafts
    where owner=p_owner and generated_by_agent
      and created_at>=v_day_start and created_at<v_day_end;
  select generation_requests into v_used from public.agent_daily_usage
    where owner=p_owner and usage_date=v_usage_date for update;
  if not found then v_used:=0;end if;
  v_used:=greatest(v_used,v_existing_drafts);
  if v_used>=v_settings.daily_draft_limit then
    return jsonb_build_object(
      'reserved',false,'code','daily_cap','used',v_used,
      'limit',v_settings.daily_draft_limit
    );
  end if;
  v_next:=v_used+1;
  insert into public.agent_daily_usage(
    owner,usage_date,generation_requests,updated_at
  ) values(p_owner,v_usage_date,v_next,now())
  on conflict(owner,usage_date) do update set
    generation_requests=excluded.generation_requests,
    updated_at=excluded.updated_at;

  perform set_config('app.agent_action_narrow_writer','1',true);
  insert into public.agent_actions(
    id,owner,persona_id,binding_id,action_type,entity_type,entity_id,
    outcome,detail
  ) values(
    v_action_id,p_owner,v_task.persona_id,v_binding.id,'ai.call.started',
    'ai_task',v_task.id,'started',jsonb_build_object(
      'generationRequest',v_next,
      'dailyLimit',v_settings.daily_draft_limit,
      'auditLifecycleVersion',2,
      'leaseToken',p_lease_token
    )
  );
  perform set_config('app.agent_action_narrow_writer',v_previous_writer,true);
  return jsonb_build_object(
    'reserved',true,'used',v_next,'limit',v_settings.daily_draft_limit,
    'auditActionId',v_action_id,'auditLifecycleVersion',2
  );
end;
$$;

revoke all on function public.insert_agent_action_service(
  uuid,uuid,uuid,text,text,uuid,text,jsonb
),public.finish_agent_action_service(uuid,uuid,text,text,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.reconcile_stale_agent_action_starts_service(
  uuid,timestamptz,integer
),public.reserve_agent_generation(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.insert_agent_action_service(
  uuid,uuid,uuid,text,text,uuid,text,jsonb
),public.finish_agent_action_service(uuid,uuid,text,text,jsonb)
  to service_role;
grant execute on function public.reconcile_stale_agent_action_starts_service(
  uuid,timestamptz,integer
),public.reserve_agent_generation(uuid,uuid,uuid)
  to service_role;

-- Full-account erasure uses this lock-ordered service boundary instead of
-- direct destination/audit deletes, so a full audit log can never block the
-- right to erase. No deletion event is retained from data being erased.
create or replace function public.delete_agent_action_data_for_account_service(
  p_owner uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_persona_id uuid;
  v_destination_count integer;
  v_action_count integer;
  v_previous_erasure text:=coalesce(
    current_setting('app.agent_action_erasure',true),'');
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051101)
  );
  for v_persona_id in
    select distinct destination.persona_id
    from public.agent_destinations destination
    where destination.owner=p_owner order by destination.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_persona_id::text,51051102)
    );
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051103)
  );
  perform set_config('app.agent_action_erasure','1',true);
  delete from public.agent_destinations destination where destination.owner=p_owner;
  get diagnostics v_destination_count=row_count;
  delete from public.agent_actions action where action.owner=p_owner;
  get diagnostics v_action_count=row_count;
  delete from public.agent_action_storage_usage usage where usage.owner=p_owner;
  perform set_config('app.agent_action_erasure',v_previous_erasure,true);
  return jsonb_build_object(
    'destinations_deleted',v_destination_count,
    'actions_deleted',v_action_count
  );
end;
$$;

revoke all on function public.delete_agent_action_data_for_account_service(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.delete_agent_action_data_for_account_service(uuid)
  to service_role;

-- Preserve the 051 lock hierarchy while making owner erasure AAL2 and removing
-- the retained usage receipt together with the audit data it describes.
create or replace function public.delete_my_agent_data()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_persona_id uuid;
  v_result boolean;
  v_previous_erasure text:=coalesce(
    current_setting('app.agent_action_erasure',true),'');
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051101)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051056)
  );
  for v_persona_id in
    select binding.persona_id from public.agent_bindings binding
    where binding.owner=v_owner order by binding.persona_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_persona_id::text,51051102)
    );
    perform public.lock_persona_publication_mutation(v_persona_id);
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051103)
  );
  perform set_config('app.agent_action_erasure','1',true);
  v_result:=public.delete_my_agent_data_legacy_011();
  delete from public.agent_action_storage_usage usage where usage.owner=v_owner;
  perform set_config('app.agent_action_erasure',v_previous_erasure,true);
  return v_result;
end;
$$;

revoke all on function public.delete_my_agent_data()
  from public,anon,authenticated,service_role;
grant execute on function public.delete_my_agent_data() to authenticated;

commit;
