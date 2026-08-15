# Supabase API Key Rotation (legacy JWT → `sb_*`)

_ARCHITECTURE-REVIEW.md P2. You flagged that the dashboard now marks the legacy
`anon` and `service_role` JWT keys as **deprecated**. They still work today and are
auto-injected into Edge Functions, but Supabase will retire them — plan the move to
the new `sb_publishable_…` / `sb_secret_…` keys before that happens._

## What's affected

| Old (deprecated) | New | Used by |
|---|---|---|
| `anon` JWT | `sb_publishable_…` | Browser/API gateway `apikey`; the signed-in user's JWT remains the `Authorization` bearer |
| `service_role` JWT | `sb_secret_…` | Server-only API gateway `apikey`; it is not a JWT bearer replacement |

Grep to find every reference:

```
rg "SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_PUBLISHABLE|anon key" \
   MyPersonas.Online_v0/index.html supabase/functions
```

## Recommended order (low-risk, reversible at each step)

1. **Read Supabase's current guidance first** (the exact key names/UI change over
   time): dashboard → Project Settings → API Keys. Both old and new keys are valid
   during the transition, so this can be done incrementally with no downtime.
2. **Inventory authentication semantics before replacement.** New `sb_*` keys are API keys, not
   JWTs. They go in the `apikey` header. A signed-in user's access token remains the
   `Authorization: Bearer <user JWT>` value. Never send `sb_publishable_*` or `sb_secret_*` as if it
   were a bearer JWT.
3. **Browser publishable key:** configure the SDK with `sb_publishable_…` so it sends the gateway
   `apikey`; keep RLS and user-JWT authorization unchanged. Verify public reads, signup/sign-in,
   AAL2, signed-in CRUD, logout, and erasure before proceeding.
4. **Edge Function callers:** functions using Supabase's legacy JWT verification cannot accept an
   `sb_*` API key as bearer identity. Migrate deliberately to `verify_jwt = false` only when the
   function explicitly validates the user JWT or its narrow cron/callback secret itself. Test
   missing, malformed, expired, wrong-owner, AAL1, and AAL2 cases.
5. **Server/admin clients:** add a separate server-only environment dictionary for accepted
   `sb_secret_*` API keys and update clients/callers to send it as `apikey`. Keep legacy
   `SUPABASE_SERVICE_ROLE_KEY` consumers in place until each call path is migrated and verified;
   do not assume renaming the environment variable is sufficient.
6. **Cron / worker callers:** separate gateway authentication from the worker's own long random
   secret. Verify pause, replay, due-time, and zero-item probes after switching. Never put an
   `sb_secret_*` value into SQL text, logs, or browser code.
7. **Rotate + revoke:** once everything runs on `sb_*` keys, disable the legacy
   JWT keys in the dashboard. Keep a note of the change date in CHANGELOG.md.

## Safety notes

- Do the browser key and the server key **separately**, verifying between steps —
  don't swap both at once.
- The `sb_secret_…` key is as sensitive as `service_role`: it stays only in
  Edge Function secrets / Vault, never in the client or the repo.
- Database migrations may be required for explicit JWT/AAL enforcement and accepted-key metadata;
  this is not a blind dashboard-only rename.

_Status: not started. Tracked in ROADMAP.md (P2)._
