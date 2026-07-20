-- Server-attested connection state for external accounts.
-- This table deliberately contains no access tokens, refresh tokens, passwords,
-- recovery codes, or other credentials. OAuth secrets belong in server-only storage.

create unique index if not exists account_ledger_id_owner_idx
  on public.account_ledger (id, owner);

create table if not exists public.account_connections (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  provider_subject text default '',
  provider_email text default '',
  granted_scopes text[] not null default '{}',
  connection_state text not null default 'verified'
    check (connection_state in ('verified','connected','error','disconnected')),
  verification_method text default '',
  verified_at timestamptz,
  connected_at timestamptz,
  last_checked_at timestamptz,
  expires_at timestamptz,
  error_code text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

alter table public.account_connections enable row level security;

drop policy if exists "account connections owner read" on public.account_connections;
create policy "account connections owner read" on public.account_connections
  for select using (auth.uid() = owner);

-- Browsers may read their own attested state but may not assert or alter it.
revoke all on public.account_connections from anon, authenticated;
grant select on public.account_connections to authenticated;

create index if not exists account_connections_owner_idx
  on public.account_connections (owner);
create unique index if not exists account_connections_provider_subject_idx
  on public.account_connections (provider, provider_subject)
  where provider_subject <> '';

comment on table public.account_connections is
  'Server-attested external account verification and OAuth connection state; contains no credentials or tokens.';

-- A safe first verification step: prove that the ledger email matches the
-- confirmed email in the current AliaSpaces authentication session. This verifies
-- ownership only; it does not grant access to an inbox or external API.
create or replace function public.verify_account_ledger_email(p_ledger_id uuid)
returns public.account_connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger public.account_ledger%rowtype;
  v_email text;
  v_connection public.account_connections%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select lower(trim(email)) into v_email
  from auth.users
  where id = auth.uid() and email_confirmed_at is not null;

  if v_email is null or v_email = '' then
    raise exception 'A confirmed AliaSpaces email is required';
  end if;

  select * into v_ledger
  from public.account_ledger
  where id = p_ledger_id and owner = auth.uid();

  if not found then
    raise exception 'Account ledger entry not found';
  end if;
  if trim(coalesce(v_ledger.login_email, '')) = '' then
    raise exception 'A login email is required for ownership verification';
  end if;
  if v_email <> lower(trim(v_ledger.login_email)) then
    raise exception 'Recorded login email does not match the signed-in AliaSpaces email';
  end if;

  insert into public.account_connections as ac (
    ledger_id, owner, provider, provider_email, connection_state,
    verification_method, verified_at, last_checked_at, updated_at
  ) values (
    v_ledger.id, v_ledger.owner, v_ledger.provider, v_email, 'verified',
    'aliaspaces_confirmed_email', now(), now(), now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    provider = excluded.provider,
    provider_email = excluded.provider_email,
    connection_state = case
      when ac.connection_state = 'connected' then 'connected'
      else 'verified'
    end,
    verification_method = excluded.verification_method,
    verified_at = excluded.verified_at,
    last_checked_at = excluded.last_checked_at,
    error_code = '',
    updated_at = excluded.updated_at
  returning * into v_connection;

  return v_connection;
end;
$$;

revoke all on function public.verify_account_ledger_email(uuid) from public;
grant execute on function public.verify_account_ledger_email(uuid) to authenticated;

comment on function public.verify_account_ledger_email(uuid) is
  'Verifies ledger email ownership from the confirmed authentication email; does not grant external API access.';
