# AliaSpaces roadmap execution checkpoint — 2026-08-13

This is the operational bridge between `ROADMAP.md` and a real release. It keeps four states
separate: **implemented locally**, **deployed**, **verified live**, and **enabled for unattended
use**. Nothing in this checkpoint was pushed, migrated, configured, or posted externally.

## Locally complete in this coordinated slice

- Persona context: manual conflict-safe editing, dated persona/content-plan field summaries,
  bounded AI inclusion, owner-reviewed chat takeaways, and distilled prior-workspace attachment.
- Chat workspaces: create, rename, pin, resume, scope messages, include them in the full account
  data export, Save context, and attach up to three distilled summaries without replaying raw histories.
- Composer: owner-time-zone weekly review, image upload, exact target/caption controls, immutable
  image-byte approval through `approve-post-draft`, guarded Meta Publish now, and locked result
  history. X remains draft-only.
- Meta safety: atomic claims, immutable attempt destinations, per-provider checkpoints, uncertain-
  outcome locks, and transactional final state + audit.
- Reddit: versioned OAuth UI/server contract, confirmed provider revocation before local disconnect,
  owner-triggered approved posting, post-claim state revalidation, pre-request audit, provider-ID
  checkpoint, and reconciliation locks for ambiguous outcomes.
- Friend requests: targeted Realtime insert/update subscriptions with RLS, stable bounded filters,
  focused badge refresh, account-switch teardown, and focus refresh fallback.
- PWA: manifest, brand icons, install prompt/help, path-safe service worker, public-only offline page,
  and Pages packaging. No private app/API response is precached; push is not implemented.
- Extensions: Concept and Personas entries, GitHub release/history support, escaped bounded notes,
  safe links, and truthful checked-in fallbacks when no public release can be fetched.
- Erasure: fail-closed Reddit grant revocation and recursive verified deletion of the exact owner
  prefixes in `media`, `persona-media`, `persona-docs`, and `post-approved-media`. Discord webhook
  Vault cleanup remains an explicit blocker before calling the whole owner erasure path complete.
- Migration 037: idempotent publication of only `public.follows` to `supabase_realtime`, plus query
  indexes. It is independent of dormant migration 036.

## Coordinated owner release order

1. **Review the full diff and preserve the maintenance boundary.** Do not include the unrelated
   Nooyou Universe working files. Confirm the eight deployed-only functions in `DRIFT.md` remain
   untouched. Announce a short Composer maintenance window and turn on the owner-wide automation
   pause before the function/035 transition.
2. **Run the migration-035 preflight** in `POST-QUEUE-ACTIVATION.md`. Reconcile every returned row
   without inventing provider history, destinations, or approvals. Confirm migrations 033/034 are
   live and migration 036 is absent.
3. **Confirm release configuration without exposing values:** GitHub's
   `SUPABASE_ACCESS_TOKEN`; Reddit client ID/secret/callback; existing Meta/AI secrets; and the
   intended `verify_jwt` entries in `supabase/config.toml`. Do not set a cron secret yet unless the
   dormant-worker pilot is actually scheduled.
4. **Create and push a backend-first commit.** Stage the matching `supabase/functions/**`,
   `supabase/config.toml`, migrations 035/036/037, and their tests/docs, but do not stage
   `index.html`, the PWA/catalog assets, or `.github/workflows/pages.yml` yet. The Pages workflow
   runs on every main push, but this commit leaves its site artifact unchanged. Wait for the
   all-functions workflow to succeed. If it fails, do not apply 035.
5. **Apply migration 035 as one transaction** during the Composer maintenance window. Do **not**
   apply 036. The old Composer cannot schedule after 035 revokes its raw RPC, so keep it closed
   until the matching frontend commit is live.
6. **Apply migration 037 separately** when ready to enable friend Realtime. Skipping dormant 036 is
   intentional; record that fact in the SQL change log so a future migration runner does not assume
   036 was applied.
7. **Create and push the frontend/site commit.** Include `index.html`, the PWA/catalog files,
   `.github/workflows/pages.yml`, and the reconciled public docs. Wait for Pages to succeed, then
   hard reload before reopening Composer. This two-commit sequence enforces the required function →
   schema → frontend order; one combined push would race the independent workflows.
8. **Verify signed-in flows with one owner test account:**
   - persona context manual edit, conflict rejection, content-plan field summary, workspace create/
     rename/pin/resume, reviewed Save context, max-three Attach context, and export;
   - PWA manifest/icons/install, offline public shell, fresh private-data fetch after reconnect, and
     waiting-worker update behavior on a phone plus a tablet/desktop browser;
   - friend request + acceptance in two sessions, badge update, focus fallback, account switch, and
     RLS denial for an unrelated account;
   - extension fallback cards and safe external links; later repeat with a real public release;
   - Reddit Connect, callback identity match, missing-scope failure, confirmed Disconnect, content-
     only erasure, full account erasure, and one explicitly approved low-stakes post;
   - the entire migration-035 Composer checklist, including immutable media path/hash, schedule,
     reload, unschedule, guarded immediate Meta post, provider IDs, cleanup, and no duplicate under
     a repeated click/request.
9. **Reload and audit durable state.** Read back important fields from Supabase and inspect actual
   provider posts; do not infer success from a toast, local queue state, or workflow badge.

## Keep these gates closed

- **Migration 036 / recurring Meta publisher:** off until provider-side reconciliation, atomic
  per-Instagram-account quota reservation, queue integration tests, production policy UUID checks,
  legacy provider-destination attribution, and the L2-versus-L3 contract are closed. Then run the
  dormant manual worker pilot before scheduling cron.
- **X writes:** off until `twitter-post` is downloaded, secret-scrubbed, versioned, contract-tested,
  and owners explicitly reauthorize `tweet.write`/media permissions. Current read OAuth is not
  publishing authority.
- **Push notifications:** not part of the PWA shell. Design permission timing, subscription storage,
  revocation, multi-device behavior, delivery, and quiet-hours semantics first.
- **Discord publishing:** the endpoint is hard-disabled and the current frontend exposes no
  connector/post action. Keep it dormant until exact transformed-content + webhook/channel approval,
  pause/binding/destination rechecks, provider-ID checkpointing, ambiguous-outcome reconciliation,
  transactional finalization/audit, Vault erasure, and concurrency/failure tests are complete.
- **Uncertain provider rows:** never reset `publishing` to retry until the provider account has been
  reconciled. A timeout can hide a successful external post.
- **Meta restricted personas:** enforce the durable UUID mapping for Chomes, Sherlock (CannaCandidz),
  and Sherlock Chomes. Do not block Traditional Family Values/Kunuk merely because older notes
  grouped that destination with cannabis accounts.

## Product recommendations from the current intent

1. **Make the daily companion small and excellent.** Lead the installed app with persona chat,
   workspaces, approval review, and a sourced personal briefing. Keep ledger/OAuth/admin setup on
   the web. That is a coherent daily habit before a full native rewrite.
2. **Ship installability before push, and PWA before Expo.** Measure whether owners actually use the
   installed shell. Build native only where camera/share sheets, biometrics, or dependable native
   notifications add real value.
3. **Make the personalized feed evidence-first.** Before code, choose an allowed source set, topic
   controls, freshness windows, citation rules, duplicate suppression, and feedback controls.
   Store source/evidence separately from the persona-written blurb so style never masquerades as fact.
4. **Keep L2 as the default external-publishing contract.** Exact owner approval plus a deliberate
   publish action matches the project's trust model. Treat unattended L3 as a later operational mode
   that requires reconciliation, atomic quotas, policy proofs, a global stop, and recovery drills.
5. **Migrate architecture incrementally.** Start SvelteKit/path-based rendering with public persona
   pages and SEO, where the current hash router imposes the clearest cost. Share typed provider/core
   modules with the existing app instead of freezing feature delivery for a big-bang rewrite.
6. **Centralize provider capabilities and policy.** One typed registry should drive connector cards,
   queue actions, required scopes, deletion/revocation claims, manual-only status, and docs. This is
   the best defense against the source/docs drift already found across Reddit, X, and Meta.
7. **Treat audit and reconciliation as product features.** Give the owner a visible reconciliation
   inbox for locked ambiguous attempts and a simple evidence trail. That is more valuable than
   adding more unattended connectors while provider outcomes can still be uncertain.

## Next implementation slices after this release

1. Provider reconciliation inbox + provider-specific reconciliation adapters.
2. Atomic Instagram quota reservations keyed to immutable attempted destination.
3. Drift pull/secret rotation, starting with `twitter-post`.
4. Public persona path rendering, OG images, and a real sitemap based on crawlable paths.
5. Personalized sourced-feed MVP after the source/citation contract is owner-approved.
6. Legacy persona-media migration and reload audit.
7. Push-notification design and pilot only after the PWA install/offline release is stable.
8. Discord webhook connector rebuild, including orphan-secret inventory and verified erasure.
