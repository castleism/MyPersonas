-- 022-fix-persona-delete-audit.sql
-- Deleting a persona failed with:
--   insert or update on table "agent_actions" violates foreign key constraint
--   "agent_actions_binding_id_fkey"
--
-- Cause: deleting a persona cascades personas -> agent_bindings ->
-- agent_destinations. The audit trigger on agent_destinations then inserts an
-- agent_actions row that references the binding (and persona) deleted earlier
-- in the same cascade, so the insert's foreign keys fail and abort the whole
-- persona delete.
--
-- Fix: the audit insert references the binding/persona only if that row still
-- exists, otherwise records NULL. Nothing is lost — audit rows written during
-- a persona cascade are themselves cascade-deleted with the persona; for a
-- normal standalone destination delete both rows still exist and the audit
-- keeps exactly the context it does today. The action detail always retains
-- the destination snapshot regardless.

create or replace function public.audit_agent_destination_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    insert into public.agent_actions (
      owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
    ) values (
      old.owner,
      (select p.id from public.personas p where p.id = old.persona_id),
      (select b.id from public.agent_bindings b where b.id = old.binding_id),
      'destination.deleted',
      'destination', old.id,
      jsonb_build_object('destination',old.destination,'mode',old.mode,
        'enabled',old.enabled,'daily_publish_limit',old.daily_publish_limit,
        'persona_id',old.persona_id)
    );
    return old;
  end if;
  if tg_op = 'INSERT' then
    insert into public.agent_actions (
      owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
    ) values (
      new.owner,
      (select p.id from public.personas p where p.id = new.persona_id),
      (select b.id from public.agent_bindings b where b.id = new.binding_id),
      'destination.created',
      'destination', new.id,
      jsonb_build_object('destination',new.destination,'mode',new.mode,
        'enabled',new.enabled,'daily_publish_limit',new.daily_publish_limit)
    );
    return new;
  end if;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
  ) values (
    new.owner,
    (select p.id from public.personas p where p.id = new.persona_id),
    (select b.id from public.agent_bindings b where b.id = new.binding_id),
    'destination.updated',
    'destination', new.id,
    jsonb_build_object('destination',new.destination,'mode_from',old.mode,
      'mode_to',new.mode,'enabled',new.enabled,
      'daily_publish_limit',new.daily_publish_limit)
  );
  return new;
end;
$$;

-- Trigger definition is unchanged (same name, timing, and events); replacing
-- the function body is sufficient. Re-assert the revokes for safety.
revoke all on function public.audit_agent_destination_change()
  from public, anon, authenticated;
