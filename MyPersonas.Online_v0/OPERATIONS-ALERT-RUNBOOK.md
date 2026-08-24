# MyPersonas operational-alert runbook

Status: local implementation only. Migration 069, the Edge function, and the UI
must be applied, deployed, and verified separately. No schedule, email, pager,
WAF rule, provider project, or paid log drain is created by this package.

## Purpose and safety boundary

The Staff queue at `#/platform-queue` gives active AAL2 global administrators
and technicians a small read-only operational inbox. It returns aggregate
categories, severity, counts, timestamps, and fixed action codes only. It does
not return account IDs, IP or fingerprint hashes, provider IDs, Stripe object
IDs, raw error messages/context, event metadata, requester data, or billing
details.

This inbox is not incident paging and does not prove an email was delivered.
Someone must open or refresh it. `notification_pending` remains pending until a
separate delivery process records evidence; staff must never clear it merely
because the inbox was viewed.

## Access and response targets

- Every inbox read requires an authenticated AAL2 session plus an active
  `global_administrator` or `technician` assignment.
- Billing rows are visible only to global administrators. Technicians receive
  the nonfinancial aggregate rows.
- Critical target: acknowledge within 15 minutes when a staffed incident window
  or an independently approved pager is active. Otherwise the business owner
  must explicitly decide and document after-hours coverage.
- High target: acknowledge within four staffed hours.
- Warning target: review by the end of the next staffed day.
- Do not use a generic dismiss or resolve operation. Resolve the underlying
  source through its dedicated workflow and retain evidence.

## Action-code matrix

| Safe action code | Owner | Required response |
| --- | --- | --- |
| `review_security_events` | Technician or global admin | Inspect the restricted security-event ledger, correlate only within approved tools, apply the incident containment steps below, and preserve event IDs internally. |
| `notify_locked_accounts` | Technician or global admin | Verify the affected account notification workflow. Do not disclose account existence and do not clear `notification_pending` without delivery evidence. |
| `review_product_notification_queue` | Technician or global admin | Check whether the notification sender exists and is healthy. A queued row is not delivery evidence. Reconcile `claimed`, `failed`, and `reconciliation_required` rows without copying requester PII into tickets. |
| `review_client_error_volume` | Technician or global admin | Inspect the restricted, already-redacted error rows, group by reproducible behavior, and verify a fix in staging. The inbox intentionally withholds raw error text. |
| `run_operations_maintenance` | Technician or global admin | Verify migration/function availability, invoke one manual maintenance run with the existing cron secret, and verify a fresh successful heartbeat. Do not create a schedule without owner approval. |
| `review_billing_webhook_pipeline` | Global admin | Halt entitlement-changing provider work, verify environment and webhook integrity, and follow the billing launch runbook. |
| `reconcile_closed_account_finance` | Global admin | Use the closed-account financial-event procedure. Never recreate an Auth account merely to attach provider data. |
| `review_duplicate_subscription` | Global admin | Follow the duplicate-subscription cancellation and explicit refund-decision workflow. Never infer a refund from cancellation. |
| `review_billing_catalog` | Global admin | Compare the exact configured Stripe Price against the reviewed plan catalog before resuming processing. |
| `reconcile_financial_hold` | Global admin | Use only the dedicated AAL2 financial-hold reconciliation RPC/UI. Record the owner-approved resolution reason. |
| `run_billing_reconciliation` | Global admin | Run the read-only reconciliation worker and retain its bounded result. Do not silently grant access on an unavailable result. |
| `review_billing_reconciliation` | Global admin | Investigate the restricted reconciliation queue and select the type-specific billing procedure. |

## Incident containment

1. Record UTC time, visible alert key, category, severity, count, and the current
   release identifier. Do not copy underlying PII or provider identifiers into
   an ordinary feature ticket.
2. If account takeover, credential exposure, financial inconsistency, or event
   payload conflict is plausible, pause the affected mutation worker before
   attempting remediation.
3. Preserve database/provider evidence. Do not delete an alert row or clear a
   notification flag to make the inbox quiet.
4. Use the type-specific action above. Test the remediation in staging when the
   incident permits.
5. Verify the source condition is actually resolved. Record who verified it,
   when, and which safe runbook action was completed.
6. Restore a paused worker only after the fail-closed condition and its audit
   evidence agree.

## Maintenance worker

`run-operations-maintenance` accepts POST only and compares
`X-Cron-Secret` to the existing `CRON_SECRET`. It calls five fixed, service-only
retention tasks with a batch limit of 500:

- product-review rate-limit expiry;
- affiliate click/rate-limit retention;
- governance and security retention;
- AI-backend budget retention;
- billing retention from migration 068.

Migration 069 adds bounded variants for older unbounded governance/affiliate
cleanup functions. Each delete category is capped independently. A successful
run writes `operations_maintenance_completed`; a partial or failed run writes
`operations_maintenance_failed`. Heartbeat metadata contains fixed task names
and numeric counts only. Database error text is neither stored nor returned.

The Staff queue raises `retention_heartbeat_stale` when no successful heartbeat
exists within 36 hours. A failure row does not count as success.

### Staging activation checklist

1. Apply all predecessor migrations, including billing migration 068 when
   billing retention is expected, then apply mirrored migration 069.
2. Deploy `run-operations-maintenance` with gateway JWT verification disabled;
   the function performs its own exact cron-secret check.
3. Confirm `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the existing
   high-entropy `CRON_SECRET` are present. Never paste their values into this
   runbook, a ticket, browser code, or a command transcript.
4. Invoke one manual POST from an approved secret-bearing environment.
5. Verify the response contains only the five fixed task names and integer
   counts, then verify one new heartbeat row and the AAL2 Staff queue behavior.
6. Test AAL1, ordinary authenticated, technician, and global-administrator
   boundaries with separate accounts.
7. Only after owner approval, create a once-daily provider schedule. Store the
   cron secret in the provider secret store/Vault; never embed it in SQL source.
8. Monitor the first three scheduled executions and confirm that the heartbeat
   remains newer than 36 hours.

### Stop and recovery

- Disable the external schedule first. This repository does not create one.
- Keep the function deployed for a manual diagnostic unless credential exposure
  is suspected; if exposure is suspected, rotate `CRON_SECRET` before retrying.
- Retention deletion is intentionally irreversible. Restore only from the
  approved backup process and only when legal/retention policy authorizes it.
- A rollback of UI/function code does not restore deleted data. Preserve the
  fixed count heartbeat as evidence.

## Known external gaps

- No automatic email/pager delivery or acknowledgement workflow is included.
- The product-review notification table still requires a dedicated sender.
- Ordinary Edge `console.error` output requires an approved log drain or narrow
  durable event writers before it can appear here.
- Database limits are backstops; application-wide WAF/CAPTCHA/rate-limit
  configuration and live drift checks remain provider-side work.
- Production or staging deployment, scheduling, secret installation, and live
  two-account verification require separate owner approval and evidence.
