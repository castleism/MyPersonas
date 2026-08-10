# Akiko / Being Tea Co. — Measurement, Community, Monetization, and Risk System

Prepared: 2026-08-09  
Operating state: local planning and owner review only; no external scheduling or publishing authorized  
Baseline rule: blanks mean **unknown**, not zero

## 1. Measurement operating system

### Qualified-view definition

A qualified view is a platform-reported view that survives the platform's initial-view threshold and belongs to the intended content unit. Because Instagram, Facebook, and X expose different definitions, never merge their raw view counts without retaining the source platform and metric name. Until Akiko has 28 days of data, report both:

- the platform's native view/impression metric; and
- an internal qualified-view field populated only when the source definition is documented.

Do not replace unknown data with zero. A blank means the platform did not expose the metric, access was unavailable, or the export was not supplied.

### Weekly dashboard fields

One row per platform per ISO week:

| Field | Definition | Formula or source |
|---|---|---|
| Week start / end | Reporting window | Monday–Sunday in America/Anchorage |
| Platform | Instagram, Facebook, or X | Native analytics source |
| Opening followers | First verified count in window | Account analytics |
| Closing followers | Last verified count in window | Account analytics |
| Net followers | Closing minus opening | `closing - opening` |
| Required trajectory | Linear stretch reference, not a promise | `999,996 / 145 × elapsed days` plus baseline |
| Trajectory variance | Actual minus reference | `closing total - required total` |
| Unique reach | Unique accounts/people reached | Native analytics; keep blank if unavailable |
| Non-follower reach | Reached accounts not following | Native analytics |
| Impressions / native views | Platform-native top-line exposure | Preserve exact source label |
| Engaged or qualified views | Views meeting documented threshold | Native analytics or documented internal rule |
| Initial hold | Viewers surviving opening threshold | Native retention when available |
| Average watch time | Mean watch time in seconds | Native analytics |
| Duration | Content length in seconds | Source file or platform |
| Watch-time ratio | Watch time divided by duration | `average watch time / duration` |
| Completion | Completed views divided by starts | Native analytics where available |
| Shares / reposts | Private and public shares where exposed | Native analytics |
| Saves | Saves/bookmarks where exposed | Native analytics |
| Meaningful comments | Questions, observations, corrections, or experiences; exclude emoji-only and obvious spam | Manual coded count |
| Profile visits | Visits attributed in window | Native analytics |
| Follows attributed | Follows attributed to content | Native analytics; otherwise blank |
| Returning viewers | Platform-returning audience measure | Native analytics |
| Search discovery | Search-originated views/reach | Native analytics where available |
| Series continuation | Viewers consuming another episode in the same series | Platform data or tracked proxy |
| Unfollows | Confirmed unfollows | Native analytics |
| Negative feedback | Hides, reports, blocks, muted/restricted signals where exposed | Native analytics |
| Production time | Human plus edit hours | Production log |
| Production cost | Direct cash cost in USD | Receipts/log |
| Email signups | Confirmed opt-ins attributed to content | Email/landing analytics |
| Affiliate clicks | Disclosed outbound clicks | Link analytics |
| Revenue | Gross revenue by source | Commerce records |

### Normalized rates

Calculate only when the denominator is known and greater than zero:

- shares per 1,000 qualified views = `shares / qualified views × 1,000`
- saves per 1,000 qualified views = `saves / qualified views × 1,000`
- meaningful comments per 1,000 qualified views = `meaningful comments / qualified views × 1,000`
- profile visits per 1,000 qualified views = `profile visits / qualified views × 1,000`
- follows per 1,000 qualified views = `attributed follows / qualified views × 1,000`
- negative feedback per 1,000 qualified views = `negative feedback / qualified views × 1,000`
- email conversion = `confirmed signups / tracked landing visits`
- affiliate click rate = `affiliate clicks / tracked link-page visits`

Do not create a blended cross-platform rate unless every component uses the same documented definition.

### Baseline and review cadence

- First 14 days: collect data; do not declare a winner from one post.
- Day 15: establish provisional seven-day medians by platform, format, and franchise.
- Day 29: establish first 28-day medians.
- Weekly: compare seven-day median with the prior seven-day median and current 28-day median.
- Monthly: audit definitions, attribution, audience geography, demographics, search terms, negative feedback, production burden, and revenue quality.
- Always report viral outliers separately from medians.

### Decision hierarchy

1. Safety, accuracy, disclosure, rights, and account health.
2. Qualified audience growth and returning behavior.
3. Shares, saves, meaningful comments, and profile visits.
4. Watch behavior and reach.
5. Revenue and production efficiency.
6. Raw views only after the above are understood.

A high-view post that attracts the wrong audience, creates unfollows, or cannot be repeated is not a scale decision.

## 2. Experiment protocol

Every test receives an ID and is written before the first post goes live.

| Required field | Rule |
|---|---|
| Hypothesis | One falsifiable sentence |
| Primary variable | Exactly one intended change |
| Control | Closest comparable post or matched pair |
| Audience | Platform and intended viewer |
| Primary metric | One decision metric |
| Guardrails | Accuracy, negative feedback, unfollows, time, and cost |
| Minimum useful sample | A matched pair with at least 1,000 qualified views per variant; if reach is lower, run at least three matched pairs and label the result directional |
| Scale rule | Repeat in at least two more episodes after a meaningful win |
| Revise rule | Promising primary metric with a guardrail or execution problem |
| Stop rule | Two failed replications, safety/trust concern, or unsustainable workload |
| Learning | Record what changed even when the result is null or negative |

The 1,000-view threshold is an operating minimum for this launch, not a universal benchmark. It may be revised after Akiko's real variance is known.

### Initial five experiments

| ID | Hypothesis | Single primary variable | Primary metric | Initial minimum | Scale / revise / stop | Learning if it fails | State |
|---|---|---|---|---|---|---|---|
| AKI-E01 | A face-led cover will convert more qualified viewers into profile visits than a process-led cover. | Cover subject | Profile visits per 1,000 qualified views | One matched pair per platform, then replicate | Scale after two wins; revise if holds drop; stop after two failed replications | The lesson or process—not Akiko's face—may be the stronger discovery asset. | `PROPOSED` |
| AKI-E02 | A concrete brewing problem will earn more saves than a definition-led hook. | Hook type | Saves per 1,000 qualified views | Three matched pairs | Scale problem-led hooks if median wins without negative feedback | The audience may prefer foundational vocabulary, or the problem framing may be too generic. | `PROPOSED` |
| AKI-E03 | A visible source card will increase saving on claim-check posts. | Source card present/absent | Saves per 1,000 qualified views | Two matched pairs | Keep if it wins without a material completion loss; revise visual density if needed; stop after two failed replications | Trust may be better conveyed in the caption/link, or the card may not be legible/useful enough to save. | `PROPOSED` |
| AKI-E04 | On Facebook, a 220–320 word explanation will create more meaningful discussion than a 90–140 word explanation. | Facebook caption word-count band | Meaningful comments per 1,000 qualified views | Four matched pairs per band | Keep the repeatable median winner; revise if depth adds discussion but sharply increases production time; stop if no stable difference | Facebook readers may want concise utility, or caption depth may matter less than the topic/question. | `PROPOSED` |
| AKI-E05 | A one-line brewing-log download will turn practical utility into owned-audience growth. | Download CTA present/absent | Confirmed email signups per tracked landing visit | At least 100 tracked landing visits or four weeks | Scale only with clear consent, low complaints, and useful completion feedback | The utility, landing page, or audience timing is insufficient; do not assume email itself is unwanted. | `PROPOSED` |

### Experiment log language

- **Verified fact:** directly shown by official policy, platform analytics, or documented source.
- **Assumption:** a temporary planning input awaiting owner confirmation.
- **Hypothesis:** a prediction under test.
- **Result:** observed measurement with source and time window.
- **Decision:** scale, revise, stop, or continue collecting.

## 3. Community response system

### Relationship and voice

Akiko is a calm guide and observant host—not a guru, clinician, historian-by-identity, or substitute for a human expert. Replies should be warm, concise, specific, and curious. She can say what is known, what is uncertain, and what she will check.

Use:

- “Try changing one variable first.”
- “That is worth checking; I would not want to guess.”
- “What changed between the two cups?”
- “Here is the source I used.”
- “Tea can be simple and still deserve attention.”

Avoid:

- mystical certainty, medical promises, detox language, shame, elitism, cultural cosplay, invented personal memories, fake product use, defensive sarcasm, or pretending Akiko is human.

### Routine reply templates

**Brewing troubleshooting**  
“I would change one thing first: [time / temperature / leaf / water]. Keep the other variables steady and tell me what happens in the next cup.”

**Clarifying question**  
“Which tea, water temperature, leaf amount, and steep time did you use? Even approximate numbers will help.”

**Terminology correction**  
“Thank you for catching that. The more precise term is [term]. I’ve corrected the record and will keep the source attached.”

**Source request**  
“Yes—this should be sourced. I used [source name/link]. If you see stronger primary evidence, please send it for review.”

**Preference disagreement**  
“That sounds like a real preference difference, not a right-or-wrong cup. What do you notice most in your version?”

**AI identity question**  
“Akiko is a fictional AI-assisted host for Being Tea Co. The research, scripts, sources, and approvals are managed by people, and synthetic visuals are disclosed.”

**Product question before testing**  
“Akiko has not used that product, so I can’t give a firsthand recommendation. I can compare the published materials and specifications if that would help.”

**Health question**  
“I can share general, sourced information, but I can’t assess your health or medication situation. Please check with a qualified clinician or pharmacist.”

**Escalation acknowledgment**  
“I’ve paused this thread for human review so I do not guess or make the situation worse.”

### Turning questions into posts

1. Capture the exact audience wording and URL/screenshot in the question log.
2. Remove names and personal details unless explicit permission exists.
3. Classify: routine brewing, terminology, sourcing, product, health, legal, financial, harassment, or crisis.
4. For low-risk questions, count repetitions and attach the relevant franchise.
5. Research claims from primary sources.
6. Draft a response post with the original question paraphrased.
7. Require human approval for any sensitive topic or identifiable quotation.
8. Link the published answer back only through permitted, non-spammy replies.
9. Record whether the episode reduced repeat confusion or produced a stronger next question.

### Community rituals

- **Monday Variable:** followers choose one controlled brewing variable to test.
- **Opened-Leaf Wednesday:** share or describe what the leaf revealed after brewing.
- **Friday Cup Note:** one sensory sentence, no score required.
- **Monthly Correction Ledger:** what Akiko clarified, corrected, or still does not know.
- **Quarterly Source Table:** primary sources and expert contributions used during the period.

Participation must be optional and non-manipulative. Never require tagging friends, mass sharing, or engagement as the price of access.

### Live-stream concepts

Live streams remain owner-approved only:

- controlled three-cup water comparison;
- one leaf through three temperatures;
- live question triage with “answer / research / decline” buckets;
- guest tea educator or sensory professional with credentials checked in advance;
- monthly correction and source-review session.

No live health advice, private-product claims, cultural impersonation, minors, crisis responses, or unscripted sponsorship claims.

### Collaboration outreach

Offer a specific, low-burden exchange: one clearly framed question, permission to quote accurately, visible credit, source link, right to review their attributed statement, and no expectation that they post. Prioritize tea educators, growers, importers, sensory professionals, ceramicists, water specialists, and historians who can speak from verifiable expertise.

Do not use copied audience lists, bulk DMs, or reciprocity pressure. Every outreach message must be human-approved until a safe pattern is proven.

### UGC and remix permissions

1. Ask the original creator in writing for platform, duration, edit, caption, paid-use, and archive rights.
2. Save the consent record and original URL.
3. Confirm all visible people are adults or obtain appropriate releases; avoid minors by default.
4. Credit exactly as requested.
5. Do not imply endorsement.
6. Preserve the original file and edited derivative.
7. Remove or stop future use when a valid withdrawal request applies, while retaining the audit record.

### Response-time goals

- First 30 days: two human review windows per day, maximum 20 minutes each.
- Routine public replies: target within 24 hours on active days.
- Corrections or credible safety issues: pause affected content and escalate as soon as seen.
- DMs: no promised response time; route only legitimate business, rights, safety, or privacy matters.
- Overnight: no automation beyond draft preparation and alerts.

### Escalation matrix

| Situation | Automatic action | Human approval | Pause threshold |
|---|---|---|---|
| Routine brewing question | AI may draft; do not auto-send | Batch review initially | None |
| Complaint about accuracy | Acknowledge and collect source | Required before substantive reply | Two credible reports on same claim |
| Health, medication, pregnancy, allergy | Provide boundary draft only | Always | Any personalized advice request |
| Legal or financial question | Decline individualized advice | Always | Any claim that could cause reliance |
| Threat or credible self-harm disclosure | Preserve evidence; use platform safety tools; alert owner | Always and urgent | Immediate global pause if account/content implicated |
| Harassment or hate | Hide/restrict/block according to documented policy; preserve evidence | Owner reviews edge cases | Coordinated attack or threat |
| Misinformation | Do not quote-amplify casually; source-check | Required for correction post | Rapid spread or material harm |
| Personal disclosure | Do not surface publicly or train reusable replies from it | Always | Any sensitive identifying detail |
| Sponsorship/product complaint | Freeze related campaign | Always | Credible safety, disclosure, or fulfillment issue |
| Impersonation/account compromise | Global pause; preserve screenshots; start official recovery | Always | Immediate |

## 4. Trust-preserving monetization ladder

Monetization follows demonstrated utility and audience fit; it does not lead the launch. No revenue tactic may require invented experience, health claims, undisclosed consideration, or erosion of Being Tea Co.'s educational promise.

### Stage 0 — Proof before revenue

Entry condition: the accounts, AI disclosure, rights records, source system, and at least one repeatable franchise are functioning safely.

Offer:

- free one-line brewing log;
- sourced glossary;
- optional email series;
- transparent “tools and teas mentioned” page with no paid placement unless disclosed.

Exit condition: at least four weeks of stable publishing, a clear returning audience, and no unresolved identity, policy, or rights problem.

### Stage 1 — First revenue

Start with a low-pressure, clearly useful owned item or a small set of disclosed affiliate links. Good candidates:

- printable brewing log and sensory-note pack;
- expanded comparison worksheet;
- carefully selected basic brewing tools Akiko can discuss from specifications and verified human testing;
- disclosed tea links only after a human actually evaluates the product and records the basis of any claim.

Do not gate the core educational answer behind a purchase.

### Stage 2 — Affiliate links

Requirements:

- owner-approved program and merchant;
- documented commission terms;
- destination and availability checked before each campaign;
- firsthand-use language used only when a named human tester actually used the item;
- clear alternative for people who do not want an affiliate link;
- link, click, conversion, refund, complaint, and revenue records retained.

Default disclosure: “Affiliate link: Being Tea Co. may earn a commission if you buy through this link, at no extra cost to you. Akiko is a fictional AI-assisted host; the human owner approves the content, and any firsthand product evaluation is attributed to the person who performed it.”

### Stage 3 — Sponsorship readiness

Begin outreach only when:

- the audience and geography are known from 28-day data;
- at least two franchises have repeatable qualified growth;
- account status and recommendation eligibility are healthy;
- rates can be described with medians, not one viral outlier;
- a sponsorship policy, claims sheet, usage-rights price, category exclusions, and cancellation clause exist.

Default disclosure: “Paid partnership with [brand]. Being Tea Co. was compensated for this post. Akiko is a fictional AI-assisted host; the human owner approved the script and sources, and any firsthand product evaluation is attributed to the person who performed it.”

Never accept a brief requiring hidden sponsorship, guaranteed praise, unsupported superiority, medical benefit, fake scarcity, undisclosed synthetic testimonial, or perpetual paid-media rights without explicit negotiation.

### Stage 4 — Owned products and services

Sequence from lowest to highest operational risk:

1. digital brewing and sensory tools;
2. educational workshop with a qualified human facilitator;
3. curated non-ingestible accessories with clear specifications;
4. tea products only after sourcing, labeling, food-safety, inventory, fulfillment, refund, and claims responsibilities are established;
5. consulting or services only when the actual human provider and scope are explicit.

Akiko must never be presented as the manufacturer, clinician, licensed professional, or firsthand traveler unless that statement is literally and verifiably true.

### Stage 5 — Newsletter or membership

Free newsletter first. A paid tier becomes eligible only when free readers consistently open, click, reply, and request deeper material. Membership must provide durable value—reference library, guided comparisons, expert sessions, or community practice—not parasocial pressure or access to invented private life.

### Stage 6 — Larger partnerships and licensing

Require counsel or specialist review for likeness licensing, international rights, exclusivity, ingestible products, synthetic-media usage, data sharing, white-label production, or long-term endorsement. The owner retains the right to withdraw Akiko from unsafe context and to approve every new category.

### When monetization damages trust

Pause or decline when:

- sponsored posts exceed 15% of published units in a rolling 28-day window before the owner sets another cap;
- a product conflicts with prior education or has not been evaluated as claimed;
- a launch displaces the content audiences followed for;
- affiliate selection is driven by commission rather than fit;
- comments show repeated confusion about whether advice is paid;
- refund, safety, or fulfillment complaints cannot be handled promptly;
- synthetic identity or human responsibility becomes less clear.

The 15% cap is a proposed starting control awaiting owner approval, not a universal rule.

## 5. Failure-prevention register

The global pause owner is the account owner until another named person is formally assigned. “Global pause” means no new publishing, scheduling, automated replies, paid promotion, or campaign activation across Akiko's accounts while investigation is open.

| # | Failure mode | Early warning signs | Preventive control | Approval requirement | Pause threshold | Recovery action |
|---:|---|---|---|---|---|---|
| 1 | Fake engagement or engagement pods | Unexplained follower spikes, repetitive comments, low qualified reach, suspicious geography | Never buy or trade engagement; audit vendors and access | Owner approval for every growth vendor | Any purchased/organized fake activity | Stop vendor, revoke access, preserve records, disclose internally, rebuild from organic baseline |
| 2 | Engagement bait or spam distribution | “Tag three friends,” repeated unsolicited replies, falling comment quality, user complaints | Utility-first CTAs; no follow/unfollow, bulk DMs, or forced sharing | Owner approves new acquisition mechanics | One deceptive mechanic live or repeated complaints | Remove/replace mechanic, apologize when appropriate, document rule |
| 3 | Copied, watermarked, or unlicensed media | Copyright notices, source uncertainty, platform downranking, visible third-party marks | Original source files, license ledger, reverse-source check, native exports | Rights approval before publication | Any unresolved ownership claim | Unpublish/pause affected asset, contact rights holder, replace and document |
| 4 | Interchangeable mass-produced AI content | Face/style drift, generic captions, duplicate scenes, falling return behavior | Canon lock, human editorial pass, provenance, series-specific learning goal | Approve every post during launch | Two visibly inconsistent or near-duplicate posts in a week | Pause batch, refresh identity and editorial QA, regenerate selectively |
| 5 | Misleading AI identity | People believe Akiko is a real person, AI labels absent, invented lived experience | Bio, post-level synthetic disclosure, FAQ, no human-experience claims | Owner approves identity language | One material deceptive claim or platform warning | Correct visibly, update profiles and affected posts, audit archive |
| 6 | Unsupported health or product claims | Detox/cure language, personal medical questions, source disputes, adverse-event report | Claim matrix, primary sources, clinician/legal escalation, no personal advice | Specialist and owner approval | Any individualized medical advice or credible safety complaint | Global pause affected topic/product, correct, seek specialist guidance |
| 7 | Audience mismatch and raw-view optimization | Reach rises while follows, saves, returns, or email quality fall; wrong geography/topic | Optimize qualified conversion and series continuation; report medians | Owner approves pillar changes | Two 7-day periods of reach growth with deteriorating qualified outcomes | Stop mismatched format, diagnose traffic source, restore wedge |
| 8 | Brand inconsistency or cultural cosplay | Conflicting age/voice/style, costume-first presentation, invented Japanese authority | Visual/voice canon, ceremonial look used sparingly, source cultural claims | Owner approves canon changes | One public canon contradiction or credible cultural concern | Pause affected creative, consult qualified reviewer, correct and document |
| 9 | Unsafe automation or duplicate publishing | Duplicate provider IDs, wrong account, replies sent without review, missing audit event | Approval queue, idempotency keys, volume caps, global pause, official APIs only | No L3 until a narrow format proves safe | Any unauthorized external action | Pause all automation, revoke tokens if needed, reconcile provider state, incident review |
| 10 | Disclosure or sponsorship failure | Missing paid-partnership label, unclear affiliate language, audience confusion | Disclosure checklist embedded in every commercial record | Owner and campaign approval | Any live undisclosed consideration | Pause campaign, correct prominently, notify partner/platform as required |
| 11 | Burnout and declining originality | Missed QA, rushed batches, resentment, repeat concepts, rising production hours | Weekly cap, reserve, no forced daily output, monthly rest week option | Owner approves cap increases | Two weeks above cap or safety/quality errors from fatigue | Reduce cadence, publish evergreen reserve only, reset production plan |
| 12 | Reputation crisis or hostile pile-on | Coordinated mentions, threats, misquotes spreading, team improvising replies | Crisis owner, evidence capture, single spokesperson, no automated arguments | Owner approval for all crisis communication | Threat, rapid harmful misinformation, or partner/safety issue | Global pause, assess facts, concise sourced response, postmortem |
| 13 | Platform-policy or recommendation loss | Account Status warning, reach collapse, monetization restriction, removed content | Weekly account-health checks; official-source policy log | Owner approves appeals and policy-sensitive changes | Any account restriction or recommendation ineligibility | Pause similar content, preserve notice, use official appeal, document outcome |
| 14 | Single-platform dependence | More than 80% of qualified audience or revenue from one platform | Native multi-platform presence plus website/email | Owner approves platform retirement | Platform access/reach loss threatens continuity | Shift reserve to healthy channels, notify owned audience, rebuild distribution |
| 15 | Privacy, impersonation, or account compromise | Unknown login, fake account, leaked private material, suspicious reset | Least privilege, owner-held authentication, 2FA, no shared passwords, privacy ledger | Owner for account access and recovery | Any credible compromise or doxxing | Global pause, official recovery, preserve evidence, rotate access, warn audience if needed |
| 16 | Founder, Brother Kāruṇya, or persona identity collision | Followers cannot tell who speaks; founder history appears in Akiko's first person; cross-persona reposts blur ownership | Separate bios, source labels, account maps, canon ledger, and no identical cross-persona reposting | Owner approval for founder stories, Brother Kāruṇya use, or cross-persona collaboration | One public lived-experience misattribution or unresolved identity complaint | Pause affected content, correct attribution visibly, separate profiles/archives, and update the canon ledger |

## 6. Approval and autonomy gates

### L0–L2 launch state

- Current package workflow: **L2-style local approval queue**. The last verified MyPersonas setting was L0; no app-side import occurred, provider authorization is incomplete, and every post remains local.
- Owner approval is required for every image, caption, alt text, disclosure, account mapping, release time, and external action.
- AI may research, draft, version, validate files, calculate schedules, and prepare import-ready records locally.
- AI may not post, schedule, like, follow, DM, argue, purchase promotion, accept agreements, authenticate accounts, or change live profiles without an explicit authorized action.

### Eligibility for bounded L3

Recommend L3 only after all of the following are true:

1. at least one low-risk format has 20 correctly published records;
2. owner-controlled authentication and official API write scope are verified;
3. duplicate prevention, provider IDs, retry limits, volume caps, audit history, alerts, and a tested global pause work end-to-end;
4. no unresolved account-health, disclosure, rights, or identity issue exists;
5. the owner approves the exact accounts, format, hours, cap, and rollback procedure.

Sensitive replies, sponsorships, claims, live streams, collaborations, crisis communication, account changes, and DMs never enter unattended L3 under this plan.

## 7. Weekly check-in output

Every check-in must end with:

1. actual versus stretch-reference followers;
2. seven- and 28-day median changes;
3. largest repeatable signal and largest uncertainty;
4. account health, disclosure, rights, and negative-feedback status;
5. experiments scaled, revised, stopped, or still collecting;
6. next seven-day production and publishing plan;
7. honest reforecast: conservative, strong, breakout, and stretch-reference;
8. owner actions and blockers;
9. a clearly separated **Approve / Deny / Revise** queue.

Never restart the core strategy solely because of one outlier. Revisit positioning only when multiple repeatable formats fail to attract the intended audience or audience feedback shows the promise itself is unclear.
