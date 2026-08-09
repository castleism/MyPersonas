# CI/CD Setup

_Added 2026-08-08 (ARCHITECTURE-REVIEW.md P0). Removes the manual dashboard
paste-and-deploy that caused most of the reliability pain during the Meta/Gmail
work._

## What runs automatically

| Workflow | Trigger | What it does | Needs a secret? |
|---|---|---|---|
| `.github/workflows/ci.yml` | PRs + pushes to `main` | Runs unit tests (`npm test`), `deno check` on every edge function, and a syntax check on the frontend `index.html`. Deploys nothing. | No |
| `.github/workflows/supabase-deploy.yml` | Push to `main` touching `supabase/functions/**` or `config.toml` (or manual) | Deploys **all** edge functions with the Supabase CLI. `verify_jwt` per function is taken from `supabase/config.toml`. | **Yes** |
| `.github/workflows/pages.yml` | Push to `main` | Publishes the static site (unchanged, pre-existing). | No |

## One-time setup (do this once)

1. Create a Supabase access token: Supabase dashboard → Account → **Access Tokens** → generate.
2. In GitHub: repo **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `SUPABASE_ACCESS_TOKEN`
   - Value: the token from step 1
3. That's it. The project ref (`nwsqyuucwzihruszocge`) is read from `supabase/config.toml`, so no second secret is needed for function deploys.

Until the secret exists, `supabase-deploy.yml` fails fast with a clear message and
changes nothing. `ci.yml` works with no secrets.

## Migrations — still deliberate (by design)

Migrations are **not** auto-applied. The project uses hand-numbered files in
`MyPersonas.Online_v0/sql-updates/` (010–029…), several of which are owner-run,
order-sensitive, and paired with function deploys (see `supabase/DEPLOY.md`).
Auto-applying them is risky. Two options going forward:

- **Keep manual (now):** run each new migration in the SQL editor, then let CD
  ship the matching function. Take a backup first — this repo now uses an
  `archive` schema convention: `create table archive.<t>_<date> as select …` before
  destructive changes, restorable via `insert into public.<t> select * from archive.<t>_<date>`.
- **Automate later (P1):** migrate the numbered files into the standard
  `supabase/migrations/` timestamped format and add a gated job that runs
  `supabase db push` on merge (with a manual approval environment). Left as a
  follow-up because it requires renaming/validating 30+ existing migrations.

## Local dev parity

- `npm test` — run the unit suite locally (mirrors CI).
- `node scripts/check-frontend-syntax.mjs` — parse-check the frontend.
- `deno check supabase/functions/<name>/index.ts` — type-check a function.
- `supabase functions deploy <name> --project-ref nwsqyuucwzihruszocge` — manual deploy.
