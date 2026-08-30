import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const [oauth, post, canonical, mirror, config, oauthReadme, postReadme] = await Promise.all([
  readFile(path.join(root, "supabase/functions/youtube-oauth/index.ts"), "utf8"),
  readFile(path.join(root, "supabase/functions/youtube-post/index.ts"), "utf8"),
  readFile(path.join(root, "MyPersonas.Online_v0/sql-updates/067-youtube-oauth-publisher.sql")),
  readFile(path.join(root, "supabase/migrations/20260830100000_youtube_oauth_publisher.sql")),
  readFile(path.join(root, "supabase/config.toml"), "utf8"),
  readFile(path.join(root, "supabase/functions/youtube-oauth/README.md"), "utf8"),
  readFile(path.join(root, "supabase/functions/youtube-post/README.md"), "utf8"),
]);
const sql = canonical.toString("utf8");

function ordered(source, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker: ${marker}`);
    assert.ok(next > cursor, `${marker} is out of order`);
    cursor = next;
  }
}

test("YouTube canonical migration and timestamped release mirror are byte-identical", () => {
  assert.deepEqual(mirror, canonical);
  assert.match(config, /\[functions\.youtube-oauth\]\s*verify_jwt = false/);
  assert.match(config, /\[functions\.youtube-post\]\s*verify_jwt = true/);
});

test("OAuth is PKCE, state, browser-nonce, AAL2, and exact-channel bound", () => {
  assert.match(oauth, /requireAal2\(req, authClient\)/);
  assert.match(oauth, /code_challenge_method: "S256"/);
  assert.match(oauth, /state_hash: await sha256Hex\(state\)/);
  assert.match(oauth, /browser_nonce_hash: await sha256Hex\(browserNonce\)/);
  assert.match(oauth, /\.eq\("browser_nonce_hash", nonceHash\)/);
  assert.match(oauth, /access_type: "offline"/);
  assert.match(oauth, /prompt: "consent"/);
  assert.match(oauth, /include_granted_scopes: "false"/);
  assert.match(oauth, /"openid", "email", UPLOAD_SCOPE/);
  assert.match(oauth, /youtube_store_token_bundle/);
  assert.match(oauth, /manualRevocationRequired: true/);
  assert.match(oauth, /rejectedGrantRevoked: true/);
  assert.match(oauth, /localCleanupRequired: true/);
  assert.match(oauth, /identity\.channelId !== prior\.channelId/);
  assert.match(oauth, /ledger\.login_email.*identity\.email/s);
  assert.doesNotMatch(oauth, /youtube\.force-ssl|youtubepartner|youtube\.readonly/);
});

test("OAuth and upload capabilities are Vault-only and browser writes are revoked", () => {
  for (const table of [
    "youtube_oauth_transactions", "youtube_credentials",
    "youtube_token_operation_leases", "youtube_upload_sessions",
  ]) assert.match(sql, new RegExp(`revoke all[\\s\\S]*${table}`, "i"));
  assert.match(sql, /vault\.create_secret/);
  assert.match(sql, /vault\.update_secret/);
  assert.match(sql, /youtube_credentials_delete_vault_secret/);
  assert.match(sql, /youtube_upload_sessions_delete_vault_secret/);
  assert.match(sql, /guard_connected_youtube_ledger_change/);
  assert.match(sql, /Disconnect and revoke the YouTube grant before deleting or retargeting/);
  assert.match(sql, /grant select on public\.youtube_upload_approvals to authenticated/);
  assert.match(sql, /youtube upload approvals owner read/);
});

test("platform preview binds every required YouTube field and verified video identity", () => {
  for (const marker of [
    "channel_id", "video_asset_id", "video_sha256", "video_byte_size", "video_mime",
    "title", "description", "category_id", "made_for_kids", "contains_synthetic_media",
    "privacy_status", "preview_version", "draft_content_hash", "approval_hash", "preview_hash",
  ]) assert.match(sql, new RegExp(marker));
  assert.match(sql, /youtube-preview-v1/);
  assert.match(sql, /public\.agent_draft_hash/);
  assert.match(sql, /public\.youtube_upload_approval_hash/);
  assert.match(sql, /a\.public_url<>d\.media_url/);
  assert.match(sql, /a\.content_sha256/);
  assert.match(sql, /a\.provenance_sha256/);
  assert.match(sql, /a\.mime_type not in \('video\/mp4','video\/webm'\)/);
  assert.match(post, /preview-draft/);
  assert.match(post, /acknowledge-preview/);
  assert.match(post, /acknowledge_provider_action_preview/);
  assert.match(post, /claim_youtube_upload_with_preview_service/);
  assert.doesNotMatch(post, /consume_provider_action_preview_service/);
  assert.match(post, /Review and approve the current YouTube platform preview first/);
  assert.match(post, /approved_preview_version/);
  assert.match(post, /approved_preview_target_id/);
  assert.match(post, /agent_draft_preview_hash/);
  assert.match(post, /genericPlatformPreviewIsCurrent\(draft, connection\.provider_subject\)/);
  assert.match(
    post,
    /categoryId: DEFAULT_CATEGORY_ID,\s*categoryLabel: "People & Blogs"/,
  );
  assert.match(post, /p_category_id: approval\.category_id/);
  assert.match(sql, /category_id text not null default '22' check \(category_id = '22'\)/);
});

test("publisher recomputes both approval hashes and verifies exact stored bytes", () => {
  ordered(post, [
    "exactDraftHash(draft)",
    "exactApprovalHash(approval)",
    "draftHash.data !== draft.approved_content_hash",
    "approvalHash.data !== approval.approval_hash",
    "claim_youtube_upload_with_preview_service",
    "verifiedVideoBytes(owner, claimed, approval)",
    "providerChannel(credential.accessToken)",
  ]);
  assert.match(post, /await sha256Hex\(bytes\) !== approval\.video_sha256/);
  assert.match(post, /detectVideoMime\(bytes\) !== approval\.video_mime/);
  assert.match(post, /bytes\.byteLength !== approval\.video_byte_size/);
  assert.match(post, /service\.storage\.from\("persona-media"\)\.download/);
});

test("resumable upload persists capability before bytes and reconciles uncertain outcomes", () => {
  ordered(post, [
    "start = await fetch(UPLOAD_START_URL",
    "youtube_store_upload_session_service",
    "const status = await queryUploadSession(",
    "phase: \"video_bytes_upload_start\"",
    "Content-Range",
  ]);
  assert.match(post, /checkpointVideo\([\s\S]*?owner,[\s\S]*?claimed,[\s\S]*?approval,/);
  assert.match(post, /status\.status === 308/);
  assert.match(post, /uploadOffset/);
  assert.match(post, /providerUncertain\(error\)/);
  assert.match(post, /reconciliation_required/);
  assert.match(post, /Do not create a new upload session until this one is reconciled/);
  assert.match(post, /provider_post_id: videoId/);
  assert.match(post, /\.eq\("provider_post_id", ""\)/);
});

test("verification is private-first, processing-aware, and does not add delete scope", () => {
  assert.match(post, /String\(body\.privacyStatus \|\| "private"\)/);
  assert.match(post, /privacy !== "private"/);
  assert.match(sql, /privacy_status text not null default 'private' check \(privacy_status = 'private'\)/);
  assert.match(sql, /if p_privacy_status<>'private'/);
  assert.match(
    post,
    /snippet:\s*\{\s*title: approval\.title,\s*description: approval\.description,\s*categoryId: approval\.category_id,?\s*\}/,
  );
  assert.match(post, /resource\.categoryId !== approval\.category_id/);
  assert.match(post, /approval\.category_id !== DEFAULT_CATEGORY_ID/);
  assert.match(
    post,
    /verifyProcessing\(\s*credential\.accessToken,\s*videoId,\s*approval\.channel_id,\s*approval\.category_id,?\s*\)/,
  );
  assert.match(post, /selfDeclaredMadeForKids: approval\.made_for_kids/);
  assert.match(post, /containsSyntheticMedia: approval\.contains_synthetic_media/);
  assert.match(post, /part: "snippet,status,processingDetails"/);
  assert.match(post, /processingStatus/);
  assert.match(post, /https:\/\/studio\.youtube\.com\/video\/\$\{videoId\}\/edit/);
  assert.match(post, /No delete scope was requested/);
  assert.doesNotMatch(oauth + post, /videos\.delete|youtube\.force-ssl/);
  assert.match(oauth, /communityPostsSupported: false/);
  assert.match(postReadme, /does not support\s+YouTube Community posts/);
});

test("focused release notes point only to official Google and YouTube references", () => {
  for (const docs of [oauthReadme, postReadme]) {
    assert.doesNotMatch(docs, /client_secret\s*[:=]\s*\S+/i);
    for (const url of docs.match(/https:\/\/[^)>\s]+/g) || []) {
      assert.ok(
        url.startsWith("https://developers.google.com/") ||
          url.startsWith("https://nwsqyuucwzihruszocge.supabase.co/"),
        `unexpected documentation domain: ${url}`,
      );
    }
  }
});
