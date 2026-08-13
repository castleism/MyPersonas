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
- [ ] index.html: add `eContext` textarea to `renderEdit`; include `context_log` in the
      `savePersona` payload; add `appendContextLog(persona, summary)` and call it on save
      with a diff summary. (Ships on the next Pages push — do AFTER 030 is applied, or the
      save payload references a missing column.)
- [ ] ai-proxy: select `context_log` in `loadPersonaContext` and add the bounded slice to
      `personaSystemPrompt`. (Edge Function deploy.)
- [ ] (optional) fan-chat: same inclusion if fan replies should reflect the journey.

## Ties into the "personas = personalized AI news feed" vision (2026-08-10)

The owner's phone-app direction — the AI researches each persona's assigned interests,
fact-checks, cites sources, and serves tailored blurbs instead of mindless scroll — uses
the context box as the per-persona memory/spine: the log records what each persona has
covered so the feed builds continuity and avoids repeats, and (later) multiple personas
assigned to a "project" share/reference each other's logs. See V2-BLUEPRINT.md.
