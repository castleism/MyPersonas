import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [oauth, publisher, migration, previewMigration, config, runbook] =
  await Promise.all([
    readFile(path.join(root, "supabase/functions/discord-oauth/index.ts"), "utf8"),
    readFile(path.join(root, "supabase/functions/discord-post/index.ts"), "utf8"),
    readFile(
      path.join(root, "MyPersonas.Online_v0/sql-updates/066-discord-oauth-publishing.sql"),
      "utf8",
    ),
    readFile(
      path.join(root, "MyPersonas.Online_v0/sql-updates/069-agent-draft-platform-preview-gate.sql"),
      "utf8",
    ),
    readFile(path.join(root, "supabase/config.toml"), "utf8"),
    readFile(path.join(root, "MyPersonas.Online_v0/DISCORD-OAUTH-PUBLISHING.md"), "utf8"),
  ]);

function sqlFunctionBlock(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} was not found`);
  const end = source.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${signature} has an unterminated SQL body`);
  return source.slice(start, end + 4);
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

test("Discord connection uses official authorization-code webhook channel consent", () => {
  assert.match(oauth, /scope:\s*"webhook\.incoming"/);
  assert.match(oauth, /response_type:\s*"code"/);
  assert.match(oauth, /grant_type:\s*"authorization_code"/);
  assert.match(oauth, /prompt:\s*"consent"/);
  assert.match(oauth, /validatedWebhookFromToken/);
  assert.match(oauth, /Number\(webhook\.type\) !== 1/);
  assert.match(oauth, /applicationId !== DISCORD_CLIENT_ID/);
  assert.match(oauth, /channelSelectionRequired:\s*true/);
  assert.doesNotMatch(oauth, /password\??\s*:/i);
  assert.doesNotMatch(oauth, /botToken\??\s*:/i);
  assert.doesNotMatch(oauth, /userToken\??\s*:/i);
});

test("OAuth state is expiring, single-use, and bound to the initiating browser", () => {
  const consume = sqlFunctionBlock(
    migration,
    "create or replace function public.consume_discord_oauth_state(",
  );
  assert.match(migration, /state_hash text primary key/);
  assert.match(migration, /browser_nonce_hash text not null/);
  assert.match(migration, /expires_at timestamptz not null/);
  assert.match(oauth, /state_hash:\s*await sha256Hex\(state\)/);
  assert.match(oauth, /browser_nonce_hash:\s*await sha256Hex\(browserNonce\)/);
  assert.match(consume, /delete from public\.discord_oauth_transactions/);
  assert.match(consume, /tx\.owner = p_owner/);
  assert.match(consume, /tx\.browser_nonce_hash = p_browser_nonce_hash/);
  assert.match(consume, /tx\.expires_at > now\(\)/);
});

test("Discord secrets remain Vault-only and exact channel identity stays non-secret", () => {
  assert.match(migration, /create table if not exists public\.discord_credentials/);
  assert.match(migration, /vault_secret_id uuid not null unique/);
  assert.match(migration, /vault\.create_secret/);
  assert.match(migration, /vault\.update_secret/);
  assert.match(migration, /revoke all on public\.discord_credentials from anon, authenticated/);
  assert.doesNotMatch(migration, /grant select[^;]*discord_credentials/is);
  assert.match(migration, /create table if not exists public\.discord_channel_bindings/);
  assert.match(migration, /guild_id text not null/);
  assert.match(migration, /channel_id text not null/);
  assert.match(migration, /webhook_id text not null unique/);
  assert.match(migration, /provider_subject, granted_scopes/);
  assert.match(migration, /p_ledger_id, p_owner, 'discord', p_channel_id/);
});

test("ambiguous authorization cleanup retains an exact non-publishable Vault hold", () => {
  const hold = sqlFunctionBlock(
    migration,
    "create or replace function public.discord_store_oauth_cleanup_hold_service(",
  );
  assert.match(hold, /public\.discord_store_oauth_connection_service\(/);
  assert.match(hold, /connection_state = 'error'/);
  assert.match(hold, /verification_method = 'discord_oauth_cleanup_hold'/);
  assert.match(hold, /last_verified_at = null/);
  assert.match(oauth, /async function retainCleanupHold/);
  assert.match(oauth, /discord_store_oauth_cleanup_hold_service/);
  assert.match(oauth, /retryDisconnect:\s*retained/);
  assert.match(
    migration,
    /revoke all on function public\.discord_store_oauth_cleanup_hold_service[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.discord_store_oauth_cleanup_hold_service[\s\S]*to service_role/,
  );
});

test("every privileged Discord action is gated by AAL2", () => {
  assert.match(oauth, /const guard = await requireAal2\(req, authClient\)/);
  assert.match(oauth, /action === "start"/);
  assert.match(oauth, /action === "complete"/);
  assert.match(oauth, /action === "disconnect"/);
  assert.match(publisher, /const guard = await requireAal2\(req, authClient\)/);
  assert.match(publisher, /action === "publish"/);
  assert.match(publisher, /action === "verify"/);
  assert.match(publisher, /action === "delete"/);
  assert.match(config, /\[functions\.discord-oauth\]\s*verify_jwt\s*=\s*false/);
  assert.match(config, /\[functions\.discord-post\]\s*verify_jwt\s*=\s*true/);
});

test("atomic claim requires exact approval, exact preview target, assignment, and pause state", () => {
  const claim = sqlFunctionBlock(
    migration,
    "create or replace function public.claim_discord_draft_publish_service(",
  );
  assert.match(claim, /where id = p_draft_id and owner = p_owner for update/);
  assert.match(claim, /public\.agent_draft_hash\(/);
  assert.match(claim, /v_hash is distinct from v_draft\.approved_content_hash/);
  assert.match(claim, /not automation_paused/);
  assert.match(claim, /v_ledger\.persona_id is distinct from v_draft\.persona_id/);
  assert.match(claim, /public\.account_persona_links/);
  assert.match(claim, /'approved_preview_version'\) is distinct from 'platform-preview-v1'/);
  assert.match(claim, /'approved_preview_target_id'\) is distinct from v_binding\.channel_id/);
  assert.match(claim, /public\.agent_draft_preview_hash\(/);
  assert.match(claim, /Migration 069 platform-preview gate is required/);
  assert.match(claim, /provider_subject = v_binding\.channel_id/);
  assert.match(claim, /'webhook\.incoming' = any\(granted_scopes\)/);
  assert.match(previewMigration, /create or replace function public\.agent_draft_preview_hash/);
  assertOrdered(claim, [
    "select * into v_draft",
    "insert into public.discord_publish_attempts",
    "publish_state = 'publishing'",
  ]);
});

test("publishing obtains a durable exact message without unexpected mentions", () => {
  assert.match(publisher, /\?wait=true/);
  assert.match(publisher, /allowed_mentions:\s*\{ parse:\s*\[\], replied_user:\s*false \}/);
  assert.match(publisher, /channelId !== claimed\.channel_id/);
  assertOrdered(publisher, [
    '"claim_discord_draft_publish_with_preview_service"',
    "?wait=true",
    '"discord_checkpoint_publish_service"',
    '"discord_finalize_publish_service"',
  ]);
  assert.match(publisher, /scheduled:\s*false/);
  assert.doesNotMatch(publisher, /scheduled_for|setInterval|cron/i);
});

test("publishing rejects credential-bearing media links before provider delivery", () => {
  assert.match(publisher, /isCredentialFreeHttpsUrl\(media\)/);
  assert.match(publisher, /parsed\.protocol !== "https:"/);
  assert.match(publisher, /parsed\.username/);
  assert.match(publisher, /parsed\.password/);
  assert.match(publisher, /key\.startsWith\("x-amz-"\)/);
  assert.match(publisher, /key\.startsWith\("x-goog-"\)/);
  assert.match(publisher, /"access_token"/);
  assert.match(publisher, /"signature"/);
  assert.match(publisher, /"token"/);
});

test("ambiguous provider outcomes lock instead of retrying", () => {
  const uncertain = sqlFunctionBlock(
    migration,
    "create or replace function public.discord_mark_publish_uncertain_service(",
  );
  assert.match(publisher, /response\.status === 408 \|\| response\.status >= 500/);
  assert.match(publisher, /reconciliationRequired:\s*true/);
  assert.match(uncertain, /status = 'outcome_unknown'/);
  assert.match(uncertain, /publish_state = 'blocked'/);
  assert.match(uncertain, /different channel than the approved destination/);
  assert.doesNotMatch(publisher, /retry\s*\(|for\s*\([^)]*attempt/i);
});

test("verification and deletion use the exact durable message and channel", () => {
  assert.match(
    publisher,
    /webhooks\/\$\{secret\.webhookId\}\/\$\{secret\.token\}\/messages\/\$\{reference\.message_id\}/,
  );
  assert.match(
    publisher,
    /reference\.message_id !== confirmMessageId\s*\|\|\s*reference\.channel_id !== confirmChannelId/,
  );
  assert.match(publisher, /response\.status !== 204 && response\.status !== 404/);
  assert.match(publisher, /discord_record_message_verified_service/);
  assert.match(publisher, /discord_record_message_deleted_service/);
});

test("runbook keeps Discord owner-triggered and identifies exact release gates", () => {
  assert.match(runbook, /Scheduled and background\s+Discord publishing remain disabled/i);
  assert.match(runbook, /private disposable\s+text channel/i);
  assert.match(runbook, /platform-preview-v1/);
  assert.match(runbook, /DISCORD_CLIENT_ID/);
  assert.match(runbook, /DISCORD_CLIENT_SECRET/);
  assert.match(runbook, /delete the remote webhook first[\s\S]*revoke the OAuth grant second[\s\S]*Vault/i);
});
