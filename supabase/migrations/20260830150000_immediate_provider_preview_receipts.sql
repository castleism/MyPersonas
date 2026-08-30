-- Server-authored, short-lived preview receipts for owner-triggered writes.
--
-- Generic platform approval (migration 069) and the Meta composer preview are
-- necessary first reviews, but they are not an action-time authorization. This
-- migration adds a second, provider-specific receipt generated from the current
-- database row and exact live destination. The receipt expires quickly, is
-- consumed once in the same transaction that claims the draft, and cannot be
-- used for a future-scheduled row.
begin;

create table if not exists public.immediate_provider_preview_receipts (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_table text not null check (draft_table in ('drafts','post_drafts')),
  draft_id uuid not null,
  provider text not null check (provider in ('meta','twitter','reddit','discord')),
  action text not null check (char_length(action) between 1 and 80),
  target_id text not null check (char_length(target_id) between 1 and 1024),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  preview_payload jsonb not null check (jsonb_typeof(preview_payload) = 'object'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles(id) on delete set null,
  consumed_at timestamptz,
  consumed_claim_id uuid,
  invalidated_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '5 minutes'),
  check (
    (acknowledged_at is null and acknowledged_by is null)
    or (acknowledged_at is not null and acknowledged_by is not null
      and acknowledged_at >= created_at and acknowledged_at < expires_at)
  ),
  check (
    (consumed_at is null and consumed_claim_id is null)
    or (consumed_at is not null and consumed_claim_id is not null)
  )
);

alter table public.immediate_provider_preview_receipts
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by uuid references public.profiles(id) on delete set null;

alter table public.immediate_provider_preview_receipts
  drop constraint if exists immediate_provider_preview_receipts_acknowledgement_check,
  add constraint immediate_provider_preview_receipts_acknowledgement_check check (
    (acknowledged_at is null and acknowledged_by is null)
    or (acknowledged_at is not null and acknowledged_by is not null
      and acknowledged_at >= created_at and acknowledged_at < expires_at)
  );

create index if not exists immediate_provider_preview_receipts_owner_draft_idx
  on public.immediate_provider_preview_receipts
  (owner,draft_table,draft_id,provider,action,created_at desc);
create index if not exists immediate_provider_preview_receipts_expiry_idx
  on public.immediate_provider_preview_receipts (expires_at)
  where consumed_at is null and invalidated_at is null;

alter table public.immediate_provider_preview_receipts enable row level security;
revoke all on public.immediate_provider_preview_receipts
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.immediate_provider_preview_receipts to service_role;

comment on table public.immediate_provider_preview_receipts is
  'Server-authored, action-specific, one-shot receipts for immediate provider writes. Browser roles have no table access.';

create or replace function public.immediate_agent_preview_snapshot_service(
  p_owner uuid,
  p_draft_id uuid,
  p_provider text,
  p_action text
)
returns table(content_hash text,target_id text,preview_payload jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_ledger public.account_ledger%rowtype;
  v_connection public.account_connections%rowtype;
  v_hash text;
  v_preview_hash text;
  v_provider text := lower(trim(coalesce(p_provider,'')));
  v_expected_action text;
  v_target text;
  v_target_label text;
  v_text text;
  v_title text;
  v_media text;
  v_destination text;
  v_match text[];
  v_is_link boolean := false;
  v_x_plain text := '';
  v_x_url text;
  v_x_url_count integer := 0;
  v_x_weight integer := 0;
  v_x_ambiguous boolean := false;
  v_x_sequence_ambiguous boolean := false;
  v_details jsonb := '[]'::jsonb;
begin
  if v_provider not in ('twitter','reddit','discord') then
    raise exception 'Unsupported immediate provider';
  end if;
  v_expected_action := v_provider || '.publish_now';
  if p_action is distinct from v_expected_action then
    raise exception 'The requested action does not match this provider';
  end if;

  select * into v_draft from public.drafts
  where id = p_draft_id and owner = p_owner for update;
  if not found then raise exception 'Owned draft not found'; end if;
  if v_draft.platform is distinct from v_provider or v_draft.account_id is null then
    raise exception 'The draft provider or destination changed';
  end if;
  if v_draft.publish_at is not null and v_draft.publish_at > now() then
    raise exception 'A future-scheduled draft cannot be posted now. Edit its time and approve the exact revision again';
  end if;
  if v_draft.approval_state <> 'approved'
    or coalesce(v_draft.approved_content_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'Exact owner approval is required';
  end if;
  v_hash := public.agent_draft_hash(
    v_draft.title,v_draft.body,v_draft.tags,v_draft.media_url,
    v_draft.content_kind,v_draft.persona_id,v_draft.account_id,
    v_draft.platform,v_draft.publish_at
  );
  if v_hash is distinct from v_draft.approved_content_hash then
    raise exception 'Approval no longer matches this exact draft';
  end if;
  if v_draft.publish_state in ('publishing','published','blocked')
    or coalesce(v_draft.provider_post_id,'') <> '' then
    raise exception 'This draft is already publishing, published, or needs reconciliation';
  end if;

  select * into v_ledger from public.account_ledger
  where id = v_draft.account_id and owner = p_owner and provider = v_provider
    and not coalesce(suspended,false) for share;
  if not found then raise exception 'The exact provider destination is unavailable'; end if;
  if v_draft.persona_id is null then raise exception 'Draft persona is required'; end if;
  if v_ledger.persona_id is distinct from v_draft.persona_id and not exists (
    select 1 from public.account_persona_links
    where ledger_id = v_ledger.id and owner = p_owner
      and persona_id = v_draft.persona_id
  ) then
    raise exception 'The destination is no longer assigned to this persona';
  end if;
  select * into v_connection from public.account_connections
  where ledger_id = v_ledger.id and owner = p_owner and provider = v_provider
    and connection_state = 'connected' for share;
  if not found or nullif(trim(v_connection.provider_subject),'') is null then
    raise exception 'The exact provider connection is unavailable';
  end if;
  if v_provider = 'twitter'
    and not ('tweet.write' = any(coalesce(v_connection.granted_scopes,array[]::text[]))) then
    raise exception 'The X connection no longer grants tweet.write';
  elsif v_provider = 'reddit'
    and not ('submit' = any(coalesce(v_connection.granted_scopes,array[]::text[]))) then
    raise exception 'The Reddit connection no longer grants submit';
  elsif v_provider = 'discord'
    and not ('webhook.incoming' = any(coalesce(v_connection.granted_scopes,array[]::text[]))) then
    raise exception 'The Discord connection no longer grants webhook.incoming';
  end if;

  v_preview_hash := public.agent_draft_preview_hash(
    v_draft.approved_content_hash,v_draft.approved_preview_version,
    v_draft.approved_preview_target_id
  );
  if v_draft.approved_preview_version <> 'platform-preview-v1'
    or v_draft.approved_previewed_at is null
    or v_draft.approved_previewed_at > now()
    or v_draft.approved_preview_target_id is distinct from trim(v_connection.provider_subject)
    or coalesce(v_draft.approved_preview_hash,'') !~ '^[0-9a-f]{64}$'
    or v_draft.approved_preview_hash is distinct from v_preview_hash then
    raise exception 'Review and approve the current exact-platform preview first';
  end if;

  if v_provider = 'twitter' then
    v_target := trim(v_connection.provider_subject);
    v_target_label := '@' || regexp_replace(lower(trim(coalesce(v_ledger.username,''))),'^@','','g');
    v_text := concat_ws(E'\n\n',
      nullif(trim(coalesce(v_draft.body,'')),''),
      case when nullif(trim(coalesce(v_draft.body,'')),'') is null
        then nullif(trim(coalesce(v_draft.title,'')),'') else null end,
      nullif(trim(coalesce(v_draft.tags,'')),'')
    );
    v_x_plain := regexp_replace(v_text,'https?://[^[:space:]]+','','gi');
    for v_x_url in
      select matches[1] from regexp_matches(v_text,'(https?://[^[:space:]]+)','gi') matches
    loop
      v_x_url_count := v_x_url_count + 1;
      if octet_length(v_x_url) <> char_length(v_x_url)
        or v_x_url !~ '^[!-~]+$'
        or right(v_x_url,1) = any(array['.',',','!','?',';',':',')',']','}'])
        or position('(' in v_x_url)>0 or position('[' in v_x_url)>0
        or position('{' in v_x_url)>0 or position('<' in v_x_url)>0
        or position(chr(92) in v_x_url)>0 or position('"' in v_x_url)>0 then
        v_x_ambiguous := true;
      end if;
    end loop;
    if v_text ~* '[[:alnum:]_]https?://'
      or v_x_plain ~* 'www[.]|(^|[^[:alnum:]_-])([[:alnum:]-]{1,63}[.])+[[:alpha:]]{2,63}($|[^[:alnum:]_-])|(^|[^0-9])([0-9]{1,3}[.]){3}[0-9]{1,3}($|[^0-9])'
      or position(U&'\3002' in v_x_plain)>0
      or position(U&'\FF0E' in v_x_plain)>0
      or position(U&'\FF61' in v_x_plain)>0 then
      v_x_ambiguous := true;
    end if;
    select coalesce(sum(case
        when codepoint<=4351
          or codepoint between 8192 and 8205
          or codepoint between 8208 and 8223
          or codepoint between 8242 and 8247 then 1 else 2 end),0),
      coalesce(bool_or(codepoint in (8205,8419,65038,65039)
        or codepoint between 127462 and 127487
        or codepoint between 127995 and 127999
        or codepoint between 917536 and 917631
        or (codepoint<32 and codepoint<>10) or codepoint=127),false)
    into v_x_weight,v_x_sequence_ambiguous
    from (select ascii(x_character) codepoint
      from regexp_split_to_table(v_x_plain,'') as x_character) weighted;
    v_x_weight := v_x_weight + v_x_url_count * 23;
    if v_x_ambiguous or v_x_sequence_ambiguous then
      raise exception 'Exact X weighted length cannot be guaranteed. Use plain text, unambiguous https:// URLs, and no complex emoji sequences';
    end if;
    if v_x_weight not between 1 and 280 then
      raise exception 'The exact X weighted length must contain 1 to 280 units';
    end if;
    if nullif(trim(coalesce(v_draft.media_url,'')),'') is not null then
      raise exception 'The current X writer is text-only';
    end if;
    v_title := '';
    v_media := '';
    v_details := jsonb_build_array(
      'Text-only X create-post action',
      'Exact X weighted length: ' || v_x_weight::text || ' / 280',
      'Conservative rule: supported Unicode ranges are weighted 1 or 2 and unambiguous explicit URLs are 23',
      'Exact provider subject: ' || v_target,
      'Provider disclosure: made_with_ai=true',
      'No media upload or background schedule'
    );
  elsif v_provider = 'reddit' then
    v_match := regexp_match(coalesce(v_draft.tags,''),
      '(?:^|[[:space:],])r/([A-Za-z0-9_]{2,21})','i');
    if v_match is not null then
      v_destination := 'r/' || v_match[1];
    else
      v_destination := 'u/' || regexp_replace(
        lower(trim(coalesce(v_ledger.username,''))),'^(?:@|/?u/)','','i'
      );
    end if;
    if v_destination in ('u/','r/') then raise exception 'Reddit destination is unavailable'; end if;
    v_target := trim(v_connection.provider_subject) || '|destination:' || lower(v_destination);
    v_target_label := v_destination;
    v_title := left(coalesce(nullif(trim(v_draft.title),''),
      nullif(left(trim(v_draft.body),250),''),'Untitled post'),300);
    v_media := trim(coalesce(v_draft.media_url,''));
    if nullif(v_media,'') is not null and v_media !~ '^https://[^[:space:]]+$' then
      raise exception 'Reddit link media must be one credential-free https:// URL';
    end if;
    if nullif(v_media,'') is not null
      and nullif(trim(coalesce(v_draft.body,'')),'') is not null then
      raise exception 'Reddit cannot send attached media with a self/text post. Remove the media or the body and preview again';
    end if;
    v_is_link := v_media ~ '^https://[^[:space:]]+$'
      and nullif(trim(coalesce(v_draft.body,'')),'') is null;
    v_text := case when v_is_link then '' else concat_ws(E'\n\n',
      nullif(trim(coalesce(v_draft.body,'')),''),
      nullif(trim(coalesce(v_draft.tags,'')),'')
    ) end;
    v_details := jsonb_build_array(
      case when v_is_link then 'Reddit link post' else 'Reddit self/text post' end,
      'Exact OAuth subject and destination: ' || v_target,
      'Immediate submit only; no background schedule'
    );
  else
    select binding.channel_id into v_target
    from public.discord_channel_bindings binding
    where binding.ledger_id = v_ledger.id and binding.owner = p_owner;
    if nullif(v_target,'') is null
      or v_target is distinct from trim(v_connection.provider_subject) then
      raise exception 'The exact Discord channel binding changed';
    end if;
    v_target_label := coalesce(nullif(trim(v_ledger.username),''),'Authorized Discord channel');
    v_text := concat_ws(E'\n\n',
      case when nullif(trim(v_draft.title),'') is not null
        then '**' || trim(v_draft.title) || '**' else null end,
      nullif(trim(coalesce(v_draft.body,'')),''),
      nullif(trim(coalesce(v_draft.tags,'')),''),
      nullif(trim(coalesce(v_draft.media_url,'')),'')
    );
    if nullif(v_text,'') is null or char_length(v_text) > 2000 then
      raise exception 'The exact Discord message must contain 1 to 2,000 characters';
    end if;
    v_title := '';
    v_media := '';
    v_details := jsonb_build_array(
      'Exact Discord channel ID: ' || v_target,
      'Exact outgoing package: ' || char_length(v_text)::text || ' / 2,000 characters',
      'Mention parsing is disabled',
      'Owner-triggered message now; no background schedule or retry'
    );
  end if;

  content_hash := v_hash;
  target_id := v_target;
  preview_payload := jsonb_build_object(
    'provider',v_provider,'action',v_expected_action,'draftId',v_draft.id,
    'contentHash',v_hash,'targetId',v_target,
    'providerPayload',case when v_provider = 'twitter'
      then jsonb_build_object('text',v_text,'made_with_ai',true,
        'weightedLength',v_x_weight,'weightingRule','x-conservative-v1')
      else null end,
    'items',jsonb_build_array(jsonb_build_object(
      'provider',v_provider,'account',v_target_label,'accountId',v_target,
      'title',coalesce(v_title,''),'text',coalesce(v_text,''),
      'tags','',
      'mediaUrl',case when v_is_link then v_media else '' end,
      'mediaKind',case when v_is_link then 'link' else v_draft.content_kind end,
      'scheduledFor',null,'mode','Immediate provider write',
      'timingLabel','Immediately after approval',
      'platformDetails',v_details
    ))
  );
  return next;
end;
$$;

revoke all on function public.immediate_agent_preview_snapshot_service(
  uuid,uuid,text,text
) from public, anon, authenticated, service_role;

create or replace function public.immediate_meta_preview_snapshot_service(
  p_owner uuid,
  p_draft_id uuid,
  p_action text
)
returns table(content_hash text,target_id text,preview_payload jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.post_drafts%rowtype;
  v_page public.meta_page_connections%rowtype;
  v_targets text[];
  v_pending text[];
  v_target text;
  v_hash text;
  v_items jsonb := '[]'::jsonb;
begin
  if p_action is distinct from 'meta.publish_now' then
    raise exception 'The requested action does not match Meta publishing';
  end if;
  select * into v_draft from public.post_drafts
  where id = p_draft_id and owner = p_owner for update;
  if not found then raise exception 'Owned Meta draft not found'; end if;
  if v_draft.status not in ('draft','approved','failed') then
    raise exception 'This Meta draft is scheduled, publishing, or read-only';
  end if;
  if v_draft.scheduled_for is not null and v_draft.scheduled_for > now() then
    raise exception 'A future-scheduled draft cannot be posted now. Unschedule, edit, and review it again';
  end if;
  if v_draft.persona_id is null or trim(coalesce(v_draft.facebook_ledger_id,'')) = '' then
    raise exception 'The Meta persona or destination is unavailable';
  end if;
  if not exists (
    select 1 from public.personas
    where id = v_draft.persona_id and owner = p_owner
  ) then raise exception 'The Meta persona is no longer owned'; end if;

  select coalesce(array_agg(target order by target),array[]::text[])
  into v_targets from (
    select distinct lower(trim(raw_target)) target
    from unnest(coalesce(v_draft.targets,array[]::text[])) raw_target
    where lower(trim(raw_target)) in ('facebook','instagram')
  ) normalized;
  if cardinality(v_targets) = 0
    or exists (
      select 1 from unnest(coalesce(v_draft.targets,array[]::text[])) t
      where lower(trim(t)) not in ('facebook','instagram')
    ) then
    raise exception 'Immediate Meta publishing requires only Facebook and/or Instagram';
  end if;
  select coalesce(array_agg(target order by target),array[]::text[])
  into v_pending from unnest(v_targets) target
  where (target = 'facebook' and v_draft.fb_post_id is null)
     or (target = 'instagram' and v_draft.ig_media_id is null);
  if cardinality(v_pending) = 0 then
    raise exception 'Every selected Meta destination already has a provider result';
  end if;

  select * into v_page from public.meta_page_connections
  where owner = p_owner
    and facebook_ledger_id::text = trim(v_draft.facebook_ledger_id)
  for share;
  if not found then raise exception 'The exact Meta Page connection is unavailable'; end if;
  if 'facebook' = any(v_pending)
    and (nullif(v_page.facebook_page_id,'') is null
      or v_draft.approved_fb_media_sha256 !~ '^[0-9a-f]{64}$'
      or nullif(v_draft.approved_fb_media_url,'') is null) then
    raise exception 'Facebook immutable preview media or target is unavailable';
  end if;
  if 'instagram' = any(v_pending)
    and (nullif(v_page.instagram_business_id,'') is null
      or v_draft.approved_ig_media_sha256 !~ '^[0-9a-f]{64}$'
      or nullif(v_draft.approved_ig_media_url,'') is null) then
    raise exception 'Instagram immutable preview media or target is unavailable';
  end if;
  if nullif(v_draft.publish_facebook_page_id,'') is not null
    and v_draft.publish_facebook_page_id is distinct from v_page.facebook_page_id then
    raise exception 'The Facebook Page changed after a prior provider result';
  end if;
  if nullif(v_draft.publish_instagram_business_id,'') is not null
    and v_draft.publish_instagram_business_id is distinct from coalesce(v_page.instagram_business_id,'') then
    raise exception 'The Instagram destination changed after a prior provider result';
  end if;

  v_target := concat_ws('|',
    case when 'facebook' = any(v_pending)
      then 'facebook:' || v_page.facebook_page_id else null end,
    case when 'instagram' = any(v_pending)
      then 'instagram:' || v_page.instagram_business_id else null end
  );
  v_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_draft.id,v_draft.persona_id,v_draft.facebook_ledger_id,v_pending,
    v_page.facebook_page_id,coalesce(v_page.instagram_business_id,''),
    v_draft.fb_caption,v_draft.ig_caption,
    v_draft.fb_image_url,v_draft.ig_image_url,v_draft.source_image_url,
    v_draft.approved_fb_media_sha256,v_draft.approved_fb_media_mime,
    v_draft.approved_fb_media_bytes,v_draft.approved_fb_media_path,
    v_draft.approved_fb_media_url,v_draft.approved_ig_media_sha256,
    v_draft.approved_ig_media_mime,v_draft.approved_ig_media_bytes,
    v_draft.approved_ig_media_path,v_draft.approved_ig_media_url,
    coalesce(v_draft.fb_post_id,''),coalesce(v_draft.ig_media_id,''),v_target
  )::text,'UTF8'),'sha256'),'hex');

  if 'facebook' = any(v_pending) then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'provider','facebook','account',coalesce(nullif(v_page.facebook_page_name,''),'Facebook Page'),
      'accountId',v_page.facebook_page_id,'title','',
      'text',v_draft.fb_caption,'tags','',
      'mediaUrl',v_draft.approved_fb_media_url,'mediaKind','image',
      'scheduledFor',null,'mode','Immediate provider write',
      'timingLabel','Immediately after approval',
      'platformDetails',jsonb_build_array(
        'Exact Facebook Page ID: ' || v_page.facebook_page_id,
        'Immutable media SHA-256: ' || v_draft.approved_fb_media_sha256,
        'Immediate Page photo post; no background schedule'
      )
    ));
  end if;
  if 'instagram' = any(v_pending) then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'provider','instagram',
      'account',case when nullif(v_page.instagram_username,'') is null
        then 'Linked Instagram professional account'
        else '@' || regexp_replace(v_page.instagram_username,'^@','','g') end,
      'accountId',v_page.instagram_business_id,'title','',
      'text',v_draft.ig_caption,'tags','',
      'mediaUrl',v_draft.approved_ig_media_url,'mediaKind','image',
      'scheduledFor',null,'mode','Immediate provider write',
      'timingLabel','Immediately after approval',
      'platformDetails',jsonb_build_array(
        'Exact Instagram business ID: ' || v_page.instagram_business_id,
        'Immutable media SHA-256: ' || v_draft.approved_ig_media_sha256,
        'Immediate media container publish; no background schedule'
      )
    ));
  end if;
  content_hash := v_hash;
  target_id := v_target;
  preview_payload := jsonb_build_object(
    'provider','meta','action','meta.publish_now','draftId',v_draft.id,
    'contentHash',v_hash,'targetId',v_target,'items',v_items
  );
  return next;
end;
$$;

revoke all on function public.immediate_meta_preview_snapshot_service(
  uuid,uuid,text
) from public, anon, authenticated, service_role;

create or replace function public.issue_immediate_agent_preview_receipt_service(
  p_owner uuid,p_draft_id uuid,p_provider text,p_action text
)
returns table(
  receipt_id uuid,receipt_hash text,preview_payload jsonb,
  created_at timestamptz,expires_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_content_hash text;
  v_target text;
  v_payload jsonb;
  v_id uuid := gen_random_uuid();
  v_created timestamptz := clock_timestamp();
  v_expires timestamptz;
  v_hash text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Immediate preview receipts are service-only';
  end if;
  select snapshot.content_hash,snapshot.target_id,snapshot.preview_payload
  into v_content_hash,v_target,v_payload
  from public.immediate_agent_preview_snapshot_service(
    p_owner,p_draft_id,p_provider,p_action
  ) snapshot;
  v_expires := v_created + interval '3 minutes';
  v_payload := v_payload || jsonb_build_object(
    'receiptVersion','immediate-provider-preview-v1',
    'receiptId',v_id,'createdAt',v_created,'expiresAt',v_expires
  );
  v_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_id,p_owner,'drafts',p_draft_id,lower(trim(p_provider)),p_action,
    v_target,v_content_hash,v_payload,v_created,v_expires
  )::text,'UTF8'),'sha256'),'hex');
  v_payload := v_payload || jsonb_build_object('receiptHash',v_hash);
  update public.immediate_provider_preview_receipts set invalidated_at = v_created
  where owner = p_owner and draft_table = 'drafts' and draft_id = p_draft_id
    and provider = lower(trim(p_provider)) and action = p_action
    and consumed_at is null and invalidated_at is null;
  insert into public.immediate_provider_preview_receipts(
    id,owner,draft_table,draft_id,provider,action,target_id,content_hash,
    receipt_hash,preview_payload,created_at,expires_at
  ) values (
    v_id,p_owner,'drafts',p_draft_id,lower(trim(p_provider)),p_action,
    v_target,v_content_hash,v_hash,v_payload,v_created,v_expires
  );
  receipt_id := v_id; receipt_hash := v_hash; preview_payload := v_payload;
  created_at := v_created; expires_at := v_expires;
  return next;
end;
$$;

revoke all on function public.issue_immediate_agent_preview_receipt_service(
  uuid,uuid,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.issue_immediate_agent_preview_receipt_service(
  uuid,uuid,text,text
) to service_role;

create or replace function public.issue_immediate_meta_preview_receipt_service(
  p_owner uuid,p_draft_id uuid,p_action text
)
returns table(
  receipt_id uuid,receipt_hash text,preview_payload jsonb,
  created_at timestamptz,expires_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_content_hash text;
  v_target text;
  v_payload jsonb;
  v_id uuid := gen_random_uuid();
  v_created timestamptz := clock_timestamp();
  v_expires timestamptz;
  v_hash text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Immediate preview receipts are service-only';
  end if;
  select snapshot.content_hash,snapshot.target_id,snapshot.preview_payload
  into v_content_hash,v_target,v_payload
  from public.immediate_meta_preview_snapshot_service(
    p_owner,p_draft_id,p_action
  ) snapshot;
  v_expires := v_created + interval '3 minutes';
  v_payload := v_payload || jsonb_build_object(
    'receiptVersion','immediate-provider-preview-v1',
    'receiptId',v_id,'createdAt',v_created,'expiresAt',v_expires
  );
  v_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_id,p_owner,'post_drafts',p_draft_id,'meta',p_action,
    v_target,v_content_hash,v_payload,v_created,v_expires
  )::text,'UTF8'),'sha256'),'hex');
  v_payload := v_payload || jsonb_build_object('receiptHash',v_hash);
  update public.immediate_provider_preview_receipts set invalidated_at = v_created
  where owner = p_owner and draft_table = 'post_drafts' and draft_id = p_draft_id
    and provider = 'meta' and action = p_action
    and consumed_at is null and invalidated_at is null;
  insert into public.immediate_provider_preview_receipts(
    id,owner,draft_table,draft_id,provider,action,target_id,content_hash,
    receipt_hash,preview_payload,created_at,expires_at
  ) values (
    v_id,p_owner,'post_drafts',p_draft_id,'meta',p_action,
    v_target,v_content_hash,v_hash,v_payload,v_created,v_expires
  );
  receipt_id := v_id; receipt_hash := v_hash; preview_payload := v_payload;
  created_at := v_created; expires_at := v_expires;
  return next;
end;
$$;

revoke all on function public.issue_immediate_meta_preview_receipt_service(
  uuid,uuid,text
) from public, anon, authenticated, service_role;
grant execute on function public.issue_immediate_meta_preview_receipt_service(
  uuid,uuid,text
) to service_role;

-- Receipt creation and owner authorization are deliberately separate. The
-- browser can display an unacknowledged server snapshot, but only an AAL2
-- owner session can move that exact immutable receipt to acknowledged.
create or replace function public.acknowledge_immediate_provider_preview_receipt(
  p_receipt_id uuid,
  p_draft_id uuid,
  p_provider text,
  p_action text
)
returns table(
  receipt_id uuid,receipt_hash text,preview_payload jsonb,
  created_at timestamptz,expires_at timestamptz,acknowledged_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_provider text := lower(trim(coalesce(p_provider,'')));
  v_content_hash text;
  v_target text;
  v_payload jsonb;
  v_receipt public.immediate_provider_preview_receipts%rowtype;
  v_expected_hash text;
  v_acknowledged timestamptz := clock_timestamp();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform public.require_aal2();
  if v_provider not in ('meta','twitter','reddit','discord')
    or p_action is distinct from v_provider || '.publish_now' then
    raise exception 'The acknowledgement action does not match this provider';
  end if;

  if v_provider = 'meta' then
    select snapshot.content_hash,snapshot.target_id,snapshot.preview_payload
      into v_content_hash,v_target,v_payload
    from public.immediate_meta_preview_snapshot_service(
      v_owner,p_draft_id,p_action
    ) snapshot;
  else
    select snapshot.content_hash,snapshot.target_id,snapshot.preview_payload
      into v_content_hash,v_target,v_payload
    from public.immediate_agent_preview_snapshot_service(
      v_owner,p_draft_id,v_provider,p_action
    ) snapshot;
  end if;

  select * into v_receipt from public.immediate_provider_preview_receipts
  where id = p_receipt_id and owner = v_owner
    and draft_table = case when v_provider = 'meta' then 'post_drafts' else 'drafts' end
    and draft_id = p_draft_id and provider = v_provider and action = p_action
  for update;
  if not found or v_receipt.consumed_at is not null
    or v_receipt.invalidated_at is not null
    or v_receipt.expires_at <= v_acknowledged
    or v_receipt.created_at > v_acknowledged
    or v_receipt.target_id is distinct from v_target
    or v_receipt.content_hash is distinct from v_content_hash then
    raise exception 'The server preview receipt is missing, expired, used, or no longer matches this exact action';
  end if;
  v_expected_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_receipt.id,v_receipt.owner,v_receipt.draft_table,v_receipt.draft_id,
    v_receipt.provider,v_receipt.action,v_receipt.target_id,v_receipt.content_hash,
    v_receipt.preview_payload - 'receiptHash',v_receipt.created_at,v_receipt.expires_at
  )::text,'UTF8'),'sha256'),'hex');
  if v_receipt.receipt_hash is distinct from v_expected_hash
    or v_receipt.preview_payload ->> 'receiptHash' is distinct from v_receipt.receipt_hash then
    raise exception 'The server preview receipt failed integrity verification';
  end if;

  if v_receipt.acknowledged_at is null then
    update public.immediate_provider_preview_receipts as stored set
      acknowledged_at = v_acknowledged,acknowledged_by = v_owner
    where stored.id = v_receipt.id and stored.acknowledged_at is null
      and stored.consumed_at is null and stored.invalidated_at is null
    returning stored.* into v_receipt;
    if not found then raise exception 'The server preview receipt changed before acknowledgement'; end if;
  elsif v_receipt.acknowledged_by is distinct from v_owner then
    raise exception 'The server preview receipt was acknowledged by a different owner';
  end if;

  receipt_id := v_receipt.id;
  receipt_hash := v_receipt.receipt_hash;
  preview_payload := v_receipt.preview_payload;
  created_at := v_receipt.created_at;
  expires_at := v_receipt.expires_at;
  acknowledged_at := v_receipt.acknowledged_at;
  return next;
end;
$$;

revoke all on function public.acknowledge_immediate_provider_preview_receipt(
  uuid,uuid,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_immediate_provider_preview_receipt(
  uuid,uuid,text,text
) to authenticated;

create or replace function public.consume_immediate_agent_preview_receipt_service(
  p_owner uuid,p_draft_id uuid,p_provider text,p_action text,
  p_receipt_id uuid,p_claim_id uuid
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_content_hash text;
  v_target text;
  v_payload jsonb;
  v_receipt public.immediate_provider_preview_receipts%rowtype;
  v_expected_hash text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Immediate preview receipt consumption is service-only';
  end if;
  select snapshot.content_hash,snapshot.target_id,snapshot.preview_payload
  into v_content_hash,v_target,v_payload
  from public.immediate_agent_preview_snapshot_service(
    p_owner,p_draft_id,p_provider,p_action
  ) snapshot;
  select * into v_receipt from public.immediate_provider_preview_receipts
  where id = p_receipt_id and owner = p_owner and draft_table = 'drafts'
    and draft_id = p_draft_id and provider = lower(trim(p_provider))
    and action = p_action for update;
  if not found or v_receipt.consumed_at is not null
    or v_receipt.invalidated_at is not null or v_receipt.expires_at <= clock_timestamp()
    or v_receipt.created_at > clock_timestamp()
    or v_receipt.acknowledged_at is null
    or v_receipt.acknowledged_by is distinct from p_owner
    or v_receipt.acknowledged_at >= v_receipt.expires_at
    or v_receipt.target_id is distinct from v_target
    or v_receipt.content_hash is distinct from v_content_hash then
    raise exception 'The server preview receipt is missing, expired, used, or no longer matches this exact action';
  end if;
  v_expected_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_receipt.id,v_receipt.owner,v_receipt.draft_table,v_receipt.draft_id,
    v_receipt.provider,v_receipt.action,v_receipt.target_id,v_receipt.content_hash,
    v_receipt.preview_payload - 'receiptHash',v_receipt.created_at,v_receipt.expires_at
  )::text,'UTF8'),'sha256'),'hex');
  if v_receipt.receipt_hash is distinct from v_expected_hash
    or v_receipt.preview_payload ->> 'receiptHash' is distinct from v_receipt.receipt_hash then
    raise exception 'The server preview receipt failed integrity verification';
  end if;
  update public.immediate_provider_preview_receipts set
    consumed_at = clock_timestamp(),consumed_claim_id = p_claim_id
  where id = v_receipt.id and consumed_at is null and invalidated_at is null
    and acknowledged_at is not null and acknowledged_by = p_owner;
  if not found then raise exception 'The server preview receipt was already used'; end if;
  return v_receipt.preview_payload;
end;
$$;

revoke all on function public.consume_immediate_agent_preview_receipt_service(
  uuid,uuid,text,text,uuid,uuid
) from public, anon, authenticated, service_role;

create or replace function public.consume_immediate_meta_preview_receipt_service(
  p_owner uuid,p_draft_id uuid,p_action text,p_receipt_id uuid,p_claim_id uuid
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_content_hash text;
  v_target text;
  v_payload jsonb;
  v_receipt public.immediate_provider_preview_receipts%rowtype;
  v_expected_hash text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Immediate preview receipt consumption is service-only';
  end if;
  select snapshot.content_hash,snapshot.target_id,snapshot.preview_payload
  into v_content_hash,v_target,v_payload
  from public.immediate_meta_preview_snapshot_service(
    p_owner,p_draft_id,p_action
  ) snapshot;
  select * into v_receipt from public.immediate_provider_preview_receipts
  where id = p_receipt_id and owner = p_owner and draft_table = 'post_drafts'
    and draft_id = p_draft_id and provider = 'meta' and action = p_action
  for update;
  if not found or v_receipt.consumed_at is not null
    or v_receipt.invalidated_at is not null or v_receipt.expires_at <= clock_timestamp()
    or v_receipt.created_at > clock_timestamp()
    or v_receipt.acknowledged_at is null
    or v_receipt.acknowledged_by is distinct from p_owner
    or v_receipt.acknowledged_at >= v_receipt.expires_at
    or v_receipt.target_id is distinct from v_target
    or v_receipt.content_hash is distinct from v_content_hash then
    raise exception 'The server preview receipt is missing, expired, used, or no longer matches this exact action';
  end if;
  v_expected_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    v_receipt.id,v_receipt.owner,v_receipt.draft_table,v_receipt.draft_id,
    v_receipt.provider,v_receipt.action,v_receipt.target_id,v_receipt.content_hash,
    v_receipt.preview_payload - 'receiptHash',v_receipt.created_at,v_receipt.expires_at
  )::text,'UTF8'),'sha256'),'hex');
  if v_receipt.receipt_hash is distinct from v_expected_hash
    or v_receipt.preview_payload ->> 'receiptHash' is distinct from v_receipt.receipt_hash then
    raise exception 'The server preview receipt failed integrity verification';
  end if;
  update public.immediate_provider_preview_receipts set
    consumed_at = clock_timestamp(),consumed_claim_id = p_claim_id
  where id = v_receipt.id and consumed_at is null and invalidated_at is null
    and acknowledged_at is not null and acknowledged_by = p_owner;
  if not found then raise exception 'The server preview receipt was already used'; end if;
  return v_receipt.preview_payload;
end;
$$;

revoke all on function public.consume_immediate_meta_preview_receipt_service(
  uuid,uuid,text,uuid,uuid
) from public, anon, authenticated, service_role;

create or replace function public.claim_immediate_agent_draft_with_preview_service(
  p_owner uuid,p_draft_id uuid,p_provider text,p_action text,p_receipt_id uuid
)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_claim_id uuid := gen_random_uuid();
  v_draft public.drafts%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Immediate draft claims are service-only';
  end if;
  if lower(trim(coalesce(p_provider,''))) not in ('twitter','reddit') then
    raise exception 'This generic immediate claim supports only X and Reddit';
  end if;
  perform public.consume_immediate_agent_preview_receipt_service(
    p_owner,p_draft_id,p_provider,p_action,p_receipt_id,v_claim_id
  );
  update public.drafts set
    publish_state = 'publishing',publish_error = '',updated_at = now()
  where id = p_draft_id and owner = p_owner and approval_state = 'approved'
    and coalesce(provider_post_id,'') = ''
    and publish_state in ('not_queued','queued','failed','blocked')
  returning * into v_draft;
  if not found then raise exception 'The exact approved draft could not be claimed'; end if;
  return v_draft;
end;
$$;

revoke all on function public.claim_immediate_agent_draft_with_preview_service(
  uuid,uuid,text,text,uuid
) from public, anon, authenticated;
grant execute on function public.claim_immediate_agent_draft_with_preview_service(
  uuid,uuid,text,text,uuid
) to service_role;

create or replace function public.claim_immediate_meta_post_draft_with_preview_service(
  p_owner uuid,p_draft_id uuid,p_action text,p_receipt_id uuid
)
returns public.post_drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_claim_id uuid := gen_random_uuid();
  v_draft public.post_drafts%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Immediate Meta claims are service-only';
  end if;
  perform public.consume_immediate_meta_preview_receipt_service(
    p_owner,p_draft_id,p_action,p_receipt_id,v_claim_id
  );
  update public.post_drafts set
    status = 'publishing',publish_claimed_at = now(),updated_at = now()
  where id = p_draft_id and owner = p_owner
    and status in ('draft','approved','failed')
  returning * into v_draft;
  if not found then raise exception 'The exact Meta draft could not be claimed'; end if;
  return v_draft;
end;
$$;

revoke all on function public.claim_immediate_meta_post_draft_with_preview_service(
  uuid,uuid,text,uuid
) from public, anon, authenticated;
grant execute on function public.claim_immediate_meta_post_draft_with_preview_service(
  uuid,uuid,text,uuid
) to service_role;

-- Migration 066's legacy Discord claim may retain an older grant whose grantor
-- cannot be changed by the release role. Gate its first durable insert instead:
-- only the receipt-aware wrapper can have consumed the same one-shot receipt
-- for the exact attempt inside the current transaction.
create or replace function public.assert_discord_attempt_preview_receipt()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.immediate_provider_preview_receipts receipt
    where receipt.owner = new.owner
      and receipt.draft_table = 'drafts'
      and receipt.draft_id = new.draft_id
      and receipt.provider = 'discord'
      and receipt.action = 'discord.publish_now'
      and receipt.consumed_claim_id = new.id
      and receipt.consumed_at is not null
      and receipt.acknowledged_at is not null
      and receipt.acknowledged_by = new.owner
      and receipt.invalidated_at is null
  ) then
    raise exception 'A current one-shot Discord preview receipt must be consumed atomically before claim';
  end if;
  return new;
end;
$$;

revoke all on function public.assert_discord_attempt_preview_receipt()
  from public, anon, authenticated;

drop trigger if exists assert_discord_attempt_preview_receipt
  on public.discord_publish_attempts;
create trigger assert_discord_attempt_preview_receipt
  before insert on public.discord_publish_attempts
  for each row execute function public.assert_discord_attempt_preview_receipt();

create or replace function public.claim_discord_draft_publish_with_preview_service(
  p_draft_id uuid,p_owner uuid,p_attempt_id uuid,p_lease_id uuid,p_receipt_id uuid
)
returns table(
  attempt_id uuid,draft_id uuid,ledger_id uuid,persona_id uuid,
  title text,body text,tags text,media_url text,content_kind text,
  approval_hash text,webhook_id text,channel_id text
)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Immediate Discord claims are service-only';
  end if;
  perform public.consume_immediate_agent_preview_receipt_service(
    p_owner,p_draft_id,'discord','discord.publish_now',p_receipt_id,p_attempt_id
  );
  return query select * from public.claim_discord_draft_publish_service(
    p_draft_id,p_owner,p_attempt_id,p_lease_id
  );
end;
$$;

revoke all on function public.claim_discord_draft_publish_with_preview_service(
  uuid,uuid,uuid,uuid,uuid
) from public, anon, authenticated;
grant execute on function public.claim_discord_draft_publish_with_preview_service(
  uuid,uuid,uuid,uuid,uuid
) to service_role;

-- Best-effort removal of the old grant. The insert trigger above remains the
-- enforcement boundary even when an older grant has a different grantor.
revoke execute on function public.claim_discord_draft_publish_service(
  uuid,uuid,uuid,uuid
) from public, anon, authenticated, service_role;

commit;
