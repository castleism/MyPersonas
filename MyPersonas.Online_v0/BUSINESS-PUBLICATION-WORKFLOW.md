# Reviewed business publication workflow

**Status:** Implemented and tested locally; not pushed, applied to the linked database,
deployed, configured, activated, or verified live unless separately evidenced. Migration
052 and its UI are part of the ordered package in `RELEASE-MANIFEST-2026-08-22.md`.

Migration `052-reviewed-business-publication.sql` closes the intentional business-page
publication gap left by migration 051. Existing business rows are normalized once to
owner-only drafts when the new revision column is first added. Nothing in the migration
publishes a page automatically.

## Owner flow

1. Save the business profile, mission pieces, and persona memberships as a private draft.
2. State the page intention and run the exact review. Submit requires AAL2.
3. Resolve every required check. The review manifest contains the bounded deterministic
   public profile target, mission text and visibility, membership role/title visibility,
   and the exact current public persona-card projection.
4. Choose **Publish reviewed revision** in a separate AAL2-gated action.
5. Use the AAL2-gated unpublish action to return the page to an owner-only draft.

A ready review is evidence, not publication. A profile, mission-item, or membership edit
increments the business revision, clears the public lifecycle fields, and marks the prior
review stale. Editing a currently published page also requires AAL2 because the edit takes
that page offline.

## Public and authority boundaries

- `business_page_by_slug` returns a row only when the published revision, published review,
  and current manifest are identical.
- Public mission items require `enabled=true` and `visibility='public'`.
- Public memberships require `enabled=true`, `membership_visibility='public'`, and a persona
  whose own page is exact-current, public, and visible. A changed or unpublished persona-card
  dependency fails the entire business page closed until the owner reviews it again.
- `title_visibility='public'` controls whether the optional title is projected. A title such
  as “Spokesperson” or a membership role such as “manager” is presentation metadata only. It
  grants no account, staff, provider, database, or authentication authority.
- Browser roles keep SELECT-only owner RLS on the underlying business tables. Mutations use
  same-owner, transaction-locked SECURITY DEFINER RPCs. Direct service-role DML is also
  revoked to prevent a row-lock/advisory-lock inversion; a future worker must use a reviewed,
  lock-first service wrapper. The older general writers that could publish directly remain
  revoked.
- The owner screen distinguishes a stored `published` value from an exact-current public
  page. Persona-card or manifest drift is labeled public-gate-offline and never offers a
  misleading public-page link.
- The optional browser-AI packet contains only the public-intended profile, public mission
  pieces, eligible public persona names/handles/titles, and the owner-entered intention. It
  excludes nonpublic rows, persona UUIDs, asset URLs, and private review notes, and asks the
  owner to inspect it before sharing.

## Bounds

An account can create at most 100 businesses. Each business accepts at most 100 mission
items, 200 persona memberships, and a 250,000-byte serialized review manifest. Creation is
serialized and every count probe stops at the first over-limit row. An oversized manifest is
marked incomplete and cannot publish.
Private owner identity, private review notes, authentication roles, and provider credentials
are deliberately absent from the manifest and public projection.

## Release order and verification

1. Prove the target baseline and apply the exact release manifest through migration 051.
2. Apply canonical 052 or its byte-identical timestamped mirror
   `20260822180000_reviewed_business_publication.sql`—never both as separate logical
   changes—and record the final frozen hash.
3. Verify owner RLS, anonymous fail-closed reads, AAL1 rejection, AAL2 submit/publish/unpublish,
   edit invalidation, dependency drift, and apply/reapply behavior in disposable PostgreSQL 16.
4. Deploy matching functions after database readback, then deploy the frontend only after
   signed-in staging verification. Repeat the public and owner flows live.

No production SQL, deployment, role grant, provider action, or public page change is performed
by the repository source alone.
