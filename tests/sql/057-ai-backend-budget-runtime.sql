\set ON_ERROR_STOP on
\pset pager off

-- PostgreSQL 16 behavioral probe for migration 057. Run only after the ordered
-- release migrations in a disposable database. Every fixture is rolled back.

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

insert into auth.users(id,email,email_confirmed_at) values(
  '05700000-0000-4000-8000-000000000001','budget-057@example.test',now()
);
insert into public.profiles(id,email,display_name) values(
  '05700000-0000-4000-8000-000000000001','budget-057@example.test','057 budget runtime'
) on conflict(id) do update set
  email=excluded.email,display_name=excluded.display_name;
insert into public.ai_backends(id,owner,name,base_url,api_key,model,provider,extra)
values(
  '05700000-0000-4000-8000-000000000010',
  '05700000-0000-4000-8000-000000000001',
  '057 backend','https://api.example.test/v1','','test-model','openai','{}'::jsonb
);

set role authenticated;
select set_config('request.jwt.claim.sub','05700000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"05700000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);

do $$
declare v_denied boolean:=false;
begin
  begin
    perform public.save_ai_backend_budget_policy(
      '05700000-0000-4000-8000-000000000010','owner_chat',true,
      10,100,1000,10000,1,300
    );
  exception when insufficient_privilege then v_denied:=true;
  end;
  perform pg_temp.assert_true(v_denied,'AAL1 cannot create or change a budget policy');
end
$$;

select set_config('request.jwt.claims',
  '{"sub":"05700000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select pg_temp.assert_true(public.save_ai_backend_budget_policy(
  '05700000-0000-4000-8000-000000000010','owner_chat',true,
  10,100,1000,10000,1,300
),'AAL2 can set a bounded owner-chat policy');
select pg_temp.assert_true(public.save_ai_backend_budget_policy(
  '05700000-0000-4000-8000-000000000010','agent_board',true,
  10,100,1000,10000,1,300
),'AAL2 can set a bounded agent-board policy');

do $$
declare v_denied boolean:=false;
begin
  begin
    update public.ai_backend_budget_policies set enabled=false
    where owner=auth.uid();
  exception when insufficient_privilege then v_denied:=true;
  end;
  perform pg_temp.assert_true(v_denied,'authenticated direct budget-policy DML is denied');
end
$$;

reset role;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $$
declare
  v_owner_chat record;v_owner_replay record;v_owner_second record;
  v_board record;v_missing record;
begin
  select * into v_owner_chat from public.claim_ai_backend_budget(
    '05700000-0000-4000-8000-000000000001',
    '05700000-0000-4000-8000-000000000010','owner_chat',100,
    '05700000-0000-4000-8000-000000000101'
  );
  perform pg_temp.assert_true(v_owner_chat.allowed and v_owner_chat.lease_id is not null,
    'the first owner-chat reservation is allowed');

  select * into v_owner_replay from public.claim_ai_backend_budget(
    '05700000-0000-4000-8000-000000000001',
    '05700000-0000-4000-8000-000000000010','owner_chat',100,
    '05700000-0000-4000-8000-000000000101'
  );
  perform pg_temp.assert_true(v_owner_replay.allowed
      and v_owner_replay.lease_id=v_owner_chat.lease_id,
    'an exact request-key replay returns the original active lease');

  select * into v_owner_second from public.claim_ai_backend_budget(
    '05700000-0000-4000-8000-000000000001',
    '05700000-0000-4000-8000-000000000010','owner_chat',100,
    '05700000-0000-4000-8000-000000000102'
  );
  perform pg_temp.assert_true(not v_owner_second.allowed
      and v_owner_second.denial_code='budget_concurrency_limit',
    'a second same-mode lease is denied at the configured concurrency ceiling');

  select * into v_board from public.claim_ai_backend_budget(
    '05700000-0000-4000-8000-000000000001',
    '05700000-0000-4000-8000-000000000010','agent_board',100,
    '05700000-0000-4000-8000-000000000103'
  );
  perform pg_temp.assert_true(v_board.allowed and v_board.lease_id is not null,
    'a different mode on the same backend has its own concurrency allowance');

  select * into v_missing from public.claim_ai_backend_budget(
    '05700000-0000-4000-8000-000000000001',
    '05700000-0000-4000-8000-000000000010','automation',100,
    '05700000-0000-4000-8000-000000000104'
  );
  perform pg_temp.assert_true(not v_missing.allowed
      and v_missing.denial_code='budget_policy_missing',
    'automated modes fail closed when no explicit policy exists');

  perform pg_temp.assert_true(public.finalize_ai_backend_budget(
    v_owner_chat.lease_id,'completed',42,true,'provider_completed'
  ),'known provider usage finalizes the exact lease once');
  perform pg_temp.assert_true(not public.finalize_ai_backend_budget(
    v_owner_chat.lease_id,'completed',42,true,'duplicate'
  ),'an exact lease cannot be finalized twice');
  perform pg_temp.assert_true(public.finalize_ai_backend_budget(
    v_board.lease_id,'request_failed',null,false,'usage_unknown'
  ),'unknown usage finalizes without releasing the conservative token reservation');
end
$$;

reset role;
select pg_temp.assert_true(
  (select count(*)=1 and bool_and(request_count=1 and actual_tokens=42
      and reserved_tokens=0)
   from public.ai_backend_budget_usage
   where owner='05700000-0000-4000-8000-000000000001'
     and backend_id='05700000-0000-4000-8000-000000000010'
     and mode='owner_chat' and window_kind='day'),
  'known usage replaces the owner-chat reservation with actual tokens'
);
select pg_temp.assert_true(
  (select count(*)=1 and bool_and(request_count=1 and actual_tokens=0
      and reserved_tokens=100)
   from public.ai_backend_budget_usage
   where owner='05700000-0000-4000-8000-000000000001'
     and backend_id='05700000-0000-4000-8000-000000000010'
     and mode='agent_board' and window_kind='day'),
  'unknown provider usage remains conservatively reserved'
);

rollback;
