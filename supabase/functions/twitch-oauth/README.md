# Twitch OAuth connector

This function binds one Account Ledger row to the exact Twitch broadcaster
returned by Twitch OAuth. Tokens are stored only through the Vault-backed RPCs
in migration 071. The ledger must already contain the exact Twitch login.

## Owner setup

1. Open [Twitch Developer Console](https://dev.twitch.tv/console/apps) and
   register a confidential application for MyPersonas.
2. Register this exact OAuth redirect URL:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/twitch-oauth`
3. Set Edge Function secrets `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`,
   `TWITCH_OAUTH_REDIRECT_URI`, and `TWITCH_OAUTH_APP_ORIGIN`.
4. Choose only the features needed for the broadcaster. The connector requests:
   - channel info: `channel:manage:broadcast`
   - stream schedule: `channel:manage:schedule`
   - chat announcements: `moderator:manage:announcements`

The callback validates a single-use hashed state. Token exchange/storage and
every owner action require a signed-in AAL2 session. Twitch tokens are validated
on connection and every owner-triggered action.

This connector does **not** grant a general social-feed post capability or a
video-upload capability.

