import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (name) => readFile(path.join(root, name), "utf8");
const canonicalMigration =
  "MyPersonas.Online_v0/sql-updates/071-twitch-patreon-capability-foundation.sql";
const releaseMigration =
  "supabase/migrations/20260830140000_twitch_patreon_capability_foundation.sql";

test("migration 071 mirrors are exact, RLS protected, and contain no token columns", async () => {
  const [canonical, release] = await Promise.all([
    read(canonicalMigration),
    read(releaseMigration),
  ]);
  assert.equal(release, canonical);
  for (const table of [
    "twitch_oauth_transactions",
    "twitch_credentials",
    "twitch_operation_leases",
    "twitch_action_approvals",
    "twitch_action_attempts",
    "patreon_oauth_transactions",
    "patreon_credentials",
    "patreon_operation_leases",
    "patreon_native_handoffs",
  ]) assert.match(canonical, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  for (const table of ["twitch_credentials", "patreon_credentials"]) {
    const start = canonical.indexOf(`create table if not exists public.${table}`);
    const end = canonical.indexOf("create table if not exists", start + 20);
    const definition = canonical.slice(start, end);
    assert.match(definition, /vault_secret_id uuid not null unique/i);
    assert.doesNotMatch(definition, /\baccess_token\b|\brefresh_token\b/i);
  }
  assert.match(canonical, /vault\.create_secret/i);
  assert.match(canonical, /vault\.update_secret/i);
  assert.match(canonical, /vault\.decrypted_secrets/i);
  assert.doesNotMatch(canonical, /cron\.schedule\s*\(/i);
});

test("Twitch exposes only exact official feature scopes", async () => {
  const [migration, oauth, action] = await Promise.all([
    read(canonicalMigration),
    read("supabase/functions/twitch-oauth/index.ts"),
    read("supabase/functions/twitch-action/index.ts"),
  ]);
  for (const scope of [
    "channel:manage:broadcast",
    "channel:manage:schedule",
    "moderator:manage:announcements",
  ]) {
    assert.match(migration, new RegExp(scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(oauth, new RegExp(scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const feature of [
    "channel_update",
    "schedule_segment_create",
    "chat_announcement",
  ]) assert.match(action, new RegExp(feature));
  assert.match(oauth, /generalFeedPostingSupported:\s*false/);
  assert.match(oauth, /videoUploadSupported:\s*false/);
  assert.match(action, /generalFeedPostingSupported:\s*false/);
  assert.match(action, /videoUploadSupported:\s*false/);
  assert.doesNotMatch(action, /helix\/videos|video\.upload|channel:manage:videos/i);
});

test("every Twitch mutation is AAL2, exact-preview, pause, assignment, and receipt gated", async () => {
  const [migration, action] = await Promise.all([
    read(canonicalMigration),
    read("supabase/functions/twitch-action/index.ts"),
  ]);
  assert.match(action, /requireAal2/);
  assert.match(action, /body\.previewConfirmed !== undefined/);
  assert.match(action, /Raw confirmation booleans are not accepted/);
  assert.doesNotMatch(action, /previewConfirmed !== true/);
  assert.match(action, /twitch_record_action_preview_service/);
  assert.match(action, /prepare_provider_action_preview_service/);
  assert.match(action, /acknowledge_provider_action_preview/);
  assert.doesNotMatch(action, /executeConfirmed !== true/);
  assert.match(action, /claim_twitch_action_service/);
  assert.match(action, /p_receipt_id:\s*String\(body\.receiptId\)/);
  assert.match(action, /stillSafe\(owner, claim\)/);
  assert.match(action, /automation_paused/);
  assert.match(action, /account_persona_links/);
  assert.match(migration, /approved_preview_version<>'platform-preview-v1'/);
  assert.match(migration, /p_preview_version<>'twitch-action-preview-v1'/);
  assert.match(migration, /approved_preview_target_id<>c\.provider_subject/);
  assert.match(migration, /agent_draft_hash\(/);
  assert.match(migration, /agent_draft_preview_hash\(/);
  assert.match(migration, /perform public\.consume_provider_action_preview_service\(/);
  assert.match(migration, /p_receipt_id uuid/);
});

test("Twitch ambiguous outcomes are locked and only safe provider features reconcile", async () => {
  const [migration, action] = await Promise.all([
    read(canonicalMigration),
    read("supabase/functions/twitch-action/index.ts"),
  ]);
  assert.match(migration, /'outcome_unknown'/);
  assert.match(migration, /approval_id uuid not null unique/);
  assert.match(migration, /on conflict do nothing returning true into v_inserted/);
  assert.match(action, /alreadyClaimed:\s*true/);
  assert.match(action, /never retry this approval blindly/i);
  assert.match(action, /channelState\(/);
  assert.match(action, /scheduleMatches\(/);
  assert.match(action, /automaticReconciliationSupported:\s*false/);
  assert.match(action, /Review the Twitch chat\/moderation record/);
});

test("Patreon is v2 read/report plus native handoff, never an ordinary provider write", async () => {
  const [oauth, handoff, docs] = await Promise.all([
    read("supabase/functions/patreon-oauth/index.ts"),
    read("supabase/functions/patreon-handoff/index.ts"),
    read("MyPersonas.Online_v0/TWITCH-PATREON-CAPABILITIES.md"),
  ]);
  assert.match(oauth, /"identity", "campaigns", "campaigns\.posts"/);
  assert.match(oauth, /hasExactReadScopes/);
  assert.match(oauth, /api\/oauth2\/v2/);
  assert.match(oauth, /ordinaryPostCreateSupported:\s*false/);
  assert.match(oauth, /ordinaryPostSchedulingSupported:\s*false/);
  assert.match(handoff, /providerWritePerformed:\s*false/);
  assert.match(handoff, /providerCompletionVerified:\s*false/);
  assert.match(handoff, /https:\/\/www\.patreon\.com\/posts\/new/);
  assert.doesNotMatch(handoff, /fetch\s*\(/);
  assert.doesNotMatch(oauth, /method:\s*["'](?:PUT|PATCH|DELETE)["']/i);
  assert.doesNotMatch(oauth, /method:\s*["']POST["'][\s\S]{0,200}campaigns\/.+\/posts/i);
  assert.match(docs, /no ordinary post-create\/schedule endpoint/i);
  assert.match(docs, /owner-attested|owner attestation/i);
});

test("Patreon campaign and native schedule handoffs require exact previews", async () => {
  const [migration, handoff] = await Promise.all([
    read(canonicalMigration),
    read("supabase/functions/patreon-handoff/index.ts"),
  ]);
  assert.match(handoff, /requireAal2/);
  assert.match(handoff, /body\.previewConfirmed !== undefined/);
  assert.doesNotMatch(handoff, /previewConfirmed !== true/);
  assert.match(handoff, /prepare_provider_action_preview_service/);
  assert.match(handoff, /acknowledge_provider_action_preview/);
  assert.match(handoff, /open_patreon_native_handoff_with_preview_service/);
  assert.match(handoff, /patreon-native-preview-v1/);
  assert.match(handoff, /scheduledFor/);
  assert.match(migration, /d\.approved_preview_version<>'platform-preview-v1'/);
  assert.match(migration, /d\.approved_preview_target_id<>c\.provider_subject/);
  assert.match(migration, /approved_previewed_at is null/);
  assert.match(migration, /not automation_paused/);
  assert.match(migration, /account_persona_links/);
  assert.match(migration, /perform public\.consume_provider_action_preview_service\(/);
  assert.match(migration, /Use the acknowledged one-shot Patreon preview wrapper/);
});

test("Supabase gateway modes preserve OAuth callback and owner-action boundaries", async () => {
  const config = await read("supabase/config.toml");
  assert.match(config, /\[functions\.twitch-oauth\]\s*\r?\nverify_jwt = false/);
  assert.match(config, /\[functions\.twitch-action\]\s*\r?\nverify_jwt = true/);
  assert.match(config, /\[functions\.patreon-oauth\]\s*\r?\nverify_jwt = false/);
  assert.match(config, /\[functions\.patreon-handoff\]\s*\r?\nverify_jwt = true/);
});
