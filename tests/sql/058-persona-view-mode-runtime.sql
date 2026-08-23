\set ON_ERROR_STOP on

insert into public.profiles(id) values
 ('05800000-0000-4000-8000-000000000001'),('05800000-0000-4000-8000-000000000002');
insert into public.personas(id,owner,handle,name,visibility,publication_state,publication_revision,published_revision) values
 ('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000001','actor-a','Actor A','public','published',1,1),
 ('05800000-0000-4000-8000-000000000102','05800000-0000-4000-8000-000000000001','sibling-b','Sibling B','public','published',1,1),
 ('05800000-0000-4000-8000-000000000103','05800000-0000-4000-8000-000000000001','draft-c','Draft C','public','draft',2,null),
 ('05800000-0000-4000-8000-000000000201','05800000-0000-4000-8000-000000000002','private-target','Private Target','private','published',1,1),
 ('05800000-0000-4000-8000-000000000202','05800000-0000-4000-8000-000000000002','public-target','Public Target','public','published',1,1);
insert into public.follows(follower,target,status) values
 ('05800000-0000-4000-8000-000000000102','05800000-0000-4000-8000-000000000201','accepted');
insert into public.persona_family_relationships values
 ('05800000-0000-4000-8000-000000000001','partner','05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000102','public','owner_confirmed');
insert into public.persona_publication_dependencies(persona_id,dependency_persona_id,dependency_kind) values
 ('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000102','family');
insert into public.posts(id,persona_id,title,body,created_at) values
 ('05800000-0000-4000-8000-000000000301','05800000-0000-4000-8000-000000000202','Visible post','Public body','2026-08-22T10:00:00Z');
insert into public.comments(id,post_id,persona_id,body,created_at) values
 ('05800000-0000-4000-8000-000000000401','05800000-0000-4000-8000-000000000301','05800000-0000-4000-8000-000000000201','Private author','2026-08-22T10:01:00Z'),
 ('05800000-0000-4000-8000-000000000402','05800000-0000-4000-8000-000000000301','05800000-0000-4000-8000-000000000101','Actor author','2026-08-22T10:02:00Z');

select set_config('request.jwt.claim.sub','05800000-0000-4000-8000-000000000001',false);

do $$
declare panel jsonb;profile jsonb;denied boolean:=false;
begin
  if public.persona_mode_can_view('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000201') then raise exception 'Actor A inherited sibling private access';end if;
  if not public.persona_mode_can_view('05800000-0000-4000-8000-000000000102','05800000-0000-4000-8000-000000000201') then raise exception 'Exact friend could not see private target';end if;
  if not public.persona_mode_can_view('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000202') then raise exception 'Public target unavailable';end if;
  profile:=public.my_persona_mode_profile('05800000-0000-4000-8000-000000000101','private-target',30);
  if profile is not null then raise exception 'Private profile leaked to wrong actor';end if;
  panel:=public.my_persona_mode_post_panel('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000301');
  if jsonb_array_length(panel->'comments')<>1 or panel->'comments'->0->>'persona_id'<>'05800000-0000-4000-8000-000000000101' then raise exception 'Post panel leaked a sibling-only private author';end if;
  begin perform public.persona_mode_delete_comment('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000401');exception when others then denied:=true;end;
  if not denied then raise exception 'Actor deleted sibling-visible comment';end if;
  denied:=false;
  begin perform public.persona_mode_follow_persona('05800000-0000-4000-8000-000000000103','05800000-0000-4000-8000-000000000202');exception when others then denied:=true;end;
  if not denied then raise exception 'Draft actor followed outwardly';end if;
end
$$;

select public.persona_mode_follow_persona(
  '05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000202'
);
do $$ begin
  if not exists(select 1 from public.persona_follows where follower_persona_id='05800000-0000-4000-8000-000000000101' and target_persona_id='05800000-0000-4000-8000-000000000202') then raise exception 'Exact follow wrapper did not mutate';end if;
  if not exists(select 1 from public.my_persona_mode_connections('05800000-0000-4000-8000-000000000101') where connection_kind='family' and persona_id='05800000-0000-4000-8000-000000000102') then raise exception 'Reviewed public family connection missing';end if;
end $$;

insert into public.follows(id,follower,target,status) values
 ('05800000-0000-4000-8000-000000000501','05800000-0000-4000-8000-000000000202','05800000-0000-4000-8000-000000000102','pending');
do $$ declare denied boolean:=false;begin
  begin perform public.persona_mode_respond_friendship('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000501',true);exception when others then denied:=true;end;
  if not denied then raise exception 'Actor A answered a request addressed to sibling B';end if;
end $$;

-- Pending requests remain actionable if the other profile is private, without
-- disclosing its id, handle, image, or copy through the connection projection.
insert into public.follows(id,follower,target,status) values
 ('05800000-0000-4000-8000-000000000502','05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000201','pending');
do $$ declare pending record;begin
  select * into pending
  from public.my_persona_mode_connections('05800000-0000-4000-8000-000000000101')
  where connection_kind='friend_outgoing' and relationship_id='05800000-0000-4000-8000-000000000502';
  if not found or pending.persona_id is not null or pending.handle<>''
     or pending.name<>'Private persona' or pending.avatar_url<>'' then
    raise exception 'Private outgoing request identity was not safely redacted';
  end if;
end $$;
select public.persona_mode_cancel_friendship_request(
  '05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000502'
);
do $$ begin
  if exists(select 1 from public.follows where id='05800000-0000-4000-8000-000000000502') then
    raise exception 'Exact actor could not cancel a redacted outgoing request';
  end if;
end $$;

insert into public.follows(id,follower,target,status) values
 ('05800000-0000-4000-8000-000000000503','05800000-0000-4000-8000-000000000201','05800000-0000-4000-8000-000000000101','pending');
do $$ declare pending record;begin
  select * into pending
  from public.my_persona_mode_connections('05800000-0000-4000-8000-000000000101')
  where connection_kind='friend_incoming' and relationship_id='05800000-0000-4000-8000-000000000503';
  if not found or pending.persona_id is not null or pending.name<>'Private persona' then
    raise exception 'Private incoming request was not redacted and retained';
  end if;
end $$;
select public.persona_mode_respond_friendship(
  '05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000503',false
);

-- A block against any identity owned by the acting account suppresses the
-- target, and block/mute rules on reviewed dependencies suppress the page.
insert into public.blocks(blocker,blocked_persona,kind) values
 ('05800000-0000-4000-8000-000000000002','05800000-0000-4000-8000-000000000102','block');
do $$ begin
  if public.persona_mode_can_view('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000202') then
    raise exception 'Target-owner block against an owned sibling did not suppress exact view';
  end if;
end $$;
delete from public.blocks where blocker='05800000-0000-4000-8000-000000000002';
insert into public.persona_publication_dependencies(persona_id,dependency_persona_id,dependency_kind) values
 ('05800000-0000-4000-8000-000000000202','05800000-0000-4000-8000-000000000201','linked');
insert into public.blocks(blocker,blocked_persona,kind) values
 ('05800000-0000-4000-8000-000000000001','05800000-0000-4000-8000-000000000201','mute');
do $$ begin
  if public.persona_mode_can_view('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000202') then
    raise exception 'Muted reviewed dependency did not suppress the target page';
  end if;
end $$;
delete from public.blocks where blocker='05800000-0000-4000-8000-000000000001';

do $$ declare status jsonb;begin
  status:=public.my_persona_mode_status('05800000-0000-4000-8000-000000000101');
  if status->>'id'<>'05800000-0000-4000-8000-000000000101'
     or (status->>'can_interact')::boolean is not true then
    raise exception 'Server-authoritative actor capability status is incorrect';
  end if;
end $$;

-- Two sessions reproduce the dependency-replacement TOCTOU: the local exact
-- action snapshots D1 while a publisher holds the actor lock, then the publisher
-- replaces D1 with D2. The helper must abort instead of proceeding with D2 unlocked.
select dblink_connect('dependency_race','dbname=postgres user=postgres');
select dblink_send_query('dependency_race',$remote$
  do $race$
  begin
    perform public.lock_persona_publication_mutation('05800000-0000-4000-8000-000000000101');
    perform pg_sleep(0.6);
    delete from public.persona_publication_dependencies
    where persona_id='05800000-0000-4000-8000-000000000101';
    insert into public.persona_publication_dependencies(persona_id,dependency_persona_id,dependency_kind)
    values('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000103','family');
  end
  $race$;
$remote$);
select pg_sleep(0.15);
do $$ declare denied boolean:=false;begin
  begin
    perform public.persona_mode_lock_exact_scope(
      '05800000-0000-4000-8000-000000000101',
      '05800000-0000-4000-8000-000000000202',true
    );
  exception when serialization_failure then denied:=true;end;
  if not denied then raise exception 'Dependency replacement proceeded with an unlocked dependency';end if;
end $$;
select * from dblink_get_result('dependency_race') as result(status text);
select dblink_disconnect('dependency_race');

-- Privileges are exercised as the API roles, not only as the database owner.
select set_config('request.jwt.claim.sub','',false);
set role anon;
do $$ declare denied boolean:=false;begin
  if exists(select 1 from public.personas) then raise exception 'Anon bypassed persona RLS';end if;
  begin perform public.my_persona_mode_status('05800000-0000-4000-8000-000000000101');
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Anon executed an authenticated persona-mode RPC';end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub','05800000-0000-4000-8000-000000000001',false);
set role authenticated;
do $$ declare status jsonb;denied boolean:=false;begin
  if exists(select 1 from public.personas) then raise exception 'Authenticated caller bypassed harness RLS directly';end if;
  status:=public.my_persona_mode_status('05800000-0000-4000-8000-000000000101');
  if status->>'handle'<>'actor-a' then raise exception 'Authenticated RPC did not retain auth context';end if;
  begin perform public.persona_mode_can_view('05800000-0000-4000-8000-000000000101','05800000-0000-4000-8000-000000000202');
  exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Authenticated role executed revoked internal helper';end if;
end $$;
reset role;

select 'persona-view-058-runtime-ok' as result;
