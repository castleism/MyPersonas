# Castleborn relationships, project, and business foundation

Status: **Implemented and tested locally; not pushed, applied to the linked database,
deployed, configured, activated, or verified live unless separately evidenced.** This
surface spans migration 049's data foundation, migration 051's publication/privacy and
export/restore governance, and migration 052's reviewed business publication. Follow the
order in `RELEASE-MANIFEST-2026-08-22.md`.

## Authority and open canon

- Relationship source: the owner-maintained
  `C:\Users\Justice Right\OneDrive\CREATE\ChatGPT\Castleborn\01-Canon-and-Books\Characters\PARENT-LINEAGE-BIBLE-2026-07-19.md`,
  updated August 22, 2026. It is authoritative for the seeded edges but labels
  the wider relationship graph as a working bible.
- Name and row boundary: `persona-briefs/2026-08-22-full-name-canon.md`, its
  machine-readable JSON companion, and
  `supabase/snippets/verify_persona_full_name_canon.sql`.
- The persistent `source_key` is
  `castleborn-parent-lineage-2026-08-22`. Relationship facts remain `working`
  and owner-only until the owner separately confirms and publishes them.
- No authoritative Castleborn business mission, persona business titles, or
  exact shared database resource was found. Those values remain blank or absent.

## What migration 049 adds

- Owner-private, normalized `parent_of` and `partner` edges. Child direction is
  inverted at read time and siblings are derived from shared parents, so inverse
  and sibling rows cannot drift apart.
- An owner-only project roster with `manager`, `member`, and `reviewer` labels.
  WAIS is seeded as the Castleborn project manager; this is organizational and
  AI-routing metadata, never an authentication, provider, or database privilege.
- Owner-only project-resource metadata. It accepts references and read-only
  connections but stores no password, API key, OAuth token, or database secret.
- Draft-first business profiles, mission components, persona memberships, and an
  optional presentation title such as `Spokesperson`. Presentation titles never
  grant access.
- Safe public projection functions. Only explicitly published/public business
  fields and explicitly public family edges between public personas are returned.
  `friends` and `followers` values remain fail-closed until those two social
  relationship types are represented separately in the data model.

The older `persona_groups` tables remain useful for visual grouping. Migration
049 hardens their missing `(group_id, owner)` relationship, but projects—not
groups—carry project roles and resource metadata.

## Follow-on governance and owner tools

- Migration 051 integrates family and business dependencies into persona revision review,
  adds the owner organization editor, and keeps private/project authority out of public
  projections. A family change can invalidate each affected published persona revision;
  it does not silently republish either endpoint.
- Migration 052 replaces direct business publication with an AAL2, exact-revision review,
  publish, and unpublish workflow. Mission or persona-title edits return the business to
  draft. A presentation title such as `Spokesperson` remains copy, never authorization.
- The local owner editor covers relationships, project membership/roles, resource metadata,
  business bios/missions/titles, and field visibility. WAIS's manager role does not give
  WAIS credentials or access to the referenced Castleborn database.
- Account export includes the family, group, project, resource, business, business-review,
  and publication-governance rows. UUID-remapped restore recreates owner data through
  bounded RPCs in private/draft/paused states; review evidence is export-only and restore
  never calls a publish or feature-submission RPC.

## Castleborn seed

The seed runs only when `@wais` exists. It then requires the complete same-owner
roster and refuses a partial write.

Parent edges:

- Rohan Dev and Maria Luna Garcia → Avi Dev.
- Rohan Dev and Sophia Ona → Lilly Dev.
- Adeola Dossou and Alexei Grigoriev → Brom Grigoriev and Zara Grigoriev.
- Cillian O'Sullivan and Akiko Sasaki → Song, Rhythm, and Lyric O'Sasaki.
- Kunuk Atiq and Yarra Warruwi → Adam Atiq.
- Justice Right / the Founder and Sophia Ona → Fenrir and Hecatia Ona-Right.

Explicit partner edges are Adeola/Alexei, Cillian/Akiko, Kunuk/Yarra, and
Justice/Sophia. Rohan/Maria and Rohan/Sophia are not converted into partner rows
merely because they share a child.

All seeded family data uses `canon_status=working` and
`visibility=owner_only`. The August 22 owner lock confirmed names; the lineage
bible describes the wider family graph as a working bible. No relationship is
silently published.

Abel Atiq is canon-only and has no MyPersonas row. Enki has no persona row or
resolved surname, and the current lineage note is internally inconsistent about
the half-sibling description. Neither is created or seeded.

The Castleborn project contains WAIS plus the 19 verified `castleborn.*` personas
and `@justiceright` (21 memberships total). The Castleborn business shell is blank,
owner-only, and `draft`. No business title, mission claim, or project resource is
invented.

## Security and release sequence

1. Apply and rollback-test migration 049 in a non-production Supabase branch.
2. Verify cross-owner relationship, project, business, group, and account-ledger
   references are rejected.
3. Verify direct authenticated table mutation is denied and bounded owner RPCs
   work only for the signed-in owner's rows.
4. Verify the exact seed counts: 20 parent edges, 4 partner edges, 21 Castleborn
   project memberships, one WAIS manager, and one blank draft business shell.
5. Confirm public projections return none of the seeded owner-private data.
6. Obtain the exact Castleborn database/provider, resource locator, allowed data
   scope, and server-side credential plan before adding a `project_resources` row.
7. Run signed-in owner/editor, keyboard, mobile, public/other-owner, export, and restore
   visual QA before deployment. Publishing a business page or family edge remains a
   separate explicit owner action.

Deletion cascades and the service erasure path remove family, membership, mission, and
project rows in owner-lock order. Release verification must prove deletion cannot race a
concurrent writer and that export/restore preserves private data without restoring any
published or approved authority.
