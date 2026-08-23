\set ON_ERROR_STOP on

do $$
declare v_usage public.agent_action_storage_usage%rowtype;
begin
  if (select count(*) from public.agent_actions
      where owner='05510000-0000-4000-8000-000000000001'
        and action_type='ai.call.legacy_started'
        and outcome='legacy_unreserved'
        and detail->>'legacy_lifecycle'='separate_terminal_or_unknown')<>2 then
    raise exception 'Legacy ai_task starts were not transparently normalized';
  end if;
  if not exists(select 1 from public.agent_actions
      where id='05510000-0000-4000-8000-000000000016'
        and action_type='ai.call.started' and outcome='started'
        and detail->>'auditLifecycleVersion'='1'
        and detail->>'legacy_lifecycle'='possible_inflight_at_upgrade') then
    raise exception 'Recent unmatched legacy start was not preserved as an in-flight candidate';
  end if;
  if not exists(select 1 from public.agent_actions
      where id='05510000-0000-4000-8000-000000000014'
        and action_type='ai.call.started' and outcome='started'
        and detail->>'auditLifecycleVersion'='2') then
    raise exception 'Version-2 open lifecycle was relabeled during upgrade/reapply';
  end if;
  if not exists(select 1 from public.agent_actions
      where id='05510000-0000-4000-8000-000000000015'
        and action_type='ai.call.started' and outcome='started'
        and entity_type='persona_ai_call') then
    raise exception 'Persona open lifecycle was relabeled during upgrade/reapply';
  end if;

  -- On the first invocation (after the initial 055 apply), create a genuine
  -- version-2 lifecycle through the new narrow service writer. On the second
  -- invocation (after reapplying 055), require the same exact row to remain a
  -- start. This proves reapplication cannot relabel post-upgrade history.
  if not exists(select 1 from public.agent_actions
      where owner='05510000-0000-4000-8000-000000000001'
        and entity_type='ai_task'
        and entity_id='05510000-0000-4000-8000-000000000023'
        and detail->>'upgrade_test'='post_055_v2') then
    perform set_config('request.jwt.claim.role','service_role',true);
    perform public.insert_agent_action_service(
      '05510000-0000-4000-8000-000000000001',
      '05510000-0000-4000-8000-000000000002',null,
      'ai.call.started','ai_task','05510000-0000-4000-8000-000000000023',
      'started','{"auditLifecycleVersion":2,"upgrade_test":"post_055_v2"}'::jsonb
    );
  end if;
  if (select count(*) from public.agent_actions
      where owner='05510000-0000-4000-8000-000000000001'
        and entity_type='ai_task'
        and entity_id='05510000-0000-4000-8000-000000000023'
        and action_type='ai.call.started' and outcome='started'
        and detail->>'auditLifecycleVersion'='2'
        and detail->>'upgrade_test'='post_055_v2')<>1 then
    raise exception 'Post-upgrade version-2 lifecycle was relabeled or duplicated';
  end if;

  select * into v_usage from public.agent_action_storage_usage
  where owner='05510000-0000-4000-8000-000000000001';
  if not found or v_usage.stored_rows<>8
     or v_usage.pending_terminal_mutations<>4 then
    raise exception 'Upgrade seed receipt is not exact: rows %, pending %',
      v_usage.stored_rows,v_usage.pending_terminal_mutations;
  end if;
  if v_usage.stored_bytes+v_usage.pending_terminal_bytes<262144 then
    raise exception 'Version-2 and persona terminal bytes were not reserved';
  end if;
  raise notice 'PASS: history normalized; in-flight v1, pre/post-upgrade v2, and persona starts retained and reserved';
end
$$;
