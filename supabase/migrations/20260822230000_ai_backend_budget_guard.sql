-- 057-ai-backend-budget-guard.sql
-- Durable request/token reservations for owner-linked AI backends.
--
-- Automated modes are deliberately dormant: agent_board and automation calls
-- are denied until the owner saves an enabled AAL2 policy with explicit daily
-- and monthly request/token ceilings. Existing interactive owner_chat and
-- persona_builder calls keep their prior behavior when no policy exists; once
-- an owner creates a policy for either manual mode, that explicit policy is
-- enforced. No provider prices, currencies, or cost estimates are stored.

begin;

create table if not exists public.ai_backend_budget_policies(
  owner uuid not null references public.profiles(id) on delete cascade,
  backend_id uuid not null,
  mode text not null check(mode in(
    'owner_chat','persona_builder','agent_board','automation'
  )),
  enabled boolean not null default false,
  daily_request_limit bigint not null default 0
    check(daily_request_limit between 0 and 1000000),
  monthly_request_limit bigint not null default 0
    check(monthly_request_limit between 0 and 30000000),
  daily_token_limit bigint not null default 0
    check(daily_token_limit between 0 and 1000000000000),
  monthly_token_limit bigint not null default 0
    check(monthly_token_limit between 0 and 30000000000000),
  max_concurrent_leases integer not null default 1
    check(max_concurrent_leases between 1 and 100),
  lease_ttl_seconds integer not null default 120,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(owner,backend_id,mode),
  constraint ai_backend_budget_policy_backend_fkey
    foreign key(backend_id,owner)
    references public.ai_backends(id,owner) on delete cascade,
  constraint ai_backend_budget_policy_enabled_limits_check check(
    not enabled or (
      daily_request_limit>0
      and monthly_request_limit>=daily_request_limit
      and daily_token_limit>0
      and monthly_token_limit>=daily_token_limit
    )
  )
);

alter table public.ai_backend_budget_policies
  drop constraint if exists ai_backend_budget_policies_lease_ttl_seconds_check;
alter table public.ai_backend_budget_policies
  add constraint ai_backend_budget_policies_lease_ttl_seconds_check
  check(lease_ttl_seconds between 60 and 3600);

create table if not exists public.ai_backend_budget_usage(
  owner uuid not null references public.profiles(id) on delete cascade,
  backend_id uuid not null,
  mode text not null check(mode in(
    'owner_chat','persona_builder','agent_board','automation'
  )),
  window_kind text not null check(window_kind in('day','month')),
  window_start timestamptz not null,
  request_count bigint not null default 0 check(request_count>=0),
  reserved_tokens bigint not null default 0 check(reserved_tokens>=0),
  actual_tokens bigint not null default 0 check(actual_tokens>=0),
  updated_at timestamptz not null default now(),
  primary key(owner,backend_id,mode,window_kind,window_start)
);

create index if not exists ai_backend_budget_usage_retention_idx
  on public.ai_backend_budget_usage(window_kind,window_start);

create table if not exists public.ai_backend_budget_leases(
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null,
  owner uuid not null references public.profiles(id) on delete cascade,
  backend_id uuid not null,
  mode text not null check(mode in(
    'owner_chat','persona_builder','agent_board','automation'
  )),
  reserved_tokens bigint not null
    check(reserved_tokens between 1 and 50000000),
  status text not null default 'active'
    check(status in('active','completed','failed','expired')),
  actual_tokens bigint check(actual_tokens between 0 and 1000000000),
  provider_usage_reported boolean not null default false,
  outcome_code text not null default '' check(char_length(outcome_code)<=80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  unique(owner,request_key),
  check(expires_at>created_at and expires_at<=created_at+interval '1 hour'),
  check((status='active' and finalized_at is null)
    or (status<>'active' and finalized_at is not null)),
  check((provider_usage_reported and actual_tokens is not null)
    or (not provider_usage_reported and actual_tokens is null))
);

create index if not exists ai_backend_budget_active_lease_idx
  on public.ai_backend_budget_leases(owner,backend_id,mode,expires_at)
  where status='active';
create index if not exists ai_backend_budget_lease_retention_idx
  on public.ai_backend_budget_leases(finalized_at,id)
  where status<>'active';

alter table public.ai_backend_budget_policies enable row level security;
alter table public.ai_backend_budget_usage enable row level security;
alter table public.ai_backend_budget_leases enable row level security;

revoke all on public.ai_backend_budget_policies,
  public.ai_backend_budget_usage,
  public.ai_backend_budget_leases
  from public,anon,authenticated,service_role;

create or replace function public.lock_ai_backend_budget(
  p_owner uuid,p_backend_id uuid
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null or p_backend_id is null then
    raise exception 'Budget lock owner and backend are required';
  end if;
  -- Every budget mutation uses owner first, then backend. Row locks come last.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051160)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_backend_id::text,51051161)
  );
end;
$$;

revoke all on function public.lock_ai_backend_budget(uuid,uuid)
  from public,anon,authenticated,service_role;

create or replace function public.save_ai_backend_budget_policy(
  p_backend_id uuid,p_mode text,p_enabled boolean,
  p_daily_request_limit bigint,p_monthly_request_limit bigint,
  p_daily_token_limit bigint,p_monthly_token_limit bigint,
  p_max_concurrent_leases integer,p_lease_ttl_seconds integer
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_mode text:=lower(pg_catalog.btrim(coalesce(p_mode,'')));
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_backend_id is null
     or v_mode not in('owner_chat','persona_builder','agent_board','automation')
     or p_enabled is null
     or p_daily_request_limit is null
     or p_monthly_request_limit is null
     or p_daily_token_limit is null
     or p_monthly_token_limit is null
     or p_max_concurrent_leases is null
     or p_lease_ttl_seconds is null then
    raise exception 'Complete budget policy values are required';
  end if;
  if p_daily_request_limit not between 0 and 1000000
     or p_monthly_request_limit not between 0 and 30000000
     or p_daily_token_limit not between 0 and 1000000000000
     or p_monthly_token_limit not between 0 and 30000000000000
     or p_max_concurrent_leases not between 1 and 100
     or p_lease_ttl_seconds not between 60 and 3600 then
    raise exception 'Budget policy values are outside safe bounds';
  end if;
  if p_enabled and (
    p_daily_request_limit=0
    or p_monthly_request_limit<p_daily_request_limit
    or p_daily_token_limit=0
    or p_monthly_token_limit<p_daily_token_limit
  ) then
    raise exception 'Enabled policies require positive daily and monthly ceilings';
  end if;

  perform public.lock_ai_backend_budget(v_owner,p_backend_id);
  perform 1 from public.ai_backends backend
  where backend.id=p_backend_id and backend.owner=v_owner for update;
  if not found then raise exception 'Owned AI backend not found'; end if;

  insert into public.ai_backend_budget_policies(
    owner,backend_id,mode,enabled,daily_request_limit,
    monthly_request_limit,daily_token_limit,monthly_token_limit,
    max_concurrent_leases,lease_ttl_seconds,updated_at
  ) values(
    v_owner,p_backend_id,v_mode,p_enabled,p_daily_request_limit,
    p_monthly_request_limit,p_daily_token_limit,p_monthly_token_limit,
    p_max_concurrent_leases,p_lease_ttl_seconds,now()
  )
  on conflict(owner,backend_id,mode) do update set
    enabled=excluded.enabled,
    daily_request_limit=excluded.daily_request_limit,
    monthly_request_limit=excluded.monthly_request_limit,
    daily_token_limit=excluded.daily_token_limit,
    monthly_token_limit=excluded.monthly_token_limit,
    max_concurrent_leases=excluded.max_concurrent_leases,
    lease_ttl_seconds=excluded.lease_ttl_seconds,
    updated_at=now();
  return true;
end;
$$;

create or replace function public.my_ai_backend_budget_policies()
returns table(
  backend_id uuid,mode text,enabled boolean,
  daily_request_limit bigint,monthly_request_limit bigint,
  daily_token_limit bigint,monthly_token_limit bigint,
  max_concurrent_leases integer,lease_ttl_seconds integer,
  day_requests bigint,day_accounted_tokens bigint,
  month_requests bigint,month_accounted_tokens bigint,
  active_leases bigint,updated_at timestamptz
)
language plpgsql security definer stable set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_day timestamptz:=pg_catalog.date_trunc(
    'day',pg_catalog.timezone('UTC',now())
  ) at time zone 'UTC';
  v_month timestamptz:=pg_catalog.date_trunc(
    'month',pg_catalog.timezone('UTC',now())
  ) at time zone 'UTC';
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  return query
  select policy.backend_id,policy.mode,policy.enabled,
    policy.daily_request_limit,policy.monthly_request_limit,
    policy.daily_token_limit,policy.monthly_token_limit,
    policy.max_concurrent_leases,policy.lease_ttl_seconds,
    coalesce(day_usage.request_count,0),
    coalesce(day_usage.reserved_tokens+day_usage.actual_tokens,0),
    coalesce(month_usage.request_count,0),
    coalesce(month_usage.reserved_tokens+month_usage.actual_tokens,0),
    (select count(*) from public.ai_backend_budget_leases lease
      where lease.owner=v_owner and lease.backend_id=policy.backend_id
        and lease.mode=policy.mode and lease.status='active'
        and lease.expires_at>now()),
    policy.updated_at
  from public.ai_backend_budget_policies policy
  left join public.ai_backend_budget_usage day_usage
    on day_usage.owner=policy.owner
   and day_usage.backend_id=policy.backend_id
   and day_usage.mode=policy.mode
   and day_usage.window_kind='day' and day_usage.window_start=v_day
  left join public.ai_backend_budget_usage month_usage
    on month_usage.owner=policy.owner
   and month_usage.backend_id=policy.backend_id
   and month_usage.mode=policy.mode
   and month_usage.window_kind='month' and month_usage.window_start=v_month
  where policy.owner=v_owner
  order by policy.backend_id,policy.mode;
end;
$$;

create or replace function public.claim_ai_backend_budget(
  p_owner uuid,p_backend_id uuid,p_mode text,
  p_reserved_tokens bigint,p_request_key uuid
)
returns table(
  allowed boolean,lease_id uuid,denial_code text,expires_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_mode text:=lower(pg_catalog.btrim(coalesce(p_mode,'')));
  v_policy public.ai_backend_budget_policies%rowtype;
  v_existing public.ai_backend_budget_leases%rowtype;
  v_day_usage public.ai_backend_budget_usage%rowtype;
  v_month_usage public.ai_backend_budget_usage%rowtype;
  v_day timestamptz:=pg_catalog.date_trunc(
    'day',pg_catalog.timezone('UTC',now())
  ) at time zone 'UTC';
  v_month timestamptz:=pg_catalog.date_trunc(
    'month',pg_catalog.timezone('UTC',now())
  ) at time zone 'UTC';
  v_lease_id uuid;
  v_expires timestamptz;
  v_active integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null or p_backend_id is null or p_request_key is null
     or v_mode not in('owner_chat','persona_builder','agent_board','automation')
     or p_reserved_tokens is null
     or p_reserved_tokens not between 1 and 50000000 then
    raise exception 'Invalid budget reservation';
  end if;

  perform public.lock_ai_backend_budget(p_owner,p_backend_id);
  perform 1 from public.ai_backends backend
  where backend.id=p_backend_id and backend.owner=p_owner for update;
  if not found then
    return query select false,null::uuid,'backend_not_owned'::text,null::timestamptz;
    return;
  end if;

  update public.ai_backend_budget_leases lease
  set status='expired',finalized_at=now(),outcome_code='lease_expired'
  where lease.owner=p_owner and lease.backend_id=p_backend_id
    and lease.status='active' and lease.expires_at<=now();

  select * into v_existing from public.ai_backend_budget_leases lease
  where lease.owner=p_owner and lease.request_key=p_request_key for update;
  if found then
    if v_existing.backend_id=p_backend_id and v_existing.mode=v_mode
       and v_existing.reserved_tokens=p_reserved_tokens
       and v_existing.status='active' and v_existing.expires_at>now() then
      return query select true,v_existing.id,null::text,v_existing.expires_at;
    else
      return query select false,null::uuid,'duplicate_request_key'::text,null::timestamptz;
    end if;
    return;
  end if;

  select * into v_policy from public.ai_backend_budget_policies policy
  where policy.owner=p_owner and policy.backend_id=p_backend_id
    and policy.mode=v_mode for update;
  if not found then
    if v_mode in('agent_board','automation') then
      return query select false,null::uuid,'budget_policy_missing'::text,null::timestamptz;
    else
      -- Compatibility boundary: an absent manual policy preserves the existing
      -- interactive owner experience and creates no budget lease.
      return query select true,null::uuid,null::text,null::timestamptz;
    end if;
    return;
  end if;
  if not v_policy.enabled then
    return query select false,null::uuid,'budget_policy_disabled'::text,null::timestamptz;
    return;
  end if;

  select count(*)::integer into v_active
  from public.ai_backend_budget_leases lease
  where lease.owner=p_owner and lease.backend_id=p_backend_id
    and lease.mode=v_mode and lease.status='active' and lease.expires_at>now();
  if v_active>=v_policy.max_concurrent_leases then
    return query select false,null::uuid,'budget_concurrency_limit'::text,null::timestamptz;
    return;
  end if;

  insert into public.ai_backend_budget_usage(
    owner,backend_id,mode,window_kind,window_start
  ) values
    (p_owner,p_backend_id,v_mode,'day',v_day),
    (p_owner,p_backend_id,v_mode,'month',v_month)
  on conflict(owner,backend_id,mode,window_kind,window_start) do nothing;

  select * into v_day_usage from public.ai_backend_budget_usage usage
  where usage.owner=p_owner and usage.backend_id=p_backend_id
    and usage.mode=v_mode and usage.window_kind='day'
    and usage.window_start=v_day for update;
  select * into v_month_usage from public.ai_backend_budget_usage usage
  where usage.owner=p_owner and usage.backend_id=p_backend_id
    and usage.mode=v_mode and usage.window_kind='month'
    and usage.window_start=v_month for update;

  if v_day_usage.request_count+1>v_policy.daily_request_limit then
    return query select false,null::uuid,'budget_daily_request_limit'::text,null::timestamptz;
    return;
  end if;
  if v_month_usage.request_count+1>v_policy.monthly_request_limit then
    return query select false,null::uuid,'budget_monthly_request_limit'::text,null::timestamptz;
    return;
  end if;
  if v_day_usage.reserved_tokens+v_day_usage.actual_tokens+p_reserved_tokens
       >v_policy.daily_token_limit then
    return query select false,null::uuid,'budget_daily_token_limit'::text,null::timestamptz;
    return;
  end if;
  if v_month_usage.reserved_tokens+v_month_usage.actual_tokens+p_reserved_tokens
       >v_policy.monthly_token_limit then
    return query select false,null::uuid,'budget_monthly_token_limit'::text,null::timestamptz;
    return;
  end if;

  v_lease_id:=gen_random_uuid();
  v_expires:=now()+pg_catalog.make_interval(secs=>v_policy.lease_ttl_seconds);
  insert into public.ai_backend_budget_leases(
    id,request_key,owner,backend_id,mode,reserved_tokens,expires_at
  ) values(
    v_lease_id,p_request_key,p_owner,p_backend_id,v_mode,
    p_reserved_tokens,v_expires
  );
  update public.ai_backend_budget_usage usage
  set request_count=usage.request_count+1,
      reserved_tokens=usage.reserved_tokens+p_reserved_tokens,
      updated_at=now()
  where usage.owner=p_owner and usage.backend_id=p_backend_id
    and usage.mode=v_mode
    and ((usage.window_kind='day' and usage.window_start=v_day)
      or (usage.window_kind='month' and usage.window_start=v_month));

  return query select true,v_lease_id,null::text,v_expires;
end;
$$;

create or replace function public.finalize_ai_backend_budget(
  p_lease_id uuid,p_outcome text,p_actual_tokens bigint,
  p_provider_usage_reported boolean,p_outcome_code text default ''
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_identity record;
  v_lease public.ai_backend_budget_leases%rowtype;
  v_status text:=lower(pg_catalog.btrim(coalesce(p_outcome,'')));
  v_code text:=lower(pg_catalog.btrim(coalesce(p_outcome_code,'')));
  v_rows integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required';
  end if;
  if p_lease_id is null or v_status not in(
       'completed','provider_error','request_failed','cancelled'
     )
     or p_provider_usage_reported is null
     or char_length(v_code)>80
     or (p_provider_usage_reported and (
       p_actual_tokens is null or p_actual_tokens not between 0 and 1000000000
     ))
     or (not p_provider_usage_reported and p_actual_tokens is not null) then
    raise exception 'Invalid budget finalization';
  end if;

  select lease.owner,lease.backend_id into v_identity
  from public.ai_backend_budget_leases lease where lease.id=p_lease_id;
  if not found then return false; end if;
  perform public.lock_ai_backend_budget(v_identity.owner,v_identity.backend_id);
  select * into v_lease from public.ai_backend_budget_leases lease
  where lease.id=p_lease_id for update;
  if not found or v_lease.status<>'active' then return false; end if;
  if v_lease.expires_at<=now() then
    update public.ai_backend_budget_leases
    set status='expired',finalized_at=now(),outcome_code='lease_expired'
    where id=p_lease_id and status='active';
    return false;
  end if;

  if p_provider_usage_reported then
    update public.ai_backend_budget_usage usage
    set reserved_tokens=usage.reserved_tokens-v_lease.reserved_tokens,
        actual_tokens=usage.actual_tokens+p_actual_tokens,
        updated_at=now()
    where usage.owner=v_lease.owner and usage.backend_id=v_lease.backend_id
      and usage.mode=v_lease.mode and usage.reserved_tokens>=v_lease.reserved_tokens
      and (
        (usage.window_kind='day'
          and usage.window_start=pg_catalog.date_trunc(
            'day',pg_catalog.timezone('UTC',v_lease.created_at)
          ) at time zone 'UTC')
        or
        (usage.window_kind='month'
          and usage.window_start=pg_catalog.date_trunc(
            'month',pg_catalog.timezone('UTC',v_lease.created_at)
          ) at time zone 'UTC')
      );
    get diagnostics v_rows=row_count;
    if v_rows<>2 then
      raise exception 'Budget usage reservation is unavailable';
    end if;
  end if;

  update public.ai_backend_budget_leases
  set status=case when v_status='completed' then 'completed' else 'failed' end,
      actual_tokens=case when p_provider_usage_reported
        then p_actual_tokens else null end,
      provider_usage_reported=p_provider_usage_reported,
      outcome_code=v_code,
      finalized_at=now()
  where id=p_lease_id and status='active';
  return found;
end;
$$;

create or replace function public.guard_ai_backend_budget_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_month timestamptz:=pg_catalog.date_trunc(
    'month',pg_catalog.timezone('UTC',now())
  ) at time zone 'UTC';
begin
  -- DELETE already owns the backend row lock before a BEFORE trigger runs.
  -- Taking the advisory lock here would invert the claim/save order
  -- (advisory, then backend row) and permit a deadlock. The backend row itself
  -- serializes deletion against every claim and policy save.
  if exists(
    select 1 from public.ai_backend_budget_usage usage
    where usage.owner=old.owner and usage.backend_id=old.id
      and usage.window_kind='month' and usage.window_start=v_month
      and (usage.request_count>0 or usage.reserved_tokens>0
        or usage.actual_tokens>0)
  ) or exists(
    select 1 from public.ai_backend_budget_leases lease
    where lease.owner=old.owner and lease.backend_id=old.id
      and lease.status='active' and lease.expires_at>now()
  ) then
    raise exception 'AI backend has current budget usage and cannot be deleted until the monthly window closes';
  end if;
  return old;
end;
$$;

revoke all on function public.guard_ai_backend_budget_delete()
  from public,anon,authenticated,service_role;
drop trigger if exists guard_ai_backend_budget_delete on public.ai_backends;
create trigger guard_ai_backend_budget_delete
  before delete on public.ai_backends for each row
  execute function public.guard_ai_backend_budget_delete();

create or replace function public.purge_ai_backend_budget_retention(
  p_limit integer default 1000
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer:=least(greatest(coalesce(p_limit,1000),1),5000);
  v_count integer:=0;
  v_rows integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required';
  end if;
  with doomed as (
    select lease.id from public.ai_backend_budget_leases lease
    where lease.status<>'active'
      and lease.finalized_at<now()-interval '90 days'
    order by lease.finalized_at,lease.id limit v_limit
  )
  delete from public.ai_backend_budget_leases lease
  using doomed where lease.id=doomed.id;
  get diagnostics v_count=row_count;

  with doomed as (
    select usage.owner,usage.backend_id,usage.mode,
      usage.window_kind,usage.window_start
    from public.ai_backend_budget_usage usage
    where (usage.window_kind='day'
        and usage.window_start<now()-interval '62 days')
       or (usage.window_kind='month'
        and usage.window_start<now()-interval '400 days')
    order by usage.window_start,usage.owner,usage.backend_id,usage.mode
    limit v_limit
  )
  delete from public.ai_backend_budget_usage usage using doomed
  where usage.owner=doomed.owner and usage.backend_id=doomed.backend_id
    and usage.mode=doomed.mode and usage.window_kind=doomed.window_kind
    and usage.window_start=doomed.window_start;
  get diagnostics v_rows=row_count;
  return v_count+v_rows;
end;
$$;

create or replace function public.delete_ai_backend_budget_data_for_account_service(
  p_owner uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_backend_id uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051160)
  );
  for v_backend_id in
    select backend_id from (
      select backend.id as backend_id from public.ai_backends backend
      where backend.owner=p_owner
      union select policy.backend_id from public.ai_backend_budget_policies policy
      where policy.owner=p_owner
      union select usage.backend_id from public.ai_backend_budget_usage usage
      where usage.owner=p_owner
      union select lease.backend_id from public.ai_backend_budget_leases lease
      where lease.owner=p_owner
    ) owned order by backend_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_backend_id::text,51051161)
    );
  end loop;
  delete from public.ai_backend_budget_leases where owner=p_owner;
  delete from public.ai_backend_budget_usage where owner=p_owner;
  delete from public.ai_backend_budget_policies where owner=p_owner;
  return true;
end;
$$;

revoke all on function public.save_ai_backend_budget_policy(
  uuid,text,boolean,bigint,bigint,bigint,bigint,integer,integer
),public.my_ai_backend_budget_policies()
  from public,anon,authenticated,service_role;
revoke all on function public.claim_ai_backend_budget(
  uuid,uuid,text,bigint,uuid
),public.finalize_ai_backend_budget(uuid,text,bigint,boolean,text),
  public.purge_ai_backend_budget_retention(integer),
  public.delete_ai_backend_budget_data_for_account_service(uuid)
  from public,anon,authenticated,service_role;

grant execute on function public.save_ai_backend_budget_policy(
  uuid,text,boolean,bigint,bigint,bigint,bigint,integer,integer
),public.my_ai_backend_budget_policies()
  to authenticated;
grant execute on function public.claim_ai_backend_budget(
  uuid,uuid,text,bigint,uuid
),public.finalize_ai_backend_budget(uuid,text,bigint,boolean,text),
  public.purge_ai_backend_budget_retention(integer),
  public.delete_ai_backend_budget_data_for_account_service(uuid)
  to service_role;

comment on table public.ai_backend_budget_policies is
  'Owner AAL2 request/token ceilings by backend and mode. Automated modes default deny when no enabled policy exists.';
comment on table public.ai_backend_budget_usage is
  'Durable atomic daily/monthly request and token accounting. Browser and service direct DML are revoked.';
comment on table public.ai_backend_budget_leases is
  'Short-lived concurrent request reservations. Unknown or expired work retains its conservative token reservation.';
comment on function public.claim_ai_backend_budget(uuid,uuid,text,bigint,uuid) is
  'Service-only atomic claim. Missing agent_board/automation policies deny; missing manual policies preserve existing owner interaction.';
comment on function public.finalize_ai_backend_budget(uuid,text,bigint,boolean,text) is
  'Service-only exactly-once finalization. Reported provider usage replaces the reservation; unknown usage keeps it charged.';

commit;
