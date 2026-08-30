import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oauth = await readFile(
  path.join(repoRoot, "supabase/functions/twitter-oauth/index.ts"),
  "utf8",
);
const post = await readFile(
  path.join(repoRoot, "supabase/functions/twitter-post/index.ts"),
  "utf8",
);
const config = await readFile(path.join(repoRoot, "supabase/config.toml"), "utf8");

function assertOrdered(source, needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker: ${needle}`);
    assert.ok(next > cursor, `${needle} appeared out of order`);
    cursor = next;
  }
}

test("X OAuth keeps read access default and requires explicit posting consent", () => {
  assert.match(oauth, /const READ_SCOPES = \[/);
  assert.match(oauth, /const PUBLISH_SCOPES = \[\s*\.\.\.READ_SCOPES,\s*"tweet\.write"/s);
  assert.doesNotMatch(oauth, /"media\.write"/);
  assert.match(oauth, /body\.enablePosting === true/);
  assert.match(oauth, /const accessMode: XAccessMode = enablePosting \? "publish" : "read"/);
  assert.match(oauth, /scope: requestedScopes\.join\(" "\)/);
  assert.match(oauth, /state = `\$\{accessMode === "publish" \? "w" : "r"\}_/);
  assert.match(oauth, /accessModeFromState\(rawState\)/);
  assert.match(oauth, /hasRequiredScopes\(token\.scopes, requestedScopes\)/);
  assert.match(oauth, /writeReconnectRequired: enablePosting/);
});

test("X capabilities report actual ledger write readiness", () => {
  assert.match(oauth, /explicitPostingConsentRequired: true/);
  assert.match(oauth, /mediaUploadEnabled: false/);
  assert.match(oauth, /\.select\("connection_state,error_code,expires_at,granted_scopes"\)/);
  assert.match(oauth, /result\.postingEnabled = credentialsConfigured\(\)/);
  assert.match(oauth, /hasRequiredScopes\(grantedScopes, PUBLISH_SCOPES\)/);
  assert.match(oauth, /result\.writeReconnectRequired/);
});

test("X publishing is AAL2 guarded and explicitly configured as JWT protected", () => {
  assert.match(post, /import \{ requireAal2 \} from "\.\.\/_shared\/aal2\.ts"/);
  assert.match(post, /const guard = await requireAal2\(req, userClient\)/);
  assert.match(post, /if \(!ALLOWED_ORIGINS\.has\(origin\)\)/);
  assert.match(config, /\[functions\.twitter-post\]\s*\r?\nverify_jwt = true/);
});

test("X publisher consumes one exact receipt, claims atomically, and recomputes its hash", () => {
  assertOrdered(post, [
    'draft.approval_state !== "approved"',
    "if (draft.provider_post_id)",
    'if (String(draft.media_url || "").trim())',
    'service.rpc("agent_draft_preview_hash"',
    '"issue_immediate_agent_preview_receipt_service"',
    '"claim_immediate_agent_draft_with_preview_service"',
    "p_receipt_id: receiptId",
    'const hash = await service.rpc("agent_draft_hash"',
    "hash.data !== claimed.approved_content_hash",
  ]);
  assert.match(post, /Open and approve the current server-generated X preview/);
  assert.doesNotMatch(post, /const claim = await service\.from\("drafts"\)/);
  for (const field of [
    "claimed.title", "claimed.body", "claimed.tags", "claimed.media_url",
    "claimed.content_kind", "claimed.persona_id", "claimed.account_id",
    "claimed.platform", "claimed.publish_at",
  ]) assert.match(post, new RegExp(field.replace(".", "\\.")));
  assert.match(post, /codePointLength\(claimedText\) > 280/);
  assert.match(post, /approved_preview_version,approved_preview_hash,approved_preview_target_id,approved_previewed_at/);
  assert.match(post, /service\.rpc\("agent_draft_preview_hash"/);
  assert.match(post, /draft\.approved_preview_target_id !==\s*connectionResult\.connection!\.provider_subject/);
  assert.match(post, /claimed\.approved_preview_target_id !== activeConnection!\.provider_subject/);
});

test("X publisher rechecks mutable safety and serializes token rotation", () => {
  const afterClaim = post.slice(post.indexOf("if (!claimed)"));
  assertOrdered(afterClaim, [
    'service.rpc("agent_draft_hash"',
    "ownerPauseState(service, owner)",
    "ownedLedger(service, owner, claimed.account_id!)",
    "currentConnection(service, owner, claimed.account_id!)",
    "personaAssignmentStillValid(service, claimed, activeLedger)",
    "claimTokenLease(service, activeLedger)",
    "verifiedAccess(",
    'phase: "provider_request_start"',
    "fetch(X_POSTS_URL",
  ]);
  assert.match(post, /claim_twitter_token_operation/);
  assert.match(post, /p_operation_kind: "refresh"/);
  assert.match(post, /release_twitter_token_operation/);
  assert.match(post, /twitter_get_token_bundle/);
  assert.match(post, /twitter_store_token_bundle/);
  assert.match(post, /Date\.parse\(credential\.expiresAt\) <= Date\.now\(\) \+ TOKEN_REFRESH_SKEW_MS/);
  assert.match(post, /response\.status < 400/);
  assert.match(post, /x_manual_revoke_required/);
});

test("ambiguous X create outcomes stay locked and durable ids checkpoint first", () => {
  assert.match(post, /class ProviderOutcomeUncertainError/);
  assert.match(post, /AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/);
  assert.match(post, /response\.status === 408 \|\| response\.status >= 500/);
  assert.match(post, /Do not retry until this X account and draft are reconciled/);
  assert.match(post, /reconciliationRequired: true/);
  assertOrdered(post, [
    "if (!SAFE_X_ID.test(postId))",
    "provider_post_id: postId",
    '.eq("provider_post_id", "")',
    'publish_state: "published"',
    '.eq("provider_post_id", postId)',
  ]);
});

test("X read and delete helpers are bound to stored owned draft ids", () => {
  assert.match(post, /async function loadPublishedDraft/);
  assert.match(post, /\.eq\("id", draftId\)\.eq\("owner", owner\)\.eq\("platform", "twitter"\)/);
  assert.match(post, /action === "verify-draft-post"/);
  assert.match(post, /action === "delete-draft-post"/);
  assert.match(post, /body\.confirmDelete !== true/);
  assert.match(post, /authorId !== access\.providerSubject/);
  assert.match(post, /method: "DELETE"/);
  assert.match(post, /confirmation\.response\.status !== 404/);
  assert.match(post, /provider id is retained for immutable history/);
});

test("no credential or media scope is embedded in the X implementation", () => {
  assert.doesNotMatch(post, /"media\.write"/);
  assert.doesNotMatch(post, /Bearer\s+[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(oauth, /Bearer\s+[A-Za-z0-9_-]{20,}/);
});
