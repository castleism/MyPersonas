# MyPersonas.Online

Source for https://mypersonas.online — the persona network.

## Structure

- `MyPersonas.Online_v0/` — current working tree (major version line v0).
  The folder is renamed only on major version changes; point releases and
  hotfixes are git tags. See `MyPersonas.Online_v0/VERSIONING.md`.
- `.github/workflows/pages.yml` — deploys the current version folder to
  GitHub Pages on every push to `main`. Bump `SITE_DIR` there on major
  version changes.

## Deployment

GitHub Pages must be set to **Settings → Pages → Source: GitHub Actions**
(not "Deploy from a branch") for this layout to serve correctly.
