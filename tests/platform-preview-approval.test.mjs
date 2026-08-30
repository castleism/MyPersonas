import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root=path.resolve(import.meta.dirname,"..");
const html=await readFile(path.join(root,"MyPersonas.Online_v0/index.html"),"utf8");
const approvalFunction=await readFile(path.join(root,"supabase/functions/approve-post-draft/index.ts"),"utf8");
const migration=await readFile(path.join(root,"MyPersonas.Online_v0/sql-updates/065-post-preview-approval-gate.sql"),"utf8");
const agentPreviewMigration=await readFile(path.join(root,"MyPersonas.Online_v0/sql-updates/069-agent-draft-platform-preview-gate.sql"),"utf8");

function functionBody(name){
  const start=html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`${name} must exist`);
  const next=html.indexOf("\nfunction ",start+10);
  return html.slice(start,next<0?html.length:next);
}

test("every 3-part scheduling action starts with platform previews",()=>{
  assert.match(html,/onclick="composerPreviewSchedule\('\$\{d\.id\}'\)">Preview &amp; schedule/);
  assert.doesNotMatch(html,/onclick="composerSchedule\('\$\{d\.id\}'\)">Approve &amp; schedule/);
  const preview=functionBody("composerPreviewSchedule");
  assert.match(preview,/composerPreviewBinding/);
  assert.match(preview,/composerPreviewItems/);
  assert.match(preview,/openPlatformPreviewDialog/);
  assert.match(preview,/Approve previews & schedule/);
});

test("the preview dialog requires an explicit all-platform acknowledgement",()=>{
  const dialog=functionBody("openPlatformPreviewDialog");
  assert.match(dialog,/id="platformPreviewAck" type="checkbox" disabled/);
  assert.match(dialog,/I reviewed every platform placement, exact target\/account, full copy and counts, every media asset, safe-area guidance, and action timing/);
  assert.match(dialog,/id="platformPreviewConfirm"[^>]*disabled/);
  assert.match(dialog,/initializePlatformPreviewRequirements\(overlay\)/);
  assert.match(dialog,/updatePlatformPreviewConfirmation\(overlay\)/);
  assert.match(dialog,/Any material edit clears acknowledgement and requires a fresh server preview/);
});

test("schedule and immediate publish both reject missing or stale previews",()=>{
  const schedule=functionBody("composerSchedule"),publish=functionBody("composerPublish");
  for(const body of [schedule,publish]){
    assert.match(body,/composerPreviewProofs\.get\(id\)/);
    assert.match(body,/composerPreviewKey/);
    assert.match(body,/proof\.key!==currentKey/);
    assert.match(body,/composerPreviewProofs\.delete\(id\)/);
  }
  assert.match(schedule,/action:"prepare-schedule"/);
  assert.match(schedule,/exactOwnerPreviewReceipt/);
  assert.match(schedule,/acknowledge_post_draft_schedule_preview_receipt/);
  assert.match(schedule,/requireAcknowledged:true/);
  assert.match(schedule,/composerCommitSchedule/);
  assert.doesNotMatch(schedule,/previewConfirmed|previewFacebookPageId|previewInstagramBusinessId/);
});

test("generic queue approvals also render the exact destination preview first",()=>{
  const approval=html.slice(html.indexOf("async function approveAutomationDraft("),html.indexOf("async function rejectAutomationDraft("));
  assert.match(approval,/openPlatformPreviewDialog/);
  assert.match(approval,/account:autoTargetName\(d\.account_id,d\.platform\)/);
  assert.match(approval,/scheduledFor:approvedFor/);
  assert.match(approval,/issue_agent_draft_preview_receipt/);
  assert.match(approval,/acknowledge_agent_draft_preview_receipt/);
  assert.match(approval,/consume_acknowledged_agent_draft_preview/);
  assert.match(approval,/requireAal2ForSensitiveAction/);
  assert.match(approval,/requireAcknowledged:true/);
  assert.doesNotMatch(approval,/ledger:\$\{account\.id\}|p_preview_target_id|p_preview_version/);
  assert.ok(approval.indexOf("issue_agent_draft_preview_receipt")<approval.indexOf("acknowledge_agent_draft_preview_receipt"));
  assert.ok(approval.indexOf("acknowledge_agent_draft_preview_receipt")<approval.indexOf("consume_acknowledged_agent_draft_preview"));
});

test("owner-triggered X publishing renders the exact account and text before calling the writer",()=>{
  const preview=html.slice(html.indexOf("async function publishTwitterDraft("),html.indexOf("async function executeTwitterDraftPublish("));
  const publish=html.slice(html.indexOf("async function executeTwitterDraftPublish("),html.indexOf("async function markManualDraftPosted("));
  assert.match(preview,/openPlatformPreviewDialog/);
  assert.match(preview,/provider:"twitter"/);
  assert.match(preview,/account:`@\$\{normalizeLedgerUsername\(account\.username\)\}`/);
  assert.match(preview,/Approve preview & post to X/);
  assert.ok(preview.indexOf("openPlatformPreviewDialog")<preview.indexOf("executeTwitterDraftPublish"));
  assert.match(publish,/providerPostAction\("twitter-post",\{action:"prepare-publish-draft",draftId:id\}\)/);
  assert.match(publish,/openImmediateReceiptPreview/);
  assert.match(publish,/providerPostAction\("twitter-post",\{action:"publish-draft",draftId:id,receiptId\}\)/);
});

test("X and Meta write scopes require separate explicit owner reauthorization",()=>{
  const x=html.slice(html.indexOf("async function enableTwitterPosting("),html.indexOf("async function finishPendingTwitter("));
  const meta=html.slice(html.indexOf("async function enableMetaPublishing("),html.indexOf("async function finishPendingMeta("));
  assert.match(x,/disconnect/);
  assert.match(x,/connectTwitter\(id,true\)/);
  assert.match(x,/tweet\.write/);
  assert.match(meta,/requestPublishing:true/);
  assert.match(meta,/publishTargets/);
  assert.match(meta,/does not schedule or publish anything/);
});

test("the X platform mockup shows the provider payload rather than its internal Queue title",()=>{
  const card=functionBody("platformPreviewCardHtml");
  assert.match(card,/provider==="twitter"/);
  assert.match(card,/rawText\.trim\(\)\|\|rawTitle\.trim\(\)/);
  assert.match(card,/rawTags\.trim\(\)/);
  assert.ok(!/titlePlatforms=new Set\(\[[^\]]*"twitter"/.test(card));
});

test("Meta previews identify exact provider targets",()=>{
  const binding=functionBody("composerPreviewBinding"),items=functionBody("composerPreviewItems");
  assert.match(binding,/facebook_page_id,facebook_page_name,instagram_business_id,instagram_username/);
  assert.match(items,/accountId:provider==="facebook"\?binding\.facebookPageId/);
  assert.match(items,/binding\.instagramBusinessId/);
});

test("the approval boundary rejects raw confirmation and exposes prepare or receipt-only commit",()=>{
  assert.match(approvalFunction,/action !== "prepare-schedule"/);
  assert.match(approvalFunction,/action === "commit-schedule"/);
  assert.match(approvalFunction,/Raw preview confirmations and browser-supplied provider targets are not accepted/);
  assert.match(approvalFunction,/issue_post_draft_schedule_preview_receipt_service/);
  assert.match(approvalFunction,/consume_acknowledged_post_draft_schedule_preview_service/);
  assert.doesNotMatch(approvalFunction,/approve_and_schedule_previewed_post_draft/);
  assert.doesNotMatch(approvalFunction,/previewConfirmed =|p_preview_facebook_page_id|p_preview_instagram_business_id/);
});

test("the database makes preview evidence mandatory for scheduled drafts",()=>{
  assert.match(migration,/approved_preview_version text not null default ''/);
  assert.match(migration,/approved_preview_hash text not null default ''/);
  assert.match(migration,/create constraint trigger assert_scheduled_post_draft_preview/);
  assert.match(migration,/deferrable initially deferred/);
  assert.match(migration,/approved_preview_hash is distinct from v_expected/);
  assert.match(migration,/create table if not exists public\.post_draft_schedule_preview_receipts/);
  assert.match(migration,/post_draft_schedule_preview_snapshot/);
  assert.match(migration,/issue_post_draft_schedule_preview_receipt_service/);
  assert.match(migration,/acknowledge_post_draft_schedule_preview_receipt/);
  assert.match(migration,/consume_acknowledged_post_draft_schedule_preview_service/);
  assert.match(migration,/perform public\.require_aal2\(\)/);
  assert.match(migration,/drop function if exists public\.approve_and_schedule_previewed_post_draft/);
  assert.match(migration,/revoke execute on function public\.approve_and_schedule_post_draft/);
  assert.match(migration,/Unschedule existing post drafts and review their platform previews/);
});

test("the general Queue also requires durable preview evidence and an exact target",()=>{
  assert.match(agentPreviewMigration,/approved_preview_target_id text not null default ''/);
  assert.match(agentPreviewMigration,/agent_draft_expected_preview_target/);
  assert.match(agentPreviewMigration,/create constraint trigger assert_approved_agent_draft_preview/);
  assert.match(agentPreviewMigration,/deferrable initially deferred/);
  assert.match(agentPreviewMigration,/create table if not exists public\.agent_draft_preview_receipts/);
  assert.match(agentPreviewMigration,/issue_agent_draft_preview_receipt/);
  assert.match(agentPreviewMigration,/acknowledge_agent_draft_preview_receipt/);
  assert.match(agentPreviewMigration,/consume_acknowledged_agent_draft_preview/);
  assert.match(agentPreviewMigration,/draft\.approve_and_queue/);
  assert.match(agentPreviewMigration,/perform public\.require_aal2\(\)/);
  assert.match(agentPreviewMigration,/drop function if exists public\.approve_previewed_agent_draft/);
  assert.match(agentPreviewMigration,/revoke execute on function public\.approve_agent_draft\(uuid,timestamptz\)/);
});
