# Meta App Review — enabling IG/FB posting

_The permissions that let the app publish to Instagram and Facebook Pages are
"advanced access" and must be approved by Meta App Review. This is the long pole
(days–weeks), so **start it first** — the code can be built in parallel but can't go
live until this clears._

## The path to live posting (order matters)

1. **Business verification** (Meta Business Manager → Security Center) — required
   before advanced access. Have the legal entity / docs ready.
2. **Add the app's use case + request the scopes** (below) in the App Dashboard.
3. **Record the screencasts** Meta requires (one per permission, showing a real
   user granting it and the app using it). Script below.
4. **Submit for review**; respond to any reviewer follow-ups.
5. Once approved: apply the `meta-oauth` scope change (below), deploy `meta-oauth`
   + the finished `meta-post`, run live smoke tests, then flip publishing on per
   account.

## Permissions to request + justification

| Permission | Why we need it | Notes |
|---|---|---|
| `pages_manage_posts` | Publish owner-approved posts to the creator's own Facebook Page | Advanced access |
| `instagram_content_publish` | Publish owner-approved posts to the linked professional Instagram account | Advanced access; IG must be Business/Creator linked to the Page |
| `business_management` | Access Pages/IG that live in the creator's Business portfolio (granular business-asset grants) | Advanced access |
| `pages_show_list`, `pages_read_engagement`, `instagram_basic` | (Already used) discover + read the Page/IG for pairing | Standard/already granted |

Framing for the reviewer (use-case text): _"Creators use AliaSpaces to manage many
persona brands. After connecting their own Facebook Page and linked Instagram
professional account, the creator (or their approved automation at explicit owner
approval) publishes content they authored to **their own** accounts. The app never
posts to accounts the user doesn't own, never posts without owner approval, and
requests no access to third-party or audience data."_

## meta-oauth scope change (apply only AFTER approval)

Keep the default connect read-only; add publishing as an **opt-in** so pre-approval
users are never blocked. In `supabase/functions/meta-oauth/index.ts`:

```ts
// existing — unchanged, read-only default
const REQUIRED_SCOPES = ["pages_show_list","pages_read_engagement","instagram_basic"] as const;

// NEW — requested only when the owner opts into publishing (post App Review)
const PUBLISH_SCOPES = ["pages_manage_posts","instagram_content_publish","business_management"] as const;

// in the "start" action, when body.requestPublishing === true:
//   scope: [...REQUIRED_SCOPES, ...PUBLISH_SCOPES].join(",")
// and derive capabilities.postingEnabled from whether the grant's granted_scopes
// include every PUBLISH_SCOPE (meta-post already enforces this at publish time).
```

This means: reviewers and you (as testers) can grant publishing immediately; the
general opt-in unlocks for everyone only once Meta approves. `meta-post` already
refuses to publish unless the grant carries all three publish scopes, so nothing can
post prematurely.

## Screencast script (per permission)

1. Sign in to AliaSpaces as a normal creator.
2. Connect Meta → in the Facebook dialog, **grant the publishing permissions**
   (show the exact permission on screen).
3. In the app, compose a post for the creator's **own** Page/IG, approve it, publish.
4. Show the post appearing on the creator's Facebook Page and Instagram.
5. Show the disconnect/revoke path (Meta likes to see revocation).

## Content-policy reality check (before you invest here)

- The **cannabis personas cannot be monetized *or* freely published** via Meta —
  Instagram's Content Publishing API enforces the same restricted-goods rules
  (drugs/cannabis). Plan those brands for owner-approved manual handoff or your own
  platform, not automated Meta posting. (See the monetization note in chat.)
- Rate limits when live: IG content publishing ≈ 25 posts / 24h per account; build the
  publish queue to respect that.

## Status

- [x] `meta-post` scaffold in repo (gated OFF until scopes present) — `supabase/functions/meta-post/`
- [ ] Business verification (owner)
- [ ] App Review submission (owner, using the above)
- [ ] meta-oauth PUBLISH_SCOPES opt-in (apply after approval)
- [ ] Finish `meta-post` token retrieval + queue wiring + live tests
