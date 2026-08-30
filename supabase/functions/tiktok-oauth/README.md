# TikTok connector authorization

`tiktok-oauth` connects one owned TikTok ledger row to the exact TikTok account
returned by Login Kit. It requests only basic/profile identity plus
`video.upload` for the first release. `video.publish` is requested only when
Direct Post is deliberately enabled and its provider-audit state is explicitly
recorded.

## Deployment prerequisites

1. Create a TikTok for Developers app, add Login Kit and the Content Posting
   API, and request approval for `user.info.basic`, `user.info.profile`, and
   `video.upload`. Request `video.publish` only for a reviewed Direct Post
   release.
2. Register the exact web redirect URI configured in
   `TIKTOK_OAUTH_REDIRECT_URI`. The default code value is
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/tiktok-oauth`.
3. Configure these Supabase Edge Function secrets:
   `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`,
   `TIKTOK_OAUTH_REDIRECT_URI`, and `TIKTOK_OAUTH_APP_ORIGIN`.
4. Apply migrations 068 and 069 before deploying the functions.
5. Add the same application origin and redirect URI to TikTok's approved web
   settings. Keep the app in a non-production test state until TikTok approval
   and a real owner-account connect/disconnect test both succeed.

Deploy this callback with gateway JWT verification disabled because TikTok
calls the GET callback without a Supabase token. The function still requires a
signed-in owner to start/complete authorization and AAL2 for destructive token
operations. It validates a hashed single-use OAuth state, a same-browser nonce,
and PKCE before exchanging the code.

## Owner API

```json
{ "action": "capabilities", "ledgerId": "<owned TikTok ledger UUID>" }
{ "action": "start", "ledgerId": "<owned TikTok ledger UUID>", "accessMode": "upload" }
{ "action": "complete", "state": "...", "code": "...", "browserNonce": "..." }
{ "action": "refresh", "ledgerId": "<owned TikTok ledger UUID>" }
{ "action": "disconnect", "ledgerId": "<owned TikTok ledger UUID>" }
```

Tokens never return to the browser or live in ordinary database columns. They
are encrypted in Supabase Vault and can be read only through service-role RPCs.
The OAuth `open_id` and current username must exactly match the owner ledger;
identity drift fails closed. If token exchange, refresh, or revocation has an
ambiguous result, the connector locks into manual-revocation recovery rather
than guessing or retrying.

Official references:

- <https://developers.tiktok.com/docs/en/login-kit-web>
- <https://developers.tiktok.com/docs/en/oauth-user-access-token-management>
- <https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info>
- <https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content>
