# MyPersonas / AliaSpaces project boundary

**Owner direction:** maintain two separate repositories and products.

**Status:** approved product direction; extraction is in progress. This document
does not authorize a deployment, database migration, DNS change, provider
permission, publication, payment activation, or account change.

## MyPersonas owns

- External-provider credentials, token refresh, official-API publishing workers,
  scheduling, reconciliation, and provider audit receipts.
- AI provider routing, model selection, budgets, task runners, research briefs,
  private source libraries, and approval packages.
- Subscription and entitlement internals, Stripe webhook processing, refunds,
  duplicate-subscription remediation, trial-abuse controls, and developer status.
- Global-administrator and technician operations, incident response, retention,
  account export/deletion coordination, and the single production-migration
  authority during the split.

## AliaSpaces owns

- Persona and business page presentation, custom fields, widgets, layout, and
  image placement.
- Public discovery, persona search, feeds, posts, albums, comments, reactions,
  and first-party moderation presentation.
- Persona follows, friendship requests, blocks, mutes, family links, backups,
  projects, business roles, and persona-perspective interaction.
- Page publication review, social visibility, field visibility, attached social
  handle presentation, public affiliate offers, review-request forms, and the
  public social PWA identity.

## Shared contracts

Authentication/MFA, canonical account and persona identifiers, entitlements,
media ingest, provenance, audit events, and account export/deletion are shared
contracts. Each contract must be versioned, authenticated, owner-scoped, and
fail closed. Privileged implementations remain in MyPersonas; AliaSpaces should
consume narrow projections and operations rather than copying secrets or
automation logic.

No Edge Function or migration may have two deployment owners. Historical
migrations stay in the MyPersonas ledger until a separately reviewed handoff
assigns a new single authority.

## Transition rules

1. The live `mypersonas.online` v0 remains a transitional combined application;
   source location is not proof of permanent product ownership.
2. The live `aliaspaces.com` page remains a rollback-safe transition front door
   until a staging candidate passes signed-in mobile and two-account privacy
   testing.
3. Public media must use opaque asset identifiers before rich social widgets are
   cut over. Stable owner UUIDs, raw storage paths, and reusable private signed
   URLs must not appear in public responses.
4. Entitlement loss may unpublish social pages and pause automation, but restoring
   payment must never silently republish a page or restart external posting.
5. Deployment, production migration, DNS, provider authorization, publication,
   and money actions remain separate approval gates.
