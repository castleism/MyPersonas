# MyPersonas.Online

Source for https://aliaspaces.com — the persona network.

## Structure

- `MyPersonas.Online_v0/` — current working tree (major version line v0).
  The folder is renamed only on major version changes; point releases and
  hotfixes are git tags. See `MyPersonas.Online_v0/VERSIONING.md`.
- `.github/workflows/pages.yml` — deploys the current version folder to
  GitHub Pages on every push to `main`. Bump `SITE_DIR` there on major
  version changes.
- `supabase/functions/mailbox-manager/` and `run-mailbox-jobs/` — the
  owner-authenticated Inbox Concierge control endpoint and its cron-secret worker.
  Gmail is the first real adapter; provider tokens and message references remain
  server-side, and every mailbox mutation requires an exact owner-approved plan.

## Development & CI/CD

- `npm test` — unit tests for pure helpers (`tests/`). Runs in CI.
- `node scripts/check-frontend-syntax.mjs` — parse-check the single-file app.
- `.github/workflows/ci.yml` — tests + `deno check` on all edge functions +
  frontend syntax on every PR/push.
- `.github/workflows/supabase-deploy.yml` — deploys edge functions on merge to
  `main` (needs the `SUPABASE_ACCESS_TOKEN` secret). See `CI-CD-SETUP.md`.

## Key docs

- `MyPersonas.Online_v0/ARCHITECTURE-REVIEW.md` — retrospective + prioritized
  refactor backlog (P0–P3).
- `MyPersonas.Online_v0/CONNECTOR-CORE-DESIGN.md` — plan to de-duplicate the
  five OAuth connectors.
- `MyPersonas.Online_v0/KEY-ROTATION.md` — migrating off deprecated Supabase keys.
- `CI-CD-SETUP.md` — one-time CI/CD setup.
- `MyPersonas.Online_v0/ROADMAP.md` / `CHANGELOG.md` — status of record.

## Deployment

GitHub Pages must be set to **Settings → Pages → Source: GitHub Actions**
(not "Deploy from a branch") for this layout to serve correctly.
