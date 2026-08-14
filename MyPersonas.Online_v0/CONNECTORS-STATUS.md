# Connector status

_Account counts were checked live 2026-08-12 against the app's own data (160 ledger
accounts, 106 connection rows). Code status below was reconciled with this checkout on
2026-08-13. “In the repo” does not mean pushed, deployed, configured, connected, or
provider-verified._

## Connectible from the UI

| Provider | Connected | Remaining | Blocker on the remaining |
|---|---|---|---|
| Gmail | 28 / 28 | 0 | — done (inbox cleanup just needs each inbox un-paused) |
| X (Twitter) | 27 / 28 | 1 · chriscodyak | connection_state=`error`, error_code=`twitter_revoke_required` — old app auth must be revoked at x.com, then confirm + reconnect |
| Facebook | 25 / 28 | 3 · Traditional Family Values, CannaCandidz, Sherlock Chomes | CannaCandidz/Sherlock Chomes are policy-blocked; Traditional Family Values still needs a pairing attempt |
| Instagram | 25 / 28 | 3 · cannacandidz, the.sherlock.chomes, trad.family.values | same account-by-account distinction as Facebook |

So "the rest of the connectible accounts" = **1 X + 6 Meta**, and every one has a specific blocker — none is a plain click-to-connect.

## Not connected in the deployed UI snapshot

- **Reddit** — `reddit-oauth` and `reddit-post` are version-controlled in this checkout,
  and the local frontend now uses the actual capability/start/disconnect/callback
  contract with exact ledger username binding. This is **local implementation only**:
  the owner still needs to review/apply migration 021 if necessary, configure Reddit
  client credentials and callback, deploy both functions, push the Pages frontend, and
  verify one real OAuth round trip plus an owner-approved low-stakes post. The existing
  Reddit account is not claimed connected by this file.
- **Discord** — historical migration/function source exists, but the current frontend has no
  webhook Connect/Post controls and production state is not verified. `discord-post` is
  intentionally fail-closed/dormant in this release pending the safety rebuild documented in
  `ROADMAP-EXECUTION-2026-08-13.md`.
- **OnlyFans, YouTube, Twitch, Patreon, website** — no connector built. OnlyFans has no public API;
  YouTube/Twitch would each be a new OAuth integration (registered app + client + secret + callback).
  These are ledger/planning records only, not click-to-connect.

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
4. **OnlyFans / YouTube / Twitch:** roadmap builds if wanted (new integrations, not quick connects).

## Note on driving from here

The Account & settings view renders blank in automated screenshots (client-render timing), so the
per-account Connect/reset controls can't be driven blind safely on the live production account. The
X reset and Meta pairing are best done on-screen with live guidance; the Reddit wiring is a code task.
