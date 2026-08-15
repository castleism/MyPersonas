-- 042-edit-ai-backend-base-url.sql
-- Lets an owner edit an existing AI model connection's BASE URL (in addition to
-- label + model id) without re-entering the API key. The key stays write-only in
-- the Vault; it is never read back or changed by this path.
--
-- Supersedes the 4-arg update_ai_backend from migration 041. Backward compatible:
-- callers that omit p_base_url (host-confirm toggles, default toggles) leave the
-- stored base_url unchanged.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR **BEFORE** DEPLOYING THE MATCHING FRONTEND.
-- The frontend degrades gracefully if this is missing (saves label + model, warns
-- that base-URL edits need 042), but base-URL editing only works once this is live.

begin;

-- Remove the old 4-arg signature so PostgREST resolves to a single function.
drop function if exists public.update_ai_backend(uuid, text, text, jsonb);

create or replace function public.update_ai_backend(
  p_backend_id uuid,
  p_name text,
  p_model text,
  p_extra jsonb default '{}'::jsonb,
  p_base_url text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  perform public.require_aal2();
  if trim(coalesce(p_name,'')) = '' or char_length(p_name) > 160 then
    raise exception 'Model connection name is required';
  end if;
  if char_length(coalesce(p_model,'')) > 300 then
    raise exception 'Model id is too long';
  end if;
  if octet_length(coalesce(p_extra,'{}'::jsonb)::text) > 10000 then
    raise exception 'Provider options are too large';
  end if;
  -- Only validate/update base_url when the caller supplies one.
  if p_base_url is not null then
    if trim(p_base_url) !~* '^https://[^[:space:]]+$'
      or char_length(p_base_url) > 2048 then
      raise exception 'Hosted model connections require a valid HTTPS base URL';
    end if;
  end if;
  update public.ai_backends set
    name = trim(p_name),
    model = trim(coalesce(p_model,'')),
    extra = coalesce(p_extra,'{}'::jsonb),
    base_url = case when p_base_url is null then base_url else trim(p_base_url) end
  where id = p_backend_id and owner = v_owner;
  if not found then raise exception 'Owned model connection not found'; end if;
  return true;
end;
$$;

revoke all on function public.update_ai_backend(uuid,text,text,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.update_ai_backend(uuid,text,text,jsonb,text)
  to authenticated;

notify pgrst, 'reload schema';

commit;
