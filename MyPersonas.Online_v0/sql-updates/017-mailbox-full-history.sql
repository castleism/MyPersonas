-- Expand the report-only Inbox Concierge scan window without changing any
-- mailbox permissions or granting background cleanup authority.
--
-- A 100-year lookback covers the practical lifetime of a Gmail account. The
-- 15,000-message ceiling keeps a full-history request bounded while the
-- one-minute worker advances it in small, resumable pages.

alter table public.mailbox_settings
  drop constraint if exists mailbox_settings_lookback_days_check,
  drop constraint if exists mailbox_settings_max_messages_check;

alter table public.mailbox_settings
  add constraint mailbox_settings_lookback_days_check
    check (lookback_days between 1 and 36500),
  add constraint mailbox_settings_max_messages_check
    check (max_messages between 10 and 15000);

comment on column public.mailbox_settings.lookback_days is
  'Owner-selected report lookback, bounded to 100 years; scans read bounded headers, subject, and preview snippets but never full bodies or attachments.';
comment on column public.mailbox_settings.max_messages is
  'Owner-selected per-scan ceiling, bounded to 15000; reaching it is reported as a partial history result.';

-- Rotate runnable scans by the time they last received service. A large
-- mailbox therefore cannot monopolize the global worker lane, and every
-- active checkpoint gets an opportunity to refresh before its bounded expiry.
create index if not exists mailbox_scan_runs_fair_idx
  on public.mailbox_scan_runs (updated_at, id)
  where status in ('queued', 'running');

create or replace function public.next_runnable_mailbox_scan_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select run.id
  from public.mailbox_scan_runs as run
  join public.mailbox_settings as setting
    on setting.ledger_id = run.ledger_id
    and setting.owner = run.owner
  left join public.agent_owner_settings as owner_setting
    on owner_setting.owner = run.owner
  where run.status in ('queued', 'running')
    and setting.paused = false
    and coalesce(owner_setting.automation_paused, false) = false
  order by run.updated_at asc, run.created_at asc, run.id asc
  limit 1;
$$;

revoke all on function public.next_runnable_mailbox_scan_id()
  from public, anon, authenticated;
grant execute on function public.next_runnable_mailbox_scan_id()
  to service_role;

comment on function public.next_runnable_mailbox_scan_id() is
  'Service-only least-recently-served runnable scan selection after mailbox and owner pause filtering.';
