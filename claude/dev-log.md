# Dev log

Dated entries from the senior-engineer scheduled task. One entry per session:
what shipped, branch, PR link, status. Check here before picking new work so
sessions don't duplicate each other.

---

## 2026-07-10 — Route render race guard (VERIFICATION.md finding #7)

- **Item:** VERIFICATION.md finding #7 (UX/reliability, observed live) —
  `route()` didn't cancel superseded renders, so navigating away while a
  page's data fetch was still in flight let the stale render resolve late
  and overwrite the page the user had since navigated to (repro on record:
  opening the edit form got replaced by the previous persona page). Still
  no `claude/meetings/` or `claude/company-charter.md` in this repo, so
  this session again used the task's fallback rule and picked the
  highest-priority open VERIFICATION.md finding that needed no credentials
  or prod access. Branched off `main` (`ce6f4b0`) rather than off this
  branch — see the "found uncommitted work" note below.
- **Branch:** `feat/route-render-race-guard`
- **PR:** not opened automatically — same environment gap as last session,
  no `gh` CLI and no `GITHUB_TOKEN` (tracked in
  `claude/departments-backlog.md` → Ops/infra). Branch is pushed to
  `origin/feat/route-render-race-guard`; open the PR manually at
  https://github.com/castleism/MyPersonas/pull/new/feat/route-render-race-guard.
  Suggested title/body are in the commit message.
- **What shipped:** a `renderEpoch` counter in `index.html`, bumped by
  `route()` and by every direct render call that bypasses it (post
  publish/delete, the NSFW age-gate "I'm 18+, enter" continuation).
  `renderDiscover`/`renderPersonaPage`/`renderEdit` each capture the epoch
  on entry and check it against the current value immediately before their
  final DOM write, bailing out if a newer render has since started.
  CHANGELOG.md (new "v0b" hotfix entry) and VERIFICATION.md finding #7
  updated to FIXED.
- **Status:** code complete, JS syntax-checked (`new Function()` over the
  extracted inline `<script>` — no parse errors) and smoke-tested against a
  local static server: discover/signin routes render correctly, and a
  scripted rapid hash-navigation sequence (5 hash changes a few ms apart)
  lands on the correct final view with zero console errors. NOT verified
  against the original live repro — reproducing the actual clobber needs
  real Supabase network latency, which this environment can't provide (no
  prod access). Needs: (1) PR opened from the pushed branch, (2) after
  deploy, re-attempt the original repro (navigate into an edit form right
  after another page starts loading) and confirm it no longer clobbers.
- **Found uncommitted work (not from this session, flagging for review):**
  the working tree on `feat/hide-persona-owner-column` had ~369 lines of
  *uncommitted* changes to `CHANGELOG.md`/`index.html` implementing a large
  "v0a — Account, security, personality & astrology" feature (set/change
  password, change email, TOTP 2FA, sign out of all devices, download my
  data, delete all my content, Myers-Briggs field, and a full natal-chart
  astrology feature with an SVG chart wheel via astronomy-engine), plus an
  untracked `_to_delete/` folder with QA scaffolding (`_qa_splice.py`,
  `index.html.qabak`) that clearly isn't meant to be committed as-is. This
  is far larger than one session's scoped unit and unrelated to that
  branch's stated purpose (hiding the owner column), so rather than discard
  it or fold it into either branch, it was preserved with `git stash push
  -u` on `feat/hide-persona-owner-column` (message: "wip: found-uncommitted
  v0a account/security/personality/astrology + QA scaffolding (not from
  this session)") and left there — `git stash list` to find it, `git stash
  show -p <ref>` to inspect, `git stash pop` on that branch to restore.
  Someone should review whether this was in-progress human work or a prior
  interrupted automated session, decide if it should become its own
  branch/PR (dropping the `_to_delete/` scaffolding first), and make sure
  the stash doesn't get garbage-collected before anyone looks at it. Also
  logged in `claude/departments-backlog.md` → Ops/infra.

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
