import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const [migration, mirror, html, meta, twitter, reddit, discord] = await Promise.all([
  read("MyPersonas.Online_v0/sql-updates/072-immediate-provider-preview-receipts.sql"),
  read("supabase/migrations/20260830150000_immediate_provider_preview_receipts.sql"),
  read("MyPersonas.Online_v0/index.html"),
  read("supabase/functions/meta-post/index.ts"),
  read("supabase/functions/twitter-post/index.ts"),
  read("supabase/functions/reddit-post/index.ts"),
  read("supabase/functions/discord-post/index.ts"),
]);

function sqlFunctionBlock(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} was not found`);
  const end = source.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${signature} has an unterminated SQL body`);
  return source.slice(start, end + 4);
}

function htmlFunctionBlock(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const next = html.indexOf("\nfunction ", start + 10);
  return html.slice(start, next < 0 ? html.length : next);
}

test("migration 072 and its release mirror are byte-identical", () => {
  assert.equal(mirror, migration);
});

test("receipts are private, short-lived, AAL2-acknowledged, exact, and one-shot", () => {
  assert.match(migration, /create table if not exists public\.immediate_provider_preview_receipts/);
  assert.match(migration, /check \(expires_at > created_at and expires_at <= created_at \+ interval '5 minutes'\)/);
  assert.match(migration, /revoke all on public\.immediate_provider_preview_receipts\s+from public, anon, authenticated/);
  assert.match(migration, /v_expires := v_created \+ interval '3 minutes'/);
  assert.match(migration, /update public\.immediate_provider_preview_receipts set invalidated_at = v_created/);
  assert.match(migration, /consumed_at = clock_timestamp\(\),consumed_claim_id = p_claim_id/);
  assert.match(migration, /where id = v_receipt\.id and consumed_at is null and invalidated_at is null/);
  assert.match(migration, /v_receipt\.expires_at <= clock_timestamp\(\)/);
  assert.match(migration, /v_receipt\.receipt_hash is distinct from v_expected_hash/);
  assert.match(migration, /acknowledged_at timestamptz/);
  assert.match(migration, /acknowledged_by uuid/);
  assert.match(migration, /create or replace function public\.acknowledge_immediate_provider_preview_receipt/);
  assert.match(migration, /perform public\.require_aal2\(\)/);
  assert.match(migration, /v_receipt\.acknowledged_at is null/);
  assert.match(migration, /v_receipt\.acknowledged_by is distinct from p_owner/);
});

test("server snapshots bind action, provider, target, content, and immediate timing", () => {
  const agentSnapshot = sqlFunctionBlock(
    migration,
    "create or replace function public.immediate_agent_preview_snapshot_service(",
  );
  const metaSnapshot = sqlFunctionBlock(
    migration,
    "create or replace function public.immediate_meta_preview_snapshot_service(",
  );
  assert.match(agentSnapshot, /v_expected_action := v_provider \|\| '\.publish_now'/);
  assert.match(agentSnapshot, /p_action is distinct from v_expected_action/);
  assert.match(agentSnapshot, /v_draft\.approved_content_hash/);
  assert.match(agentSnapshot, /v_draft\.approved_preview_target_id is distinct from trim\(v_connection\.provider_subject\)/);
  assert.match(agentSnapshot, /'targetId',v_target/);
  assert.match(agentSnapshot, /'timingLabel','Immediately after approval'/);
  assert.match(agentSnapshot, /'made_with_ai',true/);
  assert.match(agentSnapshot, /Provider disclosure: made_with_ai=true/);
  assert.match(metaSnapshot, /p_action is distinct from 'meta\.publish_now'/);
  assert.match(metaSnapshot, /v_page\.facebook_page_id/);
  assert.match(metaSnapshot, /v_page\.instagram_business_id/);
  assert.match(metaSnapshot, /v_draft\.approved_fb_media_sha256/);
  assert.match(metaSnapshot, /v_draft\.approved_ig_media_sha256/);
  assert.match(metaSnapshot, /'timingLabel','Immediately after approval'/);
});

test("future-scheduled generic and Meta drafts cannot mint an immediate receipt", () => {
  assert.equal(
    (migration.match(/future-scheduled draft cannot be posted now/gi) || []).length,
    2,
  );
  assert.match(migration, /v_draft\.publish_at is not null and v_draft\.publish_at > now\(\)/);
  assert.match(migration, /v_draft\.scheduled_for is not null and v_draft\.scheduled_for > now\(\)/);
});

test("receipt consumption and draft claim share one database transaction", () => {
  const genericClaim = sqlFunctionBlock(
    migration,
    "create or replace function public.claim_immediate_agent_draft_with_preview_service(",
  );
  const metaClaim = sqlFunctionBlock(
    migration,
    "create or replace function public.claim_immediate_meta_post_draft_with_preview_service(",
  );
  const discordClaim = sqlFunctionBlock(
    migration,
    "create or replace function public.claim_discord_draft_publish_with_preview_service(",
  );
  for (const block of [genericClaim, metaClaim, discordClaim]) {
    assert.match(block, /consume_immediate_(?:agent|meta)_preview_receipt_service/);
  }
  assert.match(genericClaim, /publish_state = 'publishing'/);
  assert.match(metaClaim, /status = 'publishing'/);
  assert.match(discordClaim, /claim_discord_draft_publish_service/);
  assert.match(migration, /revoke execute on function public\.claim_discord_draft_publish_service\([\s\S]*?from[\s\S]*?service_role/);
  assert.match(migration, /create trigger assert_discord_attempt_preview_receipt/);
  assert.match(migration, /receipt\.consumed_claim_id = new\.id/);
  assert.match(migration, /consume_immediate_agent_preview_receipt_service\([\s\S]*?from public, anon, authenticated, service_role/);
});

test("all immediate writers fail closed without a receipt and use only receipt claims", () => {
  const writers = [
    [meta, "claim_immediate_meta_post_draft_with_preview_service"],
    [twitter, "claim_immediate_agent_draft_with_preview_service"],
    [reddit, "claim_immediate_agent_draft_with_preview_service"],
    [discord, "claim_discord_draft_publish_with_preview_service"],
  ];
  for (const [source, claim] of writers) {
    assert.match(source, /receiptId/);
    assert.match(source, /SAFE_UUID\.test\(receiptId\)/);
    assert.match(source, new RegExp(claim));
  }
  assert.doesNotMatch(twitter, /const claim = await service\.from\("drafts"\)/);
  assert.doesNotMatch(reddit, /const \{ data: claimed, error: leaseError \} = await service\.from\("drafts"\)/);
  assert.doesNotMatch(meta, /\.update\(\{ status: "publishing"/);
  assert.doesNotMatch(discord, /admin\.rpc\(\s*"claim_discord_draft_publish_service"/);
  assert.match(twitter, /made_with_ai: true/);
  assert.doesNotMatch(twitter, /claimed\.generated_by_agent \? \{ made_with_ai/);
});

test("the owner UI separately previews, AAL2 acknowledges, and consumes the server receipt", () => {
  const receipt = htmlFunctionBlock("exactImmediateReceipt");
  const dialog = htmlFunctionBlock("openImmediateReceiptPreview");
  assert.match(receipt, /receiptVersion\|\|""\)!=="immediate-provider-preview-v1"/);
  assert.match(receipt, /expires<=Date\.now\(\)/);
  assert.match(receipt, /expires-created>5\*60\*1000/);
  assert.match(receipt, /String\(payload\.draftId\|\|""\)!==String\(expected\.draftId/);
  assert.match(receipt, /String\(payload\.provider\|\|""\)!==String\(expected\.provider/);
  assert.match(receipt, /String\(payload\.action\|\|""\)!==String\(expected\.action/);
  assert.match(receipt, /payload\.providerPayload\?\.made_with_ai!==true/);
  assert.match(receipt, /expected\.requireAcknowledged/);
  assert.match(dialog, /openPlatformPreviewDialog/);
  assert.match(dialog, /acknowledge_immediate_provider_preview_receipt/);
  assert.match(dialog, /requireAal2ForSensitiveAction/);
  assert.match(dialog, /requireAcknowledged:true/);
  assert.match(dialog, /onConfirm:\(\)=>onConfirm\(acknowledged\.id\)/);
  assert.ok(
    dialog.indexOf("acknowledge_immediate_provider_preview_receipt") <
      dialog.indexOf("onConfirm(acknowledged.id)"),
  );

  for (const [provider, action] of [
    ["twitter", "twitter.publish_now"],
    ["reddit", "reddit.publish_now"],
    ["discord", "discord.publish_now"],
    ["meta", "meta.publish_now"],
  ]) {
    assert.match(html, new RegExp(`provider:\"${provider}\",action:\"${action.replace(".", "\\.")}\"`));
  }
  assert.match(html, /action:"prepare-publish-draft",draftId:id/);
  assert.match(html, /action:"publish-draft",draftId:id,receiptId/);
  assert.match(html, /action:"prepare-publish",draftId:id/);
  assert.match(html, /action:"publish",draftId:id,receiptId/);
});
