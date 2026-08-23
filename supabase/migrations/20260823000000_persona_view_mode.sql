-- 058-persona-view-mode.sql
-- Exact-actor social projections and bounded mutation wrappers for the
-- Overview / Persona view switch. This migration does not publish personas,
-- create relationships, or enable any connector by itself.
-- Apply only after migration 057 (and therefore 049-051).

begin;

create or replace function public.persona_mode_actor_can_interact(p_actor_persona_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.personas actor
    where actor.id=p_actor_persona_id
      and actor.owner=auth.uid()
      and actor.visibility in ('public','unlisted')
      and public.persona_publication_is_current(actor.id)
  )
$$;

revoke all on function public.persona_mode_actor_can_interact(uuid)
  from public,anon,authenticated;

create or replace function public.persona_mode_actor_can_manage_relationships(p_actor_persona_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.personas actor
    where actor.id=p_actor_persona_id
      and actor.owner=auth.uid()
      and public.persona_publication_is_current(actor.id)
  )
$$;

revoke all on function public.persona_mode_actor_can_manage_relationships(uuid)
  from public,anon,authenticated;

-- Persona-mode mutations acquire every publication lock that their exact
-- authorization decision can depend on. The complete set is sorted once so
-- reciprocal actions and cyclic reviewed dependency graphs cannot invert the
-- lock order. Callers must still take any account-scoped quota lock first.
create or replace function public.persona_mode_lock_exact_scope(
  p_actor_persona_id uuid,p_target_persona_id uuid,p_include_dependencies boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_id uuid;
  v_dependency_ids uuid[]:='{}'::uuid[];
begin
  if p_actor_persona_id is null or p_target_persona_id is null then
    raise exception 'Persona ids are required';
  end if;
  if p_include_dependencies then
    select coalesce(array_agg(candidate.id order by candidate.id),'{}'::uuid[])
    into v_dependency_ids
    from (
      select distinct dependency.dependency_persona_id id
      from public.persona_publication_dependencies dependency
      where dependency.persona_id in (p_actor_persona_id,p_target_persona_id)
        and dependency.dependency_persona_id is not null
    ) candidate;
  end if;
  for v_lock_id in
    select distinct candidate.id
    from unnest(v_dependency_ids || array[p_actor_persona_id,p_target_persona_id]) candidate(id)
    where candidate.id is not null
    order by candidate.id
  loop
    perform public.lock_persona_publication_mutation(v_lock_id);
  end loop;
  if p_include_dependencies and exists (
    select 1 from public.persona_publication_dependencies dependency
    where dependency.persona_id in (p_actor_persona_id,p_target_persona_id)
      and not (dependency.dependency_persona_id=any(v_dependency_ids))
  ) then
    raise sqlstate '40001' using
      message='Persona publication dependencies changed while the action was waiting; retry';
  end if;
end
$$;

revoke all on function public.persona_mode_lock_exact_scope(uuid,uuid,boolean)
  from public,anon,authenticated;

-- This predicate never calls account-wide persona_visible(). Private access is
-- granted only by an accepted friendship involving this exact actor.
create or replace function public.persona_mode_can_view(
  p_actor_persona_id uuid,p_target_persona_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.personas actor
    join public.personas target on target.id=p_target_persona_id
    where actor.id=p_actor_persona_id
      and actor.owner=auth.uid()
      and (
        target.id=actor.id
        or (
          public.persona_publication_is_current(target.id)
          and not exists (
            select 1
            from public.persona_publication_dependencies dependency
            join public.personas relative
              on relative.id=dependency.dependency_persona_id
            where dependency.persona_id=target.id and (
              exists (
                select 1 from public.blocks hidden_dependency
                where hidden_dependency.blocker=actor.owner
                  and hidden_dependency.blocked_persona=relative.id
                  and hidden_dependency.kind in ('block','mute')
              )
              or exists (
                select 1 from public.blocks dependency_blocked_viewer
                join public.personas viewer_persona
                  on viewer_persona.id=dependency_blocked_viewer.blocked_persona
                 and viewer_persona.owner=actor.owner
                where dependency_blocked_viewer.blocker=relative.owner
                  and dependency_blocked_viewer.kind='block'
              )
            )
          )
          and not exists (
            select 1 from public.blocks hidden
            where hidden.blocker=actor.owner
              and hidden.blocked_persona=target.id
              and hidden.kind in ('block','mute')
          )
          and not exists (
            select 1 from public.blocks blocking
            join public.personas blocked_identity
              on blocked_identity.id=blocking.blocked_persona
             and blocked_identity.owner=actor.owner
            where blocking.blocker=target.owner and blocking.kind='block'
          )
          and (
            target.visibility in ('public','unlisted')
            or (
              target.visibility='private'
              and public.persona_publication_is_current(actor.id)
              and exists (
                select 1 from public.follows friendship
                where friendship.status='accepted'
                  and least(friendship.follower,friendship.target)=least(actor.id,target.id)
                  and greatest(friendship.follower,friendship.target)=greatest(actor.id,target.id)
              )
            )
          )
        )
      )
  )
$$;

revoke all on function public.persona_mode_can_view(uuid,uuid)
  from public,anon,authenticated;

create or replace function public.my_persona_mode_status(p_actor_persona_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare v_actor public.personas%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select actor.* into v_actor from public.personas actor
  where actor.id=p_actor_persona_id and actor.owner=auth.uid();
  if not found then raise exception 'Owned acting persona not found'; end if;
  return jsonb_build_object(
    'id',v_actor.id,'name',v_actor.name,'handle',v_actor.handle,
    'visibility',v_actor.visibility,'publication_state',v_actor.publication_state,
    'can_interact',public.persona_mode_actor_can_interact(v_actor.id),
    'can_manage_relationships',public.persona_mode_actor_can_manage_relationships(v_actor.id)
  );
end
$$;

drop function if exists public.my_persona_mode_connections(uuid);
create or replace function public.my_persona_mode_connections(p_actor_persona_id uuid)
returns table(
  connection_kind text,
  persona_id uuid,
  handle text,
  name text,
  tagline text,
  title text,
  avatar_url text,
  theme text,
  visibility text,
  publication_state text,
  relationship_label text,
  relationship_id uuid
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.personas actor
    where actor.id=p_actor_persona_id and actor.owner=auth.uid()
  ) then raise exception 'Owned acting persona not found'; end if;

  return query
  with direct_family as (
    select case when relationship.from_persona_id=p_actor_persona_id
        then relationship.to_persona_id else relationship.from_persona_id end target_id,
      case
        when relationship.relationship_type='partner' then 'partner'
        when relationship.from_persona_id=p_actor_persona_id then 'child'
        else 'parent'
      end label
    from public.persona_family_relationships relationship
    where relationship.owner=auth.uid()
      and relationship.visibility='public'
      and p_actor_persona_id in (relationship.from_persona_id,relationship.to_persona_id)
      and public.persona_publication_is_current(p_actor_persona_id)
      and exists (
        select 1 from public.persona_publication_dependencies dependency
        where dependency.persona_id=p_actor_persona_id
          and dependency.dependency_kind='family'
          and dependency.dependency_persona_id=case
            when relationship.from_persona_id=p_actor_persona_id
            then relationship.to_persona_id else relationship.from_persona_id end
      )
  ), sibling_family as (
    select other_child.to_persona_id target_id,'sibling'::text label
    from public.persona_family_relationships my_parent
    join public.persona_family_relationships other_child
      on other_child.owner=my_parent.owner
     and other_child.relationship_type='parent_of'
     and other_child.from_persona_id=my_parent.from_persona_id
     and other_child.to_persona_id<>p_actor_persona_id
     and other_child.visibility='public'
    where my_parent.owner=auth.uid()
      and my_parent.relationship_type='parent_of'
      and my_parent.to_persona_id=p_actor_persona_id
      and my_parent.visibility='public'
      and public.persona_publication_is_current(p_actor_persona_id)
      and exists (
        select 1 from public.persona_publication_dependencies dependency
        where dependency.persona_id=p_actor_persona_id
          and dependency.dependency_kind='family'
          and dependency.dependency_persona_id=other_child.to_persona_id
      )
    group by other_child.to_persona_id
  ), edges as (
    select 'friend'::text kind,
      case when friendship.follower=p_actor_persona_id
        then friendship.target else friendship.follower end target_id,
      'friend'::text label,
      friendship.id relationship_id
    from public.follows friendship
    where friendship.status='accepted'
      and p_actor_persona_id in (friendship.follower,friendship.target)
    union all
    select 'following',follow.target_persona_id,'following',null::uuid
    from public.persona_follows follow
    where follow.follower_persona_id=p_actor_persona_id
    union all
    select 'follower',follow.follower_persona_id,'follower',null::uuid
    from public.persona_follows follow
    where follow.target_persona_id=p_actor_persona_id
    union all
    select case when friendship.target=p_actor_persona_id
        then 'friend_incoming'::text else 'friend_outgoing'::text end,
      case when friendship.target=p_actor_persona_id
        then friendship.follower else friendship.target end,
      'pending friend'::text,friendship.id
    from public.follows friendship
    where friendship.status='pending'
      and p_actor_persona_id in (friendship.follower,friendship.target)
    union all
    select 'family',family.target_id,family.label,null::uuid from direct_family family
    union all
    select 'family',family.target_id,family.label,null::uuid from sibling_family family
  ), unique_edges as (
    select edge.kind,edge.target_id,min(edge.label) label,edge.relationship_id
    from edges edge where edge.target_id<>p_actor_persona_id
    group by edge.kind,edge.target_id,edge.relationship_id
  )
  select edge.kind,
    case when access.allowed then target.id else null end,
    case when access.allowed then target.handle else '' end,
    case when access.allowed then target.name else 'Private persona' end,
    case when access.allowed then coalesce(target.tagline,'') else '' end,
    case when access.allowed then coalesce(target.title,'') else '' end,
    case when access.allowed
      and public.is_safe_credential_free_https_url(target.avatar_url,true)
      then coalesce(target.avatar_url,'') else '' end,
    case when access.allowed then coalesce(target.theme,'#ff4fa3') else '#667085' end,
    case when access.allowed then target.visibility else 'private' end,
    case when access.allowed then target.publication_state else '' end,
    edge.label,edge.relationship_id
  from unique_edges edge
  join public.personas target on target.id=edge.target_id
  cross join lateral (
    select public.persona_mode_can_view(p_actor_persona_id,target.id) allowed
  ) access
  where access.allowed or edge.kind in ('friend_incoming','friend_outgoing')
  order by case edge.kind
      when 'friend_incoming' then 0 when 'friend_outgoing' then 1
      when 'friend' then 2 when 'family' then 3 when 'following' then 4 else 5 end,
    case when access.allowed then target.name else '' end,
    coalesce(case when access.allowed then target.id end,edge.relationship_id)
  limit 200;
end
$$;

create or replace function public.my_persona_mode_feed(
  p_actor_persona_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns table(
  id uuid,
  persona_id uuid,
  kind text,
  title text,
  body text,
  tags text,
  media_url text,
  created_at timestamptz,
  persona_handle text,
  persona_name text,
  persona_avatar_url text,
  persona_theme text,
  connection_kinds text[]
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare v_limit integer:=least(greatest(coalesce(p_limit,30),1),50);
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if (p_before_created_at is null)<>(p_before_id is null) then
    raise exception 'Both feed cursor fields are required together';
  end if;
  if not exists (
    select 1 from public.personas actor
    where actor.id=p_actor_persona_id and actor.owner=auth.uid()
  ) then raise exception 'Owned acting persona not found'; end if;

  return query
  with direct_family as (
    select case when relationship.from_persona_id=p_actor_persona_id
      then relationship.to_persona_id else relationship.from_persona_id end target_id
    from public.persona_family_relationships relationship
    where relationship.owner=auth.uid()
      and relationship.visibility='public'
      and p_actor_persona_id in (relationship.from_persona_id,relationship.to_persona_id)
      and public.persona_publication_is_current(p_actor_persona_id)
      and exists (
        select 1 from public.persona_publication_dependencies dependency
        where dependency.persona_id=p_actor_persona_id
          and dependency.dependency_kind='family'
          and dependency.dependency_persona_id=case
            when relationship.from_persona_id=p_actor_persona_id
            then relationship.to_persona_id else relationship.from_persona_id end
      )
  ), sibling_family as (
    select other_child.to_persona_id target_id
    from public.persona_family_relationships my_parent
    join public.persona_family_relationships other_child
      on other_child.owner=my_parent.owner
     and other_child.relationship_type='parent_of'
     and other_child.from_persona_id=my_parent.from_persona_id
     and other_child.to_persona_id<>p_actor_persona_id
     and other_child.visibility='public'
    where my_parent.owner=auth.uid()
      and my_parent.relationship_type='parent_of'
      and my_parent.to_persona_id=p_actor_persona_id
      and my_parent.visibility='public'
      and public.persona_publication_is_current(p_actor_persona_id)
      and exists (
        select 1 from public.persona_publication_dependencies dependency
        where dependency.persona_id=p_actor_persona_id
          and dependency.dependency_kind='family'
          and dependency.dependency_persona_id=other_child.to_persona_id
      )
    group by other_child.to_persona_id
  ), raw_members as (
    select p_actor_persona_id target_id,'self'::text connection_kind
    union all
    select follow.target_persona_id,'following'
    from public.persona_follows follow
    where follow.follower_persona_id=p_actor_persona_id
    union all
    select case when friendship.follower=p_actor_persona_id
      then friendship.target else friendship.follower end,'friend'
    from public.follows friendship
    where friendship.status='accepted'
      and p_actor_persona_id in (friendship.follower,friendship.target)
    union all select family.target_id,'family' from direct_family family
    union all select family.target_id,'family' from sibling_family family
  ), members as (
    select member.target_id,array_agg(distinct member.connection_kind order by member.connection_kind) kinds
    from raw_members member
    where public.persona_mode_can_view(p_actor_persona_id,member.target_id)
    group by member.target_id
  )
  select post.id,post.persona_id,post.kind,coalesce(post.title,''),coalesce(post.body,''),
    coalesce(post.tags,''),
    case when public.is_safe_credential_free_https_url(post.media_url,true)
      then coalesce(post.media_url,'') else '' end,
    post.created_at,persona.handle,persona.name,
    case when public.is_safe_credential_free_https_url(persona.avatar_url,true)
      then coalesce(persona.avatar_url,'') else '' end,
    coalesce(persona.theme,'#ff4fa3'),member.kinds
  from members member
  join public.personas persona on persona.id=member.target_id
  join public.posts post on post.persona_id=persona.id
  where p_before_created_at is null
     or (post.created_at,post.id)<(p_before_created_at,p_before_id)
  order by post.created_at desc,post.id desc
  limit v_limit;
end
$$;

create or replace function public.my_persona_mode_profile_posts(
  p_actor_persona_id uuid,
  p_target_persona_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_kind text default 'all',
  p_search text default '',
  p_limit integer default 30
)
returns table(
  id uuid,
  persona_id uuid,
  kind text,
  title text,
  body text,
  tags text,
  media_url text,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_limit integer:=least(greatest(coalesce(p_limit,30),1),50);
  v_kind text:=lower(trim(coalesce(p_kind,'all')));
  v_search text:=left(trim(coalesce(p_search,'')),120);
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if v_kind not in ('all','post','reel') then raise exception 'Unsupported post kind'; end if;
  if (p_before_created_at is null)<>(p_before_id is null) then
    raise exception 'Both profile cursor fields are required together';
  end if;
  if not exists (
    select 1 from public.personas actor
    where actor.id=p_actor_persona_id and actor.owner=auth.uid()
  ) then raise exception 'Owned acting persona not found'; end if;
  if not public.persona_mode_can_view(p_actor_persona_id,p_target_persona_id) then
    raise exception 'Target page is not visible to the acting persona';
  end if;

  return query
  select post.id,post.persona_id,post.kind,coalesce(post.title,''),
    coalesce(post.body,''),coalesce(post.tags,''),
    case when public.is_safe_credential_free_https_url(post.media_url,true)
      then coalesce(post.media_url,'') else '' end,
    post.created_at
  from public.posts post
  where post.persona_id=p_target_persona_id
    and (v_kind='all' or post.kind=v_kind)
    and (
      v_search=''
      or post.title ilike '%'||v_search||'%'
      or post.body ilike '%'||v_search||'%'
      or post.tags ilike '%'||v_search||'%'
    )
    and (
      p_before_created_at is null
      or (post.created_at,post.id)<(p_before_created_at,p_before_id)
    )
  order by post.created_at desc,post.id desc
  limit v_limit;
end
$$;


create or replace function public.my_persona_mode_profile(
  p_actor_persona_id uuid,p_handle text,p_post_limit integer default 30
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_actor public.personas%rowtype;
  v_target public.personas%rowtype;
  v_friend public.follows%rowtype;
  v_limit integer:=least(greatest(coalesce(p_post_limit,30),1),50);
  v_links jsonb:='[]'::jsonb;
  v_posts jsonb:='[]'::jsonb;
  v_layout jsonb:='{}'::jsonb;
  v_relation_cards jsonb:='[]'::jsonb;
  v_albums jsonb:='[]'::jsonb;
  v_revenue jsonb:=null;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select actor.* into v_actor from public.personas actor
  where actor.id=p_actor_persona_id and actor.owner=auth.uid();
  if not found then raise exception 'Owned acting persona not found'; end if;
  select target.* into v_target from public.personas target
  where target.handle=lower(trim(coalesce(p_handle,'')));
  if not found or not public.persona_mode_can_view(v_actor.id,v_target.id) then return null; end if;

  select friendship.* into v_friend from public.follows friendship
  where least(friendship.follower,friendship.target)=least(v_actor.id,v_target.id)
    and greatest(friendship.follower,friendship.target)=greatest(v_actor.id,v_target.id)
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',link.id,'platform',link.platform,'handle',link.handle,'url',link.url,'sort',link.sort
  ) order by link.sort,link.id),'[]'::jsonb) into v_links
  from public.persona_links link
  where link.persona_id=v_target.id
    and public.is_safe_credential_free_https_url(link.url,false);

  select coalesce(jsonb_agg(to_jsonb(feed) order by feed.created_at desc,feed.id desc),'[]'::jsonb)
  into v_posts
  from public.my_persona_mode_profile_posts(
    v_actor.id,v_target.id,null,null,'all','',v_limit
  ) feed;

  select page.layout into v_layout
  from public.persona_page_layouts page where page.persona_id=v_target.id;
  v_layout:=coalesce(v_layout,'{}'::jsonb);

  select coalesce(jsonb_agg(jsonb_build_object(
    'dependency_kind',card.dependency_kind,
    'relative_persona_id',card.relative_persona_id,
    'relative_handle',card.relative_handle,
    'relative_name',card.relative_name,
    'relative_tagline',card.relative_tagline,
    'relative_avatar_url',case
      when public.is_safe_credential_free_https_url(card.relative_avatar_url,true)
      then coalesce(card.relative_avatar_url,'') else '' end,
    'relationship_label',card.relationship_label,'sort_order',card.sort_order
  ) order by card.dependency_kind,card.sort_order,card.relative_persona_id),'[]'::jsonb)
  into v_relation_cards
  from public.persona_relation_cards(v_target.id) card
  where public.persona_mode_can_view(v_actor.id,card.relative_persona_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',album.id,'title',album.title,'kind',album.kind,'sort',album.sort,
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'id',item.id,
      'thumb_url',case
        when public.is_safe_credential_free_https_url(item.thumb_url,true)
        then coalesce(item.thumb_url,'') else '' end,
      'caption',coalesce(item.caption,''),
      'link_url',case
        when public.is_safe_credential_free_https_url(item.link_url,false)
        then coalesce(item.link_url,'') else '' end,
      'sort',item.sort
    ) order by item.sort,item.id)
    from public.album_items item where item.album_id=album.id),'[]'::jsonb)
  ) order by album.sort,album.id),'[]'::jsonb)
  into v_albums from public.albums album where album.persona_id=v_target.id;

  select to_jsonb(rail) into v_revenue
  from public.get_public_persona_revenue_rails(v_target.handle) rail limit 1;

  return jsonb_build_object(
    'actor',jsonb_build_object(
      'id',v_actor.id,'can_interact',public.persona_mode_actor_can_interact(v_actor.id),
      'can_manage_relationships',public.persona_mode_actor_can_manage_relationships(v_actor.id)
    ),
    'persona',jsonb_build_object(
      'id',v_target.id,'handle',v_target.handle,'name',v_target.name,
      'tagline',coalesce(v_target.tagline,''),'bio',coalesce(v_target.bio,''),
      'nsfw',coalesce(v_target.nsfw,false),'visibility',v_target.visibility,
      'publication_state',v_target.publication_state,
      'avatar_url',case when public.is_safe_credential_free_https_url(v_target.avatar_url,true) then coalesce(v_target.avatar_url,'') else '' end,
      'banner_url',case when public.is_safe_credential_free_https_url(v_target.banner_url,true) then coalesce(v_target.banner_url,'') else '' end,
      'bg_url',case when public.is_safe_credential_free_https_url(v_target.bg_url,true) then coalesce(v_target.bg_url,'') else '' end,
      'feed_img_url',case when public.is_safe_credential_free_https_url(v_target.feed_img_url,true) then coalesce(v_target.feed_img_url,'') else '' end,
      'music_url',case when public.is_safe_credential_free_https_url(v_target.music_url,true) then coalesce(v_target.music_url,'') else '' end,
      'live_url',case when public.is_safe_credential_free_https_url(v_target.live_url,true) then coalesce(v_target.live_url,'') else '' end,
      'theme',coalesce(v_target.theme,'#ff4fa3'),'topics',coalesce(v_target.topics,''),
      'hashtags',coalesce(v_target.hashtags,''),'title',coalesce(v_target.title,''),
      'focus',coalesce(v_target.focus,''),'pet_project',coalesce(v_target.pet_project,''),
      'ai_disclosure',coalesce(v_target.ai_disclosure,''),
      'modules',public.canonical_persona_modules(v_target.modules)
    ),
    'relationship',jsonb_build_object(
      'following',exists(select 1 from public.persona_follows follow
        where follow.follower_persona_id=v_actor.id and follow.target_persona_id=v_target.id),
      'friendship_request_id',v_friend.id,
      'friendship_status',v_friend.status,
      'friendship_direction',case
        when v_friend.id is null then null
        when v_friend.follower=v_actor.id then 'outgoing'
        else 'incoming' end
    ),
    'links',v_links,'posts',v_posts,'layout',v_layout,
    'relation_cards',v_relation_cards,'albums',v_albums,'revenue',v_revenue
  );
end
$$;

create or replace function public.my_persona_mode_post_panel(
  p_actor_persona_id uuid,p_post_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_target_persona_id uuid;
  v_comments jsonb:='[]'::jsonb;
  v_reactions jsonb:='[]'::jsonb;
  v_comments_truncated boolean:=false;
  v_reactions_truncated boolean:=false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.personas actor
    where actor.id=p_actor_persona_id and actor.owner=auth.uid()) then
    raise exception 'Owned acting persona not found';
  end if;
  select post.persona_id into v_target_persona_id from public.posts post where post.id=p_post_id;
  if v_target_persona_id is null
     or not public.persona_mode_can_view(p_actor_persona_id,v_target_persona_id) then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',bounded.id,'body',bounded.body,'created_at',bounded.created_at,
    'persona_id',bounded.persona_id,'persona_name',bounded.persona_name,
    'persona_handle',bounded.persona_handle,'persona_avatar_url',bounded.persona_avatar_url,
    'owned_by_actor',bounded.persona_id=p_actor_persona_id
  ) order by bounded.created_at,bounded.id) filter(where bounded.ordinal<=100),'[]'::jsonb),
    coalesce(max(bounded.ordinal)>100,false)
  into v_comments,v_comments_truncated
  from (
    select comment.id,comment.body,comment.created_at,comment.persona_id,
      author.name persona_name,author.handle persona_handle,
      case when public.is_safe_credential_free_https_url(author.avatar_url,true)
        then coalesce(author.avatar_url,'') else '' end persona_avatar_url,
      row_number() over(order by comment.created_at desc,comment.id desc) ordinal
    from public.comments comment
    join public.personas author on author.id=comment.persona_id
    where comment.post_id=p_post_id
      and public.persona_mode_can_view(p_actor_persona_id,author.id)
    order by comment.created_at desc,comment.id desc
    limit 101
  ) bounded;

  select coalesce(jsonb_agg(jsonb_build_object(
    'kind',bounded.kind,'persona_id',bounded.persona_id,
    'owned_by_actor',bounded.persona_id=p_actor_persona_id
  ) order by bounded.kind,bounded.persona_id) filter(where bounded.ordinal<=500),'[]'::jsonb),
    coalesce(max(bounded.ordinal)>500,false)
  into v_reactions,v_reactions_truncated
  from (
    select reaction.kind,reaction.persona_id,
      row_number() over(order by reaction.kind,reaction.persona_id) ordinal
    from public.reactions reaction
    where reaction.post_id=p_post_id
      and public.persona_mode_can_view(p_actor_persona_id,reaction.persona_id)
    order by reaction.kind,reaction.persona_id
    limit 501
  ) bounded;

  return jsonb_build_object(
    'can_interact',public.persona_mode_actor_can_interact(p_actor_persona_id),
    'can_manage_relationships',public.persona_mode_actor_can_manage_relationships(p_actor_persona_id),
    'comments',v_comments,'reactions',v_reactions,
    'comments_truncated',v_comments_truncated,
    'reactions_truncated',v_reactions_truncated
  );
end
$$;

create or replace function public.persona_mode_follow_persona(
  p_actor_persona_id uuid,p_target_persona_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051060)
  );
  perform public.persona_mode_lock_exact_scope(
    p_actor_persona_id,p_target_persona_id,true
  );
  if not public.persona_mode_actor_can_interact(p_actor_persona_id) then
    raise exception 'Acting persona must be a current published public or unlisted page';
  end if;
  if not public.persona_mode_can_view(p_actor_persona_id,p_target_persona_id) then
    raise exception 'Target page is not visible to the acting persona';
  end if;
  return public.follow_persona(p_actor_persona_id,p_target_persona_id,'public');
end
$$;

create or replace function public.persona_mode_unfollow_persona(
  p_actor_persona_id uuid,p_target_persona_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051060)
  );
  perform public.persona_mode_lock_exact_scope(
    p_actor_persona_id,p_target_persona_id,true
  );
  if not public.persona_mode_actor_can_manage_relationships(p_actor_persona_id) then
    raise exception 'Acting persona must have a current published page';
  end if;
  return public.unfollow_persona(p_actor_persona_id,p_target_persona_id);
end
$$;

create or replace function public.persona_mode_request_friendship(
  p_actor_persona_id uuid,p_target_persona_id uuid,p_invite_token text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051)
  );
  perform public.persona_mode_lock_exact_scope(
    p_actor_persona_id,p_target_persona_id,true
  );
  if not public.persona_mode_actor_can_interact(p_actor_persona_id) then
    raise exception 'Acting persona must be a current published public or unlisted page';
  end if;
  if trim(coalesce(p_invite_token,''))=''
     and not public.persona_mode_can_view(p_actor_persona_id,p_target_persona_id) then
    raise exception 'Target page is not visible to the acting persona';
  end if;
  return public.request_persona_friendship(
    p_actor_persona_id,p_target_persona_id,p_invite_token
  );
end
$$;

create or replace function public.persona_mode_respond_friendship(
  p_actor_persona_id uuid,p_request_id uuid,p_accept boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_follower uuid;v_target uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select friendship.follower,friendship.target into v_follower,v_target
  from public.follows friendship where friendship.id=p_request_id;
  if v_target is distinct from p_actor_persona_id then
    raise exception 'Friend request is not addressed to the acting persona';
  end if;
  perform public.persona_mode_lock_exact_scope(p_actor_persona_id,v_follower,true);
  select friendship.follower,friendship.target into v_follower,v_target
  from public.follows friendship
  where friendship.id=p_request_id and friendship.status='pending'
  for update;
  if v_target is distinct from p_actor_persona_id then
    raise exception 'Friend request is not addressed to the acting persona';
  end if;
  if not public.persona_mode_actor_can_manage_relationships(p_actor_persona_id) then
    raise exception 'Acting persona must have a current published page';
  end if;
  return public.respond_persona_friendship(p_request_id,p_accept);
end
$$;

create or replace function public.persona_mode_cancel_friendship_request(
  p_actor_persona_id uuid,p_request_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_follower uuid;v_target uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select friendship.follower,friendship.target into v_follower,v_target
  from public.follows friendship where friendship.id=p_request_id;
  if v_follower is distinct from p_actor_persona_id then
    raise exception 'Friend request was not sent by the acting persona';
  end if;
  perform public.persona_mode_lock_exact_scope(p_actor_persona_id,v_target,true);
  select friendship.follower,friendship.target into v_follower,v_target
  from public.follows friendship
  where friendship.id=p_request_id and friendship.status='pending'
  for update;
  if v_follower is distinct from p_actor_persona_id then
    raise exception 'Friend request was not sent by the acting persona';
  end if;
  if not public.persona_mode_actor_can_manage_relationships(p_actor_persona_id) then
    raise exception 'Acting persona must have a current published page';
  end if;
  return public.remove_persona_friendship(p_actor_persona_id,v_target);
end
$$;

create or replace function public.persona_mode_remove_friendship(
  p_actor_persona_id uuid,p_other_persona_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform public.persona_mode_lock_exact_scope(
    p_actor_persona_id,p_other_persona_id,true
  );
  if not public.persona_mode_actor_can_manage_relationships(p_actor_persona_id) then
    raise exception 'Acting persona must have a current published page';
  end if;
  return public.remove_persona_friendship(p_actor_persona_id,p_other_persona_id);
end
$$;

create or replace function public.persona_mode_add_comment(
  p_actor_persona_id uuid,p_post_id uuid,p_body text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_target uuid;v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select post.persona_id into v_target from public.posts post where post.id=p_post_id;
  if v_target is null then raise exception 'Post is not visible to the acting persona'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner::text,51051052)
  );
  perform public.persona_mode_lock_exact_scope(p_actor_persona_id,v_target,true);
  perform 1 from public.follows friendship
  where friendship.status='accepted'
    and least(friendship.follower,friendship.target)=least(p_actor_persona_id,v_target)
    and greatest(friendship.follower,friendship.target)=greatest(p_actor_persona_id,v_target)
  for share;
  if not public.persona_mode_actor_can_interact(p_actor_persona_id) then
    raise exception 'Acting persona must be a current published public or unlisted page';
  end if;
  if not exists (select 1 from public.posts post
       where post.id=p_post_id and post.persona_id=v_target)
     or not public.persona_mode_can_view(p_actor_persona_id,v_target) then
    raise exception 'Post is not visible to the acting persona';
  end if;
  return public.add_persona_comment(p_post_id,p_actor_persona_id,p_body);
end
$$;

create or replace function public.persona_mode_toggle_reaction(
  p_actor_persona_id uuid,p_post_id uuid,p_kind text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_target uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select post.persona_id into v_target from public.posts post where post.id=p_post_id;
  if v_target is null then raise exception 'Post is not visible to the acting persona'; end if;
  perform public.persona_mode_lock_exact_scope(p_actor_persona_id,v_target,true);
  perform 1 from public.follows friendship
  where friendship.status='accepted'
    and least(friendship.follower,friendship.target)=least(p_actor_persona_id,v_target)
    and greatest(friendship.follower,friendship.target)=greatest(p_actor_persona_id,v_target)
  for share;
  if not public.persona_mode_actor_can_interact(p_actor_persona_id) then
    raise exception 'Acting persona must be a current published public or unlisted page';
  end if;
  if not exists (select 1 from public.posts post
       where post.id=p_post_id and post.persona_id=v_target)
     or not public.persona_mode_can_view(p_actor_persona_id,v_target) then
    raise exception 'Post is not visible to the acting persona';
  end if;
  return public.toggle_persona_reaction(p_post_id,p_actor_persona_id,p_kind);
end
$$;

create or replace function public.persona_mode_delete_comment(
  p_actor_persona_id uuid,p_comment_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.personas actor
    where actor.id=p_actor_persona_id and actor.owner=auth.uid()) then
    raise exception 'Owned acting persona not found';
  end if;
  if not exists (select 1 from public.comments comment
    where comment.id=p_comment_id and comment.persona_id=p_actor_persona_id) then
    raise exception 'Comment is not owned by the acting persona';
  end if;
  return public.delete_persona_comment(p_comment_id);
end
$$;

revoke all on function public.my_persona_mode_status(uuid),
  public.my_persona_mode_connections(uuid),
  public.my_persona_mode_feed(uuid,timestamptz,uuid,integer),
  public.my_persona_mode_profile_posts(uuid,uuid,timestamptz,uuid,text,text,integer),
  public.my_persona_mode_profile(uuid,text,integer),
  public.my_persona_mode_post_panel(uuid,uuid),
  public.persona_mode_follow_persona(uuid,uuid),
  public.persona_mode_unfollow_persona(uuid,uuid),
  public.persona_mode_request_friendship(uuid,uuid,text),
  public.persona_mode_respond_friendship(uuid,uuid,boolean),
  public.persona_mode_cancel_friendship_request(uuid,uuid),
  public.persona_mode_remove_friendship(uuid,uuid),
  public.persona_mode_add_comment(uuid,uuid,text),
  public.persona_mode_toggle_reaction(uuid,uuid,text),
  public.persona_mode_delete_comment(uuid,uuid)
  from public,anon,authenticated;

grant execute on function public.my_persona_mode_status(uuid),
  public.my_persona_mode_connections(uuid),
  public.my_persona_mode_feed(uuid,timestamptz,uuid,integer),
  public.my_persona_mode_profile_posts(uuid,uuid,timestamptz,uuid,text,text,integer),
  public.my_persona_mode_profile(uuid,text,integer),
  public.my_persona_mode_post_panel(uuid,uuid),
  public.persona_mode_follow_persona(uuid,uuid),
  public.persona_mode_unfollow_persona(uuid,uuid),
  public.persona_mode_request_friendship(uuid,uuid,text),
  public.persona_mode_respond_friendship(uuid,uuid,boolean),
  public.persona_mode_cancel_friendship_request(uuid,uuid),
  public.persona_mode_remove_friendship(uuid,uuid),
  public.persona_mode_add_comment(uuid,uuid,text),
  public.persona_mode_toggle_reaction(uuid,uuid,text),
  public.persona_mode_delete_comment(uuid,uuid)
  to authenticated;

comment on function public.my_persona_mode_feed(uuid,timestamptz,uuid,integer) is
  'Bounded exact-actor feed. It never inherits a sibling persona private relationship.';
comment on function public.my_persona_mode_profile(uuid,text,integer) is
  'Exact-actor profile projection. Owner access to a sibling does not bypass persona visibility.';
comment on function public.my_persona_mode_profile_posts(uuid,uuid,timestamptz,uuid,text,text,integer) is
  'Bounded exact-actor profile pagination and search without account-wide post reads.';

commit;
