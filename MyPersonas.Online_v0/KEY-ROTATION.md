# Supabase API Key Rotation (legacy JWT → `sb_*`)

_ARCHITECTURE-REVIEW.md P2. You flagged that the dashboard now marks the legacy
`anon` and `service_role` JWT keys as **deprecated**. They still work today and are
auto-injected into Edge Functions, but Supabase will retire them — plan the move to
the new `sb_publishable_…` / `sb_secret_…` keys before that happens._

## What's affected

| Old (deprecated) | New | Used by |
|---|---|---|
| `anon` JWT | `sb_publishable_…` | Browser client (`index.html` `CONFIG.SUPABASE_ANON_KEY`), any function using `SUPABASE_ANON_KEY` |
| `service_role` JWT | `sb_secret_…` | Edge Functions' admin client (`SUPABASE_SERVICE_ROLE_KEY`) — meta-oauth, gmail-oauth, gemini-image, delete-account, etc. |

Grep to find every reference:

```
rg "SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_PUBLISHABLE|anon key" \
   MyPersonas.Online_v0/index.html supabase/functions
```

## Recommended order (low-risk, reversible at each step)

1. **Read Supabase's current guidance first** (the exact key names/UI change over
   time): dashboard → Project Settings → API Keys. Both old and new keys are valid
   during the transition, so this can be done incrementally with no downtime.
2. **Browser publishable key:** replace the hard-coded anon key in
   `index.html` (`CONFIG.SUPABASE_ANON_KEY`) with the new `sb_publishable_…`.
   The publishable key is safe to ship in the client (RLS still enforces access).
   Deploy via the Pages workflow; verify sign-in + a public persona page.
3. **Edge Functions secret key:** the functions read `SUPABASE_SERVICE_ROLE_KEY`
   from the environment. When Supabase provides the `sb_secret_…` replacement,
   set it as the functions' secret and update any code that names the old var.
   Keep the old var set until every function is confirmed working, then remove it.
4. **Cron / worker callers:** anything calling functions with the anon/service key
   in an Authorization header (run-tasks, run-mailbox-jobs, run-publish-queue)
   must use the new key. Verify a scheduled run after switching.
5. **Rotate + revoke:** once everything runs on `sb_*` keys, disable the legacy
   JWT keys in the dashboard. Keep a note of the change date in CHANGELOG.md.

## Safety notes

- Do the browser key and the server key **separately**, verifying between steps —
  don't swap both at once.
- The `sb_secret_…` key is as sensitive as `service_role`: it stays only in
  Edge Function secrets / Vault, never in the client or the repo.
- No database migration is required; this is purely key/secret configuration.

_Status: not started. Tracked in ROADMAP.md (P2)._
