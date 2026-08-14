# 3-part post queue — activation and rollback

**Current decision: keep `036-schedule-post-queue.sql` unapplied.** The weekly approval UI and
exact-approval migration can be deployed and tested while the publisher stays dormant. Turning on
the recurring job is a separate production decision.

## What is ready locally

- The Composer groups up to 200 drafts by owner-time-zone week and ignores stale overlapping reloads.
- `035-post-draft-approval-hardening.sql` adds an exact content/target/image/time/actual-Meta-asset hash plus
  owner-only save, approve-and-schedule, unschedule, and delete RPCs. It also returns any legacy
  unhashed scheduled rows to draft review and removes direct browser mutation of queue state/results.
- Immediate publishing is draft-scoped and server-side: `meta-post` atomically claims the row,
  checkpoints each provider ID, and locks uncertain outcomes for reconciliation.
- Scheduling is deliberately Meta-only. X remains a generated draft, but the UI and database reject
  X as a scheduled target until `twitter-post` is version-controlled and write-authorized.
- Scheduled and terminal rows are locked against browser edits. The worker claims and publishes the
  current due row, verifies its approval hash, honors the owner-wide pause, fails missing targets,
  fails missing Instagram linkage or changed paired assets, skips provider IDs already recorded, and
  applies a best-effort local rolling Instagram guard.
- The shared Meta publisher blocks the project-policy destinations before retrieving a Page token.

## Blockers before recurring activation

Do not apply migration 036 until every item below is closed:

1. Pull the deployed-only `twitter-post` source with the Supabase CLI, scrub/rotate any inline
   secrets, document its request contract, and commit the audited function. The current X grant is
   read-only; add the required write/media permissions and explicitly reauthorize test owners before
   enabling X. A formally approved Meta-only pilot may proceed with X excluded from every target.
2. Decide and document whether this exact-owner-approved queue is the L2 publishing path or must
   also require the existing L3 `agent_bindings` / `agent_destinations.mode='auto'` controls. The
   existing automation schema currently blocks external destinations from auto mode, so the two
   contracts must not be silently mixed.
3. Add provider reconciliation for the uncertain case where Meta accepts a post but the worker
   times out before saving its provider ID. The code now leaves that row locked in `publishing`, but
   cannot determine the provider outcome by itself. Reconcile it against the Page/account before any
   reset; a blind manual reset and retry can duplicate the live post.
4. Add automated queue tests for concurrent runs, rescheduling, approval invalidation, owner pause,
   missing/empty targets, missing Instagram, partial success, provider timeout, quotas, and the
   restricted-persona/destination policy.
5. Replace the advisory Instagram counter with an atomic reservation keyed to the actual IG account,
   and reconcile provider-side/manual posts so overlapping workers cannot exceed the account quota.
6. Verify the durable production UUID/account policy mapping for every Meta-blocked persona and
   destination; do not rely on mutable display names as the sole production control.
7. Verify migrations 033 and 034 are present in production, then deploy the matching source and apply
   035 in the coordinated order below.

## Safe deployment order while the cron remains off

1. Verify migrations 033 and 034 and the migration-035 target preflight in production. Announce a
   short Composer maintenance window; do not stage, edit, or publish a draft during steps 2–3.
2. Review and push the source changes. The GitHub workflows deploy the static frontend and all
   versioned Edge Functions; wait for both workflows to succeed. Until 035 lands, new mutation RPCs
   safely fail and the new draft publisher cannot claim a row; do not use Composer in this gap.
3. In the Supabase SQL editor, run `sql-updates/035-post-draft-approval-hardening.sql` as one
   transaction. Do **not** run 036. Reopen Composer only after the migration commits successfully.
4. Reload the signed-in site. Stage two disposable drafts in different weeks and verify:
   - each time is displayed in the owner time zone;
   - X cannot be scheduled;
   - missing Page/image/Instagram linkage is rejected;
   - `draft → scheduled` persists after a full reload;
   - scheduled captions/targets are locked;
   - Unschedule clears approval and allows edits;
   - posted/publishing history cannot be approved or deleted.
5. Inspect the rows in the SQL editor without changing them:

```sql
select id, owner, persona_id, facebook_ledger_id, week_start, status,
       scheduled_for, targets, approved_at, approved_by, approved_timezone,
       approved_facebook_page_id, approved_instagram_business_id,
       char_length(approved_content_hash) as approval_hash_length,
       fb_post_id, ig_media_id, x_tweet_id, last_error
from public.post_drafts
order by week_start desc nulls last, scheduled_for nulls last, created_at desc;
```

Every scheduled row must show an owner approver, an approval time + time zone, a future scheduled
time, a 64-character hash, exact paired FB/IG asset IDs, only `facebook`/`instagram` targets, and no
provider ID.

## Secret setup after the blockers are closed

Generate one long random value. Set that exact value in both places; never put it in this repository,
a migration, a screenshot, or chat.

1. Supabase Dashboard → Project Settings → Edge Functions → Secrets: set `CRON_SECRET`.
2. In the SQL editor, replace `REPLACE_WITH_THE_SAME_RANDOM_SECRET` below and run this idempotent
   Vault update:

```sql
do $$
declare v_secret_id uuid;
begin
  select id into v_secret_id
  from vault.secrets
  where name = 'mypersonas_cron_secret';

  if v_secret_id is null then
    perform vault.create_secret(
      'REPLACE_WITH_THE_SAME_RANDOM_SECRET',
      'mypersonas_cron_secret',
      'Shared secret for the run-post-queue scheduled invocation'
    );
  else
    perform vault.update_secret(
      v_secret_id,
      'REPLACE_WITH_THE_SAME_RANDOM_SECRET',
      'mypersonas_cron_secret',
      'Shared secret for the run-post-queue scheduled invocation'
    );
  end if;
end $$;
```

Verify only the name/id metadata—never select `decrypted_secret` into screenshots or logs:

```sql
select id, name, created_at, updated_at
from vault.secrets
where name = 'mypersonas_cron_secret';
```

## Dormant worker pilot before cron

1. Turn on the owner-wide automation pause, call the worker once, and confirm the due draft remains
   scheduled/deferred and no provider post appears.
2. Resume automation. Use a disposable, low-stakes, policy-eligible Facebook Page and schedule one
   Facebook-only post at least ten minutes ahead.
3. At the due time, invoke `run-post-queue` once with the matching `X-Cron-Secret`. Verify the exact
   caption/image on the Page and the stored `fb_post_id`. Invoke it again and confirm no duplicate.
4. Delete the disposable Facebook post through the existing `meta-post` delete action.
5. Repeat with one paired professional Instagram account. Verify `ig_media_id`; Instagram removal is
   manual in the Instagram app.
6. Run an overlap and controlled partial-failure test. Do not continue if a completed target repeats,
   a missing target reports `posted`, a row sticks in `publishing`, or the pause fails closed.

## Activate and verify the recurring job last

1. Enable the `pg_cron` and `pg_net` extensions in Supabase.
2. Re-audit **every** row whose status is `scheduled`; unschedule anything not intended to go live.
3. Apply `sql-updates/036-schedule-post-queue.sql` in the SQL editor.
4. Confirm there is exactly one job:

```sql
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'mypersonas-run-post-queue';
```

5. After the first run, inspect request/job and Edge Function logs plus the drafts' provider IDs and
   actual external posts. Start with one Page/account and a small daily volume.

## Immediate stop and recovery

Use the application's owner-wide **Pause all** control first. Stop the database schedule with:

```sql
select cron.unschedule('mypersonas-run-post-queue');
```

Then verify no job remains:

```sql
select jobid, jobname, active
from cron.job
where jobname = 'mypersonas-run-post-queue';
```

Do not change a `publishing` row back to `scheduled` until its Page/Instagram account has been checked
for an unrecorded provider success. Reconcile first; otherwise a retry can duplicate a live post.
