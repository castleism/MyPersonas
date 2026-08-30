import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const redditPostPath = path.join(repoRoot, "supabase/functions/reddit-post/index.ts");
const redditOauthPath = path.join(repoRoot, "supabase/functions/reddit-oauth/index.ts");
const configPath = path.join(repoRoot, "supabase/config.toml");
const frontendPath = path.join(repoRoot, "MyPersonas.Online_v0/index.html");

test("Reddit publishing uses the canonical owner pause and an exact atomic claim", async () => {
  const source = await readFile(redditPostPath, "utf8");
  assert.match(source, /\.from\("agent_owner_settings"\)/);
  assert.doesNotMatch(source, /\.from\("agent_settings"\)/);
  assert.match(source, /"issue_immediate_agent_preview_receipt_service"/);
  assert.match(source, /"claim_immediate_agent_draft_with_preview_service"/);
  assert.match(source, /p_receipt_id: receiptId/);
  assert.doesNotMatch(source, /const \{ data: claimed, error: leaseError \} = await service\.from\("drafts"\)/);
  assert.match(source, /const title = \(claimed\.title/);
  assert.match(source, /old\.publish_state|Protected draft fields cannot change once publishing begins|publish_state: "publishing"/);
});

test("ambiguous Reddit POST outcomes remain reconciliation-locked", async () => {
  const source = await readFile(redditPostPath, "utf8");
  assert.match(source, /class ProviderOutcomeUncertainError/);
  assert.match(source, /response\.status >= 500/);
  assert.match(source, /returned no durable post identifier/);
  assert.match(source, /status: "publishing"/);
  assert.match(source, /reconciliationRequired: true/);
  assert.match(source, /Do not retry until the Reddit account is reconciled/);
  assert.match(source, /AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/);
});

test("a confirmed Reddit result is durably checkpointed before success", async () => {
  const source = await readFile(redditPostPath, "utf8");
  assert.match(source, /\/\^t3_\[A-Za-z0-9\]\+\$\//);
  assert.match(source, /provider_post_id: fullname/);
  assert.match(source, /publish_state: "published"/);
  assert.match(source, /\.select\("id,provider_post_id,publish_state"\)\.maybeSingle\(\)/);
  assert.match(source, /reread\?\.provider_post_id !== fullname/);
  assert.match(source, /action_type: "publish_external_reddit"/);
});

test("Reddit callback and owner publish endpoints have explicit gateway settings", async () => {
  const config = await readFile(configPath, "utf8");
  assert.match(config, /\[functions\.reddit-oauth\]\s*\r?\nverify_jwt = false/);
  assert.match(config, /\[functions\.reddit-post\]\s*\r?\nverify_jwt = true/);
});

test("the owner Queue exposes only the guarded Reddit draft endpoint", async () => {
  const html = await readFile(frontendPath, "utf8");
  assert.match(html, /Post to Reddit now/);
  assert.match(html, /function publishRedditDraft\(id,button\)/);
  assert.match(html, /providerPostAction\("reddit-post",\{action:"prepare-publish-draft",draftId:id\}\)/);
  assert.match(html, /providerPostAction\("reddit-post",\{action:"publish-draft",draftId:id,receiptId\}\)/);
  assert.match(html, /openImmediateReceiptPreview/);
  assert.match(html, /sent\.status===202&&sent\.data\?\.reconciliationRequired/);
});

test("Reddit disconnect confirms provider revocation before clearing local tokens", async () => {
  const source = await readFile(redditOauthPath, "utf8");
  const disconnect = source.slice(source.indexOf("async function disconnect"), source.indexOf("serve(async", source.indexOf("async function disconnect")));
  assert.match(disconnect, /reddit_get_tokens_service/);
  assert.match(disconnect, /hasStoredGrant && !configured\(\)/);
  assert.match(disconnect, /!await revokeRedditGrant\(refreshToken, accessToken\)/);
  assert.match(disconnect, /Local tokens were retained/);
  assert.match(disconnect, /reddit_clear_tokens_service/);
  assert.ok(
    disconnect.indexOf("revokeRedditGrant(refreshToken, accessToken)") < disconnect.indexOf("reddit_clear_tokens_service"),
    "provider revocation must be confirmed before local token deletion"
  );
  assert.match(disconnect, /providerRevoked: hasStoredGrant/);
});

test("failed Reddit OAuth callbacks clean up newly issued grants", async () => {
  const source = await readFile(redditOauthPath, "utf8");
  assert.match(source, /async function redirectAfterIssuedGrantFailure/);
  assert.match(source, /reason: revoked \? reason : "provider_revoke_unconfirmed"/);
  for (const reason of [
    "scope_missing",
    "refresh_token_missing",
    "profile_check_failed",
    "connection_save_failed",
    "username_mismatch",
    "secure_storage_failed"
  ]) {
    assert.match(source, new RegExp(`redirectAfterIssuedGrantFailure\\(token, "${reason}"\\)`));
  }
  const html = await readFile(frontendPath, "utf8");
  assert.match(html, /provider_revoke_unconfirmed:/);
  assert.match(html, /result\.data\?\.providerRevoked\?"Reddit confirmed revocation/);
});
