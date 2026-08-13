# V2 Blueprint — How I'd build AliaSpaces from scratch

_2026-08-10. Written after living through v1: a single 445 KB `index.html`, ~25 Deno
edge functions, Postgres + RLS + Vault, hand-numbered migrations pasted into a flaky
dashboard, five near-duplicate OAuth connectors, and a week of debugging that traced
back to duplication, silent failures, and invalid API fields. This is the version that
wouldn't have those problems — optimized and secure "as AI-possible," with code that's
clean, concise, well-commented, and a folder tree you can navigate blind._

The north star (from the owner's 2026-08-10 note): **the app is a personalized AI news
feed** — each persona researches its assigned interests, fact-checks, cites sources, and
serves short tailored blurbs instead of mindless scroll; later, **projects** let multiple
personas collaborate. The architecture below is shaped to make that the easy path.

---

## 1. Principles (the lessons, distilled)

1. **One source of truth per concept.** v1's bugs lived in duplicated logic (5 connectors,
   pure helpers copied into tests). Extract shared cores; import, don't copy.
2. **Every outcome is visible.** The silent Gmail failure taught this: a flow must always
   surface success *and* each failure reason. No swallowed errors; log the raw provider
   message.
3. **Typed contracts end-to-end.** The `account_type` field that poisoned Graph calls
   would've been caught by a typed API client + a schema check. TS everywhere, shared types.
4. **Infra as code.** No dashboard paste-and-pray. Migrations and functions deploy from the
   repo via CI. The flaky editor cost more time than any feature.
5. **Reversible by default.** Backups before destructive change (the `archive` schema
   convention), soft-deletes, additive migrations, feature flags.
6. **Least privilege + no PII in the repo.** RLS on everything, `search_path` pinned,
   Vault for secrets, per-owner Storage buckets, keys rotated.
7. **Bounded everything.** Prompts, histories, retention, rate limits — every growth vector
   has an explicit cap from day one (v1 got this mostly right for chat; generalize it).

---

## 2. Stack

| Layer | v1 | v2 choice | Why |
|---|---|---|---|
| Frontend | one `index.html`, hash routing, no build | **SvelteKit** (or Next) + TypeScript + Vite, file-based routes, SSR/prerender for public pages | modules, code-split, real routes for SEO (v1's #1 SEO gap), testable units |
| Styling | inline CSS | Tailwind + a small design-token file | consistent, tree-shaken |
| Backend | ~25 Deno edge functions, much duplication | Deno edge functions **on a shared `_core` library** + typed API contracts | keep edge (low latency, Vault), kill duplication |
| DB | Postgres + RLS + Vault, manual migrations | same DB, **Supabase CLI migrations** (timestamped) + generated types | ordered, reviewable, rollbackable |
| Auth | Supabase Auth | same | fine as-is |
| Hosting | GitHub Pages (static) | static host for the SSR/prerendered app; functions on Supabase | keep it cheap |
| CI/CD | none (built in v1's final days) | GitHub Actions: typecheck + test + lint on PR, deploy functions/migrations on merge | the biggest reliability win |

Not a rewrite-for-its-own-sake: the DB, RLS model, Vault approach, and fail-closed
connector philosophy from v1 are **good** and carry over. What changes is *structure*.

---

## 3. Folder structure (navigable blind)

```
/apps
  /web                      # SvelteKit app
    /src
      /routes               # file-based: /(public)/p/[handle], /(app)/studio, /feed …
      /lib
        /components         # dumb UI
        /features           # persona-editor, connectors, mailbox, feed, chat …
        /stores             # typed client state
        /api                # typed client for edge functions (mirrors _core contracts)
      /styles               # tailwind + tokens
    /tests                  # unit + component
  /mobile                   # later: the news-feed phone app (Expo/React Native or PWA)
/supabase
  /functions
    /_core                  # THE shared library (see §5)
      http.ts oauth.ts vault.ts revocation.ts leases.ts identity.ts respond.ts pure.ts
    /connectors             # thin adapters: meta.ts gmail.ts x.ts reddit.ts
    /ai                     # ai-proxy, fan-chat, research, feed-builder
    /workers                # cron: scheduler, publish-queue, mailbox-jobs, retention
    /account                # delete-account, erase-content
  /migrations               # timestamped, CLI-managed
  /tests                    # pgTAP or SQL assertions for RLS + functions
/packages
  /shared-types             # generated DB types + hand-written API contracts (imported both sides)
/docs                       # ROADMAP, CHANGELOG, ARCHITECTURE, this file
/.github/workflows          # ci.yml, deploy.yml
```

One rule: **if two files need the same logic, it lives in `_core` or `/packages`.**

---

## 4. Frontend

- **Real routes** (`/p/[handle]` prerendered per persona) → each persona is an indexable
  URL with its own `<title>`/OG image. Fixes v1's single-indexable-URL SEO problem.
- **Feature folders** own their UI + state + API calls; components stay dumb and reusable.
- **Typed API client** in `/lib/api` generated from the `_core` contracts — the browser
  can't call an endpoint with the wrong shape.
- **No secrets in the client**; publishable key only; RLS enforces access.
- **Tests**: unit for pure logic, component tests for the persona editor + connect flows
  (the silent-notice bug is exactly what a component test catches).
- **Accessibility + non-destructive UX baked in**: every modal has a non-destructive
  close; Escape never destroys; retries are idempotent (v1 connector lessons as defaults).

---

## 5. Backend — the shared `_core` (kills the duplication)

Every connector in v1 re-implemented token exchange, `appsecret_proof`, Vault storage,
fail-closed revocation, operation leases, identity match, and CORS/JSON helpers. v2:

- `http.ts` — `fetchJson` (timeout, `redirect:"error"`, **raw provider-error logging**,
  retry/backoff on 429/5xx) and a typed `graphGet`. **Batch/field-expansion first**; a
  tiny allowlist of valid fields per provider so an invalid field (à la `account_type`)
  fails at build/test, not in prod.
- `oauth.ts` — code/long-lived exchange, PKCE, state+nonce.
- `vault.ts` — store/get/delete refresh tokens.
- `revocation.ts` — the fail-closed state machine (pending→revoking→provider_revoked/
  manual_required), shared, with `#variable_conflict use_column` baked into its SQL.
- `leases.ts`, `identity.ts` (normalize email/subject — the `girl.gamers.wp` typo class),
  `respond.ts` (CORS/json/redirect), `pure.ts` (validators, parsers — unit-tested once).

Each provider file declares only: scopes, auth URLs, and asset discovery. A new connector
is ~100 lines, not ~2,000.

Contracts live in `/packages/shared-types` and are imported by both the functions and the
web client, so request/response shapes can't drift.

---

## 6. The persona-AI system (rebuilt around the news feed)

Data (carry over + extend):
- `personas` (+ `context_log` — the context box as a first-class per-persona memory spine).
- `persona_content_plans` (strategy) — keep.
- `interests` per persona (topics to research) + `sources` (allowed/preferred citations).
- `feed_items` — generated blurbs with `{persona_id, headline, blurb, citations[],
  source_urls[], confidence, created_at, published}`.
- `chat_messages` (owner) / `fan_chat_messages` — stateless replay, unchanged model.

Functions:
- `ai/research` (cron + on-demand): for each persona's interests, fetch/vet sources,
  **fact-check and attach citations**, and write short blurbs to `feed_items`. This is the
  "custom tailored news, not mindless scroll" core. Bounded, cited, confidence-scored.
- `ai/feed-builder`: assembles a user's feed from the personas they own/follow.
- `ai/proxy` (owner chat) + `fan-chat`: as v1, but both fold a **bounded recent slice of
  `context_log`** into the system prompt so replies/generations continue the persona's
  arc. Model backend stays pure config — swapping models never loses context (it's all in
  Postgres; verified in v1).
- **Projects (later):** a `projects` table with `project_personas` membership; personas on
  a project can read each other's `context_log`/feed and a shared brief, enabling the
  "assign multiple personas to work together" goal. Orchestration = a simple planner that
  fans a project goal out to member personas and merges results (start rule-based; add an
  agentic planner once the primitives are solid).

Memory sizing (v1 numbers, carry as defaults): owner chat ≈ newest 36 msgs / 48k chars in,
≤4,096 tokens out; fan chat ≈ 16 msgs / 12k chars, 2k-char inputs, 500-token replies,
12/visitor/hr, 30/persona/day. The context box adds a bounded ~1.5k-char continuity slice.

---

## 7. The "soulular" / identity layer

Framed as the network of authored selves (see `concepts/soulular.md`): the persona graph
(follows, persona↔persona links/DMs, discovery/ranking). In v2 this is a clean module —
`feature/identity` on the client, a `graph`/`follows` schema on the server — rather than
scattered. "Cellular moves data between phones; soulular connects your selves."

---

## 8. Security posture (as-secure-as-AI-possible)

- RLS on every table; policies tested with pgTAP (v1 had 34 advisor warnings, mostly
  benign-by-design but untested — make them assertions).
- `search_path` pinned on every function; `#variable_conflict use_column` on any
  `RETURNS TABLE` plpgsql (the 42702 bug).
- Secrets only in Vault / function env; **new `sb_publishable_/sb_secret_` keys** from day
  one (v1's legacy keys are deprecated). Rotation runbook in CI.
- No PII/media in the repo — per-owner Storage buckets with RLS + signed URLs (v1 fixed
  this late; start there).
- Retention jobs from day one (pg_cron) for logs, findings, transient state.
- Structured logging with correlation ids; raw provider errors logged (the missing piece
  that made "Meta rejected the request" a mystery).
- CAPTCHA + leaked-password protection on at launch; strict CSP; no secrets in URLs.

---

## 9. Testing, observability, deploy

- **Tests:** unit (`pure.ts`, parsers), component (connect flows), SQL/pgTAP (RLS), a smoke
  test per connector against a sandbox app. `npm test` + `deno test` in CI.
- **Observability:** one structured-log format, an owner/admin health view, alerting on
  connector error spikes and cron failures.
- **Deploy:** PR → typecheck+test+lint; merge → deploy functions + `supabase db push` for
  migrations (with a manual-approval environment for prod). Zero dashboard editing.

---

## 10. Migration path from v1 (incremental, not big-bang)

1. Stand up CI/CD (done in v1's tail) and the `_core` library; adopt it one connector at a
   time (start with reddit-oauth) — verified per function. _(v1 already seeded `_core/pure.ts`.)_
2. Move migrations to the CLI `migrations/` format; keep applying via `db push`.
3. Extract the frontend into modules behind a build step; port routes one at a time,
   starting with the public persona page (unlocks SEO).
4. Build `feed_items` + `ai/research` as a new capability alongside the existing app — the
   news feed is additive, not a rewrite.
5. Retire the single `index.html` once routes are ported.

None of this requires a flag day; each step ships and is verified on its own.
