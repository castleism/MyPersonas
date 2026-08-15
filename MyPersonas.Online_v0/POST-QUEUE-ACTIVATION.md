# 3-part post queue — activation and rollback

**Current decision: keep `036-schedule-post-queue.sql` unapplied.** The weekly approval UI and
exact-approval migration can be deployed and tested while the publisher stays dormant. Turning on
the recurring job is a separate production decision.

2026-08-14 release note: a safe public permission probe shows migration 035 functions exist in the
live schema, but signed-in behavior and exact deployed function source are not fully reverified.
Treat further changes as forward fixes; do not rewrite/reapply 035 merely to make the handoff match.

## What is ready locally

- The Composer paginates every active draft, adds the newest 50 terminal history rows, groups them
  by owner-time-zone week, and ignores stale overlapping reloads.
- `035-post-draft-approval-hardening.sql` adds an exact caption/target/time/actual-Meta-asset/**image-byte**
  hash plus owner-only save, unschedule, and delete RPCs. Scheduling is no longer a browser RPC: the
  owner-authenticated `approve-post-draft` function snapshots the exact JPEG/PNG/WebP bytes first and
  alone can invoke the service-role scheduling RPC. The migration also returns legacy unhashed
  scheduled rows to draft review and removes direct browser mutation of queue state/results.
- Approved FB/IG images are copied into the public `post-approved-media` bucket at the immutable,
  owner-scoped content address `owners/<owner-uuid>/sha256/<prefix>/<sha256>.<ext>`. An explicit
  restrictive Storage policy denies anon/authenticated writes even if another permissive policy is
  introduced. The approval records and hashes canonical URL, path, SHA-256, detected MIME, and byte
  size; the queue downloads the stored object and re-verifies every value before any Meta call.
  Account deletion and content-only erasure recursively remove and verify only that owner's
  `owners/<owner-uuid>` prefix before owned database rows are deleted, including unreferenced objects
  left by an interrupted approval.
- Immediate publishing is draft-scoped and server-side: `meta-post` atomically claims the row,
  snapshots its actual destinations, checkpoints each provider ID, atomically finalizes with an
  audit event, and locks uncertain outcomes for reconciliation.
- Scheduling is deliberately Meta-only. X remains a generated draft, but the UI and database reject
  X as a scheduled target until `twitter-post` is version-controlled and write-authorized.
- Scheduled and terminal rows are locked against browser edits. The worker claims and publishes the
  current due row, verifies its approval hash and stored image bytes, honors the owner-wide pause, fails missing targets,
  fails missing Instagram linkage or changed paired assets, skips provider IDs already recorded, and
  applies a best-effort local rolling Instagram guard. Each invocation is limited to one draft and
  migration 036 gives the one-draft HTTP call a 145-second timeout.
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
7. Reconcile legacy terminal history that has a provider ID but no `publish_*` destination or
   `*_published_at` attribution. Do not guess those values. Until each recent Instagram post is
   attributed or older than the rolling window, the local quota counter is incomplete.
8. Verify migrations 033–035 in production, reconcile live state, then use the coordinated
   backend → forward migration → frontend order below.

## Safe deployment order while the cron remains off

1. Verify migrations 033, 034, and 035 plus the current target/in-flight inventory in production. Announce a
   short Composer maintenance window; do not stage, edit, or publish a draft during steps 2–4.

   ```sql
   select id, status, targets, fb_post_id, ig_media_id, x_tweet_id
   from public.post_drafts
   where cardinality(targets) = 0
      or not (targets <@ array['facebook','instagram','twitter']::text[])
      or ('twitter' = any(targets) and status not in ('posted','skipped')
          and (fb_post_id is not null or ig_media_id is not null or x_tweet_id is not null))
      or (status not in ('posted','skipped')
          and (fb_post_id is not null or ig_media_id is not null or x_tweet_id is not null));
   ```

   This must return zero rows. Reconcile any result manually; do not erase provider history or invent
   targets just to make the migration pass. On later re-runs, migration 035's internal preflight
   accepts a legitimate partial result only when its immutable attempt destination is present and
   consistent with any approval snapshot.
   Separately inventory every `status='publishing'` row, including rows with no provider ID. A row
   without a recorded result may still represent an ambiguous provider success and must be reconciled.
2. Make CI green. Push a **backend-only** commit containing reviewed functions/shared code/config
   and no frontend change. The current Supabase workflow must be repaired/protected first; wait for
   exact function-version evidence. Pages may still run, but its artifact must remain unchanged.
3. Apply only the additive forward migration required by that backend release, as one transaction.
   If this is a first application of 035 in another environment, use the original 035 preflight;
   production currently needs verified forward state, not a blind rerun. Do **not** run 036.
4. Push the matching frontend/site commit only after the schema and backend are verified. Keep
   Composer closed during any contract gap; reopen it after the frontend is live and hard-reloaded.
5. Reload the signed-in site. Stage two disposable drafts in different weeks and verify:
   - each time is displayed in the owner time zone;
   - X cannot be scheduled;
   - missing Page/image/Instagram linkage is rejected;
   - an invalid/private image URL, MIME/byte mismatch, or image over 10 MiB is rejected before scheduling;
   - `draft → scheduled` persists after a full reload;
   - every scheduled FB/IG image URL points into `post-approved-media/owners/<your-uuid>/sha256/`;
   - scheduled captions/targets are locked;
   - Unschedule clears approval and allows edits;
   - posted/publishing history cannot be approved or deleted.
6. Inspect the rows in the SQL editor without changing them:

```sql
select id, owner, persona_id, facebook_ledger_id, week_start, status,
       scheduled_for, targets, approved_at, approved_by, approved_timezone,
       approved_facebook_page_id, approved_instagram_business_id,
       char_length(approved_content_hash) as approval_hash_length,
       approved_fb_media_sha256, approved_fb_media_mime, approved_fb_media_bytes,
       approved_fb_media_path, approved_fb_media_url,
       approved_ig_media_sha256, approved_ig_media_mime, approved_ig_media_bytes,
       approved_ig_media_path, approved_ig_media_url,
       fb_post_id, ig_media_id, x_tweet_id, last_error
from public.post_drafts
order by week_start desc nulls last, scheduled_for nulls last, created_at desc;
```

Every scheduled row must show an owner approver, an approval time + time zone, a future scheduled
time, a 64-character hash, exact paired FB/IG asset IDs, only `facebook`/`instagram` targets, and no
provider ID. Every selected Meta target must also have a 64-character media SHA-256, accepted MIME,
positive byte size no greater than 10 MiB, owner-scoped content path, and canonical public URL. An
unselected target must have empty/zero approved-media metadata.

## Frontend scheduling contract

Composer must not call `approve_and_schedule_post_draft` through `supabase.rpc`; authenticated users
do not have execute permission on that internal function. Call the owner-authenticated Edge Function:

```text
POST <SUPABASE_URL>/functions/v1/approve-post-draft
Authorization: Bearer <current owner access token>
Content-Type: application/json

{
  "draftId": "<uuid>",
  "scheduledFor": "<ISO-8601 instant>",
  "timezone": "America/Anchorage",
  "fbCaption": "<exact approved Facebook caption>",
  "igCaption": "<exact approved Instagram caption>",
  "xCaption": "<retained draft-only X caption>",
  "targets": ["facebook", "instagram"]
}
```

The response is `{ "draft": <scheduled post_drafts row> }`. Display the returned `error` on any
non-2xx response and reload the draft after a conflict. Keep the Schedule button busy/disabled for
the whole request: fetching, hashing, uploading, rereading, and transactionally approving two large
images can take longer than a normal metadata-only save. Do not fall back to the retired RPC.

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

First stop **every** matching database schedule by inventorying commands, not only a job name:

```sql
select cron.unschedule(jobid)
from cron.job
where command ilike '%run-post-queue%';
```

Then use the application's owner-wide **Pause all** control and verify no matching job remains:

```sql
select jobid, jobname, active, command
from cron.job
where command ilike '%run-post-queue%';
```

Reconcile every in-flight `publishing` row next. Do not change one back to `scheduled` until its Page/Instagram account has been checked
for an unrecorded provider success. Reconcile first; otherwise a retry can duplicate a live post.
