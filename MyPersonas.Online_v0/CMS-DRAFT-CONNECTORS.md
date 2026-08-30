# Wix Blog and WordPress draft-only connectors

## Current release status

The source, migration, owner controls, and setup guidance are staged locally.
They have not been deployed, configured with production credentials, connected
to a provider, or exercised against a live site. No Wix or WordPress item was
created by this work.

The first provider proof is deliberately limited to creating one unpublished,
text-only provider **Draft**, reading it back, and handing it to the owner for
provider-native review. There is no CMS publish or scheduling endpoint.

## Required release order

1. Apply migration 069, `agent-draft-platform-preview-gate`.
2. Apply migration 070, `cms-draft-connectors`.
3. Add the provider app settings and Vault secrets listed below.
4. Deploy `wix-oauth`, `wix-draft`, `wordpress-oauth`, and
   `wordpress-draft` with the checked-in `supabase/config.toml` settings.
5. Connect one designated low-stakes site and exact author at owner AAL2.
6. Approve the exact MyPersonas platform preview for a text-only draft.
7. Use Queue's second Wix- or WordPress-specific preview and create one
   provider Draft.
8. Read it back in MyPersonas and inspect it in the provider workspace. Do not
   publish or schedule it as part of connector verification.

Migration 070 fails closed unless migration 069's exact preview functions and
columns already exist. Its canonical and timestamped copies must remain
byte-identical:

- `MyPersonas.Online_v0/sql-updates/070-cms-draft-connectors.sql`
- `supabase/migrations/20260830130000_cms_draft_connectors.sql`

## Owner-facing behavior

### Accounts

Studio > Accounts > Wix or WordPress > Connection shows connector controls.

- Wix opens Wix's official app installer. Wix chooses the site; MyPersonas
  verifies that installed instance and then requires a separate exact author
  selection. The connection is not promoted to `connected` until both a Read
  Members call and a Manage Blog read succeed.
- WordPress.com opens the official authorization-code flow and binds the exact
  normalized site URL and author returned by WordPress.com.
- Self-hosted WordPress accepts a dedicated Application Password once in a
  transient dialog. It permits only an exact public HTTPS site, no redirects,
  and an author whose `/users/me?context=edit` response proves `edit_posts`.

Disconnect removes the local Vault credential only after all verified provider
Drafts have been moved to Trash. The UI then links to Wix or WordPress so the
owner can separately revoke the provider-side app or Application Password.

### Queue and exact preview approval

A Wix or WordPress handoff button is available only when all of these are true:

- the owner is at AAL2;
- the draft is owner-approved;
- its durable `platform-preview-v1` receipt matches the current content hash;
- the receipt's target is the current exact provider site/author subject;
- the owner, persona, ledger account, connection, and credential agree;
- the owner-wide automation pause is off;
- the title is present and the media field is exactly empty;
- the source draft is not publishing or published.

The button opens a second platform-specific preview showing the exact text,
site/author target, and the fact that the provider operation is Draft-only.
The server rechecks the durable migration-069 receipt before and after claiming
the attempt, immediately before any provider mutation.

An HTTP 202 or `reconciliationRequired` response means the outcome is uncertain.
The UI changes to **Reconcile provider draft**. It never blindly retries create,
and reconciliation cannot create a new attempt without a prior create claim.
Unfinished create and Trash attempts are reloaded from a durable owner-scoped
recovery RPC, so closing or refreshing the browser cannot restore a mutation
button while a provider outcome is uncertain.

After creation, readback checks the exact site, author, title, provider status,
and a durable provider-content hash. Reconciliation fails closed if the
provider reports more candidates than a single result page can prove unique.

- WordPress returns its authenticated preview URL and exact editor URL.
- Wix's public API returns a future public URL shape, not a documented
  active-theme preview deep link for an unpublished API draft. MyPersonas does
  not mislabel that URL as a preview. It returns the exact-site dashboard and
  provider draft ID; the owner opens Blog > Posts > Drafts and uses Wix's own
  preview before any later publish or schedule decision.

## Provider setup

### Wix Blog

1. Create the app in [Wix Custom Apps](https://manage.wix.com/account/custom-apps).
2. Add only **Manage Blog** and **Read Members**. Confirm the exact permission
   scopes in the Wix API reference, release a version, and let existing sites
   approve any changed permission version.
3. If the app is unlisted, create a Share Install Link and retain its GUID.
4. Set the external post-install URL to
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/wix-oauth`.
5. Add these non-secret Edge Function settings:
   - `WIX_APP_ID`
   - `WIX_SHARE_URL_ID` for an unlisted Share Install Link
   - `WIX_POST_INSTALL_URI`
   - `WIX_OAUTH_APP_ORIGIN` (`https://mypersonas.online` in production)
6. In the Supabase Vault UI, create exactly one secret named
   `wix_app_secret`. Do not also put the app secret in an Edge Function setting,
   repository file, account ledger, browser, or chat.

The callback validates the HMAC-signed Wix instance, short signature age,
same-browser ticket, app ID, instance ID, tenant/site ID, and the site returned
by Get App Instance. Only the permanent instance ID is retained, as encrypted
JSON in a ledger-specific Vault secret. Short-lived Wix access tokens are not
stored.

Official documentation:

- [External install flow](https://dev.wix.com/docs/build-apps/launch-your-app/app-distribution/install-your-app/set-up-the-external-install-flow)
- [Configure and verify app permissions](https://dev.wix.com/docs/build-apps/develop-your-app/access/authorization/configure-permissions-for-your-app)
- [App instances](https://dev.wix.com/docs/build-apps/develop-your-app/access/app-instances/about-app-instances)
- [Create Draft Post](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/create-draft-post)
- [Query Draft Posts](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/query-draft-posts)

### WordPress.com

1. Register MyPersonas at
   [WordPress.com Applications](https://developer.wordpress.com/apps/).
2. Register exactly
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/wordpress-oauth`
   as the callback.
3. Add these non-secret Edge Function settings:
   - `WORDPRESS_COM_CLIENT_ID`
   - `WORDPRESS_COM_REDIRECT_URI`
   - `WORDPRESS_OAUTH_APP_ORIGIN` (`https://mypersonas.online` in production)
4. In the Supabase Vault UI, create exactly one secret named
   `wordpress_com_client_secret`.

The official production flow does not advertise PKCE. This implementation uses
the narrow `posts` scope, hashed single-use ten-minute state, Secure HttpOnly
same-browser cookie, owner-AAL2 initiation, server-only code exchange,
token-info validation, exact normalized full site URL (including a subdirectory
path), exact author ID, and `edit_posts` proof. Tokens are Vault-only.

Official documentation:

- [WordPress.com OAuth](https://developer.wordpress.com/docs/api/oauth2/)
- [WordPress.com REST API](https://developer.wordpress.com/docs/api/getting-started/)
- [Connected-app revocation](https://wordpress.com/me/security/connected-applications)

### Self-hosted WordPress

1. Record the exact public HTTPS site URL on its WordPress account ledger row.
2. Create a dedicated, revocable Application Password for the intended author.
3. In Studio > Accounts > WordPress > Connection, choose self-hosted, enter the
   exact URL, username, and Application Password, and then clear/revoke it if
   the connection fails.

The browser clears the password field immediately and never stores the value.
The server normalizes the exact URL, rejects embedded credentials, non-443
ports, query/fragment values, internal hostnames, private/reserved A or AAAA
answers, and all redirects. Every later request repeats the public-host check.
A production environment must also deny private, link-local, and cloud metadata
destinations at the network egress layer to defend against DNS rebinding.

Official documentation:

- [Application Passwords](https://developer.wordpress.org/advanced-administration/security/application-passwords/)
- [REST Posts](https://developer.wordpress.org/rest-api/reference/posts/)
- [REST Users](https://developer.wordpress.org/rest-api/reference/users/)

Supabase documents that Vault encrypts secrets on disk and provides a Vault UI:
[Supabase Vault](https://supabase.com/docs/guides/database/vault).

## Edge Function contracts

All browser POST actions require a valid owner JWT, allowed Origin, and AAL2.
Provider redirects use GET because they cannot carry a Supabase JWT; they
complete only a short-lived same-browser transaction initiated at AAL2.

### `wix-oauth`

```json
{ "action": "capabilities", "ledgerId": "<owned Wix ledger UUID>" }
{ "action": "start", "ledgerId": "<owned Wix ledger UUID>" }
{ "action": "list-authors", "ledgerId": "<owned Wix ledger UUID>" }
{ "action": "select-author", "ledgerId": "<owned Wix ledger UUID>", "memberId": "<ID returned by list-authors>" }
{ "action": "disconnect", "ledgerId": "<owned Wix ledger UUID>", "confirmLocalDisconnect": true }
```

### `wordpress-oauth`

```json
{ "action": "capabilities", "ledgerId": "<owned WordPress ledger UUID>" }
{ "action": "start", "ledgerId": "<owned WordPress ledger UUID>" }
{ "action": "connect-self-hosted", "ledgerId": "<owned WordPress ledger UUID>", "siteUrl": "https://example.com", "username": "author", "applicationPassword": "<transient dedicated password>" }
{ "action": "disconnect", "ledgerId": "<owned WordPress ledger UUID>", "confirmLocalDisconnect": true }
```

### `wix-draft` and `wordpress-draft`

```json
{ "action": "create-draft", "draftId": "<exact-preview-approved draft UUID>" }
{ "action": "reconcile", "draftId": "<same draft UUID>" }
{ "action": "verify-draft", "draftId": "<same draft UUID>" }
{ "action": "delete-draft", "draftId": "<same draft UUID>", "confirmDelete": true, "expectedProviderDraftId": "<visible provider ID>", "expectedTargetId": "<visible exact site/author target>" }
{ "action": "finalize-trash-checkpoint", "draftId": "<same draft UUID>", "confirmProviderTrash": true, "expectedProviderDraftId": "<visually verified provider ID>", "expectedTargetId": "<visible exact site/author target>" }
```

The functions expose no `publish`, `publish-now`, `schedule`, `private`, or
visibility-changing action. WordPress sends `status: "draft"`; Wix sends
`publish: false`. Delete uses reversible Trash (`force=false` or
`permanent=false`). Before that DELETE, a durable claim blocks every duplicate.
If the provider confirms Trash but the local atomic checkpoint is interrupted,
the owner must visually verify the exact item in provider Trash before the
local-only `finalize-trash-checkpoint` action is enabled; that recovery action
does not call the provider.
