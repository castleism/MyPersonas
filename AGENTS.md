# Agent contract — MyPersonas / Personas mobile

This checkout is the canonical **MyPersonas** platform (`castleism/MyPersonas`).
Phone-test prototypes that live on the owner desktop are **not** here. Do not
claim access to them. No attachment transfer should be assumed.

## First mobile milestone

Improve the **actual** owner command center:

1. Persona selection (owned roster / backup groups only)
2. Private four-channel draft creation
3. Review and approval through the existing exact-preview gate

Do **not** replace the platform with a local fake social publisher.

## Invariants

- `publishing_enabled` is permanently `false`.
- Exact persona ownership and exact provider/account binding are required.
- Approval is a planning record. It is not a provider send.
- No OAuth scope changes, production secrets, real social posts, or paid services.
- Public offline/PWA shell must not cache owner workflow code or private data.
- Android debug WebView wraps `#/owner`. Disconnected it only shows limitations.

## Source of truth

- Workflow helpers: `MyPersonas.Online_v0/mobile-owner-workflow.js`
- Owner UI: `MyPersonas.Online_v0/owner-app.js`
- RPC: `MyPersonas.Online_v0/sql-updates/077-mobile-private-draft-workflow.sql`
- Android path: `apps/personas-android/README.md`
- Product roadmap: `MyPersonas.Online_v0/ROADMAP.md` and `MOBILE-BLUEPRINT.md`

Existing architecture, approved content, and connector publishing gates stay in
place. Do not merge, deploy, publish to stores, or apply production migrations
from this milestone.
