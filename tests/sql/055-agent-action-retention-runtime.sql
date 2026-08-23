\set ON_ERROR_STOP on
\pset pager off

-- Disposable PostgreSQL 16 behavioral probe for migration 055. Run only on a
-- local throwaway database after the release migrations; the transaction is
-- rolled back. The caller must be able to SET ROLE service_role.
begin;

create or replace function pg_temp.assert_true(p_condition boolean,p_message text)
returns void language plpgsql set search_path='' as $$
begin
  if not coalesce(p_condition,false) then
    raise exception 'ASSERTION FAILED: %',p_message;
  end if;
  raise notice 'PASS: %',p_message;
end
$$;

insert into auth.users(id,email,email_confirmed_at) values
  ('05500000-0000-4000-8000-000000000001','retention-055@example.test',now());
update public.profiles set display_name='055 runtime'
where id='05500000-0000-4000-8000-000000000001';
insert into public.personas(id,owner,handle,name) values
  ('05500000-0000-4000-8000-000000000002','05500000-0000-4000-8000-000000000001','retention055','055 Runtime');

-- Remove any fixture-trigger audit and start each probe from a controlled
-- retained receipt. The service role itself has no table DML grant.
delete from public.agent_actions
where owner='05500000-0000-4000-8000-000000000001';
delete from public.agent_action_storage_usage
where owner='05500000-0000-4000-8000-000000000001';

insert into public.agent_action_storage_usage(
  owner,system_mutations_today,lifetime_mutations
) values(
  '05500000-0000-4000-8000-000000000001',9998,999998
);

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.insert_agent_action_service(
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000002',null,
  'ai.call.started','persona_ai_call',
  '05500000-0000-4000-8000-000000000002','started',
  '{"mode":"runtime"}'::jsonb
) as started_id \gset
reset role;

select pg_temp.assert_true((select row(
  system_mutations_today,lifetime_mutations,stored_rows,
  pending_terminal_mutations,stored_bytes+pending_terminal_bytes
) = row(10000,1000000::bigint,1,1,65536::bigint)
from public.agent_action_storage_usage
where owner='05500000-0000-4000-8000-000000000001'),
'started audit reserved the final system and lifetime mutation plus full terminal byte footprint');

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.assert_true(public.finish_agent_action_service(
  :'started_id','05500000-0000-4000-8000-000000000001',
  'ai.call.denied','denied','{"reason":"budget"}'::jsonb
),'started-to-denied terminal transition succeeded at both hard mutation counters');
reset role;

select pg_temp.assert_true((select row(
  action_type,outcome
) = row('ai.call.denied'::text,'denied'::text)
from public.agent_actions where id=:'started_id'),
'denied terminal evidence replaced the started lifecycle row');
select pg_temp.assert_true((select row(
  system_mutations_today,lifetime_mutations,pending_terminal_mutations,
  pending_terminal_bytes
) = row(10000,1000000::bigint,0,0::bigint)
from public.agent_action_storage_usage
where owner='05500000-0000-4000-8000-000000000001'),
'terminal transition consumed its reservation without another quota charge');

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare v_blocked boolean:=false;v_started_id uuid;
begin
  select action.id into v_started_id from public.agent_actions action
  where action.owner='05500000-0000-4000-8000-000000000001'
    and action.action_type='ai.call.denied';
  begin
    perform public.finish_agent_action_service(
      v_started_id,'05500000-0000-4000-8000-000000000001',
      'ai.call.completed','ok','{}'::jsonb
    );
  exception when others then
    if sqlerrm='Agent action lifecycle is immutable after its one terminal transition' then
      v_blocked:=true;
    else
      raise;
    end if;
  end;
  if not v_blocked then raise exception 'Second terminal transition unexpectedly succeeded';end if;
  raise notice 'PASS: a second terminal transition was rejected';
end
$$;
do $$
declare v_insert_blocked boolean:=false;v_update_blocked boolean:=false;
  v_delete_blocked boolean:=false;
begin
  begin
    insert into public.agent_actions(owner,action_type,outcome)
    values('05500000-0000-4000-8000-000000000001','direct.service','ok');
  exception when insufficient_privilege then v_insert_blocked:=true;
  end;
  begin
    update public.agent_actions set outcome='tampered'
    where owner='05500000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then v_update_blocked:=true;
  end;
  begin
    delete from public.agent_actions
    where owner='05500000-0000-4000-8000-000000000001';
  exception when insufficient_privilege then v_delete_blocked:=true;
  end;
  if not (v_insert_blocked and v_update_blocked and v_delete_blocked) then
    raise exception 'Service role retained direct agent_actions DML: insert %, update %, delete %',
      not v_insert_blocked,not v_update_blocked,not v_delete_blocked;
  end if;
  raise notice 'PASS: arbitrary direct service INSERT was rejected and UPDATE/DELETE were revoked';
end
$$;
reset role;

delete from public.agent_actions
where owner='05500000-0000-4000-8000-000000000001';
update public.agent_action_storage_usage set
  usage_date=current_date,owner_mutations_today=0,system_mutations_today=9999,
  lifetime_mutations=0,stored_rows=0,stored_bytes=0,
  pending_terminal_mutations=0,pending_terminal_bytes=0,over_limit=false
where owner='05500000-0000-4000-8000-000000000001';

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare v_blocked boolean:=false;
begin
  begin
    perform public.insert_agent_action_service(
      '05500000-0000-4000-8000-000000000001',
      '05500000-0000-4000-8000-000000000002',null,
      'ai.call.started','persona_ai_call',null,'started','{}'::jsonb
    );
  exception when others then
    if sqlerrm='System agent-audit mutation limit reached for today (10000)' then
      v_blocked:=true;
    else
      raise;
    end if;
  end;
  if not v_blocked then raise exception 'A start without terminal quota unexpectedly succeeded';end if;
  raise notice 'PASS: a start at system mutation 9999 failed before provider work';
end
$$;
reset role;
select pg_temp.assert_true((select count(*)=0 from public.agent_actions
where owner='05500000-0000-4000-8000-000000000001'),
'rejected start left no orphan started audit row');
select pg_temp.assert_true((select system_mutations_today=9999
from public.agent_action_storage_usage
where owner='05500000-0000-4000-8000-000000000001'),
'rejected start did not consume its transactional reservation');

update public.agent_action_storage_usage set
  system_mutations_today=0,lifetime_mutations=999999
where owner='05500000-0000-4000-8000-000000000001';
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare v_blocked boolean:=false;
begin
  begin
    perform public.insert_agent_action_service(
      '05500000-0000-4000-8000-000000000001',null,null,
      'ai.call.started','persona_ai_call',null,'started','{}'::jsonb
    );
  exception when others then
    if sqlerrm like 'Agent-audit lifetime mutation limit reached%' then
      v_blocked:=true;
    else
      raise;
    end if;
  end;
  if not v_blocked then raise exception 'A start without lifetime terminal quota unexpectedly succeeded';end if;
  raise notice 'PASS: a start at lifetime mutation 999999 failed before provider work';
end
$$;
reset role;

-- Simulate a bounded 100,001-row legacy seed receipt with one row hidden past
-- the counted slice. Reconciliation must not clear over_limit at counter zero
-- while physical evidence remains.
update public.agent_action_storage_usage set
  system_mutations_today=0,lifetime_mutations=2,stored_rows=0,stored_bytes=0,
  pending_terminal_mutations=0,pending_terminal_bytes=0,over_limit=false
where owner='05500000-0000-4000-8000-000000000001';
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.insert_agent_action_service(
  '05500000-0000-4000-8000-000000000001',null,null,
  'runtime.first','runtime',null,'ok','{}'::jsonb
) as first_id \gset
select public.insert_agent_action_service(
  '05500000-0000-4000-8000-000000000001',null,null,
  'runtime.hidden','runtime',null,'ok','{}'::jsonb
) as hidden_id \gset
reset role;
update public.agent_action_storage_usage set stored_rows=1,over_limit=true
where owner='05500000-0000-4000-8000-000000000001';
delete from public.agent_actions where id=:'first_id';
select pg_temp.assert_true((select stored_rows=0 and over_limit
from public.agent_action_storage_usage
where owner='05500000-0000-4000-8000-000000000001'),
'over-limit marker stayed sticky at bounded counter zero while a hidden row remained');
delete from public.agent_actions where id=:'hidden_id';
select pg_temp.assert_true((select stored_rows=0 and stored_bytes=0
  and pending_terminal_mutations=0 and pending_terminal_bytes=0 and not over_limit
from public.agent_action_storage_usage
where owner='05500000-0000-4000-8000-000000000001'),
'over-limit marker cleared only after exact owner-row absence');

-- A pre-055 receipt may represent only the bounded newest 100001 rows, while
-- an older open lifecycle lies outside that slice. Its terminal transition
-- must remain possible without pretending the receipt is now under limit.
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.insert_agent_action_service(
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000002',null,
  'ai.call.started','persona_ai_call',null,'started',
  '{"auditLifecycleVersion":2,"overLimitProbe":true}'::jsonb
) as over_limit_started_id \gset
reset role;
update public.agent_action_storage_usage set
  stored_rows=100001,stored_bytes=67108865,
  pending_terminal_mutations=0,pending_terminal_bytes=0,over_limit=true
where owner='05500000-0000-4000-8000-000000000001';
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.assert_true(public.finish_agent_action_service(
  :'over_limit_started_id','05500000-0000-4000-8000-000000000001',
  'ai.call.failed','error','{"reason":"runtime-over-limit"}'::jsonb
),'hidden pre-055 start terminalized despite its bounded over-limit receipt');
reset role;
select pg_temp.assert_true((select action_type='ai.call.failed'
  and outcome='error' from public.agent_actions
  where id=:'over_limit_started_id'::uuid),
  'over-limit terminal evidence was retained exactly once');
select pg_temp.assert_true((select over_limit
  and pending_terminal_mutations=0 and pending_terminal_bytes=0
  from public.agent_action_storage_usage
  where owner='05500000-0000-4000-8000-000000000001'),
  'bounded over-limit receipt stayed sticky after the terminal transition');

-- The scheduler reservation now returns the exact version-2 lifecycle UUID.
-- Its successful terminal transition must update that row rather than append a
-- second row or leave capacity pending.
delete from public.agent_actions
where owner='05500000-0000-4000-8000-000000000001';
delete from public.agent_action_storage_usage
where owner='05500000-0000-4000-8000-000000000001';
update public.agent_bindings set autonomy_level=1
where owner='05500000-0000-4000-8000-000000000001'
  and persona_id='05500000-0000-4000-8000-000000000002';
insert into public.ai_tasks(
  id,owner,persona_id,name,cadence,active,next_run_at
) values(
  '05500000-0000-4000-8000-000000000010',
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000002',
  '055 exact lifecycle','manual',true,now()
);
update public.ai_tasks set
  lease_token='05500000-0000-4000-8000-000000000011',
  lease_expires_at=now()+interval '5 minutes'
where id='05500000-0000-4000-8000-000000000010';
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.reserve_agent_generation(
  '05500000-0000-4000-8000-000000000010',
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000011'
)->>'auditActionId' as scheduler_started_id \gset
reset role;
select pg_temp.assert_true((select count(*)=1
  and bool_and(action_type='ai.call.started')
  and bool_and(outcome='started')
  and bool_and(detail->>'auditLifecycleVersion'='2')
from public.agent_actions
where id=:'scheduler_started_id'::uuid),
'scheduler returned the exact retained version-2 start UUID');
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.assert_true(public.finish_agent_action_service(
  :'scheduler_started_id','05500000-0000-4000-8000-000000000001',
  'ai.call.completed','ok','{"provider":"runtime"}'::jsonb
),'scheduler exact terminal update succeeded');
reset role;
select pg_temp.assert_true((select count(*)=1
from public.agent_actions
where id=:'scheduler_started_id'::uuid and action_type='ai.call.completed'
  and outcome='ok'),
'scheduler retained one terminal row instead of appending a duplicate');
select pg_temp.assert_true((select pending_terminal_mutations=0
  and pending_terminal_bytes=0
from public.agent_action_storage_usage
where owner='05500000-0000-4000-8000-000000000001'),
'scheduler exact terminal consumed its pending reservation');

-- Database-new/worker-old compatibility: a separate terminal INSERT for the
-- exact task/entity consumes the unique open v1/v2 row and is itself suppressed.
select id as bridge_binding_id from public.agent_bindings
where owner='05500000-0000-4000-8000-000000000001'
  and persona_id='05500000-0000-4000-8000-000000000002' \gset
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.insert_agent_action_service(
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000002',:'bridge_binding_id'::uuid,
  'ai.call.started','ai_task','05500000-0000-4000-8000-000000000020',
  'started','{"auditLifecycleVersion":1,"legacy_lifecycle":"possible_inflight_at_upgrade"}'::jsonb
) as bridge_success_id \gset
select public.insert_agent_action_service(
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000002',:'bridge_binding_id'::uuid,
  'ai.call.started','ai_task','05500000-0000-4000-8000-000000000021',
  'started','{"auditLifecycleVersion":2}'::jsonb
) as bridge_failure_id \gset
-- These are literal old-worker table calls, not the new narrow RPC.
insert into public.agent_actions(
  owner,persona_id,binding_id,action_type,entity_type,entity_id,outcome,detail
) values(
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000002',:'bridge_binding_id'::uuid,
  'ai.call.completed','ai_task','05500000-0000-4000-8000-000000000020',
  'ok','{"provider":"old-worker"}'::jsonb
);
insert into public.agent_actions(
  owner,persona_id,binding_id,action_type,entity_type,entity_id,outcome,detail
) values(
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000002',:'bridge_binding_id'::uuid,
  'ai.call.failed','ai_task','05500000-0000-4000-8000-000000000021',
  'error','{"reason":"old-worker"}'::jsonb
);
-- Open a later exact lifecycle for the same task. A delayed retry of the old
-- terminal call must not be allowed to finish this different provider call.
select public.insert_agent_action_service(
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000002',:'bridge_binding_id'::uuid,
  'ai.call.started','ai_task','05500000-0000-4000-8000-000000000020',
  'started','{"auditLifecycleVersion":2,"retryProbe":true}'::jsonb
) as bridge_retry_id \gset
do $$
declare v_blocked boolean:=false;v_binding uuid;
begin
  select binding_id into v_binding from public.agent_actions
  where id='05500000-0000-4000-8000-000000000020';
  begin
    insert into public.agent_actions(
      owner,persona_id,binding_id,action_type,entity_type,entity_id,outcome,detail
    ) values(
      '05500000-0000-4000-8000-000000000001',
      '05500000-0000-4000-8000-000000000002',v_binding,
      'ai.call.completed','ai_task','05500000-0000-4000-8000-000000000020',
      'ok','{"provider":"old-worker-retry"}'::jsonb
    );
  exception when insufficient_privilege then v_blocked:=true;
  end;
  if not v_blocked then
    raise exception 'Old-worker retry unexpectedly completed a second call';
  end if;
  raise notice 'PASS: old-worker retry could not finish another lifecycle';
end
$$;
select pg_temp.assert_true((select action_type='ai.call.started'
  and outcome='started' from public.agent_actions
  where id=:'bridge_retry_id'::uuid),
  'delayed old-worker retry left the later exact lifecycle untouched');
select pg_temp.assert_true(public.finish_agent_action_service(
  :'bridge_retry_id','05500000-0000-4000-8000-000000000001',
  'ai.call.abandoned','unknown',
  '{"code":"runtime_retry_probe","provider_outcome":"unknown"}'::jsonb
),'retry probe was reconciled without inventing a provider outcome');
reset role;
select pg_temp.assert_true((select count(*)=2
  and count(*) filter(where action_type='ai.call.completed')=1
  and count(*) filter(where action_type='ai.call.failed')=1
from public.agent_actions
where id in(:'bridge_success_id'::uuid,:'bridge_failure_id'::uuid)),
'compatibility bridge correlated success and failure to only their exact entities');

-- A genuinely abandoned start releases only its pre-reserved terminal space
-- and records an explicit unknown provider outcome.
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.insert_agent_action_service(
  '05500000-0000-4000-8000-000000000001',
  '05500000-0000-4000-8000-000000000002',null,
  'ai.call.started','ai_task','05500000-0000-4000-8000-000000000030',
  'started','{"auditLifecycleVersion":2}'::jsonb
) as stale_id \gset
reset role;
alter table public.agent_actions disable trigger guard_agent_action_storage;
update public.agent_actions set created_at=now()-interval '20 minutes'
where id=:'stale_id'::uuid;
alter table public.agent_actions enable trigger guard_agent_action_storage;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.assert_true(public.reconcile_stale_agent_action_starts_service(
  '05500000-0000-4000-8000-000000000001',now()-interval '5 minutes',32
)=1,'bounded stale lifecycle reconciliation updated exactly one row');
reset role;
select pg_temp.assert_true((select action_type='ai.call.abandoned'
  and outcome='unknown' and detail->>'provider_outcome'='unknown'
from public.agent_actions where id=:'stale_id'::uuid),
'stale lifecycle retained explicit unknown-outcome evidence');
select pg_temp.assert_true((select pending_terminal_mutations=0
  and pending_terminal_bytes=0
from public.agent_action_storage_usage
where owner='05500000-0000-4000-8000-000000000001'),
'stale reconciliation released every tested terminal reservation');

rollback;
