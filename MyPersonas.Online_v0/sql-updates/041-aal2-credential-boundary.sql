-- Require a fresh TOTP-backed AAL2 session for model credential management.
--
-- This is intentionally a local, manually applied migration. It does not alter
-- public reads, ordinary signed-in reads, account erasure workers, or cron/OAuth
-- callback contracts. Apply only with the matching frontend and OpenRouter Edge
-- Function ready; do not reuse the reserved migration number 040.

begin;

create or replace function public.require_aal2()
returns void
language plpgsql
stable
security invoker
set search_path = '' as $$
begin
  if auth.uid() is null then
    raise sqlstate '28000' using message = 'Authentication required';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise sqlstate '42501' using message = 'Two-factor verification required';
  end if;
end;
$$;
revoke all on function public.require_aal2() from public, anon, authenticated;

create or replace function public.create_ai_backend(
  p_provider text,
  p_name text,
  p_base_url text,
  p_api_key text,
  p_model text,
  p_extra jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_backend_id uuid;
  v_secret_id uuid;
  v_secret_name text;
begin
  perform public.require_aal2();
  if trim(coalesce(p_name,'')) = '' or char_length(p_name) > 160 then
    raise exception 'Model connection name is required';
  end if;
  if char_length(coalesce(p_provider,'')) > 80 then
    raise exception 'Provider name is too long';
  end if;
  if trim(coalesce(p_base_url,'')) !~* '^https://[^[:space:]]+$'
    or char_length(p_base_url) > 2048 then
    raise exception 'Hosted model connections require a valid HTTPS base URL';
  end if;
  if char_length(coalesce(p_model,'')) > 300 then
    raise exception 'Model id is too long';
  end if;
  if trim(coalesce(p_api_key,'')) = '' then
    raise exception 'A provider credential is required';
  end if;
  if octet_length(coalesce(p_api_key,'')) > 32768 then
    raise exception 'Provider credential is too large';
  end if;
  if octet_length(coalesce(p_extra,'{}'::jsonb)::text) > 10000 then
    raise exception 'Provider options are too large';
  end if;

  insert into public.ai_backends (
    owner, provider, name, base_url, api_key, model, extra
  ) values (
    v_owner, lower(trim(coalesce(p_provider,''))), trim(p_name), trim(p_base_url),
    '', trim(coalesce(p_model,'')), coalesce(p_extra,'{}'::jsonb)
  ) returning id into v_backend_id;

  v_secret_name := 'ai_backend_key_' || v_backend_id::text;
  select vault.create_secret(
    p_api_key,
    v_secret_name,
    'AI provider credential for backend ' || v_backend_id::text
  ) into v_secret_id;
  insert into public.ai_backend_credentials (
    backend_id, owner, vault_secret_id
  ) values (v_backend_id, v_owner, v_secret_id);
  return v_backend_id;
end;
$$;

create or replace function public.update_ai_backend(
  p_backend_id uuid,
  p_name text,
  p_model text,
  p_extra jsonb default '{}'::jsonb
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
  update public.ai_backends set
    name = trim(p_name), model = trim(coalesce(p_model,'')),
    extra = coalesce(p_extra,'{}'::jsonb)
  where id = p_backend_id and owner = v_owner;
  if not found then raise exception 'Owned model connection not found'; end if;
  return true;
end;
$$;

create or replace function public.delete_ai_backend(p_backend_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  perform public.require_aal2();
  delete from public.ai_backends where id = p_backend_id and owner = v_owner;
  if not found then raise exception 'Owned model connection not found'; end if;
  return true;
end;
$$;

create or replace function public.delete_my_ai_backends()
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  perform public.require_aal2();
  delete from public.ai_backends where owner = v_owner;
  return true;
end;
$$;

revoke all on function public.create_ai_backend(text,text,text,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.update_ai_backend(uuid,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.delete_ai_backend(uuid)
  from public, anon, authenticated;
revoke all on function public.delete_my_ai_backends()
  from public, anon, authenticated;
grant execute on function public.create_ai_backend(text,text,text,text,text,jsonb)
  to authenticated;
grant execute on function public.update_ai_backend(uuid,text,text,jsonb)
  to authenticated;
grant execute on function public.delete_ai_backend(uuid)
  to authenticated;
grant execute on function public.delete_my_ai_backends()
  to authenticated;

commit;
