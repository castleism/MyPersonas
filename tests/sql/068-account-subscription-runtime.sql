\set ON_ERROR_STOP on

do $$
declare
  v_owner uuid:='10000000-0000-4000-8000-000000000001';
  v_admin uuid:='10000000-0000-4000-8000-000000000002';
  v_other uuid:='10000000-0000-4000-8000-000000000003';
  v_rotation uuid:='11000000-0000-4000-8000-000000000001';
  v_delete uuid:='11000000-0000-4000-8000-000000000002';
  v_rotation_other uuid:='11000000-0000-4000-8000-000000000003';
  v_rotation_contender uuid:='11000000-0000-4000-8000-000000000004';
  v_state text;
  v_allowed boolean;
  v_checkout jsonb;
  v_checkout2 jsonb;
  v_duplicate boolean;
  v_attempt_count integer;
  v_processing_state text;
  v_error text;
  v_trial_eligible boolean;
  v_advance_batch integer;
  v_advance_passes integer:=0;
  v_advance_total integer:=0;
  v_function_def text;
  v_account_lock_pos integer;
  v_entitlement_recheck_pos integer;
  v_task_lock_pos integer;
  v_hold_id uuid;
  v_hold_account_lock_pos integer;
  v_hold_row_lock_pos integer;
  v_remediation_id uuid;
  v_refund_state text;
  v_refund_candidate jsonb;
begin
  insert into auth.users(id,email,email_confirmed_at) values
    (v_owner,'Owner@Example.com',now()),
    (v_admin,'admin@example.com',now()),
    (v_other,'other@example.com',now()),
    (v_rotation,'rotation@example.com',now()),
    (v_delete,'delete@example.com',now()),
    (v_rotation_other,'rotation-other@example.com',now()),
    (v_rotation_contender,'rotation-contender@example.com',now())
  on conflict do nothing;
  insert into public.profiles(id,email,display_name) values
    (v_owner,'Owner@Example.com','Owner'),
    (v_admin,'admin@example.com','Admin'),
    (v_other,'other@example.com','Other'),
    (v_rotation,'rotation@example.com','Rotation'),
    (v_delete,'delete@example.com','Delete'),
    (v_rotation_other,'rotation-other@example.com','Rotation Other'),
    (v_rotation_contender,'rotation-contender@example.com','Rotation Contender')
  on conflict do nothing;
  insert into public.platform_role_assignments(account_id,role_key)
  values(v_admin,'global_administrator') on conflict do nothing;

  select lower(pg_get_functiondef(
    'private.advance_suspended_ai_generation_tasks(timestamptz,integer)'::regprocedure
  )) into v_function_def;
  v_account_lock_pos:=strpos(v_function_def,'pg_advisory_xact_lock');
  v_entitlement_recheck_pos:=strpos(
    v_function_def,'if public.account_has_billing_access(v_account_id) then'
  );
  v_task_lock_pos:=strpos(v_function_def,'for update skip locked');
  if strpos(v_function_def,'order by task.owner')=0
    or v_account_lock_pos=0 or v_entitlement_recheck_pos=0 or v_task_lock_pos=0
    or not (
      v_account_lock_pos<v_entitlement_recheck_pos
      and v_entitlement_recheck_pos<v_task_lock_pos
    ) then
    raise exception
      'Suspended advancement does not preserve deterministic account-lock, entitlement-recheck, task-lock order';
  end if;
  select lower(pg_get_functiondef(
    'public.billing_admin_reconcile_financial_hold(uuid,text)'::regprocedure
  )) into v_function_def;
  v_hold_account_lock_pos:=strpos(v_function_def,'pg_advisory_xact_lock');
  v_hold_row_lock_pos:=strpos(v_function_def,'for update');
  if v_hold_account_lock_pos=0 or v_hold_row_lock_pos=0
    or v_hold_account_lock_pos>=v_hold_row_lock_pos then
    raise exception 'Financial hold reconciliation locks a child row before its account';
  end if;

  select snapshot.state,snapshot.access_allowed,snapshot.trial_eligible
  into v_state,v_allowed,v_trial_eligible
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'preview_access' or not v_allowed then
    raise exception 'Shadow mode did not preserve access: %, %',v_state,v_allowed;
  end if;
  if v_trial_eligible is not null then
    raise exception 'Self status promised trial eligibility without a current email fingerprint';
  end if;

  if not exists(
    select 1 from private.billing_plan_catalog
    where plan_code='account_weekly' and amount_minor=2000
      and currency='usd' and recurring_interval='week'
  ) or not exists(
    select 1 from private.billing_plan_catalog
    where plan_code='account_monthly' and amount_minor=5000
      and currency='usd' and recurring_interval='month'
  ) or not exists(
    select 1 from private.billing_plan_catalog
    where plan_code='account_yearly' and amount_minor=33300
      and currency='usd' and recurring_interval='year'
  ) then raise exception 'Exact plan catalog mismatch'; end if;

  begin
    delete from private.billing_runtime_config where singleton;
    raise exception 'Runtime configuration singleton was deletable';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Runtime configuration singleton was deletable' then raise; end if;
    if v_error<>'BILLING_RUNTIME_CONFIG_SINGLETON_REQUIRED' then raise; end if;
  end;
  if not exists(select 1 from private.billing_runtime_config where singleton) then
    raise exception 'Protected runtime configuration singleton disappeared';
  end if;
  begin
    truncate table private.billing_runtime_config;
    raise exception 'Runtime configuration singleton was truncatable';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Runtime configuration singleton was truncatable' then raise; end if;
    if v_error<>'BILLING_RUNTIME_CONFIG_SINGLETON_REQUIRED' then raise; end if;
  end;

  update private.billing_runtime_config
  set enforcement_enabled=true,updated_by=v_admin,updated_at=now()
  where singleton;
  if public.account_has_billing_access(v_owner) then
    raise exception 'Unsubscribed account retained access after enforcement';
  end if;

  insert into public.ai_tasks(
    id,owner,cadence,schedule_time,timezone,lead_minutes,next_run_at,next_publish_at
  ) values(
    '30000000-0000-4000-8000-000000000100',v_owner,'daily','09:00','UTC',60,
    now()-interval '2 hours',now()-interval '1 hour'
  );
  insert into public.post_drafts(id,owner,status,scheduled_for) values
    ('31000000-0000-4000-8000-000000000100',v_owner,'scheduled',now()-interval '1 hour'),
    ('31000000-0000-4000-8000-000000000101',v_owner,'scheduled',now()+interval '2 hours');
  insert into public.drafts(
    id,owner,status,approval_state,publish_state,publish_at,publish_next_attempt_at
  ) values
    ('32000000-0000-4000-8000-000000000100',v_owner,'ready','approved','queued',
      now()-interval '1 hour',now()-interval '1 hour'),
    ('32000000-0000-4000-8000-000000000101',v_owner,'ready','approved','queued',
      now()+interval '2 hours',now()+interval '2 hours');

  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims','{"aal":"aal2"}',true);
  perform public.billing_admin_grant_developer(
    v_owner,'Approved development account for local entitlement testing.',now()+interval '30 days'
  );
  select snapshot.state,snapshot.access_allowed into v_state,v_allowed
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'developer_active' or not v_allowed then
    raise exception 'Developer grant did not activate access: %, %',v_state,v_allowed;
  end if;
  if not exists(
    select 1 from private.billing_developer_grant_events
    where account_id=v_owner and action='granted'
  ) then raise exception 'Developer grant audit event missing'; end if;
  if not exists(
    select 1 from public.ai_tasks task
    where task.id='30000000-0000-4000-8000-000000000100'
      and task.last_status='paused_billing' and task.next_run_at>now()
  ) then raise exception 'Developer restoration did not skip an overdue AI occurrence'; end if;
  if not exists(
    select 1 from public.post_drafts draft
    where draft.id='31000000-0000-4000-8000-000000000100'
      and draft.status='failed'
      and draft.last_error like 'Billing membership was inactive%'
  ) then raise exception 'Developer restoration did not terminalize a due scheduled post'; end if;
  if not exists(
    select 1 from public.drafts draft
    where draft.id='32000000-0000-4000-8000-000000000100'
      and draft.publish_state='blocked' and draft.publish_next_attempt_at is null
      and draft.publish_error like 'Billing membership was inactive%'
  ) then raise exception 'Developer restoration did not terminalize a due queued draft'; end if;
  if not exists(
    select 1 from public.post_drafts draft
    where draft.id='31000000-0000-4000-8000-000000000101'
      and draft.status='scheduled'
  ) or not exists(
    select 1 from public.drafts draft
    where draft.id='32000000-0000-4000-8000-000000000101'
      and draft.publish_state='queued' and draft.publish_next_attempt_at>now()
  ) then raise exception 'Developer restoration terminalized future publishing work'; end if;

  perform public.billing_admin_revoke_developer(
    v_owner,'Development exemption ended during local entitlement testing.'
  );
  if public.account_has_billing_access(v_owner) then
    raise exception 'Revoked developer account retained access';
  end if;

  insert into private.billing_checkout_reservations(
    request_key,lease_token,lease_expires_at,account_id,plan_code,
    trial_eligible,status,expires_at,created_at,updated_at
  ) values(
    '20000000-0000-4000-8000-000000000020',
    '20000000-0000-4000-8000-000000000020',now()-interval '25 hours',
    v_other,'account_weekly',false,'provider_pending',now()-interval '1 day',
    now()-interval '2 days',now()-interval '2 days'
  );
  begin
    perform public.billing_admin_grant_developer(
      v_other,'Expired provider-pending Checkout remains canonically unresolved.',
      now()+interval '1 day'
    );
    raise exception 'Developer access bypassed an expired provider-pending Checkout';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Developer access bypassed an expired provider-pending Checkout' then raise; end if;
    if v_error<>'ACTIVE_CHECKOUT_REQUIRES_EXPIRATION' then raise; end if;
  end;
  update private.billing_checkout_reservations reservation set
    status='session_created',stripe_checkout_session_id='cs_test_ExpiredReservation123'
  where reservation.request_key='20000000-0000-4000-8000-000000000020';
  begin
    perform public.billing_admin_grant_developer(
      v_other,'Expired provider-bound Checkout Session remains canonically unresolved.',
      now()+interval '1 day'
    );
    raise exception 'Developer access bypassed an expired bound Checkout Session';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Developer access bypassed an expired bound Checkout Session' then raise; end if;
    if v_error<>'ACTIVE_CHECKOUT_REQUIRES_EXPIRATION' then raise; end if;
  end;
  delete from private.billing_checkout_reservations reservation
  where reservation.request_key='20000000-0000-4000-8000-000000000020';

  perform set_config('request.jwt.claim.sub',v_other::text,true);
  begin
    perform public.billing_admin_grant_developer(
      v_owner,'Unauthorized ordinary-account grant must be rejected.',now()+interval '1 day'
    );
    raise exception 'Ordinary account unexpectedly granted developer access';
  exception when others then
    if sqlerrm='Ordinary account unexpectedly granted developer access' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims','{"aal":"aal1"}',true);
  begin
    perform public.billing_admin_grant_developer(
      v_owner,'AAL1 administrator grant must be rejected by the database.',now()+interval '1 day'
    );
    raise exception 'AAL1 administrator unexpectedly granted developer access';
  exception when others then
    if sqlerrm='AAL1 administrator unexpectedly granted developer access' then raise; end if;
  end;

  update private.billing_plan_catalog set
    stripe_price_id=case plan_code
      when 'account_weekly' then 'price_WeeklyTest123'
      when 'account_monthly' then 'price_MonthlyTest123'
      when 'account_yearly' then 'price_YearlyTest123'
    end,
    livemode=false,
    updated_at=now();

  execute 'alter table private.billing_runtime_config disable trigger billing_runtime_config_protect_delete';
  delete from private.billing_runtime_config where singleton;
  if not public.billing_enforcement_enabled() then
    raise exception 'Missing runtime configuration disabled enforcement';
  end if;
  select snapshot.state,snapshot.access_allowed into v_state,v_allowed
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'billing_configuration_unavailable' or v_allowed then
    raise exception 'Missing runtime configuration did not fail access closed: %, %',
      v_state,v_allowed;
  end if;
  begin
    perform public.billing_prepare_checkout(
      v_owner,repeat('a',64),'k1',null,null,'[]'::jsonb,'account_weekly',
      '20000000-0000-4000-8000-000000000007',now()+interval '24 hours'
    );
    raise exception 'Missing runtime configuration unexpectedly allowed Checkout';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Missing runtime configuration unexpectedly allowed Checkout' then raise; end if;
    if v_error<>'Checkout is disabled' then raise; end if;
  end;
  insert into private.billing_runtime_config(
    singleton,enforcement_enabled,checkout_enabled,livemode,updated_by
  ) values(true,true,false,false,v_admin);
  execute 'alter table private.billing_runtime_config enable trigger billing_runtime_config_protect_delete';

  begin
    perform public.billing_prepare_checkout(
      v_owner,repeat('a',64),'k1',null,null,'[]'::jsonb,'account_weekly',
      '20000000-0000-4000-8000-000000000008',now()+interval '24 hours'
    );
    raise exception 'Server-side shadow mode unexpectedly allowed Checkout';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Server-side shadow mode unexpectedly allowed Checkout' then raise; end if;
    if v_error<>'Checkout is disabled' then raise; end if;
  end;
  update private.billing_runtime_config
  set checkout_enabled=true,updated_by=v_admin,updated_at=now()
  where singleton;

  insert into private.billing_trial_claims(
    account_id,email_fingerprint,fingerprint_key_id,claim_state,consumed_at,
    consumed_subscription_id
  ) values(
    v_rotation,repeat('8',64),'k2026_07','consumed',now()-interval '1 day',
    'sub_RotationConsumed123'
  );
  v_checkout:=public.billing_prepare_checkout(
    v_rotation,repeat('9',64),'k2026_08',repeat('8',64),'k2026_07','[]'::jsonb,
    'account_yearly','20000000-0000-4000-8000-000000000027',
    now()+interval '24 hours'
  );
  if (v_checkout->>'trial_eligible')::boolean
    or not exists(
      select 1 from private.billing_trial_claims claim
      where claim.account_id=v_rotation
        and claim.email_fingerprint=repeat('9',64)
        and claim.fingerprint_key_id='k2026_08'
        and claim.fingerprint_rotated_at is not null
        and claim.claim_state='consumed'
    ) then
    raise exception 'Previous-key rotation did not preserve the consumed trial tombstone';
  end if;
  delete from private.billing_checkout_reservations reservation
  where reservation.account_id=v_rotation;
  v_checkout:=public.billing_prepare_checkout(
    v_rotation,repeat('c',64),'k2026_09',repeat('d',64),'k2026_085',
    jsonb_build_array(jsonb_build_object(
      'digest',repeat('9',64),'key_id','k2026_08'
    )),
    'account_yearly','20000000-0000-4000-8000-000000000029',
    now()+interval '24 hours'
  );
  if (v_checkout->>'trial_eligible')::boolean
    or not exists(
      select 1 from private.billing_trial_claims claim
      where claim.account_id=v_rotation
        and claim.email_fingerprint=repeat('c',64)
        and claim.fingerprint_key_id='k2026_09'
        and claim.fingerprint_rotated_at is not null
        and claim.claim_state='consumed'
    ) then
    raise exception 'Retained-key-ring rotation did not preserve the oldest consumed trial tombstone';
  end if;
  delete from private.billing_checkout_reservations reservation
  where reservation.account_id=v_rotation;
  insert into private.billing_trial_claims(
    account_id,email_fingerprint,fingerprint_key_id,claim_state,
    reservation_expires_at
  ) values(
    v_rotation_other,repeat('7',64),'k2026_07','reserved',
    now()+interval '1 hour'
  );
  v_checkout:=public.billing_prepare_checkout(
    v_rotation_contender,repeat('5',64),'k2026_08',repeat('6',64),'k2026_075',
    jsonb_build_array(jsonb_build_object(
      'digest',repeat('7',64),'key_id','k2026_07'
    )),
    'account_weekly','20000000-0000-4000-8000-000000000028',
    now()+interval '24 hours'
  );
  if (v_checkout->>'trial_eligible')::boolean
    or not exists(
      select 1 from private.billing_trial_claims claim
      where claim.account_id=v_rotation_other
        and claim.email_fingerprint=repeat('7',64)
        and claim.fingerprint_key_id='k2026_07'
    ) then
    raise exception 'Cross-account retired-key reservation received a concurrent trial';
  end if;
  delete from private.billing_checkout_reservations reservation
  where reservation.account_id=v_rotation_contender;
  delete from private.billing_trial_claims claim
  where claim.account_id=v_rotation_other;

  v_checkout:=public.billing_prepare_checkout(
    v_other,repeat('3',64),'k1',null,null,'[]'::jsonb,'account_monthly',
    '20000000-0000-4000-8000-000000000023',now()+interval '24 hours'
  );
  if not public.billing_assert_checkout_allowed(
    v_other,(v_checkout->>'reservation_id')::uuid,
    '20000000-0000-4000-8000-000000000023'
  ) then raise exception 'Lost-attach Checkout did not enter provider-pending state'; end if;
  update private.billing_checkout_reservations reservation set
    created_at=now()-interval '2 days',expires_at=now()-interval '1 day',
    lease_expires_at=now()-interval '1 day',updated_at=now()-interval '1 day'
  where reservation.id=(v_checkout->>'reservation_id')::uuid;
  begin
    perform public.billing_prepare_checkout(
      v_other,repeat('3',64),'k1',null,null,'[]'::jsonb,'account_monthly',
      '20000000-0000-4000-8000-000000000024',now()+interval '24 hours'
    );
    raise exception 'Expired unbound provider-pending Checkout was replaced locally';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Expired unbound provider-pending Checkout was replaced locally' then raise; end if;
    if v_error<>'Checkout reconciliation is required' then raise; end if;
  end;
  if not exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.id=(v_checkout->>'reservation_id')::uuid
      and reservation.status='provider_pending'
      and reservation.stripe_checkout_session_id is null
  ) then raise exception 'Ambiguous provider-pending Checkout was not quarantined'; end if;
  perform public.billing_record_webhook_event(
    'evt_LostAttachCompleted123','checkout.session.completed',
    'cs_test_LostAttachCompleted123',now(),repeat('3',64),false
  );
  if not public.billing_apply_checkout_event(
    'evt_LostAttachCompleted123',v_other,'cus_LostAttach123',
    'sub_LostAttach123',(v_checkout->>'reservation_id')::uuid,
    'cs_test_LostAttachCompleted123','complete',now(),now()+interval '7 days'
  ) then raise exception 'Delayed canonical completion did not reconcile lost attach'; end if;
  if not exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.id=(v_checkout->>'reservation_id')::uuid
      and reservation.status='completed'
      and reservation.stripe_checkout_session_id='cs_test_LostAttachCompleted123'
      and reservation.stripe_subscription_id='sub_LostAttach123'
  ) then raise exception 'Delayed completion did not retain exact Checkout ownership'; end if;
  if not exists(
    select 1 from private.billing_trial_claims claim
    where claim.account_id=v_other and claim.claim_state='consumed'
      and claim.consumed_subscription_id='sub_LostAttach123'
  ) then raise exception 'Completed Checkout did not atomically bind its canonical trial'; end if;
  perform public.billing_record_webhook_event(
    'evt_LostAttachCanceled123','customer.subscription.deleted',
    'sub_LostAttach123',now()+interval '1 second',repeat('4',64),false
  );
  if not public.billing_apply_subscription_event(
    'evt_LostAttachCanceled123',v_other,'cus_LostAttach123','sub_LostAttach123',
    'price_MonthlyTest123','account_monthly','canceled',
    now(),now()+interval '7 days',now(),now()+interval '7 days',
    false,null,now(),null,'',false
  ) then raise exception 'Canceled-before-created subscription snapshot was not applied'; end if;
  v_checkout2:=public.billing_prepare_checkout(
    v_other,repeat('3',64),'k1',null,null,'[]'::jsonb,'account_monthly',
    '20000000-0000-4000-8000-000000000025',now()+interval '24 hours'
  );
  if (v_checkout2->>'trial_eligible')::boolean is not false then
    raise exception 'Canceled-before-created ordering allowed a repeat trial: %',v_checkout2;
  end if;
  delete from private.billing_checkout_reservations reservation
  where reservation.id in (
    (v_checkout->>'reservation_id')::uuid,(v_checkout2->>'reservation_id')::uuid
  );
  delete from private.billing_subscriptions sub
  where sub.stripe_subscription_id='sub_LostAttach123';
  delete from private.billing_trial_claims claim where claim.account_id=v_other;
  delete from private.billing_customers customer where customer.account_id=v_other;
  delete from private.billing_webhook_events event
  where event.stripe_event_id in (
    'evt_LostAttachCompleted123','evt_LostAttachCanceled123'
  );

  update private.billing_runtime_config set livemode=true,updated_at=now() where singleton;
  v_duplicate:=public.billing_record_webhook_event(
    'evt_Environment123','customer.subscription.updated','sub_Environment123',
    now(),repeat('6',64),false
  );
  if v_duplicate then raise exception 'Environment-mismatched webhook was accepted'; end if;
  if not exists(
    select 1 from private.billing_reconciliation_alerts alert
    where alert.alert_type='environment_mismatch'
      and alert.object_id='sub_Environment123' and alert.resolved_at is null
  ) then raise exception 'Environment mismatch alert did not persist'; end if;
  update private.billing_runtime_config set livemode=false,updated_at=now() where singleton;

  insert into private.billing_checkout_reservations(
    request_key,lease_token,lease_expires_at,account_id,plan_code,
    trial_eligible,status,expires_at,created_at,updated_at
  ) values(
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',now()-interval '25 hours',
    v_other,'account_weekly',false,'expired',now()-interval '1 day',
    now()-interval '2 days',now()-interval '2 days'
  );
  perform public.billing_record_webhook_event(
    'evt_ExpiredCheckout123','checkout.session.expired','cs_test_ExpiredCheckout123',
    now(),repeat('2',64),false
  );
  if not public.billing_apply_checkout_event(
    'evt_ExpiredCheckout123',v_other,'cus_OtherTest123','',
    (select id from private.billing_checkout_reservations
      where request_key='20000000-0000-4000-8000-000000000021'),
    'cs_test_ExpiredCheckout123','expired',null,null
  ) then raise exception 'Already-expired Checkout event was not idempotent'; end if;
  perform public.billing_record_webhook_event(
    'evt_ExpiredCheckoutRetry123','checkout.session.expired','cs_test_ExpiredCheckout123',
    now(),repeat('3',64),false
  );
  if not public.billing_apply_checkout_event(
    'evt_ExpiredCheckoutRetry123',v_other,'cus_OtherTest123','',
    (select id from private.billing_checkout_reservations
      where request_key='20000000-0000-4000-8000-000000000021'),
    'cs_test_ExpiredCheckout123','expired',null,null
  ) then raise exception 'Exact expired Checkout retry was not idempotent'; end if;
  perform public.billing_record_webhook_event(
    'evt_ExpiredCheckoutConflict123','checkout.session.expired','cs_test_ConflictCheckout123',
    now(),repeat('4',64),false
  );
  begin
    perform public.billing_apply_checkout_event(
      'evt_ExpiredCheckoutConflict123',v_other,'cus_OtherTest123','',
      (select id from private.billing_checkout_reservations
        where request_key='20000000-0000-4000-8000-000000000021'),
      'cs_test_ConflictCheckout123','expired',null,null
    );
    raise exception 'Conflicting expired Checkout session was accepted';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Conflicting expired Checkout session was accepted' then raise; end if;
    if v_error<>'Checkout reservation does not match the verified session' then raise; end if;
  end;
  perform public.billing_mark_webhook_failed(
    'evt_ExpiredCheckoutConflict123','conflicting_expired_checkout_session_rejected'
  );
  if not exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.request_key='20000000-0000-4000-8000-000000000021'
      and reservation.status='expired'
      and reservation.stripe_checkout_session_id='cs_test_ExpiredCheckout123'
  ) then raise exception 'Expired Checkout idempotency changed canonical ownership'; end if;

  insert into private.billing_checkout_reservations(
    request_key,lease_token,lease_expires_at,account_id,plan_code,
    trial_eligible,status,stripe_checkout_session_id,expires_at
  ) values(
    '20000000-0000-4000-8000-000000000026',
    '20000000-0000-4000-8000-000000000026',now()+interval '1 minute',
    v_other,'account_weekly',false,'session_created',
    'cs_test_IneligibleTrial123',now()+interval '24 hours'
  );
  perform public.billing_record_webhook_event(
    'evt_IneligibleTrialCheckout123','checkout.session.completed',
    'cs_test_IneligibleTrial123',now(),repeat('5',64),false
  );
  begin
    perform public.billing_apply_checkout_event(
      'evt_IneligibleTrialCheckout123',v_other,'cus_OtherTest123',
      'sub_IneligibleTrial123',
      (select id from private.billing_checkout_reservations
        where request_key='20000000-0000-4000-8000-000000000026'),
      'cs_test_IneligibleTrial123','complete',now(),now()+interval '7 days'
    );
    raise exception 'Canonical trial consumed an ineligible Checkout reservation';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Canonical trial consumed an ineligible Checkout reservation' then raise; end if;
    if v_error<>'Canonical Checkout trial does not match its reservation' then raise; end if;
  end;
  if not exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.request_key='20000000-0000-4000-8000-000000000026'
      and reservation.status='session_created'
      and reservation.stripe_subscription_id is null
  ) or exists(
    select 1 from private.billing_trial_claims claim
    where claim.account_id=v_other and claim.claim_state='consumed'
      and claim.consumed_subscription_id='sub_IneligibleTrial123'
  ) then raise exception 'Rejected trial completion was not atomically rolled back'; end if;
  perform public.billing_mark_webhook_failed(
    'evt_IneligibleTrialCheckout123','ineligible_checkout_trial_rejected'
  );
  delete from private.billing_checkout_reservations reservation
  where reservation.request_key='20000000-0000-4000-8000-000000000026';
  delete from private.billing_webhook_events event
  where event.stripe_event_id='evt_IneligibleTrialCheckout123';

  v_checkout:=public.billing_prepare_checkout(
    v_owner,repeat('a',64),'k1',null,null,'[]'::jsonb,'account_weekly',
    '20000000-0000-4000-8000-000000000001',now()+interval '24 hours'
  );
  if (v_checkout->>'trial_eligible')::boolean is not true
    or v_checkout->>'amount_minor'<>'2000'
    or v_checkout->>'stripe_price_id'<>'price_WeeklyTest123'
    or v_checkout->>'reservation_status'<>'reserved'
    or (v_checkout->>'lease_acquired')::boolean is not true
    or v_checkout->>'stripe_checkout_session_id' is not null
    or v_checkout->>'reservation_expires_at' is null then
    raise exception 'Eligible checkout reservation returned an invalid server plan: %',v_checkout;
  end if;
  v_checkout2:=public.billing_prepare_checkout(
    v_owner,repeat('a',64),'k1',null,null,'[]'::jsonb,'account_weekly',
    '20000000-0000-4000-8000-000000000009',now()+interval '24 hours'
  );
  if v_checkout2->>'reservation_id'<>v_checkout->>'reservation_id'
    or (v_checkout2->>'lease_acquired')::boolean is not false
    or (select count(*) from private.billing_checkout_reservations
      where account_id=v_owner and status in ('reserved','provider_pending','session_created'))<>1 then
    raise exception 'Concurrent Checkout preparation created or leased another reservation: %',v_checkout2;
  end if;
  if not public.billing_assert_checkout_allowed(
    v_owner,(v_checkout->>'reservation_id')::uuid,
    '20000000-0000-4000-8000-000000000001'
  ) then raise exception 'Checkout provider boundary was not authorized'; end if;
  update private.billing_runtime_config set checkout_enabled=false,updated_at=now()
  where singleton;
  begin
    perform public.billing_assert_checkout_allowed(
      v_owner,(v_checkout->>'reservation_id')::uuid,
      '20000000-0000-4000-8000-000000000001'
    );
    raise exception 'Provider-pending Checkout bypassed the kill switch';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Provider-pending Checkout bypassed the kill switch' then raise; end if;
    if v_error<>'Checkout is disabled' then raise; end if;
  end;
  update private.billing_runtime_config set checkout_enabled=true,updated_at=now()
  where singleton;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims','{"aal":"aal2"}',true);
  begin
    perform public.billing_admin_grant_developer(
      v_owner,'Concurrent Checkout must finish before developer access is granted.',
      now()+interval '1 day'
    );
    raise exception 'Developer access was granted during an active Checkout';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Developer access was granted during an active Checkout' then raise; end if;
    if v_error<>'ACTIVE_CHECKOUT_REQUIRES_EXPIRATION' then raise; end if;
  end;
  if not public.billing_bind_customer(v_owner,'cus_OwnerTest123') then
    raise exception 'Canonical Stripe Customer was not bound';
  end if;
  perform public.billing_attach_checkout_session(
    v_owner,(v_checkout->>'reservation_id')::uuid,'cs_test_BillingSession123',
    '20000000-0000-4000-8000-000000000001'
  );
  if not public.billing_attach_checkout_session(
    v_owner,(v_checkout->>'reservation_id')::uuid,'cs_test_BillingSession123',
    '20000000-0000-4000-8000-000000000001'
  ) then raise exception 'Exact Checkout attach retry was not idempotent'; end if;
  v_checkout2:=public.billing_prepare_checkout(
    v_owner,repeat('a',64),'k1',null,null,'[]'::jsonb,'account_weekly',
    '20000000-0000-4000-8000-000000000010',now()+interval '24 hours'
  );
  if v_checkout2->>'reservation_status'<>'session_created'
    or v_checkout2->>'stripe_checkout_session_id'<>'cs_test_BillingSession123'
    or (v_checkout2->>'lease_acquired')::boolean then
    raise exception 'Attached Checkout Session was not safely reusable: %',v_checkout2;
  end if;
  if not public.billing_record_webhook_event(
    'evt_Checkout123','checkout.session.completed','cs_test_BillingSession123',
    now(),repeat('b',64),false
  ) then raise exception 'First checkout event was not accepted'; end if;
  perform public.billing_apply_checkout_event(
    'evt_Checkout123',v_owner,'cus_OwnerTest123','sub_OwnerTest123',
    (v_checkout->>'reservation_id')::uuid,'cs_test_BillingSession123','complete',
    now(),now()+interval '7 days'
  );
  if not exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.id=(v_checkout->>'reservation_id')::uuid
      and reservation.status='completed'
      and reservation.stripe_subscription_id='sub_OwnerTest123'
  ) then raise exception 'Completed Checkout did not retain its subscription identity'; end if;
  if not exists(
    select 1 from private.billing_trial_claims claim
    where claim.account_id=v_owner and claim.claim_state='consumed'
      and claim.consumed_subscription_id='sub_OwnerTest123'
  ) then raise exception 'Checkout completion did not consume the reserved trial claim'; end if;
  begin
    perform public.billing_prepare_checkout(
      v_owner,repeat('a',64),'k1',null,null,'[]'::jsonb,'account_weekly',
      '20000000-0000-4000-8000-000000000022',now()+interval '24 hours'
    );
    raise exception 'A second Checkout was prepared before subscription reconciliation';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='A second Checkout was prepared before subscription reconciliation' then raise; end if;
    if v_error<>'Checkout reconciliation is required' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims','{"aal":"aal2"}',true);
  begin
    perform public.billing_admin_grant_developer(
      v_owner,'Completed Checkout must reconcile before developer access.',
      now()+interval '1 day'
    );
    raise exception 'Developer access bypassed a completed unreconciled Checkout';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Developer access bypassed a completed unreconciled Checkout' then raise; end if;
    if v_error<>'ACTIVE_CHECKOUT_REQUIRES_EXPIRATION' then raise; end if;
  end;

  if not public.billing_record_webhook_event(
    'evt_Trial123','customer.subscription.created','sub_OwnerTest123',
    now(),repeat('c',64),false
  ) then raise exception 'First subscription event was not accepted'; end if;
  perform public.billing_apply_subscription_event(
    'evt_Trial123',v_owner,'cus_OwnerTest123','sub_OwnerTest123',
    'price_WeeklyTest123','account_weekly','trialing',now(),now()+interval '7 days',
    now(),now()+interval '7 days',false,null,null,null,'',false
  );
  select snapshot.state,snapshot.access_allowed into v_state,v_allowed
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'trial_active' or not v_allowed then
    raise exception 'Verified Stripe trial did not grant access: %, %',v_state,v_allowed;
  end if;
  if not exists(
    select 1 from private.billing_trial_claims claim
    where claim.account_id=v_owner and claim.claim_state='consumed'
      and claim.consumed_subscription_id='sub_OwnerTest123'
  ) then raise exception 'Stripe trial did not consume the trial claim'; end if;
  select snapshot.trial_eligible into v_trial_eligible
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_trial_eligible is distinct from false then
    raise exception 'Consumed account trial was not reported ineligible';
  end if;

  v_duplicate:=public.billing_record_webhook_event(
    'evt_Trial123','customer.subscription.created','sub_OwnerTest123',
    now(),repeat('c',64),false
  );
  if v_duplicate then raise exception 'Duplicate webhook event was reaccepted'; end if;
  if public.billing_webhook_event_disposition('evt_Trial123',repeat('c',64))<>'terminal' then
    raise exception 'Processed webhook duplicate was not terminal';
  end if;
  v_duplicate:=public.billing_record_webhook_event(
    'evt_Trial123','customer.subscription.created','sub_OwnerTest123',
    now(),repeat('0',64),false
  );
  if v_duplicate or not exists(
    select 1 from private.billing_reconciliation_alerts alert
    where alert.alert_type='event_id_payload_conflict'
      and alert.object_id='sub_OwnerTest123' and alert.resolved_at is null
  ) then raise exception 'Payload-conflict alert did not persist'; end if;

  if not public.billing_record_webhook_event(
    'evt_Retry123','customer.subscription.updated','sub_RetryTest123',
    now(),repeat('f',64),false
  ) then raise exception 'Retry test event was not initially accepted'; end if;
  if not public.billing_mark_webhook_failed(
    'evt_Retry123','synthetic_retry_test_failure'
  ) then raise exception 'Retry test event could not be marked failed'; end if;
  if not public.billing_record_webhook_event(
    'evt_Retry123','customer.subscription.updated','sub_RetryTest123',
    now(),repeat('f',64),false
  ) then raise exception 'Failed webhook event was not atomically reclaimed'; end if;
  select event.processing_state,event.attempt_count
  into v_processing_state,v_attempt_count
  from private.billing_webhook_events event
  where event.stripe_event_id='evt_Retry123';
  if v_processing_state<>'processing' or v_attempt_count<>2 then
    raise exception 'Webhook reclaim state mismatch: %, %',v_processing_state,v_attempt_count;
  end if;
  v_duplicate:=public.billing_record_webhook_event(
    'evt_Retry123','customer.subscription.updated','sub_RetryTest123',
    now(),repeat('f',64),false
  );
  if v_duplicate then raise exception 'Active webhook lease was reaccepted'; end if;
  if public.billing_webhook_event_disposition('evt_Retry123',repeat('f',64))<>'active' then
    raise exception 'In-flight webhook duplicate was not classified active';
  end if;
  perform public.billing_mark_webhook_failed('evt_Retry123','synthetic_retry_test_complete');
  update private.billing_webhook_events set attempt_count=20
  where stripe_event_id='evt_Retry123';
  v_duplicate:=public.billing_record_webhook_event(
    'evt_Retry123','customer.subscription.updated','sub_RetryTest123',
    now(),repeat('f',64),false
  );
  if v_duplicate or not exists(
    select 1 from private.billing_reconciliation_alerts alert
    where alert.alert_type='webhook_retry_exhausted'
      and alert.object_id='sub_RetryTest123' and alert.resolved_at is null
  ) then raise exception 'Retry-exhaustion alert did not persist'; end if;
  if public.billing_webhook_event_disposition('evt_Retry123',repeat('f',64))<>'terminal'
    or not exists(
      select 1 from private.billing_webhook_events event
      where event.stripe_event_id='evt_Retry123'
        and event.processing_state='review_required'
        and event.last_error='webhook_retry_exhausted'
    ) then raise exception 'Retry exhaustion was not durably dead-lettered'; end if;

  if not public.billing_record_webhook_event(
    'evt_Dispute123','charge.dispute.created','du_ManualReview123',
    now(),repeat('7',64),false
  ) then raise exception 'Financial-hold webhook was not initially accepted'; end if;
  if not public.billing_apply_financial_hold_event(
    'evt_Dispute123',v_owner,'cus_OwnerTest123','sub_OwnerTest123',
    'in_DisputedInvoice123','dispute','du_ManualReview123'
  ) then raise exception 'Canonical dispute did not open its financial hold'; end if;
  if not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id='evt_Dispute123'
      and event.processing_state='review_required'
      and event.last_error='financial_hold_open'
  ) or not exists(
    select 1 from private.billing_reconciliation_alerts alert
    where alert.account_id=v_owner and alert.alert_type='financial_event_hold'
      and alert.object_id='du_ManualReview123'
      and alert.severity='critical' and alert.resolved_at is null
  ) or not exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.account_id=v_owner and hold_row.state='open'
      and hold_row.stripe_customer_id='cus_OwnerTest123'
      and hold_row.stripe_subscription_id='sub_OwnerTest123'
      and hold_row.stripe_invoice_id='in_DisputedInvoice123'
      and hold_row.provider_object_type='dispute'
      and hold_row.provider_object_id='du_ManualReview123'
      and hold_row.source_event_id='evt_Dispute123'
  ) or not exists(
    select 1 from public.platform_security_events security_event
    where security_event.event_type='billing_financial_hold_opened'
      and security_event.source='edge_function'
      and security_event.subject_account_id=v_owner
  ) then raise exception 'Exact dispute hold or reconciliation alert is missing'; end if;
  select hold_row.id into v_hold_id
  from private.billing_financial_holds hold_row
  where hold_row.source_event_id='evt_Dispute123';
  if v_hold_id is null then raise exception 'Internal financial hold ID is missing'; end if;
  select snapshot.state,snapshot.access_allowed into v_state,v_allowed
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'financial_review_hold' or v_allowed then
    raise exception 'Open financial hold did not revoke entitlement: %, %',v_state,v_allowed;
  end if;
  if (public.billing_account_deletion_guard(v_owner)->>'allowed')::boolean
    or public.billing_account_deletion_guard(v_owner)->>'code'
      <>'billing_financial_hold_reconciliation_required' then
    raise exception 'Open financial hold did not block destructive account cleanup';
  end if;
  perform set_config('request.jwt.claims','{"aal":"aal1"}',true);
  begin
    perform 1 from public.billing_admin_financial_holds(v_owner,10);
    raise exception 'AAL1 administrator inspected financial holds';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='AAL1 administrator inspected financial holds' then raise; end if;
    if v_error<>'AAL2 required' then raise; end if;
  end;
  perform set_config('request.jwt.claims','{"aal":"aal2"}',true);
  if not exists(
    select 1 from public.billing_admin_financial_holds(v_owner,10) hold_row
    where hold_row.hold_id=v_hold_id and hold_row.account_id=v_owner
      and hold_row.event_category='dispute'
      and hold_row.event_type='charge.dispute.created'
  ) then raise exception 'AAL2 administrator hold inspection omitted the open hold'; end if;
  if not public.billing_admin_reconcile_financial_hold(
    v_hold_id,'Canonical provider review completed; restore only the current stored entitlement.'
  ) then raise exception 'AAL2 administrator could not reconcile the exact hold'; end if;
  select snapshot.state,snapshot.access_allowed into v_state,v_allowed
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'trial_active' or not v_allowed then
    raise exception 'Explicit hold reconciliation did not restore current entitlement: %, %',
      v_state,v_allowed;
  end if;
  if not exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.source_event_id='evt_Dispute123'
      and hold_row.state='reconciled' and hold_row.reconciled_by=v_admin
      and char_length(hold_row.reconcile_reason)>=10
  ) then raise exception 'Financial hold reconciliation audit is incomplete'; end if;
  perform public.billing_record_webhook_event(
    'evt_DisputeClosedOlder123','charge.dispute.closed','du_ManualReview123',
    now()-interval '1 day',repeat('5',64),false
  );
  if not public.billing_apply_financial_hold_event(
    'evt_DisputeClosedOlder123',v_owner,'cus_OwnerTest123','sub_OwnerTest123',
    'in_DisputedInvoice123','dispute','du_ManualReview123'
  ) then raise exception 'Stale dispute-closed event skipped its hold'; end if;
  select snapshot.state,snapshot.access_allowed into v_state,v_allowed
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'financial_review_hold' or v_allowed then
    raise exception 'Stale dispute-closed event silently cleared its hold: %, %',
      v_state,v_allowed;
  end if;
  select hold_row.id into v_hold_id
  from private.billing_financial_holds hold_row
  where hold_row.source_event_id='evt_DisputeClosedOlder123';
  if not public.billing_admin_reconcile_financial_hold(
    v_hold_id,
    'Stale closed event reviewed independently; do not infer provider outcome from ordering.'
  ) then raise exception 'Exact stale-event hold reconciliation was rejected'; end if;
  select snapshot.state,snapshot.access_allowed into v_state,v_allowed
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if not v_allowed then
    raise exception 'Exact stale-event hold reconciliation did not restore entitlement: %',v_state;
  end if;
  v_duplicate:=public.billing_record_webhook_event(
    'evt_Dispute123','charge.dispute.created','du_ManualReview123',
    now(),repeat('7',64),false
  );
  if v_duplicate then raise exception 'Financial-hold webhook was reaccepted'; end if;
  if public.billing_webhook_event_disposition('evt_Dispute123',repeat('7',64))<>'terminal' then
    raise exception 'Financial-hold webhook duplicate was not terminal';
  end if;

  if not public.billing_record_webhook_event(
    'evt_UnprovenRefund123','refund.created','re_UnprovenRefund123',
    now(),repeat('6',64),false
  ) then raise exception 'Unproven refund webhook was not initially accepted'; end if;
  if not public.billing_apply_financial_hold_event(
    'evt_UnprovenRefund123',v_owner,'cus_OwnerTest123','sub_NotOwned123',
    'in_UnprovenRefund123','refund','re_UnprovenRefund123'
  ) then raise exception 'Unproven refund was not durably dead-lettered'; end if;
  if not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id='evt_UnprovenRefund123'
      and event.processing_state='review_required'
      and event.last_error='financial_event_linkage_unproven'
  ) or not exists(
    select 1 from private.billing_reconciliation_alerts alert
    where alert.account_id is null
      and alert.alert_type='unproven_financial_event_linkage'
      and alert.object_id='re_UnprovenRefund123'
      and alert.resolved_at is null
  ) or exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.source_event_id='evt_UnprovenRefund123'
  ) then raise exception 'Unproven refund inferred ownership or lacked durable review'; end if;

  perform public.billing_record_webhook_event(
    'evt_CustomerHold123','charge.refunded','ch_CustomerHold123',
    now(),repeat('4',64),false
  );
  if not public.billing_apply_customer_financial_hold_event(
    'evt_CustomerHold123','cus_OwnerTest123','charge','ch_CustomerHold123'
  ) then raise exception 'Canonical Customer fallback did not open a hold'; end if;
  select hold_row.id into v_hold_id
  from private.billing_financial_holds hold_row
  where hold_row.source_event_id='evt_CustomerHold123';
  if v_hold_id is null or not exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.id=v_hold_id and hold_row.account_id=v_owner
      and hold_row.evidence_level='customer_binding'
      and hold_row.stripe_customer_id='cus_OwnerTest123'
      and hold_row.stripe_subscription_id is null
      and hold_row.stripe_invoice_id is null
      and hold_row.state='open'
  ) or not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id='evt_CustomerHold123'
      and event.processing_state='review_required'
      and event.last_error='financial_customer_hold_open'
  ) or not exists(
    select 1 from public.platform_security_events security_event
    where security_event.event_type='billing_financial_hold_opened'
      and security_event.source='edge_function'
      and security_event.subject_account_id=v_owner
  ) or public.account_has_billing_access(v_owner) then
    raise exception 'Customer-bound unresolved financial event did not fail closed';
  end if;
  if not public.billing_admin_reconcile_financial_hold(
    v_hold_id,'Canonical Customer hold reviewed after exact Invoice linkage remained unavailable.'
  ) then raise exception 'Customer-bound financial hold reconciliation was rejected'; end if;
  if not public.account_has_billing_access(v_owner) then
    raise exception 'Customer-bound financial hold was not explicitly reconciled';
  end if;

  perform public.billing_record_webhook_event(
    'evt_UnboundCustomer123','charge.refunded','ch_UnboundCustomer123',
    now(),repeat('3',64),false
  );
  if not public.billing_apply_customer_financial_hold_event(
    'evt_UnboundCustomer123','cus_UnboundCustomer123','charge','ch_UnboundCustomer123'
  ) then raise exception 'Unknown canonical Customer review was not durable'; end if;
  if not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id='evt_UnboundCustomer123'
      and event.processing_state='review_required'
      and event.last_error='financial_customer_binding_unproven'
  ) or exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.source_event_id='evt_UnboundCustomer123'
  ) then raise exception 'Unknown canonical Customer incorrectly inferred account ownership'; end if;

  v_checkout:=public.billing_prepare_checkout(
    v_other,repeat('a',64),'k1',null,null,'[]'::jsonb,'account_monthly',
    '20000000-0000-4000-8000-000000000002',now()+interval '24 hours'
  );
  if (v_checkout->>'trial_eligible')::boolean is not false then
    raise exception 'Consumed email fingerprint received a second trial: %',v_checkout;
  end if;
  insert into private.billing_trial_claims(
    account_id,email_fingerprint,fingerprint_key_id,claim_state,
    consumed_at,consumed_subscription_id
  ) values(
    v_other,repeat('2',64),'k1','consumed',
    now()-interval '7 days','sub_OtherCanceled123'
  );
  insert into private.billing_subscriptions(
    stripe_subscription_id,account_id,stripe_customer_id,stripe_price_id,plan_code,
    status,trial_claim_verified,trial_start,trial_end,current_period_start,
    current_period_end,cancel_at_period_end,canceled_at,livemode,last_event_id,
    last_event_created_at
  ) values(
    'sub_OtherCanceled123',v_other,'cus_OtherTest123','price_MonthlyTest123',
    'account_monthly','canceled',true,now()-interval '14 days',now()-interval '7 days',
    now()-interval '14 days',now()-interval '7 days',true,now()-interval '7 days',
    false,'evt_OtherCanceled123',now()-interval '7 days'
  );
  perform public.billing_record_webhook_event(
    'evt_OtherTrialB123','customer.subscription.created','sub_OtherTrialB123',
    now(),repeat('a',64),false
  );
  perform public.billing_apply_subscription_event(
    'evt_OtherTrialB123',v_other,'cus_OtherTest123','sub_OtherTrialB123',
    'price_MonthlyTest123','account_monthly','trialing',now(),now()+interval '7 days',
    now(),now()+interval '7 days',false,null,null,null,'',false
  );
  if not exists(
    select 1 from private.billing_trial_claims claim
    where claim.account_id=v_other
      and claim.consumed_subscription_id='sub_OtherCanceled123'
  ) or not exists(
    select 1 from private.billing_subscriptions sub
    where sub.stripe_subscription_id='sub_OtherTrialB123'
      and not sub.trial_claim_verified
  ) or public.account_has_billing_access(v_other) then
    raise exception 'A consumed trial claim was rebound to a second subscription';
  end if;

  perform public.billing_record_webhook_event(
    'evt_PastDue123','customer.subscription.updated','sub_OwnerTest123',
    now(),repeat('d',64),false
  );
  perform public.billing_apply_subscription_event(
    'evt_PastDue123',v_owner,'cus_OwnerTest123','sub_OwnerTest123',
    'price_WeeklyTest123','account_weekly','past_due',now()-interval '7 days',now(),
    now()-interval '7 days',now()+interval '1 day',false,null,null,
    'in_TestPastDue123','open',false
  );
  if public.account_has_billing_access(v_owner) then
    raise exception 'Past-due account retained paid capabilities';
  end if;
  insert into public.ai_tasks(
    id,owner,cadence,schedule_time,timezone,lead_minutes,next_run_at,next_publish_at
  )
  select
    ('30000000-0000-4000-8000-'||lpad(series.value::text,12,'0'))::uuid,
    v_owner,'daily','09:00','UTC',60,
    now()-interval '2 hours',now()-interval '1 hour'
  from generate_series(1,13) as series(value);
  loop
    v_advance_passes:=v_advance_passes+1;
    if v_advance_passes>4 then
      raise exception 'Bounded suspended-schedule drain did not converge';
    end if;
    v_advance_batch:=public.advance_suspended_ai_generation_tasks(now(),5);
    v_advance_total:=v_advance_total+v_advance_batch;
    exit when v_advance_batch<5;
  end loop;
  if v_advance_total<>13 or v_advance_passes<>3 then
    raise exception 'Suspended schedule backlog was not drained in bounded batches: total %, passes %',
      v_advance_total,v_advance_passes;
  end if;
  if not exists(
    select 1 from public.ai_tasks task
    where task.id='30000000-0000-4000-8000-000000000001'
      and task.last_status='paused_billing' and task.next_run_at>now()
      and task.next_publish_at>now()
  ) or exists(
    select 1 from public.due_ai_generation_tasks(now(),10) task
    where task.owner=v_owner
  ) or exists(
    select 1 from public.ai_tasks task
    where task.owner=v_owner and task.next_run_at<=now()
  ) then raise exception 'Suspended automation could catch up after reactivation'; end if;
  insert into public.ai_tasks(
    id,owner,cadence,schedule_time,timezone,lead_minutes,next_run_at,next_publish_at
  ) values(
    '30000000-0000-4000-8000-000000000014',v_owner,'daily','09:00','UTC',60,
    now()-interval '2 hours',now()-interval '1 hour'
  );
  insert into public.post_drafts(id,owner,status,scheduled_for) values(
    '31000000-0000-4000-8000-000000000014',v_owner,'scheduled',now()-interval '1 hour'
  );
  insert into public.drafts(
    id,owner,status,approval_state,publish_state,publish_at,publish_next_attempt_at
  ) values(
    '32000000-0000-4000-8000-000000000014',v_owner,'ready','approved','queued',
    now()-interval '1 hour',now()-interval '1 hour'
  );

  perform public.billing_record_webhook_event(
    'evt_StaleGrant123','customer.subscription.updated','sub_OwnerTest123',
    now()-interval '1 day',repeat('1',64),false
  );
  perform public.billing_apply_subscription_event(
    'evt_StaleGrant123',v_owner,'cus_OwnerTest123','sub_OwnerTest123',
    'price_WeeklyTest123','account_weekly','active',null,null,
    now()-interval '8 days',now()-interval '1 day',false,null,null,
    'in_TestStaleGrant123','paid',true
  );
  if not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id='evt_StaleGrant123'
      and event.processing_state='processed'
      and event.last_error='stale_event_ignored'
  ) or not exists(
    select 1 from public.ai_tasks task
    where task.id='30000000-0000-4000-8000-000000000014'
      and task.next_run_at<=now() and task.last_status=''
  ) or not exists(
    select 1 from public.post_drafts draft
    where draft.id='31000000-0000-4000-8000-000000000014'
      and draft.status='scheduled'
  ) or not exists(
    select 1 from public.drafts draft
    where draft.id='32000000-0000-4000-8000-000000000014'
      and draft.publish_state='queued' and draft.publish_next_attempt_at<=now()
  ) then raise exception 'A stale access-granting event terminalized suspended work'; end if;

  perform public.billing_record_webhook_event(
    'evt_Paid123','invoice.paid','in_TestPaid123',now(),repeat('e',64),false
  );
  perform public.billing_apply_subscription_event(
    'evt_Paid123',v_owner,'cus_OwnerTest123','sub_OwnerTest123',
    'price_WeeklyTest123','account_weekly','active',null,null,
    now(),now()+interval '7 days',true,now()+interval '7 days',null,
    'in_TestPaid123','paid',true
  );
  select snapshot.state,snapshot.access_allowed into v_state,v_allowed
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'cancel_scheduled' or not v_allowed then
    raise exception 'Paid-through cancellation did not preserve access: %, %',v_state,v_allowed;
  end if;
  if not exists(
    select 1 from public.ai_tasks task
    where task.id='30000000-0000-4000-8000-000000000014'
      and task.last_status='paused_billing' and task.next_run_at>now()
  ) then raise exception 'Paid access restoration did not atomically skip the suspended occurrence'; end if;
  if not exists(
    select 1 from public.post_drafts draft
    where draft.id='31000000-0000-4000-8000-000000000014'
      and draft.status='failed'
      and draft.last_error like 'Billing membership was inactive%'
  ) then raise exception 'Paid access restoration did not terminalize a due scheduled post'; end if;
  if not exists(
    select 1 from public.drafts draft
    where draft.id='32000000-0000-4000-8000-000000000014'
      and draft.publish_state='blocked' and draft.publish_next_attempt_at is null
      and draft.publish_error like 'Billing membership was inactive%'
  ) then raise exception 'Paid access restoration did not terminalize a due queued draft'; end if;

  perform public.billing_admin_grant_developer(
    v_owner,'Paid-through cancellation developer-transition audit regression.',
    now()+interval '1 day'
  );
  select snapshot.state into v_state
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'developer_active' or not exists(
    select 1 from private.billing_access_transitions access_transition
    where access_transition.account_id=v_owner and access_transition.cause='developer_grant'
      and access_transition.previous_state='cancel_scheduled'
      and access_transition.new_state='developer_active'
  ) then raise exception 'Developer grant did not audit the authoritative paid-through state'; end if;
  perform public.billing_admin_revoke_developer(
    v_owner,'Paid-through cancellation developer-transition audit completed.'
  );
  select snapshot.state into v_state
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'cancel_scheduled' or not exists(
    select 1 from private.billing_access_transitions access_transition
    where access_transition.account_id=v_owner and access_transition.cause='developer_revoke'
      and access_transition.previous_state='developer_active'
      and access_transition.new_state='cancel_scheduled'
  ) then raise exception 'Developer revoke did not restore and audit the paid-through state'; end if;

  perform public.billing_record_webhook_event(
    'evt_Stale123','customer.subscription.updated','sub_OwnerTest123',
    now()-interval '1 day',repeat('9',64),false
  );
  perform public.billing_apply_subscription_event(
    'evt_Stale123',v_owner,'cus_OwnerTest123','sub_OwnerTest123',
    'price_WeeklyTest123','account_weekly','past_due',null,null,
    now()-interval '8 days',now()-interval '1 day',false,null,null,
    'in_TestStale123','open',false
  );
  select snapshot.state,snapshot.access_allowed into v_state,v_allowed
  from public.billing_entitlement_snapshot(v_owner) snapshot;
  if v_state<>'cancel_scheduled' or not v_allowed then
    raise exception 'Out-of-order Stripe event overwrote newer entitlement state: %, %',v_state,v_allowed;
  end if;
  if not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id='evt_Stale123'
      and event.processing_state='processed'
      and event.last_error='stale_event_ignored'
  ) then raise exception 'Out-of-order event was not durably classified'; end if;

  perform public.billing_record_webhook_event(
    'evt_AutoSecondSub123','customer.subscription.created','sub_AutoSecondTest123',
    now()+interval '30 seconds',repeat('7',64),false
  );
  if not public.billing_duplicate_subscription_candidate(
    'evt_AutoSecondSub123',v_owner,'cus_OwnerTest123','sub_AutoSecondTest123',
    'active'
  ) then raise exception 'Canonical duplicate subscription was not selected for remediation'; end if;
  if not exists(
    select 1 from private.billing_duplicate_subscription_remediations remediation
    where remediation.stripe_subscription_id='sub_AutoSecondTest123'
      and remediation.state='cancel_pending'
      and remediation.provider_canceled_at is null
  ) then raise exception 'Duplicate provider-cancellation intent was not durable'; end if;
  if not public.billing_record_duplicate_subscription_remediation(
    'evt_AutoSecondSub123',v_owner,'cus_OwnerTest123','sub_AutoSecondTest123',
    'in_AutoSecondTest123',true,2000::bigint,'usd',now()
  ) then raise exception 'Provider duplicate cancellation evidence was not recorded'; end if;
  if not public.billing_duplicate_subscription_candidate(
    'evt_AutoSecondSub123',v_owner,'cus_OwnerTest123','sub_AutoSecondTest123',
    'canceled'
  ) then raise exception 'Canceled-provider retry lost its durable remediation intent'; end if;
  if not public.billing_apply_subscription_event(
    'evt_AutoSecondSub123',v_owner,'cus_OwnerTest123','sub_AutoSecondTest123',
    'price_WeeklyTest123','account_weekly','canceled',null,null,
    now(),now()+interval '7 days',false,null,now(),
    'in_AutoSecondTest123','paid',true
  ) then raise exception 'Canceled duplicate snapshot was not durably applied'; end if;
  if not exists(
    select 1 from private.billing_duplicate_subscription_remediations remediation
    where remediation.stripe_subscription_id='sub_AutoSecondTest123'
      and remediation.account_id=v_owner
      and remediation.state='provider_canceled'
      and remediation.refund_review_required
  ) or not exists(
    select 1 from private.billing_reconciliation_alerts alert
    where alert.alert_type='duplicate_subscription_refund_review'
      and alert.object_id='sub_AutoSecondTest123' and alert.resolved_at is null
  ) or not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id='evt_AutoSecondSub123'
      and event.processing_state='processed'
  ) then raise exception 'Automatic duplicate cancellation or refund-review audit is incomplete'; end if;
  select remediation.id into v_remediation_id
  from private.billing_duplicate_subscription_remediations remediation
  where remediation.stripe_subscription_id='sub_AutoSecondTest123';
  if v_remediation_id is null then
    raise exception 'Opaque duplicate refund remediation ID is missing';
  end if;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims','{"aal":"aal1"}',true);
  begin
    perform 1 from public.billing_admin_duplicate_refund_reviews(10);
    raise exception 'AAL1 administrator inspected duplicate refund reviews';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='AAL1 administrator inspected duplicate refund reviews' then raise; end if;
    if v_error<>'AAL2 required' then raise; end if;
  end;
  begin
    perform public.billing_admin_approve_duplicate_refund(
      v_remediation_id,'AAL1 duplicate refund approval must fail closed.'
    );
    raise exception 'AAL1 administrator approved a duplicate refund';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='AAL1 administrator approved a duplicate refund' then raise; end if;
    if v_error<>'AAL2 required' then raise; end if;
  end;
  perform set_config('request.jwt.claims','{"aal":"aal2"}',true);
  if not exists(
    select 1 from public.billing_admin_duplicate_refund_reviews(10) review
    where review.remediation_id=v_remediation_id
      and review.masked_email='o***@example.com'
      and review.amount_minor=2000 and review.currency='usd'
      and review.state='provider_canceled'
  ) then raise exception 'AAL2 duplicate refund review omitted its safe summary'; end if;
  v_refund_state:=public.billing_admin_approve_duplicate_refund(
    v_remediation_id,
    'Confirmed canonical accidental duplicate; approve exact full original-method refund.'
  );
  if v_refund_state<>'refund_pending' then
    raise exception 'AAL2 refund approval did not persist provider intent: %',v_refund_state;
  end if;
  v_refund_candidate:=public.billing_duplicate_refund_candidate_for_service(
    v_remediation_id
  );
  if v_refund_candidate->>'remediation_id'<>v_remediation_id::text
    or v_refund_candidate->>'account_id'<>v_owner::text
    or v_refund_candidate->>'refund_amount'<>'2000'
    or v_refund_candidate->>'refund_currency'<>'usd'
    or v_refund_candidate->>'state'<>'refund_pending' then
    raise exception 'Service refund candidate lost canonical durable evidence';
  end if;
  if not public.billing_bind_duplicate_refund_charge(
    v_remediation_id,v_owner,'cus_OwnerTest123','sub_AutoSecondTest123',
    'in_AutoSecondTest123','ch_AutoSecondTest123','pi_AutoSecondTest123',
    2000::bigint,'usd'
  ) then raise exception 'Canonical duplicate refund charge was not bound'; end if;
  perform public.billing_record_webhook_event(
    'evt_ExpectedRefund123','refund.created','re_AutoSecondTest123',
    now()+interval '31 seconds',repeat('a',64),false
  );
  if not public.billing_apply_expected_duplicate_refund_event(
    'evt_ExpectedRefund123',v_remediation_id,v_owner,'cus_OwnerTest123',
    'sub_AutoSecondTest123','in_AutoSecondTest123','ch_AutoSecondTest123',
    'pi_AutoSecondTest123','re_AutoSecondTest123',2000::bigint,'usd','pending','duplicate'
  ) then raise exception 'Expected pending duplicate refund event was not exempted'; end if;
  if not exists(
    select 1 from private.billing_duplicate_subscription_remediations remediation
    where remediation.id=v_remediation_id
      and remediation.state='provider_refund_pending'
      and remediation.refund_status='pending'
  ) or exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.source_event_id='evt_ExpectedRefund123'
  ) then raise exception 'Expected pending refund opened a generic hold or lost durable state'; end if;
  perform public.billing_record_webhook_event(
    'evt_ExpectedRefundDone123','refund.updated','re_AutoSecondTest123',
    now()+interval '32 seconds',repeat('b',64),false
  );
  if not public.billing_apply_expected_duplicate_refund_event(
    'evt_ExpectedRefundDone123',v_remediation_id,v_owner,'cus_OwnerTest123',
    'sub_AutoSecondTest123','in_AutoSecondTest123','ch_AutoSecondTest123',
    'pi_AutoSecondTest123','re_AutoSecondTest123',2000::bigint,'usd','succeeded','duplicate'
  ) then raise exception 'Expected succeeded duplicate refund event was not reconciled'; end if;
  if not exists(
    select 1 from private.billing_duplicate_subscription_remediations remediation
    where remediation.id=v_remediation_id
      and remediation.state='provider_refunded'
      and remediation.refund_status='succeeded'
      and not remediation.refund_review_required
      and remediation.provider_refunded_at is not null
  ) or exists(
    select 1 from private.billing_reconciliation_alerts alert
    where alert.alert_type='duplicate_subscription_refund_review'
      and alert.object_id='sub_AutoSecondTest123' and alert.resolved_at is null
  ) or exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.source_event_id in (
      'evt_ExpectedRefund123','evt_ExpectedRefundDone123'
    )
  ) then raise exception 'Expected duplicate refund did not reconcile without a hold'; end if;
  delete from private.billing_reconciliation_alerts alert
  where alert.object_id='sub_AutoSecondTest123';
  delete from private.billing_webhook_events event
  where event.stripe_event_id in (
    'evt_ExpectedRefund123','evt_ExpectedRefundDone123'
  );
  delete from private.billing_subscriptions sub
  where sub.stripe_subscription_id='sub_AutoSecondTest123';
  delete from private.billing_duplicate_subscription_remediations remediation
  where remediation.stripe_subscription_id='sub_AutoSecondTest123';
  delete from private.billing_webhook_events event
  where event.stripe_event_id='evt_AutoSecondSub123';

  perform public.billing_record_webhook_event(
    'evt_SecondSub123','customer.subscription.created','sub_SecondTest123',
    now()+interval '1 minute',repeat('8',64),false
  );
  if not public.billing_apply_subscription_event(
    'evt_SecondSub123',v_owner,'cus_OwnerTest123','sub_SecondTest123',
    'price_WeeklyTest123','account_weekly','active',null,null,
    now(),now()+interval '7 days',false,null,null,
    'in_TestSecond123','paid',true
  ) then raise exception 'Duplicate subscription detection did not return terminal success'; end if;
  if (select count(*) from private.billing_subscriptions where account_id=v_owner)<>1
    or exists(
      select 1 from private.billing_subscriptions sub
      where sub.stripe_subscription_id='sub_SecondTest123'
    ) or not exists(
      select 1 from private.billing_reconciliation_alerts alert
      where alert.account_id=v_owner
        and alert.alert_type='duplicate_renewable_subscription'
        and alert.object_id='sub_SecondTest123'
        and alert.severity='critical' and alert.resolved_at is null
    ) or not exists(
      select 1 from private.billing_webhook_events event
      where event.stripe_event_id='evt_SecondSub123'
        and event.processing_state='review_required'
        and event.last_error='duplicate_renewable_subscription'
    ) then
    raise exception 'Duplicate subscription was not durably dead-lettered without entitlement';
  end if;
  if not exists(
    select 1 from public.billing_reconciliation_candidates(5) candidate
    where candidate.account_id=v_owner
      and candidate.stripe_subscription_id='sub_OwnerTest123'
      and candidate.stripe_price_id='price_WeeklyTest123'
      and candidate.plan_code='account_weekly'
      and candidate.subscription_status='active'
      and candidate.cancel_at_period_end
      and candidate.latest_invoice_id='in_TestPaid123'
      and candidate.latest_invoice_status='paid'
      and candidate.latest_invoice_paid
      and not candidate.livemode
  ) then raise exception 'Reconciliation candidate omitted canonical scalar state'; end if;
  perform public.billing_record_webhook_event(
    'evt_UnknownPrice123','customer.subscription.updated','sub_OwnerTest123',
    now()+interval '2 minutes',repeat('5',64),false
  );
  if public.billing_apply_subscription_event(
    'evt_UnknownPrice123',v_owner,'cus_OwnerTest123','sub_OwnerTest123',
    'price_UnknownTest123','account_weekly','active',null,null,
    now(),now()+interval '7 days',false,null,null,
    'in_TestUnknownPrice123','paid',true
  ) then raise exception 'Unknown Price webhook was applied'; end if;
  if not exists(
    select 1 from private.billing_reconciliation_alerts alert
    where alert.alert_type='unknown_or_mismatched_price'
      and alert.object_id='sub_OwnerTest123' and alert.resolved_at is null
  ) or not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id='evt_UnknownPrice123'
      and event.processing_state='failed'
      and event.last_error='unknown_or_mismatched_price'
  ) then raise exception 'Unknown Price failure and alert were not durable'; end if;
  if (public.billing_account_deletion_guard(v_owner)->>'allowed')::boolean then
    raise exception 'Account deletion was allowed with a nonterminal subscription';
  end if;

  insert into private.billing_customers(
    account_id,stripe_customer_id,livemode
  ) values(v_delete,'cus_DeleteRetention123',false);
  insert into private.billing_subscriptions(
    stripe_subscription_id,account_id,stripe_customer_id,stripe_price_id,
    plan_code,status,trial_claim_verified,current_period_start,
    current_period_end,cancel_at_period_end,canceled_at,livemode,last_event_id,
    last_event_created_at
  ) values(
    'sub_DeleteRetention123',v_delete,'cus_DeleteRetention123',
    'price_YearlyTest123','account_yearly','canceled',false,
    now()-interval '1 year',now()-interval '1 day',true,now()-interval '1 day',
    false,'evt_DeleteRetention123',now()-interval '1 day'
  );
  insert into private.billing_trial_claims(
    account_id,email_fingerprint,fingerprint_key_id,claim_state,consumed_at,
    consumed_subscription_id
  ) values(
    v_delete,repeat('6',64),'k2026_08','consumed',now()-interval '1 year',
    'sub_DeleteRetention123'
  );
  if (public.billing_account_deletion_guard(v_delete)->>'code')
      <>'billing_customer_cleanup_required' then
    raise exception 'Terminal subscriber deletion did not request Customer cleanup';
  end if;
  v_checkout:=public.billing_begin_account_closure(
    v_delete,'50000000-0000-4000-8000-000000000001'
  );
  if (v_checkout->>'allowed')::boolean is not true
    or v_checkout->>'code'<>'billing_customer_cleanup_required' then
    raise exception 'Customer cleanup did not establish a fail-closed closure token: %',
      v_checkout;
  end if;
  v_checkout:=public.billing_customer_cleanup_candidate(
    v_delete,'50000000-0000-4000-8000-000000000001'
  );
  if (v_checkout->>'required')::boolean is not true
    or v_checkout->>'stripe_customer_id'<>'cus_DeleteRetention123' then
    raise exception 'Customer cleanup candidate was not exact: %',v_checkout;
  end if;
  if not public.billing_confirm_customer_deleted(
    v_delete,'50000000-0000-4000-8000-000000000001',
    'cus_DeleteRetention123'
  ) then raise exception 'Canonical Customer deletion could not be confirmed'; end if;
  if not public.billing_confirm_account_closure(
    v_delete,'50000000-0000-4000-8000-000000000001'
  ) then raise exception 'Retained financial closure did not become irreversible'; end if;
  v_checkout:=public.billing_customer_cleanup_candidate(
    v_delete,'50000000-0000-4000-8000-000000000001'
  );
  if (v_checkout->>'required')::boolean then
    raise exception 'Irreversible account-erasure retry repeated Customer deletion';
  end if;
  if not public.billing_complete_account_closure(
    v_delete,'50000000-0000-4000-8000-000000000001'
  ) then raise exception 'Retained financial closure did not complete'; end if;
  if not exists(
    select 1 from private.billing_customers customer
    where customer.account_id=v_delete and customer.provider_deleted_at is not null
      and customer.account_closed_at is not null
      and customer.retention_expires_at>customer.account_closed_at
  ) or not exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=v_delete and sub.account_closed_at is not null
      and sub.retention_expires_at>sub.account_closed_at
  ) or not exists(
    select 1 from private.billing_trial_claims claim
    where claim.account_id=v_delete and claim.retention_expires_at is not null
  ) then raise exception 'Seven-year closed-account retention was not recorded'; end if;
  update private.billing_customers set
    account_closed_at=now()-interval '8 years',
    retention_expires_at=now()-interval '1 day'
  where account_id=v_delete;
  update private.billing_subscriptions set
    account_closed_at=now()-interval '8 years',
    retention_expires_at=now()-interval '1 day'
  where account_id=v_delete;
  update private.billing_trial_claims set retention_expires_at=now()-interval '1 day'
  where account_id=v_delete;
  perform public.billing_run_retention(100);
  if exists(select 1 from private.billing_customers where account_id=v_delete)
    or exists(select 1 from private.billing_subscriptions where account_id=v_delete)
    or exists(select 1 from private.billing_trial_claims where account_id=v_delete)
    or public.billing_account_closure_state(v_delete)<>'deleted' then
    raise exception 'Expired retained billing rows were not purged behind the tombstone';
  end if;

  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims','{"aal":"aal2"}',true);
  perform public.billing_admin_grant_developer(
    v_admin,'Developer-only account deletion minimization regression.',
    now()+interval '1 day'
  );
  insert into private.billing_trial_claims(
    account_id,email_fingerprint,fingerprint_key_id,claim_state,
    reservation_expires_at
  ) values(v_admin,repeat('4',64),'k1','reserved',now()+interval '1 hour');
  insert into private.billing_checkout_reservations(
    request_key,lease_token,lease_expires_at,account_id,plan_code,
    trial_eligible,status,expires_at
  ) values(
    '40000000-0000-4000-8000-000000000009',
    '40000000-0000-4000-8000-000000000009',now()+interval '1 minute',
    v_admin,'account_yearly',true,'abandoned',now()+interval '1 hour'
  );
  if not (public.billing_account_deletion_guard(v_admin)->>'allowed')::boolean then
    raise exception 'Account deletion was blocked without a chargeable subscription';
  end if;
  v_checkout:=public.billing_begin_account_closure(
    v_admin,'40000000-0000-4000-8000-000000000001'
  );
  if (v_checkout->>'allowed')::boolean is not true
    or v_checkout->>'closure_token'<>'40000000-0000-4000-8000-000000000001' then
    raise exception 'Account closure tombstone was not established: %',v_checkout;
  end if;
  begin
    perform public.billing_admin_grant_developer(
      v_admin,'Closing accounts cannot receive a new developer entitlement.',
      now()+interval '2 days'
    );
    raise exception 'Closing account unexpectedly received developer access';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Closing account unexpectedly received developer access' then raise; end if;
    if v_error<>'ACCOUNT_CLOSURE_BLOCKS_DEVELOPER_ACCESS' then raise; end if;
  end;
  begin
    perform public.billing_prepare_checkout(
      v_admin,repeat('4',64),'k1',null,null,'[]'::jsonb,'account_yearly',
      '40000000-0000-4000-8000-000000000002',now()+interval '24 hours'
    );
    raise exception 'Closing account unexpectedly prepared Checkout';
  exception when others then
    get stacked diagnostics v_error = message_text;
    if v_error='Closing account unexpectedly prepared Checkout' then raise; end if;
    if v_error<>'Account closure is in progress' then raise; end if;
  end;
  if not public.billing_confirm_account_closure(
    v_admin,'40000000-0000-4000-8000-000000000001'
  ) then raise exception 'Account closure could not enter irreversible state'; end if;
  if public.account_has_billing_access(v_admin) then
    raise exception 'Closing account retained feature access';
  end if;
  if not public.billing_complete_account_closure(
    v_admin,'40000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Deleted account tombstone was not finalized';
  end if;
  if public.billing_account_closure_state(v_admin)<>'deleted' then
    raise exception 'Deleted account tombstone state was not retained';
  end if;
  if exists(select 1 from private.billing_developer_grants where account_id=v_admin)
    or exists(select 1 from private.billing_developer_grant_events where account_id=v_admin)
    or exists(select 1 from private.billing_access_transitions where account_id=v_admin)
    or exists(select 1 from private.billing_trial_claims where account_id=v_admin)
    or exists(select 1 from private.billing_checkout_reservations where account_id=v_admin) then
    raise exception 'Nonfinancial billing rows were not minimized during account deletion';
  end if;
end
$$;

-- The maintenance worker can discover an inactive account before a concurrent
-- access restoration commits. The restoring session owns the account lock;
-- maintenance must wait, recheck entitlement, and leave the row untouched.
insert into auth.users(id,email,email_confirmed_at) values(
  '10000000-0000-4000-8000-000000000004','race@example.com',now()
);
insert into public.profiles(id,email,display_name) values(
  '10000000-0000-4000-8000-000000000004','race@example.com','Race'
);
insert into public.ai_tasks(
  id,owner,cadence,schedule_time,timezone,lead_minutes,next_run_at,next_publish_at
) values(
  '30000000-0000-4000-8000-000000000400',
  '10000000-0000-4000-8000-000000000004','daily','09:00','UTC',60,
  now()-interval '2 hours',now()-interval '1 hour'
);
select dblink_connect('billing_restore_race','dbname=postgres user=postgres');
select dblink_send_query('billing_restore_race',$remote$
  do $race$
  begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      '10000000-0000-4000-8000-000000000004',6810068
    ));
    perform pg_sleep(0.6);
    insert into private.billing_developer_grants(
      account_id,reason,granted_by,expires_at
    ) values(
      '10000000-0000-4000-8000-000000000004',
      'Synthetic concurrent access restoration for lock-order regression.',
      '10000000-0000-4000-8000-000000000002',now()+interval '1 day'
    );
  end
  $race$;
$remote$);
select pg_sleep(0.15);
do $$
declare v_advanced integer;
begin
  v_advanced:=public.advance_suspended_ai_generation_tasks(now(),100);
  if v_advanced<>0 then
    raise exception 'Suspended maintenance mutated work after access was restored: %',v_advanced;
  end if;
end
$$;
select * from dblink_get_result('billing_restore_race') as result(status text);
select dblink_disconnect('billing_restore_race');
do $$begin
  if not public.account_has_billing_access('10000000-0000-4000-8000-000000000004')
    or not exists(
      select 1 from public.ai_tasks task
      where task.id='30000000-0000-4000-8000-000000000400'
        and task.next_run_at<=now() and task.last_status=''
    ) then
    raise exception 'Concurrent restoration regression did not preserve the newly entitled task';
  end if;
end$$;
delete from public.ai_tasks where id='30000000-0000-4000-8000-000000000400';
delete from private.billing_developer_grants
where account_id='10000000-0000-4000-8000-000000000004';
delete from public.profiles where id='10000000-0000-4000-8000-000000000004';
delete from auth.users where id='10000000-0000-4000-8000-000000000004';

-- Browser roles never receive direct access to the private billing schema.
set role authenticated;
do $$begin
  begin
    perform count(*) from private.billing_subscriptions;
    raise exception 'Authenticated role unexpectedly read the billing ledger';
  exception when insufficient_privilege then null;
  end;
end$$;
reset role;
