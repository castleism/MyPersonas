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

## Deployment

GitHub Pages must be set to **Settings → Pages → Source: GitHub Actions**
(not "Deploy from a branch") for this layout to serve correctly.
