\set ON_ERROR_STOP on
\pset pager off

-- Behavioral probe for the shared provider action-time receipt contract.
-- Run after migration 067 in a disposable database. Every fixture is rolled back.
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
  '06700000-0000-4000-8000-000000000001','receipt-067@example.test',now()
);
insert into public.profiles(id,email,display_name) values(
  '06700000-0000-4000-8000-000000000001','receipt-067@example.test','067 receipt runtime'
) on conflict(id) do update set email=excluded.email,display_name=excluded.display_name;
insert into public.personas(id,owner,handle,name) values(
  '06700000-0000-4000-8000-000000000010',
  '06700000-0000-4000-8000-000000000001','receipt_067','Receipt 067'
);
insert into public.account_ledger(id,owner,persona_id,provider,username) values(
  '06700000-0000-4000-8000-000000000020',
  '06700000-0000-4000-8000-000000000001',
  '06700000-0000-4000-8000-000000000010','wordpress','receipt_067'
);
insert into public.drafts(
  id,owner,persona_id,account_id,platform,title,body,tags,content_kind,status
) values(
  '06700000-0000-4000-8000-000000000030',
  '06700000-0000-4000-8000-000000000001',
  '06700000-0000-4000-8000-000000000010',
  '06700000-0000-4000-8000-000000000020',
  'wordpress','Exact receipt title','Exact receipt body','#receipt','article','ready'
);

create temporary table runtime_067_receipts(
  label text primary key,receipt_id uuid,receipt_hash text
) on commit drop;
grant select,insert,update on pg_temp.runtime_067_receipts to authenticated,service_role;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare v_receipt jsonb;v_failed boolean:=false;
begin
  v_receipt:=public.prepare_provider_action_preview_service(
    '06700000-0000-4000-8000-000000000001',
    '06700000-0000-4000-8000-000000000030',
    '06700000-0000-4000-8000-000000000020',
    'wordpress','wordpress.create_draft','wpcom:site-067:author-067',
    repeat('a',64),repeat('b',64),'cms-provider-draft-preview-v1',
    jsonb_build_object('items',jsonb_build_array(jsonb_build_object(
      'provider','wordpress','title','Exact receipt title','text','Exact receipt body'
    )))
  );
  perform pg_temp.assert_true(
    v_receipt->>'receiptId' is not null
      and v_receipt->>'receiptHash'~'^[0-9a-f]{64}$'
      and v_receipt#>>'{preview,items,0,provider}'='wordpress',
    'service prepares an immutable exact provider preview snapshot'
  );
  insert into pg_temp.runtime_067_receipts(label,receipt_id,receipt_hash)
  values('first',(v_receipt->>'receiptId')::uuid,v_receipt->>'receiptHash');
  begin
    perform public.consume_provider_action_preview_service(
      '06700000-0000-4000-8000-000000000001',
      '06700000-0000-4000-8000-000000000030',
      '06700000-0000-4000-8000-000000000020',
      'wordpress','wordpress.create_draft',(v_receipt->>'receiptId')::uuid,
      'wpcom:site-067:author-067',repeat('a',64),repeat('b',64)
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'an issued but unacknowledged receipt cannot permit a provider action');
end
$$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','06700000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"06700000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
do $$
declare v_failed boolean:=false;
begin
  begin
    perform public.acknowledge_provider_action_preview(
      (select receipt_id from pg_temp.runtime_067_receipts where label='first'),
      (select receipt_hash from pg_temp.runtime_067_receipts where label='first'),
      'cms-provider-draft-preview-v1'
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,'AAL1 cannot acknowledge a provider action receipt');
end
$$;

select set_config('request.jwt.claims',
  '{"sub":"06700000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select pg_temp.assert_true(
  (public.acknowledge_provider_action_preview(
    (select receipt_id from pg_temp.runtime_067_receipts where label='first'),
    (select receipt_hash from pg_temp.runtime_067_receipts where label='first'),
    'cms-provider-draft-preview-v1'
  )->>'acknowledged')::boolean,
  'AAL2 owner acknowledgement is a separate durable transition'
);
select pg_temp.assert_true(
  not has_table_privilege('authenticated','public.provider_action_preview_receipts','insert')
    and not has_table_privilege('authenticated','public.provider_action_preview_receipts','update'),
  'browser roles cannot forge or mutate provider preview receipts'
);

reset role;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare v_id uuid;v_failed boolean:=false;
begin
  select receipt_id into v_id from pg_temp.runtime_067_receipts where label='first';
  perform pg_temp.assert_true(
    not has_function_privilege(
      'service_role',
      'public.consume_provider_action_preview_service(uuid,uuid,uuid,text,text,uuid,text,text,text)',
      'execute'
    ) and not has_function_privilege(
      'service_role',
      'public.consume_provider_action_preview_for_claim_service(uuid,uuid,uuid,text,text,uuid,text,text,text,uuid,text)',
      'execute'
    ),
    'service code cannot call either low-level receipt consumer directly'
  );
  begin
    perform public.consume_provider_action_preview_service(
      '06700000-0000-4000-8000-000000000001',
      '06700000-0000-4000-8000-000000000030',
      '06700000-0000-4000-8000-000000000020',
      'wordpress','wordpress.create_draft',v_id,
      'wpcom:site-067:author-067',repeat('a',64),repeat('b',64)
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'an acknowledged receipt still cannot bypass a provider-specific atomic wrapper');
  perform pg_temp.assert_true(exists(
    select 1 from public.provider_action_preview_receipts
    where id=v_id and acknowledged_at is not null and consumed_at is null
  ),'a rejected direct call leaves the acknowledged receipt unconsumed');
end
$$;

-- The migration owner can probe the internal primitive without exposing it to
-- Edge code. Provider-specific wrappers are the only service-callable surface.
reset role;
do $$
declare v_id uuid;v_failed boolean:=false;
begin
  select receipt_id into v_id from pg_temp.runtime_067_receipts where label='first';
  begin
    perform public.consume_provider_action_preview_service(
      '06700000-0000-4000-8000-000000000001',
      '06700000-0000-4000-8000-000000000030',
      '06700000-0000-4000-8000-000000000020',
      'wordpress','wordpress.create_draft',v_id,
      'wpcom:site-067:author-067',repeat('a',64),repeat('c',64)
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'changed action bytes cannot consume an acknowledged receipt');
  perform public.consume_provider_action_preview_service(
    '06700000-0000-4000-8000-000000000001',
    '06700000-0000-4000-8000-000000000030',
    '06700000-0000-4000-8000-000000000020',
    'wordpress','wordpress.create_draft',v_id,
    'wpcom:site-067:author-067',repeat('a',64),repeat('b',64)
  );
  perform pg_temp.assert_true(exists(
    select 1 from public.provider_action_preview_receipts
    where id=v_id and acknowledged_at is not null and acknowledged_by=owner
      and consumed_at is not null
  ),'the unchanged acknowledged receipt primitive remains one-shot');
  v_failed:=false;
  begin
    perform public.consume_provider_action_preview_service(
      '06700000-0000-4000-8000-000000000001',
      '06700000-0000-4000-8000-000000000030',
      '06700000-0000-4000-8000-000000000020',
      'wordpress','wordpress.create_draft',v_id,
      'wpcom:site-067:author-067',repeat('a',64),repeat('b',64)
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,'a consumed receipt cannot be replayed');
end
$$;

rollback;
