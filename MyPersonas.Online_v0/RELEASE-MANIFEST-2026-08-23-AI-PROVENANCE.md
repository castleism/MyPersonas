# MyPersonas AI provenance release manifest — 2026-08-23

Status: **migration 060 applied and read back in the linked production database; matching
function and frontend deployment still pending at this source freeze.** Migration 059 is
frozen historical source; migration 060 is the forward-only hardening release. The 060
ledger row records normalized-LF SHA-256
`333afa05b7292b1f0b7a780d6cf82cd497c55b0f6a6c7a444b466e46ec678d2e`.
This manifest does not claim matching Edge Function or frontend parity until a later
deployment record supplies the workflow runs, commit, public hashes, and smoke evidence.

## Release boundary

The linked migration ledger can contain 059 without proving that the complete hardened
contract below exists. Never replace, edit, or re-run an already-ledgered 059 to repair
that drift. The frozen 059 files are historical prerequisites and comparison authorities:

- `sql-updates/059-ai-content-provenance-watermark.sql`
- `supabase/migrations/20260823010000_ai_content_provenance_watermark.sql`

The deployable database change is the new, idempotent, forward-only 060 pair. It must ship
as one coordinated release with the matching Edge Functions and frontend:

- `sql-updates/060-ai-content-provenance-hardening.sql`
- `supabase/migrations/20260823020000_ai_content_provenance_hardening.sql`
- `supabase/functions/media-ingest/index.ts` and its bundled watermark master
- `supabase/functions/gemini-image/index.ts`
- `supabase/functions/compose-post/index.ts`
- `supabase/functions/ai-proxy/index.ts` for the fixed, context-free intention-plan
  explanation boundary
- `ai-content-provenance.js`, `ai-content-provenance.css`, and matching `index.html`
- `supabase/config.toml` static-file and JWT settings

The release requires the reviewed migrations through 058, an immutable ledgered 059, and
the migration-051 media, publication, and social-governance schema it hardens. The
repository's timestamped migration folder is not asserted to be a complete fresh-install
history.

## Pinned and release-candidate hashes

SQL hashes below are calculated after normalizing UTF-8 line endings to LF so checkout
line-ending conversion cannot disguise drift. Binary and source-file hashes are raw-byte
SHA-256 values.

| Artifact | SHA-256 |
| --- | --- |
| Owner-supplied watermark, both copies | `c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2` |
| Frozen migration 059, both identical copies (normalized LF) | `208259258c163f44e17e76a1b82cc8ad38949fe6c01e976a3b30b0492f54b3a6` |
| Forward migration 060, both identical copies (normalized LF) | `333afa05b7292b1f0b7a780d6cf82cd497c55b0f6a6c7a444b466e46ec678d2e` |
| `media-ingest/index.ts` | `ff5f8ac460aa621c1ec0b90408203aacc8cf801d7fb1a47586f7134f66c2f5b0` |
| `gemini-image/index.ts` | `4c7c0bf7688241b3210d0b6366aaa6d1084828c7f364d0d9423d76420fa4eb4b` |
| `compose-post/index.ts` | `23bb32d33d7a4c352cc87164cbe4f732ca7061ca74c7c9d6aed9b9c7d738d009` |
| `ai-proxy/index.ts` | `551f9f6ffc38649b81fe571c6c6e4bcda956ef15ee9b5b7704bb1a0ab9f18988` |
| `ai-content-provenance.js` | `7914b0003e3c664eb0b87f5f47a102909c2ba340adb71982ee3054d2ad4ee731` |
| `ai-content-provenance.css` | `eaed62cb0981c24973430fbff3a2f0062de797e7ef59ed9bee4f01eab674be09` |
| `persona-view.js` | `b353f032bfd36b462e2620654fa0991b4dfcf8a4a46dab73f76715524ab499d0` |
| `platform-governance.js` | `94d504e14bcc00f1ac948f77db2ff07da99b1ed4cf979482d15e1535cd381156` |
| Coordinated `index.html` | `bc0a3990c16152268ca3bb73c70d46e2e1c04d6d07a2fcc10c7cdbf080a73338` |

The source-file values are an inventory, not proof of a deployed artifact. Recalculate
every non-pinned hash after the final working-tree freeze and record the release commit. A
mismatch voids the coordinated release.

## Implemented contract

- Every browser media picker requires `No AI`, `AI-assisted`, `AI-generated`, or `Not
  sure`; cancellation does not upload. The last three receive the same subtle, exact
  bottom-right MyPersonas AI mark.
- Site-generated images are system-declared generated. Raw provider pixels pass directly
  from generation to authenticated intake; the browser receives only a registered marked
  URL.
- The service detects MIME from bytes, checks source hashes, ownership, fixed origin,
  request/file/pixel/output limits, static dimensions, unsupported animation, and the
  bundled master hash before it can author provenance.
- ImageMagick/WASM creates the final derivative after any social crop. Marked outputs are
  at most two megapixels and 10 MiB. AI-used GIF, APNG, animated WebP, and video fail
  closed.
- Service-only immutable paths include owner, declaration, source, persona, purpose, and
  final content hash. Identical bytes do not collide between personas.
- Generation-event consumption and provenance-row insertion are atomic. Archived or
  flagged assets cannot be returned as usable retries.
- Retained objects count toward 200 registrations per owner per UTC day, 2 GiB and 5,000
  records per owner, and 512 MiB and 1,000 records per persona. The legacy row-only delete
  RPC is unavailable to browsers.
- Exact active asset IDs bind profiles, posts, albums, drafts, and social crops. AI
  Storage transforms are rejected; bounded no-AI transforms remain possible.
- Existing external HTTPS media is snapshotted once as visibly `AI use not known`. A
  migration reapply does not expand that snapshot. New external/local unregistered media
  makes page review incomplete.
- Asset archive/flag requires AAL2 and invalidates the affected persona's reviewed or
  published revision.

## Verification state

- Earlier local evidence passed a 277-test Node suite, role-switched PostgreSQL runtime
  assertions, JavaScript syntax checks, an actual ImageMagick/WASM derivative, and rendered
  desktop/mobile QA. That evidence predates the immutable-059/forward-060 split and is not
  sufficient release proof for 060.
- The current harness passed this exact sequence: seed prerequisite
  schema, apply frozen 059 once, apply 060, reapply 060, then run the adversarial runtime.
  It did not reapply 059.
- The full current Node suite passed **284/284**; the inline frontend syntax check,
  migration-pair parity, both role-switched PostgreSQL harnesses, and `git diff --check`
  also passed before the production apply.
- Production readback found the 060 ledger row and hash, both grandfather tables, the safe
  render/reference functions, zero false `media_provenance_required` flags, no
  authenticated asset insert/update/delete grants, a one-time 118-reference external
  snapshot, and the requested active global-administrator and technician role rows.
- Hosted function/source parity, signed-in integration, two-account isolation, and public
  deployment verification remain unclaimed at this source freeze.

## Required owner-approved release sequence

1. Freeze this manifest, all coordinated artifacts, and their hashes at one release commit.
2. Inventory and back up the linked database schema, functions, policies, bucket settings,
   migration ledger, and existing media. Verify migrations through 058 and the exact
   prerequisite schema. Verify 059 is already ledgered; never edit or re-run it.
3. Rehearse frozen 059 followed by 060 and a 060 reapply against a current isolated
   database. Inspect the one-time external-media snapshot and stop on any drift.
4. Pause media writes and publishers. Apply **060 only**, then read back its functions,
   grants, RLS, policies, constraints, triggers, snapshot counts, and hashes.
5. Deploy the four matching Edge Functions together using local Supabase CLI bundling. Include
   the configured watermark static file. Do not use the dashboard/server-side bundle
   path for this function.
6. Deploy matching static source with the pinned per-asset `20260823-1` / `20260823-2`
   cache versions in `index.html`.
7. In signed-in staging, test AAL2 generation and upload using owner and other-owner
   accounts; all declarations; PNG/JPEG/WebP; source/output limits; duplicate/archived
   retries; external media; profile/page/album/post/social review; preview/download;
   desktop/mobile; logout/account switching; and publication invalidation.
8. Run hosted memory, CPU, timeout, and concurrent-load tests before resuming writes or
   publishers. Lower the 12-megapixel source limit if hosted evidence requires it.
9. Verify the public deployment, browser console, cache, database state, orphan scan, and
   exact generated/downloaded bytes. Resume only after all evidence passes.

## Known gates and follow-up work

- The 060 linked-project apply is recorded above. Coordinated Deno/Supabase deployed-source
  parity, signed-in integration, Storage/RLS adversarial proof, and hosted concurrency
  proof are not yet recorded in this manifest.
- The pinned ImageMagick WASM is about 14.7 MB by itself. It needs local CLI bundling and
  hosted validation against the current Edge memory, CPU, and bundle limits.
- Storage upload still precedes database finalization. Ordinary failures remove newly
  created objects, but a worker crash can leave a content-addressed public orphan. Add a
  private staging/finalize flow and an audited orphan sweeper before high-volume use.
- Static no-AI image headers/dimensions are validated, but full malware scanning and
  hardened structural parsing for GIF/video remain future worker controls.
- AI-used motion, audio, and document watermarking is not implemented. Do not simulate it
  with a removable CSS overlay or a first-frame mark.
- The owner-supplied master includes a C2PA/JUMBF container, but its signature was not
  cryptographically verified and browser/server derivatives are not claimed as C2PA
  signed.
- Public object URLs still contain stable owner UUIDs. Opaque public delivery remains a
  privacy release gate, so rich public image/video widgets and video backgrounds must stay
  disabled even after 060.
- New external media remains blocked until a safe declared-import, license, scan, and
  rehosting workflow exists.
- No provider key, SSO/MFA provider, WAF, payment processor, notification sender, DNS,
  social publisher, or external account was configured by this work.

The complete behavioral and policy contract is in `AI-CONTENT-PROVENANCE.md`.
