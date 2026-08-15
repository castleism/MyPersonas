# AI tooling and trial-credit plan

Status: owner working document, updated 2026-08-14 (America/Anchorage).

This is the operating plan for the MyPersonas/Castleborn portfolio and its related sites and apps. It uses a small, benchmarked model set. Creating one project or API key per persona would multiply cost, key exposure, and maintenance without improving persona separation. Personas belong in MyPersonas as data and policy; provider projects are separated by environment and risk.

## Current truth

- MyPersonas source and the public Pages frontend are current, but the release is not healthy: local contract tests pass while the GitHub Deno typecheck is red and automatic Supabase deployment is blocked by a missing workflow credential.
- Live MyPersonas currently has one Google text backend using the moving alias `gemini-flash-latest`. Do not add a fleet of keys until the security and release gates below are closed; replace that alias with a pinned stable model only after a controlled test.
- The recurring Meta publisher remains off. FB/IG owner-triggered publishing was proven earlier, but the hardened exact-source release still needs coordinated verification. X remains off.
- Google social sign-in and TOTP enrollment exist. That is not enterprise SSO. An AAL2 challenge and protected credential boundary are implemented locally but remain unapplied and undeployed, so production must still be treated as lacking that protection.
- This desktop now has Ollama `gpt-oss:20b`, `gemma3:12b`, and `embeddinggemma`, tested locally on `127.0.0.1:11434`. Ollama must remain loopback-only because its local API has no authentication boundary.
- Claude desktop is already at roughly 75% of its weekly allowance. Reserve it for architecture, canon, and final review instead of bulk generation.

## The smallest useful stack

| Role | Default | Escalation | Use in this portfolio |
|---|---|---|---|
| Primary engineering conductor | Codex `gpt-5.6-terra` | `gpt-5.6-sol` for hard security/release review; `gpt-5.6-luna` for bounded bulk work | One writer per branch/worktree; tests and evidence required. |
| Architecture and editorial review | Claude `claude-sonnet-5` | `claude-opus-5` only for a final difficult decision | Read-only review or isolated worktree; preserve the limited weekly allowance. |
| Hosted MyPersonas text | Gemini stable `gemini-3.6-flash` | Evaluate `gemini-3.5-flash` or a current Pro preview only on the fixed benchmark | First stable replacement candidate for the current moving alias. |
| Sourced web research | Perplexity `sonar` | `sonar-pro`; `sonar-deep-research` only for a bounded dossier | Sources go in the evidence record; generated prose never becomes evidence. |
| Local private drafting | Ollama `gpt-oss:20b` | A stronger hosted model only for material selected for publication | Caption/blog first drafts, redacted code review, classification, summaries. |
| Local retrieval | Ollama `embeddinggemma` | Cohere `embed-v4.0` + `rerank-v4.0-fast` for hosted evaluation | Persona canon/search without spending API credits. |
| IDE assistance | GitHub Copilot with GPT-5.6 Terra | Claude Sonnet 5 as second opinion | Never let Copilot and Codex edit the same files concurrently. |
| Long-context independent review | Kimi Code K3 | K3 high-reasoning mode for one bounded review | Read-only or isolated worktree; no YOLO/AFK production access. |
| Fast open-model benchmark | Groq `openai/gpt-oss-20b` | `openai/gpt-oss-120b`; Whisper Large V3 Turbo for transcription | Latency-sensitive, redacted, non-secret workloads. |
| Voice | ElevenLabs `eleven_flash_v2_5` | `eleven_v3` for an approved final; `scribe_v2` for transcription | No voice cloning without rights/consent records. Use scoped, expiring keys. |
| Image generation | Gemini `gemini-3.1-flash-image` (Nano Banana 2) | `gemini-3-pro-image` for approved hero art; Lite for bulk tests | Preserve persona visual bibles, label synthetic media, and keep provenance. |
| Image understanding | Local Ollama `gemma3:12b` or a current Gemini vision model | Human review for identity/canon | DiffusionGemma is text-output multimodal reasoning, not an image generator. |

Current official references: [OpenAI models](https://developers.openai.com/api/docs/models), [Claude models](https://platform.claude.com/docs/en/about-claude/models/overview), [Gemini models](https://ai.google.dev/gemini-api/docs/models), [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation), [Perplexity Sonar](https://docs.perplexity.ai/docs/sonar/models), [Groq production models](https://console.groq.com/docs/models), [ElevenLabs models](https://elevenlabs.io/docs/overview/models), and [Ollama models](https://ollama.com/library).

Model availability and trial terms change. Recheck the provider's official model page immediately before creating a deployment or key.

## Specialist providers: benchmark, do not duplicate

| Provider/tool | Decision | Recommended use/model |
|---|---|---|
| OpenRouter | Evaluation and controlled fallback only | Require `data_collection: deny`, ZDR, required parameters, a provider allowlist, explicit fallback order, and a maximum price. Use only public/redacted data until routing is verified. |
| Together AI and Fireworks AI | Run the same redacted benchmark, then keep one | Prefer serverless/batch. Do not start a dedicated GPU trial. |
| Mistral | OCR/document specialist candidate | `mistral-small-2603`, `mistral-medium-3-5`, and `mistral-ocr-4-0`. |
| DeepSeek | Cheap independent reasoning benchmark | `deepseek-v4-flash` or `deepseek-v4-pro`; retired `deepseek-chat`/`deepseek-reasoner` aliases must not be used. |
| xAI/Grok | Adversarial review and X-native research | `grok-4.5` for a hard review, `grok-4.3` for a cheaper pass. Never grant X write access during research. |
| Azure AI Foundry | Enterprise control-plane experiment | One `mypersonas-rnd` project using Entra/RBAC and keyless auth where available. No paid deployment until the benchmark justifies it. |
| AWS Bedrock | Standby portability test | Keep dormant unless Foundry or the direct provider fails a real requirement. |
| IBM watsonx | Governance/RAG experiment | `ibm/granite-4-h-small`; avoid hourly dedicated trial capacity. |
| Meta AI | Redacted evaluation only | No production connector or persona secrets. |
| LM Studio | Optional local compatibility server | Bind to loopback, enable authentication, and use only if a client cannot speak Ollama. |
| Bionic | Project-management experiment | Do not connect production repos or secrets until its permissions/export/deletion behavior is reviewed. |

## Provider project layout

Create at most these four projects/workspaces where the provider supports them:

1. `mypersonas-rnd` — public/redacted benchmarks; no production data or write access.
2. `mypersonas-dev` — development integration; synthetic test personas and disposable data.
3. `mypersonas-stage` — production-shaped acceptance tests; no live publishing or payments.
4. `mypersonas-prod` — server-side use only after security review, with the smallest scopes and budget.

Do not create projects per persona. Record persona-to-model assignments in MyPersonas. Split into a separate provider project only for a real legal entity, billing owner, region, or data-handling boundary.

## Three-machine local layout

| Machine | Role | Rules |
|---|---|---|
| Primary desktop (verified RTX 4090/64 GB) | Ollama inference, embeddings, approved local vision/image experiments, main development tests | Ollama stays on loopback. Keep private canon here; no inbound public tunnel. One GPU-heavy job at a time. |
| Second desktop (hardware inventory pending) | Clean build/test runner, browser/device matrix, batch public/redacted work | Benchmark thermals, disk, GPU, and power first. Do not copy secrets merely to make it a worker. |
| Laptop (hardware inventory pending) | Owner release console, MFA/dashboard ceremony, mobile/responsive validation, emergency stop | Prefer no long-running generation. Keep recovery material offline and separate from project folders. |

Connect machines through a private authenticated network only after an explicit design/review. Do not enable Ollama or LM Studio LAN exposure as a shortcut. Use signed task packets and artifact hashes for handoff until a secure worker plane exists.

## Persona and portfolio workload assignment

The five highest-leverage launch lanes are not simply the five most entertaining personas:

| Lane | Personas/brands | Best tools | Weekend definition of done |
|---|---|---|---|
| Immediate product revenue | Alexei / PrintMason | Codex for release QA; Claude for offer/copy review; Perplexity for cited market checks; Gemini for approved product imagery | Current shop surface released; one hidden $19 Payhip product tested end-to-end, including refund/delivery, before public linking. |
| Existing content distribution | Akiko / Being Tea Co | Perplexity research; local Ollama drafts; Claude voice review; ElevenLabs only after voice approval | Newsletter subscribe/confirm/welcome/unsubscribe verified; Search Console submitted; Bookshop application prepared. No more article generation. |
| Lead generation | Brom / Fix My Frozen PC | Codex security/backend; local Ollama for static triage drafts; Perplexity for sourced support notes | TLS fixed; `ask-brom` and `intake` deployed and bounded; owner-supplied territory/hours/pricing published. |
| Trust and provenance | Maria / Aware Of My Food | Perplexity sourced research; Cohere/local retrieval; Claude claims review | Public source leak closed; analytics/privacy reconciled; evidence and persona prose stored separately. Avoid outcome-based health affiliate claims. |
| Portfolio voice/audience | Justice Right and Sophia | Claude/Kimi canon review; Gemini approved visual work; Codex site release | One evidence-reviewed, owner-approved audience test each. Sophia music credits remain owner-gated. |

Adam/Contractors Club is high value but blocked on owner control and two-account E2E. Avi/Always Cooked and Hecatia/Just Right are blocked first by HTTPS/identity or qualified-provider gates. Cannabis personas remain excluded from Meta monetization/publishing. Legal, health, charity, adult-production, and endpoint-security products stay gated by their explicit roadmaps.

## Controlled model-to-model workflow

The safe version of the “hyperbolic time chamber” is a bounded handoff graph:

1. Researcher returns claims plus sources and uncertainty.
2. Planner converts approved evidence into a signed task packet with scope, files, tests, budget, and stop conditions.
3. One builder works in one branch/worktree.
4. A different model reviews the diff and evidence without write access.
5. Automated tests run.
6. The owner approves any deploy, external post, payment, provider permission, or irreversible operation.
7. A release verifier records what is local, pushed, deployed, and actually verified live.

Every loop has a maximum number of iterations, request/token/spend ceilings, a wall-clock deadline, and a global stop. No agent may create more agents, spend money, publish, or deploy merely because another model told it to.

## Trial-credit benchmark

Before wiring a provider into MyPersonas, run the same public/redacted packet:

- one TypeScript repair with tests;
- one security threat-model review;
- one persona canon task with explicit forbidden facts;
- one transparent affiliate/product description grounded in supplied evidence;
- one sourced research task;
- one strict JSON/tool-call task;
- one long-document retrieval task;
- one multimodal task where supported.

Score correctness, source fidelity, canon fidelity, JSON validity, latency, token use, dollar cost, safety failure rate, and edit distance to owner approval. Keep the winner for each role, not every provider. Log provider, pinned model, task ID, hashes of task/result, tokens, cost, tool calls, reviewer, and approval outcome; do not log confidential prompts verbatim.

## Desktop and dashboard setup map

| Tool | Project/task to use | Access posture | Current/setup gate |
|---|---|---|---|
| Codex | Current MyPersonas task; `portfolio-p0-containment`, `mypersonas-release`, then `mypersonas-security` packets | Primary writer for the assigned files only | Active locally; Git push/deploy remains owner-gated. |
| Claude desktop | Existing MyPersonas project; task `final-architecture-and-canon-review` | Read-only review of diffs/task packets; no secrets or production tools | Existing projects observed; weekly allowance is scarce, so do not create a bulk queue. |
| GitHub Copilot | Repository workspace `MyPersonas`; task `ide-second-opinion` | Local repo only; no autonomous push/deploy | Repo attachment changes access and needs owner confirmation. |
| Kimi | Project `MyPersonas Independent Review`; tasks `long-context-roadmap-audit` and `release-diff-review` | Public/redacted docs or isolated worktree; no YOLO/AFK/production | Project creation and any repo connection need owner confirmation. |
| Bionic | Project `Portfolio Control Room`; import the 50-hour board only | Planning metadata first; no repo, secrets, browser, or cloud roles | Create only after permissions/export/deletion review and owner confirmation. |
| Perplexity/Comet | Space `Portfolio Research Desk`; one collection per flagship brand | Public-web research only; citations required; no provider write access | Space creation is an external account write and needs owner confirmation. |
| Google NotebookLM | `Castleborn Public Canon`, then one notebook per approved flagship evidence set | Approved public-safe sources only; private/spoiler canon stays local until explicitly approved | Uploading source files changes cloud state and needs owner confirmation. |
| Ollama | `gpt-oss:20b`, `gemma3:12b`, and `embeddinggemma` | Local loopback-only; private drafts, multimodal review, and retrieval | All three are installed and smoke-tested on the primary desktop. Run one GPU-heavy model at a time. |
| LM Studio | `mypersonas-local-compat` only if needed | Loopback plus API auth; no LAN exposure | Dormant; avoid duplicate local serving until a client requires it. |
| OpenRouter | `mypersonas-rnd` fixed benchmark | Redacted evaluation only with strict routing/data policy | Wait for AAL2/server exchange/host/budget controls, then owner confirms one scoped key. |
| Groq, Mistral, DeepSeek, Together, Fireworks | Same `mypersonas-rnd` benchmark packet | Public/redacted data; no production MyPersonas assignment initially | Verify trial terms and create at most one bounded key per provider with owner confirmation. Drop losers. |
| Gemini/Google | Existing MyPersonas backend, then `mypersonas-rnd` image/text benchmark | Stable pinned model; service-account-bound/server-side key where supported | Current moving alias should change only after green release and a controlled owner-approved test. |
| Azure Foundry | `mypersonas-rnd` governance/control-plane trial | Entra/RBAC; keyless where available; no paid deployment | Owner must confirm tenant/subscription/region/role and $0 budget. |
| AWS Bedrock | No project unless Foundry/direct providers fail a requirement | Standby only | Do not activate paid model access during the first wave. |
| IBM watsonx, Meta AI, Grok | One redacted specialist benchmark each | No production keys/data/writes | Owner confirmation at key/project creation; remove if no measurable win. |
| ElevenLabs | `mypersonas-stage-voice`; one approved voice test | Scoped/expiring/credit-limited key; rights record required | Do not create voices or spend credits until the exact persona/voice is approved. |

“Set up” means the project, policy, task packet, budget, and revocation record exist and a bounded test passed. Merely opening a dashboard or signing in is not setup completion.

Connected apps are intentionally narrower than the list of available trials. See `INTEGRATION-PLUGIN-PLAN.md` for the first-wave control plane and the exact permission record required before any connection.

## Security gates before any mass key setup

- Add CSP plus `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, frame protection, and a documented hosting-header policy for MyPersonas.
- Implement TOTP challenge and AAL2 step-up for provider-key changes, account linking/erasure, publishing, payment settings, and other high-impact operations. Enrollment alone is insufficient.
- Restore green CI and a staged deployment path. Migrations, functions, and Pages must ship in that order with proof, not race in parallel.
- Keep provider secrets server-side; never return them to browser code, logs, screenshots, task prompts, or model context.
- Use one key per provider/environment with minimal scopes, expiry where supported, IP/referrer restrictions where appropriate, a tiny initial quota, no auto-recharge, and rotation metadata.
- Treat provider dashboards as separate security domains. Enable MFA manually. Enterprise SSO may not be included on trial plans; Google social sign-in is not enterprise SSO.
- Add application-side hard cost limits because several provider dashboard budgets are alerts rather than hard stops.

## Changes that always require an owner confirmation at action time

- creating or revealing an API/OAuth key;
- granting a repo, cloud role, storage, social, email, or payment permission;
- entering MFA/OTP/recovery data;
- starting paid capacity, enabling auto-recharge, or changing billing/payout/tax details;
- deploying, applying production migrations, publishing content, sending email, or posting to social media;
- creating a public product, affiliate listing, checkout, or price.

The owner can approve a clearly described batch, but the approval must name the provider/project, permission or key scope, destination, cost ceiling, and rollback/revocation path.
