-- 079-owner-push-subscription-foundation.sql
-- Owner-private push subscription ledger. Additive.
-- Delivery stays off. This checkout never sends APNs/FCM/Web Push,
-- never stores VAPID/server keys, and never requests notification
-- permission from the public PWA shell. Local source is not a linked apply.

begin;

create table if not exists public.owner_push_subscriptions (
  id uuid not null default gen_random_uuid() primary key,
  owner uuid not null,
  endpoint text not null default '',
  p256dh text not null default '',
  auth_secret text not null default '',
  platform text not null default 'web'
    check (platform in ('web','android','ios')),
  enabled boolean not null default false,
  delivery_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owner_push_subscriptions_endpoint_len check (char_length(endpoint) <= 2048),
  constraint owner_push_subscriptions_p256dh_len check (char_length(p256dh) <= 512),
  constraint owner_push_subscriptions_auth_len check (char_length(auth_secret) <= 512),
  constraint owner_push_subscriptions_delivery_off check (delivery_enabled = false)
);

create unique index if not exists owner_push_subscriptions_owner_endpoint_idx
  on public.owner_push_subscriptions (owner, endpoint);

alter table public.owner_push_subscriptions enable row level security;

drop policy if exists "owner all push subscriptions" on public.owner_push_subscriptions;
create policy "owner all push subscriptions" on public.owner_push_subscriptions
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

revoke all on table public.owner_push_subscriptions from public, anon, service_role;
grant select, delete on public.owner_push_subscriptions to authenticated;

create or replace function public.owner_push_delivery_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_count integer := 0;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select count(*) into v_count
  from public.owner_push_subscriptions sub
  where sub.owner = v_owner;
  return jsonb_build_object(
    'delivery_enabled', false,
    'permission_requested', false,
    'subscription_count', v_count,
    'reason', 'APNs/FCM/Web Push delivery is not installed. This checkout never sends notifications.'
  );
end;
$$;

create or replace function public.register_owner_push_subscription(
  p_endpoint text,
  p_p256dh text default '',
  p_auth_secret text default '',
  p_platform text default 'web'
)
returns public.owner_push_subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_row public.owner_push_subscriptions%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if char_length(coalesce(p_endpoint,'')) not between 12 and 2048
     or p_endpoint !~ '^https://'
     or char_length(coalesce(p_p256dh,'')) > 512
     or char_length(coalesce(p_auth_secret,'')) > 512
     or coalesce(p_platform,'web') not in ('web','android','ios') then
    raise exception 'Push subscription fields are invalid';
  end if;
  insert into public.owner_push_subscriptions (
    owner, endpoint, p256dh, auth_secret, platform, enabled, delivery_enabled, updated_at
  ) values (
    v_owner, p_endpoint, coalesce(p_p256dh,''), coalesce(p_auth_secret,''),
    coalesce(p_platform,'web'), false, false, now()
  )
  on conflict (owner, endpoint) do update
    set p256dh = excluded.p256dh,
        auth_secret = excluded.auth_secret,
        platform = excluded.platform,
        enabled = false,
        delivery_enabled = false,
        updated_at = now()
    where public.owner_push_subscriptions.owner = v_owner
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.revoke_owner_push_subscription(p_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  delete from public.owner_push_subscriptions sub
  where sub.id = p_subscription_id and sub.owner = v_owner;
  if not found then raise exception 'Owned push subscription not found'; end if;
  return true;
end;
$$;

comment on table public.owner_push_subscriptions is
  'Owner-private push endpoints only. delivery_enabled stays false. No provider send.';
comment on function public.owner_push_delivery_status() is
  'Always reports delivery_enabled=false. This is not a notification sender.';

revoke all on function public.owner_push_delivery_status() from public, anon, service_role;
revoke all on function public.register_owner_push_subscription(text,text,text,text) from public, anon, service_role;
revoke all on function public.revoke_owner_push_subscription(uuid) from public, anon, service_role;
grant execute on function public.owner_push_delivery_status() to authenticated;
grant execute on function public.register_owner_push_subscription(text,text,text,text) to authenticated;
grant execute on function public.revoke_owner_push_subscription(uuid) to authenticated;

commit;
