# Mac source checkout — 23 September 2026

All apps use branch `codex/mac-handoff-20260923`. Existing main branches are unchanged. Clone that branch explicitly; a plain clone of main can omit the mobile checkpoint.

| App/folder | Repository | App source |
|---|---|---|
| literally-even | https://github.com/castleism/Literally-Even/tree/codex/mac-handoff-20260923 | `.` |
| tea | https://github.com/castleism/being-tea-co/tree/codex/mac-handoff-20260923 | `mobile` |
| smile | https://github.com/castleism/SmileToYourBody/tree/codex/mac-handoff-20260923 | `mobile` |
| aware | https://github.com/castleism/AwareOfMyFood/tree/codex/mac-handoff-20260923 | `mobile` |
| noo | https://github.com/castleism/nooyouniverse/tree/codex/mac-handoff-20260923 | `mobile` |
| communication | https://github.com/castleism/JustRightSpeech/tree/codex/mac-handoff-20260923 | `app` |
| terraseeds | https://github.com/castleism/Terraseeds/tree/codex/mac-handoff-20260923 | `.` |
| personas | https://github.com/castleism/MyPersonas/tree/codex/mac-handoff-20260923 | `apps/personas-ios` |
| aliaspaces | https://github.com/castleism/aliaspaces.com/tree/codex/mac-handoff-20260923 | `apps/social-mobile` |
| wonder | https://github.com/castleism/Wonder-Notes/tree/codex/mac-handoff-20260923 | `.` |
| brick | https://github.com/castleism/Brick-by-Brick/tree/codex/mac-handoff-20260923 | `.` |
| cooked | https://github.com/castleism/AlwaysCookedJustRight/tree/codex/mac-handoff-20260923 | `apps/cooked-mobile` |

Start by cloning any listed handoff branch, then run its `bash mac-handoff/clone-on-mac.sh` to fetch all twelve into a fresh portfolio folder. GitHub authentication is required for private repositories. The script stops rather than replacing an existing destination. Give Gemini `mac-handoff/GEMINI-MAC-PROMPT.md`. Read `mac-handoff/README.md` for platform/toolchain notes.

APKs, local dependency/build caches, private phone backups and signing keys are deliberately excluded. Android APK verification was performed on Windows; iOS builds remain for the Mac.
