# Custom persona field boxes

Status: **migration 066 and its frontend are implemented and tested locally only.**
They are not pushed, applied to the linked Supabase project, deployed, or verified
with two unrelated signed-in accounts. Production build `cbea6a1` does not contain
this feature.

## Product contract

An owner can open a persona's Settings page and create up to 24 first-class field
boxes. A box is either escaped text or one credential-free HTTPS link. It may be
disabled or scoped to owner only, friends, followers, or public. Friends/followers
content is returned only when the request names one exact acting persona owned by
the current account; Overview and anonymous reads never infer an actor.

This surface is separate from the page designer's declarative custom widgets. The
new boxes supply audience visibility and publication-review binding; they currently
render as fixed half-width, soft cards after designer widgets. Arbitrary HTML, CSS,
JavaScript, SVG, iframes, and executable extensions remain prohibited.

## Data and RPCs

- `persona_custom_field_boxes` is RLS-enabled and has no browser-role table grants.
- `my_persona_custom_field_boxes(uuid)` returns at most 24 complete owner rows.
- `save_persona_custom_field_box(...)` creates or compare-and-swap updates one row.
- `delete_persona_custom_field_box(uuid,bigint)` deletes only the current row version.
- `persona_custom_field_boxes(uuid,uuid)` is the bounded audience projection used by
  public and exact Persona views.
- `persona_publication_review_manifest(uuid)` wraps migration 051's implementation
  without changing its OID and binds every enabled non-owner field to the exact
  review packet.

An enabled friends/followers/public field change increments the persona publication
revision and makes prior review stale. Owner-only and disabled drafts do not alter a
public revision. Account export includes the private rows; restore recreates them
only as disabled owner-only values. Content/account erasure deletes the rows while
holding the same owner/persona lock family used by page-builder data.

## Security bounds

- 24 rows per persona, 200 per account, 200 new rows per UTC day.
- 120-character title/link label, 3,000-character body, 2,048-character URL,
  and a 10,000-byte aggregate field limit.
- Credential-free HTTPS validator for links; no executable field type.
- RPC-only writes, same-owner persona foreign key, row-version CAS, bounded results,
  and session/route freshness checks in the browser.
- Public output contains no row id, owner id, timestamps, or row version.

## Verification and release

From the repository root:

```powershell
node --test tests/custom-persona-field-boxes.test.mjs tests/governance-export-restore.test.mjs
npm run test:custom-fields-sql
node scripts/check-frontend-syntax.mjs
```

The disposable PostgreSQL test applies migration 066 twice, then checks owner and
exact-actor isolation, CAS failure, quotas, public/friend/follower projection,
review invalidation/manifest binding, erasure, and grants.

Release database migration 066 before its cache-busted `index.html`,
`platform-governance.js`, and `persona-view.js`. Then verify owner create/edit/
disable/delete, anonymous public-only rendering, and two unrelated accounts acting
as follower, friend, and neither. Publication of any field remains a separate
owner review and persona publication action.
