\set ON_ERROR_STOP on

-- Narrow disposable-database prerequisites for migration 062. Migrations 059
-- and 060 are applied first by the harness; this fixture supplies only the
-- publication-review and Storage bucket shapes that 062 consumes directly.

create table storage.buckets (
  id text primary key,
  public boolean not null default false
);
insert into storage.buckets(id,public) values ('persona-media',true);
grant select,update on storage.buckets to service_role;

alter table public.personas
  add column nsfw boolean not null default false,
  add column visibility text not null default 'public',
  add column music_url text not null default '',
  add column live_url text not null default '';

alter table public.album_items
  add column link_url text not null default '';

create table public.persona_links (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id),
  url text not null default ''
);
create table public.persona_page_layouts (
  persona_id uuid primary key references public.personas(id),
  owner uuid not null,
  layout jsonb not null default '{"version":1,"order":[],"cards":{},"widgets":[]}'::jsonb
);
grant select,insert,update,delete on public.persona_links,
  public.persona_page_layouts to authenticated,service_role;
insert into public.persona_links(persona_id,url) values (
  '05900000-0000-4000-8000-000000000199',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/legacy-owner/reference.png'
);

-- Exact production predicate copied into the disposable fixture because 062
-- tightens existing 051 URL consumers without applying that very large prior
-- migration in this focused harness.
create or replace function public.is_safe_credential_free_https_url(
  p_value text,p_allow_empty boolean default false
)
returns boolean language plpgsql immutable set search_path='' as $$
declare
  v_url text:=coalesce(p_value,'');v_tail text;v_authority text;v_remainder text;
  v_host text;v_port_text text;v_label text;
begin
  if v_url='' then return p_allow_empty; end if;
  if v_url<>trim(v_url) or char_length(v_url)>2048
     or lower(left(v_url,8))<>'https://'
     or v_url~'[[:cntrl:][:space:]<>]' or position(chr(92) in v_url)>0 then
    return false;
  end if;
  v_tail:=substr(v_url,9);
  v_authority:=split_part(split_part(split_part(v_tail,'/',1),'?',1),'#',1);
  v_remainder:=substr(v_tail,char_length(v_authority)+1);
  if v_authority='' or position('@' in v_authority)>0
     or (v_remainder<>'' and left(v_remainder,1) not in ('/','?','#')) then
    return false;
  end if;
  if v_authority~':[0-9]+$' then
    v_port_text:=substring(v_authority from ':([0-9]+)$');
    v_host:=left(v_authority,char_length(v_authority)-char_length(v_port_text)-1);
    if char_length(v_port_text)>5 or v_port_text::integer not between 1 and 65535 then return false; end if;
  else
    v_host:=v_authority;
    if position(':' in v_host)>0 then return false; end if;
  end if;
  if char_length(v_host) not between 1 and 253
     or position('.' in v_host)=0
     or lower(v_host) in ('localhost','localhost.localdomain')
     or lower(v_host)~'\.(localhost|local|internal|lan)$'
     or v_host~'^[0-9.]+$'
     or v_host~*'^(?:[0-9]+|0x[0-9a-f]+)(?:\.(?:[0-9]+|0x[0-9a-f]+))+$'
     then return false; end if;
  if v_host!~'^[0-9.]+$' then
    foreach v_label in array string_to_array(v_host,'.') loop
      if char_length(v_label) not between 1 and 63
         or v_label!~'^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$' then return false; end if;
    end loop;
  end if;
  return true;
end;
$$;
revoke all on function public.is_safe_credential_free_https_url(text,boolean)
  from public,anon,authenticated;

create table public.affiliate_products (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  title text not null default '',merchant text not null default '',
  image_url text not null default '',affiliate_url text not null default '',
  product_url text not null default '',disclosure text not null default '',
  category text not null default '',status text not null default 'active',
  updated_at timestamptz not null default now()
);
create table public.persona_affiliate_offers (
  id uuid primary key default gen_random_uuid(),owner uuid not null,
  persona_id uuid not null,product_id uuid not null,
  cta_label text not null default '',placement text not null default '',
  priority integer not null default 0,status text not null default 'active'
);
grant select,insert,update,delete on public.affiliate_products,
  public.persona_affiliate_offers to authenticated,service_role;

create table public.persona_revenue_settings (
  persona_id uuid primary key references public.personas(id),
  owner uuid not null,
  affiliate_enabled boolean not null default false
);
grant select,insert,update,delete on public.persona_revenue_settings
  to authenticated,service_role;

create or replace function public.get_public_persona_revenue_rails(p_handle text)
returns table (
  persona_id uuid,affiliate_enabled boolean,review_requests_enabled boolean,
  default_disclosure text,cta_label text,review_cta_label text,offers jsonb
)
language sql security definer stable set search_path='' as $$
  select persona.id,false,false,''::text,''::text,''::text,'[]'::jsonb
  from public.personas persona where persona.handle=p_handle limit 1
$$;
grant execute on function public.get_public_persona_revenue_rails(text)
  to anon,authenticated;

create or replace function public.resolve_affiliate_redirect_service(
  p_offer_id uuid,p_source text,p_referrer_host text,
  p_utm_source text,p_utm_medium text,p_utm_campaign text,
  p_fingerprint_hash text,p_user_agent_hash text
)
returns table(affiliate_url text)
language sql security definer set search_path='' as $$
  select product.affiliate_url
  from public.persona_affiliate_offers offer
  join public.affiliate_products product
    on product.id=offer.product_id and product.owner=offer.owner
  where offer.id=p_offer_id and offer.status='active' and product.status='active'
$$;
grant execute on function public.resolve_affiliate_redirect_service(
  uuid,text,text,text,text,text,text,text
) to service_role;

create table public.persona_publication_reviews (
  persona_id uuid primary key,
  owner uuid not null,
  intention text not null default '',
  owner_review_notes text not null default '',
  readiness_snapshot jsonb not null default '{}'::jsonb,
  required_missing integer not null default 0,
  review_state text not null default 'draft',
  reviewed_revision integer not null default 0,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select,insert,update,delete on public.persona_publication_reviews
  to authenticated,service_role;

-- The production predicate is materially stricter. This small equivalent
-- isolates the exact revision/review checks needed by the 062 resolver; the
-- complete predicate remains covered by the application migration suite.
create or replace function public.persona_publication_is_current(pid uuid)
returns boolean language sql security definer stable set search_path='' as $$
  select exists (
    select 1
    from public.personas persona
    join public.persona_publication_reviews review
      on review.persona_id=persona.id and review.owner=persona.owner
    where persona.id=pid
      and persona.publication_state='published'
      and persona.published_revision=persona.publication_revision
      and review.review_state='published'
      and review.reviewed_revision=persona.publication_revision
  )
$$;
revoke all on function public.persona_publication_is_current(uuid)
  from public,anon,authenticated;

create or replace function public.persona_visible(pid uuid)
returns boolean language sql security definer stable set search_path='' as $$
  select exists(select 1 from public.personas persona where persona.id=pid and (
    persona.owner=auth.uid()
    or (persona.visibility in ('public','unlisted')
      and public.persona_publication_is_current(persona.id))
  ))
$$;
revoke all on function public.persona_visible(uuid) from public;
grant execute on function public.persona_visible(uuid) to anon,authenticated;
