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
- **2026-07-10 — `claude/` docs directory isn't on `main`.** `claude/dev-log.md`,
  `claude/departments-backlog.md` (this file) and this whole directory only
  exist on branch `feat/hide-persona-owner-column` — they were created there
  by the first scheduled-task session and never merged to `main`. Every
  session is expected to branch off `main` per the task instructions, so a
  fresh session branching off `main` won't see these files at all (this
  session had to switch branches just to append an entry). Merge that
  branch (or cherry-pick just the `claude/` directory to `main`) so the
  docs are visible regardless of which feature branch a session starts
  from.
- **2026-07-10 — Uncommitted "v0a" feature + QA scaffolding found in the
  working tree, stashed for review.** Found ~369 uncommitted lines on
  `feat/hide-persona-owner-column` implementing a large account/security/
  personality/astrology feature (password & TOTP management, data export,
  account deletion, Myers-Briggs, full natal-chart astrology with an SVG
  chart wheel), plus an untracked `_to_delete/` folder with QA scaffolding
  (`_qa_splice.py`, `index.html.qabak`). Not from this session, unrelated to
  that branch's purpose, and far bigger than one session's scoped unit, so
  it was preserved via `git stash push -u` on that branch rather than
  discarded or committed. Someone should review the stash (`git stash list`
  → `git stash show -p <ref>`), decide whether it's worth finishing as its
  own branch/PR, and make sure it isn't lost. Full detail in
  claude/dev-log.md 2026-07-10 "Route render race guard" entry.

## Security

- **2026-07-10 — SQL migration 005 needs a live-DB dry run.** sql-updates/005
  (revoke column-level SELECT on personas.owner, add my_personas() RPC) was
  checked by hand against supabase-schema.sql but never run against a real
  Postgres/Supabase instance — this environment has no production access.
  Someone with Supabase access should dry-run it on a non-prod project (or
  during low traffic) before/while deploying the matching index.html changes
  from branch `feat/hide-persona-owner-column`, since deploying the schema
  and app out of sync breaks persona creation (see PR risks).
