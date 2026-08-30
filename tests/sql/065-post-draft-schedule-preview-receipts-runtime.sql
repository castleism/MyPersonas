\set ON_ERROR_STOP on
\pset pager off

-- PostgreSQL 16 behavioral probe for immutable staged Meta schedule receipts.
-- All fixtures, helper schema changes, and writes are rolled back.
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
alter table storage.objects add column if not exists metadata jsonb;
grant insert,select on storage.objects to service_role;

insert into auth.users(id,email,email_confirmed_at) values(
  '06500000-0000-4000-8000-000000000001','receipt-065@example.test',now()
);
insert into public.profiles(id,email,display_name) values(
  '06500000-0000-4000-8000-000000000001','receipt-065@example.test','065 receipt runtime'
) on conflict(id) do update set email=excluded.email,display_name=excluded.display_name;
insert into public.personas(id,owner,handle,name) values(
  '06500000-0000-4000-8000-000000000010',
  '06500000-0000-4000-8000-000000000001','receipt_065','Receipt 065'
);
insert into public.account_ledger(id,owner,persona_id,provider,username) values(
  '06500000-0000-4000-8000-000000000020',
  '06500000-0000-4000-8000-000000000001',
  '06500000-0000-4000-8000-000000000010','facebook','Receipt Page'
);
insert into public.meta_grants(
  id,owner,meta_user_id,meta_user_name,granted_scopes,expires_at,vault_secret_id
) values(
  '06500000-0000-4000-8000-000000000021',
  '06500000-0000-4000-8000-000000000001','650000000000000001','Receipt User',
  array['pages_manage_posts','pages_read_engagement'],now()+interval '1 day',
  '06500000-0000-4000-8000-000000000022'
);
insert into public.meta_page_connections(
  facebook_ledger_id,owner,grant_id,facebook_page_id,facebook_page_name,
  page_tasks,page_vault_secret_id
) values(
  '06500000-0000-4000-8000-000000000020',
  '06500000-0000-4000-8000-000000000001',
  '06500000-0000-4000-8000-000000000021','650000000000000020','Receipt Page',
  array['CREATE_CONTENT'],'06500000-0000-4000-8000-000000000023'
);

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.register_persona_media_asset_service(
  '06500000-0000-4000-8000-000000000001',
  '06500000-0000-4000-8000-000000000010','image',
  '06500000-0000-4000-8000-000000000001/published/provenance/none/uploaded/06500000-0000-4000-8000-000000000010/facebook/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/06500000-0000-4000-8000-000000000001/published/provenance/none/uploaded/06500000-0000-4000-8000-000000000010/facebook/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
  'image/png',12,'uploaded','none',repeat('a',64),repeat('a',64),
  'not_required','','',null,'facebook'
);
insert into storage.objects(bucket_id,name,owner,metadata) values(
  'post-approved-media',
  'owners/06500000-0000-4000-8000-000000000001/sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
  '06500000-0000-4000-8000-000000000001',
  '{"size":"12","mimetype":"image/png"}'::jsonb
);
reset role;

insert into public.post_drafts(
  id,owner,persona_id,status,source_image_url,fb_image_url,fb_caption,
  targets,facebook_ledger_id
) values
(
  '06500000-0000-4000-8000-000000000030',
  '06500000-0000-4000-8000-000000000001',
  '06500000-0000-4000-8000-000000000010','draft',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/06500000-0000-4000-8000-000000000001/published/provenance/none/uploaded/06500000-0000-4000-8000-000000000010/facebook/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/06500000-0000-4000-8000-000000000001/published/provenance/none/uploaded/06500000-0000-4000-8000-000000000010/facebook/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
  'Exact staged Facebook caption',array['facebook'],
  '06500000-0000-4000-8000-000000000020'
),
(
  '06500000-0000-4000-8000-000000000031',
  '06500000-0000-4000-8000-000000000001',
  '06500000-0000-4000-8000-000000000010','draft',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/06500000-0000-4000-8000-000000000001/published/provenance/none/uploaded/06500000-0000-4000-8000-000000000010/facebook/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/06500000-0000-4000-8000-000000000001/published/provenance/none/uploaded/06500000-0000-4000-8000-000000000010/facebook/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
  'Target drift Facebook caption',array['facebook'],
  '06500000-0000-4000-8000-000000000020'
);

create temporary table runtime_065_receipts(
  label text primary key,receipt_id uuid
) on commit drop;
grant select,insert on pg_temp.runtime_065_receipts to authenticated,service_role;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare v_receipt record;v_failed boolean:=false;
begin
  select * into v_receipt from public.issue_post_draft_schedule_preview_receipt_service(
    '06500000-0000-4000-8000-000000000001',
    '06500000-0000-4000-8000-000000000030',now()+interval '2 hours','UTC',
    'Exact staged Facebook caption','','',array['facebook'],
    'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/06500000-0000-4000-8000-000000000001/published/provenance/none/uploaded/06500000-0000-4000-8000-000000000010/facebook/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png','',
    repeat('a',64),'image/png',12,
    'owners/06500000-0000-4000-8000-000000000001/sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/post-approved-media/owners/06500000-0000-4000-8000-000000000001/sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    '','',0,'',''
  );
  perform pg_temp.assert_true(
    v_receipt.preview_payload->>'action'='post_draft.schedule'
      and v_receipt.preview_payload->>'targetId'='facebook:650000000000000020'
      and v_receipt.preview_payload#>>'{items,0,accountId}'='650000000000000020'
      and v_receipt.preview_payload#>>'{items,0,timezone}'='UTC'
      and v_receipt.preview_payload#>>'{items,0,mediaUrl}' like '%/post-approved-media/%'
      and v_receipt.preview_payload#>>'{items,0,platformDetails,1}'=
        'Immutable media SHA-256: '||repeat('a',64),
    'server issue binds exact target, time zone, and immutable staged media into the second preview'
  );
  insert into pg_temp.runtime_065_receipts values('main',v_receipt.receipt_id);
  begin
    perform public.consume_acknowledged_post_draft_schedule_preview_service(
      '06500000-0000-4000-8000-000000000001',
      '06500000-0000-4000-8000-000000000030',v_receipt.receipt_id
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'service commit fails closed before the owner acknowledgement transition');
end
$$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','06500000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"06500000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
do $$
declare v_failed boolean:=false;
begin
  begin
    perform public.acknowledge_post_draft_schedule_preview_receipt(
      (select receipt_id from pg_temp.runtime_065_receipts where label='main'),
      '06500000-0000-4000-8000-000000000030'
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,'AAL1 cannot acknowledge a staged schedule receipt');
end
$$;
select set_config('request.jwt.claims',
  '{"sub":"06500000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select pg_temp.assert_true(
  (select acknowledged_at is not null from public.acknowledge_post_draft_schedule_preview_receipt(
    (select receipt_id from pg_temp.runtime_065_receipts where label='main'),
    '06500000-0000-4000-8000-000000000030'
  )),
  'AAL2 acknowledgement records a distinct transition without scheduling'
);
select pg_temp.assert_true(
  (select status='draft' from public.post_drafts
    where id='06500000-0000-4000-8000-000000000030'),
  'acknowledgement alone never queues or schedules the post'
);

reset role;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare v_draft public.post_drafts%rowtype;v_failed boolean:=false;
begin
  select * into v_draft from public.consume_acknowledged_post_draft_schedule_preview_service(
    '06500000-0000-4000-8000-000000000001',
    '06500000-0000-4000-8000-000000000030',
    (select receipt_id from pg_temp.runtime_065_receipts where label='main')
  );
  perform pg_temp.assert_true(
    v_draft.status='scheduled'
      and v_draft.approved_facebook_page_id='650000000000000020'
      and v_draft.approved_fb_media_sha256=repeat('a',64)
      and v_draft.fb_image_url like '%/post-approved-media/%'
      and v_draft.approved_previewed_at is not null,
    'one-shot consume schedules the exact staged bytes, target, and approval evidence'
  );
  begin
    perform public.consume_acknowledged_post_draft_schedule_preview_service(
      '06500000-0000-4000-8000-000000000001',
      '06500000-0000-4000-8000-000000000030',
      (select receipt_id from pg_temp.runtime_065_receipts where label='main')
    );
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,'a schedule receipt cannot be consumed twice');
end
$$;
set constraints all immediate;

reset role;
select pg_temp.assert_true(
  not has_table_privilege('authenticated',
    'public.post_draft_schedule_preview_receipts','select'),
  'browser roles cannot read or forge schedule receipts'
);
select pg_temp.assert_true(
  to_regprocedure('public.approve_and_schedule_previewed_post_draft(uuid,uuid,timestamptz,text,text,text,text,text[],text,text,text,text,bigint,text,text,text,text,bigint,text,text,text,text,text)') is null,
  'the former raw boolean and browser-target scheduling wrapper is absent'
);
select pg_temp.assert_true(
  not has_function_privilege('service_role',
    'public.approve_and_schedule_post_draft(uuid,uuid,timestamptz,text,text,text,text,text[],text,text,text,text,bigint,text,text,text,text,bigint,text,text)','execute'),
  'service callers cannot bypass the receipt and call the old scheduler directly'
);

rollback;
