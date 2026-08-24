import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root=path.resolve(import.meta.dirname,"..");
const read=relative=>readFile(path.join(root,relative),"utf8");
const[
  migration,index,shared,billingShared,checkout,mailboxShared,aiProxy,research,gemini,agentBoard,
  fanChat,runTasks,runMailboxJobs,webhook,deleteAccount,deployWorkflow,
  refundAdmin,
]=await Promise.all([
  read("supabase/migrations/20260823100000_account_subscription_entitlements.sql"),
  read("MyPersonas.Online_v0/index.html"),
  read("supabase/functions/_shared/account-entitlement.ts"),
  read("supabase/functions/_shared/billing.ts"),
  read("supabase/functions/billing-create-checkout/index.ts"),
  read("supabase/functions/_shared/mailbox.ts"),
  read("supabase/functions/ai-proxy/index.ts"),
  read("supabase/functions/research-brief-run/index.ts"),
  read("supabase/functions/gemini-image/index.ts"),
  read("supabase/functions/agent-board-run/index.ts"),
  read("supabase/functions/fan-chat/index.ts"),
  read("supabase/functions/run-tasks/index.ts"),
  read("supabase/functions/run-mailbox-jobs/index.ts"),
  read("supabase/functions/stripe-webhook/index.ts"),
  read("supabase/functions/delete-account/index.ts"),
  read(".github/workflows/supabase-deploy.yml"),
  read("supabase/functions/billing-admin-refund-duplicate/index.ts"),
]);

test("migration defaults to shadow mode and preserves the exact price ladder",()=>{
  assert.match(migration,/enforcement_enabled boolean not null default false/);
  assert.match(migration,/livemode boolean not null default false/);
  assert.match(migration,/\('account_weekly',2000,'usd','week',1\)/);
  assert.match(migration,/\('account_monthly',5000,'usd','month',1\)/);
  assert.match(migration,/\('account_yearly',33300,'usd','year',1\)/);
  assert.match(migration,/revoke all on schema private from public, anon, authenticated/);
  assert.match(migration,/BILLING_RUNTIME_CONFIG_SINGLETON_REQUIRED/);
  assert.match(migration,/coalesce\(\([\s\S]*config\.enforcement_enabled[\s\S]*\),true\)/);
  assert.match(migration,/billing_configuration_unavailable/);
});

test("trial tombstones are keyed fingerprints and browser roles cannot read billing ledgers",()=>{
  const claims=migration.slice(
    migration.indexOf("create table if not exists private.billing_trial_claims"),
    migration.indexOf("create table if not exists private.billing_checkout_reservations"),
  );
  assert.match(claims,/email_fingerprint text not null unique/);
  assert.match(claims,/fingerprint_key_id text not null/);
  assert.match(migration,/p_previous_email_fingerprint text/);
  assert.match(migration,/p_retired_email_fingerprints jsonb/);
  assert.match(migration,/jsonb_array_length\(p_retired_email_fingerprints\)>32/);
  assert.match(migration,/fingerprint_rotated_at=now()/);
  assert.match(billingShared,/BILLING_EMAIL_FINGERPRINT_PREVIOUS_SECRET/);
  assert.match(billingShared,/BILLING_EMAIL_FINGERPRINT_RETIRED_KEYS_JSON/);
  assert.match(checkout,/p_previous_email_fingerprint:/);
  assert.match(checkout,/p_retired_email_fingerprints:/);
  assert.doesNotMatch(claims,/\bemail\s+text\b/i);
  assert.match(migration,/revoke all on all tables in schema private from public,anon,authenticated,service_role/);
  assert.match(migration,/grant execute on function public\.my_billing_status\(\) to authenticated/);
});

test("customer deletion is provider-confirmed before irreversible erasure and retained records are bounded",()=>{
  const cleanup=deleteAccount.indexOf("deleteRetainedStripeCustomer");
  const begin=deleteAccount.indexOf('"billing_begin_account_closure"');
  const cleanupCall=deleteAccount.indexOf("await deleteRetainedStripeCustomer",begin);
  const confirm=deleteAccount.indexOf('"billing_confirm_account_closure"',cleanupCall);
  const destructive=deleteAccount.indexOf("await eraseOwnedStorage",confirm);
  assert.ok(cleanup>0&&begin>0&&cleanupCall>begin&&confirm>cleanupCall&&destructive>confirm);
  assert.match(deleteAccount,/assertCanonicalStripeCustomerBinding/);
  assert.match(deleteAccount,/assertTerminalCustomerSubscriptions/);
  assert.match(deleteAccount,/method: "DELETE"/);
  assert.match(deleteAccount,/billing_confirm_customer_deleted/);
  assert.match(migration,/provider_deleted_at timestamptz/);
  assert.match(migration,/retention_expires_at=coalesce\([\s\S]*interval '7 years'/);
  assert.match(migration,/create or replace function public\.billing_run_retention/);
  assert.match(migration,/billing_account_closures[\s\S]*UUID-only fail-closed tombstones/);
  assert.match(migration,/billing_refund_reconciliation_required/);
  const cleanupCandidate=migration.slice(
    migration.indexOf("create or replace function public.billing_customer_cleanup_candidate"),
    migration.indexOf("create or replace function public.billing_confirm_customer_deleted"),
  );
  assert.match(cleanupCandidate,/billing_duplicate_subscription_remediations/);
  assert.match(cleanupCandidate,/provider_refund_pending/);
});

test("canonical duplicate subscriptions are canceled without proration before ledger application",()=>{
  assert.match(webhook,/billing_duplicate_subscription_candidate/);
  assert.match(webhook,/duplicateSubscriptionCancellation/);
  const candidate=webhook.indexOf('"billing_duplicate_subscription_candidate"');
  const providerDelete=webhook.indexOf('method: "DELETE"',candidate);
  const remediation=webhook.indexOf('"billing_record_duplicate_subscription_remediation"',providerDelete);
  const apply=webhook.indexOf("applySubscriptionSnapshot",remediation);
  assert.ok(candidate>0&&providerDelete>candidate&&remediation>providerDelete&&apply>remediation);
  assert.match(billingShared,/invoice_now: "false", prorate: "false"/);
  assert.match(migration,/duplicate_subscription_refund_review/);
  assert.match(migration,/refund_review_required boolean not null default false/);
});

test("duplicate refunds require AAL2 approval, exact provider proof, and durable recovery",()=>{
  const reviews=migration.slice(
    migration.indexOf("create or replace function public.billing_admin_duplicate_refund_reviews"),
    migration.indexOf("create or replace function public.billing_admin_approve_duplicate_refund"),
  );
  const reviewReturn=reviews.slice(0,reviews.indexOf("language plpgsql"));
  assert.match(reviews,/has_platform_role\(array\['global_administrator'\]/);
  assert.match(reviews,/perform public\.require_aal2\(\)/);
  assert.match(reviewReturn,/remediation_id uuid,masked_email text,state text,amount_minor bigint/);
  assert.doesNotMatch(reviewReturn,/stripe_(?:customer|subscription|invoice|charge|refund)_id/);

  const approval=migration.slice(
    migration.indexOf("create or replace function public.billing_admin_approve_duplicate_refund"),
    migration.indexOf("create or replace function public.billing_duplicate_refund_candidate_for_service"),
  );
  assert.match(approval,/perform public\.require_aal2\(\)/);
  assert.match(approval,/p_remediation_id uuid,p_reason text/);
  assert.ok(approval.indexOf("pg_advisory_xact_lock")<approval.indexOf("for update"));
  assert.match(approval,/state='refund_pending'/);
  assert.match(approval,/billing_duplicate_refund_approved/);

  assert.match(migration,/grant execute on function public\.billing_duplicate_refund_candidate_for_service\(uuid\)[\s\S]{0,80}to service_role/);
  assert.match(migration,/grant execute on function public\.billing_bind_duplicate_refund_charge\([\s\S]{0,180}to service_role/);
  assert.match(migration,/create or replace function public\.billing_record_duplicate_refund_result/);
  assert.match(migration,/create or replace function public\.billing_apply_expected_duplicate_refund_event/);
  assert.match(migration,/state='refund_review_required'/);
  assert.match(migration,/Automatic retry is disabled/);

  assert.match(refundAdmin,/const assurance = await requireAal2\(req, service\)/);
  assert.match(refundAdmin,/Authorization: `Bearer \$\{assurance\.token\}`/);
  assert.doesNotMatch(refundAdmin,/body\.(?:amount|charge|customer|invoice|refund|subscription)/);
  const approve=refundAdmin.indexOf('"billing_admin_approve_duplicate_refund"');
  const bind=refundAdmin.indexOf('"billing_bind_duplicate_refund_charge"',approve);
  const providerRefund=refundAdmin.indexOf('"/v1/refunds"',bind);
  const record=refundAdmin.indexOf('"billing_record_duplicate_refund_result"');
  assert.ok(approve>0&&bind>approve&&providerRefund>bind&&record>0);
  assert.match(refundAdmin,/duplicateRefundRequest/);
  assert.match(refundAdmin,/assertRefundablePaidInvoice/);
  assert.match(refundAdmin,/assertCanonicalInvoicePaymentListForRefund/);
  assert.match(refundAdmin,/assertCanonicalPaymentIntentForRefund/);
  assert.match(refundAdmin,/assertCanonicalRefundableCharge/);

  const expected=webhook.indexOf("billing_apply_expected_duplicate_refund_event");
  const generic=webhook.indexOf('admin.rpc("billing_apply_financial_hold_event"',expected);
  assert.ok(expected>0&&generic>expected,
    "only an exact expected duplicate refund may bypass the generic hold");
  assert.match(webhook,/assertCanonicalExpectedRefundedCharge/);
});

test("billing financial holds use the predecessor-approved security event source",()=>{
  const holdEvents=[...migration.matchAll(/'billing_financial_hold_opened','critical','([^']+)'/g)];
  assert.equal(holdEvents.length,2);
  assert.deepEqual(holdEvents.map(match=>match[1]),["edge_function","edge_function"]);
  assert.doesNotMatch(migration,/'billing_financial_hold_opened','critical','automated'/);
});

test("publication, business pages, discovery, and both AI queue stages use server entitlements",()=>{
  assert.match(migration,/account_has_billing_access\(persona\.owner\)/);
  assert.match(migration,/account_has_billing_access\(business\.owner\)/);
  assert.match(migration,/create or replace function public\.account_can_search_personas\(\)/);
  assert.match(migration,/message='BILLING_REQUIRED'/);
  assert.match(migration,/create policy "personas visible read"[\s\S]*account_can_search_personas\(\)/);
  assert.match(migration,/due_ai_generation_tasks[\s\S]*account_has_billing_access\(task\.owner\)/);
  assert.match(migration,/claim_ai_task_generation[\s\S]*account_has_billing_access\(v_task\.owner\)/);
});

test("public directory and Top 8 lookups use the gated cursor RPC",()=>{
  assert.match(index,/function publicPersonaQuery\(state\)\{return sb\.rpc\("discover_personas_page"/);
  assert.match(index,/const\{data,error\}=await sb\.rpc\("discover_personas_page",\{p_query:q,p_limit:8/);
  assert.match(index,/BILLING_REQUIRED/);
  assert.doesNotMatch(index,/function publicPersonaQuery\(state\)[^\n]*\.from\("personas"\)/);
  assert.match(migration,/create or replace function public\.owner_persona_top8_cards\(p_persona_id uuid\)/);
  assert.match(migration,/where persona\.id=p_persona_id and persona\.owner=auth\.uid\(\)/);
  assert.match(index,/sb\.rpc\("owner_persona_top8_cards",\{p_persona_id:targetId\}\)/);
  assert.doesNotMatch(index,/\(p\.top8\|\|\[\]\)\.length\?sb\.from\("personas"\)/);
});

test("AI boundaries fail closed and recheck before provider work",()=>{
  assert.match(shared,/if \(result\.error \|\| typeof result\.data !== "boolean"\)/);
  assert.match(shared,/allowed: false, unavailable: true/);
  for(const[source,name,minimum]of[
    [aiProxy,"ai-proxy",2],
    [research,"research-brief-run",2],
    [gemini,"gemini-image",2],
    [runTasks,"run-tasks",2],
    [agentBoard,"agent-board-run",1],
    [fanChat,"fan-chat",1],
  ]){
    assert.match(source,/\.\.\/_shared\/account-entitlement\.ts/,`${name} does not import the entitlement guard`);
    assert.ok((source.match(/accountBillingAccess\(/g)||[]).length>=minimum,`${name} does not perform the required entitlement checks`);
  }
});

test("AI mailbox schedules, claimed scans, and provider calls are all billing gated",()=>{
  assert.match(mailboxShared,/\.\/account-entitlement\.ts/);
  assert.ok((mailboxShared.match(/accountBillingAccess\(admin, owner\)/g)||[]).length>=2);
  const classify=mailboxShared.slice(mailboxShared.indexOf("export async function mailboxAiClassify"));
  const firstClassifyGate=classify.indexOf("accountBillingAccess(admin, owner)");
  const secondClassifyGate=classify.indexOf("accountBillingAccess(admin, owner)",firstClassifyGate+1);
  const providerFetch=classify.indexOf("await fetch(");
  assert.ok(firstClassifyGate>=0&&secondClassifyGate>firstClassifyGate&&providerFetch>secondClassifyGate,
    "mailbox AI classification must recheck entitlement immediately before provider fetch");

  assert.match(runMailboxJobs,/\.\.\/_shared\/account-entitlement\.ts/);
  const enqueue=runMailboxJobs.slice(
    runMailboxJobs.indexOf("async function enqueueDueScans"),
    runMailboxJobs.indexOf("function suggestedAction"),
  );
  assert.match(enqueue,/setting\.classifier_mode === "ai"[\s\S]*accountBillingAccess\(admin, setting\.owner\)/);
  assert.ok(enqueue.indexOf("accountBillingAccess(admin, setting.owner)")<enqueue.indexOf("ownedMailboxContext("),
    "scheduled AI scans must be gated before mailbox context or queue creation");
  assert.match(enqueue,/scan\.schedule_skipped_billing/);

  const process=runMailboxJobs.slice(
    runMailboxJobs.indexOf("async function processOneScan"),
    runMailboxJobs.indexOf("async function completeScan"),
  );
  const claimedScanGate=process.indexOf("accountBillingAccess(admin, run.owner)");
  assert.ok(claimedScanGate>=0&&claimedScanGate<process.indexOf("gmailAccessToken("),
    "claimed AI scans must be gated before Gmail authorization or metadata reads");
  assert.match(process,/failScanForBilling\(/);
  assert.match(runMailboxJobs,/billing_verification_unavailable/);
  assert.match(runMailboxJobs,/billing_membership_inactive/);

  const aiClassification=process.indexOf("mailboxAiClassify(");
  const findingPersistence=process.indexOf("persistScannedMessage(",aiClassification);
  const postClassificationGate=process.indexOf(
    "const persistenceEntitlement = await accountBillingAccess",
    aiClassification,
  );
  assert.ok(
    aiClassification>=0&&postClassificationGate>aiClassification&&
      findingPersistence>postClassificationGate,
    "AI-configured scans must recheck entitlement after classification and before persisting even rule-based findings",
  );
  const persistenceBarrier=process.slice(postClassificationGate,findingPersistence);
  assert.match(persistenceBarrier,/if \(!\w+\.allowed\)[\s\S]*return true/);
});

test("run-tasks performs bounded suspended maintenance without starving paid due work",()=>{
  const worker=runTasks.slice(runTasks.indexOf("serve(async (req) =>"));
  const advance=worker.indexOf('"advance_suspended_ai_generation_tasks"');
  const due=worker.indexOf('"due_ai_generation_tasks"');
  assert.ok(advance>=0&&due>advance,"suspended maintenance must run before due tasks are selected");
  const advanceGuard=worker.slice(advance,due);
  assert.match(advanceGuard,/typeof pausedBilling !== "number"/);
  assert.match(advanceGuard,/Number\.isSafeInteger\(pausedBilling\)/);
  assert.doesNotMatch(advanceGuard,/Number\(pausedBilling\)/,
    "null must not be coerced to a successful zero-row advancement");
  assert.match(worker,/Suspended task schedules could not be advanced/);
  assert.match(worker,/\bpausedBilling(?:\s*:|\s*,)/);
  assert.match(runTasks,/const SUSPENDED_ADVANCE_BATCH_SIZE = 100/);
  assert.equal((worker.match(/"advance_suspended_ai_generation_tasks"/g)||[]).length,1,
    "maintenance must be one bounded best-effort batch per worker invocation");
  assert.doesNotMatch(worker,/suspendedBacklogDrained|no paid work was started/,
    "a global inactive backlog must not gate entitled work");
  const privateAdvance=migration.slice(
    migration.indexOf("create or replace function private.advance_suspended_ai_generation_tasks"),
    migration.indexOf("create or replace function public.advance_suspended_ai_generation_tasks"),
  );
  const publicAdvance=migration.slice(
    migration.indexOf("create or replace function public.advance_suspended_ai_generation_tasks"),
    migration.indexOf("create or replace function public.due_ai_generation_tasks"),
  );
  assert.match(privateAdvance,/not public\.account_has_billing_access\(task\.owner\)/);
  assert.match(privateAdvance,/order by task\.owner/);
  assert.match(privateAdvance,/last_status='paused_billing'/);
  assert.match(privateAdvance,/p_due_at\+interval '1 minute'/);
  const accountLock=privateAdvance.indexOf("pg_advisory_xact_lock");
  const freshRecheck=privateAdvance.indexOf("if public.account_has_billing_access(v_account_id) then");
  const taskLock=privateAdvance.indexOf("for update skip locked");
  assert.ok(accountLock>=0&&freshRecheck>accountLock&&taskLock>freshRecheck,
    "maintenance must lock account, recheck entitlement, then lock task rows");
  assert.match(publicAdvance,/select private\.advance_suspended_ai_generation_tasks\(p_due_at,p_limit\)/);
  assert.match(publicAdvance,/grant execute[\s\S]*to service_role/);
});

test("every access restoration path terminalizes overdue automation under the account lock",()=>{
  const helper=migration.slice(
    migration.indexOf("create or replace function private.advance_account_ai_tasks_past_due"),
    migration.indexOf("create or replace function public.billing_admin_grant_developer"),
  );
  assert.match(helper,/pg_advisory_xact_lock/);
  assert.match(helper,/public\.post_drafts[\s\S]*status='failed'/);
  assert.match(helper,/public\.drafts[\s\S]*publish_state='blocked'/);
  assert.match(helper,/publish_next_attempt_at=null/);
  assert.match(helper,/Billing membership was inactive/);

  const developerGrant=migration.slice(
    migration.indexOf("create or replace function public.billing_admin_grant_developer"),
    migration.indexOf("create or replace function public.billing_admin_revoke_developer"),
  );
  const developerRevoke=migration.slice(
    migration.indexOf("create or replace function public.billing_admin_revoke_developer"),
    migration.indexOf("create or replace function public.billing_plan_for_service"),
  );
  const developerAccountLock=developerGrant.indexOf("pg_advisory_xact_lock");
  const closureGuard=developerGrant.indexOf("ACCOUNT_CLOSURE_BLOCKS_DEVELOPER_ACCESS");
  const restoration=developerGrant.indexOf("advance_account_ai_tasks_past_due");
  const grantMutation=developerGrant.indexOf("insert into private.billing_developer_grants");
  assert.ok(developerAccountLock>=0&&closureGuard>developerAccountLock&&
    restoration>closureGuard&&grantMutation>restoration,
  "closure rejection and overdue terminalization must precede developer-grant mutation");
  assert.match(developerGrant,/status in \('provider_pending','session_created'\)/);
  assert.match(developerGrant,/reservation\.status='completed'[\s\S]*stripe_subscription_id/);
  assert.equal(
    (developerGrant.match(/billing_entitlement_snapshot\(p_account_id\)/g)??[]).length,
    2,
    "developer grants must snapshot authoritative state before and after mutation",
  );
  assert.match(developerGrant,/if v_previous_state is distinct from v_new_state then/);
  assert.doesNotMatch(developerGrant,/'subscription_required','developer_active'/);
  assert.equal(
    (developerRevoke.match(/billing_entitlement_snapshot\(p_account_id\)/g)??[]).length,
    2,
    "developer revokes must snapshot authoritative state before and after mutation",
  );
  assert.match(developerRevoke,/if v_previous_state is distinct from v_new_state then/);
  assert.doesNotMatch(developerRevoke,/'developer_active','subscription_required'/);

  const subscriptionApply=migration.slice(
    migration.indexOf("create or replace function public.billing_apply_subscription_event"),
    migration.indexOf("create or replace function public.billing_mark_webhook_failed"),
  );
  const staleDecision=subscriptionApply.indexOf("if v_rows=0 then");
  const acceptedSnapshot=subscriptionApply.indexOf("into v_new_state,v_new_access");
  const subscriptionRestoration=subscriptionApply.indexOf("advance_account_ai_tasks_past_due");
  assert.ok(staleDecision>=0&&acceptedSnapshot>staleDecision&&
    subscriptionRestoration>acceptedSnapshot,
  "only an accepted canonical subscription transition may terminalize overdue work");
  assert.match(subscriptionApply,/not coalesce\(v_previous_access,false\)[\s\S]*coalesce\(v_new_access,false\)/);
});

test("webhook ownership, duplicate leases, crash recovery, and financial review are durable",()=>{
  assert.match(migration,/billing_webhook_event_disposition/);
  assert.match(migration,/return 'terminal'/);
  assert.match(migration,/return 'active'/);
  assert.match(migration,/webhook_retry_exhausted/);
  assert.match(migration,/billing_mark_webhook_review_required/);
  assert.match(migration,/create table if not exists private\.billing_financial_holds/);
  assert.match(migration,/create or replace function public\.billing_apply_financial_hold_event/);
  assert.match(migration,/create or replace function public\.billing_apply_customer_financial_hold_event/);
  assert.match(migration,/create or replace function public\.billing_admin_financial_holds/);
  assert.match(migration,/create or replace function public\.billing_admin_reconcile_financial_hold/);
  assert.match(migration,/financial_event_linkage_unproven/);
  assert.match(migration,/financial_review_hold/);
  assert.match(migration,/duplicate_renewable_subscription/);
  assert.match(migration,/processing_state='review_required'[\s\S]*last_error='duplicate_renewable_subscription'/);
  assert.match(migration,/processing_state='review_required'/);
  assert.match(webhook,/billing_record_webhook_event/);
  assert.match(webhook,/billing_webhook_event_disposition/);
  assert.match(webhook,/billing_mark_webhook_review_required/);
  assert.match(webhook,/billing_apply_financial_hold_event/);
  assert.match(webhook,/billing_apply_customer_financial_hold_event/);
  assert.match(webhook,/canonicalFinancialOwnership/);
  assert.match(webhook,/financialCharge\.charge\.customerId/);
  const adminHoldList=migration.slice(
    migration.indexOf("create or replace function public.billing_admin_financial_holds"),
    migration.indexOf("create or replace function public.billing_admin_reconcile_financial_hold"),
  );
  const adminHoldReturn=adminHoldList.slice(0,adminHoldList.indexOf("language plpgsql"));
  assert.match(adminHoldList,/hold_id uuid,account_id uuid,masked_email text,event_category text/);
  assert.doesNotMatch(adminHoldReturn,/stripe_(?:customer|subscription|invoice)_id/);
  assert.doesNotMatch(adminHoldReturn,/source_event_id/);
  const reconcileHold=migration.slice(
    migration.indexOf("create or replace function public.billing_admin_reconcile_financial_hold"),
    migration.indexOf("create or replace function public.billing_mark_webhook_failed"),
  );
  assert.match(reconcileHold,/p_hold_id uuid,p_reason text/);
  assert.ok(reconcileHold.indexOf("pg_advisory_xact_lock")<reconcileHold.indexOf("for update"),
    "hold reconciliation must acquire the account lock before the child-row lock");
});

test("full account erasure fails closed while billing can still charge",()=>{
  assert.match(migration,/create or replace function public\.billing_account_deletion_guard\(p_account_id uuid\)/);
  assert.match(migration,/sub\.status not in \('canceled','incomplete_expired'\)/);
  const deletionGuard=migration.slice(
    migration.indexOf("create or replace function public.billing_account_deletion_guard"),
    migration.indexOf("create or replace function public.billing_begin_account_closure"),
  );
  assert.match(deletionGuard,/status in \('reserved','provider_pending','session_created'\)/);
  assert.match(deletionGuard,/billing_financial_hold_reconciliation_required/);
  assert.match(deleteAccount,/billing_account_deletion_guard/);
  assert.match(deleteAccount,/Billing cancellation could not be verified\. No account erasure work was started\./);
  assert.match(deleteAccount,/billingCancellationRequired: true/);
  const guard=deleteAccount.indexOf("billing_account_deletion_guard");
  const destructive=deleteAccount.indexOf("await eraseOwnedStorage",guard);
  assert.ok(guard>0&&destructive>guard,"billing guard must run before destructive account erasure");
});

test("a verified webhook can reconcile provider-pending Checkout without weakening ownership",()=>{
  const applyCheckout=migration.slice(
    migration.indexOf("create or replace function public.billing_apply_checkout_event"),
    migration.indexOf("create or replace function public.billing_apply_subscription_event"),
  );
  assert.match(applyCheckout,/p_reservation_id uuid/);
  assert.match(applyCheckout,/reservation\.id=p_reservation_id/);
  assert.match(applyCheckout,/reservation\.account_id=p_account_id/);
  assert.match(applyCheckout,/reservation\.status in \('provider_pending','session_created'\)/);
  assert.match(applyCheckout,/p_trial_start timestamptz,p_trial_end timestamptz/);
  assert.match(applyCheckout,/p_trial_end<>p_trial_start\+interval '7 days'/);
  assert.match(applyCheckout,/returning reservation\.trial_eligible into v_trial_eligible/);
  assert.match(applyCheckout,/claim_state='consumed'/);
  assert.match(applyCheckout,/claim\.consumed_subscription_id=p_subscription_id/);
  assert.match(applyCheckout,/Canonical Checkout trial claim could not be bound/);
  assert.match(applyCheckout,/grant execute[\s\S]*to service_role/);
  assert.match(webhook,/p_reservation_id:\s*checkout\.reservationId/);
  assert.match(webhook,/p_trial_start:\s*canonicalTrialStart/);
  assert.match(webhook,/p_trial_end:\s*canonicalTrialEnd/);
  assert.match(webhook,/applied\.error \|\| applied\.data !== true/);
  const prepareCheckout=migration.slice(
    migration.indexOf("create or replace function public.billing_prepare_checkout"),
    migration.indexOf("create or replace function public.billing_bind_customer"),
  );
  assert.match(prepareCheckout,/set status='abandoned'/);
  assert.doesNotMatch(prepareCheckout,/reservation\.status='provider_pending' then 'expired'/);
});

test("Checkout completion and trial identity remain blocked until exact reconciliation",()=>{
  const reservationSchema=migration.slice(
    migration.indexOf("create table if not exists private.billing_checkout_reservations"),
    migration.indexOf("create table if not exists private.billing_subscriptions"),
  );
  assert.match(reservationSchema,/stripe_subscription_id text unique/);

  const prepareCheckout=migration.slice(
    migration.indexOf("create or replace function public.billing_prepare_checkout"),
    migration.indexOf("create or replace function public.billing_bind_customer"),
  );
  assert.match(prepareCheckout,/reservation\.status='completed'/);
  assert.match(prepareCheckout,/sub\.stripe_subscription_id=reservation\.stripe_subscription_id/);
  assert.match(prepareCheckout,/raise exception 'Checkout reconciliation is required'/);

  const applyCheckout=migration.slice(
    migration.indexOf("create or replace function public.billing_apply_checkout_event"),
    migration.indexOf("create or replace function public.billing_apply_subscription_event"),
  );
  assert.match(applyCheckout,/stripe_checkout_session_id=coalesce\(reservation\.stripe_checkout_session_id,p_session_id\)/);
  assert.match(applyCheckout,/stripe_subscription_id=case when p_checkout_status='complete'/);
  assert.match(applyCheckout,/p_checkout_status='expired' and reservation\.status='expired'/);
  assert.match(applyCheckout,/reservation\.stripe_checkout_session_id=p_session_id/);
  assert.match(applyCheckout,/reservation\.trial_eligible/);
  assert.match(applyCheckout,/claim\.account_id=p_account_id/);
  assert.match(applyCheckout,/claim\.claim_state='reserved'/);
  assert.match(applyCheckout,/claim\.consumed_subscription_id=p_subscription_id/);

  const applySubscription=migration.slice(
    migration.indexOf("create or replace function public.billing_apply_subscription_event"),
    migration.indexOf("create or replace function public.billing_mark_webhook_failed"),
  );
  assert.match(applySubscription,
    /consumed_subscription_id=coalesce\(claim\.consumed_subscription_id,p_subscription_id\)/);
  assert.match(applySubscription,
    /claim\.claim_state='consumed'[\s\S]*claim\.consumed_subscription_id=p_subscription_id/);
});

test("full account erasure holds one closure token through begin, confirm, and completion",()=>{
  for(const rpc of[
    "billing_begin_account_closure",
    "billing_confirm_account_closure",
    "billing_complete_account_closure",
  ])assert.match(deleteAccount,new RegExp(`admin\\.rpc\\(\\s*"${rpc}"`));
  assert.match(deleteAccount,/const requestedClosureToken = crypto\.randomUUID\(\)/);
  assert.match(deleteAccount,/billingClosureToken = returnedToken/);
  assert.match(deleteAccount,/p_closure_token: billingClosureToken/g);

  const begin=deleteAccount.indexOf('"billing_begin_account_closure"');
  const confirm=deleteAccount.indexOf('"billing_confirm_account_closure"');
  const firstOwnedRead=deleteAccount.indexOf("listOwnedPersonaIds(admin, uid)",confirm);
  const firstDestructive=deleteAccount.indexOf("await eraseOwnedStorage",confirm);
  const deleteUser=deleteAccount.indexOf("admin.auth.admin.deleteUser",confirm);
  const complete=deleteAccount.indexOf('"billing_complete_account_closure"',deleteUser);
  assert.ok(begin>0&&confirm>begin&&firstOwnedRead>confirm&&firstDestructive>confirm,
    "closure confirmation must precede owned-data reads and destructive erasure");
  assert.ok(deleteUser>firstDestructive&&complete>deleteUser,
    "the durable closure tombstone must complete only after sign-in deletion succeeds");
  assert.match(deleteAccount,/billingClosureFinalized: false[\s\S]*operator reconciliation check/);

  const confirmationFailure=deleteAccount.slice(confirm,firstOwnedRead);
  assert.match(
    confirmationFailure,
    /withMetaOwnerErasureRelease\(|release_meta_owner_erasure/,
    "a billing-confirm failure happens before destructive work and must release the Meta erasure lease",
  );
});

test("billing deployment keeps test Checkout off the configured production project",()=>{
  assert.match(deployWorkflow,/staging_project_ref:/);
  assert.match(deployWorkflow,/BILLING-068-TESTMODE-VERIFIED/);
  assert.match(deployWorkflow,/BILLING-068-SHADOW-VERIFIED/);
  assert.match(deployWorkflow,/MIGRATIONS-062-064-GATEWAY-VERIFIED\+BILLING-068-SHADOW-VERIFIED/);
  assert.match(deployWorkflow,/OPAQUE-FRONTEND-VERIFIED\+BILLING-068-SHADOW-VERIFIED/);
  assert.match(deployWorkflow,/\^\[a-z0-9\]\{20\}\$/);
  assert.match(deployWorkflow,/name: \$\{\{ inputs\.release_scope == 'billing-test-boundary' && 'supabase-staging' \|\| 'production' \}\}/);
  assert.match(deployWorkflow,/STAGING_SUPABASE_ACCESS_TOKEN/);
  assert.match(deployWorkflow,/PRODUCTION_SUPABASE_ACCESS_TOKEN/);
  assert.doesNotMatch(deployWorkflow,/secrets\.SUPABASE_ACCESS_TOKEN/);
  assert.match(deployWorkflow,/APPROVED_BILLING_STAGING_PROJECT_REF: \$\{\{ secrets\.STAGING_SUPABASE_PROJECT_REF \}\}/);
  assert.match(deployWorkflow,/supabase\/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520/);
  assert.match(deployWorkflow,/version: 2\.115\.0/);
  assert.doesNotMatch(deployWorkflow,/version: latest/);
  assert.match(deployWorkflow,/test "\$\{BILLING_STAGING_PROJECT_REF\}" = "\$\{APPROVED_BILLING_STAGING_PROJECT_REF\}"/);
  assert.match(deployWorkflow,/test "\$\{APPROVED_BILLING_STAGING_PROJECT_REF\}" != "\$\{production_ref\}"/);
  assert.match(deployWorkflow,/if \[ "\$\{RELEASE_SCOPE\}" = "billing-test-boundary" \][\s\S]*ref="\$\{APPROVED_BILLING_STAGING_PROJECT_REF\}"/);
  assert.match(deployWorkflow,/for function_name in billing-create-checkout billing-create-portal billing-admin-refund-duplicate stripe-webhook billing-reconcile/);
  assert.match(deployWorkflow,/for function_name in ai-proxy research-brief-run gemini-image agent-board-run fan-chat run-tasks run-mailbox-jobs run-post-queue run-publish-queue delete-account/);
});
