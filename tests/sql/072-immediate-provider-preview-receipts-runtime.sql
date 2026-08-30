\set ON_ERROR_STOP on
\pset pager off

-- PostgreSQL 16 behavioral probe for migration 072. Run only after migrations
-- 069 and 072 in a disposable database. Every fixture is rolled back.
begin;

-- The disposable strict-ACL image does not install Supabase's auth.jwt()
-- helper, so provide the same claims reader inside this rolled-back probe.
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
  '07200000-0000-4000-8000-000000000001','receipt-072@example.test',now()
);
insert into public.profiles(id,email,display_name) values(
  '07200000-0000-4000-8000-000000000001','receipt-072@example.test','072 receipt runtime'
) on conflict(id) do update set
  email=excluded.email,display_name=excluded.display_name;
insert into public.personas(id,owner,handle,name) values(
  '07200000-0000-4000-8000-000000000010',
  '07200000-0000-4000-8000-000000000001','receipt_072','Receipt 072'
);
insert into public.account_ledger(
  id,owner,persona_id,provider,username
) values(
  '07200000-0000-4000-8000-000000000020',
  '07200000-0000-4000-8000-000000000001',
  '07200000-0000-4000-8000-000000000010','twitter','receipt_072'
);
insert into public.account_connections(
  ledger_id,owner,provider,provider_subject,granted_scopes,
  connection_state,verification_method,verified_at,connected_at
) values(
  '07200000-0000-4000-8000-000000000020',
  '07200000-0000-4000-8000-000000000001','twitter','072-twitter-subject',
  array['tweet.read','users.read','offline.access','tweet.write'],
  'connected','twitter_oauth',now(),now()
);
insert into public.drafts(
  id,owner,persona_id,account_id,platform,title,body,tags,content_kind,status
) values
(
  '07200000-0000-4000-8000-000000000030',
  '07200000-0000-4000-8000-000000000001',
  '07200000-0000-4000-8000-000000000010',
  '07200000-0000-4000-8000-000000000020',
  'twitter','','Exact immediate receipt text','#receipt','post','ready'
),
(
  '07200000-0000-4000-8000-000000000031',
  '07200000-0000-4000-8000-000000000001',
  '07200000-0000-4000-8000-000000000010',
  '07200000-0000-4000-8000-000000000020',
  'twitter','','Future receipt must fail','#future','post','ready'
),
(
  '07200000-0000-4000-8000-000000000032',
  '07200000-0000-4000-8000-000000000001',
  '07200000-0000-4000-8000-000000000010',
  '07200000-0000-4000-8000-000000000020',
  'twitter','','Content drift must fail','#drift','post','ready'
),
(
  '07200000-0000-4000-8000-000000000033',
  '07200000-0000-4000-8000-000000000001',
  '07200000-0000-4000-8000-000000000010',
  '07200000-0000-4000-8000-000000000020',
  'twitter','','Visit example.com','','post','ready'
);

-- Build exact approval/preview fixtures directly as the disposable database
-- owner. The production owner RPC additionally requires an active L2/L3 agent,
-- which is unrelated to the receipt behavior under test.
update public.drafts set publish_at=now()+interval '1 hour'
where id='07200000-0000-4000-8000-000000000031';
update public.drafts d set
  approval_state='approved',approved_at=now(),
  approved_content_hash=public.agent_draft_hash(
    d.title,d.body,d.tags,d.media_url,d.content_kind,d.persona_id,d.account_id,
    d.platform,d.publish_at
  ),
  publish_state=case when d.publish_at is null then 'not_queued' else 'queued' end
where d.id in(
  '07200000-0000-4000-8000-000000000030',
  '07200000-0000-4000-8000-000000000031',
  '07200000-0000-4000-8000-000000000032',
  '07200000-0000-4000-8000-000000000033'
);
update public.drafts d set
  approved_preview_version='platform-preview-v1',
  approved_preview_target_id='072-twitter-subject',approved_previewed_at=now(),
  approved_preview_hash=public.agent_draft_preview_hash(
    d.approved_content_hash,'platform-preview-v1','072-twitter-subject'
  )
where d.id in(
  '07200000-0000-4000-8000-000000000030',
  '07200000-0000-4000-8000-000000000031',
  '07200000-0000-4000-8000-000000000032',
  '07200000-0000-4000-8000-000000000033'
);
set constraints all immediate;

set role authenticated;
select set_config('request.jwt.claim.sub','07200000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"07200000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
do $$
declare v_denied boolean:=false;
begin
  begin
    perform public.issue_immediate_agent_preview_receipt_service(
      '07200000-0000-4000-8000-000000000001',
      '07200000-0000-4000-8000-000000000030','twitter','twitter.publish_now'
    );
  exception when insufficient_privilege then v_denied:=true;
  end;
  perform pg_temp.assert_true(v_denied,
    'authenticated callers cannot mint service preview receipts');
end
$$;
select pg_temp.assert_true(
  not has_table_privilege('authenticated',
    'public.immediate_provider_preview_receipts','select'),
  'authenticated callers cannot read the receipt table directly'
);

reset role;
create temporary table runtime_072_receipts(
  label text primary key,receipt_id uuid,receipt_hash text
) on commit drop;
grant select,insert,update on pg_temp.runtime_072_receipts
  to authenticated,service_role;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $$
declare
  v_receipt record;
  v_failed boolean:=false;
begin
  select * into v_receipt
  from public.issue_immediate_agent_preview_receipt_service(
    '07200000-0000-4000-8000-000000000001',
    '07200000-0000-4000-8000-000000000030','twitter','twitter.publish_now'
  );
  perform pg_temp.assert_true(v_receipt.receipt_id is not null
      and v_receipt.receipt_hash ~ '^[0-9a-f]{64}$',
    'the server mints an opaque integrity-bound receipt');
  perform pg_temp.assert_true(
    v_receipt.expires_at>v_receipt.created_at
      and v_receipt.expires_at<=v_receipt.created_at+interval '5 minutes',
    'the receipt has a bounded server-authored lifetime');
  perform pg_temp.assert_true(
    v_receipt.preview_payload->>'provider'='twitter'
      and v_receipt.preview_payload->>'action'='twitter.publish_now'
      and v_receipt.preview_payload->>'targetId'='072-twitter-subject'
      and (v_receipt.preview_payload#>>'{providerPayload,made_with_ai}')::boolean
      and (v_receipt.preview_payload#>>'{providerPayload,weightedLength}')::integer>0
      and v_receipt.preview_payload#>>'{providerPayload,weightingRule}'='x-conservative-v1'
      and v_receipt.preview_payload#>>'{items,0,timingLabel}'='Immediately after approval',
    'the preview binds exact provider, action, target, weighted copy, AI disclosure, and timing');

  insert into pg_temp.runtime_072_receipts(label,receipt_id,receipt_hash)
    values('claim',v_receipt.receipt_id,v_receipt.receipt_hash);

  begin
    perform public.claim_immediate_agent_draft_with_preview_service(
      '07200000-0000-4000-8000-000000000001',
      '07200000-0000-4000-8000-000000000030','twitter',
      'twitter.publish_now',v_receipt.receipt_id
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'an issued but unacknowledged receipt cannot claim or write');
end
$$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','07200000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"07200000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
do $$
declare v_failed boolean:=false;
begin
  begin
    perform public.acknowledge_immediate_provider_preview_receipt(
      (select receipt_id from pg_temp.runtime_072_receipts where label='claim'),
      '07200000-0000-4000-8000-000000000030','twitter','twitter.publish_now'
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'AAL1 cannot acknowledge an immediate provider write receipt');
end
$$;

select set_config('request.jwt.claims',
  '{"sub":"07200000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select pg_temp.assert_true(
  (select acknowledged_at is not null from public.acknowledge_immediate_provider_preview_receipt(
    (select receipt_id from pg_temp.runtime_072_receipts where label='claim'),
    '07200000-0000-4000-8000-000000000030','twitter','twitter.publish_now'
  )),
  'AAL2 owner acknowledgement records a separate durable transition'
);

reset role;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare v_failed boolean:=false;
begin
  begin
    perform public.issue_immediate_agent_preview_receipt_service(
      '07200000-0000-4000-8000-000000000001',
      '07200000-0000-4000-8000-000000000033','twitter','twitter.publish_now'
    );
  exception when others then
    v_failed:=position('Exact X weighted length cannot be guaranteed' in sqlerrm)>0;
  end;
  perform pg_temp.assert_true(v_failed,
    'ambiguous bare-domain weighting fails before an X receipt can be minted');
end
$$;
do $$
declare v_claim public.drafts%rowtype;v_failed boolean:=false;v_receipt_id uuid;
begin
  select receipt_id into v_receipt_id from pg_temp.runtime_072_receipts where label='claim';
  select * into v_claim
  from public.claim_immediate_agent_draft_with_preview_service(
    '07200000-0000-4000-8000-000000000001',
    '07200000-0000-4000-8000-000000000030','twitter',
    'twitter.publish_now',v_receipt_id
  );
  perform pg_temp.assert_true(v_claim.publish_state='publishing',
    'acknowledged receipt consumption and provider claim complete atomically');
  perform pg_temp.assert_true(exists(
    select 1 from public.immediate_provider_preview_receipts
    where id=v_receipt_id and acknowledged_at is not null
      and consumed_at is not null and consumed_claim_id is not null
  ),'the consumed receipt records acknowledgement and its one-shot claim');
  begin
    perform public.claim_immediate_agent_draft_with_preview_service(
      '07200000-0000-4000-8000-000000000001',
      '07200000-0000-4000-8000-000000000030','twitter',
      'twitter.publish_now',v_receipt_id
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,'a consumed receipt cannot claim twice');
end
$$;

do $$
declare v_failed boolean:=false;
begin
  begin
    perform public.issue_immediate_agent_preview_receipt_service(
      '07200000-0000-4000-8000-000000000001',
      '07200000-0000-4000-8000-000000000031','twitter','twitter.publish_now'
    );
  exception when others then
    v_failed:=position('future-scheduled draft cannot be posted now' in sqlerrm)>0;
  end;
  perform pg_temp.assert_true(v_failed,
    'a future-approved draft cannot mint an immediate-write receipt');
end
$$;

do $$
declare v_receipt record;v_failed boolean:=false;
begin
  select * into v_receipt
  from public.issue_immediate_agent_preview_receipt_service(
    '07200000-0000-4000-8000-000000000001',
    '07200000-0000-4000-8000-000000000032','twitter','twitter.publish_now'
  );
  insert into pg_temp.runtime_072_receipts(label,receipt_id,receipt_hash)
    values('drift',v_receipt.receipt_id,v_receipt.receipt_hash);
end
$$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','07200000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"07200000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select public.acknowledge_immediate_provider_preview_receipt(
  (select receipt_id from pg_temp.runtime_072_receipts where label='drift'),
  '07200000-0000-4000-8000-000000000032','twitter','twitter.publish_now'
);

reset role;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare v_failed boolean:=false;v_receipt_id uuid;
begin
  select receipt_id into v_receipt_id from pg_temp.runtime_072_receipts where label='drift';
  update public.drafts set body='Content changed after the receipt'
  where id='07200000-0000-4000-8000-000000000032';
  begin
    perform public.claim_immediate_agent_draft_with_preview_service(
      '07200000-0000-4000-8000-000000000001',
      '07200000-0000-4000-8000-000000000032','twitter',
      'twitter.publish_now',v_receipt_id
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'content drift invalidates the outstanding exact receipt');
  perform pg_temp.assert_true((select consumed_at is null
    from public.immediate_provider_preview_receipts where id=v_receipt_id),
    'a rejected drift claim does not burn the receipt outside the rolled-back claim');
end
$$;

reset role;
select pg_temp.assert_true(
  not has_function_privilege('service_role',
    'public.consume_immediate_agent_preview_receipt_service(uuid,uuid,text,text,uuid,uuid)','execute'),
  'service callers cannot consume a receipt outside an atomic claim wrapper'
);
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare v_failed boolean:=false;
begin
  begin
    insert into public.discord_publish_attempts(
      id,owner,draft_id,ledger_id,approval_hash,webhook_id,channel_id
    ) values(
      '07200000-0000-4000-8000-000000000099',
      '07200000-0000-4000-8000-000000000001',
      '07200000-0000-4000-8000-000000000032',
      '07200000-0000-4000-8000-000000000020',
      repeat('a',64),'123456789012345678','123456789012345679'
    );
  exception when others then
    v_failed:=position('one-shot Discord preview receipt' in sqlerrm)>0;
  end;
  perform pg_temp.assert_true(v_failed,
    'the legacy Discord claim insert cannot bypass the receipt-aware wrapper');
end
$$;

rollback;
