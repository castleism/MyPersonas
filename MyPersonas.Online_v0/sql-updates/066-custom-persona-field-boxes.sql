-- 066-custom-persona-field-boxes.sql
-- First-class, audience-scoped persona field boxes.
--
-- Values are inert text or one credential-free HTTPS link. Browser roles never
-- mutate or read the base table directly. Public/friend/follower projections
-- are bounded RPCs and exact persona mode is required for relationship-scoped
-- visibility; an account-wide session never guesses which persona is acting.

begin;

create or replace function public.persona_custom_field_link_safe_066(p_value text)
returns boolean
language sql
immutable
set search_path=''
as $$
  select public.is_safe_credential_free_https_url(btrim(coalesce(p_value,'')),false)
    and position('?' in coalesce(p_value,''))=0
    and position('#' in coalesce(p_value,''))=0
    and not public.project_resource_text_has_secret(coalesce(p_value,''))
$$;

create or replace function public.assert_owner_erasure_inactive_066(p_owner uuid)
returns void
language plpgsql
security definer
set search_path=''
as $$
begin
  if p_owner is null or auth.uid() is null or p_owner is distinct from auth.uid() then
    raise exception 'Authenticated owner is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0)
  );
  delete from public.meta_owner_erasure_leases lease
  where lease.owner=p_owner and lease.expires_at<=now();
  if exists(select 1 from public.meta_owner_erasure_leases lease
    where lease.owner=p_owner and lease.expires_at>now()) then
    raise sqlstate '55000' using
      message='Persona content changes are blocked while owner erasure is running';
  end if;
end
$$;

revoke all on function public.persona_custom_field_link_safe_066(text),
  public.assert_owner_erasure_inactive_066(uuid)
  from public,anon,authenticated,service_role;

create table if not exists public.persona_custom_field_boxes (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null,
  owner uuid not null references public.profiles(id) on delete cascade,
  field_type text not null check (field_type in ('text','link')),
  title text not null check (
    char_length(title) between 1 and 120
    and title=btrim(title)
    and title !~ E'[\\n\\r\\t]'
  ),
  body text not null default '' check (char_length(body)<=3000),
  link_label text not null default '' check (char_length(link_label)<=120),
  link_url text not null default '' check (char_length(link_url)<=2048),
  visibility text not null default 'owner_only'
    check (visibility in ('owner_only','friends','followers','public')),
  enabled boolean not null default false,
  sort_order smallint not null default 0 check (sort_order between 0 and 1000),
  row_version bigint not null default 1 check (row_version>=1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint persona_custom_field_boxes_persona_owner_fkey
    foreign key(persona_id,owner)
    references public.personas(id,owner) on delete cascade,
  constraint persona_custom_field_boxes_type_shape check (
    (field_type='text' and link_label='' and link_url='')
    or
    (field_type='link' and char_length(btrim(link_label)) between 1 and 120
      and link_url ~ '^https://[^[:space:]]+$')
  ),
  constraint persona_custom_field_boxes_no_controls check (
    translate(title||body||link_label||link_url,E'\n\r\t','') !~ '[[:cntrl:]]'
  )
);

create index if not exists persona_custom_field_boxes_persona_sort_idx
  on public.persona_custom_field_boxes(persona_id,sort_order,created_at,id);
create index if not exists persona_custom_field_boxes_owner_created_idx
  on public.persona_custom_field_boxes(owner,created_at,id);

alter table public.persona_custom_field_boxes
  drop constraint if exists persona_custom_field_boxes_type_shape;
alter table public.persona_custom_field_boxes
  add constraint persona_custom_field_boxes_type_shape check (
    (field_type='text' and link_label='' and link_url='')
    or
    (field_type='link' and char_length(btrim(link_label)) between 1 and 120
      and public.persona_custom_field_link_safe_066(link_url))
  );

alter table public.persona_custom_field_boxes enable row level security;
revoke all on table public.persona_custom_field_boxes
  from public,anon,authenticated,service_role;

create or replace function public.my_persona_custom_field_boxes(p_persona_id uuid)
returns table(
  id uuid,persona_id uuid,field_type text,title text,body text,
  link_label text,link_url text,visibility text,enabled boolean,
  sort_order smallint,row_version bigint,created_at timestamptz,updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=auth.uid()) then
    raise exception 'Owned persona not found';
  end if;
  return query
  select field.id,field.persona_id,field.field_type,field.title,field.body,
    field.link_label,field.link_url,field.visibility,field.enabled,
    field.sort_order,field.row_version,field.created_at,field.updated_at
  from public.persona_custom_field_boxes field
  where field.persona_id=p_persona_id and field.owner=auth.uid()
  order by field.sort_order,field.created_at,field.id
  limit 24;
end
$$;

create or replace function public.save_persona_custom_field_box(
  p_field_id uuid,
  p_persona_id uuid,
  p_expected_row_version bigint,
  p_field_type text,
  p_title text,
  p_body text,
  p_link_label text,
  p_link_url text,
  p_visibility text,
  p_enabled boolean,
  p_sort_order integer
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_owner uuid:=auth.uid();
  v_id uuid:=coalesce(p_field_id,gen_random_uuid());
  v_is_new boolean:=p_field_id is null;
  v_type text:=lower(btrim(coalesce(p_field_type,'')));
  v_title text:=btrim(coalesce(p_title,''));
  v_body text:=coalesce(p_body,'');
  v_link_label text:=btrim(coalesce(p_link_label,''));
  v_link_url text:=btrim(coalesce(p_link_url,''));
  v_visibility text:=lower(btrim(coalesce(p_visibility,'')));
  v_sort integer:=coalesce(p_sort_order,0);
  v_persona_total integer;
  v_owner_total integer;
  v_owner_day integer;
  v_saved public.persona_custom_field_boxes%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_persona_id is null then raise exception 'Persona id is required'; end if;
  if v_type not in ('text','link') then raise exception 'Field type must be text or link'; end if;
  if char_length(v_title) not between 1 and 120 or v_title ~ E'[\\n\\r\\t]' then
    raise exception 'Field title must be 1 to 120 single-line characters';
  end if;
  if char_length(v_body)>3000 or char_length(v_link_label)>120
     or char_length(v_link_url)>2048 then
    raise exception 'Custom field content is too long';
  end if;
  if octet_length(v_title)+octet_length(v_body)+octet_length(v_link_label)
       +octet_length(v_link_url)>10000 then
    raise exception 'Custom field content exceeds the 10000-byte limit';
  end if;
  if translate(v_title||v_body||v_link_label||v_link_url,E'\n\r\t','')
       ~ '[[:cntrl:]]' then
    raise exception 'Custom field content contains unsupported control characters';
  end if;
  if v_visibility not in ('owner_only','friends','followers','public') then
    raise exception 'Unsupported custom field visibility';
  end if;
  if v_sort not between 0 and 1000 then
    raise exception 'Custom field order must be between 0 and 1000';
  end if;
  if v_type='text' then
    if v_link_label<>'' or v_link_url<>'' then
      raise exception 'Text fields cannot contain link settings';
    end if;
  else
    if v_link_label='' or not public.persona_custom_field_link_safe_066(v_link_url) then
      raise exception 'Link fields require a credential-free HTTPS URL without a query, fragment, or secret';
    end if;
  end if;
  if public.project_resource_text_has_secret(
      concat_ws(E'\n',v_title,v_body,v_link_label,v_link_url)) then
    raise exception 'Custom field content appears to contain a credential';
  end if;

  perform public.assert_owner_erasure_inactive_066(v_owner);

  if v_is_new then
    if coalesce(p_expected_row_version,0)<>0 then
      raise exception 'A new custom field cannot have an existing row version';
    end if;
    perform public.lock_owner_content_creation_quota(v_owner);
  elsif coalesce(p_expected_row_version,0)<1 then
    raise exception 'Expected row version is required for an update';
  end if;
  perform public.lock_persona_publication_mutation(p_persona_id);
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=v_owner) then
    raise exception 'Owned persona not found';
  end if;

  if v_is_new then
    select count(*) into v_persona_total from (
      select 1 from public.persona_custom_field_boxes field
      where field.persona_id=p_persona_id limit 24
    ) quota;
    select count(*) into v_owner_total from (
      select 1 from public.persona_custom_field_boxes field
      where field.owner=v_owner limit 200
    ) quota;
    select count(*) into v_owner_day from (
      select 1 from public.persona_custom_field_boxes field
      where field.owner=v_owner
        and field.created_at>=pg_catalog.date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
        and field.created_at<(pg_catalog.date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')+interval '1 day'
      limit 200
    ) quota;
    if v_persona_total>=24 then raise exception 'Persona custom field limit reached (24)'; end if;
    if v_owner_total>=200 then raise exception 'Account custom field limit reached (200)'; end if;
    perform public.consume_owner_daily_rate(
      v_owner,'persona_custom_fields',200,1,v_owner_day
    );
    insert into public.persona_custom_field_boxes(
      id,persona_id,owner,field_type,title,body,link_label,link_url,
      visibility,enabled,sort_order
    ) values(
      v_id,p_persona_id,v_owner,v_type,v_title,v_body,
      case when v_type='link' then v_link_label else '' end,
      case when v_type='link' then v_link_url else '' end,
      v_visibility,coalesce(p_enabled,false),v_sort
    ) returning * into v_saved;
  else
    update public.persona_custom_field_boxes field set
      field_type=v_type,title=v_title,body=v_body,
      link_label=case when v_type='link' then v_link_label else '' end,
      link_url=case when v_type='link' then v_link_url else '' end,
      visibility=v_visibility,enabled=coalesce(p_enabled,false),sort_order=v_sort,
      row_version=field.row_version+1,updated_at=now()
    where field.id=p_field_id and field.persona_id=p_persona_id
      and field.owner=v_owner and field.row_version=p_expected_row_version
    returning * into v_saved;
    if not found then
      raise sqlstate '40001' using
        message='Custom field changed or was removed; reload before saving';
    end if;
  end if;

  return jsonb_build_object(
    'id',v_saved.id,'persona_id',v_saved.persona_id,
    'field_type',v_saved.field_type,'title',v_saved.title,'body',v_saved.body,
    'link_label',v_saved.link_label,'link_url',v_saved.link_url,
    'visibility',v_saved.visibility,'enabled',v_saved.enabled,
    'sort_order',v_saved.sort_order,'row_version',v_saved.row_version,
    'created_at',v_saved.created_at,'updated_at',v_saved.updated_at
  );
end
$$;

create or replace function public.delete_persona_custom_field_box(
  p_field_id uuid,p_expected_row_version bigint
)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  v_owner uuid:=auth.uid();
  v_persona_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_field_id is null or coalesce(p_expected_row_version,0)<1 then
    raise exception 'Custom field id and expected row version are required';
  end if;
  perform public.assert_owner_erasure_inactive_066(v_owner);
  select field.persona_id into v_persona_id
  from public.persona_custom_field_boxes field
  where field.id=p_field_id and field.owner=v_owner;
  if not found then
    raise sqlstate '40001' using
      message='Custom field changed or was removed; reload before deleting';
  end if;
  perform public.lock_persona_publication_mutation(v_persona_id);
  delete from public.persona_custom_field_boxes field
  where field.id=p_field_id and field.owner=v_owner
    and field.row_version=p_expected_row_version;
  if not found then
    raise sqlstate '40001' using
      message='Custom field changed or was removed; reload before deleting';
  end if;
  return true;
end
$$;

-- A relationship-scoped field is returned only when the caller supplies one
-- exact acting persona owned by the current account. Without an actor, only an
-- owner or the anonymous/public audience can receive data.
drop function if exists public.persona_custom_field_boxes(uuid);
create or replace function public.persona_custom_field_boxes(
  p_persona_id uuid,p_actor_persona_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path=''
as $$
declare
  v_target_owner uuid;
  v_target_visibility text;
  v_is_owner boolean:=false;
  v_allowed boolean:=false;
  v_is_friend boolean:=false;
  v_is_follower boolean:=false;
  v_result jsonb:='[]'::jsonb;
begin
  select persona.owner,persona.visibility
    into v_target_owner,v_target_visibility
  from public.personas persona where persona.id=p_persona_id;
  if not found then return v_result; end if;
  if p_actor_persona_id is not null then
    if auth.uid() is null or not exists(select 1 from public.personas actor
      where actor.id=p_actor_persona_id and actor.owner=auth.uid()) then
      raise exception 'Owned acting persona not found';
    end if;
    if p_actor_persona_id=p_persona_id and auth.uid()=v_target_owner then
      v_is_owner:=true;
      v_allowed:=true;
    else
      v_allowed:=public.persona_mode_can_view(p_actor_persona_id,p_persona_id);
    end if;
    if v_allowed and not v_is_owner then
      select exists(select 1 from public.follows friendship
          where friendship.status='accepted'
            and least(friendship.follower,friendship.target)=least(p_actor_persona_id,p_persona_id)
            and greatest(friendship.follower,friendship.target)=greatest(p_actor_persona_id,p_persona_id)),
        exists(select 1 from public.persona_follows follow
          where follow.follower_persona_id=p_actor_persona_id
            and follow.target_persona_id=p_persona_id)
      into v_is_friend,v_is_follower;
    end if;
  elsif auth.uid() is not null and auth.uid()=v_target_owner then
    v_is_owner:=true;
    v_allowed:=true;
  else
    v_allowed:=v_target_visibility in ('public','unlisted')
      and public.persona_publication_is_current(p_persona_id)
      and public.persona_visible(p_persona_id);
  end if;

  if not v_allowed then return v_result; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'field_type',field.field_type,'title',field.title,'body',field.body,
    'link_label',field.link_label,
    'link_url',case when field.field_type='link'
      and public.persona_custom_field_link_safe_066(field.link_url)
      then field.link_url else '' end,
    'visibility',field.visibility,'sort_order',field.sort_order
  ) order by field.sort_order,field.created_at,field.id),'[]'::jsonb)
  into v_result
  from public.persona_custom_field_boxes field
  where field.persona_id=p_persona_id and field.owner=v_target_owner
    and field.enabled
    and (
      v_is_owner
      or field.visibility='public'
      or (field.visibility='friends' and v_is_friend)
      or (field.visibility='followers' and v_is_follower)
    )
    and (field.field_type='text'
      or public.persona_custom_field_link_safe_066(field.link_url));
  return v_result;
end
$$;

-- Any change that can alter another person's page view becomes a new exact
-- publication revision. Owner-only/disabled content stays outside that review.
create or replace function public.invalidate_persona_custom_field_review()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_persona_id uuid:=case when tg_op='DELETE' then old.persona_id else new.persona_id end;
  v_old_shared boolean:=case when tg_op='INSERT' then false
    else old.enabled and old.visibility<>'owner_only' end;
  v_new_shared boolean:=case when tg_op='DELETE' then false
    else new.enabled and new.visibility<>'owner_only' end;
  v_material boolean:=true;
begin
  if tg_op='UPDATE' then
    v_material:=row(old.field_type,old.title,old.body,old.link_label,old.link_url,
      old.visibility,old.enabled,old.sort_order)
      is distinct from
      row(new.field_type,new.title,new.body,new.link_label,new.link_url,
      new.visibility,new.enabled,new.sort_order);
  end if;
  if v_material and (v_old_shared or v_new_shared) then
    perform public.lock_persona_publication_mutation(v_persona_id);
    perform public.invalidate_persona_review_revision(v_persona_id);
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end
$$;

drop trigger if exists invalidate_persona_custom_field_review
  on public.persona_custom_field_boxes;
create trigger invalidate_persona_custom_field_review
after insert or update or delete on public.persona_custom_field_boxes
for each row execute function public.invalidate_persona_custom_field_review();

-- Clone migration 051's authoritative manifest implementation behind a
-- private name, then replace the original function in place. CREATE OR REPLACE
-- preserves its OID, so already-defined readiness/publication callers cannot
-- retain a cached dependency on a bypassing legacy function.
do $manifest$
declare
  v_definition text;
begin
  if to_regprocedure('public.persona_publication_review_manifest_base_066(uuid)') is null then
    select pg_catalog.pg_get_functiondef(
      'public.persona_publication_review_manifest(uuid)'::regprocedure
    ) into v_definition;
    v_definition:=pg_catalog.regexp_replace(v_definition,
      'FUNCTION public\.persona_publication_review_manifest\(',
      'FUNCTION public.persona_publication_review_manifest_base_066(');
    execute v_definition;
    if to_regprocedure('public.persona_publication_review_manifest_base_066(uuid)') is null then
      raise exception 'Could not preserve the migration 051 review manifest';
    end if;
  end if;
end
$manifest$;

revoke all on function public.persona_publication_review_manifest_base_066(uuid)
  from public,anon,authenticated,service_role;

create or replace function public.persona_publication_review_manifest(p_persona_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path=''
as $$
declare
  v_base jsonb:=public.persona_publication_review_manifest_base_066(p_persona_id);
  v_fields jsonb:='[]'::jsonb;
  v_count integer:=0;
  v_bytes bigint:=0;
  v_invalid_url boolean:=false;
  v_complete boolean;
  v_reasons jsonb;
begin
  select count(*),coalesce(sum(octet_length(concat_ws('|',field.field_type,
      field.title,field.body,field.link_label,field.link_url,field.visibility,
      field.sort_order::text))),0),
    coalesce(bool_or(field.field_type='link'
      and not public.persona_custom_field_link_safe_066(field.link_url)),false)
  into v_count,v_bytes,v_invalid_url
  from public.persona_custom_field_boxes field
  where field.persona_id=p_persona_id and field.owner=auth.uid()
    and field.enabled and field.visibility<>'owner_only';

  select coalesce(jsonb_agg(jsonb_build_object(
    'field_type',field.field_type,'title',field.title,'body',field.body,
    'link_label',field.link_label,'link_url',field.link_url,
    'visibility',field.visibility,'sort_order',field.sort_order
  ) order by field.sort_order,field.created_at,field.id),'[]'::jsonb)
  into v_fields
  from (select * from public.persona_custom_field_boxes field
    where field.persona_id=p_persona_id and field.owner=auth.uid()
      and field.enabled and field.visibility<>'owner_only'
    order by field.sort_order,field.created_at,field.id limit 24) field;

  v_complete:=coalesce((v_base->>'complete')::boolean,false)
    and v_count<=24 and v_bytes<=100000 and not v_invalid_url;
  v_reasons:=coalesce(v_base->'truncation_reasons','[]'::jsonb)
    || case when v_count>24 then jsonb_build_array(
      'Too many enabled non-owner custom field boxes for one review packet')
      else '[]'::jsonb end
    || case when v_bytes>100000 then jsonb_build_array(
      'Custom field boxes exceed the 100000-byte review bound')
      else '[]'::jsonb end
    || case when v_invalid_url then jsonb_build_array(
      'A custom link field is not a credential-free HTTPS URL')
      else '[]'::jsonb end;

  return v_base || jsonb_build_object(
    'complete',v_complete,
    'counts',coalesce(v_base->'counts','{}'::jsonb)
      || jsonb_build_object('custom_field_boxes',v_count),
    'limits',coalesce(v_base->'limits','{}'::jsonb)
      || jsonb_build_object('custom_field_boxes',24,'custom_field_bytes',100000),
    'truncation_reasons',v_reasons,
    'custom_field_boxes',v_fields,
    'withheld',coalesce(v_base->'withheld','[]'::jsonb)
      || jsonb_build_array('owner-only and disabled custom field boxes')
  );
end
$$;

-- Reuse the existing content-erasure call site. Full-account deletion also
-- cascades through personas/profiles, while content-only erasure invokes this
-- service RPC before deleting persona rows.
create or replace function public.delete_persona_page_builder_data_for_account_service(
  p_owner uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_persona_id uuid;
  v_layout_count integer;
  v_snippet_count integer;
  v_custom_field_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise sqlstate '42501' using message='Service role required';
  end if;
  if p_owner is null then raise exception 'Owner is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051056)
  );
  for v_persona_id in
    select candidate.persona_id from (
      select layout.persona_id from public.persona_page_layouts layout
        where layout.owner=p_owner
      union
      select field.persona_id from public.persona_custom_field_boxes field
        where field.owner=p_owner
    ) candidate order by candidate.persona_id
  loop
    perform public.lock_persona_publication_mutation(v_persona_id);
  end loop;
  delete from public.persona_page_code_snippets snippet where snippet.owner=p_owner;
  get diagnostics v_snippet_count=row_count;
  delete from public.persona_custom_field_boxes field where field.owner=p_owner;
  get diagnostics v_custom_field_count=row_count;
  delete from public.persona_page_layouts layout where layout.owner=p_owner;
  get diagnostics v_layout_count=row_count;
  return jsonb_build_object(
    'layouts_deleted',v_layout_count,'snippets_deleted',v_snippet_count,
    'custom_fields_deleted',v_custom_field_count
  );
end
$$;

revoke all on function public.my_persona_custom_field_boxes(uuid),
  public.save_persona_custom_field_box(uuid,uuid,bigint,text,text,text,text,text,text,boolean,integer),
  public.delete_persona_custom_field_box(uuid,bigint),
  public.persona_custom_field_boxes(uuid,uuid),
  public.invalidate_persona_custom_field_review(),
  public.persona_publication_review_manifest(uuid),
  public.delete_persona_page_builder_data_for_account_service(uuid)
  from public,anon,authenticated,service_role;

grant execute on function public.my_persona_custom_field_boxes(uuid),
  public.save_persona_custom_field_box(uuid,uuid,bigint,text,text,text,text,text,text,boolean,integer),
  public.delete_persona_custom_field_box(uuid,bigint)
  to authenticated;
grant execute on function public.persona_custom_field_boxes(uuid,uuid)
  to anon,authenticated;
grant execute on function public.persona_publication_review_manifest(uuid)
  to authenticated;
grant execute on function public.delete_persona_page_builder_data_for_account_service(uuid)
  to service_role;

comment on table public.persona_custom_field_boxes is
  'RPC-only bounded persona field boxes. Values are escaped text or one credential-free HTTPS link; no stored value is executable.';
comment on function public.persona_custom_field_boxes(uuid,uuid) is
  'Fail-closed audience projection. Friends/followers visibility requires an exact authenticated acting persona.';

commit;
