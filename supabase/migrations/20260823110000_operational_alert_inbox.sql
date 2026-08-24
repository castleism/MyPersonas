-- Staff operational alert inbox and bounded maintenance batches.
--
-- This forward-only migration intentionally stores no new provider secret and
-- sends no email or pager notification. It exposes only aggregate, redacted
-- alert categories to AAL2 staff and records maintenance heartbeats in the
-- existing security-event ledger. Provider scheduling remains a separate,
-- owner-approved operation.

begin;

create index if not exists platform_security_events_operations_heartbeat_idx
  on public.platform_security_events(created_at desc)
  where source='edge_function'
    and event_type='operations_maintenance_completed';
create index if not exists account_security_states_notification_pending_idx
  on public.account_security_states(updated_at desc)
  where notification_pending;
create index if not exists product_review_notifications_operations_idx
  on public.product_review_notifications(status,updated_at,created_at)
  where status in ('queued','claimed','failed','reconciliation_required');

-- The historical no-argument cleanup functions remain available for manual
-- compatibility. Scheduled maintenance uses these separately named functions
-- so every delete category has a hard per-run ceiling.
create or replace function public.prune_product_review_rate_limits_batch_service(
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer:=least(greatest(coalesce(p_limit,500),1),1000);
  v_deleted integer:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(69051001);
  with doomed as (
    select limiter.scope,limiter.key_hash,limiter.window_start
    from public.product_review_rate_limits limiter
    where limiter.expires_at<pg_catalog.clock_timestamp()
    order by limiter.expires_at,limiter.scope,limiter.key_hash,limiter.window_start
    limit v_limit for update skip locked
  )
  delete from public.product_review_rate_limits limiter using doomed
  where limiter.scope=doomed.scope
    and limiter.key_hash=doomed.key_hash
    and limiter.window_start=doomed.window_start;
  get diagnostics v_deleted=row_count;
  return v_deleted;
end;
$$;

create or replace function public.purge_affiliate_click_retention_batch_service(
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer:=least(greatest(coalesce(p_limit,500),1),1000);
  v_rate_count integer:=0;
  v_event_count integer:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(69051002);
  with doomed as (
    select limiter.scope,limiter.key_hash,limiter.window_start
    from public.affiliate_click_rate_limits limiter
    where limiter.expires_at<pg_catalog.clock_timestamp()
    order by limiter.expires_at,limiter.scope,limiter.key_hash,limiter.window_start
    limit v_limit for update skip locked
  )
  delete from public.affiliate_click_rate_limits limiter using doomed
  where limiter.scope=doomed.scope
    and limiter.key_hash=doomed.key_hash
    and limiter.window_start=doomed.window_start;
  get diagnostics v_rate_count=row_count;

  with doomed as (
    select event.id from public.affiliate_click_events event
    where event.created_at<pg_catalog.clock_timestamp()-interval '400 days'
    order by event.created_at,event.id
    limit v_limit for update skip locked
  )
  delete from public.affiliate_click_events event using doomed
  where event.id=doomed.id;
  get diagnostics v_event_count=row_count;
  return jsonb_build_object(
    'rate_rows_deleted',v_rate_count,
    'event_rows_deleted',v_event_count
  );
end;
$$;

create or replace function public.purge_governance_security_retention_batch_service(
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer:=least(greatest(coalesce(p_limit,500),1),1000);
  v_friend_events integer:=0;
  v_security_events integer:=0;
  v_expired_invites integer:=0;
  v_expired_blocks integer:=0;
  v_expired_review_requests integer:=0;
  v_expired_feature_requests integer:=0;
  v_expired_extensions integer:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(69051003);

  with doomed as (
    select event.id from public.friend_request_security_events event
    where event.created_at<now()-interval '90 days'
    order by event.created_at,event.id
    limit v_limit for update skip locked
  )
  delete from public.friend_request_security_events event using doomed
  where event.id=doomed.id;
  get diagnostics v_friend_events=row_count;

  with doomed as (
    select event.id from public.platform_security_events event
    where event.created_at<now()-interval '400 days'
    order by event.created_at,event.id
    limit v_limit for update skip locked
  )
  delete from public.platform_security_events event using doomed
  where event.id=doomed.id;
  get diagnostics v_security_events=row_count;

  with doomed as (
    select invite.id from public.persona_friend_invites invite
    where invite.created_at<now()-interval '30 days'
      and (invite.expires_at<now() or invite.revoked_at is not null
        or invite.use_count>=invite.max_uses)
    order by invite.created_at,invite.id
    limit v_limit for update skip locked
  )
  delete from public.persona_friend_invites invite using doomed
  where invite.id=doomed.id;
  get diagnostics v_expired_invites=row_count;

  with doomed as (
    select block.identifier_hash from public.security_network_blocks block
    where block.expires_at is not null
      and block.expires_at<now()-interval '30 days'
    order by block.expires_at,block.identifier_hash
    limit v_limit for update skip locked
  )
  delete from public.security_network_blocks block using doomed
  where block.identifier_hash=doomed.identifier_hash;
  get diagnostics v_expired_blocks=row_count;

  with doomed as (
    select request.id from public.product_review_requests request
    where request.retention_expires_at<=now()
    order by request.retention_expires_at,request.id
    limit v_limit for update skip locked
  )
  delete from public.product_review_requests request using doomed
  where request.id=doomed.id;
  get diagnostics v_expired_review_requests=row_count;

  with doomed as (
    select request.id from public.platform_feature_requests request
    where (request.status='draft' and request.updated_at<now()-interval '90 days')
       or (request.status in ('withdrawn','declined','completed')
         and request.updated_at<now()-interval '400 days')
    order by request.updated_at,request.id
    limit v_limit for update skip locked
  )
  delete from public.platform_feature_requests request using doomed
  where request.id=doomed.id;
  get diagnostics v_expired_feature_requests=row_count;

  with doomed as (
    select submission.id from public.persona_extension_submissions submission
    where (submission.status in ('draft','withdrawn')
          and submission.updated_at<now()-interval '90 days')
       or (submission.status='rejected'
          and submission.updated_at<now()-interval '400 days')
    order by submission.updated_at,submission.id
    limit v_limit for update skip locked
  )
  delete from public.persona_extension_submissions submission using doomed
  where submission.id=doomed.id;
  get diagnostics v_expired_extensions=row_count;

  return jsonb_build_object(
    'friend_request_events',v_friend_events,
    'security_events',v_security_events,
    'friend_invites',v_expired_invites,
    'network_blocks',v_expired_blocks,
    'product_review_requests',v_expired_review_requests,
    'feature_requests',v_expired_feature_requests,
    'extension_submissions',v_expired_extensions
  );
end;
$$;

revoke all on function public.prune_product_review_rate_limits_batch_service(integer),
  public.purge_affiliate_click_retention_batch_service(integer),
  public.purge_governance_security_retention_batch_service(integer)
  from public,anon,authenticated;
grant execute on function public.prune_product_review_rate_limits_batch_service(integer),
  public.purge_affiliate_click_retention_batch_service(integer),
  public.purge_governance_security_retention_batch_service(integer)
  to service_role;

-- Billing migration 068 is developed and released separately. Dynamic SQL is
-- limited to a constant query so 069 can be staged on an opaque-media branch
-- before 068 is merged; it returns no rows until the private alert table exists.
-- No object id, account id, provider id, or free-form detail is projected.
create or replace function public.operational_billing_alerts_service()
returns table(
  alert_key text,
  source text,
  category text,
  severity text,
  occurrence_count bigint,
  first_seen timestamptz,
  last_seen timestamptz,
  requires_global_admin boolean,
  safe_action_code text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not public.has_platform_role(array['global_administrator']::text[]) then
    return;
  end if;
  if pg_catalog.to_regclass('private.billing_reconciliation_alerts') is null then
    return;
  end if;
  return query execute $billing_alerts$
    with categorized as (
      select
        case
          when alert.alert_type in (
            'environment_mismatch','event_id_payload_conflict',
            'webhook_retry_exhausted'
          ) then 'billing_webhook_integrity'
          when alert.alert_type='closed_account_financial_event'
            then 'billing_closed_account'
          when alert.alert_type in (
            'duplicate_renewable_subscription',
            'duplicate_subscription_refund_review'
          ) then 'billing_duplicate_subscription'
          when alert.alert_type='unknown_or_mismatched_price'
            then 'billing_catalog'
          when alert.alert_type in (
            'unproven_financial_event_linkage',
            'unproven_financial_customer_binding','financial_event_hold',
            'manual_financial_event_review'
          ) then 'billing_financial_review'
          when alert.alert_type in (
            'billing_subscription_drift','billing_reconciliation_unavailable'
          ) then 'billing_reconciliation'
          else 'billing_other'
        end::text as safe_category,
        alert.severity,alert.created_at
      from private.billing_reconciliation_alerts alert
      where alert.resolved_at is null
    ), grouped as (
      select safe_category,severity,count(*)::bigint as occurrence_count,
        min(created_at) as first_seen,max(created_at) as last_seen
      from categorized group by safe_category,severity
    )
    select
      ('billing:'||safe_category||':'||severity)::text,
      'billing'::text,safe_category,severity,occurrence_count,
      first_seen,last_seen,true,
      case safe_category
        when 'billing_webhook_integrity' then 'review_billing_webhook_pipeline'
        when 'billing_closed_account' then 'reconcile_closed_account_finance'
        when 'billing_duplicate_subscription' then 'review_duplicate_subscription'
        when 'billing_catalog' then 'review_billing_catalog'
        when 'billing_financial_review' then 'reconcile_financial_hold'
        when 'billing_reconciliation' then 'run_billing_reconciliation'
        else 'review_billing_reconciliation'
      end::text
    from grouped
  $billing_alerts$;
end;
$$;

revoke all on function public.operational_billing_alerts_service()
  from public,anon,authenticated,service_role;

create or replace function public.staff_operational_alerts(
  p_before_created_at timestamptz default null,
  p_before_alert_key text default null,
  p_limit integer default 100
)
returns table(
  alert_key text,
  source text,
  category text,
  severity text,
  occurrence_count bigint,
  first_seen timestamptz,
  last_seen timestamptz,
  requires_global_admin boolean,
  safe_action_code text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_limit integer:=least(greatest(coalesce(p_limit,100),1),200);
  v_global_admin boolean:=false;
  v_technician boolean:=false;
begin
  perform public.require_aal2();
  if (p_before_created_at is null)<> (p_before_alert_key is null)
     or (p_before_alert_key is not null and (
       char_length(p_before_alert_key)>200
       or p_before_alert_key!~'^[a-z0-9:_-]+$'
     )) then
    raise sqlstate '22023' using message='Invalid alert cursor';
  end if;
  v_global_admin:=public.has_platform_role(array['global_administrator']::text[]);
  v_technician:=public.has_platform_role(array['technician']::text[]);
  if not v_global_admin and not v_technician then
    raise sqlstate '42501' using message='Active staff role required';
  end if;

  return query
  with alert_rows as (
    select billing.* from public.operational_billing_alerts_service() billing
    where v_global_admin

    union all
    select
      ('security:'||event.source||':'||event.severity)::text,
      'security'::text,'platform_security_event'::text,event.severity,
      count(*)::bigint,min(event.created_at),max(event.created_at),false,
      'review_security_events'::text
    from public.platform_security_events event
    where event.severity in ('high','critical')
      and event.created_at>=now()-interval '24 hours'
    group by event.source,event.severity

    union all
    select
      'account-security:notification-pending'::text,
      'security'::text,'account_security_notification'::text,'high'::text,
      count(*)::bigint,min(state.updated_at),max(state.updated_at),false,
      'notify_locked_accounts'::text
    from public.account_security_states state
    where state.notification_pending
    having count(*)>0

    union all
    select
      'review-notification:stalled'::text,
      'review_intake'::text,'review_notification_stalled'::text,'high'::text,
      count(*)::bigint,min(notification.created_at),max(notification.updated_at),
      false,'review_product_notification_queue'::text
    from public.product_review_notifications notification
    where (notification.status='queued'
          and notification.available_at<now()-interval '15 minutes')
       or (notification.status='claimed'
          and coalesce(notification.claimed_at,notification.updated_at)
            <now()-interval '15 minutes')
    having count(*)>0

    union all
    select
      ('review-notification:'||notification.status)::text,
      'review_intake'::text,
      case notification.status when 'failed' then 'review_notification_failed'
        else 'review_notification_reconciliation' end::text,
      case notification.status when 'reconciliation_required' then 'critical'
        else 'high' end::text,
      count(*)::bigint,min(notification.created_at),max(notification.updated_at),
      false,'review_product_notification_queue'::text
    from public.product_review_notifications notification
    where notification.status in ('failed','reconciliation_required')
    group by notification.status

    union all
    select
      'client-errors:recent-volume'::text,
      'client_error'::text,'client_error_volume'::text,
      case when bool_or(log.severity='critical') then 'critical'
        else 'high' end::text,
      count(*)::bigint,min(log.created_at),max(log.created_at),false,
      'review_client_error_volume'::text
    from public.error_logs log
    where log.created_at>=now()-interval '1 hour'
    having count(*)>=5 or bool_or(log.severity='critical')

    union all
    select
      'operations:maintenance:stale'::text,
      'maintenance'::text,'retention_heartbeat_stale'::text,'high'::text,
      1::bigint,
      coalesce(heartbeat.last_success,now()-interval '36 hours'),now(),false,
      'run_operations_maintenance'::text
    from (
      select max(event.created_at) as last_success
      from public.platform_security_events event
      where event.source='edge_function'
        and event.event_type='operations_maintenance_completed'
    ) heartbeat
    where heartbeat.last_success is null
       or heartbeat.last_success<now()-interval '36 hours'
  ), filtered as (
    select candidate.* from alert_rows candidate
    where p_before_created_at is null
       or (candidate.last_seen,candidate.alert_key)<
          (p_before_created_at,coalesce(p_before_alert_key,''))
  )
  select candidate.alert_key,candidate.source,candidate.category,
    candidate.severity,candidate.occurrence_count,candidate.first_seen,
    candidate.last_seen,candidate.requires_global_admin,
    candidate.safe_action_code
  from filtered candidate
  order by candidate.last_seen desc,candidate.alert_key desc
  limit v_limit;
end;
$$;

revoke all on function public.staff_operational_alerts(
  timestamptz,text,integer
) from public,anon;
grant execute on function public.staff_operational_alerts(
  timestamptz,text,integer
) to authenticated;

comment on function public.staff_operational_alerts(timestamptz,text,integer) is
  'AAL2 staff-only, read-only aggregate alert inbox. It never projects provider identifiers, account identifiers, hashes, raw errors, metadata, or billing details.';
comment on function public.prune_product_review_rate_limits_batch_service(integer) is
  'Service-only bounded product-review limiter cleanup for the operations maintenance worker.';
comment on function public.purge_affiliate_click_retention_batch_service(integer) is
  'Service-only bounded affiliate telemetry cleanup for the operations maintenance worker.';
comment on function public.purge_governance_security_retention_batch_service(integer) is
  'Service-only bounded governance and security cleanup for the operations maintenance worker.';

commit;
