\set ON_ERROR_STOP on
\pset pager off

-- PostgreSQL 17 behavioral probe for migration 075. Run only after the
-- reviewed-business publication migrations and 075 in a disposable database.
-- Every fixture and assertion is rolled back.
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
  '07500000-0000-4000-8000-000000000001','business-075@example.test',now()
);
insert into public.profiles(id,email,display_name) values(
  '07500000-0000-4000-8000-000000000001',
  'business-075@example.test','075 business runtime'
) on conflict(id) do update set
  email=excluded.email,display_name=excluded.display_name;

insert into public.businesses(
  id,owner,slug,display_name,short_bio,mission
) values
(
  '07500000-0000-4000-8000-000000000010',
  '07500000-0000-4000-8000-000000000001',
  'business-preview-075','Business Preview 075',
  'A complete short biography for the publish test.',
  'A complete mission statement for an exact public-page preview.'
),
(
  '07500000-0000-4000-8000-000000000011',
  '07500000-0000-4000-8000-000000000001',
  'business-drift-075','Business Drift 075',
  'A complete short biography for the drift test.',
  'A complete mission statement that will change after preview.'
);

create temporary table runtime_075_previews(
  label text primary key,
  preview_id uuid not null,
  preview_version text not null,
  preview_hash text not null,
  preview_revision integer not null,
  preview_target_id text not null,
  manifest_sha256 text not null,
  preview_payload jsonb not null
) on commit drop;
grant select,insert,update on pg_temp.runtime_075_previews to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','07500000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"07500000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"runtime-075-session"}',true);

select pg_temp.assert_true(
  (public.submit_business_for_review(
    '07500000-0000-4000-8000-000000000010',
    'Publish the exact owner-reviewed public business page.',
    'Runtime proof for preview acknowledgement and one-shot publication.'
  )->>'required_missing')::integer=0,
  'the complete first business revision reaches ready review state'
);

with prepared as (
  select public.prepare_native_business_page_publish_preview(
    '07500000-0000-4000-8000-000000000010'
  ) as receipt
)
insert into pg_temp.runtime_075_previews(
  label,preview_id,preview_version,preview_hash,preview_revision,
  preview_target_id,manifest_sha256,preview_payload
)
select
  'publish',(receipt->>'preview_id')::uuid,receipt->>'preview_version',
  receipt->>'preview_hash',(receipt->>'preview_revision')::integer,
  receipt->>'preview_target_id',receipt->>'manifest_sha256',
  receipt->'preview_payload'
from prepared;

select pg_temp.assert_true(
  exists(
    select 1 from pg_temp.runtime_075_previews preview
    where preview.label='publish'
      and preview.preview_version='native-business-page-preview-v1'
      and preview.preview_hash~'^[0-9a-f]{64}$'
      and preview.manifest_sha256~'^[0-9a-f]{64}$'
      and preview.preview_target_id=
        'aliaspaces:business:07500000-0000-4000-8000-000000000010'
      and preview.preview_payload#>>'{target,public_route}'=
        '#/b/business-preview-075'
      and preview.preview_payload#>>'{target,page_status}'='published'
      and preview.preview_payload#>>'{target,visibility}'='public'
      and preview.preview_payload#>>'{action,type}'='publish_business_page'
      and preview.preview_payload#>>'{action,timing}'=
        'immediately_after_approval'
      and (preview.preview_payload#>>'{action,automated}')::boolean is false
  ),
  'the server-authored preview binds exact public route, revision, manifest, action, and timing'
);
select pg_temp.assert_true(
  (select page_status='draft' and visibility='owner_only'
   from public.businesses
   where id='07500000-0000-4000-8000-000000000010'),
  'preparing the exact preview does not publish or change visibility'
);

select set_config('request.jwt.claims',
  '{"sub":"07500000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1","session_id":"runtime-075-session"}',true);
do $$
declare v_failed boolean:=false;
begin
  begin
    perform public.acknowledge_native_business_page_publish_preview(
      '07500000-0000-4000-8000-000000000010',preview.preview_id,
      preview.preview_version,preview.preview_hash,preview.preview_revision,
      preview.preview_target_id
    ) from pg_temp.runtime_075_previews preview where preview.label='publish';
  exception when insufficient_privilege then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'AAL1 cannot acknowledge an exact native business-page preview');
end
$$;

select set_config('request.jwt.claims',
  '{"sub":"07500000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"runtime-075-session"}',true);
select pg_temp.assert_true(
  (select (public.acknowledge_native_business_page_publish_preview(
    '07500000-0000-4000-8000-000000000010',preview.preview_id,
    preview.preview_version,preview.preview_hash,preview.preview_revision,
    preview.preview_target_id
  )->>'acknowledged_at') is not null
  from pg_temp.runtime_075_previews preview where preview.label='publish'),
  'AAL2 records a separate acknowledgement of the exact preview'
);

select pg_temp.assert_true(
  (select
    result->>'page_status'='published'
      and (result->>'publication_current')::boolean
      and (result->>'preview_evidence_id')::uuid=preview.preview_id
      and result->>'preview_hash'=preview.preview_hash
      and result->>'preview_target_id'=preview.preview_target_id
   from pg_temp.runtime_075_previews preview
   cross join lateral public.approve_and_publish_previewed_business_page(
     '07500000-0000-4000-8000-000000000010',preview.preview_id,
     preview.preview_version,preview.preview_hash,preview.preview_revision,
     preview.preview_target_id
   ) result
   where preview.label='publish'),
  'acknowledgement consumption and exact-current publication complete atomically'
);
select pg_temp.assert_true(
  exists(
    select 1 from public.business_page_publish_preview_evidence evidence
    join pg_temp.runtime_075_previews preview on preview.preview_id=evidence.id
    where preview.label='publish' and evidence.acknowledged_at is not null
      and evidence.consumed_at is not null
      and evidence.published_revision=preview.preview_revision
      and evidence.published_at is not null
      and (evidence.publish_result->>'publication_current')::boolean
  ),
  'the durable evidence records acknowledgement, one-shot consumption, and current publication'
);

do $$
declare v_failed boolean:=false;
begin
  begin
    perform public.approve_and_publish_previewed_business_page(
      '07500000-0000-4000-8000-000000000010',preview.preview_id,
      preview.preview_version,preview.preview_hash,preview.preview_revision,
      preview.preview_target_id
    ) from pg_temp.runtime_075_previews preview where preview.label='publish';
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'a consumed native business-page preview cannot publish twice');
end
$$;

select pg_temp.assert_true(
  (public.submit_business_for_review(
    '07500000-0000-4000-8000-000000000011',
    'Review the second exact business page before changing it.',
    'Runtime proof that post-preview drift fails closed.'
  )->>'required_missing')::integer=0,
  'the complete second business revision reaches ready review state'
);

with prepared as (
  select public.prepare_native_business_page_publish_preview(
    '07500000-0000-4000-8000-000000000011'
  ) as receipt
)
insert into pg_temp.runtime_075_previews(
  label,preview_id,preview_version,preview_hash,preview_revision,
  preview_target_id,manifest_sha256,preview_payload
)
select
  'drift',(receipt->>'preview_id')::uuid,receipt->>'preview_version',
  receipt->>'preview_hash',(receipt->>'preview_revision')::integer,
  receipt->>'preview_target_id',receipt->>'manifest_sha256',
  receipt->'preview_payload'
from prepared;

select public.save_business_draft(
  '07500000-0000-4000-8000-000000000011',
  'business-drift-075','Business Drift 075',
  'The short biography changed after the exact preview.',
  'A complete mission statement that will change after preview.'
);

select pg_temp.assert_true(
  exists(
    select 1 from public.business_page_publish_preview_evidence evidence
    join pg_temp.runtime_075_previews preview on preview.preview_id=evidence.id
    where preview.label='drift' and evidence.invalidated_at is not null
      and evidence.invalidation_reason in(
        'business_revision_changed','business_publication_review_changed'
      )
      and evidence.acknowledged_at is null and evidence.consumed_at is null
  ),
  'editing the business revision automatically invalidates its outstanding preview'
);

do $$
declare v_failed boolean:=false;
begin
  begin
    perform public.acknowledge_native_business_page_publish_preview(
      '07500000-0000-4000-8000-000000000011',preview.preview_id,
      preview.preview_version,preview.preview_hash,preview.preview_revision,
      preview.preview_target_id
    ) from pg_temp.runtime_075_previews preview where preview.label='drift';
  exception when others then v_failed:=true;
  end;
  perform pg_temp.assert_true(v_failed,
    'revision drift cannot be acknowledged without a fresh exact preview');
end
$$;

select pg_temp.assert_true(
  not has_function_privilege('authenticated',
    'public.publish_business_page(uuid)','execute'),
  'browser callers cannot bypass preview evidence through the legacy publisher'
);
select pg_temp.assert_true(
  not has_table_privilege('authenticated',
    'public.business_page_publish_preview_evidence','insert')
    and not has_table_privilege('authenticated',
      'public.business_page_publish_preview_evidence','update')
    and not has_table_privilege('authenticated',
      'public.business_page_publish_preview_evidence','delete'),
  'browser callers cannot forge, alter, or erase preview evidence'
);

rollback;
