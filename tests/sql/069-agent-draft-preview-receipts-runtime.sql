\set ON_ERROR_STOP on
\pset pager off

-- PostgreSQL 16 behavioral probe for the immutable generic Queue approval
-- receipt. Every fixture and helper is rolled back.
begin;

create or replace function auth.jwt()
returns jsonb language sql stable set search_path='' as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
$$;
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
  '06900000-0000-4000-8000-000000000001','receipt-069@example.test',now()
);
insert into public.profiles(id,email,display_name) values(
  '06900000-0000-4000-8000-000000000001','receipt-069@example.test','069 receipt runtime'
) on conflict(id) do update set
  email=excluded.email,display_name=excluded.display_name;
insert into public.personas(id,owner,handle,name) values(
  '06900000-0000-4000-8000-000000000010',
  '06900000-0000-4000-8000-000000000001','receipt_069','Receipt 069'
);
insert into public.agent_bindings(
  id,owner,persona_id,claim_state,status,autonomy_level
) values(
  '06900000-0000-4000-8000-000000000011',
  '06900000-0000-4000-8000-000000000001',
  '06900000-0000-4000-8000-000000000010','verified','active',2
) on conflict(persona_id) do update set
  claim_state=excluded.claim_state,status=excluded.status,
  autonomy_level=excluded.autonomy_level;
insert into public.account_ledger(id,owner,persona_id,provider,username) values(
  '06900000-0000-4000-8000-000000000020',
  '06900000-0000-4000-8000-000000000001',
  '06900000-0000-4000-8000-000000000010','twitter','receipt_069'
);
insert into public.account_connections(
  ledger_id,owner,provider,provider_subject,granted_scopes,
  connection_state,verification_method,verified_at,connected_at
) values(
  '06900000-0000-4000-8000-000000000020',
  '06900000-0000-4000-8000-000000000001','twitter','069-twitter-subject',
  array['tweet.read','users.read','tweet.write'],'connected','twitter_oauth',now(),now()
);
insert into public.drafts(
  id,owner,persona_id,account_id,platform,title,body,tags,content_kind,status,publish_at
) values(
  '06900000-0000-4000-8000-000000000030',
  '06900000-0000-4000-8000-000000000001',
  '06900000-0000-4000-8000-000000000010',
  '06900000-0000-4000-8000-000000000020','twitter','',
  'Exact generic approval body','#069','post','ready',now()+interval '1 hour'
);

create temporary table runtime_069_receipt(
  receipt_id uuid primary key,action text,target_id text
) on commit drop;
grant select,insert on pg_temp.runtime_069_receipt to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','06900000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"06900000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);

do $$
declare v_receipt record;v_failed boolean:=false;
begin
  select * into v_receipt from public.issue_agent_draft_preview_receipt(
    '06900000-0000-4000-8000-000000000030',
    (select publish_at from public.drafts where id='06900000-0000-4000-8000-000000000030'),
    'America/Anchorage'
  );
  perform pg_temp.assert_true(
    v_receipt.preview_payload->>'action'='draft.approve'
      and v_receipt.preview_payload->>'targetId'='069-twitter-subject'
      and v_receipt.preview_payload#>>'{items,0,accountId}'='069-twitter-subject'
      and v_receipt.preview_payload#>>'{items,0,timezone}'='America/Anchorage',
    'server issue binds the exact target, action, time zone, and preview item'
  );
  insert into pg_temp.runtime_069_receipt(receipt_id,action,target_id) values(
    v_receipt.receipt_id,v_receipt.preview_payload->>'action',
    v_receipt.preview_payload->>'targetId'
  );
  begin
    perform public.consume_acknowledged_agent_draft_preview(
      v_receipt.receipt_id,'06900000-0000-4000-8000-000000000030'
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'direct consume fails closed while the server receipt is unacknowledged');
end
$$;

do $$
declare v_failed boolean:=false;
begin
  begin
    perform public.acknowledge_agent_draft_preview_receipt(
      (select receipt_id from pg_temp.runtime_069_receipt),
      '06900000-0000-4000-8000-000000000030'
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,'AAL1 cannot acknowledge a draft approval receipt');
end
$$;

select set_config('request.jwt.claims',
  '{"sub":"06900000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select pg_temp.assert_true(
  (select acknowledged_at is not null from public.acknowledge_agent_draft_preview_receipt(
    (select receipt_id from pg_temp.runtime_069_receipt),
    '06900000-0000-4000-8000-000000000030'
  )),
  'AAL2 acknowledgement is a separate durable transition'
);

do $$
declare v_draft public.drafts%rowtype;v_failed boolean:=false;
begin
  select * into v_draft from public.consume_acknowledged_agent_draft_preview(
    (select receipt_id from pg_temp.runtime_069_receipt),
    '06900000-0000-4000-8000-000000000030'
  );
  perform pg_temp.assert_true(
    v_draft.approval_state='approved'
      and v_draft.publish_state='not_queued'
      and v_draft.approved_preview_target_id='069-twitter-subject'
      and v_draft.approved_previewed_at is not null,
    'one-shot consume performs only the exact approved action and stores evidence'
  );
  begin
    perform public.consume_acknowledged_agent_draft_preview(
      (select receipt_id from pg_temp.runtime_069_receipt),
      '06900000-0000-4000-8000-000000000030'
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,'the acknowledged approval receipt cannot be consumed twice');
end
$$;
set constraints all immediate;

reset role;
select pg_temp.assert_true(
  not has_table_privilege('authenticated','public.agent_draft_preview_receipts','select'),
  'browser roles cannot read or forge generic approval receipts'
);
select pg_temp.assert_true(
  to_regprocedure('public.approve_previewed_agent_draft(uuid,timestamptz,text,text)') is null,
  'the former raw preview-version and browser-target wrapper is absent'
);
select pg_temp.assert_true(
  not has_function_privilege('authenticated',
    'public.approve_agent_draft(uuid,timestamptz)','execute'),
  'the pre-receipt approval function cannot be called directly'
);

rollback;
