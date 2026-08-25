# MyPersonas

MyPersonas is the automation and control plane for persona-owned work. It owns
AI/provider routing, research, private source libraries, account connections,
drafting and approval queues, scheduled third-party publishing, billing and
entitlements, operational controls, and deletion orchestration.

AliaSpaces is the separate first-party social network for persona profiles,
feeds, relationships, businesses, projects, public media, and social
interactions. Its repository is
[`castleism/aliaspaces.com`](https://github.com/castleism/aliaspaces.com).

## Repository split status

The source history is still transitional: the legacy `MyPersonas.Online_v0/`
shell contains both products. `REPOSITORY-BOUNDARIES.md` is the ownership
authority and `REPOSITORY-SPLIT-MANIFEST.md` records the migration sequence.

- Do not add new AliaSpaces-only features to MyPersonas except a documented
  compatibility bridge.
- Do not let both repositories deploy the same migration, Edge Function, Pages
  artifact, scheduled job, or provider callback.
- Keep the existing Supabase Auth/persona identity contract during the code
  split. A live Auth/database migration is a separate reviewed project.
- Migration-bearing preservation and integration branches must not be merged to
  `main` until their isolated-staging gates pass.

## Current structure

- `MyPersonas.Online_v0/` — transitional owner application and historical
  product documentation.
- `supabase/functions/` — authenticated automation, provider, billing,
  operations, and shared-contract boundaries.
- `supabase/migrations/` — ordered database migrations. Ownership is recorded
  in the split manifest; timestamp order is not deployment approval.
- `apps/workroom-bridge/` — local provider workroom bridge.
- `scripts/`, `tools/`, and `tests/` — release validation and local automation.
- `.github/workflows/` — CI plus owner-triggered, protected release workflows.

## Development and release safety

- `npm test` runs the repository contract suite.
- `node scripts/check-frontend-syntax.mjs` parses the transitional frontend.
- `node scripts/check-committed-secrets.mjs --history` scans the working tree
  and reachable Git history without printing matched values.
- `.github/workflows/pages.yml` is manual-dispatch and packages an explicit
  allowlist. A push is not proof of a Pages deployment.
- `.github/workflows/supabase-deploy.yml` is manual-dispatch and deploys only a
  selected reviewed function scope. It does not apply database migrations.
- The installed Supabase GitHub integration has previously observed `main`;
  keep unapproved migrations off `main` until that provider-side behavior is
  disabled or independently proven safe.

## Key documents

- `REPOSITORY-BOUNDARIES.md` — product and code ownership.
- `REPOSITORY-SPLIT-MANIFEST.md` — branch, migration, function, and cutover
  ledger.
- `MyPersonas.Online_v0/ARCHITECTURE-REVIEW.md` — architecture backlog.
- `MyPersonas.Online_v0/KEY-ROTATION.md` — credential rotation plan.
- `MyPersonas.Online_v0/ROADMAP.md` and `CHANGELOG.md` — historical status.
- `CI-CD-SETUP.md` — GitHub environment setup.

## Related repository

`soul-concept-engine` is a separate product and shares no schema or runtime with
MyPersonas. Its provenance format still requires explicit coordination with
MyPersonas AI-content provenance so the two standards do not drift silently.
