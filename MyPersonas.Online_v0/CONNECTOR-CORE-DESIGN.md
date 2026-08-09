# Connector Core — Design Note

_ARCHITECTURE-REVIEW.md P2. The five OAuth connectors
(meta-oauth, gmail-oauth, twitter-oauth, reddit-oauth, plus the discord webhook
poster) re-implement the same token/identity/revocation machinery. Every bug we hit
this session (the PL/pgSQL variable_conflict, the silent-notice, the per-item IG
call, the "could not lock" wedge) lived in that duplicated machinery. This note
sketches a shared core so each provider becomes a thin adapter._

## Duplicated logic today (per connector)

- OAuth code exchange + long-lived token exchange.
- `appsecret_proof` / HMAC signing of provider calls (Meta), bearer headers.
- `fetchJson` with timeout, redirect:"error", and provider-error normalization.
- Vault-backed token storage via `*_store_refresh_token` / `*_get_refresh_token`
  RPCs and delete triggers that clean the Vault secret.
- Fail-closed revocation: never auto-revoke a shared grant; mark
  `*_manual_revoke_required` / `google_revoke_required`; require explicit ack.
- Operation leases (`claim_*_token_operation` / `release_*`) to serialize
  connect/disconnect/reset.
- Exact identity/email match between the provider profile and the ledger record.
- A `capabilities` action reporting configured/authenticationEnabled/postingEnabled.
- Redirect-back handling and a browser-nonce bound to the OAuth `state`.

## Proposed shared module (`supabase/functions/_shared/connector/`)

- `http.ts` — `fetchJson`, `graphGet`-style helper, timeout, provider-error class,
  retry/backoff for transient (429/5xx) responses. **Standardize on field
  expansion / batch reads** (the IG fix) instead of N+1 per-item calls.
- `oauth.ts` — `exchangeCode`, `exchangeLongLived`, PKCE helpers, state+nonce.
- `vault.ts` — thin wrappers over the store/get/delete refresh-token RPCs.
- `revocation.ts` — the fail-closed state machine (pending → revoking →
  provider_revoked / manual_required) shared across providers.
- `leases.ts` — generic claim/release around a `*_token_operation_leases` table.
- `identity.ts` — normalized identifier match (trim+lowercase email; provider
  subject); reused by the ledger too (see frontend `normalizeLedgerEmail`).
- `respond.ts` — CORS, `json()`, `redirectToApp()`, allowed-origins.

Each provider file (`meta.ts`, `gmail.ts`, …) then declares only: its scopes,
auth URLs, profile/asset discovery, and any provider-specific quirks.

## Cross-cutting rules to bake in (lessons from this session)

1. **Every action surfaces its outcome** — success and each failure reason. The
   silent-Gmail bug came from a notice that was set but never rendered. Make the
   return contract force a user-visible message.
2. **Non-destructive escape everywhere** — a "close, change nothing" path on every
   selection modal; Escape must never trigger a destructive cancel.
3. **Idempotent, safe retries** — a repeated connect/cancel must not wedge state
   (the "could not lock" 42702 bug). Prefer self-healing over raising.
4. **`#variable_conflict use_column`** on any `RETURNS TABLE` PL/pgSQL function
   whose OUT column names collide with table columns.
5. **Batch/expand over per-item provider calls** — halves request volume and dodges
   rate limits and per-asset rejections (the IG discovery fix).
6. **Pure helpers are unit-tested** — `tests/lib/meta-helpers.mjs` is the seed; the
   core's pure functions (parsers, validators, expiry) should import from one place
   and be covered.

## Migration path (incremental, low-risk)

1. ✅ **Done (2026-08-08):** extracted the pure helpers into
   `supabase/functions/_shared/connector/pure.ts` and pointed a test at the real
   module (`tests/pure-core.test.mjs`, via Node type-stripping) — no mirrored copy
   to drift. ADDITIVE: nothing imports it yet, so deployed behavior is unchanged.
2. Adopt `pure.ts` in one connector at a time (start with reddit-oauth), deleting
   the inline duplicates; deploy + verify each. See `_shared/connector/README.md`.
3. Extract `http.ts` + `respond.ts` (no behavior change); adopt per connector.
4. Extract `leases.ts` + `revocation.ts`; migrate meta-oauth (most complex) last.

_Status: pure-helper slice extracted + tested (step 1). Remaining slices need
per-connector adoption + deploy verification — do with eyes on._
