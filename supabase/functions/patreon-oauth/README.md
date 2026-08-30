# Patreon API v2 read connector

This connector uses a Patreon API v2 OAuth client and only these read scopes:
`identity`, `campaigns`, and `campaigns.posts`. It binds the exact owner-selected
campaign and can return a read-only report of existing posts. It does not read
member details or email addresses.

## Owner setup

1. Create a **v2** client in [Patreon Clients & API Keys](https://www.patreon.com/portal/registration/register-clients).
2. Register this exact redirect URL:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/patreon-oauth`
3. Set Edge Function secrets `PATREON_CLIENT_ID`, `PATREON_CLIENT_SECRET`,
   `PATREON_OAUTH_REDIRECT_URI`, and `PATREON_OAUTH_APP_ORIGIN`.
4. Connect the Account Ledger row and explicitly select the campaign if Patreon
   returns more than one.

Patreon API v1 retires October 7, 2026, so this implementation uses only v2
resource endpoints and explicitly requested fields. Tokens are Vault-only.

Patreon does not document a developer token-revocation endpoint. Disconnect
therefore requires the owner to revoke MyPersonas under Patreon connected apps,
acknowledge that step, and only then remove the local Vault bundle.

This function never calls a post-create, post-update, post-schedule, or
post-delete endpoint.

