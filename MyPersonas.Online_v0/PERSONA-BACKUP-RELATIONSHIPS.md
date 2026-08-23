# Persona backup relationships

**Status (2026-08-22):** implemented and statically tested in the local repository.
Migration 048 has **not** been applied to production, and the matching page has **not**
been deployed or verified live.

## Product contract

An owner can attach one owned persona as another owned persona's **Backup**. The main
persona remains a top-level item in the private owner rail. Selecting the main toggles an
indented Backup child directly beneath it; the disclosure button can toggle without
navigating. Selecting the child opens that persona normally.

The mobile owner shell uses its existing native persona picker because the left rail is
hidden at phone widths. It lists the main first and then labels the child
`Backup for Main — Backup`. Backup status does not alter either persona's page,
visibility, AI model, account assignments, automation, or selected companion identity.

This is private roster organization, not a public social link. The existing **Linked
personas** control remains the only explicit opt-in mechanism for showing “More of me” on
a public page.

## Data and security model

Migration `048-persona-backup-relationships.sql` creates
`public.persona_backup_relationships` with these invariants:

- `main_persona_id` is the primary key: one backup per main.
- `backup_persona_id` is unique: one main per backup.
- Composite foreign keys require both personas to have the same `owner` and use
  `ON DELETE CASCADE` only on the relationship row.
- Main and backup cannot be equal.
- A serialized validation trigger prohibits any persona from occupying both roles or
  joining another pair. Relationships are intentionally one level deep, so chains,
  loops, and ambiguous nesting cannot exist.
- Row-level security permits an authenticated owner to read only their own relationship
  rows. Browser insert, update, and delete privileges are revoked.
- `set_persona_backup(main_uuid, backup_uuid|null)` is the only authenticated write
  surface. It derives the owner from `auth.uid()`, locks that owner's profile row before
  mutation, revalidates both owned endpoints, and treats `null` as detach.
- Public persona discovery, public page RPCs, and public persona column grants do not
  include this table.

The editor filters unavailable choices for usability, but database constraints and the
RPC are authoritative. If the migration cannot be loaded, the owner rail fails flat:
every persona stays visible, and the editor disables relationship changes with a setup
message.

## Save, export, restore, and deletion

The persona Save action persists the core persona bundle first and then the relationship
through the authenticated RPC. A relationship failure is reported as a partial-save
warning and is never presented as fully saved. The app reloads and compares the saved
relationship before claiming success.

Both JSON export paths include `persona_backup_relationships`. The account-backup JSON
format is version 2. Roster CSV and the Personas worksheet include a human-readable
`Backup Persona` column; XLSX also contains a relationship sheet. The adjacent legacy
backup defect was fixed by declaring and loading `account_persona_links` before export.
An export is stopped rather than silently omitting relationship data when either private
relationship dataset cannot be loaded.

Restore remains compatible with version-1 files. For version 2, it creates personas first,
maps each source persona UUID to the new owned UUID, and then calls the setter for a pair
only when both endpoints were newly restored. It never imports a source owner UUID or
blindly reuses persona UUIDs. Missing, duplicate, self, or role-conflicting pairs are
skipped and counted.

Deleting either persona removes only the relationship; the other persona remains and
returns to the top level. Full content/account erasure already deletes personas, so both
composite cascades remove relationship rows without a new Edge Function permission.

## Deployment order

1. Preserve the existing database and migration-history backup.
2. Review the two identical migration files:
   `sql-updates/048-persona-backup-relationships.sql` and
   `../supabase/migrations/20260822130000_persona_backup_relationships.sql`.
3. Run the linked migration dry-run. Do not fabricate a history row for the manually
   executed full-name migration; follow `../supabase/DEPLOY.md`.
4. Apply and verify migration 048 before deploying the page. There is no backfill.
5. Verify owner A can attach/detach two personas, another owner cannot read the row,
   anonymous reads fail, direct authenticated DML fails, and deleting either endpoint
   preserves the other persona.
6. Deploy the page and versioned `owner-app.js`, then test desktop rail, phone picker,
   editor removal/reassignment, JSON/CSV/XLSX export, restore to a non-production test
   account, and content erasure.

Rollback is UI-first: restore the prior page so no client calls the RPC. Keep the private
table in place unless the owner explicitly approves destructive database rollback after a
verified export. Dropping the table destroys relationship choices even though it does not
delete personas.

## Follow-up options

- Add a mobile persona-roster bottom sheet if native picker labels are not enough; keep
  the native selector as the accessible fallback.
- Add owner activity events for assignment changes if organizational relationship audit
  history becomes necessary.
- Keep public follower funneling as a separate opt-in. Never infer or publish a public
  relationship merely because a persona is marked Backup.

