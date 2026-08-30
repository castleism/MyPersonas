# Wix app installation and exact-author binding

`wix-oauth` implements Wix's external app-install flow for one owned Wix ledger
row. It does not accept Wix passwords, cookies, account API keys, or an
unverified plain-text instance ID.

## Owner/deployment setup

1. Create the app in [Wix Custom Apps](https://manage.wix.com/account/custom-apps).
2. Request only **Manage Blog** (draft create/read/trash) and **Read Members**
   (the separate exact-author picker required because third-party Wix Blog
   draft creation requires `memberId`).
3. Release a version. For an unlisted app, create a Share Install Link and save
   its GUID as the non-secret `WIX_SHARE_URL_ID` Edge Function setting.
4. Set the non-secret Edge Function settings `WIX_APP_ID`,
   `WIX_POST_INSTALL_URI`, and `WIX_OAUTH_APP_ORIGIN`. The production callback
   is `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/wix-oauth`.
5. Store the Wix app secret in Supabase Vault with the exact name
   `wix_app_secret`. Do not put it in an Edge Function environment variable,
   browser, ledger field, repository, or chat.
6. Apply migration 070 before deploying the function. Gateway JWT verification
   is disabled because Wix calls the GET callback without a Supabase JWT; every
   browser POST validates the signed-in owner, approved origin, and AAL2.

The start response is a ten-minute MyPersonas launch URL. That endpoint sets an
HttpOnly same-browser cookie and builds Wix's official external installer URL
with a ticket-bearing `postInstallationUrl`. The callback requires the exact
cookie/ticket pair, app ID, instance ID, tenant/site ID, and HMAC-verified
`signedInstance`. Only the permanent instance ID is stored, as JSON in Vault.
Short-lived Wix access tokens are generated server-side and never persisted.

## Owner API

```json
{ "action": "capabilities", "ledgerId": "<owned Wix ledger UUID>" }
{ "action": "start", "ledgerId": "<owned Wix ledger UUID>" }
{ "action": "list-authors", "ledgerId": "<owned Wix ledger UUID>" }
{ "action": "select-author", "ledgerId": "<owned Wix ledger UUID>", "memberId": "<ID returned by list-authors>" }
{ "action": "disconnect", "ledgerId": "<owned Wix ledger UUID>", "confirmLocalDisconnect": true }
```

Successful author selection binds the exact provider target
`wix:<siteId>:<memberId>`. Disconnect is blocked while a verified provider draft
remains active. Local removal is not provider revocation: the owner must also
uninstall the app in Wix.

Official references:

- <https://dev.wix.com/docs/build-apps/launch-your-app/app-distribution/install-your-app/set-up-the-external-install-flow>
- <https://dev.wix.com/docs/build-apps/develop-your-app/access/app-instances/about-app-instances>
- <https://dev.wix.com/docs/api-reference/crm/members-contacts/members/member-management/members/list-members>
- <https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/create-draft-post>

