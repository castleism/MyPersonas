select set_config('request.jwt.claim.role','service_role',false);
select set_config('app.staging.expected_environment',:'environment_name',false);
select set_config('app.staging.expected_supabase_origin',:'supabase_origin',false);
select set_config('app.staging.expected_public_media_origin',:'public_media_origin',false);

do $verify_068_069$
declare
  v_config record;
  v_runtime record;
  v_versions text[];
  v_expected_versions constant text[]:=array[
    '20260823035000',
    '20260823040000',
    '20260823050000',
    '20260823060000',
    '20260823100000',
    '20260823110000'
  ];
  v_plans jsonb;
  v_operations_schedule boolean:=false;
begin
  select coalesce(
    array_agg(migration.version::text order by migration.version::text),
    array[]::text[]
  ) into v_versions
  from supabase_migrations.schema_migrations migration;
  if v_versions<>v_expected_versions then
    raise exception
      'Staging ledger is not exactly baseline, 062-064, 068, and 069: %',
      v_versions;
  end if;

  select * into strict v_config from public.media_environment_config_service();
  if v_config.environment_name<>current_setting('app.staging.expected_environment')
     or v_config.supabase_origin<>current_setting('app.staging.expected_supabase_origin')
     or v_config.public_media_origin<>current_setting('app.staging.expected_public_media_origin')
     or v_config.locked_at is null then
    raise exception 'Locked staging media environment changed during 068-069 release';
  end if;
  if to_regclass('public.post_approved_media_handles') is null
     or to_regprocedure('public.inventory_legacy_media_references_service(uuid,integer)') is null then
    raise exception 'Opaque media 063-064 prerequisites no longer verify';
  end if;

  if to_regclass('private.billing_runtime_config') is null
     or to_regclass('private.billing_plan_catalog') is null
     or to_regclass('private.billing_customers') is null
     or to_regclass('private.billing_subscriptions') is null
     or to_regclass('private.billing_duplicate_subscription_remediations') is null
     or to_regprocedure('public.billing_entitlement_snapshot(uuid)') is null
     or to_regprocedure('public.billing_run_retention(integer)') is null
     or to_regprocedure('public.billing_admin_approve_duplicate_refund(uuid,text)') is null then
    raise exception 'Migration 068 billing boundary is incomplete';
  end if;

  select * into strict v_runtime from private.billing_runtime_config where singleton;
  if v_runtime.enforcement_enabled
     or v_runtime.checkout_enabled
     or v_runtime.livemode
     or v_runtime.updated_by is not null then
    raise exception 'Billing must remain unactivated in shadow/test-safe staging state';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'plan_code',catalog.plan_code,
      'amount_minor',catalog.amount_minor,
      'currency',catalog.currency,
      'recurring_interval',catalog.recurring_interval,
      'interval_count',catalog.interval_count,
      'stripe_price_id',catalog.stripe_price_id,
      'livemode',catalog.livemode,
      'active',catalog.active
    ) order by catalog.plan_code
  ) into v_plans
  from private.billing_plan_catalog catalog;
  if v_plans<>jsonb_build_array(
    jsonb_build_object(
      'plan_code','account_monthly','amount_minor',5000,'currency','usd',
      'recurring_interval','month','interval_count',1,
      'stripe_price_id',null,'livemode',false,'active',true
    ),
    jsonb_build_object(
      'plan_code','account_weekly','amount_minor',2000,'currency','usd',
      'recurring_interval','week','interval_count',1,
      'stripe_price_id',null,'livemode',false,'active',true
    ),
    jsonb_build_object(
      'plan_code','account_yearly','amount_minor',33300,'currency','usd',
      'recurring_interval','year','interval_count',1,
      'stripe_price_id',null,'livemode',false,'active',true
    )
  ) then
    raise exception 'Billing plan catalog is not the reviewed unbound staging catalog: %',v_plans;
  end if;

  if exists(select 1 from private.billing_customers)
     or exists(select 1 from private.billing_trial_claims)
     or exists(select 1 from private.billing_checkout_reservations)
     or exists(select 1 from private.billing_subscriptions)
     or exists(select 1 from private.billing_webhook_events)
     or exists(select 1 from private.billing_financial_holds)
     or exists(select 1 from private.billing_duplicate_subscription_remediations)
     or exists(select 1 from private.billing_reconciliation_alerts) then
    raise exception 'Billing/provider rows were unexpectedly created by the schema release';
  end if;

  if has_schema_privilege('anon','private','USAGE')
     or has_schema_privilege('authenticated','private','USAGE')
     or has_table_privilege('anon','private.billing_runtime_config','SELECT')
     or has_table_privilege('authenticated','private.billing_plan_catalog','SELECT') then
    raise exception 'Browser roles can access private billing schema objects';
  end if;
  if not has_function_privilege('service_role','public.billing_run_retention(integer)','EXECUTE')
     or has_function_privilege('anon','public.billing_run_retention(integer)','EXECUTE')
     or not has_function_privilege('authenticated','public.billing_admin_approve_duplicate_refund(uuid,text)','EXECUTE')
     or has_function_privilege('anon','public.billing_admin_approve_duplicate_refund(uuid,text)','EXECUTE') then
    raise exception 'Migration 068 function grants do not match the reviewed service/AAL2 boundary';
  end if;
  if public.billing_enforcement_enabled() then
    raise exception 'Billing entitlement enforcement unexpectedly reports enabled';
  end if;

  if to_regclass('public.platform_security_events_operations_heartbeat_idx') is null
     or to_regclass('public.account_security_states_notification_pending_idx') is null
     or to_regclass('public.product_review_notifications_operations_idx') is null
     or to_regprocedure('public.prune_product_review_rate_limits_batch_service(integer)') is null
     or to_regprocedure('public.purge_affiliate_click_retention_batch_service(integer)') is null
     or to_regprocedure('public.purge_governance_security_retention_batch_service(integer)') is null
     or to_regprocedure('public.operational_billing_alerts_service()') is null
     or to_regprocedure('public.staff_operational_alerts(timestamp with time zone,text,integer)') is null then
    raise exception 'Migration 069 operational alert/retention boundary is incomplete';
  end if;
  if not has_function_privilege(
       'authenticated',
       'public.staff_operational_alerts(timestamp with time zone,text,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.staff_operational_alerts(timestamp with time zone,text,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.prune_product_review_rate_limits_batch_service(integer)',
       'EXECUTE'
     ) then
    raise exception 'Migration 069 grants do not match the staff/service boundary';
  end if;

  if to_regclass('cron.job') is not null then
    execute $cron_check$
      select exists(
        select 1 from cron.job
        where jobname ilike '%mypersonas%operations%'
           or command ilike '%run-operations-maintenance%'
      )
    $cron_check$ into v_operations_schedule;
  end if;
  if v_operations_schedule then
    raise exception 'Operations provider scheduling was activated by a schema-only staging release';
  end if;
end
$verify_068_069$;

select jsonb_build_object(
  'phase','068-069',
  'schema_ready',true,
  'migration_versions',(
    select jsonb_agg(migration.version::text order by migration.version::text)
    from supabase_migrations.schema_migrations migration
  ),
  'deferred_migrations_excluded',jsonb_build_array('065','066','067'),
  'billing',jsonb_build_object(
    'enforcement_enabled',runtime.enforcement_enabled,
    'checkout_enabled',runtime.checkout_enabled,
    'livemode',runtime.livemode,
    'catalog_rows',(select count(*) from private.billing_plan_catalog),
    'customer_rows',(select count(*) from private.billing_customers),
    'subscription_rows',(select count(*) from private.billing_subscriptions),
    'provider_price_bindings',(
      select count(*) from private.billing_plan_catalog where stripe_price_id is not null
    )
  ),
  'operations',jsonb_build_object(
    'alert_inbox_installed',to_regprocedure(
      'public.staff_operational_alerts(timestamp with time zone,text,integer)'
    ) is not null,
    'database_schedule_detected',false
  ),
  'opaque_media',jsonb_build_object(
    'environment_name',config.environment_name,
    'supabase_origin',config.supabase_origin,
    'public_media_origin',config.public_media_origin,
    'locked',config.locked_at is not null
  )
)::text
from private.billing_runtime_config runtime
cross join public.media_environment_config_service() config
where runtime.singleton;
