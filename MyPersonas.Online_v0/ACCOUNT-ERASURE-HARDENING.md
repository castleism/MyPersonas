# Account erasure hardening — Reddit and owner storage

Status: **local implementation; not deployed or live-verified** (2026-08-13).

Known release blocker: migration 019 stored Discord webhook secrets by ledger-derived
Vault name without an erasure RPC/credential FK. Until a new owner-scoped service cleanup
and existing-orphan inventory are added and verified, do not claim complete account erasure
for an owner who may have configured Discord. `discord-post` is dormant in the meantime.

Both `delete-account` and `erase-content` use the handler in
`supabase/functions/delete-account/index.ts`, so this package applies to complete account
erasure and content-only erasure.

## Reddit erasure contract

For every owner-scoped `account_ledger` row whose provider is `reddit`, erasure now:

1. inventories the complete paginated ledger set;
2. reads each Vault-backed token only through service-role-only
   `reddit_get_tokens_service`;
3. if any Reddit access or refresh token exists, requires `REDDIT_CLIENT_ID` and
   `REDDIT_CLIENT_SECRET` before making any provider request;
4. submits every stored refresh token to Reddit's official revocation endpoint using
   Basic client authentication, form encoding, `token_type_hint=refresh_token`, an
   explicit User-Agent, redirect refusal, and a 15-second timeout;
5. requires an HTTP success response for every extant refresh token before clearing the
   first local Reddit token;
6. calls `reddit_clear_tokens_service`, deletes the owner's matching OAuth state, and
   only then deletes that owner-scoped ledger row.

An absent refresh token has no provider secret to submit and proceeds to local cleanup.
A token-read error, missing client configuration for a stored refresh token, timeout,
redirect, network failure, or non-success response stops before any local Reddit token or
ledger deletion. Earlier provider revocations in the same request may already have
succeeded, but their local tokens remain available for a safe idempotent retry. Reddit is
not and must not become a manual acknowledgement checkbox in the erasure protocol.

The existing Meta owner-erasure lease is renewed immediately before the Reddit phase so
the complete erasure sequence does not silently continue on an expired owner lease.

## Owner storage contract

Erasure now service-inventories buckets and recursively removes only these exact prefixes:

| Bucket | Exact owner prefix |
|---|---|
| `media` | `<owner UUID>` |
| `persona-media` | `<owner UUID>` |
| `persona-docs` | `<owner UUID>` |
| `post-approved-media` | `owners/<owner UUID>` |

Each existing bucket is listed recursively in pages of 1,000, removed in batches of 500,
and re-listed for verification for up to three passes. A listing, removal, or final
verification error is bucket-specific and stops before general owned-row deletion. A
bucket confirmed absent from the service-role bucket inventory is treated as containing
no owner objects. No parent prefix, wildcard, or other owner's path is used.

## Direct Reddit disconnect contract

The versioned `reddit-oauth` `disconnect` action is now hardened locally to the same
fail-closed standard: it loads the stored token, requires client configuration when a
token exists, refuses redirects, times out, requires Reddit's success response, and only
then clears local credentials and reports `providerRevoked:true`. Provider failure leaves
the local token available for a safe retry and never reports `disconnected:true`.

OAuth callback failures after a new token is issued also attempt provider cleanup before
reporting the failure. If that cleanup cannot be confirmed, the callback surfaces
`provider_revoke_unconfirmed` rather than implying access was removed. These are local
source guarantees only until `reddit-oauth` is deployed and exercised against Reddit.

## Apply and verify

1. Confirm migrations 021, 026, and 035 and their Vault/storage prerequisites are in the
   target project. A missing optional bucket is safe; a missing Reddit token RPC is not.
2. Confirm the deployed Reddit app's exact client ID and secret are installed. Do not
   paste either credential into source, SQL, logs, or a deletion request.
3. Deploy both `delete-account` and `erase-content` with gateway JWT verification on.
4. Run `node --experimental-strip-types --check supabase/functions/delete-account/index.ts`
   and `pnpm test` before deployment.
5. On a disposable owner, test: no Reddit ledger; ledger without a refresh token; stored
   token with missing client config; provider timeout/non-success; successful revoke; and
   multiple ledgers where the last provider revoke fails. In every failure case inspect
   Vault, OAuth state, and ledger rows before retrying.
6. Populate a disposable file beneath each of the four exact owner prefixes plus a
   sentinel file for another owner. Verify erasure removes the four owned trees and leaves
   every sentinel untouched.

No provider call, storage deletion, SQL migration, function deployment, secret change, or
live account erasure was performed while preparing this package.
