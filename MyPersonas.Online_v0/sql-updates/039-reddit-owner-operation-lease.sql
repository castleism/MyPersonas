-- 039-reddit-owner-operation-lease.sql
-- Durable owner-scoped serialization for Reddit OAuth, posting, disconnect,
-- and account/content erasure.  The table and every RPC are service-role only.
-- Apply after 021-reddit-oauth.sql.  It is independent of dormant migration 036.

create table if not exists public.reddit_owner_operations (
  owner uuid primary key references public.profiles(id) on delete cascade,
  operation text not null,
  lease_id uuid not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.reddit_owner_operations enable row level security;
revoke all on public.reddit_owner_operations from public, anon, authenticated;
grant all on public.reddit_owner_operations to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.reddit_owner_operations'::regclass
      and conname = 'reddit_owner_operations_operation_check'
  ) then
    alter table public.reddit_owner_operations
      add constraint reddit_owner_operations_operation_check
      check (operation in ('oauth', 'post', 'disconnect', 'erase'));
  end if;
end
$$;

create index if not exists reddit_owner_operations_expires_idx
  on public.reddit_owner_operations (expires_at);

comment on table public.reddit_owner_operations is
  'Service-only owner lease serializing Reddit provider work with erasure.';

create or replace function public.reddit_claim_owner_operation_service(
  p_owner uuid,
  p_lease_id uuid,
  p_operation text,
  p_ttl_seconds integer default 600
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_operation text;
begin
  if p_owner is null or p_lease_id is null or
     p_operation not in ('oauth', 'post', 'disconnect', 'erase') or
     p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    raise exception 'invalid Reddit owner-operation lease request';
  end if;

  insert into public.reddit_owner_operations as current_operation (
    owner, operation, lease_id, expires_at, updated_at
  ) values (
    p_owner,
    p_operation,
    p_lease_id,
    clock_timestamp() + make_interval(secs => p_ttl_seconds),
    clock_timestamp()
  )
  on conflict (owner) do update set
    operation = excluded.operation,
    lease_id = excluded.lease_id,
    expires_at = excluded.expires_at,
    updated_at = excluded.updated_at
  where current_operation.expires_at <= clock_timestamp()
  returning owner into v_owner;

  if v_owner is not null then
    return 'claimed';
  end if;

  select operation into v_operation
  from public.reddit_owner_operations
  where owner = p_owner;

  if v_operation = 'erase' then
    return 'erasing';
  end if;
  return 'busy';
end;
$$;

revoke all on function public.reddit_claim_owner_operation_service(uuid,uuid,text,integer)
  from public, anon, authenticated;
grant execute on function public.reddit_claim_owner_operation_service(uuid,uuid,text,integer)
  to service_role;

create or replace function public.reddit_renew_owner_operation_service(
  p_owner uuid,
  p_lease_id uuid,
  p_operation text,
  p_ttl_seconds integer default 600
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if p_owner is null or p_lease_id is null or
     p_operation not in ('oauth', 'post', 'disconnect', 'erase') or
     p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    return false;
  end if;

  update public.reddit_owner_operations
  set expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds),
      updated_at = clock_timestamp()
  where owner = p_owner
    and lease_id = p_lease_id
    and operation = p_operation
    and expires_at > clock_timestamp()
  returning owner into v_owner;
  return v_owner is not null;
end;
$$;

revoke all on function public.reddit_renew_owner_operation_service(uuid,uuid,text,integer)
  from public, anon, authenticated;
grant execute on function public.reddit_renew_owner_operation_service(uuid,uuid,text,integer)
  to service_role;

create or replace function public.reddit_release_owner_operation_service(
  p_owner uuid,
  p_lease_id uuid,
  p_operation text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  delete from public.reddit_owner_operations
  where owner = p_owner
    and lease_id = p_lease_id
    and operation = p_operation
  returning owner into v_owner;
  return v_owner is not null;
end;
$$;

revoke all on function public.reddit_release_owner_operation_service(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.reddit_release_owner_operation_service(uuid,uuid,text)
  to service_role;

create or replace function public.reddit_store_tokens_leased_service(
  p_ledger_id uuid,
  p_owner uuid,
  p_username text,
  p_access_token text,
  p_refresh_token text,
  p_scopes text[],
  p_expires_at timestamptz,
  p_lease_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.reddit_owner_operations
    where owner = p_owner and lease_id = p_lease_id and operation = 'oauth'
      and expires_at > clock_timestamp()
  ) then
    raise exception 'Reddit OAuth owner-operation lease is not active';
  end if;
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = p_owner and provider = 'reddit'
  ) then
    raise exception 'owned Reddit ledger record not found';
  end if;
  if coalesce(p_access_token, '') = '' or coalesce(p_refresh_token, '') = '' then
    raise exception 'Reddit token set is incomplete';
  end if;

  perform public.reddit_store_tokens_service(
    p_ledger_id, p_owner, p_username, p_access_token, p_refresh_token,
    p_scopes, p_expires_at
  );
end;
$$;

revoke all on function public.reddit_store_tokens_leased_service(uuid,uuid,text,text,text,text[],timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.reddit_store_tokens_leased_service(uuid,uuid,text,text,text,text[],timestamptz,uuid)
  to service_role;

create or replace function public.reddit_get_tokens_leased_service(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid,
  p_operation text
) returns table(access_token text, refresh_token text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_operation not in ('post', 'disconnect', 'erase') or not exists (
    select 1 from public.reddit_owner_operations
    where owner = p_owner and lease_id = p_lease_id and operation = p_operation
      and expires_at > clock_timestamp()
  ) then
    raise exception 'Reddit owner-operation lease is not active';
  end if;
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = p_owner and provider = 'reddit'
  ) then
    raise exception 'owned Reddit ledger record not found';
  end if;

  return query select
    (select decrypted_secret from vault.decrypted_secrets
      where name = 'reddit_access_' || p_ledger_id),
    (select decrypted_secret from vault.decrypted_secrets
      where name = 'reddit_refresh_' || p_ledger_id);
end;
$$;

revoke all on function public.reddit_get_tokens_leased_service(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.reddit_get_tokens_leased_service(uuid,uuid,uuid,text)
  to service_role;

create or replace function public.reddit_update_access_token_leased_service(
  p_ledger_id uuid,
  p_owner uuid,
  p_access_token text,
  p_expires_at timestamptz,
  p_lease_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.reddit_owner_operations
    where owner = p_owner and lease_id = p_lease_id and operation = 'post'
      and expires_at > clock_timestamp()
  ) then
    raise exception 'Reddit post owner-operation lease is not active';
  end if;
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = p_owner and provider = 'reddit'
  ) then
    raise exception 'owned Reddit ledger record not found';
  end if;
  if coalesce(p_access_token, '') = '' then
    raise exception 'Reddit access token is empty';
  end if;

  perform public.reddit_update_access_token_service(
    p_ledger_id, p_access_token, p_expires_at
  );
end;
$$;

revoke all on function public.reddit_update_access_token_leased_service(uuid,uuid,text,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.reddit_update_access_token_leased_service(uuid,uuid,text,timestamptz,uuid)
  to service_role;

create or replace function public.reddit_clear_tokens_leased_service(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid,
  p_operation text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_operation not in ('disconnect', 'erase') or not exists (
    select 1 from public.reddit_owner_operations
    where owner = p_owner and lease_id = p_lease_id and operation = p_operation
      and expires_at > clock_timestamp()
  ) then
    raise exception 'Reddit owner-operation lease is not active';
  end if;
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = p_owner and provider = 'reddit'
  ) then
    raise exception 'owned Reddit ledger record not found';
  end if;

  perform public.reddit_clear_tokens_service(p_ledger_id);
end;
$$;

revoke all on function public.reddit_clear_tokens_leased_service(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.reddit_clear_tokens_leased_service(uuid,uuid,uuid,text)
  to service_role;

