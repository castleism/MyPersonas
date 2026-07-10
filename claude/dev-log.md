# Dev log

Dated entries from the senior-engineer scheduled task. One entry per session:
what shipped, branch, PR link, status. Check here before picking new work so
sessions don't duplicate each other.

---

## 2026-07-10 — Hide personas.owner from anon/authenticated reads

- **Item:** VERIFICATION.md finding #10 (HIGH, privacy) — the personas SELECT
  policy returned the `owner` uuid to anyone, even signed out, letting
  strangers group all of one account's public personas together (API-level
  break of the "never linked to each other" promise). No `claude/` directory
  (charter/meeting minutes) existed yet in this repo, so this session picked
  the highest-priority open VERIFICATION.md finding per the task's fallback
  rule rather than a leadership priority.
- **Branch:** `feat/hide-persona-owner-column`
- **PR:** not opened automatically — this environment has no `gh` CLI and no
  `GITHUB_TOKEN`, so PR creation had to be skipped. Branch is pushed to
  `origin/feat/hide-persona-owner-column`; open the PR manually at
  https://github.com/castleism/MyPersonas/pull/new/feat/hide-persona-owner-column.
  Suggested title/body are in the commit message.
- **What shipped:** `sql-updates/005-hide-persona-owner.sql` (column-level
  REVOKE + `my_personas()` security-definer RPC) and matching `index.html`
  changes (explicit column lists everywhere `personas` is read, RPC replacing
  the raw owner-filtered query, roster-membership check replacing the raw
  uuid comparison for page-owner status, `.select("id")` on persona insert so
  `RETURNING` doesn't request the now-restricted column). CHANGELOG.md and
  VERIFICATION.md updated; finding #10 marked FIXED pending re-verification.
- **Status:** code complete, JS syntax-checked and smoke-tested against a
  local static server (no console errors, discover page degrades cleanly
  with no backend configured). NOT run against a live Supabase instance — no
  production credentials in this environment. Needs: (1) someone with repo
  write access to open the PR from the pushed branch, (2) sql-updates/005 run
  in Supabase, (3) re-verification per finding #10's updated note in
  VERIFICATION.md, deployed together with the index.html changes (see PR
  "Risks" section — deploying schema and app out of sync breaks persona
  creation).
