-- 071-twitch-patreon-capability-foundation.sql
--
-- Twitch is intentionally limited to three Helix features that Twitch
-- officially exposes: channel information, stream-schedule segments, and
-- chat announcements. It is not represented as a general feed/video uploader.
-- Patreon is read/report plus a native-editor handoff; the public API has no
-- ordinary post-create endpoint. Every action or handoff is bound to the
-- migration-069 exact platform preview and to the current provider subject.

begin;

create extension if not exists supabase_vault with schema vault;

-- -------------------------------------------------------------------------
-- Twitch OAuth, exact broadcaster binding, approvals, and outcomes.
-- -------------------------------------------------------------------------

create table if not exists public.twitch_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  requested_scopes text[] not null,
  return_origin text not null check (char_length(return_origin) between 8 and 255),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);
create unique index if not exists twitch_oauth_transactions_owner_ledger_idx
  on public.twitch_oauth_transactions(owner,ledger_id);
create index if not exists twitch_oauth_transactions_expiry_idx
  on public.twitch_oauth_transactions(expires_at);

create table if not exists public.twitch_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  broadcaster_id text not null check (broadcaster_id ~ '^[0-9]{1,30}$'),
  broadcaster_login text not null check (broadcaster_login ~ '^[a-z0-9_]{1,25}$'),
  broadcaster_name text not null default '' check (char_length(broadcaster_name) <= 100),
  granted_scopes text[] not null,
  vault_secret_id uuid not null unique,
  last_validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);
create unique index if not exists twitch_credentials_owner_broadcaster_idx
  on public.twitch_credentials(owner,broadcaster_id);

create table if not exists public.twitch_operation_leases (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  operation_kind text not null check (operation_kind in ('connect','refresh','disconnect','action')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);

create table if not exists public.twitch_action_approvals (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid not null references public.drafts(id) on delete cascade,
  ledger_id uuid not null,
  broadcaster_id text not null check (broadcaster_id ~ '^[0-9]{1,30}$'),
  action_type text not null check (action_type in (
    'channel_update','schedule_segment_create','chat_announcement'
  )),
  required_scope text not null,
  action_payload jsonb not null check (jsonb_typeof(action_payload) = 'object'),
  preview_version text not null check (preview_version = 'twitch-action-preview-v1'),
  draft_content_hash text not null check (draft_content_hash ~ '^[0-9a-f]{64}$'),
  approval_hash text not null unique check (approval_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid not null references public.profiles(id) on delete cascade,
  approved_at timestamptz not null default now(),
  invalidated_at timestamptz,
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);
create index if not exists twitch_action_approvals_owner_idx
  on public.twitch_action_approvals(owner,approved_at desc);

create table if not exists public.twitch_action_attempts (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid not null references public.drafts(id) on delete cascade,
  ledger_id uuid not null,
  approval_id uuid not null unique references public.twitch_action_approvals(id) on delete restrict,
  approval_hash text not null check (approval_hash ~ '^[0-9a-f]{64}$'),
  broadcaster_id text not null check (broadcaster_id ~ '^[0-9]{1,30}$'),
  action_type text not null,
  action_payload jsonb not null,
  status text not null default 'claimed' check (status in (
    'claimed','provider_accepted','completed','definitive_failure','outcome_unknown'
  )),
  provider_http_status integer check (
    provider_http_status is null or provider_http_status between 100 and 599
  ),
  provider_reference text not null default '' check (char_length(provider_reference) <= 500),
  provider_result jsonb not null default '{}'::jsonb,
  error_code text not null default '' check (char_length(error_code) <= 120),
  error_message text not null default '' check (char_length(error_message) <= 1000),
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  last_reconciled_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);
create index if not exists twitch_action_attempts_owner_idx
  on public.twitch_action_attempts(owner,claimed_at desc);

alter table public.twitch_oauth_transactions enable row level security;
alter table public.twitch_credentials enable row level security;
alter table public.twitch_operation_leases enable row level security;
alter table public.twitch_action_approvals enable row level security;
alter table public.twitch_action_attempts enable row level security;

drop policy if exists "twitch action approvals owner read" on public.twitch_action_approvals;
create policy "twitch action approvals owner read" on public.twitch_action_approvals
  for select to authenticated using ((select auth.uid()) = owner);
drop policy if exists "twitch action attempts owner read" on public.twitch_action_attempts;
create policy "twitch action attempts owner read" on public.twitch_action_attempts
  for select to authenticated using ((select auth.uid()) = owner);

revoke all on public.twitch_oauth_transactions,public.twitch_credentials,
  public.twitch_operation_leases,public.twitch_action_approvals,
  public.twitch_action_attempts from anon,authenticated;
grant all on public.twitch_oauth_transactions,public.twitch_credentials,
  public.twitch_operation_leases,public.twitch_action_approvals,
  public.twitch_action_attempts to service_role;
grant select on public.twitch_action_approvals,public.twitch_action_attempts
  to authenticated;

create or replace function public.twitch_required_scope(p_action_type text)
returns text language sql immutable set search_path='' as $$
  select case p_action_type
    when 'channel_update' then 'channel:manage:broadcast'
    when 'schedule_segment_create' then 'channel:manage:schedule'
    when 'chat_announcement' then 'moderator:manage:announcements'
    else '' end;
$$;

create or replace function public.twitch_valid_action_payload(
  p_action_type text,p_payload jsonb
)
returns boolean language plpgsql stable set search_path='' as $$
declare
  v_keys text[];
  v_duration integer;
  v_start timestamptz;
  v_timezone text;
  v_tag jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then return false; end if;
  select coalesce(array_agg(key order by key),'{}'::text[])
    into v_keys from jsonb_object_keys(p_payload) key;
  if p_action_type = 'channel_update' then
    if not (v_keys <@ array['broadcaster_language','game_id','is_branded_content','tags','title'])
      or cardinality(v_keys) = 0 then return false; end if;
    if p_payload ? 'title' and (jsonb_typeof(p_payload->'title') <> 'string'
      or char_length(trim(p_payload->>'title')) not between 1 and 140)
      then return false; end if;
    if p_payload ? 'game_id' and (jsonb_typeof(p_payload->'game_id') <> 'string'
      or coalesce(p_payload->>'game_id','') !~ '^(|0|[0-9]{1,30})$')
      then return false; end if;
    if p_payload ? 'broadcaster_language' and
      (jsonb_typeof(p_payload->'broadcaster_language') <> 'string'
      or coalesce(p_payload->>'broadcaster_language','') !~ '^(other|[a-z]{2})$')
      then return false; end if;
    if p_payload ? 'is_branded_content' and jsonb_typeof(p_payload->'is_branded_content') <> 'boolean'
      then return false; end if;
    if p_payload ? 'tags' then
      if jsonb_typeof(p_payload->'tags') <> 'array'
        or jsonb_array_length(p_payload->'tags') > 10 then return false; end if;
      for v_tag in select value from jsonb_array_elements(p_payload->'tags') value loop
        if jsonb_typeof(v_tag) <> 'string'
          or trim(both '"' from v_tag::text) !~ '^[[:alnum:]]{1,25}$' then return false; end if;
      end loop;
    end if;
    return true;
  elsif p_action_type = 'schedule_segment_create' then
    if not (v_keys <@ array['category_id','duration','is_recurring','start_time','timezone','title'])
      or not (array['duration','start_time','timezone'] <@ v_keys) then return false; end if;
    if jsonb_typeof(p_payload->'duration') not in ('number','string')
      or coalesce(p_payload->>'duration','') !~ '^[0-9]{1,4}$'
      or jsonb_typeof(p_payload->'start_time') <> 'string'
      or jsonb_typeof(p_payload->'timezone') <> 'string' then return false; end if;
    begin
      v_duration := (p_payload->>'duration')::integer;
      v_start := (p_payload->>'start_time')::timestamptz;
    exception when others then return false; end;
    if v_duration not between 30 and 1380 or v_start <= now() then return false; end if;
    v_timezone := trim(coalesce(p_payload->>'timezone',''));
    if not exists (select 1 from pg_catalog.pg_timezone_names where name=v_timezone)
      then return false; end if;
    if p_payload ? 'is_recurring' and jsonb_typeof(p_payload->'is_recurring') <> 'boolean'
      then return false; end if;
    if p_payload ? 'category_id' and (jsonb_typeof(p_payload->'category_id') <> 'string'
      or coalesce(p_payload->>'category_id','') !~ '^[0-9]{1,30}$')
      then return false; end if;
    if p_payload ? 'title' and (jsonb_typeof(p_payload->'title') <> 'string'
      or char_length(coalesce(p_payload->>'title','')) > 140)
      then return false; end if;
    return true;
  elsif p_action_type = 'chat_announcement' then
    return v_keys <@ array['color','message']
      and array['message'] <@ v_keys
      and jsonb_typeof(p_payload->'message') = 'string'
      and (not (p_payload ? 'color') or jsonb_typeof(p_payload->'color') = 'string')
      and char_length(trim(coalesce(p_payload->>'message',''))) between 1 and 500
      and coalesce(p_payload->>'color','primary') in ('blue','green','orange','purple','primary');
  end if;
  return false;
end;
$$;

create or replace function public.twitch_action_approval_hash(
  p_approval_id uuid,p_draft_hash text,p_broadcaster_id text,
  p_action_type text,p_payload jsonb,p_preview_version text
)
returns text language sql stable set search_path='' as $$
  select encode(extensions.digest(convert_to(jsonb_build_array(
    p_approval_id,coalesce(p_draft_hash,''),coalesce(p_broadcaster_id,''),
    coalesce(p_action_type,''),coalesce(p_payload,'{}'::jsonb),
    coalesce(p_preview_version,'')
  )::text,'UTF8'),'sha256'),'hex');
$$;

create or replace function public.claim_twitch_operation(
  p_ledger_id uuid,p_owner uuid,p_lease_id uuid,p_operation_kind text,
  p_ttl_seconds integer
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_claimed boolean:=false;
begin
  if p_operation_kind not in ('connect','refresh','disconnect','action')
    or p_ttl_seconds not between 15 and 180 then raise exception 'Invalid Twitch operation lease'; end if;
  if not exists(select 1 from public.account_ledger where id=p_ledger_id and owner=p_owner and provider='twitch')
    then raise exception 'Owned Twitch ledger entry not found'; end if;
  insert into public.twitch_operation_leases as l(ledger_id,owner,lease_id,operation_kind,expires_at)
  values(p_ledger_id,p_owner,p_lease_id,p_operation_kind,now()+make_interval(secs=>p_ttl_seconds))
  on conflict(ledger_id) do update set owner=excluded.owner,lease_id=excluded.lease_id,
    operation_kind=excluded.operation_kind,expires_at=excluded.expires_at,created_at=now()
  where l.expires_at<=now() returning true into v_claimed;
  return coalesce(v_claimed,false);
end;
$$;

create or replace function public.release_twitch_operation(
  p_ledger_id uuid,p_owner uuid,p_lease_id uuid
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  delete from public.twitch_operation_leases where ledger_id=p_ledger_id and owner=p_owner and lease_id=p_lease_id;
  get diagnostics v_count=row_count; return v_count>0;
end;
$$;

create or replace function public.twitch_store_token_bundle(
  p_ledger_id uuid,p_owner uuid,p_broadcaster_id text,p_broadcaster_login text,
  p_broadcaster_name text,p_access_token text,p_refresh_token text,
  p_expires_at timestamptz,p_granted_scopes text[]
)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_name text:='twitch_oauth_'||p_ledger_id::text; v_bundle text;
begin
  if p_broadcaster_id !~ '^[0-9]{1,30}$' or p_broadcaster_login !~ '^[a-z0-9_]{1,25}$'
    then raise exception 'Twitch returned an invalid broadcaster identity'; end if;
  if trim(coalesce(p_access_token,''))='' or trim(coalesce(p_refresh_token,''))=''
    or char_length(p_access_token)>16384 or char_length(p_refresh_token)>16384
    or p_expires_at<=now() then raise exception 'Twitch returned an invalid token bundle'; end if;
  if exists(select 1 from unnest(coalesce(p_granted_scopes,'{}')) s
    where s not in ('channel:manage:broadcast','channel:manage:schedule','moderator:manage:announcements'))
    then raise exception 'Twitch returned an unexpected scope'; end if;
  if cardinality(coalesce(p_granted_scopes,'{}'))=0
    then raise exception 'Twitch returned no supported feature scope'; end if;
  if not exists(select 1 from public.account_ledger where id=p_ledger_id and owner=p_owner
    and provider='twitch' and not coalesce(suspended,false)) then raise exception 'Owned active Twitch ledger entry not found'; end if;
  if exists(select 1 from public.twitch_credentials where owner=p_owner and broadcaster_id=p_broadcaster_id
    and ledger_id<>p_ledger_id) then raise exception 'That Twitch broadcaster is already connected'; end if;
  v_bundle:=jsonb_build_object('access_token',p_access_token,'refresh_token',p_refresh_token,
    'expires_at',p_expires_at,'granted_scopes',p_granted_scopes,'stored_at',now())::text;
  select vault_secret_id into v_id from public.twitch_credentials
    where ledger_id=p_ledger_id and owner=p_owner for update;
  if v_id is null then select id into v_id from vault.secrets where name=v_name; end if;
  if v_id is null then
    select vault.create_secret(v_bundle,v_name,'Twitch OAuth token bundle for ledger '||p_ledger_id::text) into v_id;
  else
    perform vault.update_secret(v_id,v_bundle,v_name,'Twitch OAuth token bundle for ledger '||p_ledger_id::text);
  end if;
  insert into public.twitch_credentials as c(ledger_id,owner,broadcaster_id,broadcaster_login,
    broadcaster_name,granted_scopes,vault_secret_id,last_validated_at,updated_at)
  values(p_ledger_id,p_owner,p_broadcaster_id,p_broadcaster_login,left(coalesce(p_broadcaster_name,''),100),
    p_granted_scopes,v_id,now(),now())
  on conflict(ledger_id) do update set broadcaster_id=excluded.broadcaster_id,
    broadcaster_login=excluded.broadcaster_login,broadcaster_name=excluded.broadcaster_name,
    granted_scopes=excluded.granted_scopes,vault_secret_id=excluded.vault_secret_id,
    last_validated_at=now(),updated_at=now();
  insert into public.account_connections as c(ledger_id,owner,provider,provider_subject,granted_scopes,
    connection_state,verification_method,verified_at,connected_at,last_checked_at,expires_at,error_code,updated_at)
  values(p_ledger_id,p_owner,'twitch',p_broadcaster_id,p_granted_scopes,'connected','twitch_oauth2_code',
    now(),now(),now(),p_expires_at,'',now())
  on conflict(ledger_id) do update set provider='twitch',provider_subject=excluded.provider_subject,
    granted_scopes=excluded.granted_scopes,connection_state='connected',verification_method=excluded.verification_method,
    verified_at=now(),connected_at=coalesce(c.connected_at,now()),last_checked_at=now(),
    expires_at=excluded.expires_at,error_code='',updated_at=now();
  return v_id;
end;
$$;

create or replace function public.twitch_get_token_bundle(p_ledger_id uuid,p_owner uuid)
returns table(broadcaster_id text,broadcaster_login text,broadcaster_name text,
  granted_scopes text[],token_bundle jsonb)
language sql security definer set search_path='' as $$
  select c.broadcaster_id,c.broadcaster_login,c.broadcaster_name,c.granted_scopes,
    s.decrypted_secret::jsonb from public.twitch_credentials c
  join vault.decrypted_secrets s on s.id=c.vault_secret_id
  where c.ledger_id=p_ledger_id and c.owner=p_owner;
$$;

create or replace function public.twitch_delete_token_bundle(p_ledger_id uuid,p_owner uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  delete from public.twitch_credentials where ledger_id=p_ledger_id and owner=p_owner;
  get diagnostics v_count=row_count;
  update public.account_connections set provider_subject='',granted_scopes='{}',connection_state='disconnected',
    expires_at=null,error_code='',last_checked_at=now(),updated_at=now()
    where ledger_id=p_ledger_id and owner=p_owner and provider='twitch';
  return v_count>0;
end;
$$;

create or replace function public.delete_twitch_vault_secret()
returns trigger language plpgsql security definer set search_path='' as $$
begin delete from vault.secrets where id=old.vault_secret_id; return old; end; $$;
drop trigger if exists twitch_credentials_delete_vault_secret on public.twitch_credentials;
create trigger twitch_credentials_delete_vault_secret after delete on public.twitch_credentials
  for each row execute function public.delete_twitch_vault_secret();

create or replace function public.twitch_record_action_preview_service(
  p_owner uuid,p_draft_id uuid,p_action_type text,p_action_payload jsonb,
  p_preview_version text
)
returns public.twitch_action_approvals language plpgsql security definer set search_path='' as $$
declare d public.drafts%rowtype; l public.account_ledger%rowtype;
  c public.account_connections%rowtype; v_id uuid:=gen_random_uuid();
  v_scope text; v_hash text; v_generic_hash text; result public.twitch_action_approvals%rowtype;
begin
  select * into d from public.drafts where id=p_draft_id and owner=p_owner;
  if not found or d.platform<>'twitch' or d.account_id is null or d.persona_id is null
    or d.approval_state<>'approved' or d.approved_content_hash !~ '^[0-9a-f]{64}$'
    then raise exception 'Approve the exact Twitch draft first'; end if;
  if public.agent_draft_hash(d.title,d.body,d.tags,d.media_url,d.content_kind,d.persona_id,
    d.account_id,d.platform,d.publish_at) is distinct from d.approved_content_hash
    then raise exception 'The Twitch draft changed after approval'; end if;
  select * into l from public.account_ledger where id=d.account_id and owner=p_owner and provider='twitch'
    and not coalesce(suspended,false);
  if not found or (l.persona_id is distinct from d.persona_id and not exists(
    select 1 from public.account_persona_links where ledger_id=l.id and owner=p_owner and persona_id=d.persona_id
  )) then raise exception 'The Twitch broadcaster is no longer assigned to this persona'; end if;
  select * into c from public.account_connections where ledger_id=l.id and owner=p_owner and provider='twitch'
    and connection_state='connected';
  v_scope:=public.twitch_required_scope(p_action_type);
  if not found or v_scope='' or not (v_scope=any(c.granted_scopes))
    or not public.twitch_valid_action_payload(p_action_type,p_action_payload)
    then raise exception 'Twitch action or permission is not available'; end if;
  v_generic_hash:=public.agent_draft_preview_hash(d.approved_content_hash,d.approved_preview_version,
    d.approved_preview_target_id);
  if d.approved_preview_version<>'platform-preview-v1' or d.approved_preview_target_id<>c.provider_subject
    or d.approved_previewed_at is null or d.approved_previewed_at>now()
    or d.approved_preview_hash<>v_generic_hash or p_preview_version<>'twitch-action-preview-v1'
    then raise exception 'Review the current exact Twitch action preview'; end if;
  v_hash:=public.twitch_action_approval_hash(v_id,d.approved_content_hash,c.provider_subject,
    p_action_type,p_action_payload,p_preview_version);
  insert into public.twitch_action_approvals(id,owner,draft_id,ledger_id,broadcaster_id,action_type,
    required_scope,action_payload,preview_version,draft_content_hash,approval_hash,approved_by)
  values(v_id,p_owner,d.id,l.id,c.provider_subject,p_action_type,v_scope,p_action_payload,
    p_preview_version,d.approved_content_hash,v_hash,p_owner) returning * into result;
  insert into public.agent_actions(owner,persona_id,action_type,entity_type,entity_id,outcome,detail)
  values(p_owner,d.persona_id,'twitch.action_preview_approved','draft',d.id,'approved',
    jsonb_build_object('approval_id',v_id,'approval_hash',v_hash,'broadcaster_id',c.provider_subject,
      'twitch_action',p_action_type,'payload',p_action_payload,'preview_version',p_preview_version));
  return result;
end;
$$;

-- Remove the pre-receipt overload on reapply so an older service grant cannot
-- bypass the acknowledged action-time receipt contract.
drop function if exists public.claim_twitch_action_service(uuid,uuid,text,uuid,uuid);
create or replace function public.claim_twitch_action_service(
  p_owner uuid,p_draft_id uuid,p_approval_hash text,p_attempt_id uuid,p_lease_id uuid,
  p_receipt_id uuid
)
returns table(attempt_id uuid,draft_id uuid,ledger_id uuid,persona_id uuid,
  broadcaster_id text,action_type text,action_payload jsonb,required_scope text,
  approval_hash text,attempt_status text,is_new boolean)
language plpgsql security definer set search_path='' as $$
declare d public.drafts%rowtype; a public.twitch_action_approvals%rowtype;
  c public.account_connections%rowtype; t public.twitch_action_attempts%rowtype;
  v_generic_hash text; v_inserted boolean:=false;
begin
  select * into d from public.drafts where id=p_draft_id and owner=p_owner for update;
  select * into a from public.twitch_action_approvals where draft_id=p_draft_id and owner=p_owner
    and approval_hash=p_approval_hash and invalidated_at is null for update;
  if d.id is null or a.id is null or d.platform<>'twitch'
    or d.account_id is distinct from a.ledger_id or d.persona_id is null
    or d.approval_state<>'approved' or d.approved_content_hash<>a.draft_content_hash
    or public.agent_draft_hash(d.title,d.body,d.tags,d.media_url,d.content_kind,d.persona_id,
      d.account_id,d.platform,d.publish_at) is distinct from d.approved_content_hash
    then raise exception 'Twitch action approval changed'; end if;
  if not exists(select 1 from public.agent_owner_settings where owner=p_owner and not automation_paused)
    then raise exception 'Owner automation is paused or unavailable'; end if;
  if not exists(select 1 from public.account_ledger l where l.id=a.ledger_id and l.owner=p_owner
    and l.provider='twitch' and not coalesce(l.suspended,false) and
    (l.persona_id=d.persona_id or exists(select 1 from public.account_persona_links x
      where x.ledger_id=l.id and x.owner=p_owner and x.persona_id=d.persona_id)))
    then raise exception 'The Twitch assignment changed'; end if;
  select * into c from public.account_connections where ledger_id=a.ledger_id and owner=p_owner
    and provider='twitch' and connection_state='connected';
  v_generic_hash:=public.agent_draft_preview_hash(d.approved_content_hash,d.approved_preview_version,
    d.approved_preview_target_id);
  if not found or c.provider_subject<>a.broadcaster_id or not(a.required_scope=any(c.granted_scopes))
    or d.approved_preview_version<>'platform-preview-v1' or d.approved_preview_target_id<>c.provider_subject
    or d.approved_previewed_at is null or d.approved_previewed_at>now()
    or d.approved_preview_hash<>v_generic_hash
    or not public.twitch_valid_action_payload(a.action_type,a.action_payload)
    or public.twitch_action_approval_hash(a.id,d.approved_content_hash,a.broadcaster_id,
      a.action_type,a.action_payload,a.preview_version)<>a.approval_hash
    then raise exception 'Twitch destination, preview, permission, or payload changed'; end if;
  if not exists(select 1 from public.twitch_operation_leases where ledger_id=a.ledger_id and owner=p_owner
    and lease_id=p_lease_id and operation_kind='action' and expires_at>now())
    then raise exception 'Twitch action lease is not active'; end if;
  perform public.consume_provider_action_preview_service(
    p_owner,d.id,a.ledger_id,'twitch','twitch.'||a.action_type,p_receipt_id,
    a.broadcaster_id,d.approved_content_hash,a.approval_hash
  );
  insert into public.twitch_action_attempts(id,owner,draft_id,ledger_id,approval_id,approval_hash,
    broadcaster_id,action_type,action_payload)
  values(p_attempt_id,p_owner,d.id,a.ledger_id,a.id,a.approval_hash,a.broadcaster_id,a.action_type,a.action_payload)
  on conflict do nothing returning true into v_inserted;
  select * into t from public.twitch_action_attempts where approval_id=a.id and owner=p_owner;
  if not found then raise exception 'The Twitch action claim could not be checkpointed'; end if;
  return query select t.id,d.id,a.ledger_id,d.persona_id,a.broadcaster_id,
    a.action_type,a.action_payload,a.required_scope,a.approval_hash,t.status,v_inserted;
end;
$$;

create or replace function public.twitch_finish_action_service(
  p_attempt_id uuid,p_owner uuid,p_status text,p_http_status integer,
  p_provider_reference text,p_provider_result jsonb,p_error_code text,p_error_message text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if p_status not in ('provider_accepted','completed','definitive_failure','outcome_unknown')
    then raise exception 'Invalid Twitch outcome'; end if;
  update public.twitch_action_attempts set status=p_status,provider_http_status=p_http_status,
    provider_reference=left(coalesce(p_provider_reference,''),500),
    provider_result=coalesce(p_provider_result,'{}'::jsonb),
    error_code=left(coalesce(p_error_code,''),120),
    error_message=left(coalesce(p_error_message,''),1000),
    completed_at=case when p_status='completed' then now() else completed_at end,
    last_reconciled_at=case when p_status in ('completed','definitive_failure') then now() else last_reconciled_at end,
    updated_at=now()
  where id=p_attempt_id and owner=p_owner and status in ('claimed','provider_accepted','outcome_unknown');
  get diagnostics v_count=row_count; return v_count>0;
end;
$$;

create or replace function public.invalidate_twitch_approval_on_draft_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.approved_content_hash is distinct from new.approved_content_hash
    or old.approved_preview_hash is distinct from new.approved_preview_hash
    or old.account_id is distinct from new.account_id or old.persona_id is distinct from new.persona_id
    or old.platform is distinct from new.platform then
    update public.twitch_action_approvals set invalidated_at=coalesce(invalidated_at,now())
      where draft_id=new.id and invalidated_at is null;
  end if; return new;
end;
$$;
drop trigger if exists invalidate_twitch_approval_on_draft_change on public.drafts;
create trigger invalidate_twitch_approval_on_draft_change after update on public.drafts
  for each row execute function public.invalidate_twitch_approval_on_draft_change();

create or replace function public.guard_connected_twitch_ledger_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.provider='twitch' and exists(select 1 from public.twitch_credentials where ledger_id=old.id and owner=old.owner) then
    if tg_op='DELETE' then
      raise exception 'Disconnect Twitch before deleting or retargeting this account';
    elsif new.owner is distinct from old.owner
      or new.provider is distinct from old.provider
      or new.username is distinct from old.username
      or new.url is distinct from old.url then
      raise exception 'Disconnect Twitch before deleting or retargeting this account';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
drop trigger if exists guard_connected_twitch_ledger_change on public.account_ledger;
create trigger guard_connected_twitch_ledger_change before update or delete on public.account_ledger
  for each row execute function public.guard_connected_twitch_ledger_change();

-- -------------------------------------------------------------------------
-- Patreon OAuth/read binding and native post-editor handoff only.
-- -------------------------------------------------------------------------

create table if not exists public.patreon_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  return_origin text not null check (char_length(return_origin) between 8 and 255),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);
create unique index if not exists patreon_oauth_transactions_owner_ledger_idx
  on public.patreon_oauth_transactions(owner,ledger_id);

create table if not exists public.patreon_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  patreon_user_id text not null check (char_length(patreon_user_id) between 1 and 100),
  campaign_id text not null default '' check (char_length(campaign_id) <= 100),
  campaign_name text not null default '' check (char_length(campaign_name) <= 200),
  campaign_url text not null default '' check (char_length(campaign_url) <= 1000),
  granted_scopes text[] not null,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);
create unique index if not exists patreon_credentials_owner_campaign_idx
  on public.patreon_credentials(owner,campaign_id) where campaign_id<>'';

create table if not exists public.patreon_operation_leases (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  operation_kind text not null check (operation_kind in ('connect','refresh','disconnect','read')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);

create table if not exists public.patreon_native_handoffs (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid not null references public.drafts(id) on delete cascade,
  ledger_id uuid not null,
  campaign_id text not null check (char_length(campaign_id) between 1 and 100),
  preview_version text not null check (preview_version='patreon-native-preview-v1'),
  draft_content_hash text not null check (draft_content_hash ~ '^[0-9a-f]{64}$'),
  publish_mode text not null check (publish_mode in ('save_draft','publish_now','schedule')),
  audience text not null check (audience in ('public','free_members','paid_members','select_tiers')),
  scheduled_for timestamptz,
  timezone text not null check (char_length(timezone) between 1 and 80),
  package_hash text not null unique check (package_hash ~ '^[0-9a-f]{64}$'),
  title text not null,
  body text not null,
  tags text not null,
  media_url text not null,
  native_editor_url text not null check (native_editor_url='https://www.patreon.com/posts/new'),
  status text not null default 'prepared' check (status in ('prepared','opened','owner_completed','abandoned')),
  prepared_at timestamptz not null default now(),
  opened_at timestamptz,
  owner_completed_at timestamptz,
  owner_completion_note text not null default '' check (char_length(owner_completion_note)<=1000),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade,
  check ((publish_mode='schedule' and scheduled_for is not null and scheduled_for>prepared_at)
    or (publish_mode<>'schedule' and scheduled_for is null))
);
create index if not exists patreon_native_handoffs_owner_idx
  on public.patreon_native_handoffs(owner,prepared_at desc);

alter table public.patreon_oauth_transactions enable row level security;
alter table public.patreon_credentials enable row level security;
alter table public.patreon_operation_leases enable row level security;
alter table public.patreon_native_handoffs enable row level security;
drop policy if exists "patreon native handoffs owner read" on public.patreon_native_handoffs;
create policy "patreon native handoffs owner read" on public.patreon_native_handoffs
  for select to authenticated using ((select auth.uid())=owner);
revoke all on public.patreon_oauth_transactions,public.patreon_credentials,
  public.patreon_operation_leases,public.patreon_native_handoffs from anon,authenticated;
grant all on public.patreon_oauth_transactions,public.patreon_credentials,
  public.patreon_operation_leases,public.patreon_native_handoffs to service_role;
grant select on public.patreon_native_handoffs to authenticated;

create or replace function public.claim_patreon_operation(
  p_ledger_id uuid,p_owner uuid,p_lease_id uuid,p_operation_kind text,p_ttl_seconds integer
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_claimed boolean:=false;
begin
  if p_operation_kind not in ('connect','refresh','disconnect','read') or p_ttl_seconds not between 15 and 180
    then raise exception 'Invalid Patreon operation lease'; end if;
  if not exists(select 1 from public.account_ledger where id=p_ledger_id and owner=p_owner and provider='patreon')
    then raise exception 'Owned Patreon ledger entry not found'; end if;
  insert into public.patreon_operation_leases as l(ledger_id,owner,lease_id,operation_kind,expires_at)
  values(p_ledger_id,p_owner,p_lease_id,p_operation_kind,now()+make_interval(secs=>p_ttl_seconds))
  on conflict(ledger_id) do update set owner=excluded.owner,lease_id=excluded.lease_id,
    operation_kind=excluded.operation_kind,expires_at=excluded.expires_at,created_at=now()
  where l.expires_at<=now() returning true into v_claimed;
  return coalesce(v_claimed,false);
end;
$$;

create or replace function public.release_patreon_operation(p_ledger_id uuid,p_owner uuid,p_lease_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin delete from public.patreon_operation_leases where ledger_id=p_ledger_id and owner=p_owner and lease_id=p_lease_id;
  get diagnostics v_count=row_count; return v_count>0; end;
$$;

create or replace function public.patreon_store_token_bundle(
  p_ledger_id uuid,p_owner uuid,p_patreon_user_id text,p_campaign_id text,p_campaign_name text,
  p_campaign_url text,p_access_token text,p_refresh_token text,p_expires_at timestamptz,p_granted_scopes text[]
)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_name text:='patreon_oauth_'||p_ledger_id::text; v_bundle text;
begin
  if trim(coalesce(p_patreon_user_id,''))='' or char_length(p_patreon_user_id)>100
    or trim(coalesce(p_access_token,''))='' or trim(coalesce(p_refresh_token,''))=''
    or char_length(p_access_token)>16384 or char_length(p_refresh_token)>16384
    or char_length(coalesce(p_campaign_id,''))>100
    or char_length(coalesce(p_campaign_name,''))>200
    or char_length(coalesce(p_campaign_url,''))>1000
    or (coalesce(p_campaign_url,'')<>'' and p_campaign_url !~ '^https://(www\.)?patreon\.com/')
    or p_expires_at<=now()
    then raise exception 'Patreon returned an invalid identity or token bundle'; end if;
  if not (array['identity','campaigns','campaigns.posts'] <@ coalesce(p_granted_scopes,'{}'))
    then raise exception 'Patreon did not grant the required read scopes'; end if;
  if exists(select 1 from unnest(coalesce(p_granted_scopes,'{}')) s
    where s not in ('identity','campaigns','campaigns.posts'))
    then raise exception 'Revoke the prior Patreon grant before connecting with least-privilege scopes'; end if;
  if not exists(select 1 from public.account_ledger where id=p_ledger_id and owner=p_owner
    and provider='patreon' and not coalesce(suspended,false)) then raise exception 'Owned active Patreon ledger entry not found'; end if;
  if coalesce(p_campaign_id,'')<>'' and exists(select 1 from public.patreon_credentials
    where owner=p_owner and campaign_id=p_campaign_id and ledger_id<>p_ledger_id)
    then raise exception 'That Patreon campaign is already connected'; end if;
  v_bundle:=jsonb_build_object('access_token',p_access_token,'refresh_token',p_refresh_token,
    'expires_at',p_expires_at,'granted_scopes',p_granted_scopes,'stored_at',now())::text;
  select vault_secret_id into v_id from public.patreon_credentials where ledger_id=p_ledger_id and owner=p_owner for update;
  if v_id is null then select id into v_id from vault.secrets where name=v_name; end if;
  if v_id is null then select vault.create_secret(v_bundle,v_name,
    'Patreon OAuth token bundle for ledger '||p_ledger_id::text) into v_id;
  else perform vault.update_secret(v_id,v_bundle,v_name,
    'Patreon OAuth token bundle for ledger '||p_ledger_id::text); end if;
  insert into public.patreon_credentials as c(ledger_id,owner,patreon_user_id,campaign_id,campaign_name,
    campaign_url,granted_scopes,vault_secret_id,updated_at)
  values(p_ledger_id,p_owner,left(p_patreon_user_id,100),left(coalesce(p_campaign_id,''),100),
    left(coalesce(p_campaign_name,''),200),left(coalesce(p_campaign_url,''),1000),p_granted_scopes,v_id,now())
  on conflict(ledger_id) do update set patreon_user_id=excluded.patreon_user_id,campaign_id=excluded.campaign_id,
    campaign_name=excluded.campaign_name,campaign_url=excluded.campaign_url,
    granted_scopes=excluded.granted_scopes,vault_secret_id=excluded.vault_secret_id,updated_at=now();
  insert into public.account_connections as c(ledger_id,owner,provider,provider_subject,granted_scopes,
    connection_state,verification_method,verified_at,connected_at,last_checked_at,expires_at,error_code,updated_at)
  values(p_ledger_id,p_owner,'patreon',coalesce(p_campaign_id,''),p_granted_scopes,
    case when coalesce(p_campaign_id,'')='' then 'verified' else 'connected' end,
    'patreon_oauth2_v2_read',now(),case when coalesce(p_campaign_id,'')='' then null else now() end,
    now(),p_expires_at,'',now())
  on conflict(ledger_id) do update set provider='patreon',provider_subject=excluded.provider_subject,
    granted_scopes=excluded.granted_scopes,connection_state=excluded.connection_state,
    verification_method=excluded.verification_method,verified_at=now(),connected_at=excluded.connected_at,
    last_checked_at=now(),expires_at=excluded.expires_at,error_code='',updated_at=now();
  return v_id;
end;
$$;

create or replace function public.patreon_get_token_bundle(p_ledger_id uuid,p_owner uuid)
returns table(patreon_user_id text,campaign_id text,campaign_name text,campaign_url text,
  granted_scopes text[],token_bundle jsonb)
language sql security definer set search_path='' as $$
  select c.patreon_user_id,c.campaign_id,c.campaign_name,c.campaign_url,c.granted_scopes,
    s.decrypted_secret::jsonb from public.patreon_credentials c
  join vault.decrypted_secrets s on s.id=c.vault_secret_id
  where c.ledger_id=p_ledger_id and c.owner=p_owner;
$$;

create or replace function public.patreon_set_campaign_binding_service(
  p_ledger_id uuid,p_owner uuid,p_campaign_id text,p_campaign_name text,p_campaign_url text
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if trim(coalesce(p_campaign_id,''))='' or exists(select 1 from public.patreon_credentials
    where owner=p_owner and campaign_id=p_campaign_id and ledger_id<>p_ledger_id)
    then raise exception 'Invalid or duplicate Patreon campaign binding'; end if;
  update public.patreon_credentials set campaign_id=left(p_campaign_id,100),
    campaign_name=left(coalesce(p_campaign_name,''),200),campaign_url=left(coalesce(p_campaign_url,''),1000),
    updated_at=now() where ledger_id=p_ledger_id and owner=p_owner;
  get diagnostics v_count=row_count; if v_count=0 then return false; end if;
  update public.account_connections set provider_subject=left(p_campaign_id,100),connection_state='connected',
    connected_at=now(),last_checked_at=now(),error_code='',updated_at=now()
    where ledger_id=p_ledger_id and owner=p_owner and provider='patreon';
  return true;
end;
$$;

create or replace function public.patreon_delete_token_bundle(p_ledger_id uuid,p_owner uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin delete from public.patreon_credentials where ledger_id=p_ledger_id and owner=p_owner;
  get diagnostics v_count=row_count;
  update public.account_connections set provider_subject='',granted_scopes='{}',connection_state='disconnected',
    expires_at=null,error_code='',last_checked_at=now(),updated_at=now()
    where ledger_id=p_ledger_id and owner=p_owner and provider='patreon';
  return v_count>0; end;
$$;

create or replace function public.delete_patreon_vault_secret()
returns trigger language plpgsql security definer set search_path='' as $$
begin delete from vault.secrets where id=old.vault_secret_id; return old; end; $$;
drop trigger if exists patreon_credentials_delete_vault_secret on public.patreon_credentials;
create trigger patreon_credentials_delete_vault_secret after delete on public.patreon_credentials
  for each row execute function public.delete_patreon_vault_secret();

create or replace function public.patreon_handoff_hash(
  p_handoff_id uuid,p_draft_hash text,p_campaign_id text,p_publish_mode text,
  p_audience text,p_scheduled_for timestamptz,p_timezone text,p_preview_version text
)
returns text language sql stable set search_path='' as $$
  select encode(extensions.digest(convert_to(jsonb_build_array(p_handoff_id,
    coalesce(p_draft_hash,''),coalesce(p_campaign_id,''),coalesce(p_publish_mode,''),
    coalesce(p_audience,''),p_scheduled_for,coalesce(p_timezone,''),
    coalesce(p_preview_version,''))::text,'UTF8'),'sha256'),'hex');
$$;

create or replace function public.prepare_patreon_native_handoff_service(
  p_owner uuid,p_draft_id uuid,p_publish_mode text,p_audience text,
  p_scheduled_for timestamptz,p_timezone text,p_preview_version text
)
returns public.patreon_native_handoffs language plpgsql security definer set search_path='' as $$
declare d public.drafts%rowtype; c public.account_connections%rowtype;
  v_id uuid:=gen_random_uuid(); v_hash text; v_generic_hash text;
  result public.patreon_native_handoffs%rowtype;
begin
  select * into d from public.drafts where id=p_draft_id and owner=p_owner;
  if not found or d.platform<>'patreon' or d.account_id is null or d.persona_id is null
    or d.approval_state<>'approved' or d.approved_content_hash !~ '^[0-9a-f]{64}$'
    then raise exception 'Approve the exact Patreon copy package first'; end if;
  if public.agent_draft_hash(d.title,d.body,d.tags,d.media_url,d.content_kind,d.persona_id,
    d.account_id,d.platform,d.publish_at)<>d.approved_content_hash
    then raise exception 'The Patreon copy package changed after approval'; end if;
  if p_publish_mode not in ('save_draft','publish_now','schedule')
    or p_audience not in ('public','free_members','paid_members','select_tiers')
    or p_preview_version<>'patreon-native-preview-v1'
    or (p_publish_mode='schedule' and (p_scheduled_for is null or p_scheduled_for<=now()))
    or (p_publish_mode<>'schedule' and p_scheduled_for is not null)
    then raise exception 'Review the complete Patreon native-editor settings'; end if;
  if char_length(coalesce(p_timezone,'')) not between 1 and 80
    or not exists(select 1 from pg_catalog.pg_timezone_names zone where zone.name=p_timezone) then
    raise exception 'Choose one valid immutable Patreon preview time zone';
  end if;
  if not exists(select 1 from public.agent_owner_settings where owner=p_owner and not automation_paused)
    then raise exception 'Owner automation is paused or unavailable'; end if;
  if not exists(select 1 from public.account_ledger l where l.id=d.account_id and l.owner=p_owner
    and l.provider='patreon' and not coalesce(l.suspended,false) and
    (l.persona_id=d.persona_id or exists(select 1 from public.account_persona_links x
      where x.ledger_id=l.id and x.owner=p_owner and x.persona_id=d.persona_id)))
    then raise exception 'The Patreon campaign is no longer assigned to this persona'; end if;
  select * into c from public.account_connections where ledger_id=d.account_id and owner=p_owner
    and provider='patreon' and connection_state='connected' and provider_subject<>''
    and array['identity','campaigns','campaigns.posts'] <@ granted_scopes;
  v_generic_hash:=public.agent_draft_preview_hash(d.approved_content_hash,d.approved_preview_version,
    d.approved_preview_target_id);
  if not found or d.approved_preview_version<>'platform-preview-v1'
    or d.approved_preview_target_id<>c.provider_subject
    or d.approved_previewed_at is null or d.approved_previewed_at>now()
    or d.approved_preview_hash<>v_generic_hash
    then raise exception 'Review the exact Patreon campaign preview'; end if;
  v_hash:=public.patreon_handoff_hash(v_id,d.approved_content_hash,c.provider_subject,p_publish_mode,
    p_audience,p_scheduled_for,p_timezone,p_preview_version);
  insert into public.patreon_native_handoffs(id,owner,draft_id,ledger_id,campaign_id,preview_version,
    draft_content_hash,publish_mode,audience,scheduled_for,timezone,package_hash,title,body,tags,media_url,
    native_editor_url)
  values(v_id,p_owner,d.id,d.account_id,c.provider_subject,p_preview_version,d.approved_content_hash,
    p_publish_mode,p_audience,p_scheduled_for,p_timezone,v_hash,coalesce(d.title,''),coalesce(d.body,''),
    coalesce(d.tags,''),coalesce(d.media_url,''),'https://www.patreon.com/posts/new') returning * into result;
  insert into public.agent_actions(owner,persona_id,action_type,entity_type,entity_id,outcome,detail)
  values(p_owner,d.persona_id,'patreon.native_handoff_prepared','draft',d.id,'prepared',
    jsonb_build_object('handoff_id',v_id,'campaign_id',c.provider_subject,'package_hash',v_hash,
      'publish_mode',p_publish_mode,'audience',p_audience,'scheduled_for',p_scheduled_for,
      'timezone',p_timezone,
      'provider_write_performed',false));
  return result;
end;
$$;

create or replace function public.update_patreon_native_handoff_service(
  p_owner uuid,p_handoff_id uuid,p_status text,p_owner_completion_note text
)
returns public.patreon_native_handoffs language plpgsql security definer set search_path='' as $$
declare result public.patreon_native_handoffs%rowtype;
begin
  if p_status='opened' then
    raise exception 'Use the acknowledged one-shot Patreon preview wrapper to open a handoff';
  end if;
  if p_status not in ('owner_completed','abandoned') then raise exception 'Invalid Patreon handoff state'; end if;
  update public.patreon_native_handoffs set status=p_status,
    opened_at=case when p_status in ('opened','owner_completed') then coalesce(opened_at,now()) else opened_at end,
    owner_completed_at=case when p_status='owner_completed' then now() else owner_completed_at end,
    owner_completion_note=case when p_status='owner_completed' then left(coalesce(p_owner_completion_note,''),1000)
      else owner_completion_note end
  where id=p_handoff_id and owner=p_owner
    and ((p_status='owner_completed' and status='opened')
      or (p_status='abandoned' and status in ('prepared','opened')))
  returning * into result;
  if not found then raise exception 'Patreon handoff changed or is already closed'; end if;
  return result;
end;
$$;

create or replace function public.open_patreon_native_handoff_with_preview_service(
  p_owner uuid,p_handoff_id uuid,p_receipt_id uuid
) returns public.patreon_native_handoffs
language plpgsql security definer set search_path='' as $$
declare
  h public.patreon_native_handoffs%rowtype;
  d public.drafts%rowtype;
  c public.account_connections%rowtype;
  v_generic_hash text;
  v_package_hash text;
  result public.patreon_native_handoffs%rowtype;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role'
    then raise exception 'Patreon handoff opening is service-only'; end if;
  select * into h from public.patreon_native_handoffs
  where id=p_handoff_id and owner=p_owner and status='prepared' for update;
  if not found then raise exception 'Prepared Patreon handoff not found or already opened'; end if;
  select * into d from public.drafts where id=h.draft_id and owner=p_owner for update;
  select * into c from public.account_connections
    where ledger_id=h.ledger_id and owner=p_owner and provider='patreon'
      and connection_state='connected' for share;
  if d.id is null or c.ledger_id is null or d.account_id is distinct from h.ledger_id
    or d.platform<>'patreon' or d.approval_state<>'approved'
    or public.agent_draft_hash(d.title,d.body,d.tags,d.media_url,d.content_kind,
      d.persona_id,d.account_id,d.platform,d.publish_at) is distinct from h.draft_content_hash
    or d.approved_content_hash is distinct from h.draft_content_hash
    or c.provider_subject is distinct from h.campaign_id then
    raise exception 'The Patreon draft, campaign, or approval changed after preview';
  end if;
  v_generic_hash:=public.agent_draft_preview_hash(d.approved_content_hash,
    d.approved_preview_version,d.approved_preview_target_id);
  if d.approved_preview_version<>'platform-preview-v1'
    or d.approved_preview_target_id is distinct from c.provider_subject
    or d.approved_previewed_at is null or d.approved_previewed_at>now()
    or d.approved_preview_hash is distinct from v_generic_hash then
    raise exception 'The exact Patreon campaign preview changed';
  end if;
  v_package_hash:=public.patreon_handoff_hash(h.id,d.approved_content_hash,
    c.provider_subject,h.publish_mode,h.audience,h.scheduled_for,h.timezone,h.preview_version);
  if v_package_hash is distinct from h.package_hash then
    raise exception 'The Patreon handoff package failed integrity verification'; end if;
  perform public.consume_provider_action_preview_service(
    p_owner,d.id,h.ledger_id,'patreon','patreon.'||h.publish_mode,p_receipt_id,
    h.campaign_id,d.approved_content_hash,h.package_hash
  );
  update public.patreon_native_handoffs set status='opened',opened_at=now()
  where id=h.id and owner=p_owner and status='prepared' returning * into result;
  if not found then raise exception 'The Patreon handoff could not be opened atomically'; end if;
  return result;
end;
$$;

create or replace function public.guard_connected_patreon_ledger_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.provider='patreon' and exists(select 1 from public.patreon_credentials where ledger_id=old.id and owner=old.owner) then
    if tg_op='DELETE' then
      raise exception 'Revoke Patreon access and disconnect before deleting or retargeting this account';
    elsif new.owner is distinct from old.owner
      or new.provider is distinct from old.provider
      or new.username is distinct from old.username
      or new.url is distinct from old.url then
      raise exception 'Revoke Patreon access and disconnect before deleting or retargeting this account';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
drop trigger if exists guard_connected_patreon_ledger_change on public.account_ledger;
create trigger guard_connected_patreon_ledger_change before update or delete on public.account_ledger
  for each row execute function public.guard_connected_patreon_ledger_change();

-- All privileged helpers are explicit service-role APIs only.
revoke all on function public.twitch_required_scope(text),
  public.twitch_valid_action_payload(text,jsonb),
  public.twitch_action_approval_hash(uuid,text,text,text,jsonb,text),
  public.claim_twitch_operation(uuid,uuid,uuid,text,integer),
  public.release_twitch_operation(uuid,uuid,uuid),
  public.twitch_store_token_bundle(uuid,uuid,text,text,text,text,text,timestamptz,text[]),
  public.twitch_get_token_bundle(uuid,uuid),public.twitch_delete_token_bundle(uuid,uuid),
  public.delete_twitch_vault_secret(),
  public.twitch_record_action_preview_service(uuid,uuid,text,jsonb,text),
  public.claim_twitch_action_service(uuid,uuid,text,uuid,uuid,uuid),
  public.twitch_finish_action_service(uuid,uuid,text,integer,text,jsonb,text,text),
  public.invalidate_twitch_approval_on_draft_change(),public.guard_connected_twitch_ledger_change(),
  public.claim_patreon_operation(uuid,uuid,uuid,text,integer),
  public.release_patreon_operation(uuid,uuid,uuid),
  public.patreon_store_token_bundle(uuid,uuid,text,text,text,text,text,text,timestamptz,text[]),
  public.patreon_get_token_bundle(uuid,uuid),public.patreon_set_campaign_binding_service(uuid,uuid,text,text,text),
  public.patreon_delete_token_bundle(uuid,uuid),public.delete_patreon_vault_secret(),
  public.patreon_handoff_hash(uuid,text,text,text,text,timestamptz,text,text),
  public.prepare_patreon_native_handoff_service(uuid,uuid,text,text,timestamptz,text,text),
  public.open_patreon_native_handoff_with_preview_service(uuid,uuid,uuid),
  public.update_patreon_native_handoff_service(uuid,uuid,text,text),
  public.guard_connected_patreon_ledger_change()
from public,anon,authenticated;

grant execute on function public.twitch_required_scope(text),
  public.twitch_valid_action_payload(text,jsonb),
  public.twitch_action_approval_hash(uuid,text,text,text,jsonb,text),
  public.claim_twitch_operation(uuid,uuid,uuid,text,integer),
  public.release_twitch_operation(uuid,uuid,uuid),
  public.twitch_store_token_bundle(uuid,uuid,text,text,text,text,text,timestamptz,text[]),
  public.twitch_get_token_bundle(uuid,uuid),public.twitch_delete_token_bundle(uuid,uuid),
  public.twitch_record_action_preview_service(uuid,uuid,text,jsonb,text),
  public.claim_twitch_action_service(uuid,uuid,text,uuid,uuid,uuid),
  public.twitch_finish_action_service(uuid,uuid,text,integer,text,jsonb,text,text),
  public.claim_patreon_operation(uuid,uuid,uuid,text,integer),
  public.release_patreon_operation(uuid,uuid,uuid),
  public.patreon_store_token_bundle(uuid,uuid,text,text,text,text,text,text,timestamptz,text[]),
  public.patreon_get_token_bundle(uuid,uuid),public.patreon_set_campaign_binding_service(uuid,uuid,text,text,text),
  public.patreon_delete_token_bundle(uuid,uuid),
  public.patreon_handoff_hash(uuid,text,text,text,text,timestamptz,text,text),
  public.prepare_patreon_native_handoff_service(uuid,uuid,text,text,timestamptz,text,text),
  public.open_patreon_native_handoff_with_preview_service(uuid,uuid,uuid),
  public.update_patreon_native_handoff_service(uuid,uuid,text,text)
to service_role;

comment on table public.twitch_action_approvals is
  'Owner-readable exact Twitch feature-preview receipts. Twitch is not a general feed/video publisher.';
comment on table public.patreon_native_handoffs is
  'Previewed copy packages for owner completion in Patreon native post editor; no provider write is performed.';

commit;
