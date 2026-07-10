# Departments backlog

Items an engineering session found that belong to an offline department, for
the next meeting to triage. Not roadmap items (those live in ROADMAP.md) —
these are things a department needs to decide or own.

---

## Ops / infra

- **2026-07-10 — Scheduled-task environment can't open PRs.** The senior-
  engineer scheduled-task session has git push access but no `gh` CLI and no
  `GITHUB_TOKEN`, so it can push a branch but can't open the draft PR the
  task asks for. Either install `gh` + a scoped token in the task's
  environment, or change the task's expected output to "pushed branch,
  PR opened manually." Until resolved, every session's dev-log entry will
  need a manual PR-open step. See claude/dev-log.md 2026-07-10 entry.

## Security

- **2026-07-10 — SQL migration 005 needs a live-DB dry run.** sql-updates/005
  (revoke column-level SELECT on personas.owner, add my_personas() RPC) was
  checked by hand against supabase-schema.sql but never run against a real
  Postgres/Supabase instance — this environment has no production access.
  Someone with Supabase access should dry-run it on a non-prod project (or
  during low traffic) before/while deploying the matching index.html changes
  from branch `feat/hide-persona-owner-column`, since deploying the schema
  and app out of sync breaks persona creation (see PR risks).
