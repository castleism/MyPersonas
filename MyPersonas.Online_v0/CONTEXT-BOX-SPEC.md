# Per-persona Context Box — spec

_Owner request (2026-08-10): "context boxes for each persona that get updated with
every change on mypersonas.online, or can be manually updated by the user in a text
box. This documents the persona's path along the brand's roadmap and so it can build
follow-up content."_

## What exists already (don't duplicate)

- `persona_content_plans` — a strategy record per persona (primary_goal, content_pillars,
  current_campaign, calls_to_action, source_notes, platform_guidance, …). Already folded
  into the AI system prompt as a "content direction" block (ai-proxy `personaSystemPrompt`).
- `personas` **private notes** (`eNotes` textarea) — owner-only, **not** sent to the AI.

The context box is the missing middle: a **running, dated journal of the persona's
brand journey that DOES feed the AI**. Distinct from private notes (never AI-visible)
and from content plans (structured strategy, not a timeline).

## Data (migration 030 — done, file ready to apply)

`personas.context_log text` — an append-mostly, owner-editable log, capped 20,000 chars.

## Behaviour

1. **Manual edit.** A textarea in the persona Edit form ("Roadmap context — the AI reads
   this to build follow-ups"), saved with the persona. Owner can freely edit/curate.
2. **Auto-append on change.** When a persona is saved or a meaningful event occurs,
   prepend a dated one-liner to `context_log`:
   ```
   [2026-08-10] tagline + focus updated; launched cannabis podcast angle
   [2026-08-08] connected Facebook Page + IG; first 10 launch drafts generated
   ```
   Events to hook (v1): persona field save (summarise which fields changed), content
   plan update, connector connect/disconnect, a publish/draft milestone. Keep entries
   short; newest on top; trim oldest past the cap.
3. **Feeds follow-up content.** ai-proxy folds a **bounded recent slice** (e.g. newest
   ~1,500 chars / last ~10 entries) of `context_log` into `personaSystemPrompt` under a
   "Recent brand journey (for continuity)" heading — so generations reference where the
   persona has been and build the next beat, not restart cold. Bounded so it never
   threatens the prompt budget (owner chat input cap is 48k chars / 36 msgs).

## Implementation checklist (coordinated — ship together)

- [x] `030-persona-context-log.sql` (add column) — apply first.
- [x] index.html (code complete locally): `eContext` is in `renderEdit`; manual replacement
      and `appendContextLog(persona, summary)` use authenticated `ai-proxy` actions with an
      optimistic compare-and-set, so a concurrent edit is rejected instead of overwritten.
      Persona saves prepend a concise dated list of changed fields; saved chat takeaways use
      the same append path. Deploy `ai-proxy` before the matching Pages build.
- [x] ai-proxy (code complete locally): selects `context_log`, folds only the newest 10
      non-empty lines / 1,500 characters into `personaSystemPrompt`, and labels the block as
      continuity reference that cannot override hard rules. (Edge Function deploy required.)
- [~] Other event hooks: persona saves, distilled chat milestones, and successful content-plan
      saves are wired. Content-plan entries list only the names of fields that actually changed,
      never their values or raw source notes; a context conflict never rolls back the plan save.
      Connector changes and verified publish milestones remain follow-on hooks; they must call
      the same conflict-safe append action and must not claim unverified work.
- [ ] (optional) fan-chat: same inclusion if fan replies should reflect the journey.

## Chat-workspace safety now implemented locally

- Owner-scoped list/create/rename/pin/resume UI uses migration 031 and stores workspace IDs
  on new `agent_messages` rows.
- **Save to context** sends at most 12 recent messages / 4,800 characters to the selected
  owner model for distillation, lets the owner review/edit the takeaway, then persists only
  that approved short summary in `context_log`.
- **Attach context** accepts at most three owned workspaces, distills the same bounded recent
  slice, and sends only their summaries (2,400 characters total server-side) to later calls.
  Raw workspace history is never copied into `context_log` or replayed as attached context.
- Attached summaries and the context log are reference material, never higher-priority
  instructions. Existing hard rules, pause controls, binding checks, and L0 co-writer limits
  still apply.

## Ties into the "personas = personalized AI news feed" vision (2026-08-10)

The owner's phone-app direction — the AI researches each persona's assigned interests,
fact-checks, cites sources, and serves tailored blurbs instead of mindless scroll — uses
the context box as the per-persona memory/spine: the log records what each persona has
covered so the feed builds continuity and avoids repeats, and (later) multiple personas
assigned to a "project" share/reference each other's logs. See V2-BLUEPRINT.md.
