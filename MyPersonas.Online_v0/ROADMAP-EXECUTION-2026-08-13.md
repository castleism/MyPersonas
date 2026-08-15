# AliaSpaces roadmap execution checkpoint — 2026-08-13

This is the operational bridge between `ROADMAP.md` and a real release. It keeps four states
separate: **implemented locally**, **deployed**, **verified live**, and **enabled for unattended
use**. The original 2026-08-13 checkpoint was subsequently pushed. A 2026-08-14 audit found the
frontend live, CI red, automatic Supabase deployment blocked, migrations 035/038 visible, 037
unknown, and 039 absent from the live schema cache. Use the forward release order below.

## Source work in this coordinated slice (individual live state varies)

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

1. **Freeze unsafe automation and inventory live state.** Unschedule every cron row whose command
   contains `run-post-queue`, then use owner-wide Pause all, then reconcile every `publishing` row.
   Record live migration, Vault, function-version, binding, and provider-destination evidence.
2. **Restore the validation/release path.** Fix the Deno typecheck, make every production workflow
   run validation, pin tooling, deploy a reviewed function allowlist, and require an approved
   production environment. Do not let Pages publish a failing commit.
3. **Fix source blockers locally.** Wire every Reddit OAuth/post/erasure path to the owner-operation
   lease; revoke access-only grants; reject unsupported body+media. Add last-moment pause checks to
   every Meta provider POST. Add Discord Vault cleanup/orphan inventory while keeping Discord
   dormant. Add AAL2 enforcement, official provider host maps, server-side OpenRouter exchange,
   default-zero budget reservations, and an AI-spend kill switch.
4. **Push a backend-only commit after green review.** It must not change the Pages artifact. Wait for
   exact function-version evidence; a workflow badge alone is insufficient.
5. **Apply only additive forward migrations** required by that backend release. Complete 039 before
   applying it and revoke old unleased RPC access only after all callers move. Verify 037 separately
   before enabling Realtime. Do **not** apply 036 or blindly rerun 035.
6. **Verify backend contracts while paused:** AAL1 denial/AAL2 success, Reddit lease contention and
   erasure, immutable media, Meta pause races, provider-host rejection, budget races, audit, and
   reconciliation.
7. **Push the matching frontend/site and security-header release** only after schema/backend proof.
   Wait for Pages/host success, hard reload, and recheck CSP/security headers before reopening
   sensitive controls.
8. **Verify signed-in flows with one owner test account:**
   - persona context manual edit, conflict rejection, content-plan field summary, workspace create/
     rename/pin/resume, reviewed Save context, max-three Attach context, and export;
   - PWA manifest/icons/install, offline public shell, fresh private-data fetch after reconnect, and
     waiting-worker update behavior on a phone plus a tablet/desktop browser;
   - friend request + acceptance in two sessions, badge update, focus fallback, account switch, and
     RLS denial for an unrelated account;
   - extension fallback cards and safe external links; later repeat with a real public release;
   - Reddit Connect, callback identity match, missing-scope failure, lease contention, confirmed
     Disconnect, content-only erasure, full account erasure, and one explicitly approved low-stakes
     post only after the provider is configured;
   - the entire migration-035 Composer checklist, including immutable media path/hash, schedule,
     reload, unschedule, guarded immediate Meta post, provider IDs, cleanup, and no duplicate under
     a repeated click/request.
9. **Reload and audit durable state.** Read back important fields from Supabase and inspect actual
   provider posts; do not infer success from a toast, local queue state, or workflow badge. Resume
   only for one controlled provider test, then restore the intended pause state.

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
