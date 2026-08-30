# WordPress authorization and exact site/author binding

`wordpress-oauth` supports two explicit modes:

- WordPress.com Authorization Code OAuth with the narrow
  `posts` scope.
- Self-hosted WordPress REST authentication with a dedicated, revocable
  Application Password over public HTTPS.

It never accepts an ordinary WordPress password.

## WordPress.com setup

1. Register the application at [WordPress.com Applications](https://developer.wordpress.com/apps/).
2. Register the exact callback
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/wordpress-oauth`.
3. Set the non-secret `WORDPRESS_COM_CLIENT_ID`,
   `WORDPRESS_COM_REDIRECT_URI`, and `WORDPRESS_OAUTH_APP_ORIGIN` Edge Function
   settings.
4. Store the client secret in Supabase Vault with the exact name
   `wordpress_com_client_secret`. Do not use an environment variable or ledger
   field for the secret.
5. Apply migration 070 before deploying. Gateway JWT verification is disabled
   only so WordPress.com can call the GET callback; browser POST actions require
   owner auth, approved origin, and AAL2.

WordPress.com's production OAuth documentation does not advertise PKCE. This
implementation therefore uses a hashed, single-use ten-minute state, a Secure
HttpOnly same-browser cookie, AAL2 initiation, server-only authorization-code
exchange, token-info validation, exact blog ID, exact user/author ID, and
`edit_posts` verification. Neither code nor token is placed in the MyPersonas
URL. The access token is stored only in Vault.

## Self-hosted safety

The owner enters the exact site URL, username, and dedicated Application
Password in the transient connection dialog. The URL must be public HTTPS on
port 443 with no embedded credentials, query, fragment, redirect, internal
hostname, or private/reserved A/AAAA answer. `/users/me?context=edit` must attest
the exact author and `edit_posts`. The password is then stored only in Vault.
Production egress should additionally retain a network-level deny rule for
private/link-local metadata ranges as defense in depth against DNS rebinding.

## Owner API

```json
{ "action": "capabilities", "ledgerId": "<owned WordPress ledger UUID>" }
{ "action": "start", "ledgerId": "<owned WordPress ledger UUID>" }
{ "action": "connect-self-hosted", "ledgerId": "<owned WordPress ledger UUID>", "siteUrl": "https://example.com", "username": "author", "applicationPassword": "<transient>" }
{ "action": "disconnect", "ledgerId": "<owned WordPress ledger UUID>", "confirmLocalDisconnect": true }
```

The exact target is `wpcom:<siteId>:<authorId>` or
`wpself:<sha256(normalizedSiteUrl)>:<authorId>`. Active provider drafts must be
moved to Trash before disconnect. The owner must separately revoke the
WordPress.com connected app or self-hosted Application Password.

Official references:

- <https://developer.wordpress.com/docs/api/oauth2/>
- <https://developer.wordpress.com/docs/api/getting-started/>
- <https://developer.wordpress.org/advanced-administration/security/application-passwords/>
- <https://developer.wordpress.org/rest-api/reference/users/#retrieve-a-user>
