# Project resource metadata editor

Status: **migration 067 and its owner Settings interface are implemented and tested
locally only.** They are not pushed, applied, deployed, connected to an external
resource, or verified live. Production build `cbea6a1` still has the migration 049
data foundation but not this hardened editor.

## Purpose and boundary

The editor lets an owner attach private metadata to any project that contains the
selected persona. For example, WAIS can describe the reviewed Castleborn database,
repository, Drive folder, document library, or website shared as project context.

The record is not a connection. It never fetches a URL, opens a database, reads a
Drive folder, tests OAuth, grants a persona permission, or stores a password, API
key, cookie, token, private key, database URI, or provider secret. A `manager` label
remains presentation/orchestration metadata and does not become an authentication
principal.

## Owner flow

Persona Settings → Family, projects, groups, and businesses → Project resource
editor shows resources from the selected persona's project memberships. The owner
can create, edit, or delete:

- project and resource type;
- display name;
- credential-free HTTPS locator without query or fragment;
- optional active owner Account Ledger binding;
- `reference` or proposed `read_only` access intent;
- `not_configured`, `blocked`, `disabled`, or owner-reviewed `ready` state;
- enabled flag and private notes.

Ready metadata may remain disabled. Only a Ready record may be enabled, and Ready
requires a reviewed HTTPS locator. “Ready” describes owner-reviewed metadata, not
tested connectivity.

## Database contract

Migration 067 revokes migration 049's last-write-wins browser RPCs and replaces them
with `save_project_resource_v2(...)` and `delete_project_resource_v2(...)`:

- every mutation requires a signed-in owner at AAL2;
- an active owner-erasure lease blocks every write, using the same exact owner advisory
  lock as account/content erasure;
- each edit and delete requires the exact current `row_version`; stale tabs fail with a
  serialization conflict instead of overwriting or deleting a newer revision;
- direct browser and generic service-role table mutation remains denied; account erasure
  uses the separately reviewed lock-first service cleanup wrapper, and service role
  receives no project-resource mutation RPC grant;
- same-owner project and nonsuspended Account Ledger checks are server-side;
- resource type, access intent, state, lengths, controls, secret patterns, and URL
  structure are validated server-side;
- an existing resource cannot be moved between projects; delete and recreate it;
- existing owner/project/daily quotas and owner/project lock ordering are preserved;
- delete returns only true/false and cannot reveal or remove another owner's row;
- restore performs the AAL2 preflight before writing any backup row, uses a fresh fixed
  session token, restores only sanitized disconnected metadata, and never silently skips
  project resources after partially restoring the rest of the backup.

The browser separately applies HTTPS/credential checks, escapes every label and
link, withholds unsafe legacy locators from editable fields, uses
`rel="noopener noreferrer"`, snapshots account/persona/route/form/row version before
the MFA pause, discards stale completions, and makes no connectivity claim. A later
Account Ledger suspension makes the displayed resource unavailable even if its stored
metadata had been marked Ready.

## Verification and release

From the repository root:

```powershell
node --test tests/project-resource-editor.test.mjs
npm run test:project-resources-sql
node scripts/check-frontend-syntax.mjs
```

The PostgreSQL harness applies migration 067 twice and verifies AAL1 denial, AAL2
success, safe/unsafe locator cases, secret/control rejection, owner/project/account
isolation, active-erasure denial, suspended-ledger rejection, Ready/enabled rules,
immovable project membership, stale edit/delete rejection, version advancement, owner
deletion, old-RPC revocation, and exact new grants.

Apply and read back migration 067 before deploying its cache-busted
`platform-governance.js`. Live QA must cover two unrelated accounts and a project
with at least two persona members. Connecting a real database/provider is a later,
separately reviewed server-side OAuth/API project with least-privilege read scope,
credential rotation, audit, revocation, and erasure evidence.
