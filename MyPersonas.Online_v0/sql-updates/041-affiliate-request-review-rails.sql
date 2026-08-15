-- ======================================================================
-- Migration 041: Affiliate + Request-Review Revenue Rails
-- Phase 3 of the Weekend Command Center Plan
--
-- Creates structured affiliate link tracking, click analytics, and a
-- public "Request Review" flow that routes into the existing post_drafts
-- human-approval gate.
--
-- NO payment processors. NO auto-publishing. Everything is owner-gated.
-- Covers ALL 28 personas.
-- ======================================================================

-- ======================================================================
-- 1. persona_revenue_settings — one row per persona
-- ======================================================================
create table if not exists public.persona_revenue_settings (
  persona_id    uuid not null references public.personas(id) on delete cascade,
  owner         uuid not null,
  affiliate_enabled      boolean not null default false,
  review_requests_enabled boolean not null default false,
  default_disclosure     text    not null default
    'As an affiliate, I may earn a commission from qualifying purchases. This does not affect the price you pay.',
  cta_label              text    not null default 'Get it here',
  review_cta_label       text    not null default 'Request a review',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (persona_id)
);

-- Seed settings for ALL existing personas (inactive by default — owner opts in)
insert into public.persona_revenue_settings (persona_id, owner)
select id, owner from public.personas
on conflict (persona_id) do nothing;

-- ======================================================================
-- 2. affiliate_partners — affiliate programs (Amazon, Etsy, etc.)
-- ======================================================================
create table if not exists public.affiliate_partners (
  id          uuid not null default gen_random_uuid() primary key,
  owner       uuid not null,
  name        text not null,
  program_url text not null default '',
  status      text not null default 'active' check (status in ('active','paused','inactive')),
  default_disclosure text not null default '',
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ======================================================================
-- 3. affiliate_products — individual products with affiliate URLs
-- ======================================================================
create table if not exists public.affiliate_products (
  id            uuid not null default gen_random_uuid() primary key,
  owner         uuid not null,
  partner_id    uuid references public.affiliate_partners(id) on delete set null,
  title         text not null,
  merchant      text not null default '',
  product_url   text not null default '',
  affiliate_url text not null,
  category      text not null default '',
  tags          text[] not null default '{}',
  status        text not null default 'draft' check (status in ('draft','active','paused','archived')),
  disclosure    text not null default '',
  image_url     text not null default '',
  price_note    text not null default '',
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ======================================================================
-- 4. persona_affiliate_offers — maps products to personas (M:N)
-- ======================================================================
create table if not exists public.persona_affiliate_offers (
  id          uuid not null default gen_random_uuid() primary key,
  owner       uuid not null,
  persona_id  uuid not null references public.personas(id) on delete cascade,
  product_id  uuid not null references public.affiliate_products(id) on delete cascade,
  placement   text not null default 'general' check (placement in ('general','bio','pinned_post','review_cta','album')),
  priority    int  not null default 50,
  cta_label   text not null default '',
  status      text not null default 'active' check (status in ('active','paused','inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (persona_id, product_id)
);

-- ======================================================================
-- 5. affiliate_click_events — anonymous click tracking
-- ======================================================================
create table if not exists public.affiliate_click_events (
  id          uuid not null default gen_random_uuid() primary key,
  owner       uuid not null,
  persona_id  uuid not null references public.personas(id) on delete cascade,
  offer_id    uuid references public.persona_affiliate_offers(id) on delete set null,
  product_id  uuid references public.affiliate_products(id) on delete set null,
  source      text not null default 'unknown',  -- bio_link, review_cta, album, pinned_post
  referrer    text not null default '',
  utm_source  text not null default '',
  utm_medium  text not null default '',
  utm_campaign text not null default '',
  ip_hash     text not null default '',  -- SHA-256 hash, never raw IP
  user_agent_hash text not null default '',
  created_at  timestamptz not null default now()
);

-- ======================================================================
-- 6. persona_review_requests — public review request queue
-- ======================================================================
create table if not exists public.persona_review_requests (
  id              uuid not null default gen_random_uuid() primary key,
  owner           uuid not null,
  persona_id      uuid not null references public.personas(id) on delete cascade,
  product_id      uuid references public.affiliate_products(id) on delete set null,
  requester_name  text not null default '',
  requester_email text not null default '',
  product_name    text not null,
  product_url     text not null default '',
  notes           text not null default '',
  status          text not null default 'new' check (status in
                    ('new','queued','drafted','owner_review','approved','rejected','archived')),
  post_draft_id   uuid,  -- linked to post_drafts(id) when a draft is generated
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Add review_request_id to post_drafts for reverse lookup
alter table public.post_drafts
  add column if not exists review_request_id uuid;

-- ======================================================================
-- Indexes
-- ======================================================================
create index if not exists idx_aff_offers_persona on public.persona_affiliate_offers(persona_id);
create index if not exists idx_aff_offers_product on public.persona_affiliate_offers(product_id);
create index if not exists idx_aff_offers_status on public.persona_affiliate_offers(status);
create index if not exists idx_aff_clicks_persona on public.affiliate_click_events(persona_id);
create index if not exists idx_aff_clicks_created on public.affiliate_click_events(created_at);
create index if not exists idx_review_req_persona on public.persona_review_requests(persona_id);
create index if not exists idx_review_req_status on public.persona_review_requests(status);
create index if not exists idx_review_req_owner on public.persona_review_requests(owner);
create index if not exists idx_aff_products_owner on public.affiliate_products(owner);
create index if not exists idx_aff_products_status on public.affiliate_products(status);
create index if not exists idx_revenue_settings_persona on public.persona_revenue_settings(persona_id);

-- ======================================================================
-- updated_at triggers
-- ======================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

do $$
declare t text;
begin
  for t in
    select unnest(array['persona_revenue_settings','affiliate_partners','affiliate_products',
                         'persona_affiliate_offers','persona_review_requests'])
  loop
    execute format('drop trigger if exists trg_%I_touch on public.%I', t, t);
    execute format(
      'create trigger trg_%I_touch before update on public.%I '
      'for each row execute function public.touch_updated_at()',
      t, t
    );
  end loop;
end $$;

-- ======================================================================
-- Row Level Security
-- ======================================================================
alter table public.persona_revenue_settings     enable row level security;
alter table public.affiliate_partners           enable row level security;
alter table public.affiliate_products           enable row level security;
alter table public.persona_affiliate_offers     enable row level security;
alter table public.affiliate_click_events       enable row level security;
alter table public.persona_review_requests      enable row level security;

-- Owner policies (full CRUD on own rows)
create policy "owner read revenue settings"   on public.persona_revenue_settings for select using (owner = auth.uid());
create policy "owner write revenue settings"  on public.persona_revenue_settings for all    using (owner = auth.uid()) with check (owner = auth.uid());

create policy "owner read partners"   on public.affiliate_partners for select using (owner = auth.uid());
create policy "owner write partners"  on public.affiliate_partners for all    using (owner = auth.uid()) with check (owner = auth.uid());

create policy "owner read products"   on public.affiliate_products for select using (owner = auth.uid());
create policy "owner write products"  on public.affiliate_products for all    using (owner = auth.uid()) with check (owner = auth.uid());

create policy "owner read offers"   on public.persona_affiliate_offers for select using (owner = auth.uid());
create policy "owner write offers"  on public.persona_affiliate_offers for all    using (owner = auth.uid()) with check (owner = auth.uid());

create policy "owner read clicks"   on public.affiliate_click_events for select using (owner = auth.uid());
create policy "owner write clicks"  on public.affiliate_click_events for insert with check (owner = auth.uid());

create policy "owner read requests"   on public.persona_review_requests for select using (owner = auth.uid());
create policy "owner write requests"  on public.persona_review_requests for all    using (owner = auth.uid()) with check (owner = auth.uid());

-- REMOVED public table read policies — all public access goes through
-- get_public_persona_revenue_rails() RPC, which returns offer_id only,
-- never the raw affiliate_url. This prevents bypassing the redirect endpoint.

-- ======================================================================
-- RPCs
-- ======================================================================

-- 1. get_public_persona_revenue_rails — public-facing data for persona pages
--    Returns active offers + settings for a given persona handle
create or replace function public.get_public_persona_revenue_rails(p_handle text)
returns table (
  persona_id uuid,
  affiliate_enabled boolean,
  review_requests_enabled boolean,
  default_disclosure text,
  cta_label text,
  review_cta_label text,
  offers jsonb
)
language sql security definer stable set search_path = '' as $$
  select
    p.id,
    rs.affiliate_enabled,
    rs.review_requests_enabled,
    rs.default_disclosure,
    rs.cta_label,
    rs.review_cta_label,
    case when rs.affiliate_enabled then
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'offer_id', o.id,
            'title', pr.title,
            'merchant', pr.merchant,
            'image_url', pr.image_url,
            'cta_label', coalesce(nullif(o.cta_label, ''), rs.cta_label),
            'placement', o.placement,
            'priority', o.priority,
            'disclosure', coalesce(nullif(pr.disclosure, ''), rs.default_disclosure),
            'category', pr.category
          ) order by o.priority desc
        ) filter (where pr.id is not null and o.id is not null),
        '[]'::jsonb
      )
    else '[]'::jsonb end as offers
  from public.personas p
  join public.persona_revenue_settings rs on rs.persona_id = p.id and rs.owner = p.owner
  left join public.persona_affiliate_offers o on o.persona_id = p.id and o.status = 'active' and o.owner = p.owner
  left join public.affiliate_products pr on pr.id = o.product_id and pr.status = 'active' and pr.owner = p.owner
  where p.handle = p_handle
  group by p.id, rs.affiliate_enabled, rs.review_requests_enabled,
           rs.default_disclosure, rs.cta_label, rs.review_cta_label;
$$;

-- 2. create_review_request — called ONLY by the request-review edge function
--    (service_role). NOT granted to anon/authenticated to prevent bypassing
--    the edge function's rate limiting.
create or replace function public.create_review_request(
  p_persona_handle text,
  p_product_name text,
  p_product_url text default '',
  p_requester_name text default '',
  p_requester_email text default '',
  p_notes text default ''
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_persona public.personas%rowtype;
  v_request_id uuid;
begin
  -- Look up persona by handle
  select * into v_persona from public.personas where handle = p_persona_handle;
  if not found then
    raise exception 'Persona not found';
  end if;

  -- Check review requests are enabled
  if not exists (
    select 1 from public.persona_revenue_settings
    where persona_id = v_persona.id and review_requests_enabled = true
  ) then
    raise exception 'Review requests are not enabled for this persona';
  end if;

  -- Validate required fields
  if length(trim(p_product_name)) < 2 then
    raise exception 'Product name is required (minimum 2 characters)';
  end if;
  if length(p_product_name) > 200 then
    raise exception 'Product name is too long (maximum 200 characters)';
  end if;
  if length(p_requester_name) > 100 then
    raise exception 'Requester name is too long (maximum 100 characters)';
  end if;
  if length(p_requester_email) > 200 then
    raise exception 'Requester email is too long (maximum 200 characters)';
  end if;
  if length(p_notes) > 2000 then
    raise exception 'Notes are too long (maximum 2000 characters)';
  end if;

  -- Validate URL format if provided
  if p_product_url <> '' and p_product_url !~ '^https?://' then
    raise exception 'Product URL must start with http:// or https://';
  end if;

  -- Insert the request
  insert into public.persona_review_requests (
    owner, persona_id, product_name, product_url,
    requester_name, requester_email, notes, status
  ) values (
    v_persona.owner, v_persona.id, trim(p_product_name), p_product_url,
    trim(p_requester_name), trim(p_requester_email), trim(p_notes), 'new'
  )
  returning id into v_request_id;

  return v_request_id;
end;
$$;

-- 3. owner_review_request_queue — owner's queue in Studio
create or replace function public.owner_review_request_queue()
returns table (
  id uuid,
  persona_id uuid,
  persona_name text,
  persona_handle text,
  product_name text,
  product_url text,
  requester_name text,
  requester_email text,
  notes text,
  status text,
  post_draft_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language sql security definer stable set search_path = '' as $$
  select
    r.id, r.persona_id, p.name, p.handle,
    r.product_name, r.product_url, r.requester_name, r.requester_email,
    r.notes, r.status, r.post_draft_id, r.created_at, r.updated_at
  from public.persona_review_requests r
  join public.personas p on p.id = r.persona_id
  where r.owner = auth.uid()
  order by
    case r.status when 'new' then 0 when 'queued' then 1 when 'drafted' then 2
                  when 'owner_review' then 3 else 4 end,
    r.created_at desc;
$$;

-- 4. record_affiliate_click — called by the affiliate-redirect edge function
create or replace function public.record_affiliate_click(
  p_persona_id uuid,
  p_offer_id uuid,
  p_source text,
  p_referrer text,
  p_utm_source text,
  p_utm_medium text,
  p_utm_campaign text,
  p_ip_hash text,
  p_user_agent_hash text
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_product_id uuid;
  v_persona_id uuid;
begin
  -- Get owner, product_id, and persona_id from the offer (not from caller)
  select o.owner, o.product_id, o.persona_id into v_owner, v_product_id, v_persona_id
  from public.persona_affiliate_offers o
  where o.id = p_offer_id and o.status = 'active';

  if not found then return; end if;

  insert into public.affiliate_click_events (
    owner, persona_id, offer_id, product_id,
    source, referrer, utm_source, utm_medium, utm_campaign,
    ip_hash, user_agent_hash
  ) values (
    v_owner, v_persona_id, p_offer_id, v_product_id,
    p_source, p_referrer, p_utm_source, p_utm_medium, p_utm_campaign,
    p_ip_hash, p_user_agent_hash
  );
end;
$$;

-- 5. link_review_request_to_draft — connect a review request to a post draft
create or replace function public.link_review_request_to_draft(
  p_request_id uuid,
  p_draft_id uuid
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_persona_id uuid;
  v_draft_owner uuid;
  v_draft_persona uuid;
begin
  select owner, persona_id into v_owner, v_persona_id
  from public.persona_review_requests where id = p_request_id;
  if v_owner is null then raise exception 'Review request not found'; end if;
  if v_owner <> auth.uid() then raise exception 'Not authorized'; end if;

  -- Verify draft exists, belongs to same owner, and same persona
  select owner, persona_id into v_draft_owner, v_draft_persona
  from public.post_drafts where id = p_draft_id;
  if v_draft_owner is null then raise exception 'Draft not found'; end if;
  if v_draft_owner <> v_owner then raise exception 'Draft belongs to a different owner'; end if;
  if v_draft_persona is not null and v_draft_persona <> v_persona_id then
    raise exception 'Draft belongs to a different persona';
  end if;

  update public.persona_review_requests
  set post_draft_id = p_draft_id, status = 'drafted', updated_at = now()
  where id = p_request_id;

  update public.post_drafts
  set review_request_id = p_request_id
  where id = p_draft_id and owner = v_owner;
end;
$$;

-- 6. update_review_request_status — owner updates request status
create or replace function public.update_review_request_status(
  p_request_id uuid,
  p_status text
)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('new','queued','drafted','owner_review','approved','rejected','archived') then
    raise exception 'Invalid status';
  end if;

  update public.persona_review_requests
  set status = p_status, updated_at = now()
  where id = p_request_id and owner = auth.uid();
end;
$$;

-- 7. get_affiliate_analytics — owner dashboard summary
create or replace function public.get_affiliate_analytics()
returns table (
  total_clicks bigint,
  total_requests bigint,
  new_requests bigint,
  active_offers bigint,
  clicks_by_persona jsonb,
  requests_by_status jsonb
)
language sql security definer stable set search_path = '' as $$
  with click_counts as (
    select persona_id, count(*) as cnt
    from public.affiliate_click_events
    where owner = auth.uid()
    group by persona_id
  ),
  request_counts as (
    select status, count(*) as cnt
    from public.persona_review_requests
    where owner = auth.uid()
    group by status
  )
  select
    (select count(*) from public.affiliate_click_events where owner = auth.uid()),
    (select count(*) from public.persona_review_requests where owner = auth.uid()),
    (select count(*) from public.persona_review_requests where owner = auth.uid() and status = 'new'),
    (select count(*) from public.persona_affiliate_offers where owner = auth.uid() and status = 'active'),
    coalesce((select jsonb_object_agg(persona_id::text, cnt) from click_counts), '{}'::jsonb),
    coalesce((select jsonb_object_agg(status, cnt) from request_counts), '{}'::jsonb);
$$;

-- ======================================================================
-- Grant permissions
-- ======================================================================
-- Public can call the rails RPC (for persona pages)
grant execute on function public.get_public_persona_revenue_rails(text) to anon, authenticated;

-- create_review_request is service_role ONLY — public submissions must go
-- through the request-review edge function (which has rate limiting)
grant execute on function public.create_review_request(text,text,text,text,text,text) to service_role;

-- Owner-only RPCs
grant execute on function public.owner_review_request_queue() to authenticated;
grant execute on function public.record_affiliate_click(uuid,uuid,text,text,text,text,text,text,text) to service_role;
grant execute on function public.link_review_request_to_draft(uuid,uuid) to authenticated;
grant execute on function public.update_review_request_status(uuid,text) to authenticated;
grant execute on function public.get_affiliate_analytics() to authenticated;

-- ======================================================================
-- Auto-create revenue settings for future personas
-- ======================================================================
create or replace function public.auto_create_persona_revenue_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.persona_revenue_settings (persona_id, owner)
  values (new.id, new.owner)
  on conflict (persona_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_auto_revenue_settings on public.personas;
create trigger trg_auto_revenue_settings
  after insert on public.personas
  for each row execute function public.auto_create_persona_revenue_settings();

-- ======================================================================
-- Additional indexes for FK lookups
-- ======================================================================
create index if not exists idx_post_drafts_review_req on public.post_drafts(review_request_id);
create index if not exists idx_review_req_draft on public.persona_review_requests(post_draft_id);

-- ======================================================================
-- Verification queries (run manually after migration)
-- ======================================================================
-- Verify all personas have revenue settings:
--   SELECT count(*) FROM persona_revenue_settings;
--   Should equal: SELECT count(*) FROM personas;
--
-- Verify tables exist:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND (table_name LIKE '%affiliate%' OR table_name LIKE '%review%');
--
-- Verify no public read policies on products/offers:
--   SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('affiliate_products','persona_affiliate_offers')
--     AND policyname LIKE 'public%';
--   Should return 0 rows.
