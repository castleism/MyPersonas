\set ON_ERROR_STOP on

-- Run only against a disposable pre-055 schema. This fixture represents the
-- inherited scheduler's append-only start + terminal format, plus version-2 and
-- persona starts that a safe reapplication must never relabel.
insert into auth.users(id,email,email_confirmed_at) values(
  '05510000-0000-4000-8000-000000000001',
  'upgrade-055@example.test',now()
);
insert into public.profiles(id,email,display_name) values(
  '05510000-0000-4000-8000-000000000001',
  'upgrade-055@example.test','055 upgrade fixture'
) on conflict(id) do update set display_name=excluded.display_name;
insert into public.personas(id,owner,handle,name) values(
  '05510000-0000-4000-8000-000000000002',
  '05510000-0000-4000-8000-000000000001',
  'upgrade055','Upgrade 055'
);
delete from public.agent_actions
where owner='05510000-0000-4000-8000-000000000001';

insert into public.agent_actions(
  id,owner,persona_id,action_type,entity_type,entity_id,outcome,detail,created_at
) values
(
  '05510000-0000-4000-8000-000000000010',
  '05510000-0000-4000-8000-000000000001',
  '05510000-0000-4000-8000-000000000002',
  'ai.call.started','ai_task','05510000-0000-4000-8000-000000000020',
  'started','{"generationRequest":1}'::jsonb,now()-interval '2 days'
),(
  '05510000-0000-4000-8000-000000000011',
  '05510000-0000-4000-8000-000000000001',
  '05510000-0000-4000-8000-000000000002',
  'ai.call.completed','ai_task','05510000-0000-4000-8000-000000000020',
  'ok','{"provider":"legacy"}'::jsonb,now()-interval '2 days'+interval '1 minute'
),(
  '05510000-0000-4000-8000-000000000012',
  '05510000-0000-4000-8000-000000000001',
  '05510000-0000-4000-8000-000000000002',
  'ai.call.started','ai_task','05510000-0000-4000-8000-000000000021',
  'started','{"generationRequest":2}'::jsonb,now()-interval '1 day'
),(
  '05510000-0000-4000-8000-000000000013',
  '05510000-0000-4000-8000-000000000001',
  '05510000-0000-4000-8000-000000000002',
  'ai.call.failed','ai_task','05510000-0000-4000-8000-000000000021',
  'error','{"provider":"legacy"}'::jsonb,now()-interval '1 day'+interval '1 minute'
),(
  '05510000-0000-4000-8000-000000000014',
  '05510000-0000-4000-8000-000000000001',
  '05510000-0000-4000-8000-000000000002',
  'ai.call.started','ai_task','05510000-0000-4000-8000-000000000022',
  'started','{"auditLifecycleVersion":2,"leaseToken":"05510000-0000-4000-8000-000000000030"}'::jsonb,
  now()-interval '10 minutes'
),(
  '05510000-0000-4000-8000-000000000015',
  '05510000-0000-4000-8000-000000000001',
  '05510000-0000-4000-8000-000000000002',
  'ai.call.started','persona_ai_call','05510000-0000-4000-8000-000000000002',
  'started','{"mode":"owner_chat"}'::jsonb,now()-interval '1 minute'
),(
  '05510000-0000-4000-8000-000000000016',
  '05510000-0000-4000-8000-000000000001',
  '05510000-0000-4000-8000-000000000002',
  'ai.call.started','ai_task','05510000-0000-4000-8000-000000000024',
  'started','{"generationRequest":3}'::jsonb,now()-interval '2 minutes'
);
