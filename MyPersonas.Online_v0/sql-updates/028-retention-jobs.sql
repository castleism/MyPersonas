-- 028-retention-jobs.sql
-- Data lifecycle / retention (ARCHITECTURE-REVIEW.md P0). Prunes unbounded-growth
-- and expired-transient tables on a schedule so the database does not grow without
-- limit (mailbox_findings/refs were ~3,900 rows each and only climbing).
--
-- STATUS: REVIEW BEFORE APPLYING. Written 2026-08-08, NOT yet run against prod.
-- It is defensive (every table guarded by to_regclass, so it cannot error on a
-- table that is absent) and conservative (365-day findings window by default).
--
-- SAFETY: this deliberately does NOT touch public.meta_oauth_candidates. Those
-- rows retain the provider token required for fail-closed revocation and are
-- cleaned by the connector's own self-heal logic, not by blind age pruning.
--
-- Owner-run in the Supabase SQL editor. Idempotent (create or replace).

create or replace function public.run_data_retention(
  p_findings_days integer default 365,
  p_error_log_days integer default 90,
  p_expired_grace_days integer default 1
)
returns table(category text, deleted bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_del bigint;
  v_sql text;
  v_expired_tables text[] := array[
    'public.meta_oauth_transactions',
    'public.meta_owner_erasure_leases',
    'public.meta_token_operation_leases',
    'public.twitter_token_operation_leases'
  ];
  t text;
begin
  -- 1) Old application error logs (insert-open, spam-able).
  if to_regclass('public.error_logs') is not null then
    delete from public.error_logs
      where created_at < now() - make_interval(days => p_error_log_days);
    get diagnostics v_del = row_count;
    category := 'error_logs'; deleted := v_del; return next;
  end if;

  -- 2) Old inbox-scan findings (the bulk of growth). Keeps a generous window of
  --    report history; older findings are removed.
  if to_regclass('public.mailbox_findings') is not null then
    delete from public.mailbox_findings
      where created_at < now() - make_interval(days => p_findings_days);
    get diagnostics v_del = row_count;
    category := 'mailbox_findings'; deleted := v_del; return next;
  end if;

  -- 3) Message refs no longer referenced by any surviving finding and older than
  --    the window. The NOT EXISTS guard prevents orphaning live findings.
  if to_regclass('public.mailbox_message_refs') is not null then
    delete from public.mailbox_message_refs m
      where m.created_at < now() - make_interval(days => p_findings_days)
        and not exists (
          select 1 from public.mailbox_findings f where f.message_ref_id = m.id
        );
    get diagnostics v_del = row_count;
    category := 'mailbox_message_refs'; deleted := v_del; return next;
  end if;

  -- 4) Expired transient OAuth/worker state (locks + abandoned auth transactions).
  --    Excludes meta_oauth_candidates on purpose (see header). Each table is
  --    optional; missing ones are skipped.
  foreach t in array v_expired_tables loop
    if to_regclass(t) is not null then
      v_sql := format(
        'delete from %s where expires_at < now() - make_interval(days => $1)', t
      );
      execute v_sql using p_expired_grace_days;
      get diagnostics v_del = row_count;
      category := split_part(t, '.', 2); deleted := v_del; return next;
    end if;
  end loop;

  return;
end;
$$;

revoke all on function public.run_data_retention(integer,integer,integer)
  from public, anon, authenticated;

-- Schedule weekly via pg_cron if available (Sundays 04:15 UTC). If pg_cron is not
-- installed this block is a no-op; run public.run_data_retention() manually or
-- enable pg_cron first. Re-running replaces any existing schedule of the same name.
do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule('data-retention-weekly')
      where exists (select 1 from cron.job where jobname = 'data-retention-weekly');
    perform cron.schedule(
      'data-retention-weekly',
      '15 4 * * 0',
      'select public.run_data_retention();'
    );
  end if;
end;
$$;

-- Manual run + preview:
--   select * from public.run_data_retention();               -- default windows
--   select * from public.run_data_retention(730, 180, 1);    -- looser windows
