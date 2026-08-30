import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  path.join(repoRoot, "supabase/functions/reddit-post/index.ts"),
  "utf8",
);

function functionBlock(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const parametersStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index++) {
    if (source[index] === "(") parameterDepth++;
    if (source[index] === ")" && --parameterDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  assert.notEqual(parametersEnd, -1, `${name} has unterminated parameters`);
  const bodyStart = source.indexOf("{", parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} has an unterminated body`);
}

function assertOrdered(haystack, needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = haystack.indexOf(needle, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker: ${needle}`);
    assert.ok(next > cursor, `${needle} appeared out of order`);
    cursor = next;
  }
}

test("Reddit consumes one exact receipt, claims atomically, and recomputes its canonical hash", () => {
  assert.match(source, /const SAFE_UUID = \/\^\[0-9a-f\]\{8\}/);
  assertOrdered(source, [
    '"issue_immediate_agent_preview_receipt_service"',
    '"claim_immediate_agent_draft_with_preview_service"',
    "p_receipt_id: receiptId",
    'service.rpc("agent_draft_hash"',
    'exactHash !== claimed.approved_content_hash',
    'async function submit(',
  ]);
  assert.match(source, /Open and approve the current server-generated Reddit preview/);
  assert.doesNotMatch(source, /const \{ data: claimed, error: leaseError \} = await service\.from\("drafts"\)/);
  const hashCall = source.slice(
    source.indexOf('service.rpc("agent_draft_hash"'),
    source.indexOf("if (hashError", source.indexOf('service.rpc("agent_draft_hash"')),
  );
  for (const field of [
    "claimed.title", "claimed.body", "claimed.tags", "claimed.media_url",
    "claimed.content_kind", "claimed.persona_id", "claimed.account_id",
    "claimed.platform", "claimed.publish_at",
  ]) assert.match(hashCall, new RegExp(field.replace(".", "\\.")));
});

test("mutable owner, ledger, sharing, connection, and token state is re-read after claim", () => {
  const afterClaim = source.slice(source.indexOf("if (!claimed)"));
  assertOrdered(afterClaim, [
    'service.rpc("agent_draft_hash"',
    'service.from("agent_owner_settings")',
    'service.from("account_ledger")',
    'service.from("account_connections")',
    'service.from("account_persona_links")',
    '"reddit_get_tokens_service"',
    'async function submit(',
  ]);
  assert.match(afterClaim, /currentSettings\.data\.automation_paused/);
  assert.match(afterClaim, /activeLedger\.suspended/);
  assert.match(afterClaim, /activeConnection\.connection_state !== "connected"/);
  assert.match(afterClaim, /activeConnection\.verification_method !== "reddit_oauth"/);
  assert.match(afterClaim, /!activeScopes\.includes\("submit"\)/);

  const submit = functionBlock("submit");
  assertOrdered(submit, [
    'service.from("agent_owner_settings")',
    "pause.data.automation_paused",
    'phase: "provider_request_start"',
    'fetch("https://oauth.reddit.com/api/submit"',
  ]);
});

test("timeouts, 408, 5xx, unreadable success, and missing ids all lock for reconciliation", () => {
  assert.match(source, /AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/);
  assert.match(source, /providerOutcomeIsUncertain\(error\)/);
  assert.equal(
    (source.match(/response\.status === 408 \|\| response\.status >= 500/g) || []).length,
    2,
  );
  assert.match(source, /returned no readable result/);
  assert.match(source, /returned no durable post identifier/);
  const uncertain = functionBlock("recordUncertain");
  assert.match(uncertain, /\.eq\("publish_state", "publishing"\)/);
  assert.match(uncertain, /retry_safe: false/);
  assert.match(uncertain, /reconciliation_required: true/);
  assert.match(uncertain, /status: "publishing"/);
  assert.match(uncertain, /status: "unknown"/);
  assert.match(uncertain, /completion_verified_after_ambiguity/);
});

test("provider id is checkpointed before completion and blocks every safe retry", () => {
  assertOrdered(source, [
    "if (failure)",
    "provider_post_id: fullname",
    '.eq("provider_post_id", "")',
    "checkpointRead.data?.provider_post_id !== fullname",
    'publish_state: "published"',
    '.eq("provider_post_id", fullname)',
  ]);
  const definitive = functionBlock("recordDefinitiveFailure");
  assert.match(definitive, /\.eq\("provider_post_id", ""\)/);
  assert.match(definitive, /status: "failed"/);
  assert.match(definitive, /state_checkpoint_missing: true/);
});

test("API and audit output distinguish failed, uncertain, and published state", () => {
  const submit = functionBlock("submit");
  assert.match(submit, /writeAttemptAudit\("ok", \{\s*phase: "provider_request_start"/s);
  const definitive = functionBlock("recordDefinitiveFailure");
  const uncertain = functionBlock("recordUncertain");
  assert.match(definitive, /auditMissing: true/);
  assert.match(uncertain, /auditMissing: true/);
  assert.match(source, /phase: "completed"/);
  assert.match(source, /status: "published"/);
  assert.match(source, /\.\.\.\(auditWritten \? \{\} : \{ auditMissing: true \}\)/);
});
