-- 077-mobile-private-draft-workflow.sql
-- Owner-authenticated mobile private draft creation. Additive.
-- publishing_enabled is constrained false. This RPC never posts, schedules a
-- provider send, changes OAuth scopes, or writes provider ids/URLs.
-- Apply only after reviewing 054 and 073. Local source is not a linked apply.

begin;

alter table public.persona_content_packages
  add column if not exists creation_source text not null default 'brief';
alter table public.persona_content_packages
  add column if not exists publishing_enabled boolean not null default false;
alter table public.persona_content_packages
  add column if not exists bound_targets jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'persona_content_packages_creation_source_check'
      and conrelid = 'public.persona_content_packages'::regclass
  ) then
    alter table public.persona_content_packages
      add constraint persona_content_packages_creation_source_check
      check (creation_source in ('brief','mobile_private'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'persona_content_packages_publishing_disabled_check'
      and conrelid = 'public.persona_content_packages'::regclass
  ) then
    alter table public.persona_content_packages
      add constraint persona_content_packages_publishing_disabled_check
      check (publishing_enabled = false);
  end if;
end $$;

create or replace function public.assert_owner_mobile_draft_bindings(
  p_owner uuid,p_persona_id uuid,p_bindings jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_channel text;
  v_item jsonb;
  v_ledger_id uuid;
  v_provider text;
  v_expected text[];
  v_row public.account_ledger%rowtype;
  v_normalized jsonb := '{}'::jsonb;
begin
  if p_bindings is null or jsonb_typeof(p_bindings) <> 'object' then
    raise exception 'Exact provider/account binding is required for every channel';
  end if;
  foreach v_channel in array array['x','instagram','facebook','website']::text[]
  loop
    v_item := p_bindings -> v_channel;
    if v_item is null or jsonb_typeof(v_item) <> 'object' then
      raise exception 'Exact provider/account binding is required for every channel';
    end if;
    begin
      v_ledger_id := nullif(v_item->>'ledger_id','')::uuid;
    exception when others then
      raise exception 'Exact provider/account binding is required for every channel';
    end;
    if v_ledger_id is null then
      raise exception 'Exact provider/account binding is required for every channel';
    end if;
    select * into v_row from public.account_ledger ledger
    where ledger.id = v_ledger_id
      and ledger.owner = p_owner
      and ledger.persona_id = p_persona_id
      and not ledger.suspended;
    if not found then
      raise exception 'Owned assigned account not found for %', v_channel;
    end if;
    v_expected := case v_channel
      when 'x' then array['x','twitter']::text[]
      when 'instagram' then array['instagram']::text[]
      when 'facebook' then array['facebook']::text[]
      else array['website','wix','wordpress','wordpress_com','wordpress_self_hosted']::text[]
    end;
    if not (lower(trim(v_row.provider)) = any(v_expected)) then
      raise exception 'Account provider does not match channel %', v_channel;
    end if;
    if coalesce(nullif(v_item->>'provider',''),'') <> ''
       and lower(trim(v_item->>'provider')) <> lower(trim(v_row.provider)) then
      raise exception 'Account provider does not match channel %', v_channel;
    end if;
    v_provider := lower(trim(v_row.provider));
    if (
      select count(*) from public.account_ledger ledger
      where ledger.owner = p_owner
        and ledger.persona_id = p_persona_id
        and not ledger.suspended
        and lower(trim(ledger.provider)) = any(v_expected)
    ) <> 1 then
      raise exception 'Exact one assigned account is required for %', v_channel;
    end if;
    v_normalized := v_normalized || jsonb_build_object(v_channel, jsonb_build_object(
      'ledger_id', v_row.id,
      'provider', v_provider
    ));
  end loop;
  return v_normalized;
end;
$$;

revoke all on function public.assert_owner_mobile_draft_bindings(uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.create_owner_mobile_private_draft(
  p_persona_id uuid,
  p_title text,
  p_owner_guidance text,
  p_timezone text,
  p_variants jsonb,
  p_bindings jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_package_id uuid;
  v_total integer;
  v_persona_total integer;
  v_existing_bytes bigint;
  v_incoming_bytes bigint;
  v_item jsonb;
  v_bindings jsonb;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if char_length(coalesce(p_title,'')) > 300
     or octet_length(coalesce(p_title,'')) > 1200
     or char_length(coalesce(p_owner_guidance,'')) > 6000
     or octet_length(coalesce(p_owner_guidance,'')) > 24000
     or char_length(coalesce(p_timezone,'')) not between 1 and 80
     or not exists(select 1 from pg_catalog.pg_timezone_names zone where zone.name = p_timezone) then
    raise exception 'Content package fields are invalid or too large';
  end if;
  perform public.assert_owner_content_variants(p_variants);
  perform public.lock_owner_research_content(v_owner);
  if not exists(
    select 1 from public.personas persona
    where persona.id = p_persona_id and persona.owner = v_owner
  ) then
    raise exception 'Owned persona not found';
  end if;
  v_bindings := public.assert_owner_mobile_draft_bindings(v_owner, p_persona_id, p_bindings);
  select count(*) into v_total from (
    select 1 from public.persona_content_packages package where package.owner = v_owner limit 1001
  ) bounded;
  if v_total >= 1000 then raise exception 'Content package storage limit reached (1000)'; end if;
  select count(*) into v_persona_total from (
    select 1 from public.persona_content_packages package
    where package.owner = v_owner and package.persona_id = p_persona_id limit 101
  ) bounded;
  if v_persona_total >= 100 then raise exception 'Persona content package limit reached (100)'; end if;
  select coalesce(sum(row_bytes),0) into v_existing_bytes from (
    select octet_length(package.title)+octet_length(package.owner_guidance)+coalesce((
      select sum(octet_length(variant.title)+octet_length(variant.body)+
        octet_length(variant.description)+octet_length(variant.alt_text)+
        octet_length(variant.media_plan::text))
      from public.persona_content_variants variant where variant.package_id = package.id
    ),0) as row_bytes
    from public.persona_content_packages package where package.owner = v_owner limit 1001
  ) bounded;
  v_incoming_bytes := octet_length(coalesce(p_title,''))+octet_length(coalesce(p_owner_guidance,''))+
    public.owner_content_variants_bytes(p_variants);
  if v_existing_bytes + v_incoming_bytes > 52428800 then
    raise exception 'Content package byte limit reached (52428800 bytes)';
  end if;
  perform public.reserve_owner_research_content_creation(v_owner, 'packages', 1);
  insert into public.persona_content_packages(
    owner, persona_id, source_brief_id, source_topic_ids, title, owner_guidance,
    status, scheduled_for, timezone, approval_hash, approved_at, approved_by, completed_at,
    creation_source, publishing_enabled, bound_targets
  ) values (
    v_owner, p_persona_id, null, '{}'::uuid[],
    coalesce(p_title,''), coalesce(p_owner_guidance,''), 'owner_review', null, p_timezone,
    '', null, null, null,
    'mobile_private', false, v_bindings
  ) returning id into v_package_id;
  for v_item in select value from jsonb_array_elements(p_variants)
  loop
    insert into public.persona_content_variants(
      owner, package_id, persona_id, channel, title, body, description, alt_text,
      media_plan, status, provider_id, provider_url
    ) values (
      v_owner, v_package_id, p_persona_id, v_item->>'channel',
      coalesce(v_item->>'title',''), v_item->>'body',
      coalesce(v_item->>'description',''), coalesce(v_item->>'alt_text',''),
      coalesce(v_item->'media_plan','[]'::jsonb), 'ready', '', ''
    );
  end loop;
  return v_package_id;
end;
$$;

comment on function public.create_owner_mobile_private_draft(uuid,text,text,text,jsonb,jsonb) is
  'Creates an owner-only four-channel private draft with exact ledger bindings. publishing_enabled stays false. Never posts.';

revoke all on function public.create_owner_mobile_private_draft(uuid,text,text,text,jsonb,jsonb)
  from public, anon, service_role;
grant execute on function public.create_owner_mobile_private_draft(uuid,text,text,text,jsonb,jsonb)
  to authenticated;

commit;
