# X publisher release contract

`twitter-post` is the source-controlled, text-only X write adapter. It is safe to
deploy only after the X Web App credentials are installed and the owner has
deliberately reconnected each posting account through `twitter-oauth` with
`enablePosting:true`.

## Permissions

- Default X authorization remains read-only:
  `tweet.read users.read offline.access`.
- Explicit posting authorization adds only `tweet.write`.
- `media.write` is not requested. This worker rejects any draft containing a
  `media_url`; a separate reviewed media-upload adapter is required before that
  can change.

Official X references:

- OAuth 2.0 PKCE and scopes: <https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code>
- Create Post: <https://docs.x.com/x-api/posts/create-post>
- Get Post by ID: <https://docs.x.com/x-api/posts/get-post-by-id>
- Delete Post: <https://docs.x.com/x-api/posts/delete-post>

## Owner API

All actions require an allowed browser origin, a signed-in Supabase bearer, and
AAL2:

```json
{ "action": "publish-draft", "draftId": "<owned approved draft uuid>" }
{ "action": "verify-draft-post", "draftId": "<published draft uuid>" }
{ "action": "delete-draft-post", "draftId": "<published draft uuid>", "confirmDelete": true }
```

The function never accepts arbitrary text, usernames, tokens, or provider post
IDs from the browser. It resolves all provider input from the owned draft,
ledger, connection metadata, and encrypted Vault token bundle.

## Release verification

1. Run `tests/twitter-post-hardening.test.mjs` and the full test suite.
2. Deploy `twitter-oauth` and `twitter-post`; do not deploy the old dashboard-only
   drifted `twitter-post` source.
3. Reconnect one disposable/test X account with explicit posting permission and
   verify that the returned grant includes `tweet.write` but not `media.write`.
4. Create and exactly approve a unique text-only draft for that account.
5. Publish it once. Confirm the returned numeric post ID is checkpointed before
   the draft reaches `published`.
6. Run `verify-draft-post`; confirm the post author matches the connected X
   subject.
7. Run `delete-draft-post` with explicit confirmation. Confirm the follow-up X
   lookup reports the post absent while the local provider ID remains in immutable
   history.

A timeout, network failure, HTTP 408/5xx, unreadable success, or success without
a numeric post ID leaves the draft reconciliation-locked. Never retry that draft
until the account has been checked directly at X.
