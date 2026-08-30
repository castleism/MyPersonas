# YouTube connector authorization

`youtube-oauth` connects one owned ledger row to the exact YouTube channel
selected in Google's OAuth flow. It requests only the identity claims needed to
bind the Google account (`openid email`) and the one YouTube capability used by
this release (`youtube.upload`). It does not request delete, broad channel
management, comment, analytics, or community-post permissions.

## Deployment prerequisites

1. Create a Google Cloud web OAuth client and enable YouTube Data API v3.
2. Register this exact redirect URI:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/youtube-oauth`.
3. Configure `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` as Supabase Edge
   Function secrets. Optionally set `YOUTUBE_OAUTH_REDIRECT_URI` and
   `YOUTUBE_OAUTH_APP_ORIGIN` only when the registered values are changed at the
   same time.
4. Configure the Google OAuth consent screen. While the app remains in Testing,
   add every owner Google account as a test user. Publishing broadly requires
   Google's review for the sensitive `youtube.upload` scope.
5. Apply migration 067 before deploying the function.

Deploy with gateway JWT verification disabled because Google calls the GET
callback without a Supabase token. Every state-changing POST still validates a
signed-in owner, AAL2, the single-use hashed state, PKCE verifier, and the
initiating browser nonce.

## Owner API

```json
{ "action": "capabilities", "ledgerId": "<owned YouTube ledger UUID>" }
{ "action": "start", "ledgerId": "<owned YouTube ledger UUID>" }
{ "action": "complete", "state": "...", "code": "...", "browserNonce": "..." }
{ "action": "refresh", "ledgerId": "<owned YouTube ledger UUID>" }
{ "action": "disconnect", "ledgerId": "<owned YouTube ledger UUID>" }
```

Tokens never return to the browser. Access and refresh tokens are encrypted in
Supabase Vault. A ledger login email, when present, must match Google's verified
email. A recorded `UC...` channel ID, when present in the ledger username or
URL, must match the channel Google attests through `channels.list(mine=true)`.
The database blocks ledger deletion or identity retargeting while a revocable
YouTube credential remains; disconnect first so provider revocation is confirmed.

Official references:

- <https://developers.google.com/identity/protocols/oauth2/web-server>
- <https://developers.google.com/identity/protocols/oauth2/resources/best-practices>
- <https://developers.google.com/youtube/v3/guides/authentication>
- <https://developers.google.com/youtube/v3/docs/channels/list>
