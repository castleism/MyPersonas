\set ON_ERROR_STOP on
\pset pager off

begin;

insert into auth.users(id,email,email_confirmed_at) values
  ('05100000-0000-4000-8000-000000000001','acl-owner-a@example.test',now()),
  ('05100000-0000-4000-8000-000000000002','acl-owner-b@example.test',now());

insert into public.personas(id,owner,handle,name) values
  ('05110000-0000-4000-8000-000000000001','05100000-0000-4000-8000-000000000001','aclownera','ACL Owner A'),
  ('05110000-0000-4000-8000-000000000002','05100000-0000-4000-8000-000000000002','aclownerb','ACL Owner B');

insert into public.persona_review_requests(id,owner,persona_id,product_name) values
  ('05120000-0000-4000-8000-000000000001','05100000-0000-4000-8000-000000000001','05110000-0000-4000-8000-000000000001','Anonymous denial fixture'),
  ('05120000-0000-4000-8000-000000000002','05100000-0000-4000-8000-000000000001','05110000-0000-4000-8000-000000000001','Cross-owner denial fixture');

insert into public.post_drafts(id,owner,persona_id,brief) values
  ('05130000-0000-4000-8000-000000000001','05100000-0000-4000-8000-000000000001','05110000-0000-4000-8000-000000000001','Anonymous denial fixture'),
  ('05130000-0000-4000-8000-000000000002','05100000-0000-4000-8000-000000000001','05110000-0000-4000-8000-000000000001','Cross-owner denial fixture');

do $$
declare
  v_owner_function regprocedure;
begin
  foreach v_owner_function in array array[
    'public.owner_review_request_queue()'::regprocedure,
    'public.link_review_request_to_draft(uuid,uuid)'::regprocedure,
    'public.update_review_request_status(uuid,text)'::regprocedure,
    'public.get_affiliate_analytics()'::regprocedure
  ] loop
    if has_function_privilege('anon',v_owner_function,'EXECUTE') then
      raise exception 'anon retained EXECUTE on %',v_owner_function;
    end if;
    if not has_function_privilege('authenticated',v_owner_function,'EXECUTE') then
      raise exception 'authenticated lacks EXECUTE on %',v_owner_function;
    end if;
    if has_function_privilege('service_role',v_owner_function,'EXECUTE') then
      raise exception 'service_role retained EXECUTE on %',v_owner_function;
    end if;
  end loop;

  if not has_function_privilege(
    'anon','public.get_public_persona_revenue_rails(text)'::regprocedure,'EXECUTE'
  ) then
    raise exception 'intentional anonymous public revenue resolver lost EXECUTE';
  end if;
end
$$;

set local role anon;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','anon',true);
select set_config('request.jwt.claims','{"role":"anon","aal":"aal1"}',true);
do $$
declare v_denied boolean:=false;
begin
  begin
    perform public.link_review_request_to_draft(
      '05120000-0000-4000-8000-000000000001',
      '05130000-0000-4000-8000-000000000001'
    );
  exception when insufficient_privilege then
    v_denied:=true;
  end;
  if not v_denied then
    raise exception 'anonymous review-to-draft link unexpectedly succeeded';
  end if;
end
$$;
reset role;

do $$
begin
  if exists(
    select 1 from public.persona_review_requests
    where id='05120000-0000-4000-8000-000000000001'
      and (post_draft_id is not null or status<>'new')
  ) or exists(
    select 1 from public.post_drafts
    where id='05130000-0000-4000-8000-000000000001'
      and review_request_id is not null
  ) then
    raise exception 'anonymous denial mutated request or draft';
  end if;
end
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub','05100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config(
  'request.jwt.claims',
  '{"sub":"05100000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',
  true
);
select public.link_review_request_to_draft(
  '05120000-0000-4000-8000-000000000001',
  '05130000-0000-4000-8000-000000000001'
);
reset role;

do $$
begin
  if not exists(
    select 1 from public.persona_review_requests
    where id='05120000-0000-4000-8000-000000000001'
      and post_draft_id='05130000-0000-4000-8000-000000000001'
      and status='drafted'
  ) or not exists(
    select 1 from public.post_drafts
    where id='05130000-0000-4000-8000-000000000001'
      and review_request_id='05120000-0000-4000-8000-000000000001'
  ) then
    raise exception 'authenticated owner link did not update both exact rows';
  end if;
end
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub','05100000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config(
  'request.jwt.claims',
  '{"sub":"05100000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',
  true
);
do $$
declare v_denied boolean:=false;
begin
  begin
    perform public.link_review_request_to_draft(
      '05120000-0000-4000-8000-000000000002',
      '05130000-0000-4000-8000-000000000002'
    );
  exception when insufficient_privilege then
    v_denied:=true;
  end;
  if not v_denied then
    raise exception 'cross-owner review-to-draft link unexpectedly succeeded';
  end if;
end
$$;
reset role;

do $$
begin
  if exists(
    select 1 from public.persona_review_requests
    where id='05120000-0000-4000-8000-000000000002'
      and (post_draft_id is not null or status<>'new')
  ) or exists(
    select 1 from public.post_drafts
    where id='05130000-0000-4000-8000-000000000002'
      and review_request_id is not null
  ) then
    raise exception 'cross-owner denial mutated request or draft';
  end if;
end
$$;

select 'PASS privilege matrix' as evidence;
select 'PASS anonymous denial with no mutation' as evidence;
select 'PASS authenticated owner exact two-row link' as evidence;
select 'PASS cross-owner denial with no mutation' as evidence;

rollback;

select case when count(*)=0 then 'PASS fixtures rolled back'
  else 'FAIL fixtures remain' end as evidence
from auth.users
where id in(
  '05100000-0000-4000-8000-000000000001',
  '05100000-0000-4000-8000-000000000002'
);
