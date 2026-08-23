# Overview and Persona view

Status: **implemented and tested locally; migration 058, Pages assets, and live behavior
are not deployed or verified live.** This feature deliberately fails closed when the
matching database projection is missing.

## Product behavior

Signed-in owners get an account-scoped `Overview / Persona` switch. Overview retains the
owner command center and management tools. Persona view freezes one exact owned persona
as the acting identity and replaces the owner roster with:

- an always-visible `Acting persona` identity;
- that persona's friends, incoming and outgoing requests, reviewed public family cards,
  followers, and outgoing follows (actionable requests are prioritized within a bounded
  200-card response);
- a cursor-paginated circle feed;
- a safe peer-profile surface that renders the page's reviewed layout, modules, widgets,
  albums, relationship cards, links, revenue rail, and paginated feed; and
- comments, reactions, follows, and friend actions attributed only to that actor.

The selector is stored under UID-scoped browser keys. It is convenience state, never an
authorization claim. Logout, account change, stale session, invalid/deleted actor, or
roster reload invalidates the active perspective. A route opened while acting does not
silently replace the actor with the page target.

Outward actions require a current reviewed public or unlisted page. A current reviewed
private actor can manage existing follows, friendships, and requests but cannot create
new public-facing interactions. Draft, revision-drifted, or dependency-stale actors
cannot create new activity; exact-actor safety cleanup such as deleting an earlier
comment remains available. Main and Backup personas are independent actors; the private
Backup pairing does not merge social graphs or grant visibility.

## Security boundary

Do not replace migration 058 with direct signed-in table reads. Existing owner RLS is
intentionally account-wide and is appropriate for Overview, but it is too broad for a
persona perspective. In particular, owner access or a sibling persona's friendship must
not reveal a private target to the acting persona.

Migration 058 supplies:

- `my_persona_mode_status(actor)`: server-authoritative publication capabilities;
- `persona_mode_can_view(actor,target)`: exact-actor visibility without calling the
  account-wide `persona_visible()` helper;
- `my_persona_mode_connections(actor)`: bounded friend/request/family/follow cards with
  action-only redaction for private pending counterparts;
- `my_persona_mode_feed(actor,cursor,limit)`: stable descending cursor pagination;
- `my_persona_mode_profile_posts(actor,target,cursor,kind,search,limit)`: bounded exact
  profile feed pagination and search;
- `my_persona_mode_profile(actor,handle,limit)`: one actor-scoped peer snapshot;
- `my_persona_mode_post_panel(actor,post)`: actor-filtered and bounded comments and
  reactions; and
- exact-actor mutation wrappers for follow, unfollow, request/respond/cancel/remove
  friendship, comments, and reactions.

Mutation wrappers acquire predecessor-compatible account quota locks, then one sorted
publication-lock set for the actor, target, and reviewed dependencies before rechecking
authorization. This prevents publication, dependency, block, mute, and exact-private-
friendship changes from racing an action. The internal actor-capability, visibility, and
lock helpers remain ungranted.

The client captures account, auth-generation, perspective-generation, mode, and actor
before asynchronous social work. It revalidates after every await and ignores stale
completions. Invite proofs remain prompt-local and are never written to storage, routes,
logs, copied URLs, or perspective state.

Blocking and muting remain account-wide by design. The UI labels them “for all my
personas”; they are not represented as actions by only the selected actor. Fan live
takeover also remains labeled `Owner` and is not impersonation.

## Page-look previews

The persona editor now renders Profile image, Banner, Page background, and Feed header as
real `<img>` elements with `object-fit: contain`. The whole source image remains visible
inside a bounded scrollable preview instead of being cropped by `background-size: cover`.
Saved-persona images keep the owner-only full-preview and bounded `Save a copy` path.

## Release order

1. Prove the target has the complete predecessor chain through migration 057.
2. Review and apply `supabase/migrations/20260823000000_persona_view_mode.sql` in staging.
3. Run database assertions for foreign actor denial, exact-private-friend access,
   sibling non-inheritance, block/mute exclusion, cursor stability, actor publication
   gates, and request-target binding.
4. Read back all fifteen granted authenticated RPC signatures and confirm the four
   internal helpers remain ungranted.
5. Publish `persona-view.js`, `persona-view.css`, the updated page, and governance script
   only after the database checks pass.
6. Smoke-test desktop and 390px mobile as two owned personas, including opening one owned
   sibling while acting as the other, switching during an awaited preflight, session
   expiry, and a missing/deleted actor.

Do not apply linked SQL, deploy Pages, or enable social writes from this document alone.
Those remain owner-approved release operations under the manual `MIGRATIONS-VERIFIED`
workflows.

## Local verification

Run:

```powershell
& 'C:\Users\Justice Right\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --experimental-strip-types --test tests/persona-view-mode.test.mjs
```

Then run the complete Node suite and the existing Edge Function checks. A passing static
suite proves repository behavior and packaging, not that migration 058 is applied or the
site is live.

Run the disposable PostgreSQL 16 apply/reapply, redaction, exact-actor, RLS, anon, and
authenticated-role assertions with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-persona-view-sql.ps1
```
