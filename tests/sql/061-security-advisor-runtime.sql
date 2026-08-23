\set ON_ERROR_STOP on

do $runtime$
declare
  v_signature text;
  v_config text[];
  v_check text;
begin
  foreach v_signature in array array[
    'public.touch_updated_at()',
    'public.tg_touch_updated_at()'
  ] loop
    select p.proconfig into v_config from pg_proc p where p.oid=v_signature::regprocedure;
    if not ('search_path=pg_catalog'=any(coalesce(v_config,array[]::text[]))) then
      raise exception '% does not pin pg_catalog: %',v_signature,v_config;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.touch_updated_at()',
    'public.tg_touch_updated_at()',
    'public.auto_create_research_settings()',
    'public.cleanup_deleted_fan_chat_notification()',
    'public.invalidate_content_package_approval()',
    'public.notify_content_package_review()',
    'public.notify_new_research_brief()',
    'public.notify_owner_fan_message()'
  ] loop
    if has_function_privilege('anon',v_signature,'execute')
       or has_function_privilege('authenticated',v_signature,'execute') then
      raise exception '% is still browser executable',v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.owner_research_brief_queue(date,text)',
    'public.get_research_digest(uuid,integer)'
  ] loop
    if has_function_privilege('anon',v_signature,'execute')
       or not has_function_privilege('authenticated',v_signature,'execute') then
      raise exception '% does not have the authenticated-only contract',v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.owns_persona(uuid)',
    'public.persona_visible(uuid)'
  ] loop
    if not has_function_privilege('anon',v_signature,'execute')
       or not has_function_privilege('authenticated',v_signature,'execute') then
      raise exception '% no longer supports its PUBLIC RLS callers',v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.auto_create_research_settings()',
    'public.cleanup_deleted_fan_chat_notification()',
    'public.get_research_digest(uuid,integer)',
    'public.invalidate_content_package_approval()',
    'public.notify_content_package_review()',
    'public.notify_new_research_brief()',
    'public.notify_owner_fan_message()',
    'public.owner_research_brief_queue(date,text)',
    'public.owns_persona(uuid)',
    'public.persona_visible(uuid)'
  ] loop
    if exists (
      select 1
      from pg_proc p,
           lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where p.oid=v_signature::regprocedure
        and acl.grantee=0 and acl.privilege_type='EXECUTE'
    ) then
      raise exception '% retains database PUBLIC execute',v_signature;
    end if;
  end loop;

  select policy.with_check into v_check
  from pg_policies policy
  where policy.schemaname='public' and policy.tablename='noo_waitlist'
    and policy.policyname='noo_waitlist_anon_insert';
  if v_check is null or v_check='true' or v_check not like '%nooyouniverse.com%' then
    raise exception 'waitlist policy is still permissive: %',v_check;
  end if;

  if has_table_privilege('anon','public.noo_waitlist','select')
     or has_table_privilege('anon','public.noo_waitlist','update')
     or has_table_privilege('anon','public.noo_waitlist','delete')
     or has_table_privilege('anon','public.noo_waitlist','truncate')
     or has_table_privilege('anon','public.noo_waitlist','references')
     or has_table_privilege('anon','public.noo_waitlist','trigger')
     or has_table_privilege('authenticated','public.noo_waitlist','insert') then
    raise exception 'waitlist retains a broad browser table privilege';
  end if;
  if not has_column_privilege('anon','public.noo_waitlist','email','insert')
     or not has_column_privilege('anon','public.noo_waitlist','source','insert')
     or has_column_privilege('anon','public.noo_waitlist','id','insert')
     or has_column_privilege('anon','public.noo_waitlist','created_at','insert') then
    raise exception 'waitlist column privileges do not match the landing-page payload';
  end if;

  if exists (
    select 1
    from pg_default_acl defaults,
         lateral aclexplode(defaults.defaclacl) acl
    where defaults.defaclrole='postgres'::regrole
      and defaults.defaclnamespace='public'::regnamespace
      and defaults.defaclobjtype='f'
      and acl.privilege_type='EXECUTE'
      and (acl.grantee=0 or acl.grantee in ('anon'::regrole,'authenticated'::regrole))
  ) then
    raise exception 'future postgres-owned public functions still default to browser execution';
  end if;
end
$runtime$;

set role anon;
insert into public.noo_waitlist(email,source)
values ('valid@example.com','nooyouniverse.com');
reset role;

do $runtime$
begin
  if (select count(*) from public.noo_waitlist) <> 1 then
    raise exception 'the bounded anonymous waitlist insert no longer works';
  end if;
end
$runtime$;
