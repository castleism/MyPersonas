-- Exact-platform preview gate for the legacy four-channel content-package flow.
--
-- Approval and manual scheduling are planning records only. They never call a
-- provider or enqueue an automatic publisher. A durable, owner-scoped receipt
-- binds the exact package, all four variant hashes, current target snapshot,
-- and proposed wall-clock instant before either state transition is allowed.
begin;

alter table public.persona_content_packages
  add column if not exists approved_preview_action text not null default '',
  add column if not exists approved_preview_version text not null default '',
  add column if not exists approved_preview_hash text not null default '',
  add column if not exists approved_preview_package_hash text not null default '',
  add column if not exists approved_preview_variant_hashes jsonb not null default '{}'::jsonb,
  add column if not exists approved_preview_target_hash text not null default '',
  add column if not exists approved_preview_targets jsonb not null default '{}'::jsonb,
  add column if not exists approved_preview_scheduled_for timestamptz,
  add column if not exists approved_preview_timezone text not null default '',
  add column if not exists approved_previewed_at timestamptz;

alter table public.persona_content_packages
  drop constraint if exists persona_content_packages_preview_evidence_check,
  add constraint persona_content_packages_preview_evidence_check check (
    (
      approved_preview_action = '' and approved_preview_version = ''
      and approved_preview_hash = '' and approved_preview_package_hash = ''
      and approved_preview_variant_hashes = '{}'::jsonb
      and approved_preview_target_hash = '' and approved_preview_targets = '{}'::jsonb
      and approved_preview_scheduled_for is null and approved_preview_timezone = ''
      and approved_previewed_at is null
    ) or (
      approved_preview_action in ('approve','manual_schedule')
      and approved_preview_version = 'content-package-preview-v1'
      and approved_preview_hash ~ '^[0-9a-f]{64}$'
      and approved_preview_package_hash ~ '^[0-9a-f]{64}$'
      and approved_preview_target_hash ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(approved_preview_variant_hashes) = 'object'
      and jsonb_array_length(jsonb_path_query_array(
        approved_preview_variant_hashes,'$.keyvalue()'
      )) = 4
      and jsonb_typeof(approved_preview_targets) = 'object'
      and jsonb_array_length(jsonb_path_query_array(
        approved_preview_targets,'$.keyvalue()'
      )) = 4
      and approved_preview_scheduled_for is not null
      and char_length(approved_preview_timezone) between 1 and 80
      and approved_previewed_at is not null
    )
  );

create table if not exists public.content_package_preview_receipts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  package_id uuid not null references public.persona_content_packages(id) on delete cascade,
  action text not null check (action in ('approve','manual_schedule')),
  preview_version text not null check (preview_version = 'content-package-preview-v1'),
  preview_hash text not null check (preview_hash ~ '^[0-9a-f]{64}$'),
  package_hash text not null check (package_hash ~ '^[0-9a-f]{64}$'),
  variant_hashes jsonb not null check (
    jsonb_typeof(variant_hashes) = 'object' and jsonb_array_length(
      jsonb_path_query_array(variant_hashes,'$.keyvalue()')
    ) = 4
  ),
  target_hash text not null check (target_hash ~ '^[0-9a-f]{64}$'),
  target_snapshot jsonb not null check (
    jsonb_typeof(target_snapshot) = 'object' and jsonb_array_length(
      jsonb_path_query_array(target_snapshot,'$.keyvalue()')
    ) = 4
  ),
  proposed_for timestamptz not null,
  timezone text not null check (char_length(timezone) between 1 and 80),
  previewed_at timestamptz not null default now(),
  preview_session_id text not null default '',
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  acknowledged_at timestamptz,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text not null default '' check (char_length(invalidation_reason) <= 200),
  foreign key (package_id, owner)
    references public.persona_content_packages(id, owner) on delete cascade
);

alter table public.content_package_preview_receipts
  add column if not exists preview_session_id text not null default '',
  add column if not exists expires_at timestamptz not null default (now() + interval '5 minutes'),
  add column if not exists acknowledged_at timestamptz,
  add column if not exists consumed_at timestamptz;

alter table public.content_package_preview_receipts
  drop constraint if exists content_package_preview_receipts_lifecycle_check,
  add constraint content_package_preview_receipts_lifecycle_check check (
    expires_at > previewed_at
    and (acknowledged_at is null or acknowledged_at >= previewed_at)
    and (consumed_at is null or (
      acknowledged_at is not null and consumed_at >= acknowledged_at
    ))
  );

create index if not exists content_package_preview_receipts_owner_idx
  on public.content_package_preview_receipts(owner, previewed_at desc);
create index if not exists content_package_preview_receipts_active_idx
  on public.content_package_preview_receipts(package_id, previewed_at desc)
  where invalidated_at is null and consumed_at is null;

alter table public.content_package_preview_receipts enable row level security;
drop policy if exists "owner read content package preview receipts"
  on public.content_package_preview_receipts;
create policy "owner read content package preview receipts"
  on public.content_package_preview_receipts for select to authenticated
  using (owner = (select auth.uid()));
revoke all on table public.content_package_preview_receipts
  from public, anon, authenticated, service_role;
grant select on table public.content_package_preview_receipts to authenticated;

create or replace function public.content_package_variant_hashes(p_package_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(
    variant.channel,
    encode(extensions.digest(convert_to(jsonb_build_array(
      variant.id::text,variant.channel,variant.title,variant.body,
      variant.description,variant.alt_text,variant.media_plan
    )::text,'UTF8'),'sha256'),'hex')
    order by variant.channel
  ),'{}'::jsonb)
  from public.persona_content_variants variant
  where variant.package_id = p_package_id;
$$;
revoke all on function public.content_package_variant_hashes(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.content_package_preview_package_hash(p_package_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select encode(extensions.digest(convert_to(jsonb_build_array(
    package.id::text,package.owner::text,package.persona_id::text,
    coalesce(package.source_brief_id::text,''),to_jsonb(package.source_topic_ids),
    package.title,package.owner_guidance,public.content_package_hash(package.id),
    public.content_package_variant_hashes(package.id)
  )::text,'UTF8'),'sha256'),'hex')
  from public.persona_content_packages package
  where package.id = p_package_id;
$$;
revoke all on function public.content_package_preview_package_hash(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.content_package_preview_targets(
  p_owner uuid,p_package_id uuid
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_persona_id uuid;
  v_channel text;
  v_candidates jsonb;
  v_candidate jsonb;
  v_count integer;
  v_provider text;
  v_target_id text;
  v_state text;
  v_label text;
  v_targets jsonb := '{}'::jsonb;
begin
  select package.persona_id into v_persona_id
  from public.persona_content_packages package
  where package.id=p_package_id and package.owner=p_owner;
  if not found then raise exception 'Owned content package not found'; end if;

  foreach v_channel in array array['x','instagram','facebook','website']::text[]
  loop
    select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object(
      'ledger_id',ledger.id::text,
      'provider',lower(trim(ledger.provider)),
      'account_label',coalesce(nullif(trim(ledger.username),''),
        nullif(trim(ledger.login_email),''),nullif(trim(ledger.url),''),
        lower(trim(ledger.provider)) || ' account'),
      'connection_state',coalesce(connection.connection_state,'disconnected'),
      'provider_subject',case when connection.connection_state='connected'
        and lower(trim(connection.provider))=lower(trim(ledger.provider))
        then coalesce(nullif(trim(connection.provider_subject),''),'') else '' end
    ) order by lower(trim(ledger.provider)),ledger.id),'[]'::jsonb)
    into v_count,v_candidates
    from public.account_ledger ledger
    left join public.account_connections connection
      on connection.ledger_id=ledger.id and connection.owner=ledger.owner
    where ledger.owner=p_owner and ledger.persona_id=v_persona_id
      and not ledger.suspended
      and case v_channel
        when 'x' then lower(trim(ledger.provider)) in ('x','twitter')
        when 'instagram' then lower(trim(ledger.provider))='instagram'
        when 'facebook' then lower(trim(ledger.provider))='facebook'
        else lower(trim(ledger.provider)) in (
          'website','wix','wordpress','wordpress_com','wordpress_self_hosted'
        )
      end;

    if v_count=1 then
      v_candidate:=v_candidates->0;
      v_provider:=case when v_channel='x' then 'twitter'
        else coalesce(nullif(v_candidate->>'provider',''),v_channel) end;
      v_target_id:=case when coalesce(v_candidate->>'provider_subject','')<>''
        then v_provider || ':' || (v_candidate->>'provider_subject')
        else 'ledger:' || (v_candidate->>'ledger_id') end;
      v_state:='determined';
      v_label:=v_candidate->>'account_label';
    elsif v_count=0 then
      v_provider:=case when v_channel='x' then 'twitter' else v_channel end;
      v_target_id:='manual:' || v_channel || ':unassigned';
      v_state:='unassigned';
      v_label:='No assigned account · manual handoff';
    else
      v_provider:=case when v_channel='x' then 'twitter' else v_channel end;
      v_target_id:='manual:' || v_channel || ':ambiguous:' ||
        encode(extensions.digest(convert_to(v_candidates::text,'UTF8'),'sha256'),'hex');
      v_state:='ambiguous';
      v_label:=v_count::text || ' assigned accounts · choose in the provider portal';
    end if;

    v_targets:=v_targets || jsonb_build_object(v_channel,jsonb_build_object(
      'channel',v_channel,'preview_provider',v_provider,'state',v_state,
      'target_id',v_target_id,'account_label',v_label,
      'determinable',v_count=1,'candidates',v_candidates
    ));
  end loop;
  return v_targets;
end;
$$;
revoke all on function public.content_package_preview_targets(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.content_package_preview_snapshot_for_owner(
  p_owner uuid,p_package_id uuid,p_action text,
  p_scheduled_for timestamptz,p_timezone text
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_package public.persona_content_packages%rowtype;
  v_targets jsonb;
  v_target_hash text;
  v_variant_hashes jsonb;
  v_package_hash text;
  v_variants jsonb;
  v_preview_hash text;
  v_time_key text;
  v_count integer;
  v_channels text[];
begin
  if p_owner is null then raise exception 'Owner is required'; end if;
  if p_action not in ('approve','manual_schedule') then
    raise exception 'Unsupported content-package preview action';
  end if;
  if p_scheduled_for is null or p_scheduled_for<=now()
     or p_scheduled_for>now()+interval '5 years'
     or char_length(coalesce(p_timezone,'')) not between 1 and 80
     or not exists(select 1 from pg_catalog.pg_timezone_names zone where zone.name=p_timezone) then
    raise exception 'Choose a valid future proposed time and time zone';
  end if;
  select * into v_package from public.persona_content_packages package
  where package.id=p_package_id and package.owner=p_owner;
  if not found then raise exception 'Owned content package not found'; end if;
  select count(*),array_agg(variant.channel order by variant.channel)
  into v_count,v_channels from public.persona_content_variants variant
  where variant.package_id=p_package_id and variant.owner=p_owner
    and variant.body<>'' and variant.provider_id='' and variant.provider_url='';
  if v_count<>4 or v_channels is distinct from
     array['facebook','instagram','website','x']::text[] then
    raise exception 'A complete unposted X, Instagram, Facebook, and website kit is required';
  end if;

  v_targets:=public.content_package_preview_targets(p_owner,p_package_id);
  if p_action='manual_schedule' and exists(
    select 1 from jsonb_each(v_targets) target
    where coalesce((target.value->>'determinable')::boolean,false) is not true
  ) then
    raise exception 'Choose one exact account or site for every platform before placing this kit on the manual schedule';
  end if;
  if p_action='manual_schedule' and exists(
    select 1
    from public.persona_content_variants variant
    cross join lateral jsonb_array_elements(variant.media_plan) media
    where variant.package_id=p_package_id and variant.owner=p_owner
      and trim(coalesce(media->>'source_url',''))=''
  ) then
    raise exception 'Attach every planned media asset before placing this kit on the manual schedule';
  end if;
  v_target_hash:=encode(extensions.digest(convert_to(v_targets::text,'UTF8'),'sha256'),'hex');
  v_variant_hashes:=public.content_package_variant_hashes(p_package_id);
  v_package_hash:=public.content_package_preview_package_hash(p_package_id);
  select jsonb_agg(jsonb_build_object(
    'id',variant.id::text,'channel',variant.channel,
    'preview_provider',v_targets->variant.channel->>'preview_provider',
    'account_label',v_targets->variant.channel->>'account_label',
    'target_id',v_targets->variant.channel->>'target_id',
    'target_state',v_targets->variant.channel->>'state',
    'target_determinable',(v_targets->variant.channel->>'determinable')::boolean,
    'title',variant.title,'body',variant.body,'description',variant.description,
    'alt_text',variant.alt_text,'media_plan',variant.media_plan,
    'variant_hash',v_variant_hashes->>variant.channel
  ) order by case variant.channel
    when 'x' then 1 when 'instagram' then 2 when 'facebook' then 3 else 4 end)
  into v_variants
  from public.persona_content_variants variant
  where variant.package_id=p_package_id and variant.owner=p_owner;
  v_time_key:=to_char(p_scheduled_for at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  v_preview_hash:=encode(extensions.digest(convert_to(jsonb_build_array(
    'content-package-preview-v1',p_action,p_package_id::text,v_package_hash,
    v_variant_hashes,v_target_hash,v_targets,v_time_key,p_timezone
  )::text,'UTF8'),'sha256'),'hex');
  return jsonb_build_object(
    'version','content-package-preview-v1','action',p_action,
    'package_id',p_package_id::text,'package_title',v_package.title,
    'package_hash',v_package_hash,'variant_hashes',v_variant_hashes,
    'target_hash',v_target_hash,'targets',v_targets,
    'proposed_for',p_scheduled_for,'timezone',p_timezone,
    'preview_hash',v_preview_hash,'variants',v_variants
  );
end;
$$;
revoke all on function public.content_package_preview_snapshot_for_owner(
  uuid,uuid,text,timestamptz,text
) from public, anon, authenticated, service_role;

create or replace function public.content_package_preview_snapshot(
  p_package_id uuid,p_action text,p_scheduled_for timestamptz,p_timezone text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_package public.persona_content_packages%rowtype;
  v_hash text;
  v_snapshot jsonb;
  v_receipt_id uuid;
  v_now timestamptz:=clock_timestamp();
  v_expires_at timestamptz:=v_now + interval '5 minutes';
  v_session_id text:=coalesce(auth.jwt()->>'session_id','');
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select * into v_package from public.persona_content_packages package
  where package.id=p_package_id and package.owner=v_owner;
  if not found then raise exception 'Owned content package not found'; end if;
  if p_action='approve' then
    if v_package.status<>'owner_review' or exists(
      select 1 from public.persona_content_variants variant
      where variant.package_id=p_package_id and variant.owner=v_owner
        and variant.status not in ('draft','ready')
    ) then raise exception 'Only a complete owner-review kit can be previewed for approval'; end if;
  elsif p_action='manual_schedule' then
    v_hash:=public.content_package_hash(p_package_id);
    if v_package.status<>'approved' or v_package.approval_hash='' or
       v_package.approval_hash is distinct from v_hash or exists(
        select 1 from public.persona_content_variants variant
        where variant.package_id=p_package_id and variant.owner=v_owner
          and variant.status<>'approved'
       ) then raise exception 'Approve the unchanged exact kit before previewing its manual schedule'; end if;
  else raise exception 'Unsupported content-package preview action';
  end if;
  v_snapshot:=public.content_package_preview_snapshot_for_owner(
    v_owner,p_package_id,p_action,p_scheduled_for,p_timezone
  );
  update public.content_package_preview_receipts set
    invalidated_at=v_now,invalidation_reason='superseded by a newer prepared preview'
  where package_id=p_package_id and owner=v_owner and action=p_action
    and invalidated_at is null and consumed_at is null;
  insert into public.content_package_preview_receipts(
    owner,package_id,action,preview_version,preview_hash,package_hash,
    variant_hashes,target_hash,target_snapshot,proposed_for,timezone,
    previewed_at,preview_session_id,expires_at
  ) values(
    v_owner,p_package_id,p_action,v_snapshot->>'version',
    v_snapshot->>'preview_hash',v_snapshot->>'package_hash',
    v_snapshot->'variant_hashes',v_snapshot->>'target_hash',
    v_snapshot->'targets',p_scheduled_for,p_timezone,v_now,v_session_id,v_expires_at
  ) returning id into v_receipt_id;
  return v_snapshot||jsonb_build_object(
    'receipt_id',v_receipt_id,'prepared_at',v_now,'expires_at',v_expires_at
  );
end;
$$;
revoke all on function public.content_package_preview_snapshot(
  uuid,text,timestamptz,text
) from public, anon, authenticated, service_role;
grant execute on function public.content_package_preview_snapshot(
  uuid,text,timestamptz,text
) to authenticated;

create or replace function public.acknowledge_content_package_preview(
  p_receipt_id uuid,p_package_id uuid,p_action text,
  p_scheduled_for timestamptz,p_timezone text,p_preview_version text,
  p_preview_hash text,p_target_hash text,p_variant_hashes jsonb
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_receipt public.content_package_preview_receipts%rowtype;
  v_snapshot jsonb;
  v_now timestamptz:=clock_timestamp();
  v_session_id text:=coalesce(auth.jwt()->>'session_id','');
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  select * into v_receipt
  from public.content_package_preview_receipts receipt
  where receipt.id=p_receipt_id and receipt.owner=v_owner for update;
  if not found then raise exception 'Prepared content-package preview receipt was not found'; end if;
  if v_receipt.invalidated_at is not null then
    raise exception 'That content-package preview was invalidated; open a fresh preview';
  end if;
  if v_receipt.expires_at<=v_now then
    raise exception 'That content-package preview expired; open a fresh preview';
  end if;
  if v_receipt.acknowledged_at is not null or v_receipt.consumed_at is not null then
    raise exception 'That content-package preview was already acknowledged or consumed';
  end if;
  if v_receipt.preview_session_id is distinct from v_session_id then
    raise exception 'The authenticated session changed after preview; open a fresh preview';
  end if;
  v_snapshot:=public.content_package_preview_snapshot_for_owner(
    v_owner,p_package_id,p_action,p_scheduled_for,p_timezone
  );
  if row(v_receipt.package_id,v_receipt.action,v_receipt.preview_version,
         v_receipt.preview_hash,v_receipt.target_hash,v_receipt.proposed_for,
         v_receipt.timezone)
     is distinct from row(p_package_id,p_action,p_preview_version,
         p_preview_hash,p_target_hash,p_scheduled_for,p_timezone)
     or v_receipt.variant_hashes is distinct from p_variant_hashes
     or v_snapshot->>'version' is distinct from p_preview_version
     or v_snapshot->>'preview_hash' is distinct from p_preview_hash
     or v_snapshot->>'target_hash' is distinct from p_target_hash
     or v_snapshot->'variant_hashes' is distinct from p_variant_hashes
     or v_snapshot->>'package_hash' is distinct from v_receipt.package_hash
     or v_snapshot->'targets' is distinct from v_receipt.target_snapshot then
    raise exception 'Content, media, target, or proposed time changed after preview; review it again';
  end if;
  update public.content_package_preview_receipts receipt
  set acknowledged_at=v_now
  where receipt.id=p_receipt_id and receipt.owner=v_owner
    and receipt.acknowledged_at is null and receipt.consumed_at is null
    and receipt.invalidated_at is null and receipt.expires_at>v_now;
  if not found then raise exception 'The content-package preview could not be acknowledged atomically'; end if;
  return jsonb_build_object(
    'receipt_id',p_receipt_id,'acknowledged_at',v_now,
    'expires_at',v_receipt.expires_at,'preview_hash',p_preview_hash
  );
end;
$$;
revoke all on function public.acknowledge_content_package_preview(
  uuid,uuid,text,timestamptz,text,text,text,text,jsonb
) from public,anon,authenticated,service_role;
grant execute on function public.acknowledge_content_package_preview(
  uuid,uuid,text,timestamptz,text,text,text,text,jsonb
) to authenticated;

drop function if exists public.commit_content_package_preview(
  uuid,text,timestamptz,text,text,text,text,jsonb
);
create or replace function public.commit_content_package_preview(
  p_receipt_id uuid,p_package_id uuid,p_action text,p_scheduled_for timestamptz,p_timezone text,
  p_preview_version text,p_preview_hash text,p_target_hash text,
  p_variant_hashes jsonb
)
returns public.persona_content_packages
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid:=auth.uid();
  v_package public.persona_content_packages%rowtype;
  v_receipt public.content_package_preview_receipts%rowtype;
  v_snapshot jsonb;
  v_content_hash text;
  v_now timestamptz:=now();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if p_preview_version<>'content-package-preview-v1'
     or coalesce(p_preview_hash,'') !~ '^[0-9a-f]{64}$'
     or coalesce(p_target_hash,'') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(coalesce(p_variant_hashes,'null'::jsonb))<>'object' then
    raise exception 'Review the current exact platform previews before continuing';
  end if;
  perform public.lock_owner_research_content(v_owner);
  select * into v_receipt
  from public.content_package_preview_receipts receipt
  where receipt.id=p_receipt_id and receipt.owner=v_owner for update;
  if not found then raise exception 'Acknowledged content-package preview receipt was not found'; end if;
  if v_receipt.invalidated_at is not null or v_receipt.expires_at<=v_now
     or v_receipt.acknowledged_at is null or v_receipt.consumed_at is not null then
    raise exception 'A current separately acknowledged content-package preview is required';
  end if;
  if v_receipt.preview_session_id is distinct from coalesce(auth.jwt()->>'session_id','') then
    raise exception 'The authenticated session changed after preview; open a fresh preview';
  end if;
  select * into v_package from public.persona_content_packages package
  where package.id=p_package_id and package.owner=v_owner for update;
  if not found then raise exception 'Owned content package not found'; end if;
  if p_action='approve' then
    if v_package.status<>'owner_review' or exists(
      select 1 from public.persona_content_variants variant
      where variant.package_id=p_package_id and variant.owner=v_owner
        and variant.status not in ('draft','ready')
    ) then raise exception 'Only a complete owner-review kit can be approved'; end if;
  elsif p_action='manual_schedule' then
    v_content_hash:=public.content_package_hash(p_package_id);
    if v_package.status<>'approved' or v_package.approval_hash=''
       or v_package.approval_hash is distinct from v_content_hash or exists(
        select 1 from public.persona_content_variants variant
        where variant.package_id=p_package_id and variant.owner=v_owner
          and variant.status<>'approved'
       ) then raise exception 'Approve the unchanged exact kit before manual scheduling'; end if;
  else raise exception 'Unsupported content-package preview action';
  end if;
  v_snapshot:=public.content_package_preview_snapshot_for_owner(
    v_owner,p_package_id,p_action,p_scheduled_for,p_timezone
  );
  if v_snapshot->>'version' is distinct from p_preview_version
     or v_snapshot->>'preview_hash' is distinct from p_preview_hash
     or v_snapshot->>'target_hash' is distinct from p_target_hash
     or v_snapshot->'variant_hashes' is distinct from p_variant_hashes then
    raise exception 'Content, media, target, or proposed time changed after preview; review it again';
  end if;
  if row(v_receipt.package_id,v_receipt.action,v_receipt.preview_version,
         v_receipt.preview_hash,v_receipt.package_hash,v_receipt.target_hash,
         v_receipt.proposed_for,v_receipt.timezone)
     is distinct from row(p_package_id,p_action,p_preview_version,
         p_preview_hash,v_snapshot->>'package_hash',p_target_hash,
         p_scheduled_for,p_timezone)
     or v_receipt.variant_hashes is distinct from p_variant_hashes
     or v_receipt.target_snapshot is distinct from v_snapshot->'targets' then
    raise exception 'The acknowledged receipt does not match this exact action';
  end if;
  update public.content_package_preview_receipts receipt set consumed_at=v_now
  where receipt.id=p_receipt_id and receipt.owner=v_owner
    and receipt.acknowledged_at is not null and receipt.consumed_at is null
    and receipt.invalidated_at is null and receipt.expires_at>v_now;
  if not found then raise exception 'The acknowledged content-package preview could not be consumed atomically'; end if;

  v_content_hash:=public.content_package_hash(p_package_id);
  if p_action='approve' then
    update public.persona_content_packages set
      status='approved',approval_hash=v_content_hash,approved_at=v_now,
      approved_by=v_owner,scheduled_for=null,completed_at=null,
      approved_preview_action=p_action,approved_preview_version=p_preview_version,
      approved_preview_hash=p_preview_hash,
      approved_preview_package_hash=v_snapshot->>'package_hash',
      approved_preview_variant_hashes=p_variant_hashes,
      approved_preview_target_hash=p_target_hash,
      approved_preview_targets=v_snapshot->'targets',
      approved_preview_scheduled_for=p_scheduled_for,
      approved_preview_timezone=p_timezone,approved_previewed_at=v_receipt.acknowledged_at,updated_at=v_now
    where id=p_package_id and owner=v_owner returning * into v_package;
    update public.persona_content_variants set status='approved',updated_at=v_now
    where package_id=p_package_id and owner=v_owner;
  else
    update public.persona_content_packages set
      status='scheduled',scheduled_for=p_scheduled_for,timezone=p_timezone,
      approved_preview_action=p_action,approved_preview_version=p_preview_version,
      approved_preview_hash=p_preview_hash,
      approved_preview_package_hash=v_snapshot->>'package_hash',
      approved_preview_variant_hashes=p_variant_hashes,
      approved_preview_target_hash=p_target_hash,
      approved_preview_targets=v_snapshot->'targets',
      approved_preview_scheduled_for=p_scheduled_for,
      approved_preview_timezone=p_timezone,approved_previewed_at=v_receipt.acknowledged_at,updated_at=v_now
    where id=p_package_id and owner=v_owner returning * into v_package;
    update public.persona_content_variants set status='scheduled',updated_at=v_now
    where package_id=p_package_id and owner=v_owner;
  end if;
  return v_package;
end;
$$;
revoke all on function public.commit_content_package_preview(
  uuid,uuid,text,timestamptz,text,text,text,text,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.commit_content_package_preview(
  uuid,uuid,text,timestamptz,text,text,text,text,jsonb
) to authenticated;

create or replace function public.invalidate_content_package_approval()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_package_id uuid:=coalesce(new.package_id,old.package_id);
begin
  update public.content_package_preview_receipts set
    invalidated_at=now(),invalidation_reason='content or media changed'
  where package_id=v_package_id and invalidated_at is null;
  update public.persona_content_packages package set
    status=case when package.status in ('approved','scheduled') then 'owner_review' else package.status end,
    scheduled_for=case when package.status in ('approved','scheduled') then null else package.scheduled_for end,
    approval_hash=case when package.status in ('approved','scheduled') then '' else package.approval_hash end,
    approved_at=case when package.status in ('approved','scheduled') then null else package.approved_at end,
    approved_by=case when package.status in ('approved','scheduled') then null else package.approved_by end,
    approved_preview_action='',approved_preview_version='',approved_preview_hash='',
    approved_preview_package_hash='',approved_preview_variant_hashes='{}'::jsonb,
    approved_preview_target_hash='',approved_preview_targets='{}'::jsonb,
    approved_preview_scheduled_for=null,approved_preview_timezone='',
    approved_previewed_at=null,updated_at=now()
  where package.id=v_package_id
    and (package.approved_previewed_at is not null or package.status in ('approved','scheduled'));
  return coalesce(new,old);
end;
$$;
revoke all on function public.invalidate_content_package_approval()
  from public, anon, authenticated, service_role;

create or replace function public.guard_content_package_material_edit()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.title is distinct from old.title
     or new.owner_guidance is distinct from old.owner_guidance
     or new.source_brief_id is distinct from old.source_brief_id
     or new.source_topic_ids is distinct from old.source_topic_ids then
    update public.content_package_preview_receipts set
      invalidated_at=now(),invalidation_reason='package material changed'
    where package_id=old.id and invalidated_at is null;
    if old.status in ('approved','scheduled') then
      new.status:='owner_review';new.scheduled_for:=null;new.approval_hash:='';
      new.approved_at:=null;new.approved_by:=null;
    end if;
    new.approved_preview_action:='';new.approved_preview_version:='';
    new.approved_preview_hash:='';new.approved_preview_package_hash:='';
    new.approved_preview_variant_hashes:='{}'::jsonb;
    new.approved_preview_target_hash:='';new.approved_preview_targets:='{}'::jsonb;
    new.approved_preview_scheduled_for:=null;new.approved_preview_timezone:='';
    new.approved_previewed_at:=null;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_content_package_material_edit()
  from public, anon, authenticated, service_role;

create or replace function public.invalidate_content_package_preview_for_target()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old_owner uuid;v_old_persona uuid;v_new_owner uuid;v_new_persona uuid;
  v_ledger_id uuid;
begin
  if tg_table_name='account_ledger' then
    if tg_op<>'INSERT' then v_old_owner:=old.owner;v_old_persona:=old.persona_id; end if;
    if tg_op<>'DELETE' then v_new_owner:=new.owner;v_new_persona:=new.persona_id; end if;
  else
    v_ledger_id:=coalesce(new.ledger_id,old.ledger_id);
    select ledger.owner,ledger.persona_id into v_new_owner,v_new_persona
    from public.account_ledger ledger where ledger.id=v_ledger_id;
    v_old_owner:=v_new_owner;v_old_persona:=v_new_persona;
  end if;
  update public.content_package_preview_receipts receipt set
    invalidated_at=now(),invalidation_reason='assigned account target changed'
  where receipt.invalidated_at is null and receipt.package_id in (
    select package.id from public.persona_content_packages package
    where (package.owner=v_old_owner and package.persona_id=v_old_persona)
       or (package.owner=v_new_owner and package.persona_id=v_new_persona)
  );
  update public.persona_content_packages package set
    status=case when package.status in ('approved','scheduled') then 'owner_review' else package.status end,
    scheduled_for=case when package.status in ('approved','scheduled') then null else package.scheduled_for end,
    approval_hash=case when package.status in ('approved','scheduled') then '' else package.approval_hash end,
    approved_at=case when package.status in ('approved','scheduled') then null else package.approved_at end,
    approved_by=case when package.status in ('approved','scheduled') then null else package.approved_by end,
    approved_preview_action='',approved_preview_version='',approved_preview_hash='',
    approved_preview_package_hash='',approved_preview_variant_hashes='{}'::jsonb,
    approved_preview_target_hash='',approved_preview_targets='{}'::jsonb,
    approved_preview_scheduled_for=null,approved_preview_timezone='',
    approved_previewed_at=null,updated_at=now()
  where ((package.owner=v_old_owner and package.persona_id=v_old_persona)
      or (package.owner=v_new_owner and package.persona_id=v_new_persona))
    and (package.approved_previewed_at is not null or package.status in ('approved','scheduled'));
  return coalesce(new,old);
end;
$$;
revoke all on function public.invalidate_content_package_preview_for_target()
  from public, anon, authenticated, service_role;

drop trigger if exists invalidate_content_package_preview_on_ledger_target
  on public.account_ledger;
create trigger invalidate_content_package_preview_on_ledger_target
  before insert or delete or update of persona_id,provider,username,login_email,url,suspended
  on public.account_ledger for each row
  execute function public.invalidate_content_package_preview_for_target();
drop trigger if exists invalidate_content_package_preview_on_connection_target
  on public.account_connections;
create trigger invalidate_content_package_preview_on_connection_target
  before insert or delete or update of provider,provider_subject,connection_state
  on public.account_connections for each row
  execute function public.invalidate_content_package_preview_for_target();

create or replace function public.clear_content_package_preview_on_state_change()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status not in ('approved','scheduled') then
    update public.content_package_preview_receipts set
      invalidated_at=now(),invalidation_reason='package left preview-approved state'
    where package_id=old.id and invalidated_at is null;
    new.approved_preview_action:='';new.approved_preview_version:='';
    new.approved_preview_hash:='';new.approved_preview_package_hash:='';
    new.approved_preview_variant_hashes:='{}'::jsonb;
    new.approved_preview_target_hash:='';new.approved_preview_targets:='{}'::jsonb;
    new.approved_preview_scheduled_for:=null;new.approved_preview_timezone:='';
    new.approved_previewed_at:=null;
  elsif old.status in ('approved','scheduled') and (
    new.status is distinct from old.status or new.scheduled_for is distinct from old.scheduled_for
    or new.timezone is distinct from old.timezone
  ) and new.approved_preview_hash is not distinct from old.approved_preview_hash then
    update public.content_package_preview_receipts set
      invalidated_at=now(),invalidation_reason='package target time or state changed'
    where package_id=old.id and invalidated_at is null;
    new.approved_preview_action:='';new.approved_preview_version:='';
    new.approved_preview_hash:='';new.approved_preview_package_hash:='';
    new.approved_preview_variant_hashes:='{}'::jsonb;
    new.approved_preview_target_hash:='';new.approved_preview_targets:='{}'::jsonb;
    new.approved_preview_scheduled_for:=null;new.approved_preview_timezone:='';
    new.approved_previewed_at:=null;
  end if;
  return new;
end;
$$;
revoke all on function public.clear_content_package_preview_on_state_change()
  from public, anon, authenticated, service_role;

drop trigger if exists clear_content_package_preview_on_state_change
  on public.persona_content_packages;
create trigger clear_content_package_preview_on_state_change
  before update of status,scheduled_for,timezone on public.persona_content_packages
  for each row execute function public.clear_content_package_preview_on_state_change();

create or replace function public.assert_content_package_preview()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_action text;
  v_snapshot jsonb;
begin
  if new.status not in ('approved','scheduled') then return null; end if;
  v_action:=case when new.status='approved' then 'approve' else 'manual_schedule' end;
  if new.approved_preview_action is distinct from v_action
     or new.approved_preview_version<>'content-package-preview-v1'
     or new.approved_previewed_at is null or new.approved_previewed_at>now()
     or (new.status='approved' and new.scheduled_for is not null)
     or (new.status='scheduled' and (
       new.scheduled_for is distinct from new.approved_preview_scheduled_for
       or new.timezone is distinct from new.approved_preview_timezone
     )) then raise exception 'Approved or scheduled content kits require a current exact-platform preview'; end if;
  v_snapshot:=public.content_package_preview_snapshot_for_owner(
    new.owner,new.id,v_action,new.approved_preview_scheduled_for,
    new.approved_preview_timezone
  );
  if new.approved_preview_hash is distinct from v_snapshot->>'preview_hash'
     or new.approved_preview_package_hash is distinct from v_snapshot->>'package_hash'
     or new.approved_preview_variant_hashes is distinct from v_snapshot->'variant_hashes'
     or new.approved_preview_target_hash is distinct from v_snapshot->>'target_hash'
     or new.approved_preview_targets is distinct from v_snapshot->'targets'
     or not exists(
       select 1 from public.content_package_preview_receipts receipt
       where receipt.package_id=new.id and receipt.owner=new.owner
         and receipt.invalidated_at is null and receipt.action=v_action
         and receipt.preview_hash=new.approved_preview_hash
         and receipt.package_hash=new.approved_preview_package_hash
         and receipt.variant_hashes=new.approved_preview_variant_hashes
         and receipt.target_hash=new.approved_preview_target_hash
         and receipt.target_snapshot=new.approved_preview_targets
         and receipt.proposed_for=new.approved_preview_scheduled_for
         and receipt.timezone=new.approved_preview_timezone
         and receipt.acknowledged_at is not null
         and receipt.consumed_at is not null
     ) then raise exception 'Content, media, target, or proposed time changed after preview'; end if;
  return null;
end;
$$;
revoke all on function public.assert_content_package_preview()
  from public, anon, authenticated, service_role;

drop trigger if exists assert_content_package_preview
  on public.persona_content_packages;
create constraint trigger assert_content_package_preview
  after insert or update on public.persona_content_packages
  deferrable initially deferred
  for each row execute function public.assert_content_package_preview();

-- The legacy owner RPC names are deliberately terminal. They cannot be called
-- by an old browser, service script, or stale client to skip the preview gate.
create or replace function public.approve_content_package(p_package_id uuid)
returns public.persona_content_packages
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Deprecated: use the exact content-package platform preview gate'
    using errcode='42501';
end;
$$;
create or replace function public.schedule_content_package(
  p_package_id uuid,p_scheduled_for timestamptz,p_timezone text
)
returns public.persona_content_packages
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Deprecated: use the exact content-package platform preview gate'
    using errcode='42501';
end;
$$;
revoke all on function public.approve_content_package(uuid),
  public.schedule_content_package(uuid,timestamptz,text)
  from public, anon, authenticated, service_role;

create or replace function public.unschedule_content_package(p_package_id uuid)
returns public.persona_content_packages
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();v_package public.persona_content_packages%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  perform public.lock_owner_research_content(v_owner);
  select * into v_package from public.persona_content_packages package
  where package.id=p_package_id and package.owner=v_owner for update;
  if not found or v_package.status<>'scheduled' then
    raise exception 'Owned scheduled content package not found';
  end if;
  update public.content_package_preview_receipts set
    invalidated_at=now(),invalidation_reason='manual schedule removed by owner'
  where package_id=p_package_id and owner=v_owner and invalidated_at is null;
  update public.persona_content_packages set
    status='owner_review',scheduled_for=null,approval_hash='',approved_at=null,
    approved_by=null,approved_preview_action='',approved_preview_version='',
    approved_preview_hash='',approved_preview_package_hash='',
    approved_preview_variant_hashes='{}'::jsonb,approved_preview_target_hash='',
    approved_preview_targets='{}'::jsonb,approved_preview_scheduled_for=null,
    approved_preview_timezone='',approved_previewed_at=null,updated_at=now()
  where id=p_package_id and owner=v_owner returning * into v_package;
  update public.persona_content_variants set status='ready',updated_at=now()
  where package_id=p_package_id and owner=v_owner and status='scheduled';
  return v_package;
end;
$$;
revoke all on function public.unschedule_content_package(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.unschedule_content_package(uuid) to authenticated;

-- Reassert that browsers can read packages but can mutate them only through
-- bounded security-definer RPCs. No provider table or automatic queue is used.
revoke insert,update,delete on public.persona_content_packages,
  public.persona_content_variants from authenticated;

do $$
begin
  if exists(
    select 1 from public.persona_content_packages package
    where package.status in ('approved','scheduled')
  ) then
    raise exception 'Return active four-channel kits to owner review before applying the exact preview gate';
  end if;
end;
$$;

commit;
