-- 038-persona-context-compare-and-set.sql
-- Body-only atomic compare-and-set for the ai-proxy context box.
--
-- Migration 030 is already live. Apply this standalone migration before
-- deploying the matching ai-proxy source. The browser cannot execute this RPC:
-- only the service-role Edge Function may call it, and ownership remains part
-- of the atomic UPDATE predicate.

begin;

create or replace function public.compare_and_set_persona_context(
  p_owner uuid,
  p_persona_id uuid,
  p_expected_context text,
  p_next_context text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_owner is null or p_persona_id is null
     or p_expected_context is null or p_next_context is null then
    raise exception using
      errcode = '22023',
      message = 'Context compare-and-set parameters are required';
  end if;

  if char_length(p_expected_context) > 20000
     or char_length(p_next_context) > 20000 then
    raise exception using
      errcode = '22023',
      message = 'Persona context must be 20000 characters or less';
  end if;

  update public.personas
  set context_log = p_next_context
  where id = p_persona_id
    and owner = p_owner
    and context_log = p_expected_context;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

comment on function public.compare_and_set_persona_context(uuid, uuid, text, text)
  is 'Service-role-only owner-scoped atomic context compare-and-set; inputs stay in the RPC request body.';

revoke all on function public.compare_and_set_persona_context(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.compare_and_set_persona_context(uuid, uuid, text, text)
  to service_role;

commit;
