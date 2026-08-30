# Discord channel publishing

Status: implementation complete in source; not deployed, connected, or
provider-tested by this change.

MyPersonas uses Discord's official OAuth2 authorization-code flow with the
single `webhook.incoming` scope. Discord presents the owner with a server and
channel selector and returns one channel-scoped incoming webhook. MyPersonas
does not request a Discord password, bot token, or user-token automation.

Official references:

- [Discord OAuth2 webhooks](https://docs.discord.com/developers/topics/oauth2#webhooks)
- [Discord webhook resource](https://docs.discord.com/developers/resources/webhook)
- [Discord Developer Portal applications](https://discord.com/developers/applications)

## Owner setup

1. Open the Discord Developer Portal and create or select the MyPersonas
   application.
2. In **OAuth2**, register this redirect URL exactly:

   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/discord-oauth`

   If `DISCORD_OAUTH_REDIRECT_URI` is intentionally set to a different URL,
   register that exact value instead. Discord and Supabase must match byte for
   byte.
3. Copy the application's **Application ID** and create or reset its **Client
   Secret**. Put them only in Supabase Edge Function secrets:

   - `DISCORD_CLIENT_ID`
   - `DISCORD_CLIENT_SECRET`

   Never paste either secret into the website, chat, source repository, or a
   draft. The Application ID is not itself secret, but keeping both values in
   server configuration avoids conflicting setup paths.
4. Apply canonical migration 066 and its timestamped mirror, then migration
   069 for the required platform-preview receipt. Deploy `discord-oauth`,
   `discord-post`, and the updated `delete-account` function. The OAuth
   function must use `verify_jwt=false`; the publisher and account-erasure
   functions keep gateway JWT verification enabled.
5. In MyPersonas, open the Discord account, choose **Connect Discord**, and
   complete Discord's server/channel selector. Choose a private disposable
   text channel for the first verification. The selected server, channel, and
   webhook IDs should appear after the connection returns.
6. Create a Discord draft assigned to that exact account/persona. Open its
   Discord preview. Approval is valid only when it records:

   - preview version `platform-preview-v1`;
   - the exact connected Discord channel ID;
   - the canonical preview hash for the approved content hash and channel;
   - a current preview timestamp.
7. Press **Publish now** while signed in at AAL2. Scheduled and background
   Discord publishing remain disabled. A successful write must return and
   durably save the exact Discord message ID and channel ID. Use **Verify** to
   re-read that exact message; use **Delete** only with the exact IDs shown by
   the verification record.

## What is supported

- One exact Discord server/channel webhook per connected account-ledger row.
- Owner-triggered text posts with credential-free HTTPS media links included
  in the message body.
- Media links containing embedded usernames/passwords, access tokens, API keys,
  or common signed-URL parameters are rejected before Discord is contacted.
- `allowed_mentions.parse=[]`, so draft text cannot unexpectedly mention
  everyone, roles, or users.
- Exact-message verification and exact-message deletion.
- Safe disconnect and full-account erasure: delete the remote webhook first,
  revoke the OAuth grant second, then erase the Vault bundle.

Forum/media channels that require a thread are not supported. Choose a normal
text channel. Discord posts longer than 2,000 characters are rejected for
owner revision rather than silently truncated.

## Fail-closed behavior

- OAuth state is hashed, expires, is single-use, and is bound to the owner,
  ledger, and initiating browser nonce.
- Webhook URL/token and OAuth access/refresh tokens are stored only in Vault
  and are available only through service-role RPCs.
- Connect, complete, disconnect, publish, verify, and delete require a signed-in
  owner at AAL2. The browser never receives stored webhook or OAuth tokens.
- Publish requires the current owner/account/persona assignment, exact
  canonical approval hash, exact preview receipt, enabled account, and global
  automation pause to be off.
- The provider request uses `wait=true`. Network failures, timeouts, HTTP 408,
  HTTP 5xx, malformed success responses, and lost durable checkpoints lock the
  draft for exact-message reconciliation. They are never automatically
  retried.
- Disconnect and account deletion retain Vault handles unless Discord
  definitively confirms webhook absence/deletion and OAuth revocation. An
  ambiguous response stops local erasure.
- If Discord issues an exact webhook/token bundle but immediate verification
  or cleanup is ambiguous, the connector retains it as a non-publishable Vault
  cleanup hold. **Disconnect** can safely retry the exact remote removal; the
  hold can never satisfy the publisher's connected/verified checks.

## Release gates

Do not describe Discord as connected or verified until all of these pass in a
private disposable channel:

1. Migrations 066 then 069 are applied and their canonical/timestamped files
   are byte-identical.
2. Required function secrets are present and the redirect URI matches the
   Developer Portal.
3. The owner selects the intended server/channel through Discord consent.
4. The website shows the same channel ID as the stored provider subject.
5. One previewed and approved test draft publishes only after an explicit
   owner press and records exact message/channel IDs.
6. Verify reads that exact message; Delete removes that exact message and a
   second verify confirms absence.
7. Disconnect deletes the exact webhook and revokes OAuth before local Vault
   deletion.
8. A fresh reconnect succeeds after disconnect.
9. Scheduled/background Discord publishing remains off.

If a provider outcome is ambiguous, inspect Discord's **Authorized Apps** and
the selected server's **Integrations**. Do not reconnect, erase the local
credential, or republish the draft until the exact provider state is resolved.
