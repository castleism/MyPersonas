-- Revoke stale AliaSpaces confirmed-email attestations when the authentication
-- email is no longer confirmed or no longer matches the saved ledger email.
--
-- This migration deliberately affects only connection_state='verified' rows
-- produced by verify_account_ledger_email(). Provider/OAuth connections in the
-- 'connected' state are independent attestations and are never disconnected by
-- an AliaSpaces account-email change.

create or replace function public.invalidate_stale_aliaspaces_email_attestations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirmed_email text:=lower(pg_catalog.btrim(coalesce(new.email,'')));
  v_email_is_confirmed boolean:=new.email_confirmed_at is not null
    and v_confirmed_email<>'';
begin
  -- UPDATE OF can still be invoked with unchanged values. Avoid unnecessary
  -- owner-wide serialization in that case.
  if lower(pg_catalog.btrim(coalesce(old.email,'')))
       is not distinct from v_confirmed_email
     and old.email_confirmed_at is not distinct from new.email_confirmed_at then
    return new;
  end if;

  -- Match verify_account_ledger_email() and ledger mutation lock ordering:
  -- owner advisory lock, ledger rows in id order, then connection rows.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.id::text,51051059)
  );

  perform 1
  from public.account_ledger as ledger
  where ledger.owner=new.id
    and exists (
      select 1
      from public.account_connections as connection
      where connection.ledger_id=ledger.id
        and connection.owner=new.id
        and connection.verification_method='aliaspaces_confirmed_email'
        and connection.connection_state='verified'
    )
  order by ledger.id
  for update of ledger;

  perform 1
  from public.account_connections as connection
  where connection.owner=new.id
    and connection.verification_method='aliaspaces_confirmed_email'
    and connection.connection_state='verified'
  order by connection.ledger_id
  for update of connection;

  update public.account_connections as connection
  set connection_state='disconnected',
      provider_email='',
      verified_at=null,
      last_checked_at=now(),
      error_code=case
        when not v_email_is_confirmed then 'aliaspaces_email_unconfirmed'
        else 'aliaspaces_email_changed'
      end,
      updated_at=now()
  from public.account_ledger as ledger
  where ledger.id=connection.ledger_id
    and ledger.owner=connection.owner
    and connection.owner=new.id
    and connection.verification_method='aliaspaces_confirmed_email'
    and connection.connection_state='verified'
    and (
      not v_email_is_confirmed
      or lower(pg_catalog.btrim(coalesce(ledger.login_email,'')))
           is distinct from v_confirmed_email
    );

  return new;
end;
$$;

revoke all on function public.invalidate_stale_aliaspaces_email_attestations()
  from public,anon,authenticated,service_role;

comment on function public.invalidate_stale_aliaspaces_email_attestations() is
  'Trigger-only revocation of stale AliaSpaces confirmed-email attestations; OAuth/provider-connected rows are not affected.';

drop trigger if exists invalidate_stale_aliaspaces_email_attestations
  on auth.users;
create trigger invalidate_stale_aliaspaces_email_attestations
  after update of email,email_confirmed_at on auth.users
  for each row
  execute function public.invalidate_stale_aliaspaces_email_attestations();

-- One-time repair for stale attestations that predate the trigger. Each owner
-- uses the same lock and row order as the trigger so this can run while the
-- application is online without racing verification or ledger edits.
do $backfill$
declare
  v_owner uuid;
  v_confirmed_email text;
  v_email_is_confirmed boolean;
begin
  for v_owner in
    select distinct connection.owner
    from public.account_connections as connection
    join public.account_ledger as ledger
      on ledger.id=connection.ledger_id
     and ledger.owner=connection.owner
    left join auth.users as auth_user on auth_user.id=connection.owner
    where connection.verification_method='aliaspaces_confirmed_email'
      and connection.connection_state='verified'
      and (
        auth_user.email_confirmed_at is null
        or nullif(lower(pg_catalog.btrim(coalesce(auth_user.email,''))),'') is null
        or lower(pg_catalog.btrim(coalesce(ledger.login_email,'')))
             is distinct from lower(pg_catalog.btrim(coalesce(auth_user.email,'')))
      )
    order by connection.owner
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_owner::text,51051059)
    );

    v_confirmed_email:='';
    v_email_is_confirmed:=false;
    select lower(pg_catalog.btrim(coalesce(auth_user.email,''))),
           auth_user.email_confirmed_at is not null
             and pg_catalog.btrim(coalesce(auth_user.email,''))<>''
      into v_confirmed_email,v_email_is_confirmed
    from auth.users as auth_user
    where auth_user.id=v_owner;

    perform 1
    from public.account_ledger as ledger
    where ledger.owner=v_owner
      and exists (
        select 1
        from public.account_connections as connection
        where connection.ledger_id=ledger.id
          and connection.owner=v_owner
          and connection.verification_method='aliaspaces_confirmed_email'
          and connection.connection_state='verified'
      )
    order by ledger.id
    for update of ledger;

    perform 1
    from public.account_connections as connection
    where connection.owner=v_owner
      and connection.verification_method='aliaspaces_confirmed_email'
      and connection.connection_state='verified'
    order by connection.ledger_id
    for update of connection;

    update public.account_connections as connection
    set connection_state='disconnected',
        provider_email='',
        verified_at=null,
        last_checked_at=now(),
        error_code=case
          when not v_email_is_confirmed then 'aliaspaces_email_unconfirmed'
          else 'aliaspaces_email_changed'
        end,
        updated_at=now()
    from public.account_ledger as ledger
    where ledger.id=connection.ledger_id
      and ledger.owner=connection.owner
      and connection.owner=v_owner
      and connection.verification_method='aliaspaces_confirmed_email'
      and connection.connection_state='verified'
      and (
        not v_email_is_confirmed
        or lower(pg_catalog.btrim(coalesce(ledger.login_email,'')))
             is distinct from v_confirmed_email
      );
  end loop;
end
$backfill$;

