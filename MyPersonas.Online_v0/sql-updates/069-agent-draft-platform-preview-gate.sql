-- Durable exact-platform preview evidence for the general owner Queue.
--
-- public.drafts is used by native page review and provider-specific writers.
-- Approval now has to pass through a preview-aware wrapper that binds the
-- exact content hash to the exact native page or provider subject/channel.
begin;

alter table public.drafts
  add column if not exists approved_preview_version text not null default '',
  add column if not exists approved_preview_hash text not null default '',
  add column if not exists approved_preview_target_id text not null default '',
  add column if not exists approved_previewed_at timestamptz;

alter table public.drafts
  drop constraint if exists drafts_approved_preview_version_check,
  add constraint drafts_approved_preview_version_check check (
    approved_preview_version in ('','platform-preview-v1')
  ),
  drop constraint if exists drafts_approved_preview_hash_check,
  add constraint drafts_approved_preview_hash_check check (
    approved_preview_hash = '' or approved_preview_hash ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists drafts_approved_preview_target_check,
  add constraint drafts_approved_preview_target_check check (
    length(approved_preview_target_id) <= 500
  ),
  drop constraint if exists drafts_approved_preview_evidence_check,
  add constraint drafts_approved_preview_evidence_check check (
    (
      approved_preview_version = '' and approved_preview_hash = ''
      and approved_preview_target_id = '' and approved_previewed_at is null
    ) or (
      approved_preview_version <> '' and approved_preview_hash <> ''
      and approved_preview_target_id <> '' and approved_previewed_at is not null
    )
  );

create or replace function public.agent_draft_preview_hash(
  p_content_hash text,
  p_preview_version text,
  p_preview_target_id text
)
returns text
language sql stable set search_path = '' as $$
  select encode(extensions.digest(
    convert_to(jsonb_build_array(
      coalesce(p_content_hash,''),
      coalesce(p_preview_version,''),
      coalesce(p_preview_target_id,'')
    )::text,'UTF8'),
    'sha256'
  ),'hex');
$$;
revoke all on function public.agent_draft_preview_hash(text,text,text)
  from public, anon, authenticated;
grant execute on function public.agent_draft_preview_hash(text,text,text)
  to service_role;

create or replace function public.agent_draft_expected_preview_target(
  p_owner uuid,
  p_persona_id uuid,
  p_account_id uuid,
  p_platform text
)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_target text := '';
  v_provider text := lower(trim(coalesce(p_platform,'')));
begin
  if p_owner is null or p_persona_id is null then return ''; end if;
  if p_account_id is null then
    if public.normalize_agent_destination(p_platform) not in (
      'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
    ) then return ''; end if;
    return 'aliaspaces:' || p_persona_id::text;
  end if;

  select case
    when connection.connection_state = 'connected'
      and connection.provider = ledger.provider
      and nullif(trim(connection.provider_subject),'') is not null
      then trim(connection.provider_subject)
    else ''
  end into v_target
  from public.account_ledger ledger
  left join public.account_connections connection
    on connection.ledger_id = ledger.id and connection.owner = ledger.owner
  where ledger.id = p_account_id
    and ledger.owner = p_owner
    and ledger.persona_id = p_persona_id
    and (
      lower(ledger.provider) = v_provider
      or (lower(ledger.provider) = 'twitter' and v_provider = 'x')
      or (lower(ledger.provider) = 'wordpress' and v_provider in (
        'wordpress_com','wordpress_self_hosted'
      ))
    );
  return coalesce(v_target,'');
end;
$$;
revoke all on function public.agent_draft_expected_preview_target(
  uuid,uuid,uuid,text
) from public, anon, authenticated;
grant execute on function public.agent_draft_expected_preview_target(
  uuid,uuid,uuid,text
) to service_role;

create or replace function public.clear_agent_draft_preview_on_edit()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.approval_state <> 'approved'
    or old.title is distinct from new.title
    or old.body is distinct from new.body
    or old.tags is distinct from new.tags
    or old.media_url is distinct from new.media_url
    or old.content_kind is distinct from new.content_kind
    or old.persona_id is distinct from new.persona_id
    or old.account_id is distinct from new.account_id
    or old.platform is distinct from new.platform
    or old.publish_at is distinct from new.publish_at
    or old.approved_content_hash is distinct from new.approved_content_hash then
    new.approved_preview_version := '';
    new.approved_preview_hash := '';
    new.approved_preview_target_id := '';
    new.approved_previewed_at := null;
  end if;
  return new;
end;
$$;
revoke all on function public.clear_agent_draft_preview_on_edit()
  from public, anon, authenticated;

drop trigger if exists clear_agent_draft_preview_on_edit on public.drafts;
create trigger clear_agent_draft_preview_on_edit
  before update on public.drafts
  for each row execute function public.clear_agent_draft_preview_on_edit();

-- Deferred so the existing approval routine and preview evidence wrapper can
-- run in one transaction. Direct calls to the old routine fail at commit.
create or replace function public.assert_approved_agent_draft_preview()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_target text;
  v_expected text;
begin
  select * into v_draft from public.drafts where id = new.id;
  if not found or v_draft.approval_state <> 'approved' then return null; end if;
  if tg_op = 'UPDATE' then
    if old.publish_state = 'published' and old.approved_preview_version = '' then
      return null;
    end if;
  end if;
  v_target := public.agent_draft_expected_preview_target(
    v_draft.owner,v_draft.persona_id,v_draft.account_id,v_draft.platform
  );
  v_expected := public.agent_draft_preview_hash(
    v_draft.approved_content_hash,
    v_draft.approved_preview_version,
    v_draft.approved_preview_target_id
  );
  if v_target = ''
    or v_draft.approved_preview_version <> 'platform-preview-v1'
    or v_draft.approved_preview_target_id is distinct from v_target
    or v_draft.approved_previewed_at is null
    or v_draft.approved_previewed_at > clock_timestamp()
    or v_draft.approved_preview_hash = ''
    or v_draft.approved_preview_hash is distinct from v_expected then
    raise exception 'Approved drafts require a current exact-platform preview';
  end if;
  return null;
end;
$$;
revoke all on function public.assert_approved_agent_draft_preview()
  from public, anon, authenticated;

drop trigger if exists assert_approved_agent_draft_preview on public.drafts;
create constraint trigger assert_approved_agent_draft_preview
  after insert or update on public.drafts
  deferrable initially deferred
  for each row execute function public.assert_approved_agent_draft_preview();

create table if not exists public.agent_draft_preview_receipts (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid not null references public.drafts(id) on delete cascade,
  action text not null check (action in ('draft.approve','draft.approve_and_queue')),
  target_id text not null check (char_length(target_id) between 1 and 500),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  proposed_publish_at timestamptz not null,
  timezone text not null check (char_length(timezone) between 1 and 80),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  preview_payload jsonb not null check (jsonb_typeof(preview_payload) = 'object'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles(id) on delete set null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '5 minutes'),
  check (
    (acknowledged_at is null and acknowledged_by is null)
    or (acknowledged_at is not null and acknowledged_by is not null
      and acknowledged_at >= created_at and acknowledged_at < expires_at)
  )
);

-- A prior review build may already have created the receipt table before the
-- immutable display timezone was added. Backfill that non-production evidence
-- so reapplying this migration upgrades cleanly instead of leaving a function
-- that references a missing column.
alter table public.agent_draft_preview_receipts
  add column if not exists timezone text;
update public.agent_draft_preview_receipts
set timezone='UTC'
where timezone is null or trim(timezone)='';
alter table public.agent_draft_preview_receipts
  alter column timezone set not null,
  drop constraint if exists agent_draft_preview_receipts_timezone_check,
  add constraint agent_draft_preview_receipts_timezone_check check (
    char_length(timezone) between 1 and 80
  );

create index if not exists agent_draft_preview_receipts_current_idx
  on public.agent_draft_preview_receipts(owner,draft_id,created_at desc)
  where consumed_at is null and invalidated_at is null;
alter table public.agent_draft_preview_receipts enable row level security;
revoke all on public.agent_draft_preview_receipts from public, anon, authenticated;

create or replace function public.agent_draft_preview_snapshot(
  p_owner uuid,p_draft_id uuid,p_publish_at timestamptz,p_timezone text
)
returns table(
  content_hash text,target_id text,action text,
  proposed_publish_at timestamptz,preview_timezone text,preview_payload jsonb
)
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_target text;
  v_hash text;
  v_publish_at timestamptz;
  v_timezone text := trim(coalesce(p_timezone,''));
  v_auto_queue boolean := false;
  v_action text;
begin
  if char_length(v_timezone) not between 1 and 80
    or not exists(select 1 from pg_catalog.pg_timezone_names zone where zone.name=v_timezone) then
    raise exception 'Choose one valid immutable preview time zone';
  end if;
  select * into v_draft from public.drafts
  where id = p_draft_id and owner = p_owner for update;
  if not found then raise exception 'Owned draft not found'; end if;
  if v_draft.publish_state in ('publishing','published')
    or coalesce(v_draft.provider_post_id,'') <> '' then
    raise exception 'Publishing or published history cannot be approved again';
  end if;
  if v_draft.persona_id is null then raise exception 'Choose a persona before approval'; end if;
  select * into v_binding from public.agent_bindings
  where persona_id = v_draft.persona_id and owner = p_owner;
  if not found or v_binding.status <> 'active'
    or v_binding.claim_state not in ('self_attested','verified')
    or v_binding.autonomy_level < 2 then
    raise exception 'This persona must have an active, valid L2 or L3 agent before approval';
  end if;

  v_publish_at := coalesce(p_publish_at,v_draft.publish_at,now());
  v_target := public.agent_draft_expected_preview_target(
    p_owner,v_draft.persona_id,v_draft.account_id,v_draft.platform
  );
  if v_target = '' then
    raise exception 'The exact account or native page target is unavailable';
  end if;
  v_hash := public.agent_draft_hash(
    v_draft.title,v_draft.body,v_draft.tags,v_draft.media_url,
    v_draft.content_kind,v_draft.persona_id,v_draft.account_id,
    v_draft.platform,v_publish_at
  );
  v_auto_queue := v_binding.autonomy_level >= 3
    and v_draft.account_id is null
    and public.normalize_agent_destination(v_draft.platform) in (
      'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
    )
    and exists (
      select 1 from public.agent_destinations destination
      where destination.owner = p_owner and destination.binding_id = v_binding.id
        and destination.persona_id = v_draft.persona_id
        and destination.account_id is null and destination.enabled
        and destination.mode = 'auto'
        and public.normalize_agent_destination(destination.destination) in (
          'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
        )
        and v_draft.content_kind = any(destination.allowed_content_types)
    );
  v_action := case when v_auto_queue
    then 'draft.approve_and_queue' else 'draft.approve' end;

  content_hash := v_hash;
  target_id := v_target;
  action := v_action;
  proposed_publish_at := v_publish_at;
  preview_timezone := v_timezone;
  preview_payload := jsonb_build_object(
    'receiptVersion','agent-draft-preview-v1','draftId',v_draft.id,
    'provider',lower(trim(coalesce(v_draft.platform,''))),
    'action',v_action,'targetId',v_target,'contentHash',v_hash,'timezone',v_timezone,
    'items',jsonb_build_array(jsonb_build_object(
      'provider',lower(trim(coalesce(v_draft.platform,''))),
      'account',v_target,'accountId',v_target,
      'title',coalesce(v_draft.title,''),'text',coalesce(v_draft.body,''),
      'tags',coalesce(v_draft.tags,''),'mediaUrl',coalesce(v_draft.media_url,''),
      'mediaKind',coalesce(v_draft.content_kind,'post'),
      'scheduledFor',v_publish_at,'timezone',v_timezone,
      'mode',case when v_auto_queue then 'Approve and queue' else 'Approve for owner action' end,
      'timingLabel',case when v_auto_queue
        then 'Queued for the exact approved time' else 'No automatic provider write' end,
      'platformDetails',jsonb_build_array(
        'Exact target: ' || v_target,
        'Action: ' || v_action,
        'Content SHA-256: ' || v_hash
      )
    ))
  );
  return next;
end;
$$;
revoke all on function public.agent_draft_preview_snapshot(uuid,uuid,timestamptz,text)
  from public, anon, authenticated, service_role;

create or replace function public.issue_agent_draft_preview_receipt(
  p_draft_id uuid,p_publish_at timestamptz default null,p_timezone text default 'UTC'
)
returns table(
  receipt_id uuid,receipt_hash text,preview_payload jsonb,
  created_at timestamptz,expires_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_snapshot record;
  v_id uuid := gen_random_uuid();
  v_created timestamptz := clock_timestamp();
  v_expires timestamptz := v_created + interval '3 minutes';
  v_payload jsonb;
  v_hash text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select * into v_snapshot from public.agent_draft_preview_snapshot(
    v_owner,p_draft_id,p_publish_at,p_timezone
  );
  v_payload := v_snapshot.preview_payload || jsonb_build_object(
    'receiptId',v_id,'createdAt',v_created,'expiresAt',v_expires
  );
  v_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_id,v_owner,p_draft_id,v_snapshot.action,v_snapshot.target_id,
    v_snapshot.content_hash,v_snapshot.proposed_publish_at,v_snapshot.preview_timezone,
    v_payload,v_created,v_expires
  )::text,'UTF8'),'sha256'),'hex');
  v_payload := v_payload || jsonb_build_object('receiptHash',v_hash);
  update public.agent_draft_preview_receipts set invalidated_at = v_created
  where owner = v_owner and draft_id = p_draft_id
    and consumed_at is null and invalidated_at is null;
  insert into public.agent_draft_preview_receipts(
    id,owner,draft_id,action,target_id,content_hash,proposed_publish_at,timezone,
    receipt_hash,preview_payload,created_at,expires_at
  ) values (
    v_id,v_owner,p_draft_id,v_snapshot.action,v_snapshot.target_id,
    v_snapshot.content_hash,v_snapshot.proposed_publish_at,v_snapshot.preview_timezone,
    v_hash,v_payload,v_created,v_expires
  );
  receipt_id := v_id; receipt_hash := v_hash; preview_payload := v_payload;
  created_at := v_created; expires_at := v_expires;
  return next;
end;
$$;
revoke all on function public.issue_agent_draft_preview_receipt(uuid,timestamptz,text)
  from public, anon, authenticated, service_role;
grant execute on function public.issue_agent_draft_preview_receipt(uuid,timestamptz,text)
  to authenticated;

create or replace function public.acknowledge_agent_draft_preview_receipt(
  p_receipt_id uuid,p_draft_id uuid
)
returns table(
  receipt_id uuid,receipt_hash text,preview_payload jsonb,
  created_at timestamptz,expires_at timestamptz,acknowledged_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_receipt public.agent_draft_preview_receipts%rowtype;
  v_snapshot record;
  v_expected_hash text;
  v_now timestamptz := clock_timestamp();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select * into v_receipt from public.agent_draft_preview_receipts
  where id = p_receipt_id and owner = v_owner and draft_id = p_draft_id for update;
  if not found or v_receipt.consumed_at is not null
    or v_receipt.invalidated_at is not null or v_receipt.expires_at <= v_now
    or v_receipt.created_at > v_now then
    raise exception 'The server preview receipt is missing, expired, used, or invalidated';
  end if;
  select * into v_snapshot from public.agent_draft_preview_snapshot(
    v_owner,p_draft_id,v_receipt.proposed_publish_at,v_receipt.timezone
  );
  v_expected_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_receipt.id,v_receipt.owner,v_receipt.draft_id,v_receipt.action,
    v_receipt.target_id,v_receipt.content_hash,v_receipt.proposed_publish_at,v_receipt.timezone,
    v_receipt.preview_payload - 'receiptHash',v_receipt.created_at,v_receipt.expires_at
  )::text,'UTF8'),'sha256'),'hex');
  if v_receipt.action is distinct from v_snapshot.action
    or v_receipt.target_id is distinct from v_snapshot.target_id
    or v_receipt.content_hash is distinct from v_snapshot.content_hash
    or v_receipt.receipt_hash is distinct from v_expected_hash
    or v_receipt.preview_payload ->> 'receiptHash' is distinct from v_receipt.receipt_hash then
    raise exception 'The exact content, target, or action changed after preview';
  end if;
  if v_receipt.acknowledged_at is null then
    update public.agent_draft_preview_receipts as stored set
      acknowledged_at = v_now,acknowledged_by = v_owner
    where stored.id = v_receipt.id and stored.acknowledged_at is null
      and stored.consumed_at is null and stored.invalidated_at is null
    returning stored.* into v_receipt;
    if not found then raise exception 'The receipt changed before acknowledgement'; end if;
  elsif v_receipt.acknowledged_by is distinct from v_owner then
    raise exception 'The receipt was acknowledged by a different owner';
  end if;
  receipt_id := v_receipt.id; receipt_hash := v_receipt.receipt_hash;
  preview_payload := v_receipt.preview_payload; created_at := v_receipt.created_at;
  expires_at := v_receipt.expires_at; acknowledged_at := v_receipt.acknowledged_at;
  return next;
end;
$$;
revoke all on function public.acknowledge_agent_draft_preview_receipt(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_agent_draft_preview_receipt(uuid,uuid)
  to authenticated;

create or replace function public.consume_acknowledged_agent_draft_preview(
  p_receipt_id uuid,p_draft_id uuid
)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_receipt public.agent_draft_preview_receipts%rowtype;
  v_snapshot record;
  v_draft public.drafts%rowtype;
  v_expected_hash text;
  v_preview_hash text;
  v_now timestamptz := clock_timestamp();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select * into v_receipt from public.agent_draft_preview_receipts
  where id = p_receipt_id and owner = v_owner and draft_id = p_draft_id for update;
  if not found or v_receipt.acknowledged_at is null
    or v_receipt.acknowledged_by is distinct from v_owner
    or v_receipt.consumed_at is not null or v_receipt.invalidated_at is not null
    or v_receipt.expires_at <= v_now or v_receipt.created_at > v_now then
    raise exception 'A current AAL2-acknowledged server preview receipt is required';
  end if;
  select * into v_snapshot from public.agent_draft_preview_snapshot(
    v_owner,p_draft_id,v_receipt.proposed_publish_at,v_receipt.timezone
  );
  v_expected_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_receipt.id,v_receipt.owner,v_receipt.draft_id,v_receipt.action,
    v_receipt.target_id,v_receipt.content_hash,v_receipt.proposed_publish_at,v_receipt.timezone,
    v_receipt.preview_payload - 'receiptHash',v_receipt.created_at,v_receipt.expires_at
  )::text,'UTF8'),'sha256'),'hex');
  if v_receipt.action is distinct from v_snapshot.action
    or v_receipt.target_id is distinct from v_snapshot.target_id
    or v_receipt.content_hash is distinct from v_snapshot.content_hash
    or v_receipt.receipt_hash is distinct from v_expected_hash then
    raise exception 'The exact content, target, or action changed after acknowledgement';
  end if;
  update public.agent_draft_preview_receipts set consumed_at = v_now
  where id = v_receipt.id and consumed_at is null and invalidated_at is null
    and acknowledged_at is not null and acknowledged_by = v_owner;
  if not found then raise exception 'The preview receipt was already consumed'; end if;

  v_draft := public.approve_agent_draft(p_draft_id,v_receipt.proposed_publish_at);
  if (v_receipt.action = 'draft.approve_and_queue') is distinct from
      (v_draft.publish_state = 'queued') then
    raise exception 'The resulting queue action no longer matches the acknowledged preview';
  end if;
  v_preview_hash := public.agent_draft_preview_hash(
    v_draft.approved_content_hash,'platform-preview-v1',v_receipt.target_id
  );
  update public.drafts set
    approved_preview_version = 'platform-preview-v1',
    approved_preview_hash = v_preview_hash,
    approved_preview_target_id = v_receipt.target_id,
    approved_previewed_at = v_receipt.acknowledged_at
  where id = v_draft.id and owner = v_owner returning * into v_draft;
  if not found then raise exception 'The acknowledged draft could not be finalized'; end if;
  insert into public.agent_actions(
    owner,persona_id,action_type,entity_type,entity_id,outcome,detail
  ) values (
    v_owner,v_draft.persona_id,'draft.preview_receipt_consumed','draft',
    v_draft.id,'approved',jsonb_build_object(
      'receipt_id',v_receipt.id,'receipt_hash',v_receipt.receipt_hash,
      'action',v_receipt.action,'target_id',v_receipt.target_id,
      'content_hash',v_receipt.content_hash,'publish_at',v_receipt.proposed_publish_at,
      'timezone',v_receipt.timezone,
      'acknowledged_at',v_receipt.acknowledged_at
    )
  );
  return v_draft;
end;
$$;
revoke all on function public.consume_acknowledged_agent_draft_preview(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_acknowledged_agent_draft_preview(uuid,uuid)
  to authenticated;

-- Raw preview booleans and browser-supplied target identifiers are not an
-- authorization primitive. Remove the former wrapper completely.
drop function if exists public.approve_previewed_agent_draft(
  uuid,timestamptz,text,text
);

-- The preview-aware wrapper is the only owner approval route from now on.
revoke execute on function public.approve_agent_draft(uuid,timestamptz)
  from authenticated;

-- Do not claim that an active approval was previewed when it was not.
do $$
begin
  if exists (
    select 1 from public.drafts
    where approval_state = 'approved' and publish_state <> 'published'
  ) then
    raise exception 'Clear active draft approvals and review their platform previews before applying this migration';
  end if;
end;
$$;

commit;
