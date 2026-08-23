\set ON_ERROR_STOP on
\pset pager off

-- Run after the complete ordered 047-057 package has applied and reapplied in
-- the same disposable database seeded by 047-057-coordinated-seed.sql.
-- The transaction creates only a temporary assertion helper and is rolled back.

begin;

create or replace function pg_temp.assert_true(p_condition boolean,p_message text)
returns void language plpgsql set search_path='' as $$
begin
  if not coalesce(p_condition,false) then
    raise exception 'ASSERTION FAILED: %',p_message;
  end if;
  raise notice 'PASS: %',p_message;
end
$$;

select pg_temp.assert_true(
  (select count(*)=21 from public.personas
   where owner='04700000-0000-4000-8000-000000000001'),
  'the coordinated owner retains exactly 21 seeded Castleborn project personas'
);

with expected(handle,name) as (values
  ('castleborn.rohan','Rohan Dev'),
  ('castleborn.maria','Maria Luna Garcia'),
  ('castleborn.cillian','Cillian O''Sullivan'),
  ('castleborn.akiko','Akiko Sasaki'),
  ('castleborn.yarra','Yarra Warruwi'),
  ('castleborn.sophia','Sophia Ona'),
  ('castleborn.kunuk','Kunuk Atiq'),
  ('castleborn.avi','Avi Dev'),
  ('castleborn.lilly','Lilly Dev'),
  ('castleborn.brom','Brom Grigoriev'),
  ('castleborn.zara','Zara Grigoriev'),
  ('castleborn.song','Song O''Sasaki'),
  ('castleborn.rhythm','Rhythm O''Sasaki'),
  ('castleborn.lyric','Lyric O''Sasaki'),
  ('castleborn.adam','Adam Atiq'),
  ('castleborn.fenrir','Fenrir Ona-Right'),
  ('castleborn.hecatia','Hecatia Ona-Right'),
  ('castleborn.adeola','Adeola Dossou')
), comparison as (
  select expected.handle,expected.name as expected_name,persona.name as actual_name
  from expected left join public.personas persona using(handle)
)
select pg_temp.assert_true(
  (select count(*)=18 and bool_and(actual_name=expected_name) from comparison),
  'all 18 guarded full-name changes match the owner-confirmed canon'
);

select pg_temp.assert_true(
  not exists(select 1 from public.personas where name='Abel Atiq'),
  'the migration did not invent an absent Abel Atiq persona'
);

select pg_temp.assert_true(
  (select count(*)=20 from public.persona_family_relationships
   where owner='04700000-0000-4000-8000-000000000001'
     and relationship_type='parent_of'),
  'the exact Castleborn parent seed contains 20 directed parent edges'
);

select pg_temp.assert_true(
  (select count(*)=4 from public.persona_family_relationships
   where owner='04700000-0000-4000-8000-000000000001'
     and relationship_type='partner'),
  'the exact Castleborn partner seed contains four normalized partner edges'
);

select pg_temp.assert_true(
  (select count(*)=21 from public.persona_project_memberships membership
   join public.persona_projects project on project.id=membership.project_id
   where project.owner='04700000-0000-4000-8000-000000000001'
     and project.slug='castleborn'),
  'the private Castleborn project contains all 21 existing personas'
);

select pg_temp.assert_true(
  (select count(*)=1 and bool_and(persona.handle='wais')
   from public.persona_project_memberships membership
   join public.persona_projects project on project.id=membership.project_id
   join public.personas persona on persona.id=membership.persona_id
   where project.owner='04700000-0000-4000-8000-000000000001'
     and project.slug='castleborn' and membership.role='manager'),
  'WAIS is the only Castleborn project manager'
);

select pg_temp.assert_true(
  (select count(*)=1 and bool_and(page_status='draft' and visibility='owner_only'
    and short_bio='' and mission='')
   from public.businesses
   where owner='04700000-0000-4000-8000-000000000001' and slug='castleborn'),
  'the Castleborn business remains one blank owner-private draft'
);

select pg_temp.assert_true(
  not exists(
    select 1 from public.business_persona_memberships membership
    join public.businesses business on business.id=membership.business_id
    where business.owner='04700000-0000-4000-8000-000000000001'
      and business.slug='castleborn'
  ),
  'no business title or membership was invented'
);

select pg_temp.assert_true(
  not exists(
    select 1 from public.business_mission_items item
    join public.businesses business on business.id=item.business_id
    where business.owner='04700000-0000-4000-8000-000000000001'
      and business.slug='castleborn'
  ),
  'no business mission item was invented'
);

select pg_temp.assert_true(
  not exists(
    select 1 from public.project_resources resource
    join public.persona_projects project on project.id=resource.project_id
    where project.owner='04700000-0000-4000-8000-000000000001'
      and project.slug='castleborn'
  ),
  'no Castleborn database resource was fabricated'
);

select pg_temp.assert_true(
  to_regclass('public.persona_backup_relationships') is not null
  and to_regclass('public.persona_page_layouts') is not null
  and to_regclass('public.persona_publication_reviews') is not null
  and to_regclass('public.business_publication_reviews') is not null
  and to_regclass('public.agent_board_requests') is not null
  and to_regclass('public.persona_content_packages') is not null
  and to_regclass('public.agent_action_storage_usage') is not null
  and to_regprocedure('public.invalidate_stale_aliaspaces_email_attestations()') is not null
  and to_regclass('public.ai_backend_budget_policies') is not null,
  'all coordinated feature boundaries exist after ordered apply and reapply'
);

rollback;
