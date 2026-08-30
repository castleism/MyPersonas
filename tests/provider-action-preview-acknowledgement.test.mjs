import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const files = {
  youtubeSql: "MyPersonas.Online_v0/sql-updates/067-youtube-oauth-publisher.sql",
  youtubeMirror: "supabase/migrations/20260830100000_youtube_oauth_publisher.sql",
  tiktokSql: "MyPersonas.Online_v0/sql-updates/068-tiktok-connector-foundation.sql",
  tiktokMirror: "supabase/migrations/20260830110000_tiktok_connector_foundation.sql",
  cmsSql: "MyPersonas.Online_v0/sql-updates/070-cms-draft-connectors.sql",
  cmsMirror: "supabase/migrations/20260830130000_cms_draft_connectors.sql",
  featureSql: "MyPersonas.Online_v0/sql-updates/071-twitch-patreon-capability-foundation.sql",
  featureMirror: "supabase/migrations/20260830140000_twitch_patreon_capability_foundation.sql",
};

function ordered(source, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker: ${marker}`);
    assert.ok(next > cursor, `${marker} is out of order`);
    cursor = next;
  }
}

test("provider action receipt migration is mirrored and browser immutable", async () => {
  const [sql, mirror] = await Promise.all([
    read(files.youtubeSql),
    read(files.youtubeMirror),
  ]);
  assert.equal(mirror, sql);
  assert.match(sql, /create table if not exists public\.provider_action_preview_receipts/);
  for (const field of [
    "target_id", "content_hash", "action_hash", "preview_version",
    "preview_payload", "receipt_hash", "prepared_at", "expires_at",
    "acknowledged_at", "acknowledged_by", "consumed_at", "consumed_claim_id",
    "consumed_claim_kind", "invalidated_at",
  ]) assert.match(sql, new RegExp(field));
  assert.match(sql, /expires_at<=prepared_at\+interval '5 minutes'/);
  assert.match(sql, /revoke all on public\.provider_action_preview_receipts from public,anon,authenticated/);
  assert.match(sql, /grant select on public\.provider_action_preview_receipts to authenticated/);
  assert.match(sql, /provider action preview receipts owner read/);
});

test("prepare, AAL2 acknowledge, and one-shot unchanged consume are separate transitions", async () => {
  const sql = await read(files.youtubeSql);
  const prepare = sql.slice(
    sql.indexOf("create or replace function public.prepare_provider_action_preview_service"),
    sql.indexOf("create or replace function public.acknowledge_provider_action_preview"),
  );
  const acknowledge = sql.slice(
    sql.indexOf("create or replace function public.acknowledge_provider_action_preview"),
    sql.indexOf("create or replace function public.consume_provider_action_preview_service"),
  );
  const consume = sql.slice(
    sql.indexOf("create or replace function public.consume_provider_action_preview_service"),
    sql.indexOf("create or replace function public.invalidate_provider_action_previews_on_draft_change"),
  );
  assert.match(prepare, /request\.jwt\.claim\.role/);
  assert.match(prepare, /service_role/);
  assert.match(prepare, /superseded_by_new_preview/);
  assert.doesNotMatch(prepare, /auth\.uid\(\)/);
  assert.match(acknowledge, /perform public\.require_aal2\(\)/);
  assert.match(acknowledge, /auth\.uid\(\)/);
  assert.match(acknowledge, /set acknowledged_at=v_now,acknowledged_by=v_owner/);
  assert.doesNotMatch(acknowledge, /consumed_at=v_now/);
  assert.match(consume, /r\.acknowledged_at is null/);
  assert.match(consume, /r\.acknowledged_by is distinct from p_owner/);
  assert.match(consume, /r\.expires_at<=v_now/);
  assert.match(consume, /r\.target_id is distinct from trim\(p_target_id\)/);
  assert.match(consume, /r\.content_hash is distinct from p_content_hash/);
  assert.match(consume, /r\.action_hash is distinct from p_action_hash/);
  assert.match(consume, /set consumed_at=v_now/);
  assert.match(consume, /receipt was already consumed/);
  assert.match(consume, /consume_provider_action_preview_for_claim_service/);
  assert.match(consume, /set consumed_claim_id=p_claim_id,consumed_claim_kind=trim\(p_claim_kind\)/);
  const providerGrant = sql.slice(
    sql.indexOf("grant execute on function public.prepare_provider_action_preview_service"),
    sql.indexOf("grant execute on function public.acknowledge_provider_action_preview"),
  );
  assert.doesNotMatch(providerGrant, /consume_provider_action_preview_service/);
});

test("all four provider migrations remain byte-identical to release mirrors", async () => {
  for (const [canonical, mirror] of [
    [files.youtubeSql, files.youtubeMirror],
    [files.tiktokSql, files.tiktokMirror],
    [files.cmsSql, files.cmsMirror],
    [files.featureSql, files.featureMirror],
  ]) {
    assert.equal(await read(mirror), await read(canonical), canonical);
  }
});

test("provider snapshots declare exact targets, placements, and media requirements", async () => {
  const [youtube, tiktok, twitch, patreon, cms] = await Promise.all([
    read("supabase/functions/youtube-post/index.ts"),
    read("supabase/functions/tiktok-post/index.ts"),
    read("supabase/functions/twitch-action/index.ts"),
    read("supabase/functions/patreon-handoff/index.ts"),
    read("supabase/functions/_shared/cms-drafts.ts"),
  ]);
  for (const source of [youtube, tiktok, twitch, patreon, cms]) {
    assert.match(source, /requiresExactTarget: true/);
    assert.match(source, /exactTargetReady: true/);
    assert.match(source, /placement:/);
    assert.match(source, /mediaItems:/);
    assert.match(source, /requiresMedia:/);
  }
  for (const source of [youtube, tiktok]) {
    assert.match(source, /requiresMedia: true/);
    assert.match(source, /requiredMediaMissing:/);
  }
});

test("YouTube direct publish rejects bypasses and atomically binds receipt to draft claim before upload", async () => {
  const [source, sql] = await Promise.all([
    read("supabase/functions/youtube-post/index.ts"),
    read(files.youtubeSql),
  ]);
  assert.match(source, /action === "acknowledge-preview"/);
  assert.match(source, /acknowledge_provider_action_preview/);
  assert.match(source, /prepare_provider_action_preview_service/);
  assert.match(source, /body\.previewConfirmed !== undefined/);
  assert.match(source, /body\.executeConfirmed !== undefined/);
  assert.doesNotMatch(source, /previewConfirmed\s*===\s*true/);
  const publish = source.slice(source.indexOf('if (action !== "publish-draft")'));
  ordered(publish, [
    'const receiptId = String(body.receiptId || "")',
    'claim_youtube_upload_with_preview_service',
    "await fetch(UPLOAD_START_URL",
  ]);
  assert.doesNotMatch(publish, /consume_provider_action_preview_service/);
  assert.doesNotMatch(publish, /update\(\{ publish_state: "publishing"/);
  assert.match(source, /claimPayload\.claimId !== draft\.id/);
  const wrapper = sql.slice(
    sql.indexOf("create or replace function public.claim_youtube_upload_with_preview_service"),
    sql.indexOf("create or replace function public.youtube_store_upload_session_service"),
  );
  ordered(wrapper, [
    "v_claim_id uuid:=p_draft_id",
    "perform public.consume_provider_action_preview_for_claim_service(",
    "update public.drafts set publish_state='publishing'",
    "'claimId',v_claim_id",
  ]);
});

test("TikTok direct send rejects bypasses and atomically binds exact mode receipt to draft claim", async () => {
  const [source, sql] = await Promise.all([
    read("supabase/functions/tiktok-post/index.ts"),
    read(files.tiktokSql),
  ]);
  assert.match(source, /action === "acknowledge-preview"/);
  assert.match(source, /acknowledge_provider_action_preview/);
  assert.match(source, /prepare_provider_action_preview_service/);
  assert.match(source, /body\.previewConfirmed !== undefined/);
  assert.match(source, /body\.executeConfirmed !== undefined/);
  assert.doesNotMatch(source, /previewConfirmed\s*===\s*true/);
  const send = source.slice(source.indexOf("async function sendApproved"));
  ordered(send, [
    "!SAFE_UUID.test(receiptId)",
    'claim_tiktok_publish_with_preview_service',
    "await fetch(",
  ]);
  assert.doesNotMatch(send, /consume_provider_action_preview_service/);
  assert.doesNotMatch(send, /update\(\{ publish_state: "publishing"/);
  assert.match(source, /claimPayload\.claimId !== draft\.id/);
  const wrapper = sql.slice(
    sql.indexOf("create or replace function public.claim_tiktok_publish_with_preview_service"),
    sql.indexOf("create or replace function public.invalidate_tiktok_draft_approval"),
  );
  ordered(wrapper, [
    "v_claim_id uuid:=p_draft_id",
    "perform public.consume_provider_action_preview_for_claim_service(",
    "'tiktok.'||a.publish_mode",
    "update public.drafts set publish_state='publishing'",
  ]);
});

test("Twitch claim and Patreon handoff reject unacknowledged direct calls in the database boundary", async () => {
  const [sql, twitch, patreon] = await Promise.all([
    read(files.featureSql),
    read("supabase/functions/twitch-action/index.ts"),
    read("supabase/functions/patreon-handoff/index.ts"),
  ]);
  const twitchClaim = sql.slice(
    sql.indexOf("create or replace function public.claim_twitch_action_service"),
    sql.indexOf("create or replace function public.twitch_finish_action_service"),
  );
  ordered(twitchClaim, [
    "p_receipt_id uuid",
    "perform public.consume_provider_action_preview_service(",
    "insert into public.twitch_action_attempts",
  ]);
  assert.match(twitch, /!SAFE_UUID\.test\(String\(body\.receiptId \|\| ""\)\)/);
  assert.doesNotMatch(twitch, /executeConfirmed\s*===\s*true/);

  const open = sql.slice(
    sql.indexOf("create or replace function public.open_patreon_native_handoff_with_preview_service"),
    sql.indexOf("create or replace function public.guard_connected_patreon_ledger_change"),
  );
  ordered(open, [
    "status='prepared' for update",
    "perform public.consume_provider_action_preview_service(",
    "set status='opened'",
  ]);
  assert.match(sql, /Use the acknowledged one-shot Patreon preview wrapper to open a handoff/);
  assert.match(patreon, /action === "open"/);
  assert.doesNotMatch(patreon, /action === "opened"/);
  assert.doesNotMatch(patreon, /previewConfirmed\s*===\s*true/);
});

test("CMS UI renders server snapshot and writers atomically bind receipt to durable attempt", async () => {
  const [ui, shared, wix, wordpress, sql] = await Promise.all([
    read("MyPersonas.Online_v0/cms-connector-ui.js"),
    read("supabase/functions/_shared/cms-drafts.ts"),
    read("supabase/functions/wix-draft/index.ts"),
    read("supabase/functions/wordpress-draft/index.ts"),
    read(files.cmsSql),
  ]);
  assert.match(ui, /action: "prepare-preview"/);
  assert.match(ui, /const preview = prepared\.data\?\.preview/);
  assert.match(ui, /openPlatformPreviewDialog\(\{\s*\.\.\.preview/s);
  assert.match(ui, /acknowledge_provider_action_preview/);
  assert.match(ui, /action: "create-draft"[\s\S]*receiptId/);
  assert.match(shared, /prepare_provider_action_preview_service/);
  assert.match(shared, /claim_cms_draft_with_preview_service/);
  assert.doesNotMatch(shared, /consume_provider_action_preview_service/);
  const reconcileOnly = shared.slice(
    shared.indexOf("export async function claimCmsAttempt("),
    shared.indexOf("export async function updateCmsAttempt("),
  );
  assert.doesNotMatch(reconcileOnly, /\.insert\(|\.update\(/);
  for (const source of [wix, wordpress]) {
    assert.match(source, /body\.previewConfirmed !== undefined/);
    assert.match(source, /body\.executeConfirmed !== undefined/);
    assert.match(source, /action === "prepare-preview"/);
    const create = source.slice(source.indexOf('if (["create-draft", "reconcile"].includes(action))'));
    ordered(create, [
      'const receiptId = String(body.receiptId || "")',
      "claimCmsAttemptWithPreview(",
      "createDraft(fresh.context, claimed.attempt)",
    ]);
    assert.doesNotMatch(create, /consumeCmsActionPreview\(/);
  }
  const wrapper = sql.slice(
    sql.indexOf("create or replace function public.claim_cms_draft_with_preview_service"),
    sql.indexOf("-- The provider has already confirmed"),
  );
  ordered(wrapper, [
    "v_attempt_id:=gen_random_uuid()",
    "perform public.consume_provider_action_preview_for_claim_service(",
    "insert into public.cms_draft_attempts(",
  ]);
  assert.match(wrapper, /p_claim_id|v_attempt_id/);
});
