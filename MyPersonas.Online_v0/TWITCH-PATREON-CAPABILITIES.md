# Twitch and Patreon capability handoff

Status: local implementation foundation, not deployed, not provider-verified.
Current source review: 2026-08-30.

## Truthful capability matrix

| Provider | Safe implemented capability | Not represented as supported |
|---|---|---|
| Twitch | exact broadcaster OAuth; selected least-privilege scopes; channel-info edits; stream-schedule segment creation; immediate chat announcements; action-specific preview/approval receipts; provider readback where Twitch exposes it | general feed posting; uploading a recorded video; scheduled chat announcements; eligibility guarantees |
| Patreon | API v2 identity/campaign binding; read-only existing-post report; immutable copy package and native editor handoff | API-created, API-edited, API-published, or API-scheduled ordinary Patreon posts; browser scraping/automation; provider-verified native completion |

Every Twitch write and Patreon handoff requires a current migration-069
platform preview for the exact provider subject. A Twitch write also requires a
second preview of the exact Helix action payload. Every provider mutation or
native handoff requires AAL2, current pause state, current persona assignment,
and current provider binding. OAuth and report operations also require AAL2 and
exact owned-ledger binding.

## Twitch owner setup

1. Open the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Create a confidential app and register exactly:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/twitch-oauth`
3. Supply deployment secrets (never paste them into the website or repository):
   `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`,
   `TWITCH_OAUTH_REDIRECT_URI`, `TWITCH_OAUTH_APP_ORIGIN`.
4. Connect each Twitch ledger entry and select only the required features:
   - `channel:manage:broadcast` for channel information;
   - `channel:manage:schedule` for stream schedule segments;
   - `moderator:manage:announcements` for chat announcements.
5. Verify the returned broadcaster ID/login and exact granted scopes. A
   non-recurring schedule segment is available only to Twitch Affiliates and
   Partners. Announcements require the authenticated user to be a moderator for
   the broadcaster; the implementation uses the broadcaster as moderator.
6. Before the first real action, use a low-stakes test only after reviewing both
   previews. Verify channel/schedule readback. A chat announcement has no
   durable readback endpoint, so ambiguous outcomes require manual review and
   must not be resent using the same receipt.

Official references: [Twitch API reference](https://dev.twitch.tv/docs/api/reference),
[OAuth code flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/),
[scopes](https://dev.twitch.tv/docs/authentication/scopes/),
[token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/),
and [application registration](https://dev.twitch.tv/docs/authentication/register-app/).

## Patreon owner setup

1. Create a **v2** OAuth client at [Patreon Clients & API Keys](https://www.patreon.com/portal/registration/register-clients).
2. Register exactly:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/patreon-oauth`
3. Supply deployment secrets: `PATREON_CLIENT_ID`,
   `PATREON_CLIENT_SECRET`, `PATREON_OAUTH_REDIRECT_URI`, and
   `PATREON_OAUTH_APP_ORIGIN`.
4. Connect with only `identity campaigns campaigns.posts`. Select the exact
   campaign if Patreon returns more than one. This connector does not request
   member, email, webhook-write, or Live write scopes.
   Patreon appends newly requested scopes to older grants, so revoke any older
   broader MyPersonas grant before reconnecting; this connector rejects extras.
5. Use the read report to verify the bound campaign and latest existing posts.
6. For a new ordinary Patreon post, review the exact MyPersonas native-handoff
   preview, prepare the immutable package, and open
   [Patreon's post editor](https://www.patreon.com/posts/new). If that convenience
   URL does not select the right campaign, use **Create > Post**. Paste the copy,
   select the previewed audience and schedule, review Patreon's own final
   preview, and complete it there.
7. Record completion in MyPersonas only as an owner attestation. There is no API
   proof that the native action occurred.

Patreon public API v1 retires October 7, 2026. This implementation uses v2.
Patreon's v2 reference documents GET endpoints for campaign posts and individual
posts, but no ordinary post-create/schedule endpoint. The only current Patreon
write family related to content is early-access Lives, which is not requested or
implemented here.

Official references: [Patreon API v2 reference](https://docs.patreon.com/),
[Posting to Patreon](https://support.patreon.com/hc/en-us/articles/115004048046-Posting-to-your-Patreon),
and [Scheduled posts](https://support.patreon.com/hc/en-us/articles/360031956632-Scheduled-posts).

## Remaining release gates

- Review and apply migration 071 through the migration deployment process.
- Deploy the four Edge Functions and add provider secrets in Supabase.
- Create/register the two provider apps and exact redirect URLs.
- Complete owner OAuth, campaign/broadcaster selection, and scope verification.
- Render desktop/mobile previews and run owner-approved low-stakes tests.
- Confirm that pause, reassignment, disconnect, expired-token, provider-timeout,
  and reconciliation paths fail safely in the deployed environment.

None of those release gates was performed by the local implementation work.
