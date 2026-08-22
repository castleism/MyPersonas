# Owner mobile command center

_Local implementation contract, 2026-08-22. This document separates the installable
owner experience that is implemented in this checkout from native and desktop capabilities
that still require packaging, deployment, and device verification._

## Product shape

AliaSpaces is the public network and brand. MyPersonas remains the private owner control
plane behind it. The installed PWA opens into an owner-first command center while the
existing Matrix keeps the full administration surface.

The daily owner loop is deliberately small:

1. Pick a persona from one persistent selector.
2. Read and annotate sourced briefings.
3. Turn only selected evidence and owner guidance into a four-channel content kit.
4. Edit, approve, and place that exact kit on the manual schedule.
5. Open the relevant account portal or AI workroom and finish the task as the owner.
6. Review an activity trail of actions mediated by MyPersonas.

The four channel variants are X, Instagram, Facebook, and website. A scheduled content
kit is a planning commitment, not proof that any provider will publish it. Existing Meta
publishing remains behind the separate immutable-media approval path.

## Implemented in this checkout

- `#/owner`: mobile home with persona picker, voice card, owner chat, briefing, queue,
  account portal, AI route, and activity entry points.
- `#/briefs`: account-wide research queue with persona/status filters, short/study/full
  reading modes, source links, owner comments, text highlights, image references, topic
  approval/rejection, and brief-to-content-kit generation.
- `#/schedule`: four-channel content-kit review and manual scheduling, plus a truthful
  view of the legacy three-channel publishing queue.
- `#/activity`: combined MyPersonas-mediated activity timeline.
- `#/notifications`: account-wide in-app review queue. This is not push notification
  delivery and does not request browser notification permission.
- AI workroom handoff: builds a bounded prompt, copies it to the clipboard, and opens the
  selected model's official web interface. Cross-origin browser security means the owner
  performs the final paste. No passwords, cookies, or API keys enter the handoff payload.
- Migration 045: owner-only annotations, content packages/variants, notifications,
  activity events, approval invalidation, and manual schedule RPCs. Migration 046 adds
  fan-retention consent, content-free usage receipts, finite owner-live RPCs, and the
  required ephemeral cleanup job. Their CLI-tracked mirrors live under
  `supabase/migrations/` and must be applied before the matching Edge Functions and UI.

## Siloed browser boundary

A normal website cannot create durable per-account browser-cookie silos or paste a file
into another authenticated origin. The safe architecture is therefore two cooperating
clients:

- The mobile/PWA client selects persona, account, asset, prompt, and intent.
- A signed desktop Workroom Bridge opens an Electron persistent partition keyed by the
  local owner installation plus account ledger id. The partition contains that provider's
  authenticated browser session; MyPersonas never pre-fills or stores the password.
- The bridge copies owner-selected text or media to the operating-system clipboard and
  opens the provider. The owner performs the final paste or upload in the visible window.
- Every bridge launch may append a minimal activity receipt: persona, account ledger id,
  provider, intent, time, and outcome supplied by the owner. Page contents, keystrokes,
  cookies, and unrelated browsing are not captured.

This supports more separately authenticated account sessions without pretending to remove
provider account limits or platform rules. Unsupported providers remain manual-only.

## AI cost and context model

`persona_ai_model_routes` is the routing registry. Routes can be owner-wide or overridden
per persona for chat, research, short drafting, long synthesis, image prompting, and other
task types. The owner UI exposes the selected backend and bounded output/context guidance.
The secure proxy accepts a route key and resolves it server-side; credentials remain in
Vault and are not returned to the browser.

Cost control rules:

- Send source excerpts, selected highlights, and distilled workspace summaries rather than
  whole histories.
- Keep raw research evidence separate from persona-styled output.
- Use low-cost routes for bulk drafts and a stronger route only for long synthesis or
  independent review.
- Preserve visible input/output limits. A context-window estimate is owner metadata, not
  proof of a provider's current billing or model limit.
- Material edits invalidate approval. Changing model routes never retroactively changes an
  approved content package.

## Fan inbox, privacy, and live owner chat

The owner app includes a persona-filtered fan inbox. Every public chat begins with an
unavoidable warning that the human owner can see the conversation and that AI and human
replies are separately labeled.

Fans choose one retention mode before sending the first message:

- **Saved transcript:** remains in the private owner inbox until deletion.
- **Private session:** temporarily stored only so the AI and an optionally live owner can
  respond; deleted when the fan closes the window and automatically expires after 30
  minutes idle. It is not added to persona memory.

The privacy mode is immutable after the first message. A finite 5, 15, 30, or 60 minute
owner-live window pauses AI replies. The database refuses owner messages outside that
window and refuses takeover while an AI response lease is active. Owner replies use the
distinct `owner` role and render as **Owner** to both sides.

Private-session language must never claim that message bytes are never transmitted or
never temporarily stored. The honest promise is no retained transcript after a successful
close, with the idle-expiry job as the abandoned-tab backstop. Content-free quota and
safety receipts may remain briefly so deleting an ephemeral transcript cannot reset model
cost limits; they contain no message or reply text.

## Activity truth

The persona timeline covers activity that passes through MyPersonas or a future Workroom
Bridge receipt. It cannot truthfully claim to capture every action performed directly on
the wider internet. Provider ids and live read-back are still required before a post is
called published.

## Release gates

1. Review and apply migrations in order; confirm migration 044 state before 045 and 046.
2. Deploy the hardened research functions, route-aware `ai-proxy`, and matching `fan-chat`
   function before the Pages UI.
3. Verify owner isolation, fan retention/close/expiry/live-takeover races, annotation
   anchors, approval invalidation, and four-variant
   schedule behavior with two unrelated test accounts.
4. Push the Pages build only after CI is green; verify signed-in phone/tablet layouts,
   offline public shell behavior, and fresh private-data loading after reconnect.
5. Package/sign the Workroom Bridge separately. Test profile isolation, custom-protocol
   validation, logout/revocation, and local-data deletion before offering it as functional.
6. Design APNs/FCM or Web Push subscription, revocation, device, quiet-hours, and delivery
   semantics before calling account notifications push-enabled.
