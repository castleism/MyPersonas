# CI/CD Setup

_Added 2026-08-08; production triggers hardened 2026-08-22._

Release-package status: **The 2026-08-23 coordinated database, four-function, and Pages
release is live from commit `968e1ea`; exact workflow and hash evidence is in
`MyPersonas.Online_v0/RELEASE-MANIFEST-2026-08-23-AI-PROVENANCE.md`.** Continue to treat
provider configuration, persona publication, post-TOTP smoke, and two-account testing as
separate approvals/evidence.

## Workflow behavior

| Workflow | Trigger | What it does | Needs a secret? |
|---|---|---|---|
| `.github/workflows/ci.yml` | PRs + pushes to `main` | Runs unit tests (`npm test`), `deno check` on every edge function, and a syntax check on the frontend `index.html`. Deploys nothing. | No |
| `.github/workflows/supabase-deploy.yml` | Manual `workflow_dispatch` only | Requires `MIGRATIONS-VERIFIED`; defaults to the reviewed `media-ingest`, `gemini-image`, `compose-post`, and `ai-proxy` scope, with a separate explicit all-reviewed choice. `verify_jwt` per function comes from `supabase/config.toml`. It does not apply migrations. | **Yes** |
| `.github/workflows/pages.yml` | Manual `workflow_dispatch` only | Requires `MIGRATIONS-VERIFIED`, validates/builds the explicit public artifact, then publishes Pages. | No |

## One-time setup (do this once)

1. Create a Supabase access token: Supabase dashboard → Account → **Access Tokens** → generate.
2. In GitHub: repo **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `SUPABASE_ACCESS_TOKEN`
   - Value: the token from step 1
3. Configure a protected GitHub production environment and restrict who can approve and
   dispatch it. The project ref is read from `supabase/config.toml`; verify it at action
   time rather than treating this document as current dashboard evidence.

Until the secret exists, `supabase-deploy.yml` fails fast with a clear message and changes
nothing. `ci.yml` works with no secrets. Never paste the access token into a workflow
input, issue, chat, log, screenshot, or repository file.

Production setup record (2026-08-23): `SUPABASE_ACCESS_TOKEN` is configured as an
encrypted repository Actions secret using a 30-day Supabase account token. Rotate/revoke
it by 2026-09-22. Supabase currently warns that this token can control the whole account;
use a narrower project deployment credential when one is available.

## Database and deployment ceremony

Migrations are not auto-applied. The project uses canonical numbered files in
`MyPersonas.Online_v0/sql-updates/` plus selected timestamped mirrors. The timestamped
directory does not contain the entire historical chain, so it is not proof that a blank
project or an unknown linked project can be safely built with one command.

For the 2026-08-22 package:

1. Freeze and verify the exact canonical/mirror pairs in the release manifest.
2. Back up and inventory the linked project's migration ledger and predecessor schema.
3. Apply/reapply the ordered package in a matching isolated staging database and read back
   RLS, grants, data, erasure, concurrency, and lifecycle behavior.
4. Obtain exact owner approval, apply the database, and read it back.
5. Manually dispatch the function workflow with `MIGRATIONS-VERIFIED`.
6. Complete signed-in smoke tests, then manually dispatch Pages with the same confirmation.

Do not hand-edit migration history. Do not deploy functions against an older schema. Do
not publish the frontend before its functions and database contract are verified.

## Local dev parity

- `npm test` — run the unit suite locally (mirrors CI).
- `node scripts/check-frontend-syntax.mjs` — parse-check the frontend.
- `deno check supabase/functions/<name>/index.ts` — type-check a function.
- `supabase functions deploy <name> --project-ref nwsqyuucwzihruszocge` — manual deploy.
