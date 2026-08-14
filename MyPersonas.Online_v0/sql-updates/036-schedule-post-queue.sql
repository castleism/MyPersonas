-- 036-schedule-post-queue.sql
-- OPT-IN: schedule the 3-part publisher (run-post-queue) every 5 minutes.
--
-- DO NOT apply until 035 is applied, the approval UI and hardened worker are
-- deployed and verified, and POST-QUEUE-ACTIVATION.md has no open blocker.
-- Until this is applied the publisher is dormant (deployed but never invoked).
--
-- Requires: pg_cron + pg_net extensions, and a Vault secret named
-- 'mypersonas_cron_secret' whose value equals the run-post-queue CRON_SECRET.

begin;

do $$
begin
  if to_regprocedure('public.claim_due_post_drafts(integer)') is null
    or to_regprocedure('public.finalize_post_draft_publish(uuid,uuid,text,text,text,jsonb)') is null
    or to_regprocedure('public.note_post_draft_reconciliation(uuid,uuid,text,text,jsonb)') is null
    or to_regprocedure(
      'public.approve_and_schedule_post_draft(uuid,uuid,timestamp with time zone,text,text,text,text,text[],text,text,text,text,bigint,text,text,text,text,bigint,text,text)'
    ) is null then
    raise exception 'Apply migration 035 completely before applying migration 036';
  end if;
  if not exists (
    select 1 from storage.buckets
    where id = 'post-approved-media' and public = true
      and file_size_limit = 10485760
  ) then
    raise exception 'The immutable approved-media bucket from migration 035 is missing or misconfigured';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'Enable pg_cron before applying migration 036';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'Enable pg_net with the five-argument net.http_post function before applying migration 036';
  end if;
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'mypersonas_cron_secret'
      and trim(coalesce(decrypted_secret,'')) <> ''
  ) then
    raise exception 'Create the non-empty Vault secret mypersonas_cron_secret before enabling this job';
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
    timeout_milliseconds := 145000
  );
$$);

commit;

-- To stop it later:  select cron.unschedule('mypersonas-run-post-queue');
