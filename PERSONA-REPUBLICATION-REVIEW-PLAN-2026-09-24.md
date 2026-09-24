# Persona republication review plan — 2026-09-24

**Status:** owner-review preparation only. This file does not contain a current
production export, approve a persona, authorize publication, or change a public
association.

## Coverage correction

The portfolio file `PROFILE-REPUBLICATION-REVIEW.csv` has 17 property rows but
only 16 unique persona handles because Sophia is correctly associated with two
different properties. It is a website-association queue, not a complete
27-person republication roster.

The source-backed missing 11 public-persona rows are:

| Persona | Canonical handle |
|---|---|
| Chomes / Classwoods Case Files | `chomes` |
| Chomie | `chomie` |
| Chris Cody / Useful Work + Style | `chris.cody.ak` |
| Christian Cody | `christiancodyak` |
| Kunuk Atiq | `castleborn.kunuk` |
| Lyric O'Sasaki | `castleborn.lyric` |
| Rhythm O'Sasaki | `castleborn.rhythm` |
| Rohan Dev | `castleborn.rohan` |
| Sherlock | `sherlock` |
| Sherlock Chomes | `sherlock.chomes` |
| Watson / Dispensary Goods | `watson` |

Adeola Dossou was the 28th persona but was unlisted, not visibility-public, so
she is outside this 27-person batch. No verified live persona row was found for
Abel. Enki's surname remains unresolved. Neither should be invented or silently
added.

`PERSONA-REPUBLICATION-REVIEW-INDEX-2026-09-24.csv` provides the complete
27-person index with `publish_authorized=false` for every row. It is a coverage
index only; all exact fields and hashes remain blocked on the fresh manifest.

This roster evidence is historical. A fresh server-authored sanitized manifest
is required before any exact approval because fields, links, assets, revisions,
and publication state may have changed.

## Packet structure

Generate one parent review packet per unique persona with these linked sections:

1. `batch_index`: handle/name, visibility, publication state, current and
   proposed revision, manifest schema/hash, readiness, unknown count, and owner
   decision.
2. `site_associations`: zero or more sites, relationship/business title, current
   and desired link, routing state, identity conflicts, and independent decision.
   Sophia's two website rows belong here, not as duplicate persona approvals.
3. `profile_fields`: current and proposed values for every public field plus
   visibility and preserve/change/hide/clear/reject decisions.
4. `destination_links`: every existing/proposed URL and handle, provider binding,
   access/recovery/2FA evidence, scope/expiry, policy gate, and decision.
5. `media_assets`: asset id, slot, provenance/content hashes, AI declaration,
   watermark state/version/hash, rights/likeness consent, alt text, and opaque-
   delivery/correlation state.
6. `page_surface_inventory`: layout hash, modules/widgets, posts, albums, family,
   Top 8, linked personas, business roles, custom fields, affiliate offers, and
   review-request configuration.
7. `dependencies`: family, Top 8, linked-persona, and business dependencies with
   revision/projection hash, publication state, and owner decision.
8. `revenue_and_review`: affiliate disclosures/offers, request-review destination,
   merchant/legal/rights state, and separate decisions. Review is not a money or
   publication action.
9. `automation_publication_safety`: safe booleans and configuration hashes for
   purpose, voice, audience, rules, backend, fan chat, and provider restrictions;
   never credentials or private prompts.
10. `readiness_and_unknowns`: `ok`, `unknown`, or `blocked`, evidence timestamp,
    exact missing input, responsible party if assigned, and smallest action.
11. `final_approval_receipt`: exact revision, manifest SHA-256, AI-provenance
    version/hash, AAL2 evidence reference, reviewer, timestamp, and all-child-
    decisions-complete. `publish_authorized` defaults to false.

## Mandatory reconciliation before approval

- Account for every current destination link. Historical evidence found 25
  `persona_links` rows, but the existing website queue explains only 20 links
  across seven personas. A fresh export must identify the omitted persona and
  five exact URLs; do not guess.
- Include current avatar, banner, background, layout, modules, posts, albums,
  family, Top 8, linked personas, business roles, affiliate settings, and
  request-review settings for every persona.
- Require rights, likeness consent, AI-use declaration, watermark compliance,
  alt text, and external-media immutability evidence.
- Require opaque asset delivery before public rich media exposes stable owner
  UUIDs or storage paths.
- Keep provider role, recovery, MFA, authorization scope, and expiry separate
  from a displayed account handle.
- Preserve explicit cannabis/provider policy gates for Chomes, Sherlock,
  Sherlock Chomes, and Watson. Do not infer that one brand variant's permission
  applies to another.

## Safe owner workflow

1. Generate a fresh read-only sanitized manifest for all 27 unique public
   personas.
2. Reconcile the 16 existing website-associated personas plus the 11 missing
   personas into one batch index.
3. Resolve every unknown and child decision without changing live data.
4. Lock the exact packet hash and review each persona under AAL2.
5. Record approval of an exact revision only. Do not publish from packet review.
6. Request a separate action-time publication confirmation per persona, then
   publish once and read back the exact public projection.
