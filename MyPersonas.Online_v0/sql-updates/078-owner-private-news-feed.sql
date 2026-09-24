-- 078-owner-private-news-feed.sql
-- Owner-private sourced news-feed ledger. Additive.
-- This is not a social publisher. publishing_enabled stays false.
-- social_published stays false. ai/research is not deployed here.
-- Source/citation/freshness/feedback rules stay unapproved until the owner
-- reviews them in a later linked apply. Local source is not a linked apply.

begin;

create table if not exists public.persona_feed_source_rules (
  persona_id uuid not null references public.personas(id) on delete cascade,
  owner uuid not null,
  rules_approved boolean not null default false,
  allowed_hosts text[] not null default '{}'::text[],
  require_https_citations boolean not null default true,
  freshness_hours integer not null default 72
    check (freshness_hours between 1 and 720),
  max_items_per_day integer not null default 8
    check (max_items_per_day between 1 and 24),
  feedback_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (persona_id),
  constraint persona_feed_source_rules_owner_persona
    foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);

create table if not exists public.persona_feed_items (
  id uuid not null default gen_random_uuid() primary key,
  owner uuid not null,
  persona_id uuid not null references public.personas(id) on delete cascade,
  headline text not null default '',
  blurb text not null default '',
  citations jsonb not null default '[]'::jsonb,
  source_urls text[] not null default '{}'::text[],
  confidence numeric(4,3) not null default 0,
  evidence_hash text not null default '',
  status text not null default 'owner_review'
    check (status in ('owner_review','owner_visible','rejected','archived')),
  social_published boolean not null default false,
  publishing_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint persona_feed_items_headline_len check (char_length(headline) <= 200),
  constraint persona_feed_items_blurb_len check (char_length(blurb) <= 2000),
  constraint persona_feed_items_never_social_publish check (social_published = false),
  constraint persona_feed_items_publishing_disabled check (publishing_enabled = false),
  constraint persona_feed_items_owner_persona
    foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);

create index if not exists persona_feed_items_owner_created_idx
  on public.persona_feed_items (owner, created_at desc);
create index if not exists persona_feed_items_persona_created_idx
  on public.persona_feed_items (persona_id, created_at desc);

alter table public.persona_feed_source_rules enable row level security;
alter table public.persona_feed_items enable row level security;

drop policy if exists "owner all feed source rules" on public.persona_feed_source_rules;
create policy "owner all feed source rules" on public.persona_feed_source_rules
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists "owner read feed items" on public.persona_feed_items;
create policy "owner read feed items" on public.persona_feed_items
  for select to authenticated using (owner = auth.uid());

revoke all on table public.persona_feed_source_rules from public, anon, service_role;
revoke all on table public.persona_feed_items from public, anon, service_role;
grant select, insert, update, delete on public.persona_feed_source_rules to authenticated;
grant select on public.persona_feed_items to authenticated;

create or replace function public.list_owner_feed_items(p_persona_id uuid default null)
returns setof public.persona_feed_items
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  return query
  select item.*
  from public.persona_feed_items item
  where item.owner = v_owner
    and (p_persona_id is null or item.persona_id = p_persona_id)
  order by item.created_at desc
  limit 200;
end;
$$;

create or replace function public.save_owner_feed_source_rules(
  p_persona_id uuid,
  p_allowed_hosts text[] default '{}'::text[],
  p_freshness_hours integer default 72,
  p_max_items_per_day integer default 8
)
returns public.persona_feed_source_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_hosts text[] := '{}'::text[];
  v_host text;
  v_row public.persona_feed_source_rules%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.personas persona
    where persona.id = p_persona_id and persona.owner = v_owner
  ) then
    raise exception 'Owned persona not found';
  end if;
  if p_freshness_hours is null or p_freshness_hours < 1 or p_freshness_hours > 720
     or p_max_items_per_day is null or p_max_items_per_day < 1 or p_max_items_per_day > 24 then
    raise exception 'Feed source rule bounds are invalid';
  end if;
  foreach v_host in array coalesce(p_allowed_hosts, '{}'::text[])
  loop
    v_host := lower(trim(v_host));
    if v_host = '' or char_length(v_host) > 253 or v_host ~ '[/:]' or v_host like '% %' then
      raise exception 'Allowed hosts must be bare hostnames';
    end if;
    v_hosts := array_append(v_hosts, v_host);
  end loop;
  insert into public.persona_feed_source_rules (
    persona_id, owner, rules_approved, allowed_hosts, require_https_citations,
    freshness_hours, max_items_per_day, feedback_required, updated_at
  ) values (
    p_persona_id, v_owner, false, v_hosts, true,
    p_freshness_hours, p_max_items_per_day, true, now()
  )
  on conflict (persona_id) do update
    set allowed_hosts = excluded.allowed_hosts,
        freshness_hours = excluded.freshness_hours,
        max_items_per_day = excluded.max_items_per_day,
        rules_approved = false,
        require_https_citations = true,
        feedback_required = true,
        updated_at = now()
    where public.persona_feed_source_rules.owner = v_owner
  returning * into v_row;
  if not found then raise exception 'Owned persona not found'; end if;
  return v_row;
end;
$$;

create or replace function public.acknowledge_owner_feed_item(p_item_id uuid)
returns public.persona_feed_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_row public.persona_feed_items%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  update public.persona_feed_items item
  set status = 'owner_visible', updated_at = now()
  where item.id = p_item_id and item.owner = v_owner and item.status = 'owner_review'
  returning * into v_row;
  if not found then raise exception 'Owned feed item not found'; end if;
  return v_row;
end;
$$;

create or replace function public.reject_owner_feed_item(p_item_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  update public.persona_feed_items item
  set status = 'rejected', updated_at = now()
  where item.id = p_item_id and item.owner = v_owner
    and item.status in ('owner_review','owner_visible');
  if not found then raise exception 'Owned feed item not found'; end if;
  return true;
end;
$$;

create or replace function public.request_owner_feed_research(p_persona_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_rules public.persona_feed_source_rules%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.personas persona
    where persona.id = p_persona_id and persona.owner = v_owner
  ) then
    raise exception 'Owned persona not found';
  end if;
  select * into v_rules
  from public.persona_feed_source_rules rules
  where rules.persona_id = p_persona_id and rules.owner = v_owner;
  if not found or v_rules.rules_approved is not true then
    raise exception 'Source, citation, freshness, and feedback rules are not owner-approved';
  end if;
  raise exception 'ai/research is not deployed. This RPC never fetches URLs or writes social posts';
end;
$$;

comment on table public.persona_feed_items is
  'Owner-private research blurbs. Never a provider send. publishing_enabled stays false.';
comment on function public.request_owner_feed_research(uuid) is
  'Fail-closed research request. Does not fetch sources or publish.';

revoke all on function public.list_owner_feed_items(uuid) from public, anon, service_role;
revoke all on function public.save_owner_feed_source_rules(uuid,text[],integer,integer) from public, anon, service_role;
revoke all on function public.acknowledge_owner_feed_item(uuid) from public, anon, service_role;
revoke all on function public.reject_owner_feed_item(uuid) from public, anon, service_role;
revoke all on function public.request_owner_feed_research(uuid) from public, anon, service_role;
grant execute on function public.list_owner_feed_items(uuid) to authenticated;
grant execute on function public.save_owner_feed_source_rules(uuid,text[],integer,integer) to authenticated;
grant execute on function public.acknowledge_owner_feed_item(uuid) to authenticated;
grant execute on function public.reject_owner_feed_item(uuid) to authenticated;
grant execute on function public.request_owner_feed_research(uuid) to authenticated;

commit;
