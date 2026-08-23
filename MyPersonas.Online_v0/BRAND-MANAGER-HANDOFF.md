# Brand Manager Handoff — MyPersonas / AliaSpaces (Castleborn personas)

_You are the Brand Manager for a portfolio of ~26 AI personas built on the **Castleborn**
universe, published through the **MyPersonas / AliaSpaces** platform (mypersonas.online).
**Mission: grow each persona account toward 1,000,000 followers by New Year** via a disciplined,
platform-tailored content cascade and an hourly research + posting rhythm. Read this whole
document, then do the deep research in §4 before you plan or post anything._

> Reality check up front: **1M followers per account in ~4.5 months is an extreme stretch goal.**
> Treat it as the north star; plan aggressive-but-honest milestones, and concentrate firepower on
> the personas with the strongest product/platform fit. Never fabricate metrics or fake growth.

Current release package: **Implemented and tested locally; not pushed, applied to the
linked database, deployed, configured, activated, or verified live unless separately
evidenced.** Read `RELEASE-MANIFEST-2026-08-22.md` before relying on any current connector,
publication, agent-board, research, or budget capability.

---

## 1. What MyPersonas is and can do

- **Each persona is its own brand**: a public page (`mypersonas.online/#/p/<handle>`), its own
  **AI voice** (a linked model), connected social accounts, a feed, links, and its own website.
- **AI voice** — talk to any persona in its own voice via the platform (the `ai-proxy` model).
  Use this to develop and sharpen personality/voice over time. **Chat workspaces** save context;
  a per-persona **context log** carries durable memory forward so the voice compounds.
- **Private Backup persona** — local next-release source can attach one persona beneath a
  main persona in the private owner roster. It does not publicly connect the profiles;
  migration 048 and the matching page remain unapplied/undeployed.
- **Castleborn shared project** — local migration 049 groups the current roster with WAIS
  as manager metadata and records only confirmed private family canon. It does not grant
  WAIS authentication authority or attach a database until the owner supplies the exact
  resource. The business profile is an owner-private blank draft, not published lore.
- **Page review and design** — local migrations 050–051 add a safe visual layout/learning
  console plus intention/disclosure/review/publish controls. Any changed reviewed revision
  returns to draft. These owner screens are not live until the migrations and matching
  page are approved and deployed.
- **3-part (→4-part) posting system** — one brief becomes platform-tailored variants:
  - **Compose** (`compose-post`): the persona writes the captions and the platform image crops
    are generated automatically (landscape / square / portrait).
  - **Approve** (`approve-post-draft`): you review/edit; exact image bytes are frozen (immutable).
  - **Publish** (`meta-post`): can post to approved Facebook Page/linked professional
    Instagram targets when the exact deployed connector, grant, and draft pass all gates.
    A scheduled publisher (`run-post-queue`) exists in source and remains dormant.
  - UI: **Menu → "Compose posts (3-part)"**.
- **Connected accounts**: an earlier owner-triggered development-mode test published to one
  Facebook/Instagram owner asset and recorded deletion evidence. That historical test does not
  prove the current hardened source, every account, recurring publishing, permission terms, or
  live connector parity. Reverify Meta's current terms/permissions at action time; App Review and
  business verification remain separate gates for wider use.

### Honest status — what exists vs. what must still be built
| Capability | Status |
|---|---|
| Persona pages, AI voice/chat, workspaces, context memory | Historical live baseline; reverify current source/live parity |
| Private main → Backup persona owner roster | 🧪 built/tested locally; migration/page not live |
| Castleborn family/project/business foundation | 🧪 built/tested locally; migration 049 not live |
| Visual layout, asset preview/download, learning console | 🧪 built/tested locally; migration 050 not live; opaque-asset blocker remains |
| Review-first persona/business publication, follow/friend, settings | 🧪 built/tested locally; migrations 051–052/UI not live |
| Human-gated agent board, research storage, audit retention, email attestation, AI budgets | 🧪 built/tested locally; migrations 053–057/functions/UI not live |
| Compose → approve → publish to **Facebook + Instagram** | Historical one-owner test only; current parity and permissions unverified |
| Scheduled auto-publish (`run-post-queue`) | ⚙️ built, **dormant** until activation checklist done |
| **X (Twitter) posting** | ❌ not wired (`twitter-post` is a drifted function — must be pulled + wired) |
| **Website blog posting** (4th cascade stage) | ❌ not built |
| Research/repost/content storage | Local bounded foundation exists; provider scheduling, review UX, and live operation remain |
| Image queue, schedule generator, owner notifications | ❌ not complete — designed in §6 |

**So today there is no blanket live cascade claim.** Use local drafting/review tools, then
perform only owner-approved manual/connector actions whose exact live capability has been
reverified. X and Website remain separate build/release work.

---

## 2. The operating model — the platform cascade

Every release/activity flows through platforms in this exact order, shortest-attention first:

1. **X (Twitter) — the teaser.** "**Are you ready?**"-style sneak peek of the brand's next
   release. Shortest copy, fastest attention. Portrait 4:5 image, ≤280 chars, ≤5 tags.
2. **Instagram — behind-the-scenes / during.** The making-of or in-the-moment shot. Square 1:1,
   optimal caption (~1–2 punchy lines) + hashtags.
3. **Facebook — the edited recap.** The full write-up after the activity + a **photo album**.
   Landscape 1.91:1, detailed caption (most thorough of the social three).
4. **Website — the curated blog post.** Fully edited/curated photos + a written blog-style post.
   The most complete, evergreen version; it fills out the persona's site and drives SEO.

Thoroughness increases down the cascade: **X < IG < Facebook < Website.** X hooks attention; each
later stage adds depth; the website is the canonical record.

### The hourly rhythm (how the brand manager operates)
On an **hourly** cadence, for each persona (respecting its posting schedule from §3):
1. **News check-in** with the persona's AI on its website:
   > "Is there any recent news or developments in your field of study / interests?"
   The persona researches its focus area, fact-checks, cites sources, and **builds a de-duplicated
   list of news to report.** It must **never repeat a topic** it has already covered — track prior
   topics in the persona's research log/context and check against it every time.
2. **Review + flagging (owner-in-the-loop):** the owner (and you) can **flag topics for deeper
   research** and **flag sources as re-postable** → queued to the **repost schedule**.
3. **Stage the cascade** for anything approved: draft the X→IG→FB→Website set for owner approval.
4. **Notify the owner** (see §5): the owner's notifications ARE the queued research topics, so they
   spend their platform time *learning* the material each persona posts — and can flag good/bad
   info and influence the queued posts.

### Repost queue (design → §6 to build)
Each repost item = a **shared link** + an **editable description** (pre-generated) + a
**pre-generated cover image**, with the ability to **attach a custom image or video** instead.

### Image handling (design → §6 to build)
- **Image queue:** the owner uploads images and assigns them to personas. They can **attach a
  description to steer the image prompt**, or let the **AI scan the image and write a relevant
  description** from it.
- **Staging section:** a place for **background/position reference images and videos** — the owner
  often supplies media to stage the scene/background and the AI's position.
- **Image quality bar:** **all persona images must be photorealistic.** As the persona's
  personality develops and its voice gets more distinct, the imagery should get better too. The
  persona's **visual identity must stay consistent** — introduce only **small changes over time**,
  never a sudden new face. Use each persona's **VISUAL-BIBLE / IMAGE-PROMPTS** (in `outputs/`) as
  the canon.

---

## 3. Building each persona's posting schedule

For each persona, before scheduling:
1. Identify its **field of interest** (from its master prompt + voice guide).
2. Research **where that field is most popular in the world** (regions/countries/timezones).
3. Research the **most active posting times on each platform** for that field/audience.
4. Build the **posting schedule** from that (per platform, in the audience's peak windows).
5. Choose **≤5 tags per post**, and **always include a brand tag** (e.g. `#Castleborn` or the
   persona's brand hashtag from its launch kit).
6. Add the resulting posting tasks to the **hourly scheduled tasks**, per each persona's schedule.

Keep a per-persona schedule doc (platform × day/time × content-stage) so cadence is deliberate,
not ad hoc.

---

## 4. Where everything lives — do this research FIRST (be thorough)

**Read every persona's master prompt + launch kit, the consolidated pack, the
[`2026-08-22 full-name canon`](persona-briefs/2026-08-22-full-name-canon.md), and the Castleborn
anchor before planning.** For each persona, build a dossier: field, audience, voice rules, visual
canon, brand tag, current assets, website, and current follower baseline.

### Persona master prompts + launch kits — `outputs/<persona>/`
Each folder holds the persona's `*-MASTER-*-ROADMAP-PROMPT.md` (system prompt/brief),
`*VOICE*/BRAND-OS*`, `IMAGE-PROMPTS*` / `*VISUAL-BIBLE*`, `ROADMAP*`, and `*APPROVAL-PACK*`.
**Newest dated folder is current; folders marked `rejected` / `pre-parent-genetics` / `_archive`
are superseded.** The roster:

- `adam-contractors-club/` — Adam Atiq · contractor/trades
- `akiko-being-tea-launch-2026-08-08/` — Akiko Sasaki · Being Tea Co (tea) — largest kit; site in `outputs/beingteaco-website/`
- `alexei-print-mason/` — Alexei Grigoriev · Print Mason (printing)
- `avi-launch-2026-08-08/` — Avi Dev · Always Cooked Just Right (cooking)
- `brom-fix-my-frozen-pc/` — Brom Grigoriev · PC repair
- `chomes-classwoods/`, `chomie-launch-approval-2026-08-08/`, `chomie-roadmap-2026-08-09/` — Chomes / Chomie · Classwoods
- `chris-cody/`, `christian-cody/` — Chris / Christian Cody · useful work + style
- `cillian-noo-youniverse/` — Cillian O'Sullivan · Noo Youniverse (large multi-area program; site `nooyouniverse.com/`)
- `fenrir-unjustice-right/` — Fenrir Ona-Right · Unjustice Right
- `hecatia-just-right-communication/` — Hecatia Ona-Right · communication
- `justice-right-castleborn/` — **Justice Right · the in-universe Castleborn creator/narrator (Castleborn anchor)**
- `kunuk-traditional-family-values/` — Kunuk Atiq · Traditional Family Values
- `lilly-social-persona/` (+ dated launch folders) — Lilly Dev
- `lyric-retriever-energy/` — Lyric O'Sasaki · Retriever Energy
- `maria-aware-of-my-food-launch-2026-08-08/` — Maria Luna Garcia · Aware Of My Food (food)
- `oversharing-mom-launch-2026-08-08/` — Adeola Dossou · Oversharing Mom
- `rhythm-social-persona/` — Rhythm O'Sasaki (gaming culture)
- `rohan-launch-2026-08-08/` — Rohan Dev · Jokes From Dads (humor)
- `sherlock-cannacandidz/`, `sherlock-chomes/`, `sherlock-roadmap-2026-08-09/` — Sherlock · CannaCandidz / Chomes (**cannabis — see §7**)
- `song-persona-roadmap/` — Song O'Sasaki (owner-confirmed sibling of Rhythm O'Sasaki and Lyric O'Sasaki)
- `sophia-social-persona/` (+ pop-icon, music, site folders) — Sophia Ona
- `watson-dispensary-goods/` — Watson · Dispensary Goods (**cannabis — see §7**)
- `yarra-smile-to-your-body/` — Yarra Warruwi · Smile To Your Body (movement/wellness)
- `zara-planters-journal/` — Zara Grigoriev · Planters Journal (gardening)

Abel Atiq is confirmed in the full-name canon but has no current output dossier or
verified live persona row. Enki's surname remains unconfirmed; do not infer it.

### Consolidated + platform content
- `MyPersonas.Online_v0/content/persona-launch-pack-2026-08-01.json` — all bios, purposes, topics,
  hashtags, campaigns in one place (includes the Castleborn creator-voice definition).
- `MyPersonas.Online_v0/content/wais-launch-2026-08-08/` — WAIS launch kit (brand voice roadmap,
  30-post approval pack, chat starter, visual prompt matrix, platform-compliance notes).
- `MyPersonas.Online_v0/persona-briefs/2026-08-10-persona-updates.md` — cross-persona update log.
- Repo-root: `AKIKO-SOCIAL-PERSONA-ROADMAP-PROMPT.md`, `WAIS-SOCIAL-PERSONA-ROADMAP-PROMPT.md`.

### Castleborn source — familiarize with ALL of it (the personas are based on it)
Castleborn is a **distributed convention**, not a single lore file:
- **Handle namespace** `@castleborn.<persona>` across the whole roster.
- **External canonical home:** `https://castleborn.online` (not in-repo — visit it).
- **In-repo anchor:** `outputs/justice-right-castleborn/` (Justice Right = the Castleborn
  creator/narrator persona; its prompt + launch pack carry the worldbuilding voice), plus the
  Castleborn creator-voice entry in the launch-pack JSON. Read these to internalize the universe
  before you shape any persona.

### Websites
- `MyPersonas.Online_v0/` — the platform site (all personas). Entry `index.html`.
- `nooyouniverse.com/` — Cillian's live static brand site.
- `outputs/beingteaco-website/` — Akiko's Being Tea Co site (markdown page sources + backups).
- Per-persona site build notes: Avi (`SITE-ALWAYSCOOKEDJUSTRIGHT.md`), Alexei
  (`PRINTMASON-SITE-BUILD-ROADMAP.md`), Brom (`SITE-V1-BUILD-NOTES`), Sophia
  (`sophia-liberalsarehotter-site/`).

### Assets & platform docs
- `MyPersonas.Online_v0/assets/personas/` — per-persona avatar/banner sets.
- Per-persona imagery: `outputs/<persona>/images*/`, `*profile-anchor*.png`, `CONTACT-SHEET*`.
- `MyPersonas.Online_v0/brand/app-icon/` — brand icon set.
- Platform docs to read: `HANDOFF-CHATGPT.md`, `POSTING-3PART-SPEC.md`,
  `ROADMAP-EXECUTION-2026-08-13.md`, `POST-QUEUE-ACTIVATION.md`, `CONNECTORS-STATUS.md`,
  `supabase/functions/DRIFT.md`.

---

## 5. Owner notifications = a learning feed

The owner's notifications should surface **the research topics each persona has queued** — so the
owner spends their time on the site/app **learning** the material their personas are about to post,
and can **flag** information or photos to influence the queued posts (and filter out bad info). This
keeps a human in the loop on accuracy and makes the owner smarter about each persona's field.

---

## 6. Build backlog (features required to fully realize this)

Design specs for the dev/AI who will build these. **Each must follow the manual sequence in
`RELEASE-MANIFEST-2026-08-22.md`: database apply/readback → Functions deploy/verification →
Pages deploy/live smoke. Never push functions against an older schema.**

1. **X (Twitter) posting.** Pull the drifted `twitter-post` (see `DRIFT.md`; needs the owner's
   Supabase CLI), secret-scrub + version it, then wire X into `run-post-queue` + the Composer.
   Add the X teaser as cascade stage 1.
2. **Website blog posting** (cascade stage 4). Auto-publish the curated blog post + photo gallery to
   each persona's site (Being Tea Co / Noo Youniverse are the templates).
3. **Repost queue.** Local schema/source now provide a bounded, owner-private foundation. Finish
   signed-in review UX, provider-independent scheduling, immutable media/provenance, erasure, and
   staging/live verification before any connector consumes it.
4. **Hourly research check-in system.** Local research/topic/content storage and hardened RPC/
   quota boundaries exist. A scheduled research provider, citation/evidence QA, duplicate policy,
   owner notification/review UX, and live default-off operation still must be built and approved.
5. **Image queue + AI scan/describe.** Owner uploads → assign to persona → attach a description to
   steer the prompt OR AI scans + writes a description. Feeds the compose image pipeline.
6. **Image/video staging section.** Store background/position reference images + videos per persona
   for scene/pose staging. Enforce photorealism + identity consistency (small changes only).
7. **Posting-schedule generator.** Per persona: field-popularity-by-region + peak-times → schedule +
   ≤5 tags (incl brand tag) → write the tasks into the hourly scheduled tasks.
8. **Owner notifications surface** for the research feed (§5).

---

## 7. Guardrails

- **Cannabis personas** (Sherlock/CannaCandidz, Watson/Dispensary Goods, and any Chomes cannabis
  variant) **cannot post or monetize via Meta** — restricted-goods content policy. Plan
  own-platform/manual distribution for them; do not wire them to Meta publishing.
- **Photorealistic + identity-consistent** imagery always; evolve a persona's look only in small
  increments; honor each persona's VISUAL-BIBLE.
- **Owner approval gates every external post** — the platform enforces exact-approval + immutable
  media. Do not attempt to bypass it.
- **No repeated research topics** — always dedupe against the persona's research history.
- **No fabricated facts or metrics** — cite sources; store source/evidence separately from the
  persona-written blurb so style never masquerades as fact.

---

## 8. The 4-month go-to-market campaign (→ New Year)

~4.5 months (mid-Aug → Dec 31). Run it per persona AND at the portfolio level. Suggested arc:

- **Month 1 — Foundation & research.** Complete §4 research; finalize each persona's voice + visual
  canon; build per-persona dossiers + posting schedules (§3); stand up the content engine (start the
  X+FB+IG cascade even while X/Website features are being built — use FB+IG now, add X/Website as
  they ship); seed each account; capture baseline follower counts + engagement.
- **Month 2 — Ramp.** Consistent cascade cadence in peak windows; run the "are you ready?" teaser
  series; behind-the-scenes IG; grow via hashtags, cross-persona collabs (they share the Castleborn
  universe), and website SEO; begin the repost engine.
- **Month 3 — Scale.** Double down on the top-performing personas/formats; amplify (organic +
  any paid); heavy community engagement; ship the website blog stage; cross-promote across the
  roster; measure and cut what isn't working.
- **Month 4 — Push.** Peak cadence; challenges/campaigns/collabs; holiday-season content; convert
  engaged viewers → followers; final sprint to the stretch targets.

For each persona set **weekly follower + engagement milestones** working back from the target, and
report against them honestly. Prioritize the personas with the clearest audience + platform fit
(non-restricted fields, strong visual canon, active niche communities) to carry the portfolio.

---

## 9. Start here (first actions)
1. Read this doc, then **every persona master prompt + launch kit** (§4), the launch-pack JSON, and
   the **Castleborn** anchor + `castleborn.online`. Produce a **per-persona dossier**.
2. For each persona, research **field popularity by region + platform peak times**; draft its
   **schedule + tags** (§3).
3. Draft the **4-month campaign** per persona and portfolio-wide (§8), with weekly milestones.
4. Begin the **hourly rhythm** (§2): news check-ins → queue research → notify owner → stage the
   FB+IG cascade for approval (add X + Website as those features ship).
5. Track **non-repetition** and **metrics**; keep the owner learning-in-the-loop (§5).
