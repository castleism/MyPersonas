-- MyPersonas account subscriptions and server-authoritative entitlements.
--
-- This migration is intentionally shadow-mode by default. It installs the
-- billing ledger and every enforcement hook, but existing behavior remains
-- unchanged until private.billing_runtime_config.enforcement_enabled is set by
-- an explicitly approved production SQL change. Stripe identifiers and billing
-- history live outside the exposed public schema. Browser roles receive only
-- narrow, self-scoped or AAL2 global-administrator RPCs.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.billing_runtime_config (
  singleton boolean primary key default true check (singleton),
  enforcement_enabled boolean not null default false,
  checkout_enabled boolean not null default false,
  livemode boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (not enforcement_enabled or updated_by is not null),
  check (not checkout_enabled or enforcement_enabled)
);
insert into private.billing_runtime_config(
  singleton,enforcement_enabled,checkout_enabled,livemode
)
values (true,false,false,false)
on conflict (singleton) do nothing;

create or replace function private.protect_billing_runtime_config_singleton()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception using
    errcode='55000',
    message='BILLING_RUNTIME_CONFIG_SINGLETON_REQUIRED',
    detail='The billing runtime configuration row cannot be deleted or truncated.';
end;
$$;
revoke all on function private.protect_billing_runtime_config_singleton()
  from public,anon,authenticated,service_role;
drop trigger if exists billing_runtime_config_protect_delete
  on private.billing_runtime_config;
create trigger billing_runtime_config_protect_delete
before delete on private.billing_runtime_config
for each row execute function private.protect_billing_runtime_config_singleton();
drop trigger if exists billing_runtime_config_protect_truncate
  on private.billing_runtime_config;
create trigger billing_runtime_config_protect_truncate
before truncate on private.billing_runtime_config
for each statement execute function private.protect_billing_runtime_config_singleton();

create table if not exists private.billing_plan_catalog (
  plan_code text primary key check (plan_code in (
    'account_weekly','account_monthly','account_yearly'
  )),
  amount_minor integer not null check (amount_minor > 0),
  currency text not null check (currency = 'usd'),
  recurring_interval text not null check (recurring_interval in ('week','month','year')),
  interval_count integer not null default 1 check (interval_count = 1),
  stripe_price_id text unique,
  livemode boolean not null default false,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9]+$')
);
insert into private.billing_plan_catalog(
  plan_code,amount_minor,currency,recurring_interval,interval_count
) values
  ('account_weekly',2000,'usd','week',1),
  ('account_monthly',5000,'usd','month',1),
  ('account_yearly',33300,'usd','year',1)
on conflict (plan_code) do update set
  amount_minor=excluded.amount_minor,
  currency=excluded.currency,
  recurring_interval=excluded.recurring_interval,
  interval_count=excluded.interval_count;

create table if not exists private.billing_customers (
  account_id uuid primary key,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  livemode boolean not null,
  provider_deleted_at timestamptz,
  account_closed_at timestamptz,
  retention_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (provider_deleted_at is null or provider_deleted_at>=created_at),
  check ((account_closed_at is null and retention_expires_at is null)
    or (account_closed_at is not null and retention_expires_at>account_closed_at))
);

create table if not exists private.billing_account_closures (
  account_id uuid primary key,
  closure_token uuid not null unique,
  state text not null default 'closing' check (state in ('closing','deleted')),
  started_at timestamptz not null default now(),
  irreversible_started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((state='closing' and completed_at is null) or (state='deleted' and completed_at is not null))
);

comment on table private.billing_account_closures is
  'UUID-only fail-closed tombstones that serialize Checkout against full account erasure. Deleted tombstones are retained for late financial-event handling.';

create table if not exists private.billing_trial_claims (
  account_id uuid primary key,
  email_fingerprint text not null unique
    check (email_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_key_id text not null
    check (fingerprint_key_id ~ '^[a-z][a-z0-9_-]{0,31}$'),
  fingerprint_rotated_at timestamptz,
  claim_state text not null check (claim_state in ('reserved','consumed')),
  reserved_at timestamptz not null default now(),
  reservation_expires_at timestamptz,
  consumed_at timestamptz,
  consumed_subscription_id text,
  retention_expires_at timestamptz,
  last_checkout_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (claim_state='reserved' and consumed_at is null
      and retention_expires_at is null)
    or (claim_state='consumed' and consumed_at is not null)
  )
);

comment on table private.billing_trial_claims is
  'Versioned keyed email anti-abuse tombstones. No raw email is stored. A presented verified email is checked under the current and optional previous key, and a previous-key match is atomically rewritten under the current key.';

create table if not exists private.billing_checkout_reservations (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  account_id uuid not null,
  plan_code text not null references private.billing_plan_catalog(plan_code),
  trial_eligible boolean not null,
  status text not null default 'reserved'
    check (status in ('reserved','provider_pending','session_created','completed','expired','abandoned')),
  stripe_checkout_session_id text unique,
  stripe_subscription_id text unique
    check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (lease_expires_at <= expires_at),
  check (stripe_checkout_session_id is null or stripe_checkout_session_id ~ '^cs_(test_|live_)?[A-Za-z0-9]+$')
);
create index if not exists billing_checkout_reservations_account_created_idx
  on private.billing_checkout_reservations(account_id,created_at desc);
create unique index if not exists billing_checkout_reservations_one_active_account_idx
  on private.billing_checkout_reservations(account_id)
  where status in ('reserved','provider_pending','session_created');

create table if not exists private.billing_subscriptions (
  stripe_subscription_id text primary key check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  account_id uuid not null,
  stripe_customer_id text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_price_id text not null check (stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  plan_code text not null references private.billing_plan_catalog(plan_code),
  status text not null check (status in (
    'incomplete','incomplete_expired','trialing','active','past_due',
    'canceled','unpaid','paused'
  )),
  trial_claim_verified boolean not null default false,
  trial_start timestamptz,
  trial_end timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  cancel_at timestamptz,
  canceled_at timestamptz,
  latest_invoice_id text,
  latest_invoice_status text not null default '',
  latest_invoice_paid boolean not null default false,
  livemode boolean not null,
  last_event_id text not null,
  last_event_created_at timestamptz not null,
  last_reconciled_at timestamptz,
  last_reconciliation_result text
    check (last_reconciliation_result is null or last_reconciliation_result in ('current','drifted','unavailable')),
  account_closed_at timestamptz,
  retention_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((account_closed_at is null and retention_expires_at is null)
    or (account_closed_at is not null and retention_expires_at>account_closed_at))
);
create index if not exists billing_subscriptions_account_updated_idx
  on private.billing_subscriptions(account_id,updated_at desc);
create index if not exists billing_subscriptions_customer_idx
  on private.billing_subscriptions(stripe_customer_id,updated_at desc);

create table if not exists private.billing_webhook_events (
  stripe_event_id text primary key check (stripe_event_id ~ '^evt_[A-Za-z0-9]+$'),
  event_type text not null check (char_length(event_type) between 3 and 160),
  object_id text not null default '' check (char_length(object_id) <= 255),
  event_created_at timestamptz not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  livemode boolean not null,
  processing_state text not null default 'processing'
    check (processing_state in ('processing','processed','ignored','failed','review_required')),
  attempt_count integer not null default 1 check (attempt_count between 1 and 1000),
  last_error text not null default '' check (char_length(last_error) <= 1000),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists billing_webhook_events_unfinished_idx
  on private.billing_webhook_events(received_at)
  where processing_state in ('processing','failed');

create table if not exists private.billing_financial_holds (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  stripe_customer_id text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_subscription_id text
    check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  stripe_invoice_id text
    check (stripe_invoice_id is null or stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  evidence_level text not null default 'exact_subscription'
    check (evidence_level in ('exact_subscription','customer_binding')),
  provider_object_type text not null
    check (provider_object_type in ('charge','refund','dispute')),
  provider_object_id text not null,
  source_event_id text not null unique
    references private.billing_webhook_events(stripe_event_id),
  event_type text not null check (char_length(event_type) between 3 and 160),
  state text not null default 'open' check (state in ('open','reconciled')),
  opened_at timestamptz not null default now(),
  reconciled_at timestamptz,
  reconciled_by uuid,
  reconcile_reason text not null default '' check (char_length(reconcile_reason) <= 1000),
  updated_at timestamptz not null default now(),
  check (
    (provider_object_type='charge' and provider_object_id ~ '^ch_[A-Za-z0-9]+$')
    or (provider_object_type='refund' and provider_object_id ~ '^re_[A-Za-z0-9]+$')
    or (provider_object_type='dispute' and provider_object_id ~ '^du_[A-Za-z0-9]+$')
  ),
  check (
    (evidence_level='exact_subscription' and stripe_subscription_id is not null
      and stripe_invoice_id is not null)
    or (evidence_level='customer_binding' and stripe_subscription_id is null
      and stripe_invoice_id is null)
  ),
  check (
    (state='open' and reconciled_at is null and reconciled_by is null
      and reconcile_reason='')
    or (state='reconciled' and reconciled_at is not null
      and reconciled_by is not null and char_length(reconcile_reason) between 10 and 1000)
  )
);
create index if not exists billing_financial_holds_account_open_idx
  on private.billing_financial_holds(account_id,opened_at desc)
  where state='open';

create table if not exists private.billing_developer_grants (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  reason text not null check (char_length(reason) between 10 and 1000),
  granted_by uuid not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text not null default '' check (char_length(revoke_reason) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at),
  check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);
create unique index if not exists billing_developer_grants_one_open_idx
  on private.billing_developer_grants(account_id) where revoked_at is null;

create table if not exists private.billing_developer_grant_events (
  id bigint generated always as identity primary key,
  grant_id uuid not null,
  account_id uuid not null,
  actor_id uuid not null,
  action text not null check (action in ('granted','revoked')),
  reason text not null check (char_length(reason) between 10 and 1000),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists private.billing_access_transitions (
  id bigint generated always as identity primary key,
  account_id uuid not null,
  previous_state text not null,
  new_state text not null,
  cause text not null check (char_length(cause) between 1 and 160),
  stripe_event_id text,
  actor_id uuid,
  metadata jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 10000),
  created_at timestamptz not null default now()
);
create index if not exists billing_access_transitions_account_idx
  on private.billing_access_transitions(account_id,created_at desc);

create table if not exists private.billing_reconciliation_alerts (
  id bigint generated always as identity primary key,
  account_id uuid,
  alert_type text not null check (char_length(alert_type) between 3 and 100),
  severity text not null check (severity in ('warning','high','critical')),
  object_id text not null default '' check (char_length(object_id) <= 255),
  detail text not null default '' check (char_length(detail) <= 1000),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists billing_reconciliation_alerts_open_idx
  on private.billing_reconciliation_alerts(severity,created_at)
  where resolved_at is null;
create unique index if not exists billing_reconciliation_alerts_open_type_object_idx
  on private.billing_reconciliation_alerts(alert_type,object_id)
  where resolved_at is null;

create table if not exists private.billing_duplicate_subscription_remediations (
  id uuid not null default extensions.gen_random_uuid() unique,
  stripe_subscription_id text primary key
    check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  account_id uuid not null,
  stripe_customer_id text not null
    check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  source_event_id text not null unique
    references private.billing_webhook_events(stripe_event_id),
  state text not null default 'cancel_pending'
    check (state in (
      'cancel_pending','provider_canceled','refund_pending',
      'provider_refund_pending','provider_refunded','refund_review_required'
    )),
  stripe_invoice_id text
    check (stripe_invoice_id is null or stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  stripe_charge_id text
    check (stripe_charge_id is null or stripe_charge_id ~ '^ch_[A-Za-z0-9]+$'),
  stripe_payment_intent_id text check (
    stripe_payment_intent_id is null
    or stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]+$'
  ),
  stripe_refund_id text unique
    check (stripe_refund_id is null or stripe_refund_id ~ '^re_[A-Za-z0-9]+$'),
  refund_amount bigint check (
    refund_amount is null or refund_amount between 1 and 1000000000
  ),
  refund_currency text check (
    refund_currency is null or refund_currency ~ '^[a-z]{3}$'
  ),
  refund_status text check (
    refund_status is null or refund_status in (
      'pending','requires_action','succeeded','failed','canceled'
    )
  ),
  refund_review_required boolean not null default false,
  refund_approved_by uuid,
  refund_approved_at timestamptz,
  refund_reason text check (
    refund_reason is null or char_length(refund_reason) between 10 and 1000
  ),
  provider_canceled_at timestamptz,
  provider_refund_started_at timestamptz,
  provider_refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((refund_amount is null)=(refund_currency is null)),
  check ((stripe_charge_id is null)=(stripe_payment_intent_id is null)),
  check ((stripe_refund_id is null)=(refund_status is null)),
  check (
    (state='cancel_pending' and provider_canceled_at is null
      and stripe_invoice_id is null and refund_amount is null
      and not refund_review_required and refund_approved_by is null
      and refund_approved_at is null and refund_reason is null
      and provider_refund_started_at is null and provider_refunded_at is null)
    or (state='provider_canceled' and provider_canceled_at is not null
      and stripe_charge_id is null and stripe_refund_id is null
      and refund_approved_by is null and refund_approved_at is null
      and refund_reason is null and provider_refund_started_at is null
      and provider_refunded_at is null
      and ((refund_review_required and stripe_invoice_id is not null
        and refund_amount is not null)
        or (not refund_review_required and refund_amount is null)))
    or (state='refund_pending' and provider_canceled_at is not null
      and stripe_invoice_id is not null and refund_amount is not null
      and refund_review_required and refund_approved_by is not null
      and refund_approved_at is not null and refund_reason is not null
      and provider_refund_started_at is not null
      and stripe_refund_id is null and provider_refunded_at is null)
    or (state='provider_refund_pending' and provider_canceled_at is not null
      and stripe_invoice_id is not null and stripe_charge_id is not null
      and refund_amount is not null and refund_review_required
      and refund_approved_by is not null and refund_approved_at is not null
      and refund_reason is not null and provider_refund_started_at is not null
      and stripe_refund_id is not null
      and refund_status in ('pending','requires_action')
      and provider_refunded_at is null)
    or (state='provider_refunded' and provider_canceled_at is not null
      and stripe_invoice_id is not null and stripe_charge_id is not null
      and refund_amount is not null and not refund_review_required
      and refund_approved_by is not null and refund_approved_at is not null
      and refund_reason is not null and provider_refund_started_at is not null
      and stripe_refund_id is not null and refund_status='succeeded'
      and provider_refunded_at is not null)
    or (state='refund_review_required' and provider_canceled_at is not null
      and stripe_invoice_id is not null and refund_amount is not null
      and refund_review_required and refund_approved_by is not null
      and refund_approved_at is not null and refund_reason is not null
      and provider_refund_started_at is not null
      and provider_refunded_at is null
      and (refund_status is null or refund_status<>'succeeded'))
  ),
  check (
    provider_canceled_at is null
    or provider_canceled_at<=updated_at+interval '5 minutes'
  ),
  check (
    provider_refunded_at is null
    or provider_refunded_at<=updated_at+interval '5 minutes'
  )
);

comment on table private.billing_duplicate_subscription_remediations is
  'Opaque-id AAL2 approval and durable provider-mutation state for canonical duplicate cancellation and an exact net, tax-inclusive refund to the original payment method. Ambiguous provider evidence stays in manual review.';

revoke all on all tables in schema private from public,anon,authenticated,service_role;
revoke all on all sequences in schema private from public,anon,authenticated,service_role;

create or replace function public.billing_enforcement_enabled()
returns boolean
language sql security definer stable set search_path = '' as $$
  select coalesce((
    select config.enforcement_enabled
    from private.billing_runtime_config config where config.singleton
  ),true)
$$;
revoke all on function public.billing_enforcement_enabled()
  from public,anon,authenticated;
grant execute on function public.billing_enforcement_enabled() to service_role;

create or replace function public.billing_entitlement_snapshot(p_account_id uuid)
returns table(
  enforcement_enabled boolean,
  checkout_enabled boolean,
  state text,
  source text,
  access_allowed boolean,
  trial_eligible boolean,
  subscription_status text,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  paid_through timestamptz,
  cancel_at_period_end boolean,
  developer_expires_at timestamptz,
  updated_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  with config as (
    select count(*)=1 as valid,
      case when count(*)=1 then coalesce(bool_or(enforcement_enabled),true)
        else true end as enabled,
      case when count(*)=1 then coalesce(bool_or(checkout_enabled),false)
        else false end as checkout_enabled,
      coalesce(max(updated_at),'epoch'::timestamptz) as updated_at
    from private.billing_runtime_config
  ), developer as (
    select grant_row.expires_at,grant_row.updated_at
    from private.billing_developer_grants grant_row
    where grant_row.account_id=p_account_id
      and grant_row.revoked_at is null
      and grant_row.starts_at<=now()
      and (grant_row.expires_at is null or grant_row.expires_at>now())
    order by grant_row.created_at desc limit 1
  ), subscription as (
    select sub.*,
      case
        when sub.status='trialing' and sub.trial_claim_verified
          and sub.trial_end>now() then true
        when sub.status='active' and sub.latest_invoice_paid
          and sub.latest_invoice_status='paid'
          and sub.current_period_end>now() then true
        else false
      end as grants_access
    from private.billing_subscriptions sub
    where sub.account_id=p_account_id
    order by
      case sub.status when 'trialing' then 1 when 'active' then 2
        when 'past_due' then 3 when 'unpaid' then 4 else 5 end,
      sub.updated_at desc
    limit 1
  ), closure as (
    select account_closure.state
    from private.billing_account_closures account_closure
    where account_closure.account_id=p_account_id
  ), financial_hold as (
    select hold_row.opened_at
    from private.billing_financial_holds hold_row
    where hold_row.account_id=p_account_id and hold_row.state='open'
    order by hold_row.opened_at desc,hold_row.id desc limit 1
  ), raw as (
    select
      exists(select 1 from closure) as account_closing,
      exists(select 1 from financial_hold) as financially_held,
      exists(select 1 from developer) as developer_access,
      coalesce((select grants_access from subscription),false) as subscription_access
  )
  select
    config.enabled,
    config.checkout_enabled,
    case
      when not config.valid then 'billing_configuration_unavailable'
      when exists(select 1 from closure) then 'account_'||closure.state
      when exists(select 1 from financial_hold) then 'financial_review_hold'
      when exists(select 1 from developer) then 'developer_active'
      when coalesce(subscription.status,'')='trialing'
        and coalesce(subscription.grants_access,false) then 'trial_active'
      when coalesce(subscription.status,'')='active'
        and coalesce(subscription.grants_access,false)
        and subscription.cancel_at_period_end then 'cancel_scheduled'
      when coalesce(subscription.status,'')='active'
        and coalesce(subscription.grants_access,false) then 'paid_active'
      when coalesce(subscription.status,'')='past_due' then 'past_due_suspended'
      when coalesce(subscription.status,'') in ('unpaid','paused','incomplete','incomplete_expired')
        then subscription.status||'_suspended'
      when coalesce(subscription.status,'')='canceled' then 'canceled_suspended'
      when not config.enabled then 'preview_access'
      else 'subscription_required'
    end,
    case
      when not config.valid or exists(select 1 from closure)
        or exists(select 1 from financial_hold) then 'none'
      when exists(select 1 from developer) then 'developer'
      when coalesce(subscription.grants_access,false) then 'subscription'
      when not config.enabled then 'preview'
      else 'none'
    end,
    config.valid and not raw.account_closing and not raw.financially_held
      and ((not config.enabled) or raw.developer_access or raw.subscription_access),
    case
      when exists (
        select 1 from private.billing_trial_claims claim
        where claim.account_id=p_account_id and claim.claim_state='consumed'
      ) then false
      else null::boolean
    end,
    coalesce(subscription.status,''),
    subscription.trial_start,
    subscription.trial_end,
    subscription.current_period_end,
    coalesce(subscription.cancel_at_period_end,false),
    developer.expires_at,
    greatest(
      coalesce(subscription.updated_at,'epoch'::timestamptz),
      coalesce(developer.updated_at,'epoch'::timestamptz),
      coalesce(financial_hold.opened_at,'epoch'::timestamptz),
      config.updated_at
    )
  from config cross join raw
  left join developer on true
  left join subscription on true
  left join closure on true
  left join financial_hold on true
$$;
revoke all on function public.billing_entitlement_snapshot(uuid)
  from public,anon,authenticated;
grant execute on function public.billing_entitlement_snapshot(uuid) to service_role;

create or replace function public.account_has_billing_access(p_account_id uuid)
returns boolean
language sql security definer stable set search_path = '' as $$
  select p_account_id is not null
    and exists(select 1 from public.profiles profile where profile.id=p_account_id)
    and not exists(
      select 1 from private.billing_account_closures closure
      where closure.account_id=p_account_id
    )
    and coalesce((
      select snapshot.access_allowed
      from public.billing_entitlement_snapshot(p_account_id) snapshot
    ),false)
$$;
revoke all on function public.account_has_billing_access(uuid)
  from public,anon,authenticated;
grant execute on function public.account_has_billing_access(uuid) to service_role;

create or replace function public.require_account_billing_access(p_account_id uuid)
returns void
language plpgsql security definer stable set search_path = '' as $$
begin
  if not public.account_has_billing_access(p_account_id) then
    raise exception using
      errcode='P0001',
      message='BILLING_REQUIRED',
      detail='An active trial, subscription, or developer grant is required.';
  end if;
end;
$$;
revoke all on function public.require_account_billing_access(uuid)
  from public,anon,authenticated;
grant execute on function public.require_account_billing_access(uuid) to service_role;

-- Native automatic publication is already paused by migration 051 until the
-- exact page-review contract is atomic. Keep that fail-closed behavior and put
-- the entitlement assertion inside the same RPC so a future implementation
-- cannot rely only on a worker-side check.
create or replace function public.publish_native_agent_draft(
  p_draft_id uuid,p_owner uuid,p_require_due boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;
  if not public.account_has_billing_access(p_owner) then
    raise exception using errcode='P0001',message='BILLING_REQUIRED',
      detail='An active MyPersonas account is required for automatic publication.';
  end if;
  raise exception using
    errcode='P0001',
    message='Native automatic publication is paused until it can complete the persona page review contract',
    hint='An owner can stage the approved draft into the page and publish that exact page revision from Review.';
end;
$$;
revoke all on function public.publish_native_agent_draft(uuid,uuid,boolean)
  from public,anon,authenticated;
grant execute on function public.publish_native_agent_draft(uuid,uuid,boolean)
  to service_role;

create or replace function public.my_billing_status()
returns table(
  enforcement_enabled boolean,
  checkout_enabled boolean,
  state text,
  source text,
  access_allowed boolean,
  trial_eligible boolean,
  subscription_status text,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  paid_through timestamptz,
  cancel_at_period_end boolean,
  developer_expires_at timestamptz,
  consequences jsonb,
  updated_at timestamptz
)
language plpgsql security definer stable set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  return query
  select snapshot.enforcement_enabled,snapshot.checkout_enabled,
    snapshot.state,snapshot.source,
    snapshot.access_allowed,snapshot.trial_eligible,snapshot.subscription_status,
    snapshot.trial_started_at,snapshot.trial_ends_at,snapshot.paid_through,
    snapshot.cancel_at_period_end,snapshot.developer_expires_at,
    jsonb_build_array(
      'MyPersonas directory search is suspended',
      'Owned persona pages are hidden from public projections',
      'AI generation and research automation are paused'
    ),snapshot.updated_at
  from public.billing_entitlement_snapshot(v_owner) snapshot;
end;
$$;
revoke all on function public.my_billing_status()
  from public,anon,authenticated;
grant execute on function public.my_billing_status() to authenticated;

create or replace function public.billing_mask_email(p_email text)
returns text
language sql immutable set search_path = '' as $$
  select case
    when position('@' in coalesce(p_email,''))<2 then '***'
    else left(split_part(lower(p_email),'@',1),1)||'***@'||split_part(lower(p_email),'@',2)
  end
$$;
revoke all on function public.billing_mask_email(text)
  from public,anon,authenticated;

create or replace function public.billing_admin_lookup_account(p_query text)
returns table(
  account_id uuid,
  display_name text,
  masked_email text,
  enforcement_enabled boolean,
  state text,
  source text,
  access_allowed boolean,
  subscription_status text,
  cancel_at_period_end boolean,
  paid_through timestamptz,
  developer_expires_at timestamptz,
  updated_at timestamptz
)
language plpgsql security definer stable set search_path = '' as $$
declare v_query text:=trim(coalesce(p_query,''));
begin
  if not public.has_platform_role(array['global_administrator']::text[]) then
    raise exception 'Global administrator role required';
  end if;
  perform public.require_aal2();
  if char_length(v_query)<3 or char_length(v_query)>320 then
    raise exception 'Enter an exact verified email address or account UUID';
  end if;
  return query
  select profile.id,coalesce(profile.display_name,''),
    public.billing_mask_email(user_row.email),snapshot.enforcement_enabled,
    snapshot.state,snapshot.source,snapshot.access_allowed,
    snapshot.subscription_status,snapshot.cancel_at_period_end,
    snapshot.paid_through,snapshot.developer_expires_at,snapshot.updated_at
  from auth.users user_row
  join public.profiles profile on profile.id=user_row.id
  cross join lateral public.billing_entitlement_snapshot(profile.id) snapshot
  where user_row.email_confirmed_at is not null and (
    profile.id=case
      when v_query ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then v_query::uuid
      else null
    end
    or lower(user_row.email)=lower(v_query)
  )
  limit 1;
end;
$$;
revoke all on function public.billing_admin_lookup_account(text)
  from public,anon,authenticated;
grant execute on function public.billing_admin_lookup_account(text) to authenticated;

create or replace function private.advance_account_ai_tasks_past_due(
  p_account_id uuid,p_due_at timestamptz default now()
)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_post_draft_id uuid;
  v_draft_id uuid;
  v_next_publish timestamptz;
  v_advanced integer:=0;
  v_post_reason text:=
    'Billing membership was inactive when this scheduled post became due. Publishing was stopped; review and reschedule it after access is restored.';
  v_draft_reason text:=
    'Billing membership was inactive when this queued draft became due. Automatic publishing was blocked; review and requeue it after access is restored.';
begin
  if p_account_id is null or p_due_at is null then
    raise exception 'Account and due time are required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  for v_task in
    select task.* from public.ai_tasks task
    where task.owner=p_account_id and task.active and task.next_run_at is not null
      and task.next_run_at<=p_due_at
      and (task.lease_expires_at is null or task.lease_expires_at<=p_due_at)
    order by task.next_run_at,task.id
    for update
  loop
    v_next_publish:=case
      when v_task.cadence in ('daily','weekly') then
        public.next_content_occurrence(
          v_task.cadence,v_task.schedule_day,v_task.schedule_time,
          v_task.timezone,p_due_at+interval '1 second'
        )
      else null
    end;
    update public.ai_tasks task set
      next_publish_at=v_next_publish,
      next_run_at=case when v_next_publish is null then null else
        greatest(
          v_next_publish-make_interval(mins=>v_task.lead_minutes),
          p_due_at+interval '1 minute'
        ) end,
      lease_token=null,lease_expires_at=null,last_status='paused_billing',
      last_error='Account membership was inactive; this occurrence was skipped without provider work.',
      updated_at=now()
    where task.id=v_task.id;
    v_advanced:=v_advanced+1;
  end loop;
  for v_post_draft_id in
    select draft.id from public.post_drafts draft
    where draft.owner=p_account_id and draft.status='scheduled'
      and draft.scheduled_for is not null and draft.scheduled_for<=p_due_at
    order by draft.scheduled_for,draft.id
    for update
  loop
    update public.post_drafts draft set
      status='failed',last_error=v_post_reason,updated_at=now()
    where draft.id=v_post_draft_id and draft.owner=p_account_id
      and draft.status='scheduled' and draft.scheduled_for<=p_due_at;
  end loop;
  for v_draft_id in
    select draft.id from public.drafts draft
    where draft.owner=p_account_id and draft.publish_state='queued'
      and draft.publish_at is not null and draft.publish_at<=p_due_at
      and draft.publish_next_attempt_at is not null
      and draft.publish_next_attempt_at<=p_due_at
    order by draft.publish_next_attempt_at,draft.publish_at,draft.id
    for update
  loop
    update public.drafts draft set
      publish_state='blocked',publish_next_attempt_at=null,
      publish_error=v_draft_reason,updated_at=now()
    where draft.id=v_draft_id and draft.owner=p_account_id
      and draft.publish_state='queued' and draft.publish_at<=p_due_at
      and draft.publish_next_attempt_at<=p_due_at;
  end loop;
  return v_advanced;
end;
$$;
revoke all on function private.advance_account_ai_tasks_past_due(uuid,timestamptz)
  from public,anon,authenticated;

create or replace function public.billing_admin_grant_developer(
  p_account_id uuid,p_reason text,p_expires_at timestamptz default null
)
returns table(
  account_id uuid,display_name text,masked_email text,enforcement_enabled boolean,
  state text,source text,access_allowed boolean,subscription_status text,
  cancel_at_period_end boolean,paid_through timestamptz,
  developer_expires_at timestamptz,updated_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=auth.uid();v_grant_id uuid;
  v_reason text:=trim(coalesce(p_reason,''));v_had_access boolean:=false;
  v_previous_state text;v_new_state text;
begin
  if not public.has_platform_role(array['global_administrator']::text[]) then
    raise exception 'Global administrator role required';
  end if;
  perform public.require_aal2();
  if not exists(select 1 from public.profiles where id=p_account_id) then
    raise exception 'Account not found';
  end if;
  if char_length(v_reason) not between 10 and 1000 then
    raise exception 'A developer grant reason between 10 and 1000 characters is required';
  end if;
  if p_expires_at is not null and p_expires_at<=now()+interval '1 minute' then
    raise exception 'Developer grant expiry must be in the future';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=p_account_id
  ) then raise exception using message='ACCOUNT_CLOSURE_BLOCKS_DEVELOPER_ACCESS',
    detail='A closing or deleted account cannot receive developer access.';
  end if;
  if exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.account_id=p_account_id and hold_row.state='open'
  ) then raise exception using message='BILLING_FINANCIAL_HOLD_REQUIRES_RECONCILIATION',
    detail='Reconcile every open refund or dispute hold before granting developer access.';
  end if;
  select snapshot.state,snapshot.access_allowed
  into v_previous_state,v_had_access
  from public.billing_entitlement_snapshot(p_account_id) snapshot;
  if exists (
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id
      and sub.status in ('trialing','active','past_due','unpaid','paused','incomplete')
      and not sub.cancel_at_period_end
  ) then
    raise exception using message='ACTIVE_SUBSCRIPTION_REQUIRES_CANCELLATION',
      detail='Schedule cancellation in the billing portal before granting free developer access.';
  end if;
  if exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.account_id=p_account_id
      and (
        reservation.status in ('provider_pending','session_created')
        or (reservation.status='reserved' and reservation.expires_at>now())
        or (
          reservation.status='completed' and (
            reservation.stripe_subscription_id is null
            or not exists(
              select 1 from private.billing_subscriptions sub
              where sub.account_id=p_account_id
                and sub.stripe_subscription_id=reservation.stripe_subscription_id
            )
          )
        )
      )
  ) then
    raise exception using message='ACTIVE_CHECKOUT_REQUIRES_EXPIRATION',
      detail='Expire or reconcile the active Checkout before granting free developer access.';
  end if;
  if not v_had_access then
    perform private.advance_account_ai_tasks_past_due(p_account_id,now());
  end if;
  update private.billing_developer_grants grant_row
  set revoked_at=now(),revoked_by=v_actor,
      revoke_reason='Superseded by a new administrator grant.',updated_at=now()
  where grant_row.account_id=p_account_id and grant_row.revoked_at is null;
  insert into private.billing_developer_grants(account_id,reason,granted_by,expires_at)
  values(p_account_id,v_reason,v_actor,p_expires_at) returning id into v_grant_id;
  insert into private.billing_developer_grant_events(
    grant_id,account_id,actor_id,action,reason,expires_at
  ) values(v_grant_id,p_account_id,v_actor,'granted',v_reason,p_expires_at);
  select snapshot.state into v_new_state
  from public.billing_entitlement_snapshot(p_account_id) snapshot;
  if v_previous_state is distinct from v_new_state then
    insert into private.billing_access_transitions(
      account_id,previous_state,new_state,cause,actor_id
    ) values(p_account_id,v_previous_state,v_new_state,'developer_grant',v_actor);
  end if;
  insert into public.platform_security_events(
    actor_id,event_type,severity,source,subject_type,subject_id,subject_account_id,metadata
  ) values(
    v_actor,'billing_developer_granted','warning','staff','account',p_account_id::text,
    p_account_id,jsonb_build_object('grant_id',v_grant_id,'expires_at',p_expires_at)
  );
  return query select * from public.billing_admin_lookup_account(p_account_id::text);
end;
$$;
revoke all on function public.billing_admin_grant_developer(uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.billing_admin_grant_developer(uuid,text,timestamptz)
  to authenticated;

create or replace function public.billing_admin_revoke_developer(
  p_account_id uuid,p_reason text
)
returns table(
  account_id uuid,display_name text,masked_email text,enforcement_enabled boolean,
  state text,source text,access_allowed boolean,subscription_status text,
  cancel_at_period_end boolean,paid_through timestamptz,
  developer_expires_at timestamptz,updated_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=auth.uid();v_grant_id uuid;
  v_reason text:=trim(coalesce(p_reason,''));
  v_previous_state text;v_new_state text;
begin
  if not public.has_platform_role(array['global_administrator']::text[]) then
    raise exception 'Global administrator role required';
  end if;
  perform public.require_aal2();
  if char_length(v_reason) not between 10 and 1000 then
    raise exception 'A revoke reason between 10 and 1000 characters is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  select snapshot.state into v_previous_state
  from public.billing_entitlement_snapshot(p_account_id) snapshot;
  select grant_row.id into v_grant_id
  from private.billing_developer_grants grant_row
  where grant_row.account_id=p_account_id and grant_row.revoked_at is null
    and (grant_row.expires_at is null or grant_row.expires_at>now())
  for update;
  if v_grant_id is null then raise exception 'Active developer grant not found'; end if;
  update private.billing_developer_grants
  set revoked_at=now(),revoked_by=v_actor,revoke_reason=v_reason,updated_at=now()
  where id=v_grant_id;
  insert into private.billing_developer_grant_events(
    grant_id,account_id,actor_id,action,reason
  ) values(v_grant_id,p_account_id,v_actor,'revoked',v_reason);
  select snapshot.state into v_new_state
  from public.billing_entitlement_snapshot(p_account_id) snapshot;
  if v_previous_state is distinct from v_new_state then
    insert into private.billing_access_transitions(
      account_id,previous_state,new_state,cause,actor_id
    ) values(p_account_id,v_previous_state,v_new_state,'developer_revoke',v_actor);
  end if;
  insert into public.platform_security_events(
    actor_id,event_type,severity,source,subject_type,subject_id,subject_account_id,metadata
  ) values(
    v_actor,'billing_developer_revoked','warning','staff','account',p_account_id::text,
    p_account_id,jsonb_build_object('grant_id',v_grant_id)
  );
  return query select * from public.billing_admin_lookup_account(p_account_id::text);
end;
$$;
revoke all on function public.billing_admin_revoke_developer(uuid,text)
  from public,anon,authenticated;
grant execute on function public.billing_admin_revoke_developer(uuid,text)
  to authenticated;

create or replace function public.billing_plan_for_service(p_plan_code text)
returns table(
  plan_code text,amount_minor integer,currency text,recurring_interval text,
  interval_count integer,stripe_price_id text,livemode boolean
)
language sql security definer stable set search_path = '' as $$
  select plan.plan_code,plan.amount_minor,plan.currency,plan.recurring_interval,
    plan.interval_count,plan.stripe_price_id,plan.livemode
  from private.billing_plan_catalog plan
  where plan.plan_code=p_plan_code and plan.active
$$;
revoke all on function public.billing_plan_for_service(text)
  from public,anon,authenticated;
grant execute on function public.billing_plan_for_service(text) to service_role;

create or replace function public.billing_prepare_checkout(
  p_account_id uuid,p_email_fingerprint text,p_email_fingerprint_key_id text,
  p_previous_email_fingerprint text,p_previous_email_fingerprint_key_id text,
  p_retired_email_fingerprints jsonb,
  p_plan_code text,
  p_request_key uuid,p_expires_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_plan private.billing_plan_catalog%rowtype;
  v_runtime private.billing_runtime_config%rowtype;
  v_existing private.billing_checkout_reservations%rowtype;
  v_reservation_id uuid;
  v_trial_eligible boolean:=false;
  v_customer_id text;
  v_lease_acquired boolean:=false;
  v_fingerprint_ring jsonb;
  v_fingerprint text;
  v_matching_claims integer:=0;
begin
  if p_account_id is null or p_request_key is null then raise exception 'Invalid checkout request'; end if;
  if (p_previous_email_fingerprint is null)
      is distinct from (p_previous_email_fingerprint_key_id is null)
    or p_retired_email_fingerprints is null
    or jsonb_typeof(p_retired_email_fingerprints)<>'array' then
    raise exception 'Invalid trial fingerprint';
  end if;
  if jsonb_array_length(p_retired_email_fingerprints)>32 then
    raise exception 'Invalid trial fingerprint';
  end if;
  v_fingerprint_ring:=jsonb_build_array(jsonb_build_object(
    'digest',p_email_fingerprint,'key_id',p_email_fingerprint_key_id
  ));
  if p_previous_email_fingerprint is not null then
    v_fingerprint_ring:=v_fingerprint_ring||jsonb_build_array(jsonb_build_object(
      'digest',p_previous_email_fingerprint,
      'key_id',p_previous_email_fingerprint_key_id
    ));
  end if;
  v_fingerprint_ring:=v_fingerprint_ring||p_retired_email_fingerprints;
  if jsonb_array_length(v_fingerprint_ring)>34
    or exists(
      select 1 from jsonb_array_elements(v_fingerprint_ring) as ring(entry)
      where case when jsonb_typeof(entry)<>'object' then true else
        not (entry?'digest') or not (entry?'key_id')
          or (select count(*) from jsonb_object_keys(entry))<>2
          or coalesce(entry->>'digest','') !~ '^[0-9a-f]{64}$'
          or coalesce(entry->>'key_id','') !~ '^[a-z][a-z0-9_-]{0,31}$'
      end
    )
    or (select count(*) from jsonb_array_elements(v_fingerprint_ring))
      <>(select count(distinct entry->>'digest')
         from jsonb_array_elements(v_fingerprint_ring) as ring(entry))
    or (select count(*) from jsonb_array_elements(v_fingerprint_ring))
      <>(select count(distinct entry->>'key_id')
         from jsonb_array_elements(v_fingerprint_ring) as ring(entry)) then
    raise exception 'Invalid trial fingerprint';
  end if;
  if p_expires_at<=now()+interval '5 minutes' or p_expires_at>now()+interval '25 hours' then
    raise exception 'Invalid checkout reservation expiry';
  end if;
  select * into v_plan from private.billing_plan_catalog plan
  where plan.plan_code=p_plan_code and plan.active;
  if not found then raise exception 'Unknown billing plan'; end if;
  if v_plan.stripe_price_id is null then raise exception 'Billing plan is not configured'; end if;
  if not exists(
    select 1 from auth.users user_row where user_row.id=p_account_id
      and user_row.email_confirmed_at is not null
  ) then raise exception 'A verified email address is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  for v_fingerprint in
    select distinct entry->>'digest'
    from jsonb_array_elements(v_fingerprint_ring) as ring(entry)
    order by entry->>'digest'
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      v_fingerprint,6810069
    ));
  end loop;
  select * into v_runtime
  from private.billing_runtime_config config where config.singleton;
  if not found or not v_runtime.enforcement_enabled or not v_runtime.checkout_enabled
    or v_runtime.livemode<>v_plan.livemode then
    raise exception 'Checkout is disabled';
  end if;
  if exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=p_account_id
  ) then raise exception 'Account closure is in progress'; end if;
  if exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.account_id=p_account_id and hold_row.state='open'
  ) then raise exception 'Billing reconciliation is required'; end if;
  if exists(
    select 1 from private.billing_developer_grants grant_row
    where grant_row.account_id=p_account_id and grant_row.revoked_at is null
      and grant_row.starts_at<=now()
      and (grant_row.expires_at is null or grant_row.expires_at>now())
  ) then raise exception 'Developer access is already active'; end if;
  if exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id
      and sub.status in ('trialing','active','past_due','unpaid','paused','incomplete')
  ) then raise exception 'An existing subscription must be managed in the billing portal'; end if;
  if exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.account_id=p_account_id and reservation.status='completed'
      and (
        reservation.stripe_subscription_id is null
        or not exists(
          select 1 from private.billing_subscriptions sub
          where sub.account_id=p_account_id
            and sub.stripe_subscription_id=reservation.stripe_subscription_id
        )
      )
  ) then raise exception 'Checkout reconciliation is required'; end if;
  update private.billing_checkout_reservations reservation
  set status='abandoned',updated_at=now()
  where reservation.account_id=p_account_id
    and reservation.status='reserved'
    and reservation.expires_at<=now();
  select * into v_existing
  from private.billing_checkout_reservations reservation
  where reservation.account_id=p_account_id
    and reservation.status in ('reserved','provider_pending','session_created')
  order by reservation.created_at desc
  limit 1 for update;
  if found then
    if v_existing.expires_at<=now() then
      raise exception 'Checkout reconciliation is required';
    end if;
    if v_existing.plan_code<>p_plan_code then
      raise exception 'Finish or expire the active Checkout before choosing another plan';
    end if;
    if v_existing.status in ('reserved','provider_pending') then
      if v_existing.lease_token=p_request_key and v_existing.lease_expires_at>now() then
        v_lease_acquired:=true;
      elsif v_existing.lease_expires_at<=now() then
        update private.billing_checkout_reservations reservation
        set lease_token=p_request_key,
            lease_expires_at=least(v_existing.expires_at,now()+interval '2 minutes'),
            updated_at=now()
        where reservation.id=v_existing.id
        returning * into v_existing;
        v_lease_acquired:=true;
      end if;
    end if;
    select customer.stripe_customer_id into v_customer_id
    from private.billing_customers customer where customer.account_id=p_account_id;
    return jsonb_build_object(
      'reservation_id',v_existing.id,'reservation_status',v_existing.status,
      'reservation_expires_at',v_existing.expires_at,
      'stripe_checkout_session_id',v_existing.stripe_checkout_session_id,
      'lease_acquired',v_lease_acquired,
      'trial_eligible',v_existing.trial_eligible,
      'stripe_customer_id',v_customer_id,'plan_code',v_plan.plan_code,
      'amount_minor',v_plan.amount_minor,'currency',v_plan.currency,
      'recurring_interval',v_plan.recurring_interval,'interval_count',v_plan.interval_count,
      'stripe_price_id',v_plan.stripe_price_id,'livemode',v_plan.livemode
    );
  end if;
  if (select count(*) from private.billing_checkout_reservations reservation
      where reservation.account_id=p_account_id and reservation.created_at>now()-interval '1 hour')>=5 then
    raise exception 'Checkout rate limit reached';
  end if;
  -- Rewrite one same-account older-generation tombstone under the current key.
  -- Every retained digest is locked in stable order, so cross-account concurrent
  -- presentation fails closed even after multiple emergency rotations.
  select count(*) into v_matching_claims
  from private.billing_trial_claims claim
  where claim.account_id=p_account_id and exists(
    select 1 from jsonb_array_elements(v_fingerprint_ring) as ring(entry)
    where entry->>'digest'=claim.email_fingerprint
      and entry->>'key_id'=claim.fingerprint_key_id
  );
  if v_matching_claims>1 then
    raise exception 'Trial fingerprint reconciliation is required';
  end if;
  if v_matching_claims=1 and not exists(
      select 1 from private.billing_trial_claims current_claim
      where current_claim.email_fingerprint=p_email_fingerprint
    ) then
    update private.billing_trial_claims claim set
      email_fingerprint=p_email_fingerprint,
      fingerprint_key_id=p_email_fingerprint_key_id,
      fingerprint_rotated_at=now(),updated_at=now()
    where claim.account_id=p_account_id
      and claim.email_fingerprint<>p_email_fingerprint
      and exists(
        select 1 from jsonb_array_elements(v_fingerprint_ring) as ring(entry)
        where entry->>'digest'=claim.email_fingerprint
          and entry->>'key_id'=claim.fingerprint_key_id
      );
  end if;
  if not exists(
    select 1 from private.billing_trial_claims claim
    where claim.account_id=p_account_id and claim.claim_state='consumed'
  ) and not exists(
    select 1 from private.billing_trial_claims claim
    where exists(
      select 1 from jsonb_array_elements(v_fingerprint_ring) as ring(entry)
      where entry->>'digest'=claim.email_fingerprint
    ) and claim.claim_state='consumed'
  ) and not exists(
    select 1 from private.billing_trial_claims claim
    where exists(
      select 1 from jsonb_array_elements(v_fingerprint_ring) as ring(entry)
      where entry->>'digest'=claim.email_fingerprint
    ) and claim.account_id<>p_account_id
  ) then
    update private.billing_trial_claims claim set
      reserved_at=now(),reservation_expires_at=p_expires_at,
      fingerprint_key_id=p_email_fingerprint_key_id,
      last_checkout_at=now(),updated_at=now()
    where claim.account_id=p_account_id
      and claim.email_fingerprint=p_email_fingerprint
      and claim.claim_state='reserved';
    if not found then
      insert into private.billing_trial_claims(
        account_id,email_fingerprint,fingerprint_key_id,claim_state,
        reserved_at,reservation_expires_at,last_checkout_at
      ) values(
        p_account_id,p_email_fingerprint,p_email_fingerprint_key_id,
        'reserved',now(),p_expires_at,now()
      ) on conflict do nothing;
    end if;
    v_trial_eligible:=exists(
      select 1 from private.billing_trial_claims claim
      where claim.account_id=p_account_id
        and claim.email_fingerprint=p_email_fingerprint
        and claim.claim_state='reserved'
    );
  end if;
  insert into private.billing_checkout_reservations(
    request_key,lease_token,lease_expires_at,account_id,plan_code,trial_eligible,expires_at
  ) values(
    p_request_key,p_request_key,least(p_expires_at,now()+interval '2 minutes'),
    p_account_id,p_plan_code,v_trial_eligible,p_expires_at
  )
  returning id into v_reservation_id;
  select customer.stripe_customer_id into v_customer_id
  from private.billing_customers customer where customer.account_id=p_account_id;
  return jsonb_build_object(
    'reservation_id',v_reservation_id,'reservation_status','reserved',
    'reservation_expires_at',p_expires_at,'stripe_checkout_session_id',null,
    'lease_acquired',true,'trial_eligible',v_trial_eligible,
    'stripe_customer_id',v_customer_id,'plan_code',v_plan.plan_code,
    'amount_minor',v_plan.amount_minor,'currency',v_plan.currency,
    'recurring_interval',v_plan.recurring_interval,'interval_count',v_plan.interval_count,
    'stripe_price_id',v_plan.stripe_price_id,'livemode',v_plan.livemode
  );
end;
$$;
revoke all on function public.billing_prepare_checkout(
  uuid,text,text,text,text,jsonb,text,uuid,timestamptz
)
  from public,anon,authenticated;
grant execute on function public.billing_prepare_checkout(
  uuid,text,text,text,text,jsonb,text,uuid,timestamptz
)
  to service_role;

create or replace function public.billing_bind_customer(
  p_account_id uuid,p_customer_id text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_runtime private.billing_runtime_config%rowtype;
begin
  if p_account_id is null or p_customer_id !~ '^cus_[A-Za-z0-9]+$' then
    raise exception 'Invalid Stripe customer binding';
  end if;
  if not exists(
    select 1 from auth.users user_row
    where user_row.id=p_account_id and user_row.email_confirmed_at is not null
  ) then raise exception 'A verified billing account is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  select * into v_runtime
  from private.billing_runtime_config config where config.singleton;
  if not found or not v_runtime.enforcement_enabled or not v_runtime.checkout_enabled then
    raise exception 'Checkout is disabled';
  end if;
  if exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=p_account_id
  ) then raise exception 'Account closure is in progress'; end if;
  if exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.account_id=p_account_id and hold_row.state='open'
  ) then raise exception 'Billing reconciliation is required'; end if;
  if exists(
    select 1 from private.billing_developer_grants grant_row
    where grant_row.account_id=p_account_id and grant_row.revoked_at is null
      and grant_row.starts_at<=now()
      and (grant_row.expires_at is null or grant_row.expires_at>now())
  ) then raise exception 'Developer access is already active'; end if;
  if exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id
      and sub.status in ('trialing','active','past_due','unpaid','paused','incomplete')
  ) then raise exception 'An existing subscription must be managed in the billing portal'; end if;
  if exists(
    select 1 from private.billing_customers customer
    where customer.stripe_customer_id=p_customer_id
      and customer.account_id<>p_account_id
  ) then raise exception 'Stripe customer is already bound to another account'; end if;
  insert into private.billing_customers(account_id,stripe_customer_id,livemode)
  values(p_account_id,p_customer_id,v_runtime.livemode)
  on conflict (account_id) do update set updated_at=now()
  where private.billing_customers.stripe_customer_id=excluded.stripe_customer_id
    and private.billing_customers.livemode=excluded.livemode;
  if not found then raise exception 'Account is already bound to another Stripe customer'; end if;
  return true;
end;
$$;
revoke all on function public.billing_bind_customer(uuid,text)
  from public,anon,authenticated;
grant execute on function public.billing_bind_customer(uuid,text) to service_role;

create or replace function public.billing_assert_checkout_allowed(
  p_account_id uuid,p_reservation_id uuid,p_lease_token uuid
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_runtime private.billing_runtime_config%rowtype;
  v_reservation private.billing_checkout_reservations%rowtype;
begin
  if p_account_id is null or p_reservation_id is null or p_lease_token is null then
    raise exception 'Invalid checkout authorization';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=p_account_id
  ) then raise exception 'Account closure is in progress'; end if;
  if exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.account_id=p_account_id and hold_row.state='open'
  ) then raise exception 'Billing reconciliation is required'; end if;
  if exists(
    select 1 from private.billing_developer_grants grant_row
    where grant_row.account_id=p_account_id and grant_row.revoked_at is null
      and grant_row.starts_at<=now()
      and (grant_row.expires_at is null or grant_row.expires_at>now())
  ) then raise exception 'Developer access is already active'; end if;
  if exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id
      and sub.status in ('trialing','active','past_due','unpaid','paused','incomplete')
  ) then raise exception 'An existing subscription must be managed in the billing portal'; end if;
  select * into v_reservation
  from private.billing_checkout_reservations reservation
  where reservation.id=p_reservation_id and reservation.account_id=p_account_id
  for update;
  if not found or v_reservation.expires_at<=now() then
    return false;
  end if;
  select * into v_runtime
  from private.billing_runtime_config config where config.singleton;
  if not found or not v_runtime.enforcement_enabled or not v_runtime.checkout_enabled then
    raise exception 'Checkout is disabled';
  end if;
  if v_reservation.status='session_created' then
    return true;
  end if;
  if v_reservation.status not in ('reserved','provider_pending')
    or v_reservation.lease_token<>p_lease_token then return false; end if;
  update private.billing_checkout_reservations reservation
  set status='provider_pending',
      lease_expires_at=least(v_reservation.expires_at,now()+interval '5 minutes'),
      updated_at=now()
  where reservation.id=v_reservation.id;
  return true;
end;
$$;
revoke all on function public.billing_assert_checkout_allowed(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.billing_assert_checkout_allowed(uuid,uuid,uuid)
  to service_role;

create or replace function public.billing_attach_checkout_session(
  p_account_id uuid,p_reservation_id uuid,p_session_id text,p_lease_token uuid
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_runtime private.billing_runtime_config%rowtype;
begin
  if p_session_id !~ '^cs_(test_|live_)?[A-Za-z0-9]+$' or p_lease_token is null then
    raise exception 'Invalid checkout session';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=p_account_id
  ) then raise exception 'Account closure is in progress'; end if;
  if exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.account_id=p_account_id and hold_row.state='open'
  ) then raise exception 'Billing reconciliation is required'; end if;
  if exists(
    select 1 from private.billing_developer_grants grant_row
    where grant_row.account_id=p_account_id and grant_row.revoked_at is null
      and grant_row.starts_at<=now()
      and (grant_row.expires_at is null or grant_row.expires_at>now())
  ) then raise exception 'Developer access is already active'; end if;
  if exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id
      and sub.status in ('trialing','active','past_due','unpaid','paused','incomplete')
  ) then raise exception 'An existing subscription must be managed in the billing portal'; end if;
  select * into v_runtime
  from private.billing_runtime_config config where config.singleton;
  if not found or not v_runtime.enforcement_enabled or not v_runtime.checkout_enabled then
    raise exception 'Checkout is disabled';
  end if;
  if exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.id=p_reservation_id and reservation.account_id=p_account_id
      and reservation.status='session_created'
      and reservation.stripe_checkout_session_id=p_session_id
  ) then return true; end if;
  update private.billing_checkout_reservations reservation
  set stripe_checkout_session_id=p_session_id,status='session_created',updated_at=now()
  where reservation.id=p_reservation_id and reservation.account_id=p_account_id
    and reservation.status='provider_pending' and reservation.expires_at>now()
    and reservation.lease_token=p_lease_token and reservation.lease_expires_at>now()
    and exists(
      select 1 from private.billing_customers customer
      where customer.account_id=p_account_id
    );
  if not found then raise exception 'Active checkout reservation not found'; end if;
  return true;
end;
$$;
revoke all on function public.billing_attach_checkout_session(uuid,uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.billing_attach_checkout_session(uuid,uuid,text,uuid)
  to service_role;

create or replace function public.billing_expire_checkout_reservation(
  p_account_id uuid,p_reservation_id uuid,p_session_id text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_reservation private.billing_checkout_reservations%rowtype;
begin
  if p_account_id is null or p_reservation_id is null
    or p_session_id !~ '^cs_(test_|live_)?[A-Za-z0-9]+$' then
    raise exception 'Invalid expired checkout session';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  select * into v_reservation
  from private.billing_checkout_reservations reservation
  where reservation.id=p_reservation_id and reservation.account_id=p_account_id
  for update;
  if not found then return false; end if;
  if v_reservation.status='expired'
    and v_reservation.stripe_checkout_session_id=p_session_id then return true; end if;
  if v_reservation.status not in ('provider_pending','session_created')
    or (v_reservation.stripe_checkout_session_id is not null
      and v_reservation.stripe_checkout_session_id<>p_session_id) then
    return false;
  end if;
  update private.billing_checkout_reservations reservation
  set stripe_checkout_session_id=p_session_id,status='expired',updated_at=now()
  where reservation.id=v_reservation.id;
  return true;
end;
$$;
revoke all on function public.billing_expire_checkout_reservation(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.billing_expire_checkout_reservation(uuid,uuid,text)
  to service_role;

create or replace function public.billing_get_customer_for_portal(p_account_id uuid)
returns text
language plpgsql security definer stable set search_path = '' as $$
declare v_customer text;
begin
  select customer.stripe_customer_id into v_customer
  from private.billing_customers customer
  where customer.account_id=p_account_id and customer.provider_deleted_at is null;
  if v_customer is null then raise exception 'Billing customer not found'; end if;
  return v_customer;
end;
$$;
revoke all on function public.billing_get_customer_for_portal(uuid)
  from public,anon,authenticated;
grant execute on function public.billing_get_customer_for_portal(uuid) to service_role;

create or replace function public.billing_customer_cleanup_candidate(
  p_account_id uuid,p_closure_token uuid
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_customer private.billing_customers%rowtype;
begin
  if p_account_id is null or p_closure_token is null then
    raise exception 'Account closure token is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if not exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=p_account_id and closure.closure_token=p_closure_token
      and closure.state='closing'
  ) then raise exception 'Account closure is not awaiting customer cleanup'; end if;
  if exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id and (
      sub.status not in ('canceled','incomplete_expired')
      or (sub.latest_invoice_id is not null and not sub.latest_invoice_paid
        and sub.latest_invoice_status not in ('','paid','void','uncollectible'))
    )
  ) or exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.account_id=p_account_id
      and (
        reservation.status in ('reserved','provider_pending','session_created')
        or (reservation.status='completed' and (
          reservation.stripe_subscription_id is null or not exists(
            select 1 from private.billing_subscriptions sub
            where sub.account_id=p_account_id
              and sub.stripe_subscription_id=reservation.stripe_subscription_id
              and sub.status in ('canceled','incomplete_expired')
          )
        ))
      )
  ) or exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.account_id=p_account_id and hold_row.state='open'
  ) or exists(
    select 1 from private.billing_duplicate_subscription_remediations remediation
    where remediation.account_id=p_account_id and (
      remediation.state in (
        'cancel_pending','refund_pending','provider_refund_pending',
        'refund_review_required'
      ) or (remediation.state='provider_canceled'
        and remediation.refund_review_required)
    )
  ) then raise exception 'Billing changed before customer cleanup'; end if;
  select * into v_customer
  from private.billing_customers customer
  where customer.account_id=p_account_id
  for update;
  if not found or v_customer.provider_deleted_at is not null then
    return jsonb_build_object('required',false,'stripe_customer_id',null);
  end if;
  return jsonb_build_object(
    'required',true,'stripe_customer_id',v_customer.stripe_customer_id
  );
end;
$$;
revoke all on function public.billing_customer_cleanup_candidate(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.billing_customer_cleanup_candidate(uuid,uuid)
  to service_role;

create or replace function public.billing_confirm_customer_deleted(
  p_account_id uuid,p_closure_token uuid,p_customer_id text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_account_id is null or p_closure_token is null
    or p_customer_id !~ '^cus_[A-Za-z0-9]+$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if not exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=p_account_id and closure.closure_token=p_closure_token
      and closure.state='closing' and closure.irreversible_started_at is null
  ) or exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id and (
      sub.status not in ('canceled','incomplete_expired')
      or (sub.latest_invoice_id is not null and not sub.latest_invoice_paid
        and sub.latest_invoice_status not in ('','paid','void','uncollectible'))
    )
  ) or exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.account_id=p_account_id
      and (
        reservation.status in ('reserved','provider_pending','session_created')
        or (reservation.status='completed' and (
          reservation.stripe_subscription_id is null or not exists(
            select 1 from private.billing_subscriptions sub
            where sub.account_id=p_account_id
              and sub.stripe_subscription_id=reservation.stripe_subscription_id
              and sub.status in ('canceled','incomplete_expired')
          )
        ))
      )
  ) or exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.account_id=p_account_id and hold_row.state='open'
  ) or exists(
    select 1 from private.billing_duplicate_subscription_remediations remediation
    where remediation.account_id=p_account_id and (
      remediation.state in (
        'cancel_pending','refund_pending','provider_refund_pending',
        'refund_review_required'
      ) or (remediation.state='provider_canceled'
        and remediation.refund_review_required)
    )
  ) then return false; end if;
  update private.billing_customers customer
  set provider_deleted_at=coalesce(customer.provider_deleted_at,now()),updated_at=now()
  where customer.account_id=p_account_id
    and customer.stripe_customer_id=p_customer_id;
  return found;
end;
$$;
revoke all on function public.billing_confirm_customer_deleted(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.billing_confirm_customer_deleted(uuid,uuid,text)
  to service_role;

create or replace function public.billing_account_deletion_guard(p_account_id uuid)
returns jsonb
language plpgsql security definer stable set search_path = '' as $$
declare
  v_blocking_subscription boolean:=false;
  v_unreconciled_checkout boolean:=false;
  v_financial_hold boolean:=false;
  v_refund_reconciliation boolean:=false;
  v_customer_cleanup boolean:=false;
  v_closure_state text;
begin
  if p_account_id is null then raise exception 'Account is required'; end if;
  select closure.state into v_closure_state
  from private.billing_account_closures closure
  where closure.account_id=p_account_id;
  select exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id and (
      sub.status not in ('canceled','incomplete_expired')
      or (
        sub.latest_invoice_id is not null
        and not sub.latest_invoice_paid
        and sub.latest_invoice_status not in ('','paid','void','uncollectible')
      )
    )
  ) into v_blocking_subscription;
  select exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.account_id=p_account_id
      and reservation.status in ('reserved','provider_pending','session_created')
      or (
        reservation.account_id=p_account_id and reservation.status='completed'
        and not exists(
          select 1 from private.billing_subscriptions sub
          where sub.account_id=p_account_id
        )
      )
  ) into v_unreconciled_checkout;
  select exists(
    select 1 from private.billing_financial_holds hold_row
    where hold_row.account_id=p_account_id and hold_row.state='open'
  ) into v_financial_hold;
  select exists(
    select 1 from private.billing_duplicate_subscription_remediations remediation
    where remediation.account_id=p_account_id and (
      remediation.state in (
        'cancel_pending','refund_pending','provider_refund_pending',
        'refund_review_required'
      ) or (remediation.state='provider_canceled'
        and remediation.refund_review_required)
    )
  ) into v_refund_reconciliation;
  select exists(
    select 1 from private.billing_customers customer
    where customer.account_id=p_account_id
      and customer.provider_deleted_at is null
  ) into v_customer_cleanup;
  return jsonb_build_object(
    'allowed',v_closure_state is null and not v_blocking_subscription
      and not v_unreconciled_checkout and not v_financial_hold
      and not v_refund_reconciliation and not v_customer_cleanup,
    'code',case
      when v_closure_state='deleted' then 'billing_account_already_deleted'
      when v_closure_state='closing' then 'billing_account_closure_in_progress'
      when v_financial_hold then 'billing_financial_hold_reconciliation_required'
      when v_refund_reconciliation then 'billing_refund_reconciliation_required'
      when v_blocking_subscription then 'billing_subscription_must_be_terminal'
      when v_unreconciled_checkout then 'billing_checkout_reconciliation_required'
      when v_customer_cleanup then 'billing_customer_cleanup_required'
      else 'billing_clear'
    end
  );
end;
$$;
revoke all on function public.billing_account_deletion_guard(uuid)
  from public,anon,authenticated;
grant execute on function public.billing_account_deletion_guard(uuid) to service_role;

create or replace function public.billing_begin_account_closure(
  p_account_id uuid,p_closure_token uuid
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_guard jsonb;
  v_existing private.billing_account_closures%rowtype;
begin
  if p_account_id is null or p_closure_token is null then
    raise exception 'Account closure token is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  select * into v_existing
  from private.billing_account_closures closure
  where closure.account_id=p_account_id
  for update;
  if found then
    if v_existing.state='deleted' then
      return jsonb_build_object('allowed',false,'code','billing_account_already_deleted');
    end if;
    return jsonb_build_object(
      'allowed',true,'code','billing_closure_resumed',
      'closure_token',v_existing.closure_token
    );
  end if;
  update private.billing_checkout_reservations reservation
  set status='abandoned',updated_at=now()
  where reservation.account_id=p_account_id and reservation.status='reserved';
  v_guard:=public.billing_account_deletion_guard(p_account_id);
  if not coalesce((v_guard->>'allowed')::boolean,false)
    and v_guard->>'code'<>'billing_customer_cleanup_required' then
    return v_guard;
  end if;
  insert into private.billing_account_closures(account_id,closure_token)
  values(p_account_id,p_closure_token);
  return jsonb_build_object(
    'allowed',true,
    'code',case when v_guard->>'code'='billing_customer_cleanup_required'
      then 'billing_customer_cleanup_required' else 'billing_closure_started' end,
    'closure_token',p_closure_token
  );
end;
$$;
revoke all on function public.billing_begin_account_closure(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.billing_begin_account_closure(uuid,uuid)
  to service_role;

create or replace function public.billing_confirm_account_closure(
  p_account_id uuid,p_closure_token uuid
)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_account_id is null or p_closure_token is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if not exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=p_account_id and closure.closure_token=p_closure_token
      and closure.state='closing'
  ) then return false; end if;
  if exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id and (
      sub.status not in ('canceled','incomplete_expired')
      or (sub.latest_invoice_id is not null and not sub.latest_invoice_paid
        and sub.latest_invoice_status not in ('','paid','void','uncollectible'))
    )
  ) or exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.account_id=p_account_id
      and reservation.status in ('reserved','provider_pending','session_created')
  ) or exists(
    select 1 from private.billing_customers customer
    where customer.account_id=p_account_id
      and customer.provider_deleted_at is null
  ) then return false; end if;
  -- Accounts that never reached a financial Customer/subscription retain only
  -- the UUID-only closure tombstone. Remove abandoned trial/Checkout state and
  -- free developer-access audit text before the Auth account disappears.
  delete from private.billing_developer_grant_events event
  where event.account_id=p_account_id;
  delete from private.billing_developer_grants grant_row
  where grant_row.account_id=p_account_id;
  delete from private.billing_access_transitions transition
  where transition.account_id=p_account_id;
  delete from private.billing_trial_claims claim
  where claim.account_id=p_account_id and claim.claim_state='reserved';
  delete from private.billing_checkout_reservations reservation
  where reservation.account_id=p_account_id
    and (
      reservation.status in ('expired','abandoned')
      or (reservation.status='completed' and exists(
        select 1 from private.billing_subscriptions sub
        where sub.account_id=p_account_id
          and sub.stripe_subscription_id=reservation.stripe_subscription_id
          and sub.status in ('canceled','incomplete_expired')
      ))
    );
  update private.billing_account_closures closure
  set irreversible_started_at=coalesce(closure.irreversible_started_at,now()),updated_at=now()
  where closure.account_id=p_account_id and closure.closure_token=p_closure_token;
  if not found then return false; end if;
  update private.billing_subscriptions sub
  set account_closed_at=coalesce(sub.account_closed_at,now()),
      retention_expires_at=coalesce(
        sub.retention_expires_at,now()+interval '7 years'
      ),updated_at=now()
  where sub.account_id=p_account_id
    and sub.status in ('canceled','incomplete_expired');
  update private.billing_trial_claims claim
  set retention_expires_at=coalesce(
        claim.retention_expires_at,now()+interval '7 years'
      ),updated_at=now()
  where claim.account_id=p_account_id and claim.claim_state='consumed';
  update private.billing_customers customer
  set account_closed_at=coalesce(customer.account_closed_at,now()),
      retention_expires_at=coalesce(
        customer.retention_expires_at,now()+interval '7 years'
      ),updated_at=now()
  where customer.account_id=p_account_id
    and customer.provider_deleted_at is not null;
  return true;
end;
$$;
revoke all on function public.billing_confirm_account_closure(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.billing_confirm_account_closure(uuid,uuid)
  to service_role;

create or replace function public.billing_complete_account_closure(
  p_account_id uuid,p_closure_token uuid
)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_account_id is null or p_closure_token is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if exists(
    select 1 from private.billing_subscriptions sub
    where sub.account_id=p_account_id and (
      sub.status not in ('canceled','incomplete_expired')
      or sub.account_closed_at is null or sub.retention_expires_at is null
    )
  ) or exists(
    select 1 from private.billing_checkout_reservations reservation
    where reservation.account_id=p_account_id
      and reservation.status in ('reserved','provider_pending','session_created','completed')
  ) or exists(
    select 1 from private.billing_customers customer
    where customer.account_id=p_account_id and (
      customer.provider_deleted_at is null or customer.account_closed_at is null
      or customer.retention_expires_at is null
    )
  ) then return false; end if;
  update private.billing_account_closures closure
  set state='deleted',completed_at=now(),updated_at=now()
  where closure.account_id=p_account_id and closure.closure_token=p_closure_token
    and closure.state='closing' and closure.irreversible_started_at is not null;
  return found;
end;
$$;
revoke all on function public.billing_complete_account_closure(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.billing_complete_account_closure(uuid,uuid)
  to service_role;

create or replace function public.billing_mark_account_closure_reconciliation_required(
  p_account_id uuid,p_closure_token uuid
)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_account_id is null or p_closure_token is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if not exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=p_account_id and closure.closure_token=p_closure_token
      and closure.state='closing' and closure.irreversible_started_at is not null
  ) then return false; end if;
  insert into private.billing_reconciliation_alerts(
    account_id,alert_type,severity,object_id,detail
  ) values(
    p_account_id,'account_closure_finalization_failed','critical',p_account_id::text,
    'The Auth account was deleted but the billing closure tombstone did not finalize; operator reconciliation is required.'
  ) on conflict (alert_type,object_id) where resolved_at is null do update set
    severity='critical',detail=excluded.detail;
  update private.billing_account_closures closure set updated_at=now()
  where closure.account_id=p_account_id and closure.closure_token=p_closure_token;
  return true;
end;
$$;
revoke all on function public.billing_mark_account_closure_reconciliation_required(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.billing_mark_account_closure_reconciliation_required(uuid,uuid)
  to service_role;

create or replace function public.billing_account_closure_state(p_account_id uuid)
returns text
language sql security definer stable set search_path = '' as $$
  select closure.state from private.billing_account_closures closure
  where closure.account_id=p_account_id
$$;
revoke all on function public.billing_account_closure_state(uuid)
  from public,anon,authenticated;
grant execute on function public.billing_account_closure_state(uuid) to service_role;

create or replace function public.billing_record_webhook_event(
  p_event_id text,p_event_type text,p_object_id text,p_event_created_at timestamptz,
  p_payload_sha256 text,p_livemode boolean
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_existing_sha text;
  v_expected_live boolean;
  v_processing_state text;
  v_attempt_count integer;
  v_updated_at timestamptz;
begin
  if p_event_id !~ '^evt_[A-Za-z0-9]+$' or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid webhook envelope';
  end if;
  if char_length(p_event_type) not between 3 and 160 or char_length(coalesce(p_object_id,''))>255 then
    raise exception 'Invalid webhook metadata';
  end if;
  select config.livemode into v_expected_live
  from private.billing_runtime_config config where config.singleton;
  if p_livemode is distinct from v_expected_live then
    insert into private.billing_reconciliation_alerts(
      alert_type,severity,object_id,detail
    ) values('environment_mismatch','critical',left(coalesce(p_object_id,''),255),
      'A Stripe event did not match the configured billing environment.')
    on conflict (alert_type,object_id) where resolved_at is null do update set
      severity='critical',detail=excluded.detail;
    return false;
  end if;
  insert into private.billing_webhook_events(
    stripe_event_id,event_type,object_id,event_created_at,payload_sha256,livemode
  ) values(
    p_event_id,p_event_type,left(coalesce(p_object_id,''),255),p_event_created_at,
    p_payload_sha256,p_livemode
  ) on conflict (stripe_event_id) do nothing;
  if found then return true; end if;
  select event.payload_sha256,event.processing_state,event.attempt_count,event.updated_at
  into v_existing_sha,v_processing_state,v_attempt_count,v_updated_at
  from private.billing_webhook_events event
  where event.stripe_event_id=p_event_id
  for update;
  if v_existing_sha is distinct from p_payload_sha256 then
    insert into private.billing_reconciliation_alerts(
      alert_type,severity,object_id,detail
    ) values('event_id_payload_conflict','critical',left(coalesce(p_object_id,''),255),
      'A duplicate Stripe event identifier arrived with a different payload digest.')
    on conflict (alert_type,object_id) where resolved_at is null do update set
      severity='critical',detail=excluded.detail;
    return false;
  end if;
  if v_processing_state in ('processed','ignored','review_required') then return false; end if;
  if v_attempt_count >= 20 then
    insert into private.billing_reconciliation_alerts(
      alert_type,severity,object_id,detail
    ) values('webhook_retry_exhausted','critical',left(coalesce(p_object_id,''),255),
      'A Stripe webhook exhausted its bounded database processing retries.')
    on conflict (alert_type,object_id) where resolved_at is null do update set
      severity='critical',detail=excluded.detail;
    update private.billing_webhook_events event
    set processing_state='review_required',processed_at=now(),
        last_error='webhook_retry_exhausted',updated_at=now()
    where event.stripe_event_id=p_event_id;
    return false;
  end if;
  if v_processing_state='failed'
    or (v_processing_state='processing' and v_updated_at < now()-interval '5 minutes') then
    update private.billing_webhook_events event
    set processing_state='processing',attempt_count=event.attempt_count+1,
        last_error='',processed_at=null,updated_at=now()
    where event.stripe_event_id=p_event_id;
    return true;
  end if;
  return false;
end;
$$;
revoke all on function public.billing_record_webhook_event(text,text,text,timestamptz,text,boolean)
  from public,anon,authenticated;
grant execute on function public.billing_record_webhook_event(text,text,text,timestamptz,text,boolean)
  to service_role;

create or replace function public.billing_webhook_event_disposition(
  p_event_id text,p_payload_sha256 text
)
returns text
language plpgsql security definer stable set search_path = '' as $$
declare v_event private.billing_webhook_events%rowtype;
begin
  if p_event_id !~ '^evt_[A-Za-z0-9]+$'
    or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid webhook disposition request';
  end if;
  select * into v_event from private.billing_webhook_events event
  where event.stripe_event_id=p_event_id;
  if not found or v_event.payload_sha256 is distinct from p_payload_sha256 then
    raise exception 'Webhook disposition could not be verified';
  end if;
  if v_event.processing_state in ('processed','ignored','review_required') then
    return 'terminal';
  end if;
  if v_event.processing_state='processing' then return 'active'; end if;
  raise exception 'Webhook event is not in a duplicate-safe state';
end;
$$;
revoke all on function public.billing_webhook_event_disposition(text,text)
  from public,anon,authenticated;
grant execute on function public.billing_webhook_event_disposition(text,text)
  to service_role;

create or replace function public.billing_apply_checkout_event(
  p_event_id text,p_account_id uuid,p_customer_id text,p_subscription_id text,
  p_reservation_id uuid,p_session_id text,p_checkout_status text,
  p_trial_start timestamptz,p_trial_end timestamptz
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_livemode boolean;v_closure_state text;v_trial_eligible boolean;
begin
  if p_account_id is null or p_reservation_id is null
    or p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_session_id !~ '^cs_(test_|live_)?[A-Za-z0-9]+$'
    or (coalesce(p_subscription_id,'')<>'' and p_subscription_id !~ '^sub_[A-Za-z0-9]+$') then
    raise exception 'Invalid Stripe checkout identifiers';
  end if;
  if p_checkout_status not in ('complete','expired') then raise exception 'Invalid checkout state'; end if;
  if (p_trial_start is null)<>(p_trial_end is null)
    or (p_trial_start is not null and p_trial_end<>p_trial_start+interval '7 days')
    or (p_checkout_status='expired' and p_trial_start is not null) then
    raise exception 'Invalid canonical Checkout trial proof';
  end if;
  select event.livemode into v_livemode
  from private.billing_webhook_events event
  where event.stripe_event_id=p_event_id and event.processing_state='processing'
  for update;
  if not found then return false; end if;
  if p_checkout_status='complete' and coalesce(p_subscription_id,'')='' then
    raise exception 'Completed checkout is missing its subscription';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  select closure.state into v_closure_state
  from private.billing_account_closures closure
  where closure.account_id=p_account_id;
  if exists(select 1 from private.billing_customers customer
    where customer.stripe_customer_id=p_customer_id and customer.account_id<>p_account_id) then
    raise exception 'Stripe customer is already bound to another account';
  end if;
  insert into private.billing_customers(account_id,stripe_customer_id,livemode)
  values(p_account_id,p_customer_id,v_livemode)
  on conflict (account_id) do update set
    stripe_customer_id=excluded.stripe_customer_id,livemode=excluded.livemode,updated_at=now()
  where private.billing_customers.stripe_customer_id=excluded.stripe_customer_id;
  if not found then raise exception 'Account is already bound to another Stripe customer'; end if;
  update private.billing_checkout_reservations reservation
  set stripe_checkout_session_id=coalesce(reservation.stripe_checkout_session_id,p_session_id),
      stripe_subscription_id=case when p_checkout_status='complete'
        then p_subscription_id else reservation.stripe_subscription_id end,
      status=case when p_checkout_status='complete' then 'completed' else 'expired' end,
      updated_at=now()
  where reservation.id=p_reservation_id and reservation.account_id=p_account_id
    and (
      reservation.status in ('provider_pending','session_created')
      or (p_checkout_status='expired' and reservation.status='expired')
      or (p_checkout_status='complete' and reservation.status='completed'
        and reservation.stripe_checkout_session_id=p_session_id
        and reservation.stripe_subscription_id=p_subscription_id)
    )
    and (reservation.stripe_checkout_session_id is null
      or reservation.stripe_checkout_session_id=p_session_id)
  returning reservation.trial_eligible into v_trial_eligible;
  if not found then raise exception 'Checkout reservation does not match the verified session'; end if;
  if p_checkout_status='complete' and p_trial_start is not null then
    if not v_trial_eligible then
      raise exception 'Canonical Checkout trial does not match its reservation';
    end if;
    update private.billing_trial_claims claim
    set claim_state='consumed',consumed_at=coalesce(claim.consumed_at,now()),
        consumed_subscription_id=coalesce(claim.consumed_subscription_id,p_subscription_id),
        reservation_expires_at=null,updated_at=now()
    where claim.account_id=p_account_id and (
      (claim.claim_state='reserved' and claim.consumed_subscription_id is null)
      or (claim.claim_state='consumed'
        and claim.consumed_subscription_id=p_subscription_id)
    );
    if not found then
      raise exception 'Canonical Checkout trial claim could not be bound';
    end if;
  end if;
  if v_closure_state is not null and p_checkout_status='complete' then
    insert into private.billing_reconciliation_alerts(
      account_id,alert_type,severity,object_id,detail
    ) values(
      p_account_id,'closed_account_financial_event','critical',p_session_id,
      'A canonical Checkout completed while the account was closing or deleted; public access remains blocked and operator cancellation review is required.'
    ) on conflict (alert_type,object_id) where resolved_at is null do update set
      severity='critical',detail=excluded.detail;
    update private.billing_webhook_events
    set processing_state='review_required',processed_at=now(),updated_at=now(),
        last_error='closed_account_checkout_completed'
    where stripe_event_id=p_event_id;
    return true;
  end if;
  update private.billing_webhook_events
  set processing_state='processed',processed_at=now(),updated_at=now(),last_error=''
  where stripe_event_id=p_event_id;
  return true;
end;
$$;
revoke all on function public.billing_apply_checkout_event(
  text,uuid,text,text,uuid,text,text,timestamptz,timestamptz
)
  from public,anon,authenticated;
grant execute on function public.billing_apply_checkout_event(
  text,uuid,text,text,uuid,text,text,timestamptz,timestamptz
)
  to service_role;

create or replace function public.billing_duplicate_subscription_candidate(
  p_event_id text,p_account_id uuid,p_customer_id text,p_subscription_id text,
  p_subscription_status text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_duplicate boolean:=false;
begin
  if p_event_id !~ '^evt_[A-Za-z0-9]+$' or p_account_id is null
    or p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or p_subscription_status not in (
      'incomplete','incomplete_expired','trialing','active','past_due',
      'canceled','unpaid','paused'
    ) then
    raise exception 'Invalid duplicate-subscription candidate';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id=p_event_id and event.processing_state='processing'
  ) or not exists(
    select 1 from private.billing_customers customer
    where customer.account_id=p_account_id
      and customer.stripe_customer_id=p_customer_id
      and customer.provider_deleted_at is null
  ) then return false; end if;
  if p_subscription_status='canceled' then
    return exists(
      select 1 from private.billing_duplicate_subscription_remediations remediation
      where remediation.stripe_subscription_id=p_subscription_id
        and remediation.account_id=p_account_id
        and remediation.stripe_customer_id=p_customer_id
    );
  end if;
  if p_subscription_status not in (
    'trialing','active','past_due','unpaid','paused','incomplete'
  ) then return false; end if;
  select exists(
    select 1 from private.billing_subscriptions existing
    where existing.account_id=p_account_id
      and existing.stripe_subscription_id<>p_subscription_id
      and existing.status in (
        'trialing','active','past_due','unpaid','paused','incomplete'
      )
  ) into v_duplicate;
  if not v_duplicate then return false; end if;
  insert into private.billing_duplicate_subscription_remediations(
    stripe_subscription_id,account_id,stripe_customer_id,source_event_id
  ) values(p_subscription_id,p_account_id,p_customer_id,p_event_id)
  on conflict do nothing;
  return exists(
    select 1 from private.billing_duplicate_subscription_remediations remediation
    where remediation.stripe_subscription_id=p_subscription_id
      and remediation.account_id=p_account_id
      and remediation.stripe_customer_id=p_customer_id
  );
end;
$$;
revoke all on function public.billing_duplicate_subscription_candidate(
  text,uuid,text,text,text
) from public,anon,authenticated;
grant execute on function public.billing_duplicate_subscription_candidate(
  text,uuid,text,text,text
) to service_role;

create or replace function public.billing_record_duplicate_subscription_remediation(
  p_event_id text,p_account_id uuid,p_customer_id text,p_subscription_id text,
  p_invoice_id text,p_invoice_paid boolean,p_invoice_amount bigint,
  p_invoice_currency text,p_provider_canceled_at timestamptz
)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_event_id !~ '^evt_[A-Za-z0-9]+$' or p_account_id is null
    or p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or (p_invoice_id is not null and p_invoice_id !~ '^in_[A-Za-z0-9]+$')
    or (coalesce(p_invoice_paid,false) and (
      p_invoice_id is null or p_invoice_amount not between 1 and 1000000000
      or p_invoice_currency !~ '^[a-z]{3}$'
    ))
    or (not coalesce(p_invoice_paid,false) and (
      p_invoice_amount is not null or p_invoice_currency is not null
    ))
    or p_provider_canceled_at is null
    or p_provider_canceled_at>now()+interval '5 minutes' then
    raise exception 'Invalid duplicate-subscription remediation';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  if not exists(
    select 1 from private.billing_webhook_events event
    where event.stripe_event_id=p_event_id and event.processing_state='processing'
  ) or not exists(
    select 1 from private.billing_customers customer
    where customer.account_id=p_account_id
      and customer.stripe_customer_id=p_customer_id
  ) then return false; end if;
  insert into private.billing_duplicate_subscription_remediations(
    stripe_subscription_id,account_id,stripe_customer_id,source_event_id,
    state,stripe_invoice_id,refund_amount,refund_currency,
    refund_review_required,provider_canceled_at,updated_at
  ) values(
    p_subscription_id,p_account_id,p_customer_id,p_event_id,'provider_canceled',
    p_invoice_id,p_invoice_amount,p_invoice_currency,
    coalesce(p_invoice_paid,false),p_provider_canceled_at,now()
  ) on conflict (stripe_subscription_id) do update set
    state=case
      when private.billing_duplicate_subscription_remediations.state='cancel_pending'
        then 'provider_canceled'
      else private.billing_duplicate_subscription_remediations.state
    end,
    stripe_invoice_id=coalesce(
      excluded.stripe_invoice_id,
      private.billing_duplicate_subscription_remediations.stripe_invoice_id
    ),
    refund_amount=coalesce(
      private.billing_duplicate_subscription_remediations.refund_amount,
      excluded.refund_amount
    ),
    refund_currency=coalesce(
      private.billing_duplicate_subscription_remediations.refund_currency,
      excluded.refund_currency
    ),
    refund_review_required=case
      when private.billing_duplicate_subscription_remediations.state='provider_refunded'
        then false
      else private.billing_duplicate_subscription_remediations.refund_review_required
        or excluded.refund_review_required
    end,
    provider_canceled_at=greatest(
      coalesce(
        private.billing_duplicate_subscription_remediations.provider_canceled_at,
        excluded.provider_canceled_at
      ),
      excluded.provider_canceled_at
    ),updated_at=now()
  where private.billing_duplicate_subscription_remediations.account_id=excluded.account_id
    and private.billing_duplicate_subscription_remediations.stripe_customer_id=excluded.stripe_customer_id
    and (
      private.billing_duplicate_subscription_remediations.stripe_invoice_id is null
      or private.billing_duplicate_subscription_remediations.stripe_invoice_id
        is not distinct from excluded.stripe_invoice_id
    )
    and (
      private.billing_duplicate_subscription_remediations.refund_amount is null
      or private.billing_duplicate_subscription_remediations.refund_amount
        is not distinct from excluded.refund_amount
    )
    and (
      private.billing_duplicate_subscription_remediations.refund_currency is null
      or private.billing_duplicate_subscription_remediations.refund_currency
        is not distinct from excluded.refund_currency
    );
  if not found then return false; end if;
  update private.billing_reconciliation_alerts alert
  set resolved_at=coalesce(alert.resolved_at,now())
  where alert.alert_type='duplicate_renewable_subscription'
    and alert.object_id=p_subscription_id and alert.resolved_at is null;
  if coalesce(p_invoice_paid,false) and exists(
    select 1 from private.billing_duplicate_subscription_remediations remediation
    where remediation.stripe_subscription_id=p_subscription_id
      and remediation.state<>'provider_refunded'
  ) then
    insert into private.billing_reconciliation_alerts(
      account_id,alert_type,severity,object_id,detail
    ) values(
      p_account_id,'duplicate_subscription_refund_review','high',p_subscription_id,
      'The duplicate renewal was canceled without proration, but its latest canonical invoice was paid and requires an explicit refund decision.'
    ) on conflict (alert_type,object_id) where resolved_at is null do update set
      account_id=excluded.account_id,severity='high',detail=excluded.detail;
  end if;
  return true;
end;
$$;
revoke all on function public.billing_record_duplicate_subscription_remediation(
  text,uuid,text,text,text,boolean,bigint,text,timestamptz
) from public,anon,authenticated;
grant execute on function public.billing_record_duplicate_subscription_remediation(
  text,uuid,text,text,text,boolean,bigint,text,timestamptz
) to service_role;

create or replace function public.billing_admin_duplicate_refund_reviews(
  p_limit integer default 100
)
returns table(
  remediation_id uuid,masked_email text,state text,amount_minor bigint,
  currency text,refund_status text,approved_at timestamptz,
  created_at timestamptz,updated_at timestamptz
)
language plpgsql security definer stable set search_path = '' as $$
begin
  if not public.has_platform_role(array['global_administrator']::text[]) then
    raise exception 'Global administrator role required';
  end if;
  perform public.require_aal2();
  return query
  select remediation.id,public.billing_mask_email(user_row.email),
    remediation.state,remediation.refund_amount,
    remediation.refund_currency,remediation.refund_status,
    remediation.refund_approved_at,remediation.created_at,
    remediation.updated_at
  from private.billing_duplicate_subscription_remediations remediation
  left join auth.users user_row on user_row.id=remediation.account_id
  where remediation.refund_review_required
    and remediation.state in (
      'provider_canceled','refund_pending','provider_refund_pending',
      'refund_review_required'
    )
  order by remediation.created_at,remediation.id
  limit greatest(1,least(coalesce(p_limit,100),200));
end;
$$;
revoke all on function public.billing_admin_duplicate_refund_reviews(integer)
  from public,anon,authenticated;
grant execute on function public.billing_admin_duplicate_refund_reviews(integer)
  to authenticated;

create or replace function public.billing_admin_approve_duplicate_refund(
  p_remediation_id uuid,p_reason text
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=auth.uid();
  v_reason text:=trim(coalesce(p_reason,''));
  v_account_id uuid;
  v_remediation private.billing_duplicate_subscription_remediations%rowtype;
begin
  if not public.has_platform_role(array['global_administrator']::text[]) then
    raise exception 'Global administrator role required';
  end if;
  perform public.require_aal2();
  if p_remediation_id is null
    or char_length(v_reason) not between 10 and 1000
    or v_reason ~ '[[:cntrl:]]' then
    raise exception 'A valid refund review and approval reason are required';
  end if;
  select remediation.account_id into v_account_id
  from private.billing_duplicate_subscription_remediations remediation
  where remediation.id=p_remediation_id;
  if not found then raise exception 'Refund review not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_account_id::text,6810068)
  );
  select * into v_remediation
  from private.billing_duplicate_subscription_remediations remediation
  where remediation.id=p_remediation_id
    and remediation.account_id=v_account_id
  for update;
  if not found then raise exception 'Refund review not found'; end if;
  if exists(
    select 1 from private.billing_account_closures closure
    where closure.account_id=v_account_id
  ) then raise exception 'Account closure is in progress'; end if;
  if v_remediation.state in (
    'refund_pending','provider_refund_pending','provider_refunded'
  ) then
    return v_remediation.state;
  end if;
  if v_remediation.state<>'provider_canceled'
    or not v_remediation.refund_review_required
    or v_remediation.stripe_invoice_id is null
    or v_remediation.refund_amount is null
    or v_remediation.refund_currency is null then
    raise exception 'Refund evidence requires manual review';
  end if;
  update private.billing_duplicate_subscription_remediations remediation set
    state='refund_pending',refund_approved_by=v_actor,
    refund_approved_at=now(),refund_reason=v_reason,
    provider_refund_started_at=now(),updated_at=now()
  where remediation.id=p_remediation_id
    and remediation.account_id=v_account_id
    and remediation.state='provider_canceled';
  if not found then raise exception 'Refund review changed; reload and retry'; end if;
  update private.billing_reconciliation_alerts alert set
    severity='high',
    detail='An AAL2 global administrator approved the canonical duplicate charge for an exact provider-side refund. Provider verification or reconciliation remains pending.'
  where alert.alert_type='duplicate_subscription_refund_review'
    and alert.object_id=v_remediation.stripe_subscription_id
    and alert.resolved_at is null;
  insert into public.platform_security_events(
    actor_id,event_type,severity,source,subject_type,subject_id,
    subject_account_id,metadata
  ) values(
    v_actor,'billing_duplicate_refund_approved','warning','staff',
    'billing_refund_review',p_remediation_id::text,v_account_id,
    jsonb_build_object('remediation_id',p_remediation_id)
  );
  return 'refund_pending';
end;
$$;
revoke all on function public.billing_admin_approve_duplicate_refund(uuid,text)
  from public,anon,authenticated;
grant execute on function public.billing_admin_approve_duplicate_refund(uuid,text)
  to authenticated;

create or replace function public.billing_duplicate_refund_candidate_for_service(
  p_remediation_id uuid
)
returns jsonb
language plpgsql security definer stable set search_path = '' as $$
declare v_result jsonb;
begin
  if p_remediation_id is null then raise exception 'Refund review is required'; end if;
  select jsonb_build_object(
    'remediation_id',remediation.id,
    'account_id',remediation.account_id,
    'stripe_customer_id',remediation.stripe_customer_id,
    'stripe_subscription_id',remediation.stripe_subscription_id,
    'stripe_invoice_id',remediation.stripe_invoice_id,
    'state',remediation.state,
    'refund_amount',remediation.refund_amount,
    'refund_currency',remediation.refund_currency,
    'stripe_charge_id',remediation.stripe_charge_id,
    'stripe_payment_intent_id',remediation.stripe_payment_intent_id,
    'stripe_refund_id',remediation.stripe_refund_id,
    'refund_status',remediation.refund_status
  ) into v_result
  from private.billing_duplicate_subscription_remediations remediation
  join private.billing_customers customer
    on customer.account_id=remediation.account_id
   and customer.stripe_customer_id=remediation.stripe_customer_id
   and customer.provider_deleted_at is null
  where remediation.id=p_remediation_id
    and remediation.state in (
      'refund_pending','provider_refund_pending','provider_refunded'
    );
  if v_result is null then raise exception 'Refund candidate is unavailable'; end if;
  return v_result;
end;
$$;
revoke all on function public.billing_duplicate_refund_candidate_for_service(uuid)
  from public,anon,authenticated;
grant execute on function public.billing_duplicate_refund_candidate_for_service(uuid)
  to service_role;

create or replace function public.billing_bind_duplicate_refund_charge(
  p_remediation_id uuid,p_account_id uuid,p_customer_id text,
  p_subscription_id text,p_invoice_id text,p_charge_id text,
  p_payment_intent_id text,p_amount bigint,p_currency text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_account_id uuid;
begin
  if p_remediation_id is null or p_account_id is null
    or p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or p_invoice_id !~ '^in_[A-Za-z0-9]+$'
    or p_charge_id !~ '^ch_[A-Za-z0-9]+$'
    or p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$'
    or p_amount not between 1 and 1000000000
    or p_currency !~ '^[a-z]{3}$' then
    raise exception 'Invalid canonical refund charge';
  end if;
  select remediation.account_id into v_account_id
  from private.billing_duplicate_subscription_remediations remediation
  where remediation.id=p_remediation_id;
  if v_account_id is null or v_account_id<>p_account_id then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_account_id::text,6810068)
  );
  update private.billing_duplicate_subscription_remediations remediation set
    stripe_charge_id=coalesce(remediation.stripe_charge_id,p_charge_id),
    stripe_payment_intent_id=coalesce(
      remediation.stripe_payment_intent_id,p_payment_intent_id
    ),updated_at=now()
  where remediation.id=p_remediation_id
    and remediation.account_id=p_account_id
    and remediation.stripe_customer_id=p_customer_id
    and remediation.stripe_subscription_id=p_subscription_id
    and remediation.stripe_invoice_id=p_invoice_id
    and remediation.refund_amount=p_amount
    and remediation.refund_currency=p_currency
    and remediation.state='refund_pending'
    and (remediation.stripe_charge_id is null
      or remediation.stripe_charge_id=p_charge_id)
    and (remediation.stripe_payment_intent_id is null
      or remediation.stripe_payment_intent_id=p_payment_intent_id);
  return found;
end;
$$;
revoke all on function public.billing_bind_duplicate_refund_charge(
  uuid,uuid,text,text,text,text,text,bigint,text
) from public,anon,authenticated;
grant execute on function public.billing_bind_duplicate_refund_charge(
  uuid,uuid,text,text,text,text,text,bigint,text
) to service_role;

create or replace function public.billing_mark_duplicate_refund_review_required(
  p_remediation_id uuid,p_detail_code text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_account_id uuid;
  v_subscription_id text;
  v_detail_code text:=trim(coalesce(p_detail_code,''));
begin
  if p_remediation_id is null
    or v_detail_code !~ '^[a-z][a-z0-9_]{2,99}$' then
    raise exception 'Invalid refund review detail';
  end if;
  select remediation.account_id,remediation.stripe_subscription_id
    into v_account_id,v_subscription_id
  from private.billing_duplicate_subscription_remediations remediation
  where remediation.id=p_remediation_id;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_account_id::text,6810068)
  );
  update private.billing_duplicate_subscription_remediations remediation set
    state='refund_review_required',refund_review_required=true,updated_at=now()
  where remediation.id=p_remediation_id
    and remediation.account_id=v_account_id
    and remediation.state in ('refund_pending','provider_refund_pending');
  if not found then
    return exists(
      select 1 from private.billing_duplicate_subscription_remediations remediation
      where remediation.id=p_remediation_id
        and remediation.state in ('refund_review_required','provider_refunded')
    );
  end if;
  insert into private.billing_reconciliation_alerts(
    account_id,alert_type,severity,object_id,detail
  ) values(
    v_account_id,'duplicate_subscription_refund_review','critical',
    v_subscription_id,
    'Provider evidence was ambiguous or a refund did not complete. Automatic retry is disabled; an operator must reconcile this case. Code: '||v_detail_code
  ) on conflict (alert_type,object_id) where resolved_at is null do update set
    account_id=excluded.account_id,severity='critical',detail=excluded.detail;
  return true;
end;
$$;
revoke all on function public.billing_mark_duplicate_refund_review_required(uuid,text)
  from public,anon,authenticated;
grant execute on function public.billing_mark_duplicate_refund_review_required(uuid,text)
  to service_role;

create or replace function public.billing_record_duplicate_refund_result(
  p_remediation_id uuid,p_account_id uuid,p_customer_id text,
  p_subscription_id text,p_invoice_id text,p_charge_id text,
  p_payment_intent_id text,p_refund_id text,p_amount bigint,
  p_currency text,p_status text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_subscription_id text;
begin
  if p_remediation_id is null or p_account_id is null
    or p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or p_invoice_id !~ '^in_[A-Za-z0-9]+$'
    or p_charge_id !~ '^ch_[A-Za-z0-9]+$'
    or p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$'
    or p_refund_id !~ '^re_[A-Za-z0-9]+$'
    or p_amount not between 1 and 1000000000
    or p_currency !~ '^[a-z]{3}$'
    or p_status not in (
      'pending','requires_action','succeeded','failed','canceled'
    ) then raise exception 'Invalid canonical refund result'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  update private.billing_duplicate_subscription_remediations remediation set
    stripe_charge_id=p_charge_id,
    stripe_payment_intent_id=p_payment_intent_id,
    stripe_refund_id=p_refund_id,refund_status=p_status,
    state=case
      when p_status='succeeded' then 'provider_refunded'
      when p_status in ('pending','requires_action')
        then 'provider_refund_pending'
      else 'refund_review_required'
    end,
    refund_review_required=(p_status<>'succeeded'),
    provider_refunded_at=case
      when p_status='succeeded'
        then coalesce(remediation.provider_refunded_at,now())
      else null
    end,updated_at=now()
  where remediation.id=p_remediation_id
    and remediation.account_id=p_account_id
    and remediation.stripe_customer_id=p_customer_id
    and remediation.stripe_subscription_id=p_subscription_id
    and remediation.stripe_invoice_id=p_invoice_id
    and remediation.refund_amount=p_amount
    and remediation.refund_currency=p_currency
    and remediation.state in (
      'refund_pending','provider_refund_pending','provider_refunded'
    )
    and (remediation.stripe_charge_id is null
      or remediation.stripe_charge_id=p_charge_id)
    and (remediation.stripe_payment_intent_id is null
      or remediation.stripe_payment_intent_id=p_payment_intent_id)
    and (remediation.stripe_refund_id is null
      or remediation.stripe_refund_id=p_refund_id)
    and not (remediation.state='provider_refunded' and p_status<>'succeeded')
  returning remediation.stripe_subscription_id into v_subscription_id;
  if not found then return false; end if;
  if p_status='succeeded' then
    update private.billing_reconciliation_alerts alert set resolved_at=now()
    where alert.alert_type='duplicate_subscription_refund_review'
      and alert.object_id=v_subscription_id and alert.resolved_at is null;
  else
    insert into private.billing_reconciliation_alerts(
      account_id,alert_type,severity,object_id,detail
    ) values(
      p_account_id,'duplicate_subscription_refund_review',
      case when p_status in ('failed','canceled') then 'critical' else 'high' end,
      v_subscription_id,
      case when p_status in ('failed','canceled')
        then 'The approved duplicate refund did not complete. Automatic retry is disabled; an operator must reconcile it.'
        else 'The approved duplicate refund is pending at the provider and must be reconciled from signed webhooks.' end
    ) on conflict (alert_type,object_id) where resolved_at is null do update set
      account_id=excluded.account_id,severity=excluded.severity,detail=excluded.detail;
  end if;
  return true;
end;
$$;
revoke all on function public.billing_record_duplicate_refund_result(
  uuid,uuid,text,text,text,text,text,text,bigint,text,text
) from public,anon,authenticated;
grant execute on function public.billing_record_duplicate_refund_result(
  uuid,uuid,text,text,text,text,text,text,bigint,text,text
) to service_role;

create or replace function public.billing_apply_expected_duplicate_refund_event(
  p_event_id text,p_remediation_id uuid,p_account_id uuid,p_customer_id text,
  p_subscription_id text,p_invoice_id text,p_charge_id text,
  p_payment_intent_id text,p_refund_id text,p_amount bigint,
  p_currency text,p_status text,p_reason text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_event private.billing_webhook_events%rowtype;
  v_source_livemode boolean;
begin
  if p_event_id !~ '^evt_[A-Za-z0-9]+$'
    or p_remediation_id is null or p_account_id is null
    or p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or p_invoice_id !~ '^in_[A-Za-z0-9]+$'
    or p_charge_id !~ '^ch_[A-Za-z0-9]+$'
    or p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$'
    or p_refund_id !~ '^re_[A-Za-z0-9]+$'
    or p_amount not between 1 and 1000000000
    or p_currency !~ '^[a-z]{3}$'
    or p_status not in (
      'pending','requires_action','succeeded','failed','canceled'
    ) or p_reason<>'duplicate' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  select * into v_event
  from private.billing_webhook_events event
  where event.stripe_event_id=p_event_id
    and event.processing_state='processing'
  for update;
  if not found or not (
    (v_event.event_type='charge.refunded'
      and v_event.object_id=p_charge_id and p_status='succeeded')
    or (v_event.event_type in ('refund.created','refund.updated','refund.failed')
      and v_event.object_id=p_refund_id)
  ) then return false; end if;
  select source_event.livemode into v_source_livemode
  from private.billing_duplicate_subscription_remediations remediation
  join private.billing_webhook_events source_event
    on source_event.stripe_event_id=remediation.source_event_id
  where remediation.id=p_remediation_id
    and remediation.account_id=p_account_id
    and remediation.stripe_customer_id=p_customer_id
    and remediation.stripe_subscription_id=p_subscription_id
    and remediation.stripe_invoice_id=p_invoice_id
    and remediation.refund_amount=p_amount
    and remediation.refund_currency=p_currency
    and remediation.refund_approved_by is not null
    and remediation.refund_approved_at is not null
    and remediation.refund_reason is not null
    and remediation.provider_refund_started_at is not null
    and remediation.state in (
      'refund_pending','provider_refund_pending','provider_refunded'
    )
    and (remediation.stripe_charge_id is null
      or remediation.stripe_charge_id=p_charge_id)
    and (remediation.stripe_payment_intent_id is null
      or remediation.stripe_payment_intent_id=p_payment_intent_id)
    and (remediation.stripe_refund_id is null
      or remediation.stripe_refund_id=p_refund_id)
  for update of remediation;
  if not found or v_source_livemode<>v_event.livemode then return false; end if;
  if not public.billing_record_duplicate_refund_result(
    p_remediation_id,p_account_id,p_customer_id,p_subscription_id,p_invoice_id,
    p_charge_id,p_payment_intent_id,p_refund_id,p_amount,p_currency,p_status
  ) then return false; end if;
  update private.billing_webhook_events event set
    processing_state='processed',processed_at=now(),updated_at=now(),
    last_error=case when p_status in ('failed','canceled')
      then 'expected_duplicate_refund_manual_review' else '' end
  where event.stripe_event_id=p_event_id
    and event.processing_state='processing';
  return found;
end;
$$;
revoke all on function public.billing_apply_expected_duplicate_refund_event(
  text,uuid,uuid,text,text,text,text,text,text,bigint,text,text,text
) from public,anon,authenticated;
grant execute on function public.billing_apply_expected_duplicate_refund_event(
  text,uuid,uuid,text,text,text,text,text,text,bigint,text,text,text
) to service_role;

create or replace function public.billing_apply_subscription_event(
  p_event_id text,p_account_id uuid,p_customer_id text,p_subscription_id text,
  p_price_id text,p_plan_code text,p_status text,p_trial_start timestamptz,
  p_trial_end timestamptz,p_period_start timestamptz,p_period_end timestamptz,
  p_cancel_at_period_end boolean,p_cancel_at timestamptz,p_canceled_at timestamptz,
  p_invoice_id text,p_invoice_status text,p_invoice_paid boolean
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_event private.billing_webhook_events%rowtype;
  v_plan private.billing_plan_catalog%rowtype;
  v_trial_verified boolean:=false;
  v_previous_state text:='subscription_required';
  v_previous_access boolean:=false;
  v_new_state text;
  v_new_access boolean:=false;
  v_rows integer:=0;
  v_closure_state text;
begin
  if p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or p_price_id !~ '^price_[A-Za-z0-9]+$' then
    raise exception 'Invalid Stripe subscription identifiers';
  end if;
  if p_status not in (
    'incomplete','incomplete_expired','trialing','active','past_due',
    'canceled','unpaid','paused'
  ) then raise exception 'Unknown Stripe subscription status'; end if;
  select * into v_event from private.billing_webhook_events event
  where event.stripe_event_id=p_event_id and event.processing_state='processing'
  for update;
  if not found then return false; end if;
  select * into v_plan from private.billing_plan_catalog plan
  where plan.plan_code=p_plan_code and plan.active and plan.stripe_price_id=p_price_id
    and plan.livemode=v_event.livemode;
  if not found then
    insert into private.billing_reconciliation_alerts(
      account_id,alert_type,severity,object_id,detail
    ) values(p_account_id,'unknown_or_mismatched_price','critical',p_subscription_id,
      'Subscription Price did not match the configured plan catalog.')
    on conflict (alert_type,object_id) where resolved_at is null do update set
      severity='critical',detail=excluded.detail;
    update private.billing_webhook_events
    set processing_state='failed',last_error='unknown_or_mismatched_price',updated_at=now()
    where stripe_event_id=p_event_id;
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  select closure.state into v_closure_state
  from private.billing_account_closures closure
  where closure.account_id=p_account_id;
  if p_status in ('trialing','active','past_due','unpaid','paused','incomplete')
    and exists(
      select 1 from private.billing_subscriptions existing
      where existing.account_id=p_account_id
        and existing.stripe_subscription_id<>p_subscription_id
        and existing.status in ('trialing','active','past_due','unpaid','paused','incomplete')
    ) then
    insert into private.billing_reconciliation_alerts(
      account_id,alert_type,severity,object_id,detail
    ) values(
      p_account_id,'duplicate_renewable_subscription','critical',p_subscription_id,
      'A second renewable Stripe subscription was detected and must be canceled or refunded at the provider before this event can be reconciled.'
    ) on conflict (alert_type,object_id) where resolved_at is null do update set
      severity='critical',detail=excluded.detail;
    update private.billing_webhook_events event set
      processing_state='review_required',processed_at=now(),updated_at=now(),
      last_error='duplicate_renewable_subscription'
    where event.stripe_event_id=p_event_id;
    return true;
  end if;
  select snapshot.state,snapshot.access_allowed into v_previous_state,v_previous_access
  from public.billing_entitlement_snapshot(p_account_id) snapshot;
  if exists(select 1 from private.billing_customers customer
    where customer.stripe_customer_id=p_customer_id and customer.account_id<>p_account_id) then
    raise exception 'Stripe customer is already bound to another account';
  end if;
  insert into private.billing_customers(account_id,stripe_customer_id,livemode)
  values(p_account_id,p_customer_id,v_event.livemode)
  on conflict (account_id) do update set
    stripe_customer_id=excluded.stripe_customer_id,livemode=excluded.livemode,updated_at=now()
  where private.billing_customers.stripe_customer_id=excluded.stripe_customer_id;
  if not found then raise exception 'Account is already bound to another Stripe customer'; end if;
  if p_status='trialing' then
    update private.billing_trial_claims claim
    set claim_state='consumed',consumed_at=coalesce(claim.consumed_at,now()),
        consumed_subscription_id=coalesce(claim.consumed_subscription_id,p_subscription_id),
        reservation_expires_at=null,
        updated_at=now()
    where claim.account_id=p_account_id and (
      (claim.claim_state='reserved' and claim.consumed_subscription_id is null
        and claim.reservation_expires_at>now()-interval '24 hours')
      or (claim.claim_state='consumed'
        and claim.consumed_subscription_id=p_subscription_id)
    );
    v_trial_verified:=found;
  end if;
  if p_status<>'trialing' then
    select coalesce(existing.trial_claim_verified,false) into v_trial_verified
    from private.billing_subscriptions existing
    where existing.stripe_subscription_id=p_subscription_id;
    v_trial_verified:=coalesce(v_trial_verified,false);
  end if;
  insert into private.billing_subscriptions(
    stripe_subscription_id,account_id,stripe_customer_id,stripe_price_id,plan_code,
    status,trial_claim_verified,trial_start,trial_end,current_period_start,current_period_end,
    cancel_at_period_end,cancel_at,canceled_at,latest_invoice_id,latest_invoice_status,
    latest_invoice_paid,livemode,last_event_id,last_event_created_at
  ) values(
    p_subscription_id,p_account_id,p_customer_id,p_price_id,p_plan_code,
    p_status,v_trial_verified,p_trial_start,p_trial_end,p_period_start,p_period_end,
    coalesce(p_cancel_at_period_end,false),p_cancel_at,p_canceled_at,
    nullif(left(coalesce(p_invoice_id,''),255),''),left(coalesce(p_invoice_status,''),80),
    coalesce(p_invoice_paid,false),v_event.livemode,p_event_id,v_event.event_created_at
  ) on conflict (stripe_subscription_id) do update set
    account_id=excluded.account_id,stripe_customer_id=excluded.stripe_customer_id,
    stripe_price_id=excluded.stripe_price_id,plan_code=excluded.plan_code,
    status=excluded.status,
    trial_claim_verified=private.billing_subscriptions.trial_claim_verified or excluded.trial_claim_verified,
    trial_start=excluded.trial_start,trial_end=excluded.trial_end,
    current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,
    cancel_at_period_end=excluded.cancel_at_period_end,cancel_at=excluded.cancel_at,
    canceled_at=excluded.canceled_at,latest_invoice_id=excluded.latest_invoice_id,
    latest_invoice_status=excluded.latest_invoice_status,
    latest_invoice_paid=excluded.latest_invoice_paid,livemode=excluded.livemode,
    last_event_id=excluded.last_event_id,
    last_event_created_at=greatest(
      private.billing_subscriptions.last_event_created_at,excluded.last_event_created_at
    ),updated_at=now()
  where excluded.last_event_created_at>=private.billing_subscriptions.last_event_created_at;
  get diagnostics v_rows = row_count;
  if v_rows=0 then
    update private.billing_webhook_events
    set processing_state='processed',processed_at=now(),updated_at=now(),
        last_error='stale_event_ignored'
    where stripe_event_id=p_event_id;
    return true;
  end if;
  select snapshot.state,snapshot.access_allowed into v_new_state,v_new_access
  from public.billing_entitlement_snapshot(p_account_id) snapshot;
  if v_closure_state is null and not coalesce(v_previous_access,false)
    and coalesce(v_new_access,false) then
    perform private.advance_account_ai_tasks_past_due(p_account_id,now());
  end if;
  if v_new_state is distinct from v_previous_state then
    insert into private.billing_access_transitions(
      account_id,previous_state,new_state,cause,stripe_event_id,metadata
    ) values(
      p_account_id,coalesce(v_previous_state,'unknown'),coalesce(v_new_state,'unknown'),
      'stripe_subscription',p_event_id,
      jsonb_build_object('subscription_id',p_subscription_id,'status',p_status,'plan_code',p_plan_code)
    );
  end if;
  if v_closure_state is not null then
    insert into private.billing_reconciliation_alerts(
      account_id,alert_type,severity,object_id,detail
    ) values(
      p_account_id,'closed_account_financial_event','critical',p_subscription_id,
      'A canonical subscription event arrived for a closing or deleted account; public access remains blocked and operator cancellation review is required.'
    ) on conflict (alert_type,object_id) where resolved_at is null do update set
      severity='critical',detail=excluded.detail;
    update private.billing_webhook_events
    set processing_state='review_required',processed_at=now(),updated_at=now(),
        last_error='closed_account_subscription_event'
    where stripe_event_id=p_event_id;
  else
    update private.billing_webhook_events
    set processing_state='processed',processed_at=now(),updated_at=now(),last_error=''
    where stripe_event_id=p_event_id;
  end if;
  return true;
end;
$$;
revoke all on function public.billing_apply_subscription_event(
  text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,
  boolean,timestamptz,timestamptz,text,text,boolean
) from public,anon,authenticated;
grant execute on function public.billing_apply_subscription_event(
  text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,
  boolean,timestamptz,timestamptz,text,text,boolean
) to service_role;

create or replace function public.billing_apply_financial_hold_event(
  p_event_id text,p_account_id uuid,p_customer_id text,p_subscription_id text,
  p_invoice_id text,p_provider_object_type text,p_provider_object_id text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_event private.billing_webhook_events%rowtype;
  v_owned_account uuid;
  v_hold_id uuid;
  v_previous_state text;
  v_new_state text;
begin
  if p_account_id is null
    or p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or p_invoice_id !~ '^in_[A-Za-z0-9]+$'
    or p_provider_object_type not in ('charge','refund','dispute')
    or not (
      (p_provider_object_type='charge' and p_provider_object_id ~ '^ch_[A-Za-z0-9]+$')
      or (p_provider_object_type='refund' and p_provider_object_id ~ '^re_[A-Za-z0-9]+$')
      or (p_provider_object_type='dispute' and p_provider_object_id ~ '^du_[A-Za-z0-9]+$')
    ) then
    raise exception 'Invalid canonical financial event identifiers';
  end if;
  select * into v_event
  from private.billing_webhook_events event
  where event.stripe_event_id=p_event_id and event.processing_state='processing'
  for update;
  if not found then return false; end if;
  if v_event.object_id<>p_provider_object_id or not (
    (v_event.event_type='charge.refunded' and p_provider_object_type='charge')
    or (v_event.event_type in (
      'charge.dispute.created','charge.dispute.updated','charge.dispute.closed'
    ) and p_provider_object_type='dispute')
    or (v_event.event_type in ('refund.created','refund.updated','refund.failed')
      and p_provider_object_type='refund')
  ) then
    raise exception 'Financial event envelope does not match its canonical object';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text,6810068)
  );
  select sub.account_id into v_owned_account
  from private.billing_subscriptions sub
  join private.billing_customers customer
    on customer.account_id=sub.account_id
   and customer.stripe_customer_id=sub.stripe_customer_id
   and customer.livemode=sub.livemode
  where sub.account_id=p_account_id
    and sub.stripe_customer_id=p_customer_id
    and sub.stripe_subscription_id=p_subscription_id
    and sub.livemode=v_event.livemode
    and customer.stripe_customer_id=p_customer_id
  for update of sub;
  if v_owned_account is null then
    insert into private.billing_reconciliation_alerts(
      alert_type,severity,object_id,detail
    ) values(
      'unproven_financial_event_linkage','critical',p_provider_object_id,
      'Canonical provider objects could not be matched to one locally owned customer and subscription. No entitlement mutation was inferred.'
    ) on conflict (alert_type,object_id) where resolved_at is null do update set
      severity='critical',detail=excluded.detail;
    update private.billing_webhook_events event set
      processing_state='review_required',processed_at=now(),updated_at=now(),
      last_error='financial_event_linkage_unproven'
    where event.stripe_event_id=p_event_id;
    return true;
  end if;
  select snapshot.state into v_previous_state
  from public.billing_entitlement_snapshot(p_account_id) snapshot;
  insert into private.billing_financial_holds(
    account_id,stripe_customer_id,stripe_subscription_id,stripe_invoice_id,
    provider_object_type,provider_object_id,source_event_id,event_type
  ) values(
    p_account_id,p_customer_id,p_subscription_id,p_invoice_id,
    p_provider_object_type,p_provider_object_id,p_event_id,v_event.event_type
  )
  on conflict (source_event_id) do update set updated_at=now()
  returning id into v_hold_id;
  perform private.advance_account_ai_tasks_past_due(p_account_id,now());
  insert into private.billing_reconciliation_alerts(
    account_id,alert_type,severity,object_id,detail
  ) values(
    p_account_id,'financial_event_hold','critical',p_provider_object_id,
    'A canonically linked refund or dispute opened a fail-closed account hold. An AAL2 global administrator must reconcile it explicitly.'
  ) on conflict (alert_type,object_id) where resolved_at is null do update set
    account_id=excluded.account_id,severity='critical',detail=excluded.detail;
  select snapshot.state into v_new_state
  from public.billing_entitlement_snapshot(p_account_id) snapshot;
  if v_new_state is distinct from v_previous_state then
    insert into private.billing_access_transitions(
      account_id,previous_state,new_state,cause,stripe_event_id,metadata
    ) values(
      p_account_id,coalesce(v_previous_state,'unknown'),
      coalesce(v_new_state,'financial_review_hold'),'stripe_financial_hold',p_event_id,
      jsonb_build_object('hold_id',v_hold_id,'provider_object_type',p_provider_object_type)
    );
  end if;
  insert into public.platform_security_events(
    actor_id,event_type,severity,source,subject_type,subject_id,
    subject_account_id,metadata
  ) values(
    null,'billing_financial_hold_opened','critical','edge_function','account',
    p_account_id::text,p_account_id,
    jsonb_build_object('hold_id',v_hold_id,'provider_object_type',p_provider_object_type)
  );
  update private.billing_webhook_events event set
    processing_state='review_required',processed_at=now(),updated_at=now(),
    last_error='financial_hold_open'
  where event.stripe_event_id=p_event_id;
  return true;
end;
$$;
revoke all on function public.billing_apply_financial_hold_event(
  text,uuid,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.billing_apply_financial_hold_event(
  text,uuid,text,text,text,text,text
) to service_role;

create or replace function public.billing_apply_customer_financial_hold_event(
  p_event_id text,p_customer_id text,p_provider_object_type text,
  p_provider_object_id text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_event private.billing_webhook_events%rowtype;
  v_account_id uuid;
  v_hold_id uuid;
  v_previous_state text;
  v_new_state text;
begin
  if p_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_provider_object_type not in ('charge','refund','dispute')
    or not (
      (p_provider_object_type='charge' and p_provider_object_id ~ '^ch_[A-Za-z0-9]+$')
      or (p_provider_object_type='refund' and p_provider_object_id ~ '^re_[A-Za-z0-9]+$')
      or (p_provider_object_type='dispute' and p_provider_object_id ~ '^du_[A-Za-z0-9]+$')
    ) then
    raise exception 'Invalid canonical customer financial event identifiers';
  end if;
  select * into v_event
  from private.billing_webhook_events event
  where event.stripe_event_id=p_event_id and event.processing_state='processing'
  for update;
  if not found then return false; end if;
  if v_event.object_id<>p_provider_object_id or not (
    (v_event.event_type='charge.refunded' and p_provider_object_type='charge')
    or (v_event.event_type in (
      'charge.dispute.created','charge.dispute.updated','charge.dispute.closed'
    ) and p_provider_object_type='dispute')
    or (v_event.event_type in ('refund.created','refund.updated','refund.failed')
      and p_provider_object_type='refund')
  ) then
    raise exception 'Financial event envelope does not match its canonical object';
  end if;
  select customer.account_id into v_account_id
  from private.billing_customers customer
  where customer.stripe_customer_id=p_customer_id
    and customer.livemode=v_event.livemode;
  if v_account_id is null then
    insert into private.billing_reconciliation_alerts(
      alert_type,severity,object_id,detail
    ) values(
      'unproven_financial_customer_binding','critical',p_provider_object_id,
      'A canonical Charge Customer was not present in the immutable local Customer binding. No account ownership was inferred.'
    ) on conflict (alert_type,object_id) where resolved_at is null do update set
      severity='critical',detail=excluded.detail;
    update private.billing_webhook_events event set
      processing_state='review_required',processed_at=now(),updated_at=now(),
      last_error='financial_customer_binding_unproven'
    where event.stripe_event_id=p_event_id;
    return true;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_account_id::text,6810068)
  );
  perform 1 from private.billing_customers customer
  where customer.account_id=v_account_id
    and customer.stripe_customer_id=p_customer_id
    and customer.livemode=v_event.livemode
  for update;
  if not found then
    raise exception 'Canonical Customer binding changed during financial review';
  end if;
  select snapshot.state into v_previous_state
  from public.billing_entitlement_snapshot(v_account_id) snapshot;
  insert into private.billing_financial_holds(
    account_id,stripe_customer_id,evidence_level,provider_object_type,
    provider_object_id,source_event_id,event_type
  ) values(
    v_account_id,p_customer_id,'customer_binding',p_provider_object_type,
    p_provider_object_id,p_event_id,v_event.event_type
  )
  on conflict (source_event_id) do update set updated_at=now()
  returning id into v_hold_id;
  perform private.advance_account_ai_tasks_past_due(v_account_id,now());
  insert into private.billing_reconciliation_alerts(
    account_id,alert_type,severity,object_id,detail
  ) values(
    v_account_id,'financial_event_hold','critical',p_provider_object_id,
    'A canonical Charge matched this account Customer, but exact Invoice/Subscription linkage was unavailable. Access remains held for AAL2 administrator reconciliation.'
  ) on conflict (alert_type,object_id) where resolved_at is null do update set
    account_id=excluded.account_id,severity='critical',detail=excluded.detail;
  select snapshot.state into v_new_state
  from public.billing_entitlement_snapshot(v_account_id) snapshot;
  if v_new_state is distinct from v_previous_state then
    insert into private.billing_access_transitions(
      account_id,previous_state,new_state,cause,stripe_event_id,metadata
    ) values(
      v_account_id,coalesce(v_previous_state,'unknown'),
      coalesce(v_new_state,'financial_review_hold'),
      'stripe_customer_financial_hold',p_event_id,
      jsonb_build_object('hold_id',v_hold_id,'provider_object_type',p_provider_object_type)
    );
  end if;
  insert into public.platform_security_events(
    actor_id,event_type,severity,source,subject_type,subject_id,
    subject_account_id,metadata
  ) values(
    null,'billing_financial_hold_opened','critical','edge_function','account',
    v_account_id::text,v_account_id,
    jsonb_build_object('hold_id',v_hold_id,'evidence_level','customer_binding',
      'provider_object_type',p_provider_object_type)
  );
  update private.billing_webhook_events event set
    processing_state='review_required',processed_at=now(),updated_at=now(),
    last_error='financial_customer_hold_open'
  where event.stripe_event_id=p_event_id;
  return true;
end;
$$;
revoke all on function public.billing_apply_customer_financial_hold_event(
  text,text,text,text
) from public,anon,authenticated;
grant execute on function public.billing_apply_customer_financial_hold_event(
  text,text,text,text
) to service_role;

create or replace function public.billing_admin_financial_holds(
  p_account_id uuid default null,p_limit integer default 100
)
returns table(
  hold_id uuid,account_id uuid,masked_email text,event_category text,
  event_type text,opened_at timestamptz
)
language plpgsql security definer stable set search_path = '' as $$
begin
  if not public.has_platform_role(array['global_administrator']::text[]) then
    raise exception 'Global administrator role required';
  end if;
  perform public.require_aal2();
  return query
  select hold_row.id,hold_row.account_id,
    public.billing_mask_email(user_row.email),hold_row.provider_object_type,
    hold_row.event_type,hold_row.opened_at
  from private.billing_financial_holds hold_row
  left join auth.users user_row on user_row.id=hold_row.account_id
  where hold_row.state='open'
    and (p_account_id is null or hold_row.account_id=p_account_id)
  order by hold_row.opened_at,hold_row.id
  limit greatest(1,least(coalesce(p_limit,100),200));
end;
$$;
revoke all on function public.billing_admin_financial_holds(uuid,integer)
  from public,anon,authenticated;
grant execute on function public.billing_admin_financial_holds(uuid,integer)
  to authenticated;

create or replace function public.billing_admin_reconcile_financial_hold(
  p_hold_id uuid,p_reason text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=auth.uid();
  v_reason text:=trim(coalesce(p_reason,''));
  v_hold private.billing_financial_holds%rowtype;
  v_account_id uuid;
  v_previous_state text;
  v_new_state text;
begin
  if not public.has_platform_role(array['global_administrator']::text[]) then
    raise exception 'Global administrator role required';
  end if;
  perform public.require_aal2();
  if p_hold_id is null or char_length(v_reason) not between 10 and 1000 then
    raise exception 'A valid hold and reconciliation reason are required';
  end if;
  select hold_row.account_id into v_account_id
  from private.billing_financial_holds hold_row
  where hold_row.id=p_hold_id;
  if not found then raise exception 'Financial hold not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_account_id::text,6810068)
  );
  select * into v_hold
  from private.billing_financial_holds hold_row
  where hold_row.id=p_hold_id and hold_row.account_id=v_account_id
  for update;
  if not found then raise exception 'Financial hold not found'; end if;
  if v_hold.state='reconciled' then return true; end if;
  select snapshot.state into v_previous_state
  from public.billing_entitlement_snapshot(v_hold.account_id) snapshot;
  perform private.advance_account_ai_tasks_past_due(v_hold.account_id,now());
  update private.billing_financial_holds hold_row set
    state='reconciled',reconciled_at=now(),reconciled_by=v_actor,
    reconcile_reason=v_reason,updated_at=now()
  where hold_row.id=v_hold.id and hold_row.state='open';
  if not found then return true; end if;
  update private.billing_reconciliation_alerts alert set resolved_at=now()
  where alert.alert_type='financial_event_hold'
    and alert.object_id=v_hold.provider_object_id and alert.resolved_at is null
    and not exists(
      select 1 from private.billing_financial_holds other_hold
      where other_hold.provider_object_id=v_hold.provider_object_id
        and other_hold.state='open'
    );
  select snapshot.state into v_new_state
  from public.billing_entitlement_snapshot(v_hold.account_id) snapshot;
  if v_new_state is distinct from v_previous_state then
    insert into private.billing_access_transitions(
      account_id,previous_state,new_state,cause,actor_id,metadata
    ) values(
      v_hold.account_id,coalesce(v_previous_state,'financial_review_hold'),
      coalesce(v_new_state,'unknown'),'financial_hold_reconciled',v_actor,
      jsonb_build_object('hold_id',v_hold.id)
    );
  end if;
  insert into public.platform_security_events(
    actor_id,event_type,severity,source,subject_type,subject_id,
    subject_account_id,metadata
  ) values(
    v_actor,'billing_financial_hold_reconciled','warning','staff','account',
    v_hold.account_id::text,v_hold.account_id,jsonb_build_object('hold_id',v_hold.id)
  );
  return true;
end;
$$;
revoke all on function public.billing_admin_reconcile_financial_hold(uuid,text)
  from public,anon,authenticated;
grant execute on function public.billing_admin_reconcile_financial_hold(uuid,text)
  to authenticated;

create or replace function public.billing_mark_webhook_failed(
  p_event_id text,p_error text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update private.billing_webhook_events
  set processing_state='failed',
      last_error=left(regexp_replace(coalesce(p_error,''),
        '(sk_(test|live|restricted)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+)','[redacted]','gi'),1000),
      updated_at=now()
  where stripe_event_id=p_event_id and processing_state in ('processing','failed');
  return found;
end;
$$;
revoke all on function public.billing_mark_webhook_failed(text,text)
  from public,anon,authenticated;
grant execute on function public.billing_mark_webhook_failed(text,text) to service_role;

create or replace function public.billing_mark_webhook_review_required(
  p_event_id text,p_reason text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_event private.billing_webhook_events%rowtype;
  v_reason text:=lower(trim(coalesce(p_reason,'')));
begin
  if p_event_id !~ '^evt_[A-Za-z0-9]+$'
    or v_reason !~ '^[a-z0-9_]{3,100}$' then
    raise exception 'Invalid webhook review request';
  end if;
  select * into v_event
  from private.billing_webhook_events event
  where event.stripe_event_id=p_event_id
  for update;
  if not found then return false; end if;
  if v_event.processing_state='review_required' then return true; end if;
  if v_event.processing_state<>'processing' then return false; end if;
  insert into private.billing_reconciliation_alerts(
    alert_type,severity,object_id,detail
  ) values(
    'manual_financial_event_review','critical',
    left(coalesce(nullif(v_event.object_id,''),p_event_id),255),
    'A verified Stripe financial event requires manual review: '||v_reason||'.'
  ) on conflict (alert_type,object_id) where resolved_at is null do update set
    severity='critical',detail=excluded.detail;
  update private.billing_webhook_events
  set processing_state='review_required',processed_at=now(),updated_at=now(),
      last_error=left(v_reason,1000)
  where stripe_event_id=p_event_id;
  return true;
end;
$$;
revoke all on function public.billing_mark_webhook_review_required(text,text)
  from public,anon,authenticated;
grant execute on function public.billing_mark_webhook_review_required(text,text)
  to service_role;

create or replace function public.billing_reconciliation_candidates(p_limit integer default 100)
returns table(
  account_id uuid,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  plan_code text,
  subscription_status text,
  trial_start timestamptz,
  trial_end timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  cancel_at timestamptz,
  canceled_at timestamptz,
  latest_invoice_id text,
  latest_invoice_status text,
  latest_invoice_paid boolean,
  livemode boolean,
  last_event_created_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  select sub.account_id,sub.stripe_customer_id,sub.stripe_subscription_id,
    sub.stripe_price_id,sub.plan_code,sub.status,sub.trial_start,sub.trial_end,
    sub.current_period_start,sub.current_period_end,sub.cancel_at_period_end,
    sub.cancel_at,sub.canceled_at,sub.latest_invoice_id,sub.latest_invoice_status,
    sub.latest_invoice_paid,sub.livemode,sub.last_event_created_at
  from private.billing_subscriptions sub
  order by sub.last_reconciled_at asc nulls first,sub.updated_at asc,sub.stripe_subscription_id
  limit greatest(1,least(coalesce(p_limit,100),500))
$$;
revoke all on function public.billing_reconciliation_candidates(integer)
  from public,anon,authenticated;
grant execute on function public.billing_reconciliation_candidates(integer) to service_role;

create or replace function public.billing_record_reconciliation_result(
  p_account_id uuid,p_subscription_id text,p_result text,p_detail_code text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_result text:=lower(trim(coalesce(p_result,'')));
  v_detail text:=lower(trim(coalesce(p_detail_code,'')));
  v_alert_type text;
  v_severity text;
begin
  if p_account_id is null or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or v_result not in ('current','drifted','unavailable')
    or v_detail !~ '^[a-z0-9_]{3,100}$' then
    raise exception 'Invalid reconciliation result';
  end if;
  update private.billing_subscriptions sub
  set last_reconciled_at=now(),last_reconciliation_result=v_result
  where sub.account_id=p_account_id
    and sub.stripe_subscription_id=p_subscription_id;
  if not found then return false; end if;
  if v_result='current' then
    update private.billing_reconciliation_alerts alert
    set resolved_at=coalesce(alert.resolved_at,now())
    where alert.account_id=p_account_id and alert.object_id=p_subscription_id
      and alert.alert_type in ('billing_subscription_drift','billing_reconciliation_unavailable')
      and alert.resolved_at is null;
    return true;
  end if;
  v_alert_type:=case when v_result='drifted'
    then 'billing_subscription_drift' else 'billing_reconciliation_unavailable' end;
  v_severity:=case when v_result='drifted' then 'critical' else 'high' end;
  insert into private.billing_reconciliation_alerts(
    account_id,alert_type,severity,object_id,detail
  ) values(
    p_account_id,v_alert_type,v_severity,p_subscription_id,
    'Automated Stripe reconciliation reported: '||v_detail||'.'
  ) on conflict (alert_type,object_id) where resolved_at is null do update set
    account_id=excluded.account_id,severity=excluded.severity,detail=excluded.detail;
  return true;
end;
$$;
revoke all on function public.billing_record_reconciliation_result(uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.billing_record_reconciliation_result(uuid,text,text,text)
  to service_role;

create or replace function public.billing_run_retention(p_limit integer default 500)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer:=greatest(1,least(coalesce(p_limit,500),1000));
  v_checkout integer:=0;
  v_holds integer:=0;
  v_duplicate_remediations integer:=0;
  v_trials integer:=0;
  v_subscriptions integer:=0;
  v_customers integer:=0;
  v_webhooks integer:=0;
  v_alerts integer:=0;
  v_transitions integer:=0;
begin
  perform pg_catalog.pg_advisory_xact_lock(6810068001);
  with doomed as (
    select reservation.id
    from private.billing_checkout_reservations reservation
    where reservation.status in ('expired','abandoned')
      and reservation.updated_at<now()-interval '90 days'
    order by reservation.updated_at,reservation.id limit v_limit
  )
  delete from private.billing_checkout_reservations reservation
  using doomed where reservation.id=doomed.id;
  get diagnostics v_checkout=row_count;

  with doomed as (
    select hold_row.id
    from private.billing_financial_holds hold_row
    join private.billing_account_closures closure
      on closure.account_id=hold_row.account_id and closure.state='deleted'
    where hold_row.state='reconciled'
      and hold_row.reconciled_at<now()-interval '7 years'
    order by hold_row.reconciled_at,hold_row.id limit v_limit
  )
  delete from private.billing_financial_holds hold_row
  using doomed where hold_row.id=doomed.id;
  get diagnostics v_holds=row_count;

  with doomed as (
    select remediation.stripe_subscription_id
    from private.billing_duplicate_subscription_remediations remediation
    join private.billing_account_closures closure
      on closure.account_id=remediation.account_id and closure.state='deleted'
    where remediation.state in ('provider_canceled','provider_refunded')
      and case
        when remediation.state='provider_refunded'
          then remediation.provider_refunded_at
        else remediation.provider_canceled_at
      end<now()-interval '7 years'
      and not exists(
        select 1 from private.billing_reconciliation_alerts alert
        where alert.alert_type='duplicate_subscription_refund_review'
          and alert.object_id=remediation.stripe_subscription_id
          and alert.resolved_at is null
      )
    order by case
      when remediation.state='provider_refunded'
        then remediation.provider_refunded_at
      else remediation.provider_canceled_at
    end,remediation.stripe_subscription_id
    limit v_limit
  )
  delete from private.billing_duplicate_subscription_remediations remediation
  using doomed
  where remediation.stripe_subscription_id=doomed.stripe_subscription_id;
  get diagnostics v_duplicate_remediations=row_count;

  with doomed as (
    select claim.account_id
    from private.billing_trial_claims claim
    join private.billing_account_closures closure
      on closure.account_id=claim.account_id and closure.state='deleted'
    where claim.claim_state='consumed'
      and claim.retention_expires_at<=now()
    order by claim.retention_expires_at,claim.account_id limit v_limit
  )
  delete from private.billing_trial_claims claim
  using doomed where claim.account_id=doomed.account_id;
  get diagnostics v_trials=row_count;

  with doomed as (
    select sub.stripe_subscription_id
    from private.billing_subscriptions sub
    join private.billing_account_closures closure
      on closure.account_id=sub.account_id and closure.state='deleted'
    where sub.status in ('canceled','incomplete_expired')
      and sub.retention_expires_at<=now()
      and not exists(
        select 1 from private.billing_financial_holds hold_row
        where hold_row.account_id=sub.account_id
      )
    order by sub.retention_expires_at,sub.stripe_subscription_id limit v_limit
  )
  delete from private.billing_subscriptions sub
  using doomed where sub.stripe_subscription_id=doomed.stripe_subscription_id;
  get diagnostics v_subscriptions=row_count;

  with doomed as (
    select customer.account_id
    from private.billing_customers customer
    join private.billing_account_closures closure
      on closure.account_id=customer.account_id and closure.state='deleted'
    where customer.provider_deleted_at is not null
      and customer.retention_expires_at<=now()
      and not exists(
        select 1 from private.billing_subscriptions sub
        where sub.account_id=customer.account_id
      )
      and not exists(
        select 1 from private.billing_financial_holds hold_row
        where hold_row.account_id=customer.account_id
      )
    order by customer.retention_expires_at,customer.account_id limit v_limit
  )
  delete from private.billing_customers customer
  using doomed where customer.account_id=doomed.account_id;
  get diagnostics v_customers=row_count;

  with doomed as (
    select event.stripe_event_id
    from private.billing_webhook_events event
    where event.processing_state in ('processed','ignored')
      and event.received_at<now()-interval '400 days'
      and not exists(
        select 1 from private.billing_financial_holds hold_row
        where hold_row.source_event_id=event.stripe_event_id
      )
      and not exists(
        select 1 from private.billing_subscriptions sub
        where sub.last_event_id=event.stripe_event_id
      )
      and not exists(
        select 1 from private.billing_duplicate_subscription_remediations remediation
        where remediation.source_event_id=event.stripe_event_id
      )
    order by event.received_at,event.stripe_event_id limit v_limit
  )
  delete from private.billing_webhook_events event
  using doomed where event.stripe_event_id=doomed.stripe_event_id;
  get diagnostics v_webhooks=row_count;

  with doomed as (
    select alert.id from private.billing_reconciliation_alerts alert
    where alert.resolved_at<now()-interval '400 days'
    order by alert.resolved_at,alert.id limit v_limit
  )
  delete from private.billing_reconciliation_alerts alert
  using doomed where alert.id=doomed.id;
  get diagnostics v_alerts=row_count;

  with doomed as (
    select transition.id from private.billing_access_transitions transition
    where transition.created_at<now()-interval '400 days'
      and not exists(
        select 1 from private.billing_financial_holds hold_row
        where hold_row.account_id=transition.account_id and hold_row.state='open'
      )
    order by transition.created_at,transition.id limit v_limit
  )
  delete from private.billing_access_transitions transition
  using doomed where transition.id=doomed.id;
  get diagnostics v_transitions=row_count;

  return jsonb_build_object(
    'checkout_reservations',v_checkout,'financial_holds',v_holds,
    'duplicate_subscription_remediations',v_duplicate_remediations,
    'trial_claims',v_trials,'subscriptions',v_subscriptions,
    'customers',v_customers,'webhook_events',v_webhooks,
    'reconciliation_alerts',v_alerts,'access_transitions',v_transitions
  );
end;
$$;
revoke all on function public.billing_run_retention(integer)
  from public,anon,authenticated;
grant execute on function public.billing_run_retention(integer) to service_role;

-- Subscription-aware publication is reversible: reviewed publication state is
-- preserved while public projections fail closed. Unchanged reviewed pages can
-- return after entitlement recovery; changed or stale pages still cannot.
create or replace function public.persona_publication_is_current(pid uuid)
returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.personas persona
    where persona.id=pid
      and public.account_has_billing_access(persona.owner)
      and persona.publication_state='published'
      and persona.published_revision=persona.publication_revision
      and public.persona_public_urls_safe(persona.id)
      and public.persona_modules_are_canonical(persona.modules)
      and exists (
        select 1 from public.persona_publication_reviews review
        where review.persona_id=persona.id and review.owner=persona.owner
          and review.review_state='published'
          and review.reviewed_revision=persona.publication_revision
      )
      and exists (
        select 1 from public.persona_publication_dependency_sets dependency_set
        join public.persona_publication_reviews reviewed
          on reviewed.persona_id=dependency_set.persona_id
         and reviewed.owner=dependency_set.owner
        where dependency_set.persona_id=persona.id
          and dependency_set.owner=persona.owner
          and dependency_set.reviewed_revision=persona.publication_revision
          and dependency_set.manifest_sha256=reviewed.readiness_snapshot->>'manifest_sha256'
          and dependency_set.dependency_count=(
            select count(*) from public.persona_publication_dependencies counted
            where counted.persona_id=persona.id
          )
      )
      and not exists (
        select 1
        from public.persona_publication_dependencies dependency
        left join public.personas relative on relative.id=dependency.dependency_persona_id
        left join public.persona_publication_reviews relative_review
          on relative_review.persona_id=relative.id and relative_review.owner=relative.owner
        where dependency.persona_id=persona.id and (
          relative.id is null
          or relative.publication_state<>'published'
          or relative.publication_revision is distinct from dependency.dependency_revision
          or relative.published_revision is distinct from relative.publication_revision
          or relative_review.review_state is distinct from 'published'
          or relative_review.reviewed_revision is distinct from relative.publication_revision
          or public.persona_dependency_projection_hash(
            dependency.dependency_persona_id,dependency.dependency_kind
          ) is distinct from dependency.projection_sha256
          or (dependency.dependency_kind='family' and relative.visibility<>'public')
          or (dependency.dependency_kind in ('top8','linked')
            and relative.visibility not in ('public','unlisted'))
        )
      )
  )
$$;
revoke all on function public.persona_publication_is_current(uuid)
  from public,anon,authenticated;
grant execute on function public.persona_publication_is_current(uuid) to service_role;

create or replace function public.business_publication_is_current(p_business_id uuid)
returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1
    from public.businesses business
    join public.business_publication_reviews review
      on review.business_id=business.id and review.owner=business.owner
    cross join lateral (
      select public.business_publication_review_manifest(business.id) as manifest
    ) current_review
    where business.id=p_business_id
      and public.account_has_billing_access(business.owner)
      and business.page_status='published' and business.visibility='public'
      and business.published_at is not null
      and business.published_revision=business.publication_revision
      and review.review_state='published'
      and review.reviewed_revision=business.publication_revision
      and review.required_missing=0
      and review.published_at is not null
      and current_review.manifest->>'complete'='true'
      and review.readiness_snapshot->'review_manifest'=current_review.manifest
      and review.readiness_snapshot->>'manifest_sha256'=
        encode(extensions.digest(convert_to(current_review.manifest::text,'UTF8'),'sha256'),'hex')
  )
$$;
revoke all on function public.business_publication_is_current(uuid)
  from public,anon,authenticated;
grant execute on function public.business_publication_is_current(uuid) to service_role;

create or replace function public.account_can_search_personas()
returns boolean
language sql security definer stable set search_path = '' as $$
  select case
    when auth.uid() is not null then public.account_has_billing_access(auth.uid())
    when not public.billing_enforcement_enabled() then true
    else false
  end
$$;
revoke all on function public.account_can_search_personas()
  from public,anon,authenticated;
grant execute on function public.account_can_search_personas() to anon,authenticated;

-- A suspended owner must still be able to preserve and remove already-saved
-- Top 8 references while editing. This is not a search surface: it accepts one
-- owned source persona and returns only the exact identifiers already stored.
create or replace function public.owner_persona_top8_cards(p_persona_id uuid)
returns table(
  id uuid,handle text,name text,avatar_url text,available boolean
)
language sql security definer stable set search_path = '' as $$
  with source as (
    select persona.top8
    from public.personas persona
    where persona.id=p_persona_id and persona.owner=auth.uid()
  ), saved as (
    select item.saved_id,item.ordinality
    from source
    cross join lateral jsonb_array_elements_text(
      coalesce(source.top8,'[]'::jsonb)
    ) with ordinality as item(saved_id,ordinality)
    where item.saved_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  select saved.saved_id::uuid,
    case when target.owner=auth.uid() or public.persona_visible(target.id)
      then target.handle else '' end,
    case when target.owner=auth.uid() or public.persona_visible(target.id)
      then target.name else 'Unavailable saved persona' end,
    case when target.owner=auth.uid() or public.persona_visible(target.id)
      then target.avatar_url else null end,
    coalesce(target.owner=auth.uid() or public.persona_visible(target.id),false)
  from saved
  left join public.personas target on target.id=saved.saved_id::uuid
  order by saved.ordinality
$$;
revoke all on function public.owner_persona_top8_cards(uuid)
  from public,anon,authenticated;
grant execute on function public.owner_persona_top8_cards(uuid) to authenticated;

drop function if exists public.discover_personas(text,int);
create function public.discover_personas(q text default null,lim int default 80)
returns table(
  id uuid,handle text,name text,tagline text,bio text,nsfw boolean,
  visibility text,avatar_url text,banner_url text,bg_url text,feed_img_url text,
  music_url text,live_url text,theme text,topics text,hashtags text,
  top8 jsonb,modules jsonb,linked jsonb,title text,focus text,pet_project text,
  ai_disclosure text,publication_state text,created_at timestamptz,updated_at timestamptz
)
language plpgsql security definer stable set search_path = '' as $$
begin
  if not public.account_can_search_personas() then
    raise exception using errcode='P0001',message='BILLING_REQUIRED',
      detail='An active MyPersonas account is required for directory search.';
  end if;
  return query
  select persona.id,persona.handle,persona.name,persona.tagline,persona.bio,
    persona.nsfw,persona.visibility,persona.avatar_url,persona.banner_url,
    persona.bg_url,persona.feed_img_url,persona.music_url,persona.live_url,
    persona.theme,persona.topics,persona.hashtags,persona.top8,
    public.canonical_persona_modules(persona.modules),persona.linked,
    persona.title,persona.focus,persona.pet_project,persona.ai_disclosure,
    persona.publication_state,persona.created_at,persona.updated_at
  from public.personas persona
  where persona.visibility='public'
    and persona.publication_state='published'
    and public.persona_visible(persona.id)
    and (q is null or persona.name ilike '%'||q||'%'
      or persona.handle ilike '%'||q||'%'
      or persona.topics ilike '%'||q||'%'
      or persona.tagline ilike '%'||q||'%')
  order by persona.created_at desc
  limit greatest(1,least(coalesce(lim,80),200));
end;
$$;
revoke all on function public.discover_personas(text,int) from public;
grant execute on function public.discover_personas(text,int) to anon,authenticated;

create or replace function public.discover_personas_page(
  p_query text default null,p_limit int default 40,
  p_before_created_at timestamptz default null,p_before_id uuid default null
)
returns table(
  id uuid,handle text,name text,tagline text,bio text,nsfw boolean,
  visibility text,avatar_url text,banner_url text,bg_url text,feed_img_url text,
  music_url text,live_url text,theme text,topics text,hashtags text,
  top8 jsonb,modules jsonb,linked jsonb,title text,focus text,pet_project text,
  ai_disclosure text,publication_state text,created_at timestamptz,updated_at timestamptz
)
language plpgsql security definer stable set search_path = '' as $$
begin
  if (p_before_created_at is null) is distinct from (p_before_id is null) then
    raise exception 'A complete discovery cursor is required';
  end if;
  if not public.account_can_search_personas() then
    raise exception using errcode='P0001',message='BILLING_REQUIRED',
      detail='An active MyPersonas account is required for directory search.';
  end if;
  return query
  select persona.id,persona.handle,persona.name,persona.tagline,persona.bio,
    persona.nsfw,persona.visibility,persona.avatar_url,persona.banner_url,
    persona.bg_url,persona.feed_img_url,persona.music_url,persona.live_url,
    persona.theme,persona.topics,persona.hashtags,persona.top8,
    public.canonical_persona_modules(persona.modules),persona.linked,
    persona.title,persona.focus,persona.pet_project,persona.ai_disclosure,
    persona.publication_state,persona.created_at,persona.updated_at
  from public.personas persona
  where persona.visibility='public'
    and persona.publication_state='published'
    and public.persona_visible(persona.id)
    and (p_query is null or persona.name ilike '%'||p_query||'%'
      or persona.handle ilike '%'||p_query||'%'
      or persona.topics ilike '%'||p_query||'%'
      or persona.tagline ilike '%'||p_query||'%')
    and (
      p_before_created_at is null
      or persona.created_at<p_before_created_at
      or (persona.created_at=p_before_created_at and persona.id<p_before_id)
    )
  order by persona.created_at desc,persona.id desc
  limit greatest(1,least(coalesce(p_limit,40),200));
end;
$$;
revoke all on function public.discover_personas_page(text,int,timestamptz,uuid)
  from public;
grant execute on function public.discover_personas_page(text,int,timestamptz,uuid)
  to anon,authenticated;

drop policy if exists "personas visible read" on public.personas;
create policy "personas visible read" on public.personas for select using (
  owner=auth.uid()
  or (
    public.persona_visible(id)
    and public.account_can_search_personas()
  )
);

-- Scheduled AI work is filtered and rechecked atomically. Rows are preserved;
-- an account recovery does not synthesize a catch-up queue.
create or replace function private.advance_suspended_ai_generation_tasks(
  p_due_at timestamptz default now(),p_limit integer default 100
)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_account_id uuid;
  v_task public.ai_tasks%rowtype;
  v_next_publish timestamptz;
  v_advanced integer:=0;
  v_limit integer:=least(500,greatest(1,coalesce(p_limit,100)));
begin
  if p_due_at is null then raise exception 'Due time is required'; end if;
  for v_account_id in
    select distinct task.owner from public.ai_tasks task
    where task.active and task.next_run_at is not null and task.next_run_at<=p_due_at
      and (task.lease_expires_at is null or task.lease_expires_at<=p_due_at)
      and not public.account_has_billing_access(task.owner)
    order by task.owner
  loop
    exit when v_advanced>=v_limit;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_account_id::text,6810068)
    );
    if public.account_has_billing_access(v_account_id) then continue; end if;
    for v_task in
      select task.* from public.ai_tasks task
      where task.owner=v_account_id and task.active
        and task.next_run_at is not null and task.next_run_at<=p_due_at
        and (task.lease_expires_at is null or task.lease_expires_at<=p_due_at)
      order by task.next_run_at,task.id
      for update skip locked
      limit v_limit-v_advanced
    loop
      v_next_publish:=case
        when v_task.cadence in ('daily','weekly') then
          public.next_content_occurrence(
            v_task.cadence,v_task.schedule_day,v_task.schedule_time,
            v_task.timezone,p_due_at+interval '1 second'
          )
        else null
      end;
      update public.ai_tasks task set
        next_publish_at=v_next_publish,
        next_run_at=case when v_next_publish is null then null else
          greatest(
            v_next_publish-make_interval(mins=>v_task.lead_minutes),
            p_due_at+interval '1 minute'
          ) end,
        lease_token=null,lease_expires_at=null,last_status='paused_billing',
        last_error='Account membership is inactive; this occurrence was skipped without provider work.',
        updated_at=now()
      where task.id=v_task.id;
      v_advanced:=v_advanced+1;
    end loop;
  end loop;
  return v_advanced;
end;
$$;
revoke all on function private.advance_suspended_ai_generation_tasks(timestamptz,integer)
  from public,anon,authenticated;

create or replace function public.advance_suspended_ai_generation_tasks(
  p_due_at timestamptz default now(),p_limit integer default 100
)
returns integer
language sql security definer set search_path = '' as $$
  select private.advance_suspended_ai_generation_tasks(p_due_at,p_limit)
$$;
revoke all on function public.advance_suspended_ai_generation_tasks(timestamptz,integer)
  from public,anon,authenticated;
grant execute on function public.advance_suspended_ai_generation_tasks(timestamptz,integer)
  to service_role;

create or replace function public.due_ai_generation_tasks(
  p_due_at timestamptz default now(),p_limit integer default 8
)
returns setof public.ai_tasks
language sql security definer stable set search_path = '' as $$
  with due as (
    select task.id,task.owner,task.next_run_at,
      row_number() over(partition by task.owner order by task.next_run_at,task.id) as owner_rank
    from public.ai_tasks task
    where task.active and task.next_run_at is not null and task.next_run_at<=p_due_at
      and (task.lease_expires_at is null or task.lease_expires_at<=p_due_at)
      and public.account_has_billing_access(task.owner)
  )
  select task.* from due
  join public.ai_tasks task on task.id=due.id
  left join public.agent_generation_queue_state queue on queue.owner=due.owner
  order by due.owner_rank,queue.last_claimed_at nulls first,
    due.next_run_at,due.owner,due.id
  limit least(100,greatest(1,coalesce(p_limit,8)))
$$;
revoke all on function public.due_ai_generation_tasks(timestamptz,integer)
  from public,anon,authenticated;
grant execute on function public.due_ai_generation_tasks(timestamptz,integer)
  to service_role;

create or replace function public.claim_ai_task_generation(
  p_task_id uuid,p_due_at timestamptz,p_lease_token uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_task public.ai_tasks%rowtype;v_claimed_at timestamptz;v_owner uuid;
begin
  if p_lease_token is null then raise exception 'Lease token is required'; end if;
  select task.owner into v_owner from public.ai_tasks task where task.id=p_task_id;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,6810068)
  );
  select * into v_task from public.ai_tasks where id=p_task_id for update;
  if not found or v_task.owner<>v_owner or not v_task.active or v_task.next_run_at is null
    or v_task.next_run_at>p_due_at
    or not public.account_has_billing_access(v_task.owner)
    or (v_task.lease_expires_at is not null and v_task.lease_expires_at>now()) then
    return false;
  end if;
  update public.ai_tasks set lease_token=p_lease_token,
    lease_expires_at=now()+interval '5 minutes',last_status='processing',last_error=''
  where id=p_task_id;
  v_claimed_at:=clock_timestamp();
  insert into public.agent_generation_queue_state(owner,last_claimed_at,claim_count,updated_at)
  values(v_task.owner,v_claimed_at,1,v_claimed_at)
  on conflict(owner) do update set
    last_claimed_at=greatest(public.agent_generation_queue_state.last_claimed_at,excluded.last_claimed_at),
    claim_count=public.agent_generation_queue_state.claim_count+1,
    updated_at=greatest(public.agent_generation_queue_state.updated_at,excluded.updated_at);
  return true;
end;
$$;
revoke all on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  from public,anon,authenticated;
grant execute on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  to service_role;

comment on function public.account_has_billing_access(uuid) is
  'Central fail-closed account entitlement. Shadow mode allows existing behavior until explicitly activated.';
comment on function public.my_billing_status() is
  'Self-scoped safe billing state. Never returns Stripe identifiers or payment details.';
comment on function public.billing_admin_grant_developer(uuid,text,timestamptz) is
  'AAL2 global-admin free-access override. Refuses silently renewing subscriptions.';
comment on function public.discover_personas(text,int) is
  'Subscription-gated MyPersonas directory; direct exact-handle public pages remain separate.';
comment on function public.discover_personas_page(text,int,timestamptz,uuid) is
  'Cursor-paginated subscription-gated directory used by the browser and persona pickers.';

commit;
