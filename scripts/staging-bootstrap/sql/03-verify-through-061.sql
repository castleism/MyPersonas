do $verify_through_061$
declare
  v_config text;
begin
  if to_regclass('public.personas') is null
     or to_regclass('public.persona_page_publications') is null
     or to_regclass('public.persona_media_assets') is null then
    raise exception 'Through-061 public schema sentinels are missing';
  end if;
  if to_regclass('public.media_environment_config_062') is not null
     or to_regclass('public.persona_public_media_handles') is not null then
    raise exception 'Predecessor unexpectedly contains migration 062 objects';
  end if;
  if not exists(
    select 1 from pg_catalog.pg_constraint
    where conrelid='public.noo_waitlist'::regclass
      and conname='noo_waitlist_input_contract' and convalidated
  ) then raise exception 'Migration 061 waitlist constraint is missing or unvalidated'; end if;

  select array_to_string(proconfig,',') into v_config
  from pg_catalog.pg_proc
  where oid='public.touch_updated_at()'::regprocedure;
  if coalesce(v_config,'') not like '%search_path=pg_catalog%' then
    raise exception 'Migration 061 touch_updated_at search_path is not hardened';
  end if;
  if has_function_privilege('anon','public.owner_research_brief_queue(date,text)','execute')
     or has_function_privilege('anon','public.get_research_digest(uuid,integer)','execute') then
    raise exception 'Migration 061 owner research RPC ACL is too broad';
  end if;
  if not has_function_privilege('authenticated','public.owner_research_brief_queue(date,text)','execute')
     or not has_function_privilege('authenticated','public.get_research_digest(uuid,integer)','execute') then
    raise exception 'Migration 061 authenticated research RPC ACL is missing';
  end if;

  if not exists(select 1 from pg_catalog.pg_trigger
      where tgrelid='auth.users'::regclass and tgname='on_auth_user_created' and not tgisinternal)
     or not exists(select 1 from pg_catalog.pg_trigger
      where tgrelid='auth.users'::regclass and tgname='invalidate_stale_aliaspaces_email_attestations' and not tgisinternal) then
    raise exception 'Application Auth triggers were not restored';
  end if;
  if (select count(*) from storage.buckets
      where id in ('media','persona-media','persona-docs','post-approved-media')) <> 4 then
    raise exception 'Empty staging Storage bucket configuration is incomplete';
  end if;
  if (select count(*) from pg_catalog.pg_policies
      where schemaname='storage' and tablename='objects'
        and policyname in (
          'media public read','media auth upload','media owner delete',
          'persona media public read','persona docs owner select',
          'persona docs owner insert','persona docs owner update','persona docs owner delete',
          'post approved media service writes only','persona media service insert',
          'persona media service update','persona media service delete'
        )) <> 12 then
    raise exception 'Through-061 Storage policy supplement is incomplete';
  end if;
  if exists(select 1 from pg_catalog.pg_policies
      where schemaname='storage' and tablename='objects'
        and policyname in ('persona media owner insert','persona media owner update','persona media owner delete')) then
    raise exception 'Deprecated browser-write persona media policy remains';
  end if;
  if exists(select 1 from auth.users) or exists(select 1 from storage.objects)
     or (to_regclass('vault.secrets') is not null and exists(select 1 from vault.secrets)) then
    raise exception 'A schema-only bootstrap must not copy users, Storage objects, or Vault secrets';
  end if;
end
$verify_through_061$;

select jsonb_build_object(
  'phase','through-061',
  'schema_ready',true,
  'auth_users', (select count(*) from auth.users),
  'storage_objects',(select count(*) from storage.objects),
  'vault_secrets',case when to_regclass('vault.secrets') is null then 0 else (select count(*) from vault.secrets) end,
  'configured_empty_buckets',(select count(*) from storage.buckets where id in ('media','persona-media','persona-docs','post-approved-media')),
  'opaque_062_present',to_regclass('public.media_environment_config_062') is not null
)::text;
