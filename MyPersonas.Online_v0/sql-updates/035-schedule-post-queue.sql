-- 035-schedule-post-queue.sql
-- OPT-IN: schedule the 3-part publisher (run-post-queue) every 5 minutes.
--
-- DO NOT apply until (a) the approval UI exists so drafts only reach status
-- 'scheduled' via explicit owner approval, and (b) you're ready for approved,
-- due drafts to auto-publish to real accounts. Until this is applied the publisher
-- is dormant (deployed but never invoked).
--
-- Requires: pg_cron + pg_net extensions, and a Vault secret named
-- 'mypersonas_cron_secret' whose value equals the run-post-queue CRON_SECRET.

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
    body := '{}'::jsonb
  );
$$);

-- To stop it later:  select cron.unschedule('mypersonas-run-post-queue');
