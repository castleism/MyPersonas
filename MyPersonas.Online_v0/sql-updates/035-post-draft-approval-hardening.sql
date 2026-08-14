-- 035-post-draft-approval-hardening.sql
-- Exact, owner-approved scheduling contract for the 3-part post_drafts queue.
-- Deploy the matching source first, then apply this in the coordinated maintenance
-- window documented in POST-QUEUE-ACTIVATION.md. The cron remains opt-in in
-- 036-schedule-post-queue.sql and must stay off until that checklist is complete.

begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.post_drafts
  add column if not exists approved_content_hash text not null default '',
  add column if not exists approved_timezone text not null default '',
  add column if not exists approved_facebook_page_id text not null default '',
  add column if not exists approved_instagram_business_id text not null default '',
  add column if not exists publish_claimed_at timestamptz,
  add column if not exists posted_at timestamptz,
  add column if not exists fb_published_at timestamptz,
  add column if not exists ig_published_at timestamptz;

-- Fail before changing privileges if old data needs an owner decision. Do not
-- silently invent a destination for an empty or unknown legacy target list.
do $$
declare v_invalid integer;
begin
  select count(*) into v_invalid from public.post_drafts
  where cardinality(targets) = 0
     or not (targets <@ array['facebook','instagram','twitter']::text[]);
  if v_invalid > 0 then
    raise exception 'Migration 035 preflight: % post_drafts row(s) have empty or unsupported targets; review them before applying', v_invalid;
  end if;
end $$;

alter table public.post_drafts drop constraint if exists post_drafts_targets_allowed_check;
alter table public.post_drafts add constraint post_drafts_targets_allowed_check
  check (
    cardinality(targets) > 0
    and targets <@ array['facebook','instagram','twitter']::text[]
  );

alter table public.post_drafts drop constraint if exists post_drafts_approval_hash_check;
alter table public.post_drafts add constraint post_drafts_approval_hash_check
  check (approved_content_hash = '' or char_length(approved_content_hash) = 64);

-- The old UI could set scheduled without an exact approval hash. The cron has
-- never been enabled, so return any such dormant rows to review rather than
-- grandfathering an unverifiable approval.
drop trigger if exists guard_post_draft_approval on public.post_drafts;
update public.post_drafts set
  status = 'draft', scheduled_for = null, approved_at = null, approved_by = null,
  approved_content_hash = '', approved_timezone = '',
  approved_facebook_page_id = '', approved_instagram_business_id = '',
  publish_claimed_at = null,
  last_error = 'Reapproval required after the exact-approval hardening migration.',
  updated_at = now()
where status = 'scheduled' and approved_content_hash = '';

-- Owners can read their rows through RLS, but every mutation now goes through a
-- reviewed SECURITY DEFINER RPC or an owner-scoped edge function. This protects
-- provider IDs, approval state, claims, and immutable publish history.
revoke insert, update, delete on table public.post_drafts from anon, authenticated;

create or replace function public.post_draft_hash(
  p_persona_id uuid,
  p_facebook_ledger_id text,
  p_targets text[],
  p_scheduled_for timestamptz,
  p_week_start date,
  p_timezone text,
  p_facebook_page_id text,
  p_instagram_business_id text,
  p_fb_caption text,
  p_ig_caption text,
  p_x_caption text,
  p_fb_image_url text,
  p_ig_image_url text,
  p_x_image_url text,
  p_source_image_url text
)
returns text
language sql stable set search_path = '' as $$
  select encode(extensions.digest(
    convert_to(jsonb_build_array(
      coalesce(p_persona_id::text,''),
      coalesce(p_facebook_ledger_id,''),
      coalesce((select jsonb_agg(lower(trim(target)) order by lower(trim(target)))
        from unnest(coalesce(p_targets,array[]::text[])) as target
      ),'[]'::jsonb),
      coalesce((extract(epoch from p_scheduled_for) * 1000000)::bigint,0),
      coalesce((p_week_start - date '1970-01-01')::integer,0),
      coalesce(p_timezone,''),
      coalesce(p_facebook_page_id,''), coalesce(p_instagram_business_id,''),
      coalesce(p_fb_caption,''), coalesce(p_ig_caption,''), coalesce(p_x_caption,''),
      coalesce(p_fb_image_url,''), coalesce(p_ig_image_url,''), coalesce(p_x_image_url,''),
      coalesce(p_source_image_url,'')
    )::text,'UTF8'),
    'sha256'
  ), 'hex');
$$;
revoke all on function public.post_draft_hash(uuid,text,text[],timestamptz,date,text,text,text,text,text,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.post_draft_hash(uuid,text,text[],timestamptz,date,text,text,text,text,text,text,text,text,text,text)
  to service_role;

-- Browser writes cannot bypass the owner RPC to schedule or alter a scheduled
-- exact draft. Service-role worker transitions and SECURITY DEFINER RPC writes
-- continue to work.
create or replace function public.guard_post_draft_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_hash text;
begin
  v_hash := public.post_draft_hash(
    new.persona_id, new.facebook_ledger_id, new.targets, new.scheduled_for,
    new.week_start, new.approved_timezone, new.approved_facebook_page_id,
    new.approved_instagram_business_id, new.fb_caption, new.ig_caption, new.x_caption,
    new.fb_image_url, new.ig_image_url, new.x_image_url, new.source_image_url
  );

  if new.status = 'scheduled' then
    if new.scheduled_for is null or new.approved_at is null
      or new.approved_by is distinct from new.owner
      or new.approved_content_hash = ''
      or new.approved_content_hash is distinct from v_hash then
      raise exception 'Scheduled drafts require an exact owner approval';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.status = 'scheduled' and new.status = 'scheduled'
    and v_hash is distinct from old.approved_content_hash then
    raise exception 'Approval no longer matches the draft content, target, or schedule';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_post_draft_approval()
  from public, anon, authenticated;

drop trigger if exists guard_post_draft_approval on public.post_drafts;
create trigger guard_post_draft_approval
  before insert or update on public.post_drafts
  for each row execute function public.guard_post_draft_approval();

create or replace function public.save_post_draft(
  p_draft_id uuid,
  p_fb_caption text,
  p_ig_caption text,
  p_x_caption text,
  p_targets text[]
)
returns public.post_drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.post_drafts%rowtype;
  v_targets text[];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select coalesce(array_agg(target order by target),array[]::text[]) into v_targets
  from (
    select distinct lower(trim(raw_target)) as target
    from unnest(coalesce(p_targets,array[]::text[])) as raw_target
    where trim(raw_target) <> ''
  ) normalized;
  if cardinality(v_targets) = 0
    or exists (select 1 from unnest(v_targets) target where target not in ('facebook','instagram','twitter')) then
    raise exception 'Choose at least one supported destination';
  end if;

  select * into v_draft from public.post_drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.status not in ('draft','approved','failed')
    or v_draft.fb_post_id is not null or v_draft.ig_media_id is not null
    or v_draft.x_tweet_id is not null then
    raise exception 'Scheduled, publishing, or published history cannot be edited';
  end if;

  update public.post_drafts set
    fb_caption = coalesce(p_fb_caption,''),
    ig_caption = coalesce(p_ig_caption,''),
    x_caption = coalesce(p_x_caption,''),
    targets = v_targets,
    status = 'draft',
    scheduled_for = null,
    approved_at = null,
    approved_by = null,
    approved_content_hash = '',
    approved_timezone = '',
    approved_facebook_page_id = '',
    approved_instagram_business_id = '',
    last_error = null,
    updated_at = now()
  where id = p_draft_id
  returning * into v_draft;

  insert into public.agent_actions (
    owner, persona_id, action_type, entity_type, entity_id, outcome, detail
  ) values (
    auth.uid(), v_draft.persona_id, 'post_draft.saved', 'post_draft',
    v_draft.id, 'ok', jsonb_build_object('targets',v_targets)
  );
  return v_draft;
end;
$$;
revoke all on function public.save_post_draft(uuid,text,text,text,text[])
  from public, anon;
grant execute on function public.save_post_draft(uuid,text,text,text,text[])
  to authenticated;

create or replace function public.approve_and_schedule_post_draft(
  p_draft_id uuid,
  p_scheduled_for timestamptz,
  p_timezone text,
  p_fb_caption text,
  p_ig_caption text,
  p_x_caption text,
  p_targets text[]
)
returns public.post_drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.post_drafts%rowtype;
  v_ledger public.account_ledger%rowtype;
  v_meta public.meta_page_connections%rowtype;
  v_targets text[];
  v_week_start date;
  v_hash text;
  v_now timestamptz := now();
  v_policy_key text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_scheduled_for is null or p_scheduled_for <= v_now then
    raise exception 'Choose a future publish time';
  end if;
  if trim(coalesce(p_timezone,'')) = ''
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'Choose a valid time zone';
  end if;

  select coalesce(array_agg(target order by target),array[]::text[]) into v_targets
  from (
    select distinct lower(trim(raw_target)) as target
    from unnest(coalesce(p_targets,array[]::text[])) as raw_target
    where trim(raw_target) <> ''
  ) normalized;
  if cardinality(v_targets) = 0
    or exists (select 1 from unnest(v_targets) target where target not in ('facebook','instagram','twitter')) then
    raise exception 'Choose at least one supported destination';
  end if;
  if 'twitter' = any(v_targets) then
    raise exception 'X scheduling is unavailable until its publisher is versioned and write-authorized';
  end if;
  if not ('facebook' = any(v_targets) or 'instagram' = any(v_targets)) then
    raise exception 'Choose Facebook or Instagram for this Meta-only schedule';
  end if;

  select * into v_draft from public.post_drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.persona_id is null or not exists (
    select 1 from public.personas
    where id = v_draft.persona_id and owner = auth.uid()
  ) then
    raise exception 'Choose an owned persona before scheduling';
  end if;
  if v_draft.status not in ('draft','approved','failed')
    or v_draft.fb_post_id is not null or v_draft.ig_media_id is not null
    or v_draft.x_tweet_id is not null then
    raise exception 'This draft can no longer be scheduled';
  end if;
  if v_draft.persona_id in (
    '56ebe05e-78c0-4dad-8e61-bcb7d245ab7b'::uuid,
    '288a472a-b286-43ae-b941-1731f406c23b'::uuid,
    'a997734c-9e47-4c05-bf55-0537a1c0ad97'::uuid
  ) then
    raise exception 'This adult cannabis persona is not eligible for Meta publishing';
  end if;
  if trim(coalesce(v_draft.facebook_ledger_id,'')) = '' then
    raise exception 'Choose a paired Facebook page before scheduling';
  end if;

  select * into v_ledger from public.account_ledger
    where id::text = v_draft.facebook_ledger_id
      and owner = auth.uid() and provider = 'facebook'
      and coalesce(suspended,false) = false;
  if not found then raise exception 'The selected Facebook page is unavailable'; end if;
  v_policy_key := regexp_replace(lower(concat_ws(' ',v_ledger.username,v_ledger.login_email,v_ledger.aliases)),'[^a-z0-9]+','','g');
  if v_policy_key like '%cannacandidz%' or v_policy_key like '%cannacandids%'
    or v_policy_key like '%sherlockchomes%'
    or v_policy_key like '%traditionalfamilyvalues%'
    or v_policy_key like '%tradfamilyvalues%' then
    raise exception 'This destination is blocked from Meta publishing by project policy';
  end if;

  select * into v_meta from public.meta_page_connections
    where owner = auth.uid() and facebook_ledger_id = v_ledger.id;
  if not found then raise exception 'The selected Facebook page is not paired with Meta'; end if;
  if trim(coalesce(v_meta.facebook_page_id::text,'')) = '' then
    raise exception 'The selected Meta pairing has no Facebook Page ID';
  end if;
  if 'instagram' = any(v_targets) and v_meta.instagram_business_id is null then
    raise exception 'The selected page has no linked professional Instagram account';
  end if;
  if 'facebook' = any(v_targets)
    and coalesce(nullif(v_draft.fb_image_url,''),nullif(v_draft.source_image_url,'')) is null then
    raise exception 'Facebook needs a public source image';
  end if;
  if 'instagram' = any(v_targets)
    and coalesce(nullif(v_draft.ig_image_url,''),nullif(v_draft.source_image_url,'')) is null then
    raise exception 'Instagram needs a public source image';
  end if;
  if 'facebook' = any(v_targets)
    and coalesce(nullif(v_draft.fb_image_url,''),nullif(v_draft.source_image_url,''))
      !~* '^https://[^[:space:]]+$' then
    raise exception 'Facebook needs a public HTTPS image';
  end if;
  if 'instagram' = any(v_targets)
    and coalesce(nullif(v_draft.ig_image_url,''),nullif(v_draft.source_image_url,''))
      !~* '^https://[^[:space:]]+$' then
    raise exception 'Instagram needs a public HTTPS image';
  end if;

  v_week_start := date_trunc('week',p_scheduled_for at time zone p_timezone)::date;
  v_hash := public.post_draft_hash(
    v_draft.persona_id, v_draft.facebook_ledger_id, v_targets,
    p_scheduled_for, v_week_start, p_timezone,
    v_meta.facebook_page_id::text,
    case when 'instagram' = any(v_targets)
      then coalesce(v_meta.instagram_business_id::text,'') else '' end,
    coalesce(p_fb_caption,''),
    coalesce(p_ig_caption,''), coalesce(p_x_caption,''),
    v_draft.fb_image_url, v_draft.ig_image_url, v_draft.x_image_url,
    v_draft.source_image_url
  );

  update public.post_drafts set
    fb_caption = coalesce(p_fb_caption,''),
    ig_caption = coalesce(p_ig_caption,''),
    x_caption = coalesce(p_x_caption,''),
    targets = v_targets,
    status = 'scheduled',
    scheduled_for = p_scheduled_for,
    week_start = v_week_start,
    approved_at = v_now,
    approved_by = auth.uid(),
    approved_content_hash = v_hash,
    approved_timezone = p_timezone,
    approved_facebook_page_id = v_meta.facebook_page_id::text,
    approved_instagram_business_id = case when 'instagram' = any(v_targets)
      then coalesce(v_meta.instagram_business_id::text,'') else '' end,
    last_error = null,
    publish_claimed_at = null,
    updated_at = v_now
  where id = p_draft_id
  returning * into v_draft;

  insert into public.agent_actions (
    owner, persona_id, action_type, entity_type, entity_id, outcome, detail
  ) values (
    auth.uid(), v_draft.persona_id, 'post_draft.scheduled', 'post_draft',
    v_draft.id, 'approved', jsonb_build_object(
      'scheduled_for',p_scheduled_for,'timezone',p_timezone,
      'week_start',v_week_start,'targets',v_targets,
      'facebook_ledger_id',v_draft.facebook_ledger_id,'content_hash',v_hash
    )
  );
  return v_draft;
end;
$$;
revoke all on function public.approve_and_schedule_post_draft(uuid,timestamptz,text,text,text,text,text[])
  from public, anon;
grant execute on function public.approve_and_schedule_post_draft(uuid,timestamptz,text,text,text,text,text[])
  to authenticated;

create or replace function public.unschedule_post_draft(p_draft_id uuid)
returns public.post_drafts
language plpgsql security definer set search_path = '' as $$
declare v_draft public.post_drafts%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.post_drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.status <> 'scheduled' then raise exception 'Only a scheduled draft can be unscheduled'; end if;

  update public.post_drafts set
    status = 'draft', scheduled_for = null, approved_at = null,
    approved_by = null, approved_content_hash = '', last_error = null,
    approved_timezone = '', approved_facebook_page_id = '',
    approved_instagram_business_id = '',
    publish_claimed_at = null, updated_at = now()
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, action_type, entity_type, entity_id, outcome, detail
  ) values (
    auth.uid(), v_draft.persona_id, 'post_draft.unscheduled', 'post_draft',
    v_draft.id, 'ok', '{}'::jsonb
  );
  return v_draft;
end;
$$;
revoke all on function public.unschedule_post_draft(uuid) from public, anon;
grant execute on function public.unschedule_post_draft(uuid) to authenticated;

create or replace function public.delete_post_draft(p_draft_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_draft public.post_drafts%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.post_drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then return false; end if;
  if v_draft.status not in ('draft','approved','failed')
    or v_draft.fb_post_id is not null or v_draft.ig_media_id is not null
    or v_draft.x_tweet_id is not null then
    raise exception 'Scheduled or published history cannot be deleted';
  end if;
  insert into public.agent_actions (
    owner, persona_id, action_type, entity_type, entity_id, outcome, detail
  ) values (
    auth.uid(), v_draft.persona_id, 'post_draft.deleted', 'post_draft',
    v_draft.id, 'ok', jsonb_build_object('status',v_draft.status)
  );
  delete from public.post_drafts where id = p_draft_id;
  return true;
end;
$$;
revoke all on function public.delete_post_draft(uuid) from public, anon;
grant execute on function public.delete_post_draft(uuid) to authenticated;

-- Claim only due rows whose owner's global automation switch is available and
-- on. Filtering before the small locked batch prevents a paused owner's backlog
-- from starving every other owner. The returned rows are the exact current rows
-- that the worker must validate and publish.
create or replace function public.claim_due_post_drafts(p_limit integer default 3)
returns setof public.post_drafts
language sql security definer set search_path = '' as $$
  with candidates as materialized (
    select d.id
    from public.post_drafts d
    join public.agent_owner_settings s on s.owner = d.owner
      and coalesce(s.automation_paused,false) = false
    where d.status = 'scheduled'
      and d.scheduled_for <= now()
    order by d.scheduled_for, d.id
    for update of d skip locked
    limit greatest(1,least(coalesce(p_limit,3),5))
  ), claimed as (
    update public.post_drafts d set
      status = 'publishing',
      publish_claimed_at = now(),
      updated_at = now()
    from candidates c
    where d.id = c.id and d.status = 'scheduled' and d.scheduled_for <= now()
    returning d.*
  )
  select * from claimed;
$$;
revoke all on function public.claim_due_post_drafts(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_post_drafts(integer) to service_role;

commit;
