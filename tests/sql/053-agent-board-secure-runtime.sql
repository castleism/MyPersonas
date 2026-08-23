\set ON_ERROR_STOP on
\pset pager off

-- PostgreSQL 16 behavioral probe for migration 053. Run only on a local
-- throwaway database after the release migrations. Every fixture is rolled
-- back. The caller must be able to SET ROLE authenticated/service_role.
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
  ('05300000-0000-4000-8000-000000000001','agent-board-053@example.test',now());
insert into public.profiles(id,email,display_name) values
  ('05300000-0000-4000-8000-000000000001','agent-board-053@example.test','053 runtime')
on conflict(id) do update set display_name=excluded.display_name;
insert into public.ai_backends(
  id,owner,name,base_url,api_key,model,provider,extra
) values(
  '05300000-0000-4000-8000-000000000010',
  '05300000-0000-4000-8000-000000000001','053 model',
  'https://api.example.test/v1','','test-model','openai',
  '{"deployment":"safe-deployment","api_version":"2025-01-01","api_key":"must-not-escape"}'::jsonb
);
insert into public.personas(
  id,owner,handle,name,bio,purpose,voice,topics,audience,hashtags,dont,
  context_log,ai_backend
) values
  ('05300000-0000-4000-8000-000000000002',
   '05300000-0000-4000-8000-000000000001','board053source','053 Source',
   'Source bio','Coordinate review','Clear','review','owner','#review','No publishing',
   'Source continuity','05300000-0000-4000-8000-000000000010'),
  ('05300000-0000-4000-8000-000000000003',
   '05300000-0000-4000-8000-000000000001','board053target','053 Target',
   'Original target bio','Draft for owner review','Careful','drafting','owner','#draft','No publishing',
   'Target continuity','05300000-0000-4000-8000-000000000010');
insert into public.agent_owner_settings(owner,automation_paused)
values('05300000-0000-4000-8000-000000000001',false)
on conflict(owner) do update set automation_paused=false;
insert into public.agent_bindings(owner,persona_id,status,claim_state,autonomy_level)
values(
  '05300000-0000-4000-8000-000000000001',
  '05300000-0000-4000-8000-000000000003','active','self_attested',0
) on conflict(persona_id) do update set
  owner=excluded.owner,status=excluded.status,claim_state=excluded.claim_state,
  autonomy_level=excluded.autonomy_level;
insert into public.persona_content_plans(persona_id,owner,primary_goal,content_pillars)
values(
  '05300000-0000-4000-8000-000000000003',
  '05300000-0000-4000-8000-000000000001','Human-reviewed draft','Safety and accuracy'
);
insert into public.post_drafts(
  id,owner,persona_id,brief,fb_caption,ig_caption,x_caption
) values(
  '05300000-0000-4000-8000-000000000020',
  '05300000-0000-4000-8000-000000000001',
  '05300000-0000-4000-8000-000000000003',
  'Original subject','Facebook text','Instagram text','X text'
);

set role authenticated;
select set_config('request.jwt.claim.sub','05300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"05300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
do $$
declare v_blocked boolean:=false;
begin
  begin
    perform public.save_agent_board_settings(
      '05300000-0000-4000-8000-000000000002',true,false,'{}'::text[],10
    );
  exception when others then
    if sqlerrm like 'At least one allowed task type%' then v_blocked:=true;else raise;end if;
  end;
  if not v_blocked then raise exception 'Empty task allowlist unexpectedly enabled proposals';end if;
  raise notice 'PASS: empty task allowlist is deny-all';
end
$$;
select (public.save_agent_board_settings(
  '05300000-0000-4000-8000-000000000002',true,false,array['review_draft'],10
)).persona_id;
select (public.save_agent_board_settings(
  '05300000-0000-4000-8000-000000000003',false,true,array['review_draft'],10
)).persona_id;
select public.propose_agent_board_request(
  '05300000-0000-4000-8000-000000000002',
  '05300000-0000-4000-8000-000000000003','review_draft','Review the subject.',
  'post_draft','05300000-0000-4000-8000-000000000020','{"intent":"safe draft"}'::jsonb,
  'low',null,'05300000-0000-4000-8000-000000000010'
) as first_request_id \gset
select review_hash as stale_hash from public.get_agent_board_review_item(:'first_request_id') \gset
select set_config('test.first_request_id',:'first_request_id',true);
select set_config('test.stale_hash',:'stale_hash',true);
reset role;

update public.post_drafts set brief='Changed subject after first review'
where id='05300000-0000-4000-8000-000000000020';

set role authenticated;
select set_config('request.jwt.claim.sub','05300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"05300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
do $$
declare v_blocked boolean:=false;
begin
  begin
    perform public.approve_agent_board_request(
      current_setting('test.first_request_id')::uuid,
      current_setting('test.stale_hash'),'stale review must fail'
    );
  exception when others then
    if sqlerrm like 'Review inputs changed%' then v_blocked:=true;else raise;end if;
  end;
  if not v_blocked then raise exception 'Stale review hash unexpectedly approved';end if;
  raise notice 'PASS: approval rejected review drift';
end
$$;
select review_hash as first_hash,
  review_payload#>>'{backend,credential_revision}' as first_credential_revision,
  review_payload#>>'{execution,system_prompt}' as first_system_prompt
from public.get_agent_board_review_item(:'first_request_id') \gset
select set_config('test.first_hash',:'first_hash',true);
select set_config('test.first_system_prompt',:'first_system_prompt',true);
select pg_temp.assert_true(:'first_system_prompt' like '%AUTHORITATIVE FROZEN AGENT BOARD CONTEXT%',
  'review includes the exact frozen automated system prompt');
select public.approve_agent_board_request(:'first_request_id',:'first_hash','reviewed exact packet');
select pg_temp.assert_true((select
  approved_review_payload#>>'{execution,prompt_schema}'='agent-board-v1'
  and approved_review_payload#>>'{subject,brief}'='Changed subject after first review'
  and not (approved_review_payload#>'{backend,extra}' ? 'api_key')
  and approved_review_payload#>>'{backend,extra,deployment}'='safe-deployment'
  and approved_review_hash=:'first_hash'
from public.owner_agent_board_queue_page(null,null,null,25)
where id=:'first_request_id'),
  'approval stored an exact bounded snapshot, frozen prompts, and safe backend options only');
do $$
declare v_blocked boolean:=false;
begin
  begin
    perform * from public.claim_agent_board_request_service(
      '05300000-0000-4000-8000-000000000001',
      current_setting('test.first_request_id')::uuid,current_setting('test.first_hash'),
      '05300000-0000-4000-8000-000000000030',repeat('a',64)
    );
  exception when insufficient_privilege then v_blocked:=true;
  end;
  if not v_blocked then raise exception 'Authenticated caller reached service claim';end if;
  raise notice 'PASS: secure claim is service-only';
end
$$;
reset role;

update public.personas set bio='Mutable bio changed after approval'
where id='05300000-0000-4000-8000-000000000003';
update public.ai_backends set api_key='temporary-rotated-runtime-key'
where id='05300000-0000-4000-8000-000000000010';
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare v_blocked boolean:=false;
begin
  begin
    perform * from public.claim_agent_board_request_service(
      '05300000-0000-4000-8000-000000000001',
      current_setting('test.first_request_id')::uuid,current_setting('test.first_hash'),
      '05300000-0000-4000-8000-000000000029',repeat('9',64)
    );
  exception when others then
    if sqlerrm like 'Target model credential changed%' then v_blocked:=true;else raise;end if;
  end;
  if not v_blocked then raise exception 'Credential rotation did not invalidate approval';end if;
  raise notice 'PASS: credential rotation invalidated the approved packet';
end
$$;
reset role;
update public.ai_backends set api_key=''
where id='05300000-0000-4000-8000-000000000010';

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select request_id as first_claim_request_id,run_id as first_run_id,claimed_new,
  review_payload#>>'{backend,credential_revision}' as first_run_credential_revision,
  (review_payload#>>'{execution,system_prompt}'=
    current_setting('test.first_system_prompt')) as frozen_prompt_unchanged
from public.claim_agent_board_request_service(
  '05300000-0000-4000-8000-000000000001',:'first_request_id',:'first_hash',
  '05300000-0000-4000-8000-000000000030',
  encode(extensions.digest(convert_to('053-capability-one-0000000000000000','UTF8'),'sha256'),'hex')
) \gset
select set_config('test.first_run_id',:'first_run_id',true);
select pg_temp.assert_true(:'claimed_new'::boolean,'exact request claim created one run');
select pg_temp.assert_true(:'frozen_prompt_unchanged'::boolean,
  'post-approval persona and code paths could not change the frozen system prompt');
select request_id from public.consume_agent_board_run_capability_service(
  :'first_run_id','053-capability-one-0000000000000000'
);
do $$
declare v_blocked boolean:=false;
begin
  begin
    perform * from public.consume_agent_board_run_capability_service(
      current_setting('test.first_run_id')::uuid,'053-capability-one-0000000000000000'
    );
  exception when others then
    if sqlerrm like 'Run capability is expired or already consumed%' then v_blocked:=true;else raise;end if;
  end;
  if not v_blocked then raise exception 'One-use capability was consumed twice';end if;
  raise notice 'PASS: run capability is one-use';
end
$$;
select public.mark_agent_board_provider_started_service(
  :'first_run_id',:'first_run_credential_revision'
);
select public.complete_agent_board_run(
  :'first_request_id',:'first_run_id','completed','Frozen prompt result','{}'::jsonb,''
);
select claimed_new as replay_claimed_new,request_status as replay_request_status,
  run_status as replay_run_status
from public.claim_agent_board_request_service(
  '05300000-0000-4000-8000-000000000001',:'first_request_id',:'first_hash',
  '05300000-0000-4000-8000-000000000030',repeat('b',64)
) \gset
select pg_temp.assert_true(not :'replay_claimed_new'::boolean
  and :'replay_request_status'='completed' and :'replay_run_status'='completed',
  'idempotent replay returned the original completed run without re-execution');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','05300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"05300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select public.propose_agent_board_request(
  '05300000-0000-4000-8000-000000000002',
  '05300000-0000-4000-8000-000000000003','review_draft','Budget-denial retry probe.',
  'none',null,'{}'::jsonb,'low',null,'05300000-0000-4000-8000-000000000010'
) as second_request_id \gset
select review_hash as second_hash
from public.get_agent_board_review_item(:'second_request_id') \gset
select public.approve_agent_board_request(:'second_request_id',:'second_hash','approve retry probe');
reset role;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select run_id as second_run_id from public.claim_agent_board_request_service(
  '05300000-0000-4000-8000-000000000001',:'second_request_id',:'second_hash',
  '05300000-0000-4000-8000-000000000031',
  encode(extensions.digest(convert_to('053-capability-two-0000000000000000','UTF8'),'sha256'),'hex')
) \gset
select request_id from public.consume_agent_board_run_capability_service(
  :'second_run_id','053-capability-two-0000000000000000'
);
select public.release_agent_board_run_pre_provider(
  :'second_request_id',:'second_run_id','budget_policy_denied','Budget policy denied before provider'
);
select request_status as released_request_status,
  result_json->>'pre_provider' as released_pre_provider
from public.claim_agent_board_request_service(
  '05300000-0000-4000-8000-000000000001',:'second_request_id',:'second_hash',
  '05300000-0000-4000-8000-000000000031',repeat('c',64)
) \gset
select pg_temp.assert_true(:'released_request_status'='approved'
  and :'released_pre_provider'='true',
  'pre-provider denial preserved approval and replay proved it safe to retry');

select run_id as expiring_run_id from public.claim_agent_board_request_service(
  '05300000-0000-4000-8000-000000000001',:'second_request_id',:'second_hash',
  '05300000-0000-4000-8000-000000000032',
  encode(extensions.digest(convert_to('053-capability-three-00000000000000','UTF8'),'sha256'),'hex')
) \gset
reset role;
update public.agent_board_runs set capability_expires_at=now()-interval '1 second'
where id=:'expiring_run_id';

set role authenticated;
select set_config('request.jwt.claim.sub','05300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"05300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select restored_approved,quarantined_failed
from public.reconcile_my_expired_agent_board_runs() \gset
select pg_temp.assert_true(:'restored_approved'::integer=1
  and :'quarantined_failed'::integer=0,
  'expired pre-provider run restored its immutable approval');
reset role;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select run_id as ambiguous_run_id,
  review_payload#>>'{backend,credential_revision}' as ambiguous_credential_revision
from public.claim_agent_board_request_service(
  '05300000-0000-4000-8000-000000000001',:'second_request_id',:'second_hash',
  '05300000-0000-4000-8000-000000000033',
  encode(extensions.digest(convert_to('053-capability-four-000000000000000','UTF8'),'sha256'),'hex')
) \gset
select request_id from public.consume_agent_board_run_capability_service(
  :'ambiguous_run_id','053-capability-four-000000000000000'
);
select public.mark_agent_board_provider_started_service(
  :'ambiguous_run_id',:'ambiguous_credential_revision'
);
reset role;
update public.agent_board_runs set capability_expires_at=now()-interval '1 second'
where id=:'ambiguous_run_id';

set role authenticated;
select set_config('request.jwt.claim.sub','05300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"05300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select restored_approved as ambiguous_restored,
  quarantined_failed as ambiguous_quarantined
from public.reconcile_my_expired_agent_board_runs() \gset
select pg_temp.assert_true(:'ambiguous_restored'::integer=0
  and :'ambiguous_quarantined'::integer=1
  and (select status='failed' from public.owner_agent_board_queue_page(null,null,null,25)
    where id=:'second_request_id'),
  'expired provider-started run was quarantined instead of automatically retried');
reset role;

-- A single approval cannot be amplified into unbounded pre-provider attempts.
set role authenticated;
select set_config('request.jwt.claim.sub','05300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"05300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select public.propose_agent_board_request(
  '05300000-0000-4000-8000-000000000002',
  '05300000-0000-4000-8000-000000000003','review_draft','Exact retry ceiling probe.',
  'none',null,'{}'::jsonb,'low',null,'05300000-0000-4000-8000-000000000010'
) as bounded_request_id \gset
select review_hash as bounded_hash
from public.get_agent_board_review_item(:'bounded_request_id') \gset
select public.approve_agent_board_request(:'bounded_request_id',:'bounded_hash','approve bounded retry probe');
select set_config('test.bounded_request_id',:'bounded_request_id',true);
select set_config('test.bounded_hash',:'bounded_hash',true);
reset role;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare v_index integer;v_run record;v_capability text;v_key uuid;
begin
  for v_index in 1..10 loop
    v_key:=('05310000-0000-4000-8000-'||lpad(v_index::text,12,'0'))::uuid;
    v_capability:='053-bounded-capability-'||lpad(v_index::text,32,'0');
    select * into v_run from public.claim_agent_board_request_service(
      '05300000-0000-4000-8000-000000000001',
      current_setting('test.bounded_request_id')::uuid,current_setting('test.bounded_hash'),v_key,
      encode(extensions.digest(convert_to(v_capability,'UTF8'),'sha256'),'hex')
    );
    perform * from public.consume_agent_board_run_capability_service(
      v_run.run_id,v_capability
    );
    perform public.release_agent_board_run_pre_provider(
      current_setting('test.bounded_request_id')::uuid,v_run.run_id,
      'bounded_pre_provider','Bounded denial'
    );
  end loop;
end
$$;
do $$
declare v_blocked boolean:=false;v_replay record;
begin
  begin
    perform * from public.claim_agent_board_request_service(
      '05300000-0000-4000-8000-000000000001',
      current_setting('test.bounded_request_id')::uuid,current_setting('test.bounded_hash'),
      '05310000-0000-4000-8000-000000000011',repeat('f',64)
    );
  exception when others then
    if sqlerrm like 'Agent Board exact approval attempt limit reached (10)%'
      then v_blocked:=true;else raise;end if;
  end;
  select * into v_replay from public.claim_agent_board_request_service(
    '05300000-0000-4000-8000-000000000001',
    current_setting('test.bounded_request_id')::uuid,current_setting('test.bounded_hash'),
    '05310000-0000-4000-8000-000000000001',repeat('0',64)
  );
  if not v_blocked or v_replay.claimed_new then
    raise exception 'Exact approval attempt ceiling was not atomic or replay-safe';
  end if;
  raise notice 'PASS: exact approval retry ceiling rejected without insert and preserved idempotent replay';
end
$$;
reset role;
select pg_temp.assert_true(
  (select count(*)=10 from public.agent_board_runs
    where request_id=:'bounded_request_id'::uuid and approval_hash=:'bounded_hash')
  and (select status='approved' from public.agent_board_requests
    where id=:'bounded_request_id'::uuid),
  'exact approval retry ceiling left exactly ten attempts and kept approval dormant');

-- The rolling owner claim window blocks burst amplification across approvals.
set role authenticated;
select set_config('request.jwt.claim.sub','05300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"05300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select public.propose_agent_board_request(
  '05300000-0000-4000-8000-000000000002',
  '05300000-0000-4000-8000-000000000003','review_draft','Short-window ceiling probe.',
  'none',null,'{}'::jsonb,'low',null,'05300000-0000-4000-8000-000000000010'
) as rate_request_id \gset
select review_hash as rate_hash
from public.get_agent_board_review_item(:'rate_request_id') \gset
select public.approve_agent_board_request(:'rate_request_id',:'rate_hash','approve rate probe');
select set_config('test.rate_request_id',:'rate_request_id',true);
select set_config('test.rate_hash',:'rate_hash',true);
reset role;
insert into public.agent_board_runs(
  owner,request_id,backend_id,status,idempotency_key,approval_hash,created_at,completed_at
)
select '05300000-0000-4000-8000-000000000001',:'first_request_id'::uuid,
  '05300000-0000-4000-8000-000000000010','failed',gen_random_uuid(),repeat('d',64),now(),now()
from generate_series(1,greatest(0,60-(select count(*) from public.agent_board_runs
  where owner='05300000-0000-4000-8000-000000000001'
    and idempotency_key is not null and approval_hash~'^[0-9a-f]{64}$'
    and created_at>=now()-interval '10 minutes'))::integer);
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare v_blocked boolean:=false;
begin
  begin
    perform * from public.claim_agent_board_request_service(
      '05300000-0000-4000-8000-000000000001',
      current_setting('test.rate_request_id')::uuid,current_setting('test.rate_hash'),
      gen_random_uuid(),repeat('e',64)
    );
  exception when others then
    if sqlerrm like 'Agent Board short-window claim limit reached (60 per 10 minutes)%'
      then v_blocked:=true;else raise;end if;
  end;
  if not v_blocked then
    raise exception 'Short-window claim ceiling inserted or changed denied work';
  end if;
  raise notice 'PASS: short-window claim ceiling rejected without inserting a run';
end
$$;
reset role;
select pg_temp.assert_true(
  (select count(*)=0 from public.agent_board_runs where request_id=:'rate_request_id'::uuid)
  and (select status='approved' from public.agent_board_requests
    where id=:'rate_request_id'::uuid),
  'short-window claim ceiling kept the denied request approved with no run');

-- Retained secure attempts have a high owner-wide ceiling. Legacy rows with a
-- null idempotency key are intentionally outside this count.
set role authenticated;
select set_config('request.jwt.claim.sub','05300000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"05300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select public.propose_agent_board_request(
  '05300000-0000-4000-8000-000000000002',
  '05300000-0000-4000-8000-000000000003','review_draft','Retained ceiling probe.',
  'none',null,'{}'::jsonb,'low',null,'05300000-0000-4000-8000-000000000010'
) as retained_request_id \gset
select review_hash as retained_hash
from public.get_agent_board_review_item(:'retained_request_id') \gset
select public.approve_agent_board_request(:'retained_request_id',:'retained_hash','approve retained probe');
select set_config('test.retained_request_id',:'retained_request_id',true);
select set_config('test.retained_hash',:'retained_hash',true);
reset role;
update public.agent_board_runs set created_at=now()-interval '1 day'
where owner='05300000-0000-4000-8000-000000000001' and idempotency_key is not null;
insert into public.agent_board_runs(
  owner,request_id,backend_id,status,idempotency_key,approval_hash,created_at,completed_at
)
select '05300000-0000-4000-8000-000000000001',:'first_request_id'::uuid,
  '05300000-0000-4000-8000-000000000010','failed',gen_random_uuid(),repeat('e',64),
  now()-interval '1 day',now()-interval '1 day'
from generate_series(1,greatest(0,10000-(select count(*) from public.agent_board_runs
  where owner='05300000-0000-4000-8000-000000000001'
    and idempotency_key is not null and approval_hash~'^[0-9a-f]{64}$'))::integer);
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare v_blocked boolean:=false;
begin
  begin
    perform * from public.claim_agent_board_request_service(
      '05300000-0000-4000-8000-000000000001',
      current_setting('test.retained_request_id')::uuid,current_setting('test.retained_hash'),
      gen_random_uuid(),repeat('f',64)
    );
  exception when others then
    if sqlerrm like 'Agent Board secure retained attempt limit reached (10000)%'
      then v_blocked:=true;else raise;end if;
  end;
  if not v_blocked then
    raise exception 'Retained attempt ceiling inserted or changed denied work';
  end if;
  raise notice 'PASS: owner retained attempt ceiling ignored legacy shape and rejected without insert';
end
$$;
reset role;
select pg_temp.assert_true(
  (select count(*)=0 from public.agent_board_runs where request_id=:'retained_request_id'::uuid)
  and (select status='approved' from public.agent_board_requests
    where id=:'retained_request_id'::uuid),
  'owner retained attempt ceiling kept the denied request approved with no run');

rollback;
