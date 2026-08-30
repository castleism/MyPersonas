\set ON_ERROR_STOP on
\pset pager off

-- PostgreSQL 17 behavioral probe for the 067/068/070 action-time wrappers.
-- It covers unacknowledged direct calls, transactional crash rollback,
-- conflicting attempts, content drift, one-shot replay, and claim binding.
-- Every fixture and Vault secret is rolled back.
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
  '67070000-0000-4000-8000-000000000001','atomic-067-070@example.test',now()
);
insert into public.profiles(id,email,display_name) values(
  '67070000-0000-4000-8000-000000000001',
  'atomic-067-070@example.test','Atomic provider claim runtime'
) on conflict(id) do update set email=excluded.email,display_name=excluded.display_name;
insert into public.personas(id,owner,handle,name) values(
  '67070000-0000-4000-8000-000000000010',
  '67070000-0000-4000-8000-000000000001','atomic_067_070','Atomic 067-070'
);
insert into public.agent_owner_settings(owner,automation_paused)
values('67070000-0000-4000-8000-000000000001',false)
on conflict(owner) do update set automation_paused=false;
insert into public.account_ledger(id,owner,persona_id,provider,username,login_email) values
  ('67070000-0000-4000-8000-000000000020','67070000-0000-4000-8000-000000000001',
   '67070000-0000-4000-8000-000000000010','youtube','atomic_youtube','youtube@example.test'),
  ('67070000-0000-4000-8000-000000000021','67070000-0000-4000-8000-000000000001',
   '67070000-0000-4000-8000-000000000010','tiktok','atomic_tiktok',''),
  ('67070000-0000-4000-8000-000000000022','67070000-0000-4000-8000-000000000001',
   '67070000-0000-4000-8000-000000000010','wix','atomic_wix',''),
  ('67070000-0000-4000-8000-000000000023','67070000-0000-4000-8000-000000000001',
   '67070000-0000-4000-8000-000000000010','wordpress','atomic_wordpress','');

create temporary table atomic_runtime(
  label text primary key,value_text text,value_uuid uuid
) on commit drop;
grant select,insert,update,delete on pg_temp.atomic_runtime
  to authenticated,service_role;

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

select pg_temp.assert_true(
  not has_function_privilege('service_role',
    'public.consume_provider_action_preview_service(uuid,uuid,uuid,text,text,uuid,text,text,text)',
    'execute')
  and not has_function_privilege('service_role',
    'public.consume_provider_action_preview_for_claim_service(uuid,uuid,uuid,text,text,uuid,text,text,text,uuid,text)',
    'execute'),
  'service code cannot bypass provider wrappers through either receipt consumer'
);
select pg_temp.assert_true(
  has_function_privilege('service_role',
    'public.claim_youtube_upload_with_preview_service(uuid,uuid,uuid)','execute')
  and has_function_privilege('service_role',
    'public.claim_tiktok_publish_with_preview_service(uuid,uuid,uuid)','execute')
  and has_function_privilege('service_role',
    'public.claim_cms_draft_with_preview_service(uuid,uuid,text,uuid)','execute'),
  'service role can execute only the provider-specific atomic claim surfaces'
);

select public.youtube_store_token_bundle(
  '67070000-0000-4000-8000-000000000020',
  '67070000-0000-4000-8000-000000000001','6707000001','youtube@example.test',
  'UC1234567890123456789012','Atomic YouTube','youtube-access','youtube-refresh',
  'bearer','https://www.googleapis.com/auth/youtube.upload',now()+interval '1 hour'
);
select public.tiktok_store_token_bundle(
  '67070000-0000-4000-8000-000000000021',
  '67070000-0000-4000-8000-000000000001','atomic_tiktok','atomic-open-id','atomic_tiktok',
  'tiktok-access','tiktok-refresh','bearer',
  array['user.info.basic','user.info.profile','video.upload'],
  now()+interval '1 hour',now()+interval '1 day'
);
select public.cms_store_credential_service(
  '67070000-0000-4000-8000-000000000022',
  '67070000-0000-4000-8000-000000000001','wix','wix_app_instance',
  'wix:site-atomic:author-atomic','site-atomic','https://atomic-wix.example',
  'Atomic Wix','author-atomic','Atomic Author','{"instance":"test"}'::jsonb,
  array['READ_MEMBERS','MANAGE_BLOG']
);
select public.cms_store_credential_service(
  '67070000-0000-4000-8000-000000000023',
  '67070000-0000-4000-8000-000000000001','wordpress','wordpress_com_oauth',
  'wpcom:6707:author-6707','6707','https://atomic-wordpress.example',
  'Atomic WordPress','author-6707','Atomic Author','{"access_token":"test"}'::jsonb,
  array['posts']
);

insert into pg_temp.atomic_runtime(label,value_uuid)
select 'video_asset',public.register_persona_media_asset_service(
  '67070000-0000-4000-8000-000000000001',
  '67070000-0000-4000-8000-000000000010','video',
  '67070000-0000-4000-8000-000000000001/published/provenance/none/uploaded/67070000-0000-4000-8000-000000000010/video/original/'||repeat('a',64)||'.mp4',
  'https://runtime.example/storage/v1/object/public/persona-media/67070000-0000-4000-8000-000000000001/published/provenance/none/uploaded/67070000-0000-4000-8000-000000000010/video/original/'||repeat('a',64)||'.mp4',
  'video/mp4',1024,'uploaded','none',repeat('a',64),repeat('a',64),
  'not_required','','',null,'original'
);

reset role;
insert into public.drafts(
  id,owner,persona_id,account_id,platform,title,body,tags,media_url,
  content_kind,status
) values
  ('67070000-0000-4000-8000-000000000030','67070000-0000-4000-8000-000000000001',
   '67070000-0000-4000-8000-000000000010','67070000-0000-4000-8000-000000000020',
   'youtube','Atomic YouTube title','Atomic YouTube body','#atomic',
   'https://runtime.example/storage/v1/object/public/persona-media/67070000-0000-4000-8000-000000000001/published/provenance/none/uploaded/67070000-0000-4000-8000-000000000010/video/original/'||repeat('a',64)||'.mp4',
   'reel','ready'),
  ('67070000-0000-4000-8000-000000000031','67070000-0000-4000-8000-000000000001',
   '67070000-0000-4000-8000-000000000010','67070000-0000-4000-8000-000000000021',
   'tiktok','Atomic TikTok title','Atomic TikTok body','#atomic',
   'https://runtime.example/storage/v1/object/public/persona-media/67070000-0000-4000-8000-000000000001/published/provenance/none/uploaded/67070000-0000-4000-8000-000000000010/video/original/'||repeat('a',64)||'.mp4',
   'reel','ready'),
  ('67070000-0000-4000-8000-000000000032','67070000-0000-4000-8000-000000000001',
   '67070000-0000-4000-8000-000000000010','67070000-0000-4000-8000-000000000022',
   'wix','Atomic Wix title','Atomic Wix body','#atomic','',
   'article','ready'),
  ('67070000-0000-4000-8000-000000000033','67070000-0000-4000-8000-000000000001',
   '67070000-0000-4000-8000-000000000010','67070000-0000-4000-8000-000000000023',
   'wordpress','Atomic WordPress title','Atomic WordPress body','#atomic','',
   'article','ready');

update public.drafts d set approval_state='approved',approved_at=now(),
  approved_content_hash=public.agent_draft_hash(
    d.title,d.body,d.tags,d.media_url,d.content_kind,d.persona_id,d.account_id,
    d.platform,d.publish_at
  ),publish_state='not_queued'
where d.id in(
  '67070000-0000-4000-8000-000000000030',
  '67070000-0000-4000-8000-000000000031',
  '67070000-0000-4000-8000-000000000032',
  '67070000-0000-4000-8000-000000000033'
);
update public.drafts d set approved_preview_version='platform-preview-v1',
  approved_preview_target_id=case d.id
    when '67070000-0000-4000-8000-000000000030' then 'UC1234567890123456789012'
    when '67070000-0000-4000-8000-000000000031' then 'atomic-open-id'
    when '67070000-0000-4000-8000-000000000032' then 'wix:site-atomic:author-atomic'
    else 'wpcom:6707:author-6707' end,
  approved_preview_hash=public.agent_draft_preview_hash(
    d.approved_content_hash,'platform-preview-v1',case d.id
      when '67070000-0000-4000-8000-000000000030' then 'UC1234567890123456789012'
      when '67070000-0000-4000-8000-000000000031' then 'atomic-open-id'
      when '67070000-0000-4000-8000-000000000032' then 'wix:site-atomic:author-atomic'
      else 'wpcom:6707:author-6707' end
  ),approved_previewed_at=now()
where d.id in(
  '67070000-0000-4000-8000-000000000030',
  '67070000-0000-4000-8000-000000000031',
  '67070000-0000-4000-8000-000000000032',
  '67070000-0000-4000-8000-000000000033'
);
set constraints all immediate;

insert into public.youtube_upload_approvals(
  draft_id,owner,ledger_id,channel_id,video_asset_id,video_sha256,
  video_byte_size,video_mime,title,description,made_for_kids,
  contains_synthetic_media,privacy_status,category_id,preview_version,
  draft_content_hash,approval_hash,preview_hash,approved_by
)
select d.id,d.owner,d.account_id,'UC1234567890123456789012',
  (select value_uuid from pg_temp.atomic_runtime where label='video_asset'),
  repeat('a',64),1024,'video/mp4',d.title,d.body,false,true,'private','22',
  'youtube-preview-v1',d.approved_content_hash,
  public.youtube_upload_approval_hash(
    d.approved_content_hash,'UC1234567890123456789012',
    (select value_uuid from pg_temp.atomic_runtime where label='video_asset'),
    repeat('a',64),1024,'video/mp4',d.title,d.body,'22',false,true,
    'private','youtube-preview-v1'
  ),
  public.youtube_upload_approval_hash(
    d.approved_content_hash,'UC1234567890123456789012',
    (select value_uuid from pg_temp.atomic_runtime where label='video_asset'),
    repeat('a',64),1024,'video/mp4',d.title,d.body,'22',false,true,
    'private','youtube-preview-v1'
  ),d.owner
from public.drafts d where d.id='67070000-0000-4000-8000-000000000030';

insert into public.tiktok_draft_approvals(
  draft_id,owner,ledger_id,provider_open_id,approved_content_hash,
  preview_version,preview_hash,publish_mode,approved_media_sha256,
  approved_media_mime,approved_media_bytes,approved_media_url,approved_settings
)
select d.id,d.owner,d.account_id,'atomic-open-id',d.approved_content_hash,
  'tiktok-platform-preview-v1',public.tiktok_preview_hash(
    d.approved_content_hash,'tiktok-platform-preview-v1',d.account_id,
    'atomic-open-id','upload_inbox',repeat('a',64),'video/mp4',1024,d.media_url,
    '{"explicit_upload_consent":true,"completion_required_in_tiktok":true,"caption_not_transferred_acknowledged":true,"video_duration_seconds":15}'::jsonb
  ),'upload_inbox',repeat('a',64),'video/mp4',1024,d.media_url,
  '{"explicit_upload_consent":true,"completion_required_in_tiktok":true,"caption_not_transferred_acknowledged":true,"video_duration_seconds":15}'::jsonb
from public.drafts d where d.id='67070000-0000-4000-8000-000000000031';

insert into pg_temp.atomic_runtime(label,value_text)
select 'wix_fingerprint',public.cms_draft_request_fingerprint(
  'wix','wix_app_instance',d.approved_content_hash,'wix:site-atomic:author-atomic'
) from public.drafts d where d.id='67070000-0000-4000-8000-000000000032';
insert into pg_temp.atomic_runtime(label,value_text)
select 'wordpress_fingerprint',public.cms_draft_request_fingerprint(
  'wordpress','wordpress_com_oauth',d.approved_content_hash,'wpcom:6707:author-6707'
) from public.drafts d where d.id='67070000-0000-4000-8000-000000000033';

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $$
declare r jsonb;v_fingerprint text;
begin
  r:=public.prepare_provider_action_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000030',
    '67070000-0000-4000-8000-000000000020','youtube','youtube.publish_private',
    'UC1234567890123456789012',
    (select approved_content_hash from public.drafts where id='67070000-0000-4000-8000-000000000030'),
    (select approval_hash from public.youtube_upload_approvals where draft_id='67070000-0000-4000-8000-000000000030'),
    'youtube-action-preview-v1','{"items":[{"provider":"youtube"}]}'::jsonb
  );
  insert into pg_temp.atomic_runtime values('youtube_receipt',r->>'receiptHash',(r->>'receiptId')::uuid);

  r:=public.prepare_provider_action_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000031',
    '67070000-0000-4000-8000-000000000021','tiktok','tiktok.upload_inbox',
    'atomic-open-id',
    (select approved_content_hash from public.drafts where id='67070000-0000-4000-8000-000000000031'),
    (select preview_hash from public.tiktok_draft_approvals where draft_id='67070000-0000-4000-8000-000000000031'),
    'tiktok-action-preview-v1','{"items":[{"provider":"tiktok"}]}'::jsonb
  );
  insert into pg_temp.atomic_runtime values('tiktok_receipt',r->>'receiptHash',(r->>'receiptId')::uuid);

  select value_text into v_fingerprint from pg_temp.atomic_runtime where label='wix_fingerprint';
  r:=public.prepare_provider_action_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000032',
    '67070000-0000-4000-8000-000000000022','wix','wix.create_draft',
    'wix:site-atomic:author-atomic',
    (select approved_content_hash from public.drafts where id='67070000-0000-4000-8000-000000000032'),
    v_fingerprint,'cms-provider-draft-preview-v1','{"items":[{"provider":"wix"}]}'::jsonb
  );
  insert into pg_temp.atomic_runtime values('wix_receipt',r->>'receiptHash',(r->>'receiptId')::uuid);

  select value_text into v_fingerprint from pg_temp.atomic_runtime where label='wordpress_fingerprint';
  r:=public.prepare_provider_action_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000033',
    '67070000-0000-4000-8000-000000000023','wordpress','wordpress.create_draft',
    'wpcom:6707:author-6707',
    (select approved_content_hash from public.drafts where id='67070000-0000-4000-8000-000000000033'),
    v_fingerprint,'cms-provider-draft-preview-v1','{"items":[{"provider":"wordpress"}]}'::jsonb
  );
  insert into pg_temp.atomic_runtime values('wordpress_receipt',r->>'receiptHash',(r->>'receiptId')::uuid);
  insert into public.cms_draft_attempts(
    id,owner,draft_id,ledger_id,provider,provider_mode,exact_target_id,
    request_fingerprint,status
  ) values(
    '67070000-0000-4000-8000-000000000090',
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000033',
    '67070000-0000-4000-8000-000000000023','wordpress','wordpress_com_oauth',
    'wpcom:6707:author-6707',v_fingerprint,'claimed'
  );
end
$$;

do $$
declare failed boolean:=false;
begin
  begin perform public.claim_youtube_upload_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000030',
    (select value_uuid from pg_temp.atomic_runtime where label='youtube_receipt'));
  exception when others then failed:=true; end;
  perform pg_temp.assert_true(failed,'unacknowledged YouTube direct claim fails closed');
  failed:=false;
  begin perform public.claim_tiktok_publish_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000031',
    (select value_uuid from pg_temp.atomic_runtime where label='tiktok_receipt'));
  exception when others then failed:=true; end;
  perform pg_temp.assert_true(failed,'unacknowledged TikTok direct claim fails closed');
  failed:=false;
  begin perform public.claim_cms_draft_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000032',
    'wix',(select value_uuid from pg_temp.atomic_runtime where label='wix_receipt'));
  exception when others then failed:=true; end;
  perform pg_temp.assert_true(failed,'unacknowledged Wix direct claim fails closed');
  perform pg_temp.assert_true(not exists(
    select 1 from public.provider_action_preview_receipts where consumed_at is not null
      and id in(select value_uuid from pg_temp.atomic_runtime where label like '%_receipt')
  ),'failed unacknowledged calls consume no receipt and create no provider claim');
end
$$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','67070000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"67070000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select public.acknowledge_provider_action_preview(
  value_uuid,value_text,
  case label
    when 'youtube_receipt' then 'youtube-action-preview-v1'
    when 'tiktok_receipt' then 'tiktok-action-preview-v1'
    else 'cms-provider-draft-preview-v1' end
)
from pg_temp.atomic_runtime where label like '%_receipt';

reset role;
create or replace function pg_temp.fail_atomic_wix_attempt()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.draft_id='67070000-0000-4000-8000-000000000032' then
    raise exception 'simulated process crash after receipt consumption';
  end if;
  return new;
end
$$;
create trigger fail_atomic_wix_attempt before insert on public.cms_draft_attempts
for each row execute function pg_temp.fail_atomic_wix_attempt();

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $$
declare payload jsonb;failed boolean:=false;attempt public.cms_draft_attempts%rowtype;
begin
  payload:=public.claim_youtube_upload_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000030',
    (select value_uuid from pg_temp.atomic_runtime where label='youtube_receipt'));
  perform pg_temp.assert_true(payload#>>'{draft,publish_state}'='publishing'
    and (payload->>'claimId')::uuid='67070000-0000-4000-8000-000000000030',
    'YouTube receipt consumption and durable draft claim complete atomically');
  perform pg_temp.assert_true(exists(
    select 1 from public.provider_action_preview_receipts receipt
    where receipt.id=(select value_uuid from pg_temp.atomic_runtime where label='youtube_receipt')
      and receipt.consumed_at is not null
      and receipt.consumed_claim_id=(payload->>'claimId')::uuid
      and receipt.consumed_claim_id=receipt.draft_id
      and receipt.consumed_claim_kind='youtube_upload'
  ),'YouTube receipt is bound to its exact durable claim id');
  begin perform public.claim_youtube_upload_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000030',
    (select value_uuid from pg_temp.atomic_runtime where label='youtube_receipt'));
  exception when others then failed:=true; end;
  perform pg_temp.assert_true(failed,'YouTube receipt replay cannot create a second claim');

  payload:=public.claim_tiktok_publish_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000031',
    (select value_uuid from pg_temp.atomic_runtime where label='tiktok_receipt'));
  perform pg_temp.assert_true(payload#>>'{draft,publish_state}'='publishing'
    and (payload->>'claimId')::uuid='67070000-0000-4000-8000-000000000031'
    and exists(select 1 from public.provider_action_preview_receipts receipt
      where receipt.id=(select value_uuid from pg_temp.atomic_runtime where label='tiktok_receipt')
        and receipt.consumed_claim_id=(payload->>'claimId')::uuid
        and receipt.consumed_claim_id=receipt.draft_id
        and receipt.consumed_claim_kind='tiktok_publish'),
    'TikTok receipt is consumed and bound to the atomic durable claim');
  failed:=false;
  begin perform public.claim_tiktok_publish_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000031',
    (select value_uuid from pg_temp.atomic_runtime where label='tiktok_receipt'));
  exception when others then failed:=true; end;
  perform pg_temp.assert_true(failed,'TikTok receipt replay cannot create a second claim');

  failed:=false;
  begin perform public.claim_cms_draft_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000032',
    'wix',(select value_uuid from pg_temp.atomic_runtime where label='wix_receipt'));
  exception when others then failed:=true; end;
  perform pg_temp.assert_true(failed
    and not exists(select 1 from public.cms_draft_attempts
      where draft_id='67070000-0000-4000-8000-000000000032')
    and exists(select 1 from public.provider_action_preview_receipts
      where id=(select value_uuid from pg_temp.atomic_runtime where label='wix_receipt')
        and consumed_at is null and consumed_claim_id is null),
    'simulated crash rolls receipt consumption and CMS attempt insert back together');

  failed:=false;
  begin perform public.claim_cms_draft_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000033',
    'wordpress',(select value_uuid from pg_temp.atomic_runtime where label='wordpress_receipt'));
  exception when others then failed:=true; end;
  perform pg_temp.assert_true(failed and exists(
    select 1 from public.provider_action_preview_receipts
    where id=(select value_uuid from pg_temp.atomic_runtime where label='wordpress_receipt')
      and consumed_at is null and consumed_claim_id is null
  ),'a conflicting durable WordPress attempt rejects the wrapper without consuming its receipt');
end
$$;

reset role;
drop trigger fail_atomic_wix_attempt on public.cms_draft_attempts;
delete from public.cms_draft_attempts
where id='67070000-0000-4000-8000-000000000090';
update public.drafts set body='Content drift after acknowledgement'
where id='67070000-0000-4000-8000-000000000033';

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare attempt public.cms_draft_attempts%rowtype;failed boolean:=false;
begin
  select * into attempt from public.claim_cms_draft_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000032',
    'wix',(select value_uuid from pg_temp.atomic_runtime where label='wix_receipt'));
  perform pg_temp.assert_true(attempt.status='claimed' and exists(
    select 1 from public.provider_action_preview_receipts receipt
    where receipt.id=(select value_uuid from pg_temp.atomic_runtime where label='wix_receipt')
      and receipt.consumed_claim_id=attempt.id
      and receipt.consumed_claim_kind='cms_draft'
  ),'the same crash-safe Wix receipt later binds to the inserted durable attempt');
  begin perform public.claim_cms_draft_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000032',
    'wix',(select value_uuid from pg_temp.atomic_runtime where label='wix_receipt'));
  exception when others then failed:=true; end;
  perform pg_temp.assert_true(failed,'Wix attempt and receipt cannot be replayed');

  failed:=false;
  begin perform public.claim_cms_draft_with_preview_service(
    '67070000-0000-4000-8000-000000000001','67070000-0000-4000-8000-000000000033',
    'wordpress',(select value_uuid from pg_temp.atomic_runtime where label='wordpress_receipt'));
  exception when others then failed:=true; end;
  perform pg_temp.assert_true(failed and exists(
    select 1 from public.provider_action_preview_receipts
    where id=(select value_uuid from pg_temp.atomic_runtime where label='wordpress_receipt')
      and consumed_at is null and invalidated_at is not null
  ),'content drift invalidates the WordPress receipt without a provider attempt');
end
$$;

rollback;
