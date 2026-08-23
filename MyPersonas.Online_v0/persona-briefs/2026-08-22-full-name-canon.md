# Castleborn persona full-name canon — 2026-08-22

**Authority:** direct owner decision, recorded August 22, 2026. This decision supersedes
older surname proposals for the people listed here. It changes display-name canon only;
it does not change handles, biographies, visibility, account ownership, or publishing
authorization.

| Given name | Canonical full name | Current MyPersonas handle | Database action |
|---|---|---|---|
| Rohan | Rohan Dev | `castleborn.rohan` | Rename existing row |
| Maria | Maria Luna Garcia | `castleborn.maria` | Rename existing row |
| Alexei | Alexei Grigoriev | `castleborn.alexei` | Already current |
| Cillian | Cillian O'Sullivan | `castleborn.cillian` | Rename existing row |
| Akiko | Akiko Sasaki | `castleborn.akiko` | Rename existing row |
| Yarra | Yarra Warruwi | `castleborn.yarra` | Rename existing row |
| Sophia | Sophia Ona | `castleborn.sophia` | Rename existing row |
| Kunuk | Kunuk Atiq | `castleborn.kunuk` | Rename existing row |
| Avi | Avi Dev | `castleborn.avi` | Rename existing row |
| Lilly | Lilly Dev | `castleborn.lilly` | Rename existing row |
| Brom | Brom Grigoriev | `castleborn.brom` | Rename existing row |
| Zara | Zara Grigoriev | `castleborn.zara` | Rename existing row |
| Song | Song O'Sasaki | `castleborn.song` | Rename existing row |
| Rhythm | Rhythm O'Sasaki | `castleborn.rhythm` | Rename existing row |
| Lyric | Lyric O'Sasaki | `castleborn.lyric` | Rename existing row |
| Adam | Adam Atiq | `castleborn.adam` | Rename existing row |
| Abel | Abel Atiq | — | Canon only; no persona row exists |
| Fenrir | Fenrir Ona-Right | `castleborn.fenrir` | Rename existing row |
| Hecatia | Hecatia Ona-Right | `castleborn.hecatia` | Rename existing row |
| Adeola | Adeola Dossou | `castleborn.adeola` | Rename existing unlisted row |

## Family naming decisions

- Akiko Sasaki and Cillian O'Sullivan combined their surnames for their children.
  The canonical combined surname is **O'Sasaki** for Song, Rhythm, and Lyric.
- Sophia Ona gave her children with the Founder both surnames. The canonical combined
  surname is **Ona-Right** for Fenrir and Hecatia.
- Kunuk Atiq and his children Adam and Abel use **Atiq**.
- Avi and Lilly use **Dev**; Brom and Zara use **Grigoriev**.
- Enki appears in older family records, but the owner did not assign Enki a surname in
  this decision. Do not infer one from the Atiq family entries.

## Implementation boundary

The database migration updates the `public.personas.name` display field by exact immutable
handle. It deliberately does not create Abel's missing persona, alter any handle or URL,
change profile visibility, rewrite first-name conversational prose, or publish content.
The machine-readable companion is
`content/persona-full-name-canon-2026-08-22.json`.
