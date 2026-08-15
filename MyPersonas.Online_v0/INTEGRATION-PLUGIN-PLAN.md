# Connected-app integration plan — 2026-08-14

Status: recommendation only. No plugin installation, OAuth grant, mailbox access, payment connection, cloud role, or production write was performed.

The portfolio should use the fewest connected apps that close a real launch gap. Every connection gets a named owner, exact scopes, environment, expiry/review date, revocation procedure, and data-class limit. A signed-in browser tab is not authorization to grant access.

## First-wave control plane

| Integration | Purpose | Initial scope | Owner ceremony before connection |
|---|---|---|---|
| GitHub | Source, review, CI, release evidence | Selected repositories; branch/PR workflow; no blanket autonomous deploy | Confirm repository list and whether writes are allowed; keep production environment approvals |
| Supabase | Auth, database, Vault, Edge Functions | MyPersonas project only; read-only inspection first; migrations/functions separately approved | Confirm project, role, migration order, backups, MFA, and deploy token handling |
| Cloudflare | DNS, TLS, security headers, allowlisted site artifacts | Only the exact zones being repaired; no account-wide token | Confirm each zone, artifact directory, DNS/TLS change, and rollback |
| Stripe | Customer portal, checkout, receipts, refunds, webhook evidence | Test mode first; one legal seller account; no live product until payout/tax ownership is confirmed | Owner handles identity, banking, tax, live-mode switch, refunds, and pricing approval |
| Gmail or Outlook | Request-review and operations mail | One dedicated operational mailbox; send-only function where possible; no full historical inbox import | Confirm mailbox, sender name, domain authentication, retention, and exact scopes |
| Sentry | Error detection and release correlation | Stage first; scrub auth, prompts, URLs, emails, provider bodies, and tokens | Confirm data region, retention, sampling, source-map exposure, and production project |
| Linear **or** Asana | Single source for the 50-hour execution queue | Public-safe task metadata; links/hashes, no secrets or private canon | Choose one; confirm workspace/project creation and member permissions |

## Second wave, only if a measured need remains

| Integration | Decision |
|---|---|
| PostHog | Add only after privacy review, consent/opt-out decision, retention, region, session-recording redaction, and a written event schema. Do not run it alongside unexplained Cloudflare analytics injection. |
| Semrush | Bounded public-site SEO audit after TLS and artifact leaks are fixed. No value in indexing unsafe or stale releases faster. |
| HubSpot | Consider after one lead funnel and mailbox workflow work end-to-end. It is not the launch database and should not receive private persona canon. |
| Canva | Approved marketing-template production; preserve editable masters, license/provenance, synthetic-media disclosure, and persona visual rules. |
| HeyGen / HyperFrames | Optional disclosed synthetic video tests only after voice/likeness rights and exact persona approval. |
| Airtable | Skip unless the selected task system cannot model the affiliate/product evidence ledger. Avoid duplicate sources of truth. |
| Vercel / Wix / Replit / Lovable / Base44 | Do not add merely because trials exist. Keep current hosting unless a documented requirement—headers, runtime, preview isolation, or build support—justifies migration. |
| Slack / Teams | Add one only when another human collaborator exists and retention/access rules are defined. Model-to-model orchestration belongs in the audited task system, not an unbounded chat loop. |

## Required connection record

For every OAuth app, API key, webhook, cloud role, or plugin, record:

- integration and environment;
- exact account/project/zone/repository;
- purpose and permitted data class;
- scopes/role and why each is necessary;
- credential type, fingerprint or secret reference (never the value), created/expiry/rotation dates;
- $0 or explicitly owner-approved spend cap and whether auto-recharge is off;
- callback URLs, allowed origins/hosts, and network boundary;
- human owner and action-time approver;
- revocation, export, deletion, and incident steps;
- smoke-test evidence and last review date.

Do not connect payment, mailbox, cloud, source, analytics, or social accounts to an AI dashboard simply to make it more autonomous. The orchestrator exchanges bounded task packets and artifact hashes; high-impact actions remain separately authorized and audited.
