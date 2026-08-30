import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const html = await readFile(path.join(root, "MyPersonas.Online_v0/index.html"), "utf8");

function between(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `${start} must exist`);
  const to = html.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${end} must follow ${start}`);
  return html.slice(from, to);
}

test("YouTube account authorization is exact-channel, AAL2, and credential-gated", () => {
  const connect = between("async function connectYouTube(", "async function finishPendingYouTube(");
  assert.match(connect, /requireAal2ForSensitiveAction/);
  assert.match(connect, /youtubeOAuthCapability\.configured/);
  assert.match(connect, /accounts\.google\.com/);
  assert.match(connect, /youtube_oauth_/);
  assert.match(html, /https:\/\/nwsqyuucwzihruszocge\.supabase\.co\/functions\/v1\/youtube-oauth/);
});

test("Private YouTube upload cannot run until the exact rendered preview is acknowledged", () => {
  const prepare = between("async function prepareYouTubeDraft(", "async function reviewYouTubeDraft(");
  const review = between("async function reviewYouTubeDraft(", "async function acknowledgeAndUploadYouTube(");
  const send = between("async function acknowledgeAndUploadYouTube(", "async function prepareTikTokDraft(");
  assert.match(prepare, /exactVerifiedVideoAsset/);
  assert.match(prepare, /uploads immediately as <b>Private<\/b>/);
  assert.match(review, /action:"preview-draft"/);
  assert.match(review, /exactProviderActionPreview/);
  assert.match(review, /openPlatformPreviewDialog/);
  assert.match(review, /\.\.\.receipt\.preview/);
  assert.match(review, /Acknowledge preview & upload Private/);
  assert.match(send, /requireAal2ForSensitiveAction/);
  assert.match(send, /action:"acknowledge-preview"/);
  assert.match(send, /action:"publish-draft"/);
  assert.match(send, /receiptId:receipt\.id/);
  assert.ok(send.indexOf('action:"acknowledge-preview"') < send.indexOf('action:"publish-draft"'));
  assert.doesNotMatch(review + send, /previewConfirmed|executeConfirmed|action:"approve-preview"/);
});

test("TikTok first release is upload-to-inbox with a truthful preview and explicit consent", () => {
  const prepare = between("async function prepareTikTokDraft(", "async function reviewTikTokDraft(");
  const review = between("async function reviewTikTokDraft(", "async function acknowledgeAndSendTikTokDraft(");
  const send = between("async function acknowledgeAndSendTikTokDraft(", "function twitchActionLabel(");
  assert.match(prepare, /exactVerifiedVideoAsset/);
  assert.match(prepare, /caption is not transferred/);
  assert.match(prepare, /not a published or scheduled TikTok post/);
  assert.match(prepare, /explicitly consent/);
  assert.match(review, /publishMode:"upload_inbox"/);
  assert.match(review, /action:"prepare-preview"/);
  assert.match(review, /exactProviderActionPreview/);
  assert.match(review, /openPlatformPreviewDialog/);
  assert.match(review, /\.\.\.receipt\.preview/);
  assert.match(review, /caption is deliberately not represented as transferred/);
  assert.match(review, /Acknowledge preview & send to TikTok inbox/);
  assert.match(send, /requireAal2ForSensitiveAction/);
  assert.match(send, /action:"acknowledge-preview"/);
  assert.match(send, /action:"send-approved"/);
  assert.match(send, /receiptId:receipt\.id/);
  assert.ok(send.indexOf('action:"acknowledge-preview"') < send.indexOf('action:"send-approved"'));
  assert.doesNotMatch(review + send, /previewConfirmed|executeConfirmed|action:"approve-preview"/);
});

test("provider previews can display visibility and consent details", () => {
  const card = between("function platformPreviewCardHtml(", "function closePlatformPreviewDialog(");
  assert.match(card, /platformDetails/);
  assert.match(card, /details\.map/);
  assert.match(card, /"discord"/);
});

test("Discord uses exact-channel OAuth and owner-triggered platform previews only", () => {
  const connect = between("async function connectDiscord(", "async function finishPendingDiscord(");
  const publish = between("async function publishDiscordDraft(", "async function executeDiscordDraftPublish(");
  const execute = between("async function executeDiscordDraftPublish(", "async function verifyDiscordDraft(");
  const remove = between("async function deleteDiscordDraft(", "async function exactVerifiedVideoAsset(");
  assert.match(connect, /requireAal2ForSensitiveAction/);
  assert.match(connect, /discord\.com/);
  assert.match(connect, /discord_oauth_/);
  assert.match(publish, /openPlatformPreviewDialog/);
  assert.match(publish, /scheduled\/background posting is disabled/i);
  assert.match(publish, /Approve preview & post to Discord/);
  assert.match(execute, /action:"publish"/);
  assert.ok(publish.indexOf("openPlatformPreviewDialog") < publish.indexOf("executeDiscordDraftPublish"));
  assert.match(remove, /confirmMessageId/);
  assert.match(remove, /confirmChannelId/);
});

test("Twitch UI uses one exact server preview, separate AAL2 acknowledgement, and one-shot execution", () => {
  const prepare = between("async function prepareTwitchDraftAction(", "function renderTwitchActionFields(");
  const review = between("async function reviewTwitchDraftAction(", "async function recordTwitchActionPreview(");
  const record = between("async function recordTwitchActionPreview(", "async function executeTwitchAction(");
  const execute = between("async function executeTwitchAction(", "function showTwitchReconciliation(");
  assert.match(prepare, /twitchGrantedActions/);
  assert.match(prepare, /requireAal2ForSensitiveAction/);
  assert.match(prepare, /does not provide general feed posting or video upload/i);
  assert.match(review, /recordTwitchActionPreview/);
  assert.match(record, /action:"record-preview"/);
  assert.match(record, /previewVersion:"twitch-action-preview-v1"/);
  assert.match(record, /exactProviderActionPreview/);
  assert.match(record, /openPlatformPreviewDialog/);
  assert.match(record, /\.\.\.receipt\.preview/);
  assert.match(execute, /requireAal2ForSensitiveAction/);
  assert.match(execute, /action:"acknowledge-preview"/);
  assert.match(execute, /action:"execute"/);
  assert.match(execute, /receiptId:receipt\.id/);
  assert.ok(execute.indexOf('action:"acknowledge-preview"') < execute.indexOf('action:"execute"'));
  assert.doesNotMatch(record + execute, /previewConfirmed|executeConfirmed/);
  assert.match(execute, /reconciliationRequired/);
  assert.match(html, /Do not execute or resend this action again/);
});

test("Patreon UI previews the native handoff and never claims an API publish or schedule", () => {
  const prepare = between("async function preparePatreonHandoff(", "function updatePatreonScheduleVisibility(");
  const review = between("async function reviewPatreonHandoff(", "async function acknowledgeAndOpenPatreonHandoff(");
  const packageCall = between("async function acknowledgeAndOpenPatreonHandoff(", "function patreonCopyPackageText(");
  const open = between("async function openPatreonPreparedEditor(", "async function completePatreonPreparedHandoff(");
  const complete = between("async function completePatreonPreparedHandoff(", "async function abandonPatreonPreparedHandoff(");
  assert.match(prepare, /requireAal2ForSensitiveAction/);
  assert.match(prepare, /read\/report only/i);
  assert.match(prepare, /finish every save, publish, or schedule action in Patreon/i);
  assert.match(review, /openPlatformPreviewDialog/);
  assert.match(review, /action:"prepare-preview"/);
  assert.match(review, /exactProviderActionPreview/);
  assert.match(review, /\.\.\.receipt\.preview/);
  assert.match(review, /does not publish or schedule through the Patreon API/i);
  assert.match(review, /Patreon's own final preview/);
  assert.match(packageCall, /requireAal2ForSensitiveAction/);
  assert.match(packageCall, /action:"acknowledge-preview"/);
  assert.match(packageCall, /action:"open"/);
  assert.match(packageCall, /previewVersion:receipt\.version/);
  assert.match(packageCall, /receiptId:receipt\.id/);
  assert.ok(packageCall.indexOf('action:"acknowledge-preview"') < packageCall.indexOf('action:"open"'));
  assert.ok(packageCall.indexOf('action:"open"') < packageCall.indexOf("popup.location.replace"));
  assert.doesNotMatch(review + packageCall, /previewConfirmed|executeConfirmed|action:"opened"/);
  assert.match(open, /handoff\.nativeEditorUrl/);
  assert.match(complete, /action:"owner-completed"/);
  assert.match(complete, /owner-attested only/);
  assert.match(html, /not an API-published or API-scheduled post/i);
});

test("generic external approvals explain provider-specific second preview gates", () => {
  const details = between("function automationApprovalPlatformDetails(", "async function approveAutomationDraft(");
  assert.match(details, /draft\.platform==="twitch"/);
  assert.match(details, /second feature-specific preview/i);
  assert.match(details, /General feed posting and video upload are unavailable/i);
  assert.match(details, /draft\.platform==="patreon"/);
  assert.match(details, /second preview is required/i);
  assert.match(details, /completed and previewed again inside Patreon/i);
});
