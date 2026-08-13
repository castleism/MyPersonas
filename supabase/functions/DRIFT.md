# Edge Function drift — deployed but not in the repo

_Checked live against the Supabase dashboard on 2026-08-12 (project `nwsqyuucwzihruszocge`)._

26 functions are deployed; 18 are in `supabase/functions/`. These **8 are deployed but
not version-controlled** — pull them so the repo is the source of truth:

- `daily-discovery`
- `gemini-models`
- `gemini-probe`
- `image-probe`
- `meta-ig-attach`
- `meta-ig-discover`
- `split-post`
- `twitter-post`

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

`meta-post` exists in the repo (gated-off scaffold) **and** deployed. Diff the deployed
version against the repo scaffold after download — if the deployed one differs, reconcile
before the App Review publishing work goes live (see `APP-REVIEW-META.md`).
