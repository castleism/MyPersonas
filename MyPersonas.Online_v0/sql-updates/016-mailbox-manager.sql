-- Provider-neutral Inbox Concierge data model (Gmail is the first executor).
--
-- Owner-readable records contain only bounded, sanitized message metadata and
-- action summaries. Provider message ids, label snapshots, scan cursors, and
-- unsubscribe targets stay in service-only tables. Browser clients can select
-- their own summaries but cannot create or mutate scans or cleanup actions.

-- Composite keys make every mailbox and AI-backend relationship owner-bound.
create unique index if not exists account_ledger_id_owner_provider_idx
  on public.account_ledger (id, owner, provider);
create unique index if not exists ai_backends_id_owner_idx
  on public.ai_backends (id, owner);

create table if not exists public.mailbox_settings (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  provider text not null
    check (
      provider = lower(provider)
      and provider ~ '^[a-z][a-z0-9_-]{1,39}$'
    ),
  paused boolean not null default true,
  schedule_cadence text not null default 'manual'
    check (schedule_cadence in ('manual', 'daily', 'weekly')),
  next_scan_at timestamptz,
  include_spam_trash boolean not null default false,
  lookback_days integer not null default 90
    check (lookback_days between 1 and 3650),
  max_messages integer not null default 250
    check (max_messages between 10 and 5000),
  classifier_mode text not null default 'rules'
    check (classifier_mode in ('rules', 'ai')),
  ai_backend_id uuid,
  ai_consent boolean not null default false,
  ai_consent_at timestamptz,
  last_scan_at timestamptz,
  last_successful_scan_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner, provider)
    references public.account_ledger(id, owner, provider) on delete cascade,
  foreign key (ai_backend_id, owner)
    references public.ai_backends(id, owner),
  check (schedule_cadence <> 'manual' or next_scan_at is null),
  check (
    (
      classifier_mode = 'rules'
      and ai_backend_id is null
      and ai_consent = false
      and ai_consent_at is null
    )
    or (
      classifier_mode = 'ai'
      and ai_backend_id is not null
      and ai_consent = true
      and ai_consent_at is not null
    )
  ),
  check (
    last_successful_scan_at is null
    or last_scan_at is null
    or last_successful_scan_at <= last_scan_at
  )
);

create index if not exists mailbox_settings_owner_idx
  on public.mailbox_settings (owner, provider);
create index if not exists mailbox_settings_due_idx
  on public.mailbox_settings (next_scan_at)
  where paused = false and schedule_cadence <> 'manual';

create table if not exists public.mailbox_scan_runs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  provider text not null
    check (
      provider = lower(provider)
      and provider ~ '^[a-z][a-z0-9_-]{1,39}$'
    ),
  trigger_kind text not null
    check (trigger_kind in ('manual', 'scheduled')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  classifier_mode text not null
    check (classifier_mode in ('rules', 'ai')),
  settings_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings_snapshot) = 'object'),
  processed_count integer not null default 0 check (processed_count >= 0),
  found_count integer not null default 0 check (found_count >= 0),
  category_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(category_counts) = 'object'),
  error_code text not null default ''
    check (char_length(error_code) <= 80),
  error_message text not null default ''
    check (char_length(error_message) <= 500),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner, ledger_id),
  foreign key (ledger_id, owner, provider)
    references public.account_ledger(id, owner, provider) on delete cascade,
  check (found_count <= processed_count),
  check (
    (status = 'queued' and started_at is null and finished_at is null)
    or (status = 'running' and started_at is not null and finished_at is null)
    or (
      status in ('completed', 'failed', 'cancelled')
      and finished_at is not null
    )
  ),
  check (
    finished_at is null
    or started_at is null
    or finished_at >= started_at
  )
);

-- A mailbox may have history, but never more than one queued/running scan.
create unique index if not exists mailbox_scan_runs_one_active_idx
  on public.mailbox_scan_runs (ledger_id)
  where status in ('queued', 'running');
create index if not exists mailbox_scan_runs_owner_created_idx
  on public.mailbox_scan_runs (owner, created_at desc);
create index if not exists mailbox_scan_runs_schedule_idx
  on public.mailbox_scan_runs (status, created_at);

-- Page tokens and provider checkpoints can reveal mailbox state, so the
-- resumable scan cursor is separated from the owner-readable run summary.
create table if not exists public.mailbox_scan_state (
  scan_run_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  page_token text not null default ''
    check (char_length(page_token) <= 4096),
  processed_count integer not null default 0 check (processed_count >= 0),
  found_count integer not null default 0 check (found_count >= 0),
  checkpoint jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(checkpoint) = 'object'
      and octet_length(checkpoint::text) <= 65536
    ),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  foreign key (scan_run_id, owner, ledger_id)
    references public.mailbox_scan_runs(id, owner, ledger_id)
    on delete cascade,
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  check (found_count <= processed_count)
);

create index if not exists mailbox_scan_state_expiry_idx
  on public.mailbox_scan_state (expires_at);

-- Raw provider identifiers, current label ids, and unsubscribe targets are
-- deliberately service-only. No message body is stored anywhere in this model.
create table if not exists public.mailbox_message_refs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  scan_run_id uuid not null,
  provider_message_id text not null
    check (
      btrim(provider_message_id) <> ''
      and char_length(provider_message_id) <= 1024
    ),
  provider_thread_id text not null default ''
    check (char_length(provider_thread_id) <= 1024),
  rfc_message_id_hash text not null default ''
    check (
      rfc_message_id_hash = ''
      or rfc_message_id_hash ~ '^[0-9a-f]{64}$'
    ),
  current_labels text[] not null default '{}',
  unsubscribe_kind text not null default 'none'
    check (unsubscribe_kind in ('none', 'https', 'mailto', 'one_click')),
  unsubscribe_target text not null default ''
    check (char_length(unsubscribe_target) <= 8192),
  unsubscribe_host text not null default ''
    check (char_length(unsubscribe_host) <= 253),
  provider_internal_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner, ledger_id),
  unique (ledger_id, provider_message_id),
  foreign key (scan_run_id, owner, ledger_id)
    references public.mailbox_scan_runs(id, owner, ledger_id)
    on delete cascade,
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  check (
    (unsubscribe_kind = 'none' and unsubscribe_target = '')
    or (unsubscribe_kind <> 'none' and unsubscribe_target <> '')
  ),
  check (cardinality(current_labels) <= 256)
);

create index if not exists mailbox_message_refs_scan_idx
  on public.mailbox_message_refs (scan_run_id);

-- Findings expose only bounded metadata that a person needs to review a
-- recommendation. They never expose provider ids, unsubscribe URLs, or bodies.
create table if not exists public.mailbox_findings (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  scan_run_id uuid not null,
  message_ref_id uuid not null,
  category text not null
    check (
      category in (
        'subscription',
        'account_creation',
        'receipt',
        'security',
        'order_travel',
        'financial_legal_medical',
        'personal',
        'other'
      )
    ),
  sender_name text not null default ''
    check (char_length(sender_name) <= 200),
  sender_address text not null default ''
    check (char_length(sender_address) <= 320),
  sender_domain text not null default ''
    check (char_length(sender_domain) <= 253),
  subject text not null default ''
    check (char_length(subject) <= 500),
  snippet text not null default ''
    check (char_length(snippet) <= 1000),
  received_at timestamptz,
  confidence numeric(5,4) not null default 0
    check (confidence between 0 and 1),
  evidence text[] not null default '{}'
    check (cardinality(evidence) <= 32),
  protected_reasons text[] not null default '{}'
    check (cardinality(protected_reasons) <= 32),
  suggested_action text not null default 'keep'
    check (
      suggested_action in ('keep', 'label', 'label_archive', 'trash', 'review')
    ),
  unsubscribe_available boolean not null default false,
  status text not null default 'open'
    check (status in ('open', 'planned', 'acted', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner, ledger_id),
  unique (ledger_id, message_ref_id),
  foreign key (scan_run_id, owner, ledger_id)
    references public.mailbox_scan_runs(id, owner, ledger_id)
    on delete cascade,
  foreign key (message_ref_id, owner, ledger_id)
    references public.mailbox_message_refs(id, owner, ledger_id)
    on delete cascade,
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  -- Runtime planning and execution fail closed for every protected category or
  -- reason on every action. This constraint is an additional stored-data
  -- invariant limiting which unprotected findings may recommend Trash.
  check (
    suggested_action <> 'trash'
    or (
      category in ('subscription', 'other')
      and cardinality(protected_reasons) = 0
    )
  )
);

create index if not exists mailbox_findings_owner_status_idx
  on public.mailbox_findings (owner, ledger_id, status, received_at desc);
create index if not exists mailbox_findings_scan_category_idx
  on public.mailbox_findings (scan_run_id, category);

-- A plan is the immutable, owner-readable approval envelope. The ordered
-- finding id array plus plan_hash binds approval to an exact reviewed set
-- without exposing provider message ids.
create table if not exists public.mailbox_action_plans (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  operation text not null
    check (operation in ('label', 'label_archive', 'trash')),
  target_label text not null default ''
    check (char_length(target_label) <= 225),
  status text not null default 'pending_approval'
    check (
      status in (
        'draft',
        'pending_approval',
        'approved',
        'applying',
        'completed',
        'partial',
        'failed',
        'cancelled',
        'expired'
      )
    ),
  plan_hash text not null check (plan_hash ~ '^[0-9a-f]{64}$'),
  finding_ids uuid[] not null,
  total_count integer not null check (total_count between 1 and 500),
  category_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(category_counts) = 'object'),
  protected_excluded integer not null default 0
    check (protected_excluded >= 0),
  expires_at timestamptz not null,
  approved_at timestamptz,
  completed_at timestamptz,
  undo_status text not null default 'not_available'
    check (
      undo_status in (
        'not_available',
        'available',
        'requested',
        'running',
        'completed',
        'partial',
        'failed',
        'expired'
      )
    ),
  undo_expires_at timestamptz,
  undo_requested_at timestamptz,
  undone_at timestamptz,
  error_code text not null default ''
    check (char_length(error_code) <= 80),
  error_message text not null default ''
    check (char_length(error_message) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner, ledger_id),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  check (cardinality(finding_ids) = total_count),
  check (array_position(finding_ids, null) is null),
  check (
    operation <> 'trash'
    or target_label = ''
  ),
  check (expires_at > created_at),
  check (approved_at is null or approved_at <= expires_at),
  check (
    status not in ('approved', 'applying', 'completed', 'partial', 'failed')
    or approved_at is not null
  ),
  check (
    status not in ('completed', 'partial', 'failed')
    or completed_at is not null
  ),
  check (
    (undo_status = 'not_available' and undo_expires_at is null)
    or (undo_status <> 'not_available' and undo_expires_at is not null)
  ),
  check (
    undo_requested_at is null
    or undo_status in ('requested', 'running', 'completed', 'partial', 'failed')
  ),
  check (
    undone_at is null
    or undo_status in ('completed', 'partial')
  )
);

create index if not exists mailbox_action_plans_owner_status_idx
  on public.mailbox_action_plans (owner, ledger_id, status, created_at desc);
create index if not exists mailbox_action_plans_expiry_idx
  on public.mailbox_action_plans (status, expires_at);
create index if not exists mailbox_action_plans_undo_expiry_idx
  on public.mailbox_action_plans (undo_status, undo_expires_at)
  where undo_expires_at is not null;

-- Items are the service-only execution manifest. Each row binds one approved
-- finding to the exact provider message id and pre-action label snapshot needed
-- to apply or undo the operation safely.
create table if not exists public.mailbox_action_items (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  plan_id uuid not null,
  finding_id uuid not null,
  message_ref_id uuid not null,
  provider_message_id text not null
    check (
      btrim(provider_message_id) <> ''
      and char_length(provider_message_id) <= 1024
    ),
  provider_thread_id text not null default ''
    check (char_length(provider_thread_id) <= 1024),
  category text not null
    check (
      category in (
        'subscription',
        'account_creation',
        'receipt',
        'security',
        'order_travel',
        'financial_legal_medical',
        'personal',
        'other'
      )
    ),
  ordinal integer not null check (ordinal > 0),
  prior_labels text[] not null default '{}'
    check (cardinality(prior_labels) <= 256),
  target_label text not null default ''
    check (char_length(target_label) <= 225),
  applied_labels text[] not null default '{}'
    check (cardinality(applied_labels) <= 256),
  status text not null default 'pending'
    check (
      status in (
        'pending',
        'applying',
        'applied',
        'failed',
        'skipped',
        'undoing',
        'undone',
        'undo_failed'
      )
    ),
  error_code text not null default ''
    check (char_length(error_code) <= 80),
  error_message text not null default ''
    check (char_length(error_message) <= 500),
  applied_at timestamptz,
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, ordinal),
  unique (plan_id, finding_id),
  unique (plan_id, provider_message_id),
  foreign key (plan_id, owner, ledger_id)
    references public.mailbox_action_plans(id, owner, ledger_id)
    on delete cascade,
  foreign key (finding_id, owner, ledger_id)
    references public.mailbox_findings(id, owner, ledger_id)
    on delete cascade,
  foreign key (message_ref_id, owner, ledger_id)
    references public.mailbox_message_refs(id, owner, ledger_id)
    on delete cascade,
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  check (
    status not in ('applied', 'undoing', 'undone', 'undo_failed')
    or applied_at is not null
  ),
  check (status <> 'undone' or undone_at is not null)
);

create index if not exists mailbox_action_items_plan_status_idx
  on public.mailbox_action_items (plan_id, status, ordinal);
create index if not exists mailbox_action_items_ref_idx
  on public.mailbox_action_items (message_ref_id);

-- Audit summaries are owner-readable, bounded, and intentionally omit generic
-- payload fields that could accidentally hold provider ids, URLs, or content.
create table if not exists public.mailbox_audit_events (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  scan_run_id uuid,
  action_plan_id uuid,
  event_type text not null
    check (
      event_type ~ '^[a-z][a-z0-9_.]{1,79}$'
      and char_length(event_type) <= 80
    ),
  status text not null
    check (status in ('info', 'succeeded', 'partial', 'failed', 'cancelled')),
  summary text not null
    check (
      btrim(summary) <> ''
      and char_length(summary) <= 500
    ),
  counts jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(counts) = 'object'
      and octet_length(counts::text) <= 16384
    ),
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  foreign key (scan_run_id, owner, ledger_id)
    references public.mailbox_scan_runs(id, owner, ledger_id),
  foreign key (action_plan_id, owner, ledger_id)
    references public.mailbox_action_plans(id, owner, ledger_id)
);

create index if not exists mailbox_audit_events_owner_created_idx
  on public.mailbox_audit_events (owner, ledger_id, created_at desc);

-- Bounded, reclaimable leases serialize each mailbox scan/action/undo and keep
-- multiple tabs or workers from applying the same approval twice.
create table if not exists public.mailbox_operation_leases (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  operation_kind text not null
    check (
      operation_kind in ('scan', 'plan', 'apply', 'undo', 'connect', 'disconnect', 'erase')
    ),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create index if not exists mailbox_operation_leases_expiry_idx
  on public.mailbox_operation_leases (expires_at);

alter table public.mailbox_settings enable row level security;
alter table public.mailbox_scan_runs enable row level security;
alter table public.mailbox_scan_state enable row level security;
alter table public.mailbox_message_refs enable row level security;
alter table public.mailbox_findings enable row level security;
alter table public.mailbox_action_plans enable row level security;
alter table public.mailbox_action_items enable row level security;
alter table public.mailbox_audit_events enable row level security;
alter table public.mailbox_operation_leases enable row level security;

-- Reapplying the migration recreates the five owner-select policies cleanly.
drop policy if exists "mailbox settings owner read"
  on public.mailbox_settings;
create policy "mailbox settings owner read"
  on public.mailbox_settings for select
  using (auth.uid() = owner);

drop policy if exists "mailbox scan runs owner read"
  on public.mailbox_scan_runs;
create policy "mailbox scan runs owner read"
  on public.mailbox_scan_runs for select
  using (auth.uid() = owner);

drop policy if exists "mailbox findings owner read"
  on public.mailbox_findings;
create policy "mailbox findings owner read"
  on public.mailbox_findings for select
  using (auth.uid() = owner);

drop policy if exists "mailbox action plans owner read"
  on public.mailbox_action_plans;
create policy "mailbox action plans owner read"
  on public.mailbox_action_plans for select
  using (auth.uid() = owner);

drop policy if exists "mailbox audit events owner read"
  on public.mailbox_audit_events;
create policy "mailbox audit events owner read"
  on public.mailbox_audit_events for select
  using (auth.uid() = owner);

-- Remove default browser privileges first, including PUBLIC, then grant only
-- owner-filtered SELECT on the sanitized review surfaces.
revoke all on table public.mailbox_settings
  from public, anon, authenticated;
revoke all on table public.mailbox_scan_runs
  from public, anon, authenticated;
revoke all on table public.mailbox_scan_state
  from public, anon, authenticated;
revoke all on table public.mailbox_message_refs
  from public, anon, authenticated;
revoke all on table public.mailbox_findings
  from public, anon, authenticated;
revoke all on table public.mailbox_action_plans
  from public, anon, authenticated;
revoke all on table public.mailbox_action_items
  from public, anon, authenticated;
revoke all on table public.mailbox_audit_events
  from public, anon, authenticated;
revoke all on table public.mailbox_operation_leases
  from public, anon, authenticated;

grant select on table public.mailbox_settings to authenticated;
grant select on table public.mailbox_scan_runs to authenticated;
grant select on table public.mailbox_findings to authenticated;
grant select on table public.mailbox_action_plans to authenticated;
grant select on table public.mailbox_audit_events to authenticated;

grant all on table public.mailbox_settings to service_role;
grant all on table public.mailbox_scan_runs to service_role;
grant all on table public.mailbox_scan_state to service_role;
grant all on table public.mailbox_message_refs to service_role;
grant all on table public.mailbox_findings to service_role;
grant all on table public.mailbox_action_plans to service_role;
grant all on table public.mailbox_action_items to service_role;
grant all on table public.mailbox_audit_events to service_role;
grant all on table public.mailbox_operation_leases to service_role;

create or replace function public.claim_mailbox_operation(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid,
  p_operation text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean := false;
begin
  if p_operation not in ('scan', 'plan', 'apply', 'undo', 'connect', 'disconnect', 'erase') then
    raise exception 'Invalid mailbox operation';
  end if;
  if p_ttl_seconds < 15 or p_ttl_seconds > 3600 then
    raise exception 'Mailbox operation lease must be between 15 and 3600 seconds';
  end if;
  if not exists (
    select 1
    from public.mailbox_settings as setting
    join public.account_ledger as ledger
      on ledger.id = setting.ledger_id
      and ledger.owner = setting.owner
      and ledger.provider = setting.provider
    where setting.ledger_id = p_ledger_id
      and setting.owner = p_owner
  ) then
    raise exception 'Owned mailbox settings not found';
  end if;

  insert into public.mailbox_operation_leases as lease (
    ledger_id,
    owner,
    lease_id,
    operation_kind,
    expires_at,
    created_at
  ) values (
    p_ledger_id,
    p_owner,
    p_lease_id,
    p_operation,
    now() + make_interval(secs => p_ttl_seconds),
    now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    lease_id = excluded.lease_id,
    operation_kind = excluded.operation_kind,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at
  where lease.expires_at <= now()
    or (
      lease.owner = excluded.owner
      and lease.lease_id = excluded.lease_id
      and lease.operation_kind = excluded.operation_kind
    )
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

create or replace function public.release_mailbox_operation(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer := 0;
begin
  delete from public.mailbox_operation_leases
  where ledger_id = p_ledger_id
    and owner = p_owner
    and lease_id = p_lease_id;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

-- Serialize active-plan admission per owner. This prevents duplicate previews
-- for the same finding and bounds one owner to ten queued cleanup/Undo jobs.
-- The advisory lock makes the count and overlap checks safe across tabs,
-- mailboxes, and concurrent Edge Function invocations.
create or replace function public.enforce_mailbox_action_plan_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_plan_count bigint := 0;
  v_active_undo_count bigint := 0;
begin
  if (
    new.status in ('pending_approval', 'approved', 'applying')
    and new.expires_at > now()
  ) or new.undo_status in ('requested', 'running') then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'mailbox-action-owner:' || new.owner::text,
        0
      )
    );
  end if;

  if (
    new.status in ('pending_approval', 'approved', 'applying')
    and new.expires_at > now()
  ) then
    if exists (
      select 1
      from public.mailbox_action_plans as active
      where active.owner = new.owner
        and active.id <> new.id
        and active.status in ('pending_approval', 'approved', 'applying')
        and active.expires_at > now()
        and active.finding_ids && new.finding_ids
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'mailbox_active_plan_overlap';
    end if;

    select count(*)
    into v_active_plan_count
    from public.mailbox_action_plans as active
    where active.owner = new.owner
      and active.id <> new.id
      and active.status in ('pending_approval', 'approved', 'applying')
      and active.expires_at > now();

    if v_active_plan_count >= 10 then
      raise exception using
        errcode = 'P0001',
        message = 'mailbox_active_plan_limit';
    end if;
  end if;

  if new.undo_status in ('requested', 'running') then
    select count(*)
    into v_active_undo_count
    from public.mailbox_action_plans as active
    where active.owner = new.owner
      and active.id <> new.id
      and active.undo_status in ('requested', 'running');

    if v_active_undo_count >= 10 then
      raise exception using
        errcode = 'P0001',
        message = 'mailbox_active_undo_limit';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_mailbox_action_plan_limits
  on public.mailbox_action_plans;
create trigger enforce_mailbox_action_plan_limits
  before insert or update on public.mailbox_action_plans
  for each row execute function public.enforce_mailbox_action_plan_limits();

-- Candidate selection filters pause state in SQL before LIMIT. A paused or
-- recovery-blocked owner can therefore never occupy the worker's entire
-- candidate window and starve another owner.
create or replace function public.next_runnable_mailbox_scan_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select run.id
  from public.mailbox_scan_runs as run
  join public.mailbox_settings as setting
    on setting.ledger_id = run.ledger_id
    and setting.owner = run.owner
  left join public.agent_owner_settings as owner_setting
    on owner_setting.owner = run.owner
  where run.status in ('queued', 'running')
    and setting.paused = false
    and coalesce(owner_setting.automation_paused, false) = false
  order by run.created_at asc, run.id asc
  limit 1;
$$;

create or replace function public.next_runnable_mailbox_plan_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select plan.id
  from public.mailbox_action_plans as plan
  join public.mailbox_settings as setting
    on setting.ledger_id = plan.ledger_id
    and setting.owner = plan.owner
  left join public.agent_owner_settings as owner_setting
    on owner_setting.owner = plan.owner
  where plan.status in ('approved', 'applying')
    and setting.paused = false
    and coalesce(owner_setting.automation_paused, false) = false
    and not (
      plan.status = 'applying'
      and plan.error_code in ('plan_items_missing', 'plan_hash_mismatch')
    )
  order by coalesce(plan.approved_at, plan.created_at) asc, plan.id asc
  limit 1;
$$;

create or replace function public.next_runnable_mailbox_undo_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select plan.id
  from public.mailbox_action_plans as plan
  join public.mailbox_settings as setting
    on setting.ledger_id = plan.ledger_id
    and setting.owner = plan.owner
  left join public.agent_owner_settings as owner_setting
    on owner_setting.owner = plan.owner
  where plan.undo_status in ('requested', 'running')
    and setting.paused = false
    and coalesce(owner_setting.automation_paused, false) = false
  order by coalesce(plan.undo_requested_at, plan.updated_at) asc, plan.id asc
  limit 1;
$$;

revoke all on function public.claim_mailbox_operation(
  uuid, uuid, uuid, text, integer
) from public, anon, authenticated;
revoke all on function public.release_mailbox_operation(
  uuid, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.enforce_mailbox_action_plan_limits()
  from public, anon, authenticated;
revoke all on function public.next_runnable_mailbox_scan_id()
  from public, anon, authenticated;
revoke all on function public.next_runnable_mailbox_plan_id()
  from public, anon, authenticated;
revoke all on function public.next_runnable_mailbox_undo_id()
  from public, anon, authenticated;

grant execute on function public.claim_mailbox_operation(
  uuid, uuid, uuid, text, integer
) to service_role;
grant execute on function public.release_mailbox_operation(
  uuid, uuid, uuid
) to service_role;
grant execute on function public.next_runnable_mailbox_scan_id()
  to service_role;
grant execute on function public.next_runnable_mailbox_plan_id()
  to service_role;
grant execute on function public.next_runnable_mailbox_undo_id()
  to service_role;

comment on table public.mailbox_settings is
  'Owner-readable, service-managed scan schedule and explicit AI-consent settings for one mailbox ledger entry.';
comment on table public.mailbox_scan_runs is
  'Owner-readable sanitized scan progress and result counts; provider cursors are stored separately.';
comment on table public.mailbox_scan_state is
  'Service-only resumable provider cursor and bounded checkpoint for an active mailbox scan.';
comment on table public.mailbox_message_refs is
  'Service-only provider identifiers, label snapshots, and unsubscribe targets; never message bodies.';
comment on table public.mailbox_findings is
  'Owner-readable bounded message metadata and conservative cleanup classification; no provider ids or URLs.';
comment on table public.mailbox_action_plans is
  'Owner-readable exact approval envelope bound to ordered finding ids, an expiry, and a SHA-256 plan hash.';
comment on table public.mailbox_action_items is
  'Service-only execution and undo manifest binding approved findings to exact provider messages and prior labels.';
comment on table public.mailbox_audit_events is
  'Owner-readable sanitized mailbox operation history with bounded summaries and aggregate counts only.';
comment on table public.mailbox_operation_leases is
  'Service-only bounded per-mailbox leases preventing concurrent scans, actions, disconnects, or erasure.';
comment on column public.mailbox_settings.ai_consent is
  'Explicit consent to send bounded headers, subject, and snippet data to the selected owner-bound AI backend.';
comment on column public.mailbox_action_plans.plan_hash is
  'Lowercase SHA-256 digest of the canonical immutable approval manifest.';
comment on function public.claim_mailbox_operation(
  uuid, uuid, uuid, text, integer
) is
  'Service-only atomic claim or same-holder renewal of a bounded per-mailbox operation lease.';
comment on function public.release_mailbox_operation(
  uuid, uuid, uuid
) is
  'Service-only release of a mailbox operation lease by its unguessable lease id.';
comment on function public.enforce_mailbox_action_plan_limits() is
  'Trigger-only owner lock enforcing active cleanup overlap and queue limits.';
comment on function public.next_runnable_mailbox_scan_id() is
  'Service-only oldest runnable scan after mailbox and owner pause filtering.';
comment on function public.next_runnable_mailbox_plan_id() is
  'Service-only oldest runnable cleanup after pause and recovery filtering.';
comment on function public.next_runnable_mailbox_undo_id() is
  'Service-only oldest runnable Undo after mailbox and owner pause filtering.';
