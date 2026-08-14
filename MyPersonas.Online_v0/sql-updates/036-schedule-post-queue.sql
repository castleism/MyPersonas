-- 036-schedule-post-queue.sql
-- OPT-IN: schedule the 3-part publisher (run-post-queue) every 5 minutes.
--
-- DO NOT apply until 035 is applied, the approval UI and hardened worker are
-- deployed and verified, and POST-QUEUE-ACTIVATION.md has no open blocker.
-- Until this is applied the publisher is dormant (deployed but never invoked).
--
-- Requires: pg_cron + pg_net extensions, and a Vault secret named
-- 'mypersonas_cron_secret' whose value equals the run-post-queue CRON_SECRET.

do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'mypersonas_cron_secret'
      and trim(coalesce(decrypted_secret,'')) <> ''
  ) then
    raise exception 'Create the non-empty Vault secret mypersonas_cron_secret before enabling this job';
  end if;
  if exists (select 1 from cron.job where jobname = 'mypersonas-run-post-queue') then
    perform cron.unschedule('mypersonas-run-post-queue');
  end if;
end $$;

select cron.schedule('mypersonas-run-post-queue', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://nwsqyuucwzihruszocge.supabase.co/functions/v1/run-post-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'mypersonas_cron_secret'
        limit 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
$$);

-- To stop it later:  select cron.unschedule('mypersonas-run-post-queue');
