\set ON_ERROR_STOP on

-- Prove that migration 069 can be defined before billing migration 068, then
-- begins surfacing safe aggregates once the private alert table exists.
create table private.billing_reconciliation_alerts(
  id bigint generated always as identity primary key,
  account_id uuid,
  alert_type text not null,
  severity text not null check(severity in('warning','high','critical')),
  object_id text not null default '',
  detail text not null default '',
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table private.billing_reconciliation_alerts enable row level security;
revoke all on private.billing_reconciliation_alerts from public,anon,
  authenticated,service_role;

insert into public.profiles(id) values
  ('06900000-0000-4000-8000-000000000001'),
  ('06900000-0000-4000-8000-000000000002'),
  ('06900000-0000-4000-8000-000000000003'),
  ('06900000-0000-4000-8000-000000000004');
insert into public.platform_role_assignments(account_id,role_key) values
  ('06900000-0000-4000-8000-000000000001','global_administrator'),
  ('06900000-0000-4000-8000-000000000002','technician'),
  ('06900000-0000-4000-8000-000000000004','global_administrator');

insert into public.platform_security_events(
  event_type,severity,source,subject_type,subject_id,identifier_hash,metadata,created_at
) values
  ('owner@example.invalid','critical','application','account','private-subject',
    repeat('a',64),'{"credential":"sk_live_SECURITY_CANARY"}'::jsonb,now()-interval '5 minutes'),
  ('operations_maintenance_failed','high','edge_function','operations','retention','',
    '{"failed_tasks":["billing_retention"]}'::jsonb,now()-interval '10 minutes'),
  ('operations_maintenance_completed','info','edge_function','operations','retention','',
    '{"deleted_count":0}'::jsonb,now()-interval '40 hours');
insert into public.account_security_states(user_id,notification_pending,updated_at)
values('06900000-0000-4000-8000-000000000003',true,now()-interval '4 minutes');
insert into public.product_review_notifications(
  status,available_at,claimed_at,last_error_code,created_at,updated_at
) values
  ('queued',now()-interval '40 minutes',null,'owner@example.invalid',now()-interval '40 minutes',now()-interval '40 minutes'),
  ('claimed',now()-interval '50 minutes',now()-interval '30 minutes','sk_live_REVIEW_CANARY',now()-interval '50 minutes',now()-interval '30 minutes'),
  ('failed',now()-interval '20 minutes',null,'provider-secret-canary',now()-interval '20 minutes',now()-interval '15 minutes'),
  ('reconciliation_required',now()-interval '20 minutes',null,'stripe-object-canary',now()-interval '20 minutes',now()-interval '12 minutes');
insert into public.error_logs(user_id,message,context,severity,created_at)
select '06900000-0000-4000-8000-000000000003',
  'owner@example.invalid sk_live_ERROR_CANARY',
  '{"url":"https://private.invalid/token"}'::jsonb,
  case when item=1 then 'critical' else 'error' end,
  now()-make_interval(mins=>item)
from generate_series(1,5) item;
insert into private.billing_reconciliation_alerts(
  account_id,alert_type,severity,object_id,detail,created_at
) values
  ('06900000-0000-4000-8000-000000000003','duplicate_subscription_refund_review','high',
    'sub_SECRET_PROVIDER_CANARY','owner@example.invalid sk_live_BILLING_CANARY',now()-interval '8 minutes'),
  ('06900000-0000-4000-8000-000000000003','event_id_payload_conflict','critical',
    'evt_SECRET_PROVIDER_CANARY','payload digest conflict private detail',now()-interval '7 minutes');

select set_config('request.jwt.claim.sub','06900000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"aal":"aal2"}',false);
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;

do $$
declare
  alert record;
  payload text;
  saw_billing boolean:=false;
  saw_security boolean:=false;
  saw_pending boolean:=false;
  saw_review boolean:=false;
  saw_errors boolean:=false;
  saw_stale boolean:=false;
  before_notifications bigint;
  after_notifications bigint;
  first_alert record;
  second_alert record;
  invalid_cursor boolean:=false;
begin
  select count(*) into before_notifications
  from public.staff_operational_alerts(null,null,200)
  where source='review_intake';
  for alert in select * from public.staff_operational_alerts(null,null,200) loop
    payload:=row_to_json(alert)::text;
    if payload ~* 'owner@example|sk_live|provider_canary|private-subject|payload digest' then
      raise exception 'Operational output leaked a seeded canary: %',payload;
    end if;
    if alert.alert_key !~ '^[a-z0-9:_-]+$' then
      raise exception 'Alert key was not from the safe alphabet: %',alert.alert_key;
    end if;
    saw_billing:=saw_billing or alert.source='billing';
    saw_security:=saw_security or alert.category='platform_security_event';
    saw_pending:=saw_pending or alert.category='account_security_notification';
    saw_review:=saw_review or alert.source='review_intake';
    saw_errors:=saw_errors or alert.category='client_error_volume';
    saw_stale:=saw_stale or alert.category='retention_heartbeat_stale';
    if alert.source='billing' and not alert.requires_global_admin then
      raise exception 'Billing row was not marked global-admin-only';
    end if;
  end loop;
  if not (saw_billing and saw_security and saw_pending and saw_review
      and saw_errors and saw_stale) then
    raise exception 'Global admin did not receive every safe aggregate';
  end if;

  select count(*) into after_notifications
  from public.staff_operational_alerts(null,null,200)
  where source='review_intake';
  if after_notifications<>before_notifications then
    raise exception 'A read changed alert state';
  end if;

  select * into first_alert
  from public.staff_operational_alerts(null,null,1);
  select * into second_alert
  from public.staff_operational_alerts(
    first_alert.last_seen,first_alert.alert_key,1
  );
  if second_alert.alert_key is null or second_alert.alert_key=first_alert.alert_key then
    raise exception 'Keyset pagination duplicated or lost the next alert';
  end if;
  if (select count(*) from public.staff_operational_alerts(null,null,10000))>200 then
    raise exception 'Alert limit clamp exceeded 200';
  end if;
  begin perform public.staff_operational_alerts(now(),null,10);
  exception when invalid_parameter_value then invalid_cursor:=true;end;
  if not invalid_cursor then raise exception 'Partial alert cursor was accepted';end if;
end
$$;

-- Direct private/helper access remains denied even though the aggregate RPC is allowed.
do $$
declare denied boolean:=false;
begin
  begin perform public.operational_billing_alerts_service();
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Authenticated caller executed billing helper directly';end if;
  denied:=false;
  begin perform count(*) from private.billing_reconciliation_alerts;
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Authenticated caller read private billing alerts';end if;
end
$$;
reset role;

-- Technicians see nonfinancial aggregates but never billing aggregates.
select set_config('request.jwt.claim.sub','06900000-0000-4000-8000-000000000002',false);
set role authenticated;
do $$
begin
  if exists(select 1 from public.staff_operational_alerts(null,null,200)
      where source='billing' or requires_global_admin) then
    raise exception 'Technician received a restricted billing aggregate';
  end if;
  if not exists(select 1 from public.staff_operational_alerts(null,null,200)
      where source='security') then
    raise exception 'Technician did not receive permitted security aggregates';
  end if;
end
$$;
reset role;

-- An AAL2 ordinary account and an AAL1 global administrator both fail closed.
select set_config('request.jwt.claim.sub','06900000-0000-4000-8000-000000000003',false);
set role authenticated;
do $$ declare denied boolean:=false;begin
  begin perform public.staff_operational_alerts(null,null,100);
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Ordinary authenticated account read staff alerts';end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub','06900000-0000-4000-8000-000000000004',false);
select set_config('request.jwt.claims','{"aal":"aal1"}',false);
set role authenticated;
do $$ declare denied boolean:=false;begin
  begin perform public.staff_operational_alerts(null,null,100);
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'AAL1 global administrator read staff alerts';end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub','',false);
select set_config('request.jwt.claims','{"aal":"aal1"}',false);
set role anon;
do $$ declare denied boolean:=false;begin
  begin perform public.staff_operational_alerts(null,null,100);
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Anonymous account executed staff alert RPC';end if;
end $$;
reset role;

-- Successful current heartbeat removes only the synthesized stale condition.
insert into public.platform_security_events(
  event_type,severity,source,subject_type,subject_id,identifier_hash,metadata
) values('operations_maintenance_completed','info','edge_function','operations',
  'retention','','{"schema_version":1,"deleted_count":0}'::jsonb);
select set_config('request.jwt.claim.sub','06900000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"aal":"aal2"}',false);
set role authenticated;
do $$ begin
  if exists(select 1 from public.staff_operational_alerts(null,null,200)
      where category='retention_heartbeat_stale') then
    raise exception 'Fresh success heartbeat remained stale';
  end if;
end $$;
reset role;

-- Seed more expired rows than one requested batch and prove the hard ceiling.
insert into public.product_review_rate_limits(scope,key_hash,window_start,expires_at)
select 'fingerprint_day',encode(digest('product-'||item,'sha256'),'hex'),
  now()-interval '2 days'-make_interval(secs=>item),now()-interval '1 day'
from generate_series(1,3) item;
insert into public.affiliate_click_rate_limits(scope,key_hash,window_start,expires_at)
select 'global_day',encode(digest('affiliate-'||item,'sha256'),'hex'),
  now()-interval '2 days'-make_interval(secs=>item),now()-interval '1 day'
from generate_series(1,3) item;
insert into public.affiliate_click_events(created_at)
select now()-interval '401 days'-make_interval(secs=>item)
from generate_series(1,3) item;
insert into public.friend_request_security_events(created_at)
select now()-interval '91 days'-make_interval(secs=>item)
from generate_series(1,3) item;

select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
do $$
declare deleted integer;affiliate jsonb;governance jsonb;denied boolean:=false;
begin
  deleted:=public.prune_product_review_rate_limits_batch_service(2);
  if deleted<>2 then raise exception 'Product-review cleanup was not bounded: %',deleted;end if;
  affiliate:=public.purge_affiliate_click_retention_batch_service(2);
  if (affiliate->>'rate_rows_deleted')::integer<>2
     or (affiliate->>'event_rows_deleted')::integer<>2 then
    raise exception 'Affiliate cleanup was not independently bounded: %',affiliate;
  end if;
  governance:=public.purge_governance_security_retention_batch_service(2);
  if (governance->>'friend_request_events')::integer<>2 then
    raise exception 'Governance cleanup was not bounded: %',governance;
  end if;
end
$$;
reset role;

do $$ begin
  if (select count(*) from public.product_review_rate_limits)<>1 then
    raise exception 'Product-review batch deleted beyond its limit';end if;
  if (select count(*) from public.affiliate_click_rate_limits)<>1
     or (select count(*) from public.affiliate_click_events)<>1 then
    raise exception 'Affiliate batch deleted beyond its per-category limit';end if;
  if (select count(*) from public.friend_request_security_events)<>1 then
    raise exception 'Governance batch deleted beyond its limit';end if;
end $$;

select set_config('request.jwt.claim.sub','06900000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claims','{"aal":"aal2"}',false);
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
do $$ declare denied boolean:=false;begin
  begin perform public.prune_product_review_rate_limits_batch_service(1);
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Authenticated caller ran maintenance cleanup';end if;
end $$;
reset role;

select 'operational-alert-inbox-069-runtime-ok' as result;
