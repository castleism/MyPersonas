-- Keep inbox identities out of social destination, schedule, and draft tables.
-- Mailbox scanning and owner-approved cleanup use the dedicated mailbox workflow.

create function public.reject_mailbox_social_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
begin
  if new.account_id is null then
    return new;
  end if;

  select lower(pg_catalog.btrim(account.provider))
  into v_provider
  from public.account_ledger account
  where account.id = new.account_id;

  if v_provider = any(array['gmail','outlook','yahoo','icloud','proton']::text[]) then
    raise exception using
      errcode = '23514',
      message = 'Inbox accounts cannot be social publishing destinations';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_mailbox_social_account()
  from public, anon, authenticated, service_role;
grant execute on function public.reject_mailbox_social_account() to postgres;

comment on function public.reject_mailbox_social_account() is
  'Trigger-only invariant preventing mailbox account IDs from entering social automation tables.';

create trigger reject_mailbox_agent_destination
before insert or update of account_id on public.agent_destinations
for each row execute function public.reject_mailbox_social_account();

create trigger reject_mailbox_ai_task
before insert or update of account_id on public.ai_tasks
for each row execute function public.reject_mailbox_social_account();

create trigger reject_mailbox_draft
before insert or update of account_id on public.drafts
for each row execute function public.reject_mailbox_social_account();

create function public.reject_social_account_mailbox_reclassification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if lower(pg_catalog.btrim(new.provider))
       = any(array['gmail','outlook','yahoo','icloud','proton']::text[])
     and not coalesce(
       lower(pg_catalog.btrim(old.provider))
         = any(array['gmail','outlook','yahoo','icloud','proton']::text[]),
       false
     )
     and (
       exists(select 1 from public.agent_destinations destination where destination.account_id = new.id)
       or exists(select 1 from public.ai_tasks task where task.account_id = new.id)
       or exists(select 1 from public.drafts draft where draft.account_id = new.id)
     ) then
    raise exception using
      errcode = '23514',
      message = 'Remove this account from social targets, schedules, and drafts before changing it to an inbox provider';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_social_account_mailbox_reclassification()
  from public, anon, authenticated, service_role;
grant execute on function public.reject_social_account_mailbox_reclassification() to postgres;

comment on function public.reject_social_account_mailbox_reclassification() is
  'Prevents an account referenced by social automation from being reclassified as a mailbox.';

create trigger reject_social_account_mailbox_reclassification
before update of provider on public.account_ledger
for each row execute function public.reject_social_account_mailbox_reclassification();
