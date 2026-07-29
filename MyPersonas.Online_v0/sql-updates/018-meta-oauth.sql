-- Meta OAuth foundation for Facebook Pages and Page-linked Instagram
-- professional accounts.
--
-- This migration adds connection and credential infrastructure only. It does
-- not grant publishing authority, request publishing scopes, or add a posting
-- endpoint. Facebook personal profiles and Instagram consumer accounts are not
-- eligible connection targets.

begin;

create extension if not exists supabase_vault with schema vault;

create table if not exists public.meta_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  browser_nonce_hash text not null
    check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  return_origin text not null,
  transaction_state text not null default 'pending',
  processing_started_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.meta_oauth_transactions
  add column if not exists transaction_state text;
alter table public.meta_oauth_transactions
  add column if not exists processing_started_at timestamptz;
update public.meta_oauth_transactions
set transaction_state = 'pending'
where transaction_state is null;
alter table public.meta_oauth_transactions
  alter column transaction_state set default 'pending',
  alter column transaction_state set not null;
alter table public.meta_oauth_transactions
  drop constraint if exists meta_oauth_transactions_state_check;
alter table public.meta_oauth_transactions
  add constraint meta_oauth_transactions_state_check
  check (transaction_state in ('pending', 'processing'));
alter table public.meta_oauth_transactions
  drop constraint if exists meta_oauth_transactions_processing_check;
alter table public.meta_oauth_transactions
  add constraint meta_oauth_transactions_processing_check
  check (
    (transaction_state = 'pending' and processing_started_at is null)
    or
    (transaction_state = 'processing' and processing_started_at is not null)
  );

create unique index if not exists meta_oauth_transactions_owner_idx
  on public.meta_oauth_transactions (owner);
create index if not exists meta_oauth_transactions_expiry_idx
  on public.meta_oauth_transactions (expires_at);

-- Authorization codes are exchanged and provider assets are discovered before
-- the owner selects ledger bindings. The temporary user/Page token bundle is
-- encrypted in Vault and addressed by a one-time, hashed selection token.
create table if not exists public.meta_oauth_candidates (
  selection_hash text primary key check (selection_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  browser_nonce_hash text not null
    check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  meta_user_id text not null check (meta_user_id ~ '^[0-9]{1,64}$'),
  meta_user_name text not null default '',
  granted_scopes text[] not null default '{}',
  token_expires_at timestamptz not null,
  vault_secret_id uuid not null unique,
  revocation_state text not null default 'pending'
    constraint meta_oauth_candidates_revocation_state_check
    check (
      revocation_state in (
        'pending',
        'revoking',
        'provider_revoked',
        'manual_required'
      )
    ),
  revocation_error_code text not null default '',
  revocation_started_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Keep the migration safe if an earlier draft created the candidate table
-- before fail-closed revocation state was added.
alter table public.meta_oauth_candidates
  add column if not exists revocation_state text;
alter table public.meta_oauth_candidates
  add column if not exists revocation_error_code text;
alter table public.meta_oauth_candidates
  add column if not exists revocation_started_at timestamptz;
update public.meta_oauth_candidates
set revocation_state = 'pending'
where revocation_state is null;
update public.meta_oauth_candidates
set revocation_error_code = ''
where revocation_error_code is null;
alter table public.meta_oauth_candidates
  alter column revocation_state set default 'pending',
  alter column revocation_state set not null,
  alter column revocation_error_code set default '',
  alter column revocation_error_code set not null;
alter table public.meta_oauth_candidates
  drop constraint if exists meta_oauth_candidates_revocation_state_check;
alter table public.meta_oauth_candidates
  add constraint meta_oauth_candidates_revocation_state_check
  check (
    revocation_state in (
      'pending',
      'revoking',
      'provider_revoked',
      'manual_required'
    )
  );

create unique index if not exists meta_oauth_candidates_owner_idx
  on public.meta_oauth_candidates (owner);
create unique index if not exists meta_oauth_candidates_meta_user_idx
  on public.meta_oauth_candidates (meta_user_id);
create index if not exists meta_oauth_candidates_expiry_idx
  on public.meta_oauth_candidates (expires_at);

-- A Facebook Login grant belongs to one immutable Meta user identity. Several
-- Facebook Pages may share it, so provider revocation and disconnect operate
-- on the whole grant rather than pretending that a single Page can revoke it.
create table if not exists public.meta_grants (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  meta_user_id text not null unique check (meta_user_id ~ '^[0-9]{1,64}$'),
  meta_user_name text not null default '',
  granted_scopes text[] not null default '{}',
  expires_at timestamptz not null,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One immutable reservation serializes a Meta user identity across both the
-- short-lived candidate and durable grant lifecycles. This prevents two
-- MyPersonas owners from independently storing or revoking the same provider
-- integration during a finalization race.
create table if not exists public.meta_identity_reservations (
  meta_user_id text primary key check (meta_user_id ~ '^[0-9]{1,64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  candidate_selection_hash text unique,
  grant_id uuid unique references public.meta_grants(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    candidate_selection_hash is not null
    or grant_id is not null
  )
);

alter table public.meta_identity_reservations
  drop constraint if exists meta_identity_reservations_grant_id_fkey;
alter table public.meta_identity_reservations
  add constraint meta_identity_reservations_grant_id_fkey
  foreign key (grant_id) references public.meta_grants(id) on delete restrict;

-- If the provider consumes an authorization code but no trustworthy identity
-- or token is returned, there is nothing safe to revoke automatically. Retain
-- a service-only owner hold until manual provider revocation is acknowledged.
create table if not exists public.meta_oauth_cleanup_holds (
  owner uuid primary key references public.profiles(id) on delete cascade,
  meta_user_id text check (
    meta_user_id is null or meta_user_id ~ '^[0-9]{1,64}$'
  ),
  cleanup_kind text not null default 'ownership_investigation'
    check (
      cleanup_kind in ('manual_revoke', 'ownership_investigation')
    ),
  error_code text not null check (
    trim(error_code) <> '' and char_length(error_code) <= 128
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.meta_oauth_cleanup_holds
  add column if not exists meta_user_id text;
alter table public.meta_oauth_cleanup_holds
  add column if not exists cleanup_kind text;
update public.meta_oauth_cleanup_holds
set cleanup_kind = 'ownership_investigation'
where cleanup_kind is null;
alter table public.meta_oauth_cleanup_holds
  alter column cleanup_kind set default 'ownership_investigation',
  alter column cleanup_kind set not null;
alter table public.meta_oauth_cleanup_holds
  drop constraint if exists meta_oauth_cleanup_holds_cleanup_kind_check;
alter table public.meta_oauth_cleanup_holds
  add constraint meta_oauth_cleanup_holds_cleanup_kind_check
  check (cleanup_kind in ('manual_revoke', 'ownership_investigation'));
alter table public.meta_oauth_cleanup_holds
  drop constraint if exists meta_oauth_cleanup_holds_meta_user_id_check;
alter table public.meta_oauth_cleanup_holds
  add constraint meta_oauth_cleanup_holds_meta_user_id_check
  check (meta_user_id is null or meta_user_id ~ '^[0-9]{1,64}$');
create unique index if not exists meta_oauth_cleanup_holds_meta_user_idx
  on public.meta_oauth_cleanup_holds (meta_user_id)
  where meta_user_id is not null;

insert into public.meta_identity_reservations (
  meta_user_id,
  owner,
  grant_id,
  created_at,
  updated_at
)
select
  grant_row.meta_user_id,
  grant_row.owner,
  grant_row.id,
  grant_row.created_at,
  grant_row.updated_at
from public.meta_grants as grant_row
on conflict (meta_user_id) do update set
  owner = excluded.owner,
  grant_id = excluded.grant_id,
  updated_at = now()
where public.meta_identity_reservations.owner = excluded.owner;

insert into public.meta_identity_reservations as reservation (
  meta_user_id,
  owner,
  candidate_selection_hash,
  created_at,
  updated_at
)
select
  candidate.meta_user_id,
  candidate.owner,
  candidate.selection_hash,
  candidate.created_at,
  candidate.created_at
from public.meta_oauth_candidates as candidate
on conflict (meta_user_id) do update set
  candidate_selection_hash = excluded.candidate_selection_hash,
  updated_at = now()
where reservation.owner = excluded.owner;

do $$
begin
  if exists (
    select 1
    from public.meta_grants as grant_row
    left join public.meta_identity_reservations as reservation
      on reservation.meta_user_id = grant_row.meta_user_id
    where reservation.meta_user_id is null
      or reservation.owner <> grant_row.owner
      or reservation.grant_id is distinct from grant_row.id
  ) then
    raise exception 'Existing Meta grants could not be reserved safely';
  end if;
  if exists (
    select 1
    from public.meta_oauth_candidates as candidate
    left join public.meta_identity_reservations as reservation
      on reservation.meta_user_id = candidate.meta_user_id
    where reservation.meta_user_id is null
      or reservation.owner <> candidate.owner
      or reservation.candidate_selection_hash is distinct from
        candidate.selection_hash
  ) then
    raise exception 'Existing Meta candidates could not be reserved safely';
  end if;
end;
$$;

-- Every row represents one Facebook Page selected from /me/accounts. An
-- optional Instagram ledger is attached only when that exact Page reports a
-- linked Instagram professional-account id.
create table if not exists public.meta_page_connections (
  facebook_ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  grant_id uuid not null references public.meta_grants(id) on delete cascade,
  facebook_page_id text not null unique
    check (facebook_page_id ~ '^[0-9]{1,64}$'),
  facebook_page_name text not null default '',
  page_tasks text[] not null default '{}',
  instagram_ledger_id uuid unique,
  instagram_business_id text unique,
  instagram_username text not null default '',
  page_vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (facebook_ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  foreign key (instagram_ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  check (
    (instagram_ledger_id is null and instagram_business_id is null)
    or
    (
      instagram_ledger_id is not null
      and instagram_business_id is not null
      and instagram_business_id ~ '^[0-9]{1,64}$'
    )
  )
);

create index if not exists meta_page_connections_owner_idx
  on public.meta_page_connections (owner, created_at);
create index if not exists meta_page_connections_grant_idx
  on public.meta_page_connections (grant_id);

-- Provider revocation is shared by every Page under a Meta user grant.
-- Serialize finalization, disconnect, and manual-reset operations so two tabs
-- cannot overwrite or delete the same credential set concurrently.
create table if not exists public.meta_token_operation_leases (
  grant_id uuid primary key references public.meta_grants(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  operation_kind text not null
    check (operation_kind in ('connect', 'disconnect', 'reset')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists meta_token_operation_leases_expiry_idx
  on public.meta_token_operation_leases (expires_at);

-- Account/content erasure must be mutually exclusive with every Meta OAuth
-- transition. The lease survives for the complete erasure request, blocks new
-- authorization, and cascades only after a full profile deletion succeeds.
create table if not exists public.meta_owner_erasure_leases (
  owner uuid primary key references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meta_owner_erasure_leases_expiry_idx
  on public.meta_owner_erasure_leases (expires_at);

alter table public.meta_oauth_transactions enable row level security;
alter table public.meta_oauth_candidates enable row level security;
alter table public.meta_grants enable row level security;
alter table public.meta_identity_reservations enable row level security;
alter table public.meta_oauth_cleanup_holds enable row level security;
alter table public.meta_page_connections enable row level security;
alter table public.meta_token_operation_leases enable row level security;
alter table public.meta_owner_erasure_leases enable row level security;

-- Deliberately no browser policies exist. The Edge connector exposes only
-- sanitized capabilities and discovered asset metadata.
revoke all on public.meta_oauth_transactions
  from public, anon, authenticated;
revoke all on public.meta_oauth_candidates
  from public, anon, authenticated;
revoke all on public.meta_grants from public, anon, authenticated;
revoke all on public.meta_identity_reservations
  from public, anon, authenticated;
revoke all on public.meta_oauth_cleanup_holds
  from public, anon, authenticated;
revoke all on public.meta_page_connections
  from public, anon, authenticated;
revoke all on public.meta_token_operation_leases
  from public, anon, authenticated;
revoke all on public.meta_owner_erasure_leases
  from public, anon, authenticated;
grant all on public.meta_oauth_transactions to service_role;
grant all on public.meta_oauth_candidates to service_role;
grant all on public.meta_grants to service_role;
grant all on public.meta_identity_reservations to service_role;
grant all on public.meta_oauth_cleanup_holds to service_role;
grant all on public.meta_page_connections to service_role;
grant all on public.meta_token_operation_leases to service_role;
grant all on public.meta_owner_erasure_leases to service_role;

comment on table public.meta_oauth_transactions is
  'Service-only, single-use Meta OAuth state bound to an owner and initiating browser tab.';
comment on table public.meta_oauth_candidates is
  'Service-only, short-lived Meta Page-selection state whose provider token bundle is encrypted in Vault.';
comment on table public.meta_grants is
  'Service-only Meta user grant metadata; the user access token is encrypted in Vault.';
comment on table public.meta_identity_reservations is
  'Service-only cross-lifecycle ownership reservation for one immutable Meta user identity.';
comment on table public.meta_oauth_cleanup_holds is
  'Service-only fail-closed owner marker for ambiguous Meta code exchanges that cannot be safely revoked automatically.';
comment on table public.meta_page_connections is
  'Service-only immutable Facebook Page and optional linked Instagram professional-account bindings; Page tokens are encrypted in Vault.';
comment on table public.meta_token_operation_leases is
  'Service-only bounded leases serializing operations on a shared Meta user grant.';
comment on table public.meta_owner_erasure_leases is
  'Service-only owner lease that blocks Meta OAuth while account or content erasure is running.';

drop function if exists public.consume_meta_oauth_state(text, uuid, text);

create or replace function public.meta_create_oauth_transaction(
  p_state_hash text,
  p_owner uuid,
  p_browser_nonce_hash text,
  p_return_origin text,
  p_expires_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.meta_oauth_transactions%rowtype;
begin
  if p_state_hash !~ '^[0-9a-f]{64}$'
    or p_browser_nonce_hash !~ '^[0-9a-f]{64}$'
    or trim(coalesce(p_return_origin, '')) = ''
    or char_length(p_return_origin) > 2048
    or p_expires_at <= now()
    or p_expires_at > now() + interval '10 minutes' then
    raise exception 'Invalid Meta OAuth transaction';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  delete from public.meta_owner_erasure_leases
  where owner = p_owner
    and expires_at <= now();
  if exists (
    select 1
    from public.meta_owner_erasure_leases
    where owner = p_owner
      and expires_at > now()
  ) then
    return 'erasing';
  end if;
  if exists (
    select 1 from public.meta_oauth_candidates where owner = p_owner
  ) or exists (
    select 1 from public.meta_oauth_cleanup_holds where owner = p_owner
  ) then
    return 'protected_cleanup';
  end if;

  select * into v_existing
  from public.meta_oauth_transactions
  where owner = p_owner
  for update;
  if found then
    if v_existing.transaction_state = 'processing' then
      return 'processing';
    end if;
    if v_existing.expires_at > now() then
      return 'pending';
    end if;
    delete from public.meta_oauth_transactions
    where state_hash = v_existing.state_hash
      and owner = p_owner
      and transaction_state = 'pending';
  end if;

  insert into public.meta_oauth_transactions (
    state_hash,
    owner,
    browser_nonce_hash,
    return_origin,
    transaction_state,
    processing_started_at,
    expires_at,
    created_at
  ) values (
    p_state_hash,
    p_owner,
    p_browser_nonce_hash,
    p_return_origin,
    'pending',
    null,
    p_expires_at,
    now()
  );
  return 'created';
end;
$$;

create or replace function public.meta_claim_oauth_transaction(
  p_state_hash text,
  p_owner uuid,
  p_browser_nonce_hash text
)
returns table(return_origin text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  if exists (
    select 1
    from public.meta_owner_erasure_leases
    where owner = p_owner
      and expires_at > now()
  ) then
    return;
  end if;
  return query
  update public.meta_oauth_transactions as tx
  set
    transaction_state = 'processing',
    processing_started_at = now()
  where tx.state_hash = p_state_hash
    and tx.owner = p_owner
    and tx.browser_nonce_hash = p_browser_nonce_hash
    and tx.transaction_state = 'pending'
    and tx.expires_at > now()
  returning tx.return_origin;
end;
$$;

create or replace function public.claim_meta_owner_erasure(
  p_owner uuid,
  p_lease_id uuid,
  p_ttl_seconds integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.meta_owner_erasure_leases%rowtype;
  v_transaction_state text;
begin
  if p_ttl_seconds < 300 or p_ttl_seconds > 3600 then
    raise exception 'Meta owner-erasure lease must be between 300 and 3600 seconds';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );

  delete from public.meta_owner_erasure_leases
  where owner = p_owner
    and expires_at <= now();
  select * into v_existing
  from public.meta_owner_erasure_leases
  where owner = p_owner
  for update;
  if found then
    if v_existing.lease_id = p_lease_id then
      update public.meta_owner_erasure_leases
      set
        expires_at = now() + make_interval(secs => p_ttl_seconds),
        updated_at = now()
      where owner = p_owner
        and lease_id = p_lease_id;
      return 'claimed';
    end if;
    return 'busy';
  end if;

  select transaction_state into v_transaction_state
  from public.meta_oauth_transactions
  where owner = p_owner
  for update;
  if found and v_transaction_state = 'processing' then
    return 'processing_oauth';
  end if;
  if found then
    delete from public.meta_oauth_transactions
    where owner = p_owner
      and transaction_state = 'pending';
  end if;

  insert into public.meta_owner_erasure_leases (
    owner,
    lease_id,
    expires_at,
    created_at,
    updated_at
  ) values (
    p_owner,
    p_lease_id,
    now() + make_interval(secs => p_ttl_seconds),
    now(),
    now()
  );
  return 'claimed';
end;
$$;

create or replace function public.renew_meta_owner_erasure(
  p_owner uuid,
  p_lease_id uuid,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
begin
  if p_ttl_seconds < 300 or p_ttl_seconds > 3600 then
    raise exception 'Meta owner-erasure lease must be between 300 and 3600 seconds';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  update public.meta_owner_erasure_leases
  set
    expires_at = now() + make_interval(secs => p_ttl_seconds),
    updated_at = now()
  where owner = p_owner
    and lease_id = p_lease_id
    and expires_at > now();
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.release_meta_owner_erasure(
  p_owner uuid,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  delete from public.meta_owner_erasure_leases
  where owner = p_owner
    and lease_id = p_lease_id;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

create or replace function public.meta_finish_oauth_transaction(
  p_state_hash text,
  p_owner uuid,
  p_browser_nonce_hash text,
  p_resolution text,
  p_selection_hash text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  if p_resolution not in (
    'no_exchange',
    'provider_cancelled',
    'identity_protected',
    'candidate_recorded',
    'cleanup_hold_recorded'
  ) then
    raise exception 'Invalid Meta OAuth transaction resolution';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  if exists (
    select 1
    from public.meta_owner_erasure_leases
    where owner = p_owner
      and expires_at > now()
  ) then
    raise exception 'Meta authorization is blocked while owner erasure is running';
  end if;
  perform 1
  from public.meta_oauth_transactions
  where state_hash = p_state_hash
    and owner = p_owner
    and browser_nonce_hash = p_browser_nonce_hash
    and transaction_state = 'processing'
  for update;
  if not found then return false; end if;

  if p_resolution = 'candidate_recorded' and (
    p_selection_hash is null
    or p_selection_hash !~ '^[0-9a-f]{64}$'
    or not exists (
      select 1
      from public.meta_oauth_candidates
      where selection_hash = p_selection_hash
        and owner = p_owner
        and browser_nonce_hash = p_browser_nonce_hash
    )
  ) then
    raise exception 'The Meta OAuth candidate resolution is not durable';
  end if;
  if p_resolution = 'cleanup_hold_recorded' and not exists (
    select 1
    from public.meta_oauth_cleanup_holds
    where owner = p_owner
  ) then
    raise exception 'The Meta OAuth cleanup-hold resolution is not durable';
  end if;
  if p_resolution in ('no_exchange', 'provider_cancelled')
    and p_selection_hash is not null then
    raise exception 'Invalid Meta OAuth no-grant resolution';
  end if;

  delete from public.meta_oauth_transactions
  where state_hash = p_state_hash
    and owner = p_owner
    and browser_nonce_hash = p_browser_nonce_hash
    and transaction_state = 'processing';
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

create or replace function public.delete_meta_candidate_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

drop trigger if exists meta_candidates_delete_vault_secret
  on public.meta_oauth_candidates;
create trigger meta_candidates_delete_vault_secret
  after delete on public.meta_oauth_candidates
  for each row execute function public.delete_meta_candidate_vault_secret();

create or replace function public.release_meta_candidate_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.meta_identity_reservations
  where meta_user_id = old.meta_user_id
    and owner = old.owner
    and candidate_selection_hash = old.selection_hash
    and grant_id is null;
  update public.meta_identity_reservations
  set
    candidate_selection_hash = null,
    updated_at = now()
  where meta_user_id = old.meta_user_id
    and owner = old.owner
    and candidate_selection_hash = old.selection_hash
    and grant_id is not null;
  return old;
end;
$$;

drop trigger if exists meta_candidates_release_identity_reservation
  on public.meta_oauth_candidates;
create trigger meta_candidates_release_identity_reservation
  after delete on public.meta_oauth_candidates
  for each row execute function public.release_meta_candidate_reservation();

create or replace function public.delete_meta_grant_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

drop trigger if exists meta_grants_delete_vault_secret on public.meta_grants;
create trigger meta_grants_delete_vault_secret
  after delete on public.meta_grants
  for each row execute function public.delete_meta_grant_vault_secret();

create or replace function public.delete_meta_page_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.page_vault_secret_id;
  return old;
end;
$$;

drop trigger if exists meta_pages_delete_vault_secret
  on public.meta_page_connections;
create trigger meta_pages_delete_vault_secret
  after delete on public.meta_page_connections
  for each row execute function public.delete_meta_page_vault_secret();

create or replace function public.meta_create_oauth_candidate(
  p_selection_hash text,
  p_transaction_state_hash text,
  p_owner uuid,
  p_browser_nonce_hash text,
  p_meta_user_id text,
  p_meta_user_name text,
  p_granted_scopes text[],
  p_token_expires_at timestamptz,
  p_token_bundle text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_reservation public.meta_identity_reservations%rowtype;
  v_reserved integer := 0;
  v_transaction_deleted integer := 0;
  v_secret_name text :=
    'meta_candidate_' || substring(p_selection_hash from 1 for 32);
begin
  if p_selection_hash !~ '^[0-9a-f]{64}$'
    or p_transaction_state_hash !~ '^[0-9a-f]{64}$'
    or p_browser_nonce_hash !~ '^[0-9a-f]{64}$'
    or trim(coalesce(p_meta_user_id, '')) !~ '^[0-9]{1,64}$' then
    raise exception 'Invalid Meta OAuth candidate identity';
  end if;
  if p_token_expires_at is null or p_token_expires_at <= now() then
    raise exception 'Meta user token expiry must be in the future';
  end if;
  if p_expires_at is null
    or p_expires_at <= now()
    or p_expires_at > now() + interval '15 minutes' then
    raise exception 'Meta OAuth candidate expiry is invalid';
  end if;
  if octet_length(coalesce(p_token_bundle, '')) < 32
    or octet_length(p_token_bundle) > 524288 then
    raise exception 'Meta OAuth candidate token bundle is invalid';
  end if;
  if jsonb_typeof(p_token_bundle::jsonb) <> 'object' then
    raise exception 'Meta OAuth candidate token bundle must be an object';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  if exists (
    select 1
    from public.meta_owner_erasure_leases
    where owner = p_owner
      and expires_at > now()
  ) then
    raise exception 'Meta authorization is blocked while owner erasure is running';
  end if;
  perform 1
  from public.meta_oauth_transactions
  where state_hash = p_transaction_state_hash
    and owner = p_owner
    and browser_nonce_hash = p_browser_nonce_hash
    and transaction_state = 'processing'
  for update;
  if not found then
    raise exception 'The Meta OAuth processing transaction is unavailable';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'meta-identity:' || trim(p_meta_user_id),
      0
    )
  );
  if exists (
    select 1
    from public.meta_oauth_cleanup_holds
    where owner = p_owner
  ) then
    raise exception 'Resolve the previous ambiguous Meta authorization before starting another';
  end if;
  if exists (
    select 1
    from public.meta_oauth_cleanup_holds
    where meta_user_id = trim(p_meta_user_id)
      and owner <> p_owner
  ) then
    raise exception 'META_IDENTITY_RESERVED_BY_ANOTHER_OWNER';
  end if;
  if exists (
    select 1
    from public.meta_oauth_candidates
    where owner = p_owner
  ) then
    raise exception 'Resolve the previous Meta authorization before starting another';
  end if;

  select * into v_reservation
  from public.meta_identity_reservations
  where meta_user_id = trim(p_meta_user_id)
  for update;
  if found and v_reservation.owner <> p_owner then
    raise exception 'META_IDENTITY_RESERVED_BY_ANOTHER_OWNER';
  end if;
  if found
    and v_reservation.candidate_selection_hash is not null
    and v_reservation.candidate_selection_hash <> p_selection_hash then
    raise exception 'Resolve the previous Meta authorization before starting another';
  end if;

  select vault.create_secret(
    p_token_bundle,
    v_secret_name,
    'Temporary Meta OAuth Page-selection bundle'
  ) into v_secret_id;

  insert into public.meta_oauth_candidates (
    selection_hash,
    owner,
    browser_nonce_hash,
    meta_user_id,
    meta_user_name,
    granted_scopes,
    token_expires_at,
    vault_secret_id,
    expires_at
  ) values (
    p_selection_hash,
    p_owner,
    p_browser_nonce_hash,
    trim(p_meta_user_id),
    left(trim(coalesce(p_meta_user_name, '')), 255),
    coalesce(p_granted_scopes, '{}'),
    p_token_expires_at,
    v_secret_id,
    p_expires_at
  );

  insert into public.meta_identity_reservations as reservation (
    meta_user_id,
    owner,
    candidate_selection_hash,
    grant_id,
    updated_at
  ) values (
    trim(p_meta_user_id),
    p_owner,
    p_selection_hash,
    v_reservation.grant_id,
    now()
  )
  on conflict (meta_user_id) do update set
    candidate_selection_hash = excluded.candidate_selection_hash,
    updated_at = excluded.updated_at
  where reservation.owner = excluded.owner;
  get diagnostics v_reserved = row_count;
  if v_reserved <> 1 then
    raise exception 'META_IDENTITY_RESERVED_BY_ANOTHER_OWNER';
  end if;

  delete from public.meta_oauth_transactions
  where state_hash = p_transaction_state_hash
    and owner = p_owner
    and browser_nonce_hash = p_browser_nonce_hash
    and transaction_state = 'processing';
  get diagnostics v_transaction_deleted = row_count;
  if v_transaction_deleted <> 1 then
    raise exception 'The Meta OAuth processing transaction could not be resolved';
  end if;

  return v_secret_id;
end;
$$;

drop function if exists public.meta_update_oauth_candidate_bundle(
  text, uuid, text, text
);
create or replace function public.meta_update_oauth_candidate_bundle(
  p_selection_hash text,
  p_owner uuid,
  p_browser_nonce_hash text,
  p_granted_scopes text[],
  p_token_expires_at timestamptz,
  p_token_bundle text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.meta_oauth_candidates%rowtype;
begin
  if p_selection_hash !~ '^[0-9a-f]{64}$'
    or p_browser_nonce_hash !~ '^[0-9a-f]{64}$'
    or octet_length(coalesce(p_token_bundle, '')) < 32
    or octet_length(p_token_bundle) > 524288
    or jsonb_typeof(p_token_bundle::jsonb) <> 'object'
    or p_token_expires_at is null
    or p_token_expires_at <= now() then
    raise exception 'Invalid Meta candidate update';
  end if;

  select * into v_candidate
  from public.meta_oauth_candidates
  where selection_hash = p_selection_hash
    and owner = p_owner
    and browser_nonce_hash = p_browser_nonce_hash
    and revocation_state = 'pending'
    and expires_at > now()
  for update;
  if not found then return false; end if;

  perform vault.update_secret(
    v_candidate.vault_secret_id,
    p_token_bundle,
    'meta_candidate_' || substring(p_selection_hash from 1 for 32),
    'Temporary Meta OAuth Page-selection bundle'
  );
  update public.meta_oauth_candidates
  set
    granted_scopes = coalesce(p_granted_scopes, '{}'),
    token_expires_at = p_token_expires_at
  where selection_hash = p_selection_hash
    and owner = p_owner;
  return true;
end;
$$;

drop function if exists public.meta_create_cleanup_hold(uuid, text);
drop function if exists public.meta_create_cleanup_hold(uuid, text, text);
drop function if exists public.meta_create_cleanup_hold(uuid, text, text, text);
create or replace function public.meta_create_cleanup_hold(
  p_owner uuid,
  p_error_code text,
  p_meta_user_id text,
  p_cleanup_kind text,
  p_transaction_state_hash text default null,
  p_browser_nonce_hash text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_hold public.meta_oauth_cleanup_holds%rowtype;
  v_transaction_deleted integer := 0;
begin
  if trim(coalesce(p_error_code, '')) = ''
    or char_length(p_error_code) > 128
    or (
      p_meta_user_id is not null
      and trim(p_meta_user_id) !~ '^[0-9]{1,64}$'
    )
    or p_cleanup_kind not in (
      'manual_revoke',
      'ownership_investigation'
    )
    or (
      p_cleanup_kind = 'manual_revoke'
      and p_meta_user_id is null
    )
    or (
      p_meta_user_id is null
      and p_cleanup_kind <> 'ownership_investigation'
    )
    or (
      (p_transaction_state_hash is null) <>
        (p_browser_nonce_hash is null)
    )
    or (
      p_transaction_state_hash is not null
      and p_transaction_state_hash !~ '^[0-9a-f]{64}$'
    )
    or (
      p_browser_nonce_hash is not null
      and p_browser_nonce_hash !~ '^[0-9a-f]{64}$'
    ) then
    raise exception 'Invalid Meta cleanup hold';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  select * into v_existing_hold
  from public.meta_oauth_cleanup_holds
  where owner = p_owner
  for update;
  if found then
    if v_existing_hold.meta_user_id is not distinct from
        nullif(trim(coalesce(p_meta_user_id, '')), '')
      and v_existing_hold.cleanup_kind = p_cleanup_kind
      and v_existing_hold.error_code = p_error_code then
      if p_transaction_state_hash is not null then
        delete from public.meta_oauth_transactions
        where state_hash = p_transaction_state_hash
          and owner = p_owner
          and browser_nonce_hash = p_browser_nonce_hash
          and transaction_state = 'processing';
        get diagnostics v_transaction_deleted = row_count;
        if v_transaction_deleted <> 1 then
          raise exception 'The Meta OAuth processing transaction could not be resolved';
        end if;
      end if;
      return 'held_existing';
    end if;
    return 'protected_existing_hold';
  end if;
  if p_transaction_state_hash is not null then
    perform 1
    from public.meta_oauth_transactions
    where state_hash = p_transaction_state_hash
      and owner = p_owner
      and browser_nonce_hash = p_browser_nonce_hash
      and transaction_state = 'processing'
    for update;
    if not found then
      raise exception 'The Meta OAuth processing transaction is unavailable';
    end if;
  end if;
  if p_meta_user_id is not null then
    p_meta_user_id := trim(p_meta_user_id);
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'meta-identity:' || p_meta_user_id,
        0
      )
    );
    if exists (
      select 1
      from public.meta_identity_reservations
      where meta_user_id = p_meta_user_id
        and owner <> p_owner
    ) or exists (
      select 1
      from public.meta_oauth_cleanup_holds
      where meta_user_id = p_meta_user_id
        and owner <> p_owner
    ) then
      return 'reserved_other_owner';
    end if;
    if exists (
      select 1
      from public.meta_identity_reservations
      where meta_user_id = p_meta_user_id
        and owner = p_owner
    ) then
      return 'protected_same_owner';
    end if;
  end if;
  insert into public.meta_oauth_cleanup_holds (
    owner,
    meta_user_id,
    cleanup_kind,
    error_code,
    updated_at
  ) values (
    p_owner,
    p_meta_user_id,
    p_cleanup_kind,
    p_error_code,
    now()
  );
  if p_transaction_state_hash is not null then
    delete from public.meta_oauth_transactions
    where state_hash = p_transaction_state_hash
      and owner = p_owner
      and browser_nonce_hash = p_browser_nonce_hash
      and transaction_state = 'processing';
    get diagnostics v_transaction_deleted = row_count;
    if v_transaction_deleted <> 1 then
      raise exception 'The Meta OAuth processing transaction could not be resolved';
    end if;
  end if;
  return 'held';
end;
$$;

drop function if exists public.meta_delete_cleanup_hold(uuid);
create or replace function public.meta_delete_cleanup_hold(
  p_owner uuid,
  p_cleanup_kind text,
  p_meta_user_id text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_meta_user_id text;
  v_cleanup_kind text;
  v_error_code text;
begin
  if p_cleanup_kind <> 'manual_revoke'
    or trim(coalesce(p_error_code, '')) = ''
    or char_length(p_error_code) > 128
    or trim(coalesce(p_meta_user_id, '')) !~ '^[0-9]{1,64}$' then
    raise exception 'Invalid Meta cleanup-hold deletion';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  select meta_user_id, cleanup_kind, error_code
  into v_meta_user_id, v_cleanup_kind, v_error_code
  from public.meta_oauth_cleanup_holds
  where owner = p_owner
    and cleanup_kind = p_cleanup_kind
    and meta_user_id = trim(p_meta_user_id)
    and error_code = p_error_code
  for update;
  if not found then return false; end if;
  if v_meta_user_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'meta-identity:' || v_meta_user_id,
        0
      )
    );
  end if;
  delete from public.meta_oauth_cleanup_holds
  where owner = p_owner
    and meta_user_id = trim(p_meta_user_id)
    and cleanup_kind = p_cleanup_kind
    and error_code = p_error_code
    and meta_user_id is not distinct from v_meta_user_id
    and cleanup_kind = v_cleanup_kind
    and error_code = v_error_code;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

create or replace function public.meta_get_oauth_candidate(
  p_selection_hash text,
  p_owner uuid,
  p_browser_nonce_hash text
)
returns table(
  meta_user_id text,
  meta_user_name text,
  granted_scopes text[],
  token_expires_at timestamptz,
  token_bundle jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    candidate.meta_user_id,
    candidate.meta_user_name,
    candidate.granted_scopes,
    candidate.token_expires_at,
    secret.decrypted_secret::jsonb
  from public.meta_oauth_candidates as candidate
  join vault.decrypted_secrets as secret
    on secret.id = candidate.vault_secret_id
  where candidate.selection_hash = p_selection_hash
    and candidate.owner = p_owner
    and candidate.browser_nonce_hash = p_browser_nonce_hash
    and candidate.revocation_state = 'pending'
    and candidate.expires_at > now();
$$;

-- Revocation cleanup deliberately ignores the UI-selection expiry. Expiry
-- prevents asset finalization; it must never silently discard the sole token
-- that can revoke an already-granted provider integration.
create or replace function public.meta_get_oauth_candidate_for_revocation(
  p_selection_hash text,
  p_owner uuid,
  p_browser_nonce_hash text default null
)
returns table(
  selection_hash text,
  meta_user_id text,
  revocation_state text,
  revocation_error_code text,
  revocation_started_at timestamptz,
  token_bundle jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    candidate.selection_hash,
    candidate.meta_user_id,
    candidate.revocation_state,
    candidate.revocation_error_code,
    candidate.revocation_started_at,
    secret.decrypted_secret::jsonb
  from public.meta_oauth_candidates as candidate
  join vault.decrypted_secrets as secret
    on secret.id = candidate.vault_secret_id
  where candidate.selection_hash = p_selection_hash
    and candidate.owner = p_owner
    and (
      p_browser_nonce_hash is null
      or candidate.browser_nonce_hash = p_browser_nonce_hash
    );
$$;

-- Atomically take an active or expired candidate out of the finalization path
-- before its provider token is used for revocation. This serializes cancel
-- against finalize: only one path can move or consume the encrypted bundle.
create or replace function public.meta_claim_oauth_candidate_for_revocation(
  p_selection_hash text,
  p_owner uuid,
  p_browser_nonce_hash text default null,
  p_allow_manual_required boolean default false
)
returns table(
  selection_hash text,
  meta_user_id text,
  previous_revocation_state text,
  token_bundle jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.meta_oauth_candidates%rowtype;
  v_token_bundle jsonb;
begin
  if p_selection_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Meta candidate selection';
  end if;
  if p_browser_nonce_hash is not null
    and p_browser_nonce_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Meta candidate browser binding';
  end if;

  select * into v_candidate
  from public.meta_oauth_candidates as candidate
  where candidate.selection_hash = p_selection_hash
    and candidate.owner = p_owner
    and (
      p_browser_nonce_hash is null
      or candidate.browser_nonce_hash = p_browser_nonce_hash
    )
    and (
      candidate.revocation_state in ('pending', 'provider_revoked')
      or (
        candidate.revocation_state = 'revoking'
        and (
          candidate.revocation_started_at is null
          or candidate.revocation_started_at < now() - interval '3 minutes'
        )
      )
      or (
        p_allow_manual_required
        and candidate.revocation_state = 'manual_required'
      )
    )
  for update;
  if not found then return; end if;

  select secret.decrypted_secret::jsonb into v_token_bundle
  from vault.decrypted_secrets as secret
  where secret.id = v_candidate.vault_secret_id;
  if v_token_bundle is null then
    raise exception 'The encrypted Meta candidate token is unavailable';
  end if;
  if not exists (
    select 1
    from public.meta_identity_reservations
    where meta_user_id = v_candidate.meta_user_id
      and owner = p_owner
      and candidate_selection_hash = v_candidate.selection_hash
  ) then
    raise exception 'The Meta identity reservation is unavailable';
  end if;

  update public.meta_oauth_candidates
  set
    revocation_state = 'revoking',
    revocation_error_code = '',
    revocation_started_at = now()
  where selection_hash = v_candidate.selection_hash
    and owner = p_owner;

  return query select
    v_candidate.selection_hash,
    v_candidate.meta_user_id,
    v_candidate.revocation_state,
    v_token_bundle;
end;
$$;

create or replace function public.meta_mark_candidate_provider_revoked(
  p_selection_hash text,
  p_owner uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
begin
  update public.meta_oauth_candidates
  set
    revocation_state = 'provider_revoked',
    revocation_error_code = '',
    revocation_started_at = null
  where selection_hash = p_selection_hash
    and owner = p_owner
    and revocation_state = 'revoking';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.meta_mark_candidate_manual_revoke(
  p_selection_hash text,
  p_owner uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
begin
  if trim(coalesce(p_error_code, '')) = ''
    or char_length(p_error_code) > 128 then
    raise exception 'Invalid Meta candidate revocation error';
  end if;
  update public.meta_oauth_candidates
  set
    revocation_state = 'manual_required',
    revocation_error_code = p_error_code,
    revocation_started_at = null
  where selection_hash = p_selection_hash
    and owner = p_owner;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.meta_delete_oauth_candidate(
  p_selection_hash text,
  p_owner uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_meta_user_id text;
begin
  select meta_user_id into v_meta_user_id
  from public.meta_oauth_candidates
  where selection_hash = p_selection_hash
    and owner = p_owner;
  if not found then return false; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-identity:' || v_meta_user_id, 0)
  );
  delete from public.meta_oauth_candidates
  where selection_hash = p_selection_hash
    and owner = p_owner;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then return false; end if;

  delete from public.meta_identity_reservations
  where meta_user_id = v_meta_user_id
    and owner = p_owner
    and candidate_selection_hash = p_selection_hash
    and grant_id is null;
  update public.meta_identity_reservations
  set
    candidate_selection_hash = null,
    updated_at = now()
  where meta_user_id = v_meta_user_id
    and owner = p_owner
    and candidate_selection_hash = p_selection_hash
    and grant_id is not null;
  return v_deleted = 1;
end;
$$;

create or replace function public.claim_meta_token_operation(
  p_grant_id uuid,
  p_owner uuid,
  p_lease_id uuid,
  p_operation_kind text,
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
  if p_operation_kind not in ('connect', 'disconnect', 'reset') then
    raise exception 'Invalid Meta token operation';
  end if;
  if p_ttl_seconds < 15 or p_ttl_seconds > 180 then
    raise exception 'Meta token-operation lease must be between 15 and 180 seconds';
  end if;
  if not exists (
    select 1
    from public.meta_grants
    where id = p_grant_id and owner = p_owner
  ) then
    raise exception 'Owned Meta grant not found';
  end if;

  insert into public.meta_token_operation_leases as lease (
    grant_id,
    owner,
    lease_id,
    operation_kind,
    expires_at,
    created_at
  ) values (
    p_grant_id,
    p_owner,
    p_lease_id,
    p_operation_kind,
    now() + make_interval(secs => p_ttl_seconds),
    now()
  )
  on conflict (grant_id) do update set
    owner = excluded.owner,
    lease_id = excluded.lease_id,
    operation_kind = excluded.operation_kind,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at
  where lease.expires_at <= now()
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

create or replace function public.release_meta_token_operation(
  p_grant_id uuid,
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
  delete from public.meta_token_operation_leases
  where grant_id = p_grant_id
    and owner = p_owner
    and lease_id = p_lease_id;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

-- Atomically consume a trusted provider-discovery candidate and bind the
-- selected immutable Page/Instagram ids to owner ledger rows. Every existing
-- Page under a reauthorized grant must be included, preventing a partial token
-- replacement from stranding an older connected asset.
drop function if exists public.meta_finalize_assets(text, uuid, text, jsonb);
create or replace function public.meta_finalize_assets(
  p_selection_hash text,
  p_owner uuid,
  p_browser_nonce_hash text,
  p_bindings jsonb,
  p_lease_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.meta_oauth_candidates%rowtype;
  v_reservation public.meta_identity_reservations%rowtype;
  v_existing_grant public.meta_grants%rowtype;
  v_existing_page public.meta_page_connections%rowtype;
  v_bundle jsonb;
  v_binding jsonb;
  v_page jsonb;
  v_instagram jsonb;
  v_grant_id uuid;
  v_grant_secret_id uuid;
  v_page_secret_id uuid;
  v_facebook_ledger_id uuid;
  v_instagram_ledger_id uuid;
  v_page_id text;
  v_page_name text;
  v_page_token text;
  v_instagram_id text;
  v_instagram_username text;
  v_provider text;
  v_prior_provider text;
  v_prior_subject text;
  v_tasks text[];
  v_user_access_token text;
  v_count integer;
  v_meta_user_id text;
  v_result_assets jsonb := '[]'::jsonb;
begin
  if p_selection_hash !~ '^[0-9a-f]{64}$'
    or p_browser_nonce_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Meta Page-selection state';
  end if;
  if jsonb_typeof(p_bindings) <> 'array'
    or jsonb_array_length(p_bindings) < 1
    or jsonb_array_length(p_bindings) > 50 then
    raise exception 'Select between 1 and 50 Facebook Pages';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_bindings) as item(value)
    where jsonb_typeof(item.value) <> 'object'
  ) then
    raise exception 'Invalid Meta Page binding';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_bindings) as item(value)
    group by item.value ->> 'pageId'
    having count(*) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(p_bindings) as item(value)
    group by item.value ->> 'facebookLedgerId'
    having count(*) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(p_bindings) as item(value)
    where nullif(item.value ->> 'instagramLedgerId', '') is not null
    group by item.value ->> 'instagramLedgerId'
    having count(*) > 1
  ) then
    raise exception 'A Meta Page or ledger entry was selected more than once';
  end if;

  select meta_user_id into v_meta_user_id
  from public.meta_oauth_candidates
  where selection_hash = p_selection_hash
    and owner = p_owner
    and browser_nonce_hash = p_browser_nonce_hash;
  if not found then
    raise exception 'The Meta Page selection belongs to another owner or browser session';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  if exists (
    select 1
    from public.meta_owner_erasure_leases
    where owner = p_owner
      and expires_at > now()
  ) then
    raise exception 'Meta asset finalization is blocked while owner erasure is running';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-identity:' || v_meta_user_id, 0)
  );

  select * into v_candidate
  from public.meta_oauth_candidates
  where selection_hash = p_selection_hash
    and owner = p_owner
    and browser_nonce_hash = p_browser_nonce_hash
    and revocation_state = 'pending'
    and expires_at > now()
  for update;
  if not found then
    raise exception 'The Meta Page selection expired or belongs to another browser session';
  end if;
  select * into v_reservation
  from public.meta_identity_reservations
  where meta_user_id = v_candidate.meta_user_id
  for update;
  if not found
    or v_reservation.owner <> p_owner
    or v_reservation.candidate_selection_hash is distinct from
      p_selection_hash then
    raise exception 'The Meta identity reservation is unavailable';
  end if;

  select secret.decrypted_secret::jsonb into v_bundle
  from vault.decrypted_secrets as secret
  where secret.id = v_candidate.vault_secret_id;
  if v_bundle is null
    or jsonb_typeof(v_bundle -> 'pages') <> 'array'
    or jsonb_array_length(v_bundle -> 'pages') > 100 then
    raise exception 'The encrypted Meta Page discovery result is unavailable';
  end if;

  v_user_access_token := trim(coalesce(v_bundle ->> 'user_access_token', ''));
  if v_user_access_token = ''
    or char_length(v_user_access_token) > 16384 then
    raise exception 'The encrypted Meta user token is invalid';
  end if;

  select * into v_existing_grant
  from public.meta_grants
  where meta_user_id = v_candidate.meta_user_id
  for update;
  if found and v_existing_grant.owner <> p_owner then
    raise exception 'That Meta identity is already connected to another owner';
  end if;

  -- Reauthorization must never fall through into the new-grant branch. A
  -- connect lease can expire while provider Page discovery is running; a
  -- concurrent disconnect may then revoke and delete the old grant. The
  -- reservation remembers that this candidate expected an existing grant, so
  -- require that exact grant and exact unexpired lease at commit time.
  if v_existing_grant.id is null then
    if p_lease_id is not null or v_reservation.grant_id is not null then
      raise exception 'The existing Meta grant disappeared before reauthorization finalized';
    end if;
  elsif (
    p_lease_id is null
    or v_reservation.grant_id is null
    or v_reservation.grant_id <> v_existing_grant.id
    or not exists (
      select 1
      from public.meta_token_operation_leases
      where grant_id = v_existing_grant.id
        and owner = p_owner
        and lease_id = p_lease_id
        and operation_kind = 'connect'
        and expires_at > now()
      for update
    )
  ) then
    raise exception 'The Meta connect lease expired or changed before finalization';
  end if;

  if v_existing_grant.id is not null and exists (
    select 1
    from public.meta_page_connections as existing
    where existing.grant_id = v_existing_grant.id
      and not exists (
        select 1
        from jsonb_array_elements(p_bindings) as binding(value)
        where binding.value ->> 'pageId' = existing.facebook_page_id
          and binding.value ->> 'facebookLedgerId' =
            existing.facebook_ledger_id::text
          and coalesce(nullif(binding.value ->> 'instagramLedgerId', ''), '') =
            coalesce(existing.instagram_ledger_id::text, '')
      )
  ) then
    raise exception 'Reauthorization must retain every existing Page and linked Instagram ledger binding';
  end if;

  if v_existing_grant.id is null then
    v_grant_id := gen_random_uuid();
    select vault.create_secret(
      jsonb_build_object(
        'access_token', v_user_access_token,
        'token_type', 'bearer',
        'expires_at', v_candidate.token_expires_at,
        'stored_at', now()
      )::text,
      'meta_user_' || v_grant_id::text,
      'Meta user access token for grant ' || v_grant_id::text
    ) into v_grant_secret_id;

    insert into public.meta_grants (
      id,
      owner,
      meta_user_id,
      meta_user_name,
      granted_scopes,
      expires_at,
      vault_secret_id,
      updated_at
    ) values (
      v_grant_id,
      p_owner,
      v_candidate.meta_user_id,
      left(v_candidate.meta_user_name, 255),
      v_candidate.granted_scopes,
      v_candidate.token_expires_at,
      v_grant_secret_id,
      now()
    );
  else
    v_grant_id := v_existing_grant.id;
    v_grant_secret_id := v_existing_grant.vault_secret_id;
    perform vault.update_secret(
      v_grant_secret_id,
      jsonb_build_object(
        'access_token', v_user_access_token,
        'token_type', 'bearer',
        'expires_at', v_candidate.token_expires_at,
        'stored_at', now()
      )::text,
      'meta_user_' || v_grant_id::text,
      'Meta user access token for grant ' || v_grant_id::text
    );
    update public.meta_grants
    set
      meta_user_name = left(v_candidate.meta_user_name, 255),
      granted_scopes = v_candidate.granted_scopes,
      expires_at = v_candidate.token_expires_at,
      updated_at = now()
    where id = v_grant_id and owner = p_owner;
  end if;

  for v_binding in
    select value from jsonb_array_elements(p_bindings)
  loop
    v_page_id := trim(coalesce(v_binding ->> 'pageId', ''));
    if v_page_id !~ '^[0-9]{1,64}$'
      or coalesce(v_binding ->> 'facebookLedgerId', '') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
      raise exception 'Invalid Facebook Page or ledger id';
    end if;
    v_facebook_ledger_id := (v_binding ->> 'facebookLedgerId')::uuid;
    v_instagram_ledger_id := null;
    if nullif(trim(coalesce(v_binding ->> 'instagramLedgerId', '')), '') is not null then
      if (v_binding ->> 'instagramLedgerId') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
        raise exception 'Invalid Instagram ledger id';
      end if;
      v_instagram_ledger_id := (v_binding ->> 'instagramLedgerId')::uuid;
    end if;

    select value into v_page
    from jsonb_array_elements(v_bundle -> 'pages') as page(value)
    where page.value ->> 'page_id' = v_page_id;
    if v_page is null then
      raise exception 'The selected Facebook Page was not in the provider discovery result';
    end if;

    v_page_name := trim(coalesce(v_page ->> 'page_name', ''));
    v_page_token := trim(coalesce(v_page ->> 'page_access_token', ''));
    if v_page_token = ''
      or char_length(v_page_token) > 16384
      or char_length(v_page_name) > 255 then
      raise exception 'The selected Facebook Page credential is invalid';
    end if;

    if jsonb_typeof(v_page -> 'page_tasks') = 'array' then
      select coalesce(array_agg(task.value order by task.value), '{}')
        into v_tasks
      from jsonb_array_elements_text(v_page -> 'page_tasks') as task(value)
      where char_length(task.value) between 1 and 64;
      if jsonb_array_length(v_page -> 'page_tasks') <>
        coalesce(array_length(v_tasks, 1), 0)
        or coalesce(array_length(v_tasks, 1), 0) > 32 then
        raise exception 'The selected Facebook Page task set is invalid';
      end if;
    else
      v_tasks := '{}';
    end if;

    v_instagram := case
      when jsonb_typeof(v_page -> 'instagram') = 'object'
      then v_page -> 'instagram'
      else null
    end;
    v_instagram_id := trim(coalesce(v_instagram ->> 'id', ''));
    v_instagram_username := trim(coalesce(v_instagram ->> 'username', ''));
    if v_instagram_ledger_id is not null then
      if v_instagram_id !~ '^[0-9]{1,64}$'
        or char_length(v_instagram_username) > 255 then
        raise exception 'That Page does not expose an eligible linked Instagram professional account';
      end if;
    else
      v_instagram_id := null;
      v_instagram_username := '';
    end if;

    select provider into v_provider
    from public.account_ledger
    where id = v_facebook_ledger_id and owner = p_owner
    for update;
    if not found or v_provider <> 'facebook' then
      raise exception 'Select an owned Facebook ledger entry for the Page';
    end if;

    select provider, provider_subject
      into v_prior_provider, v_prior_subject
    from public.account_connections
    where ledger_id = v_facebook_ledger_id
    for update;
    if found and (
      v_prior_provider <> 'facebook'
      or (
        trim(coalesce(v_prior_subject, '')) <> ''
        and v_prior_subject <> v_page_id
      )
    ) then
      raise exception 'Disconnect the previous Facebook identity before rebinding this ledger entry';
    end if;

    if v_instagram_ledger_id is not null then
      select provider into v_provider
      from public.account_ledger
      where id = v_instagram_ledger_id and owner = p_owner
      for update;
      if not found or v_provider <> 'instagram' then
        raise exception 'Select an owned Instagram ledger entry for the linked professional account';
      end if;

      select provider, provider_subject
        into v_prior_provider, v_prior_subject
      from public.account_connections
      where ledger_id = v_instagram_ledger_id
      for update;
      if found and (
        v_prior_provider <> 'instagram'
        or (
          trim(coalesce(v_prior_subject, '')) <> ''
          and v_prior_subject <> v_instagram_id
        )
      ) then
        raise exception 'Disconnect the previous Instagram identity before rebinding this ledger entry';
      end if;
    end if;

    select * into v_existing_page
    from public.meta_page_connections
    where facebook_ledger_id = v_facebook_ledger_id
    for update;
    if found and (
      v_existing_page.grant_id <> v_grant_id
      or v_existing_page.facebook_page_id <> v_page_id
      or (
        v_existing_page.instagram_business_id is not null
        and (
          v_existing_page.instagram_business_id <> v_instagram_id
          or v_existing_page.instagram_ledger_id is distinct from
            v_instagram_ledger_id
        )
      )
    ) then
      raise exception 'Disconnect the existing immutable Meta asset binding before changing it';
    end if;

    if exists (
      select 1
      from public.meta_page_connections
      where facebook_page_id = v_page_id
        and facebook_ledger_id <> v_facebook_ledger_id
    ) then
      raise exception 'That Facebook Page is already connected elsewhere';
    end if;
    if v_instagram_ledger_id is not null and exists (
      select 1
      from public.meta_page_connections
      where (
        instagram_ledger_id = v_instagram_ledger_id
        or instagram_business_id = v_instagram_id
      )
        and facebook_ledger_id <> v_facebook_ledger_id
    ) then
      raise exception 'That Instagram professional account is already connected elsewhere';
    end if;

    v_page_secret_id := v_existing_page.page_vault_secret_id;
    if v_page_secret_id is null then
      select vault.create_secret(
        jsonb_build_object(
          'access_token', v_page_token,
          'token_type', 'bearer',
          'facebook_page_id', v_page_id,
          'expires_at', v_candidate.token_expires_at,
          'stored_at', now()
        )::text,
        'meta_page_' || v_facebook_ledger_id::text,
        'Meta Page access token for ledger ' || v_facebook_ledger_id::text
      ) into v_page_secret_id;
    else
      perform vault.update_secret(
        v_page_secret_id,
        jsonb_build_object(
          'access_token', v_page_token,
          'token_type', 'bearer',
          'facebook_page_id', v_page_id,
          'expires_at', v_candidate.token_expires_at,
          'stored_at', now()
        )::text,
        'meta_page_' || v_facebook_ledger_id::text,
        'Meta Page access token for ledger ' || v_facebook_ledger_id::text
      );
    end if;

    insert into public.meta_page_connections as connection (
      facebook_ledger_id,
      owner,
      grant_id,
      facebook_page_id,
      facebook_page_name,
      page_tasks,
      instagram_ledger_id,
      instagram_business_id,
      instagram_username,
      page_vault_secret_id,
      updated_at
    ) values (
      v_facebook_ledger_id,
      p_owner,
      v_grant_id,
      v_page_id,
      v_page_name,
      v_tasks,
      v_instagram_ledger_id,
      v_instagram_id,
      v_instagram_username,
      v_page_secret_id,
      now()
    )
    on conflict (facebook_ledger_id) do update set
      owner = excluded.owner,
      grant_id = excluded.grant_id,
      facebook_page_id = excluded.facebook_page_id,
      facebook_page_name = excluded.facebook_page_name,
      page_tasks = excluded.page_tasks,
      instagram_ledger_id = excluded.instagram_ledger_id,
      instagram_business_id = excluded.instagram_business_id,
      instagram_username = excluded.instagram_username,
      page_vault_secret_id = excluded.page_vault_secret_id,
      updated_at = excluded.updated_at;

    insert into public.account_connections as account (
      ledger_id,
      owner,
      provider,
      provider_subject,
      provider_email,
      granted_scopes,
      connection_state,
      verification_method,
      verified_at,
      connected_at,
      last_checked_at,
      expires_at,
      error_code,
      updated_at
    ) values (
      v_facebook_ledger_id,
      p_owner,
      'facebook',
      v_page_id,
      '',
      v_candidate.granted_scopes,
      'connected',
      'meta_facebook_login_pages',
      now(),
      now(),
      now(),
      v_candidate.token_expires_at,
      '',
      now()
    )
    on conflict (ledger_id) do update set
      owner = excluded.owner,
      provider = excluded.provider,
      provider_subject = excluded.provider_subject,
      provider_email = '',
      granted_scopes = excluded.granted_scopes,
      connection_state = 'connected',
      verification_method = excluded.verification_method,
      verified_at = coalesce(account.verified_at, excluded.verified_at),
      connected_at = coalesce(account.connected_at, excluded.connected_at),
      last_checked_at = excluded.last_checked_at,
      expires_at = excluded.expires_at,
      error_code = '',
      updated_at = excluded.updated_at;

    if v_instagram_ledger_id is not null then
      insert into public.account_connections as account (
        ledger_id,
        owner,
        provider,
        provider_subject,
        provider_email,
        granted_scopes,
        connection_state,
        verification_method,
        verified_at,
        connected_at,
        last_checked_at,
        expires_at,
        error_code,
        updated_at
      ) values (
        v_instagram_ledger_id,
        p_owner,
        'instagram',
        v_instagram_id,
        '',
        v_candidate.granted_scopes,
        'connected',
        'meta_facebook_login_linked_instagram',
        now(),
        now(),
        now(),
        v_candidate.token_expires_at,
        '',
        now()
      )
      on conflict (ledger_id) do update set
        owner = excluded.owner,
        provider = excluded.provider,
        provider_subject = excluded.provider_subject,
        provider_email = '',
        granted_scopes = excluded.granted_scopes,
        connection_state = 'connected',
        verification_method = excluded.verification_method,
        verified_at = coalesce(account.verified_at, excluded.verified_at),
        connected_at = coalesce(account.connected_at, excluded.connected_at),
        last_checked_at = excluded.last_checked_at,
        expires_at = excluded.expires_at,
        error_code = '',
        updated_at = excluded.updated_at;
    end if;

    v_result_assets := v_result_assets || jsonb_build_array(
      jsonb_build_object(
        'facebookLedgerId', v_facebook_ledger_id,
        'facebookPageId', v_page_id,
        'facebookPageName', v_page_name,
        'instagramLedgerId', v_instagram_ledger_id,
        'instagramBusinessId', v_instagram_id,
        'instagramUsername', v_instagram_username
      )
    );
  end loop;

  update public.meta_identity_reservations
  set
    candidate_selection_hash = null,
    grant_id = v_grant_id,
    updated_at = now()
  where meta_user_id = v_candidate.meta_user_id
    and owner = p_owner
    and candidate_selection_hash = p_selection_hash;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'The Meta identity reservation could not be finalized safely';
  end if;

  delete from public.meta_oauth_candidates
  where selection_hash = p_selection_hash
    and owner = p_owner
    and browser_nonce_hash = p_browser_nonce_hash;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'The Meta Page selection could not be consumed safely';
  end if;

  return jsonb_build_object(
    'grantId', v_grant_id,
    'metaUserId', v_candidate.meta_user_id,
    'assets', v_result_assets
  );
end;
$$;

create or replace function public.meta_get_grant_token_bundle(
  p_grant_id uuid,
  p_owner uuid
)
returns table(
  meta_user_id text,
  granted_scopes text[],
  expires_at timestamptz,
  token_bundle jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    grant_row.meta_user_id,
    grant_row.granted_scopes,
    grant_row.expires_at,
    secret.decrypted_secret::jsonb
  from public.meta_grants as grant_row
  join vault.decrypted_secrets as secret
    on secret.id = grant_row.vault_secret_id
  where grant_row.id = p_grant_id
    and grant_row.owner = p_owner;
$$;

create or replace function public.meta_get_page_token_bundle(
  p_facebook_ledger_id uuid,
  p_owner uuid
)
returns table(
  grant_id uuid,
  facebook_page_id text,
  instagram_business_id text,
  token_bundle jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    connection.grant_id,
    connection.facebook_page_id,
    connection.instagram_business_id,
    secret.decrypted_secret::jsonb
  from public.meta_page_connections as connection
  join vault.decrypted_secrets as secret
    on secret.id = connection.page_vault_secret_id
  where connection.facebook_ledger_id = p_facebook_ledger_id
    and connection.owner = p_owner;
$$;

create or replace function public.meta_mark_grant_error(
  p_grant_id uuid,
  p_owner uuid,
  p_error_code text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
begin
  if not exists (
    select 1 from public.meta_grants
    where id = p_grant_id and owner = p_owner
  ) then
    raise exception 'Owned Meta grant not found';
  end if;
  if trim(coalesce(p_error_code, '')) = ''
    or char_length(p_error_code) > 128 then
    raise exception 'Invalid Meta connection error';
  end if;

  update public.account_connections as account
  set
    connection_state = 'error',
    error_code = p_error_code,
    last_checked_at = now(),
    updated_at = now()
  where account.owner = p_owner
    and account.ledger_id in (
      select page.facebook_ledger_id
      from public.meta_page_connections as page
      where page.grant_id = p_grant_id and page.owner = p_owner
      union all
      select page.instagram_ledger_id
      from public.meta_page_connections as page
      where page.grant_id = p_grant_id
        and page.owner = p_owner
        and page.instagram_ledger_id is not null
    );
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

drop function if exists public.meta_delete_grant_and_mark_disconnected(
  uuid, uuid
);
create or replace function public.meta_delete_grant_and_mark_disconnected(
  p_grant_id uuid,
  p_owner uuid,
  p_lease_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger_ids uuid[];
  v_deleted integer := 0;
  v_meta_user_id text;
  v_reservation_changed integer := 0;
begin
  select meta_user_id into v_meta_user_id
  from public.meta_grants
  where id = p_grant_id and owner = p_owner;
  if not found then raise exception 'Owned Meta grant not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:' || p_owner::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-identity:' || v_meta_user_id, 0)
  );
  if not exists (
    select 1
    from public.meta_token_operation_leases
    where grant_id = p_grant_id
      and owner = p_owner
      and lease_id = p_lease_id
      and operation_kind in ('disconnect', 'reset')
      and expires_at > now()
    for update
  ) then
    raise exception 'The Meta disconnect lease expired or changed before cleanup';
  end if;

  select coalesce(array_agg(ledger_id), '{}') into v_ledger_ids
  from (
    select page.facebook_ledger_id as ledger_id
    from public.meta_page_connections as page
    where page.grant_id = p_grant_id and page.owner = p_owner
    union all
    select page.instagram_ledger_id as ledger_id
    from public.meta_page_connections as page
    where page.grant_id = p_grant_id
      and page.owner = p_owner
      and page.instagram_ledger_id is not null
  ) as ledgers;

  delete from public.meta_identity_reservations
  where meta_user_id = v_meta_user_id
    and owner = p_owner
    and grant_id = p_grant_id
    and candidate_selection_hash is null;
  get diagnostics v_reservation_changed = row_count;
  if v_reservation_changed = 0 then
    update public.meta_identity_reservations
    set
      grant_id = null,
      updated_at = now()
    where meta_user_id = v_meta_user_id
      and owner = p_owner
      and grant_id = p_grant_id
      and candidate_selection_hash is not null;
    get diagnostics v_reservation_changed = row_count;
  end if;
  if v_reservation_changed <> 1 then
    raise exception 'The Meta identity reservation could not be released safely';
  end if;

  delete from public.meta_grants
  where id = p_grant_id and owner = p_owner;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception 'Owned Meta grant not found';
  end if;

  update public.account_connections
  set
    connection_state = 'disconnected',
    provider_subject = '',
    provider_email = '',
    granted_scopes = '{}',
    connected_at = null,
    expires_at = null,
    error_code = '',
    last_checked_at = now(),
    updated_at = now()
  where owner = p_owner
    and ledger_id = any(v_ledger_ids);

  return jsonb_build_object(
    'disconnectedLedgerIds', to_jsonb(v_ledger_ids)
  );
end;
$$;

-- A direct or stale browser write must not orphan an encrypted Page grant or
-- silently change a connected ledger's provider underneath its immutable id.
create or replace function public.guard_connected_meta_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.meta_page_connections
    where facebook_ledger_id = old.id
      or instagram_ledger_id = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Disconnect the Meta grant before deleting this account';
    end if;
    if new.provider is distinct from old.provider then
      raise exception 'Disconnect the Meta grant before changing this account provider';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_connected_meta_ledger_change
  on public.account_ledger;
create trigger guard_connected_meta_ledger_change
  before delete or update of provider on public.account_ledger
  for each row execute function public.guard_connected_meta_ledger_change();

-- Profile deletion cascades into candidates before an account-ledger guard can
-- help when authorization was completed but no Page was finalized. Require
-- the erasure endpoint to revoke that pending provider integration first.
create or replace function public.guard_pending_meta_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.meta_oauth_transactions
    where owner = old.id
  ) or exists (
    select 1
    from public.meta_oauth_candidates
    where owner = old.id
  ) or exists (
    select 1
    from public.meta_grants
    where owner = old.id
  ) or exists (
    select 1
    from public.meta_oauth_cleanup_holds
    where owner = old.id
  ) then
    raise exception 'Disconnect every Meta grant and resolve every pending or ambiguous Meta authorization before deleting this account';
  end if;
  return old;
end;
$$;

drop trigger if exists guard_pending_meta_profile_delete
  on public.profiles;
create trigger guard_pending_meta_profile_delete
  before delete on public.profiles
  for each row execute function public.guard_pending_meta_profile_delete();

revoke all on function public.meta_create_oauth_transaction(
  text, uuid, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.meta_claim_oauth_transaction(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_meta_owner_erasure(
  uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.renew_meta_owner_erasure(
  uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.release_meta_owner_erasure(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.meta_finish_oauth_transaction(
  text, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.meta_create_oauth_candidate(
  text, text, uuid, text, text, text, text[], timestamptz, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.meta_update_oauth_candidate_bundle(
  text, uuid, text, text[], timestamptz, text
) from public, anon, authenticated;
revoke all on function public.meta_create_cleanup_hold(
  uuid, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.meta_delete_cleanup_hold(
  uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.meta_get_oauth_candidate(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.meta_get_oauth_candidate_for_revocation(
  text, uuid, text
) from public, anon, authenticated;
revoke all on function public.meta_claim_oauth_candidate_for_revocation(
  text, uuid, text, boolean
) from public, anon, authenticated;
revoke all on function public.meta_mark_candidate_provider_revoked(text, uuid)
  from public, anon, authenticated;
revoke all on function public.meta_mark_candidate_manual_revoke(
  text, uuid, text
) from public, anon, authenticated;
revoke all on function public.meta_delete_oauth_candidate(text, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_meta_token_operation(
  uuid, uuid, uuid, text, integer
) from public, anon, authenticated;
revoke all on function public.release_meta_token_operation(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.meta_finalize_assets(text, uuid, text, jsonb, uuid)
  from public, anon, authenticated;
revoke all on function public.meta_get_grant_token_bundle(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.meta_get_page_token_bundle(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.meta_mark_grant_error(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.meta_delete_grant_and_mark_disconnected(
  uuid, uuid, uuid
)
  from public, anon, authenticated;
revoke all on function public.delete_meta_candidate_vault_secret()
  from public, anon, authenticated;
revoke all on function public.release_meta_candidate_reservation()
  from public, anon, authenticated;
revoke all on function public.delete_meta_grant_vault_secret()
  from public, anon, authenticated;
revoke all on function public.delete_meta_page_vault_secret()
  from public, anon, authenticated;
revoke all on function public.guard_connected_meta_ledger_change()
  from public, anon, authenticated;
revoke all on function public.guard_pending_meta_profile_delete()
  from public, anon, authenticated;

grant execute on function public.meta_create_oauth_transaction(
  text, uuid, text, text, timestamptz
) to service_role;
grant execute on function public.meta_claim_oauth_transaction(text, uuid, text)
  to service_role;
grant execute on function public.claim_meta_owner_erasure(
  uuid, uuid, integer
) to service_role;
grant execute on function public.renew_meta_owner_erasure(
  uuid, uuid, integer
) to service_role;
grant execute on function public.release_meta_owner_erasure(uuid, uuid)
  to service_role;
grant execute on function public.meta_finish_oauth_transaction(
  text, uuid, text, text, text
) to service_role;
grant execute on function public.meta_create_oauth_candidate(
  text, text, uuid, text, text, text, text[], timestamptz, text, timestamptz
) to service_role;
grant execute on function public.meta_update_oauth_candidate_bundle(
  text, uuid, text, text[], timestamptz, text
) to service_role;
grant execute on function public.meta_create_cleanup_hold(
  uuid, text, text, text, text, text
) to service_role;
grant execute on function public.meta_delete_cleanup_hold(
  uuid, text, text, text
) to service_role;
grant execute on function public.meta_get_oauth_candidate(text, uuid, text)
  to service_role;
grant execute on function public.meta_get_oauth_candidate_for_revocation(
  text, uuid, text
) to service_role;
grant execute on function public.meta_claim_oauth_candidate_for_revocation(
  text, uuid, text, boolean
) to service_role;
grant execute on function public.meta_mark_candidate_provider_revoked(text, uuid)
  to service_role;
grant execute on function public.meta_mark_candidate_manual_revoke(
  text, uuid, text
) to service_role;
grant execute on function public.meta_delete_oauth_candidate(text, uuid)
  to service_role;
grant execute on function public.claim_meta_token_operation(
  uuid, uuid, uuid, text, integer
) to service_role;
grant execute on function public.release_meta_token_operation(uuid, uuid, uuid)
  to service_role;
grant execute on function public.meta_finalize_assets(text, uuid, text, jsonb, uuid)
  to service_role;
grant execute on function public.meta_get_grant_token_bundle(uuid, uuid)
  to service_role;
grant execute on function public.meta_get_page_token_bundle(uuid, uuid)
  to service_role;
grant execute on function public.meta_mark_grant_error(uuid, uuid, text)
  to service_role;
grant execute on function public.meta_delete_grant_and_mark_disconnected(
  uuid, uuid, uuid
)
  to service_role;

comment on function public.meta_create_oauth_transaction(
  text, uuid, text, text, timestamptz
) is
  'Service-only owner-locked creation of one pending Meta OAuth transaction.';
comment on function public.meta_claim_oauth_transaction(text, uuid, text) is
  'Service-only transition of an exact pending Meta OAuth transaction into fail-closed processing state.';
comment on function public.claim_meta_owner_erasure(uuid, uuid, integer) is
  'Service-only owner-locked erasure gate that rejects processing OAuth and atomically cancels pending OAuth.';
comment on function public.renew_meta_owner_erasure(uuid, uuid, integer) is
  'Service-only exact renewal of an active owner erasure lease.';
comment on function public.release_meta_owner_erasure(uuid, uuid) is
  'Service-only exact release of an owner erasure lease.';
comment on function public.meta_finish_oauth_transaction(
  text, uuid, text, text, text
) is
  'Service-only exact resolution of a claimed Meta OAuth transaction when no provider credential must be retained.';
comment on function public.meta_create_oauth_candidate(
  text, text, uuid, text, text, text, text[], timestamptz, text, timestamptz
) is
  'Service-only atomic OAuth-processing resolution into encrypted short-lived Meta Page-selection state.';
comment on function public.meta_update_oauth_candidate_bundle(
  text, uuid, text, text[], timestamptz, text
) is
  'Service-only update of an identity-reserved Meta candidate after provider Page discovery completes.';
comment on function public.meta_create_cleanup_hold(
  uuid, text, text, text, text, text
) is
  'Service-only durable fail-closed marker that can atomically resolve an ambiguous claimed Meta exchange.';
comment on function public.meta_delete_cleanup_hold(
  uuid, text, text, text
) is
  'Service-only exact removal of a manual-revoke hold after provider-revocation acknowledgement.';
comment on function public.meta_get_oauth_candidate_for_revocation(
  text, uuid, text
) is
  'Service-only retrieval of an expired or active Meta candidate solely for confirmed revocation cleanup.';
comment on function public.meta_claim_oauth_candidate_for_revocation(
  text, uuid, text, boolean
) is
  'Service-only atomic claim that prevents an active or expired Meta candidate from racing provider revocation against finalization.';
comment on function public.meta_mark_candidate_provider_revoked(text, uuid) is
  'Service-only retry marker proving provider revocation succeeded before local candidate cleanup.';
comment on function public.meta_mark_candidate_manual_revoke(
  text, uuid, text
) is
  'Service-only fail-closed marker retaining a Meta candidate until provider-side manual revocation is acknowledged.';
comment on function public.meta_delete_oauth_candidate(text, uuid) is
  'Service-only deletion of a Meta candidate and Vault token after confirmed or acknowledged provider revocation.';
comment on function public.meta_finalize_assets(text, uuid, text, jsonb, uuid) is
  'Service-only atomic binding of provider-discovered Facebook Pages and linked Instagram professional accounts to owner ledger rows.';
comment on function public.meta_get_grant_token_bundle(uuid, uuid) is
  'Service-only retrieval of a Meta user access-token bundle from Vault.';
comment on function public.meta_get_page_token_bundle(uuid, uuid) is
  'Service-only retrieval of a Facebook Page access-token bundle from Vault; it does not grant posting authority.';
comment on function public.meta_delete_grant_and_mark_disconnected(
  uuid, uuid, uuid
) is
  'Service-only local cleanup after confirmed provider revocation or explicit manual-revocation acknowledgement.';
comment on function public.guard_pending_meta_profile_delete() is
  'Prevents profile cascades from silently deleting Meta OAuth state, an unrevoked grant, authorization candidate, or ambiguous-exchange cleanup hold.';

commit;
