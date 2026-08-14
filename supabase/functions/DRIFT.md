# Edge Function drift — deployed but not in the repo

_Checked live against the Supabase dashboard on 2026-08-12 (project `nwsqyuucwzihruszocge`)._

The live snapshot contained 26 deployed functions. Eighteen of those had matching
version-controlled directories at the time; these **8 were deployed but not
version-controlled** — pull them so the repo is the source of truth. This checkout now
also contains new/local-only functions, so its directory count must not be read as a
deployment count:

- `daily-discovery`
- `gemini-models`
- `gemini-probe`
- `image-probe`
- `meta-ig-attach`
- `meta-ig-discover`
- `split-post`
- `twitter-post`

`reddit-oauth` and `reddit-post` are present in this checkout and are not part of the
drift list. Their presence is source-control evidence only; deployment, secrets, OAuth
round trips, write scopes, and provider results require separate verification.

## Why this can't be pulled from here

- The dashboard code viewer shows **"Deploy status unavailable"** for these (source not
  rendered inline reliably).
- The platform `/functions/{slug}/body` endpoint returns an **ESZIP binary bundle**, not
  clean source.
- The rendered source contains **secret-looking strings** (inline keys/tokens), so it
  can't be safely relayed or committed verbatim.

Pulling requires the Supabase CLI logged in with your access token (local, not this
session).

## Pull them (run locally, in the repo root)

```bash
# one-time: link the project (uses your login)
supabase link --project-ref nwsqyuucwzihruszocge

# download each drifted function's source into supabase/functions/<slug>/
for f in daily-discovery gemini-models gemini-probe image-probe \
         meta-ig-attach meta-ig-discover split-post twitter-post; do
  supabase functions download "$f" --project-ref nwsqyuucwzihruszocge
done
```

## After downloading — before committing (important)

1. **Scrub inline secrets.** Any hardcoded API key/token in the source must move to
   function secrets (`supabase secrets set NAME=...`) and be read via
   `Deno.env.get("NAME")`. Do **not** commit real keys — `.gitignore` won't catch them
   inside source files. Grep first:
   ```bash
   grep -rInE "(sk-|AIza|EAAG|Bearer |service_role|secret)" supabase/functions/<slug>/
   ```
2. **Rotate** anything that was ever committed or exposed (see `KEY-ROTATION.md`).
3. Compile-check with the repo's existing esbuild check, then commit per function.

## Also verify: `meta-post`

An older `meta-post` is deployed, while this checkout contains the hardened exact-draft
replacement. Compare the live source/behavior with the repository before the coordinated
release; do not restore the old scaffold or overwrite the new claim/checkpoint/reconciliation
contract. App Review remains a separate requirement only for serving other users.
