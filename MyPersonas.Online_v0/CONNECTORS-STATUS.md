# Connector status

_Checked live 2026-08-12 against the app's own account data (160 ledger accounts, 106 connection rows)._

## Connectible from the UI

| Provider | Connected | Remaining | Blocker on the remaining |
|---|---|---|---|
| Gmail | 28 / 28 | 0 | — done (inbox cleanup just needs each inbox un-paused) |
| X (Twitter) | 27 / 28 | 1 · chriscodyak | connection_state=`error`, error_code=`twitter_revoke_required` — old app auth must be revoked at x.com, then confirm + reconnect |
| Facebook | 25 / 28 | 3 · Traditional Family Values, CannaCandidz, Sherlock Chomes | Meta pairing; the cannabis personas are blocked by Meta restricted-goods policy |
| Instagram | 25 / 28 | 3 · cannacandidz, the.sherlock.chomes, trad.family.values | same as Facebook |

So "the rest of the connectible accounts" = **1 X + 6 Meta**, and every one has a specific blocker — none is a plain click-to-connect.

## NOT connectible from the UI

- **Reddit** — the `reddit-oauth` backend exists, but there is **no `connectReddit` wiring in the
  frontend** (no button/function). The 1 Reddit account (christiancodyak) can't be connected until
  that wiring is added. ⚠️ `reddit-oauth` is a **drifted** function (not in the repo — see
  `supabase/functions/DRIFT.md`); pull it first to see its start/callback contract before wiring,
  or the frontend will guess the shape wrong.
- **OnlyFans, YouTube, Twitch, Patreon, website** — no connector built. OnlyFans has no public API;
  YouTube/Twitch would each be a new OAuth integration (registered app + client + secret + callback).
  These are ledger/planning records only, not click-to-connect.

## Next actions

1. **X (chriscodyak):** on x.com → Settings → Security and account access → Apps and sessions →
   revoke the AliaSpaces app; then in the app: Account & settings → Accounts → the chriscodyak X row →
   confirm revocation and reconnect. (Owner action — the revoke happens on X's site.)
2. **Reddit:** pull `reddit-oauth` (DRIFT.md) → then wire `connectReddit` + a Connect button in
   `index.html` mirroring the Gmail/X connect pattern → verify the OAuth round-trip.
3. **Meta — Traditional Family Values:** attempt pairing (not a cannabis brand; may succeed).
   **CannaCandidz + Sherlock Chomes:** blocked by Meta content policy — plan manual/own-platform.
4. **OnlyFans / YouTube / Twitch:** roadmap builds if wanted (new integrations, not quick connects).

## Note on driving from here

The Account & settings view renders blank in automated screenshots (client-render timing), so the
per-account Connect/reset controls can't be driven blind safely on the live production account. The
X reset and Meta pairing are best done on-screen with live guidance; the Reddit wiring is a code task.
