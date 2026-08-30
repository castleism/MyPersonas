# Connector status

_Account counts were checked live 2026-08-30 against the app's own data (160 ledger
accounts, 106 connection rows). The focused publishing readiness below was reconciled
with the isolated source checkout on 2026-08-30. “In the repo” does not mean pushed,
deployed, configured, connected, write-authorized, target-bound, or provider-verified._

## Connectible from the UI

| Provider | Connected | Remaining | Blocker on the remaining |
|---|---|---|---|
| Gmail | 28 / 28 | 0 | — done (inbox cleanup just needs each inbox un-paused) |
| X (Twitter) | 27 / 28 identity/read | 1 · chriscodyak | all intended posting accounts still require a fresh `tweet.write` authorization; chriscodyak also has `twitter_revoke_required` and must revoke the old app grant first |
| Facebook | 25 / 28 | 3 · Traditional Family Values, CannaCandidz, Sherlock Chomes | CannaCandidz/Sherlock Chomes are policy-blocked; Traditional Family Values still needs a pairing attempt |
| Instagram | 25 / 28 | 3 · cannacandidz, the.sherlock.chomes, trad.family.values | same account-by-account distinction as Facebook |

These connection counts prove identity/target inventory only. They do not prove that the current publisher release is deployed or that an action-time preview receipt and provider readback have passed.

## Not connected in the deployed UI snapshot

- **Reddit** — `reddit-oauth` and `reddit-post` are version-controlled in this checkout,
  and the local frontend now uses the actual capability/start/disconnect/callback
  contract with exact ledger username binding. This is **local implementation only**:
  the owner still needs to review/apply migration 021 if necessary, configure Reddit
  client credentials and callback, deploy both functions, push the Pages frontend, and
  verify one real OAuth round trip plus an owner-approved low-stakes post. The existing
  Reddit account is not claimed connected by this file.
- **Discord** — official `webhook.incoming` OAuth, immutable exact-channel binding, Vault
  erasure, owner-triggered sending, action-time preview receipts, reconciliation, and UI controls
  are implemented locally. Production credentials, deployment, authorization, and one
  designated-channel proof are still required; mentions remain disabled by default.
- **OnlyFans** — no public official account-management API was located; keep manual staging only.
- **YouTube, TikTok, Twitch, Patreon, Wix, WordPress** — see the seven-check readiness table below. None has a live, target-bound, provider-verified MyPersonas publisher in this release.

## Focused publishing readiness snapshot

Each column is a separate fact. A record marked **saved** is not a provider-authorized connection.

| Provider | Inventory | App credentials | Owner authorization | Exact write ability | Exact target | Publisher | Safe proof |
|---|---|---|---|---|---|---|---|
| YouTube | 3 saved records | source implemented; credentials not installed | 0 connected | `youtube.upload` not granted | channel not bound | Private-first uploader not deployed | private upload/readback not run |
| TikTok | 1 saved record | source implemented; credentials not installed | 0 connected | `video.upload` not granted | creator not bound | Upload-to-inbox not deployed; Direct Post disabled | inbox upload/status proof not run |
| Twitch | 1 saved record | source implemented; credentials not installed | 0 connected | no action-specific grant | channel not bound | limited action connector not deployed | read identity first; any visible write needs exact preview/approval |
| Patreon | 2 saved records | API v2 source implemented; credentials not installed | 0 connected | no general create-post permission exists | campaign not bound | read/report plus native editor handoff not deployed | read-only report or native draft proof needed |
| Wix | 2 saved records | native app flow staged; app not installed | 0 connected | Manage Blog + Read Members not granted | site/author not bound | source only; not live | publish-off Blog draft not run |
| WordPress | first-class connector source staged | .com OAuth and self-hosted modes staged | 0 connected | posts / edit_posts not granted | site/author not bound | source only; not live | Draft-only post not run |

The native Wix and WordPress connector source, migration, owner UI, and setup guidance are
staged locally. They are not deployed, credentialed, connected, or provider-verified. A sign-in
or tool grant elsewhere does not authorize the deployed MyPersonas application.

## Platform preview release gate

**No preview, no approval, no schedule, and no immediate send.**

No provider row may be approved, scheduled, or sent until the owner has seen the exact platform-specific
preview, exact destination, privacy/audience, disclosure, and date/time with a named time zone or explicit immediate
action. The server prepares a short-lived immutable receipt before the preview; the owner's separate AAL2 acknowledgement binds that exact revision and target, and the unchanged receipt can be consumed only once. Any change invalidates the receipt.
The preview shows the full submitted media in a relevant platform frame with safe-area
guidance, while final rendering can still vary by device and placement. Wix and WordPress also require
the provider's own active-theme draft preview before any later public schedule.

The number beside **Save target** is the provider's stable Page/channel/creator/campaign/site ID.
It is not an account count. A client ID identifies the developer app; a client secret is the app's
password and must never be entered in the target field.

## Next actions

1. **X (chriscodyak):** on x.com → Settings → Security and account access → Apps and sessions →
   revoke the AliaSpaces app; then in the app: Account & settings → Accounts → the chriscodyak X row →
   confirm revocation and reconnect. (Owner action — the revoke happens on X's site.)
2. **Reddit:** owner reviews migration 021 and the versioned functions → sets
   `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and the exact callback → deploys
   `reddit-oauth` + `reddit-post` and pushes the frontend → verifies Connect,
   Disconnect, account erasure, and one explicitly approved low-stakes post. Keep
   scheduled Reddit publishing off; the current Queue action is owner-triggered.
3. **Meta — Traditional Family Values:** attempt pairing (not a cannabis brand; may succeed).
   **CannaCandidz + Sherlock Chomes:** blocked by Meta content policy — plan manual/own-platform.
4. **YouTube:** deploy the implemented OAuth/uploader, bind one exact channel, then run one explicitly approved Private upload/readback proof.
5. **TikTok:** deploy the implemented `video.upload` connector, bind one exact creator, then run one explicitly approved Upload-to-inbox/status proof. Finish or discard it in TikTok; Direct Post remains off.
6. **Wix / WordPress:** bind one exact site and author, create a draft with publishing off, read it back, and open the provider's own preview.
7. **Twitch:** choose the exact feature (schedule, channel, chat, or moderation); do not present it as general feed/video publishing.
8. **Patreon:** use API access only for approved read/report/webhook or eligible Live work; ordinary posts stay in Patreon's native scheduler.

## Owner handoff boundary

MyPersonas can open each provider's official authorization route after the reviewed release is live.
The owner must take over only for provider login, MFA, CAPTCHA, developer terms, billing, app review,
business verification, and the final consent screen. Secrets never belong in this file, the ledger,
or chat.
