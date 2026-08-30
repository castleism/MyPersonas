import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (name) => readFile(path.join(root, name), "utf8");

const oauthPath = "supabase/functions/tiktok-oauth/index.ts";
const postPath = "supabase/functions/tiktok-post/index.ts";
const canonicalMigration =
  "MyPersonas.Online_v0/sql-updates/068-tiktok-connector-foundation.sql";
const releaseMigration =
  "supabase/migrations/20260830110000_tiktok_connector_foundation.sql";

test("TikTok migration mirrors are exact and install no scheduler", async () => {
  const [canonical, release] = await Promise.all([
    read(canonicalMigration),
    read(releaseMigration),
  ]);
  assert.equal(release, canonical);
  assert.doesNotMatch(canonical, /cron\.schedule\s*\(/i);
  assert.match(canonical, /alter table public\.tiktok_credentials enable row level security/i);
  assert.match(canonical, /revoke all on public\.tiktok_credentials from anon, authenticated/i);
  assert.match(canonical, /grant all on public\.tiktok_credentials to service_role/i);
  assert.doesNotMatch(canonical, /auth\.role\(\)/i);
  assert.doesNotMatch(canonical, /\{1,2038\}/);
  assert.match(canonical, /char_length\(p_media_url\) not between 9 and 2048/i);
});

test("TikTok tokens are Vault-only and identity-bound", async () => {
  const migration = await read(canonicalMigration);
  const credentialsTable = migration.slice(
    migration.indexOf("create table if not exists public.tiktok_credentials"),
    migration.indexOf("create table if not exists public.tiktok_token_operation_leases"),
  );
  assert.match(credentialsTable, /vault_secret_id uuid not null unique/i);
  assert.doesNotMatch(credentialsTable, /\baccess_token\b|\brefresh_token\b/i);
  assert.match(migration, /vault\.create_secret/i);
  assert.match(migration, /vault\.update_secret/i);
  assert.match(migration, /vault\.decrypted_secrets/i);
  assert.match(migration, /provider_subject = excluded\.provider_subject/i);
  assert.match(migration, /'tiktok_oauth2_pkce'/i);
});

test("TikTok Login Kit uses single-use state, browser nonce, and PKCE", async () => {
  const oauth = await read(oauthPath);
  assert.match(oauth, /state_hash:\s*await sha256Hex\(state\)/);
  assert.match(oauth, /browser_nonce_hash:\s*await sha256Hex\(browserNonce\)/);
  assert.match(oauth, /code_verifier:\s*codeVerifier/);
  assert.match(oauth, /code_challenge_method",\s*"S256"/);
  assert.match(oauth, /consume_tiktok_oauth_state/);
  assert.match(oauth, /tx\.code_verifier/);
  assert.match(oauth, /identity\.openId !== expectedOpenId/);
  assert.match(oauth, /identity\.username !== normalizeUsername\(ledger\.username\)/);
  assert.match(oauth, /"video\.upload"/);
  assert.match(oauth, /"video\.publish"/);
});

test("Direct Post is explicit, audit-gated, and private when unaudited", async () => {
  const [oauth, post] = await Promise.all([read(oauthPath), read(postPath)]);
  for (const source of [oauth, post]) {
    assert.match(source, /TIKTOK_DIRECT_POST_ENABLED/);
    assert.match(source, /TIKTOK_CLIENT_AUDIT_STATE/);
    assert.match(source, /"audited"/);
    assert.match(source, /"unaudited"/);
  }
  assert.match(post, /CLIENT_AUDIT_STATE !== "unaudited" \|\|\s*settings\.privacy_level === "SELF_ONLY"/);
  assert.match(post, /creator_info\/query/);
});

test("all TikTok writes require durable generic and TikTok-specific previews", async () => {
  const post = await read(postPath);
  for (const field of [
    "approved_preview_version",
    "approved_preview_hash",
    "approved_preview_target_id",
    "approved_previewed_at",
  ]) assert.match(post, new RegExp(field));
  assert.match(post, /draft\.approved_preview_version !== "platform-preview-v1"/);
  assert.match(post, /draft\.approved_preview_target_id !== providerTargetId/);
  assert.match(post, /service\.rpc\("agent_draft_preview_hash"/);
  assert.match(post, /exactGenericPreview\(claimed, approval\.provider_open_id\)/);
  assert.match(post, /service\.rpc\("tiktok_preview_hash"/);
  assert.match(post, /previewVersion:\s*PREVIEW_VERSION/);
  assert.match(post, /editInvalidatesApproval:\s*true/);
});

test("TikTok consent, privacy, interaction, commercial, music, and AIGC choices are exact-approved", async () => {
  const post = await read(postPath);
  for (const field of [
    "privacy_level",
    "disable_comment",
    "disable_duet",
    "disable_stitch",
    "brand_content_toggle",
    "brand_organic_toggle",
    "is_aigc",
    "music_usage_confirmed",
    "branded_content_policy_confirmed",
    "explicit_direct_post_consent",
    "video_duration_seconds",
    "video_cover_timestamp_ms",
  ]) assert.match(post, new RegExp(field));
  assert.ok((post.match(/exactKeys\(settings, keys\)/g) || []).length >= 2);
  assert.match(post, /directSettingsMatchCreator\(settings, creator, context\.ledger\)/);
});

test("first release is video-only Upload API handoff with fail-closed media", async () => {
  const post = await read(postPath);
  assert.match(post, /\["video", "reel"\]/);
  assert.match(post, /"video\/mp4",\s*"video\/quicktime",\s*"video\/webm"/);
  assert.match(post, /source:\s*"PULL_FROM_URL"/);
  assert.match(post, /TIKTOK_VERIFIED_MEDIA_PREFIXES/);
  assert.match(post, /completionRequiredInTikTok:\s*mode === "upload_inbox"/);
  assert.match(post, /caption:\s*mode === "direct_post"/);
  assert.doesNotMatch(post, /source:\s*"FILE_UPLOAD"/);
});

test("send path rechecks pause, assignment, identity, and scopes immediately before TikTok", async () => {
  const post = await read(postPath);
  const send = post.slice(post.indexOf("async function sendApproved"));
  assert.ok((send.match(/ownerPause\(owner\)/g) || []).length >= 3);
  assert.ok((send.match(/currentAssignment\(claimed,/g) || []).length >= 2);
  assert.ok((send.match(/validConnection\(/g) || []).length >= 2);
  assert.match(send, /connection\?\.provider_subject !== approval\.provider_open_id/);
  const finalSafety = send.lastIndexOf("The TikTok safety state changed immediately before the provider request");
  const providerFetch = send.indexOf("await fetch(", finalSafety);
  assert.ok(finalSafety >= 0 && providerFetch > finalSafety);
});

test("ambiguous provider outcomes lock, checkpoint, and reconcile by publish_id", async () => {
  const post = await read(postPath);
  assert.match(post, /class ProviderOutcomeUncertainError extends Error/);
  assert.match(post, /reconciliationRequired:\s*true/);
  assert.match(post, /provider_post_id:\s*publishId/);
  assert.match(post, /JSON\.stringify\(\{ publish_id: draft\.provider_post_id \}\)/);
  for (const status of [
    "PROCESSING_UPLOAD",
    "PROCESSING_DOWNLOAD",
    "SEND_TO_USER_INBOX",
    "PUBLISH_COMPLETE",
    "FAILED",
  ]) assert.match(post, new RegExp(status));
  const checkpoint = post.indexOf("provider_post_id: publishId");
  const acceptedResponse = post.indexOf("status: approval.publish_mode", checkpoint);
  assert.ok(checkpoint >= 0 && acceptedResponse > checkpoint);
});

test("Supabase gateway modes match OAuth callback and owner write boundaries", async () => {
  const config = await read("supabase/config.toml");
  assert.match(config, /\[functions\.tiktok-oauth\]\s*\r?\nverify_jwt = false/);
  assert.match(config, /\[functions\.tiktok-post\]\s*\r?\nverify_jwt = true/);
});
