#!/usr/bin/env node

/**
 * Build a reviewable, fail-closed SQL transaction that stages the approved
 * OpenArt social items in public.drafts only. This script never connects to a
 * database. The generated SQL must be reviewed and run separately after the
 * provider-preview release is live.
 *
 * UUID namespace derivation:
 *   UUIDv5(DNS namespace, "mypersonas.online/openart-private-draft/v1")
 * Each draft id is UUIDv5(OPENART_PRIVATE_DRAFT_NAMESPACE, source post id).
 * The source post id—not a mutable fingerprint—is deliberately the UUID name.
 *
 * Runtime mapping JSON (IDs and provider subjects must come from a fresh,
 * owner-scoped database readback; none are stored in this source file):
 * {
 *   "schema_version": "1.0",
 *   "owner_id": "<uuid>",
 *   "personas": [{ "persona_handle": "...", "persona_id": "<uuid>" }],
 *   "accounts": [{
 *     "source_post_id": "...", "account_id": "<uuid>",
 *     "persona_handle": "...", "provider": "facebook|instagram|x",
 *     "target_account": "...", "provider_subject": "...",
 *     "connection_state": "connected"
 *   }]
 * }
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPENART_PRIVATE_DRAFT_NAMESPACE = "1c0b86ef-3a5b-51cd-a0ac-fa3de90903e9";
export const READY_STATUS = "evidence_complete_release_not_authorized";
export const BLOCKED_STATUS = "blocked_missing_owner_selected_media";
export const MEDIA_STATE = "owner_media_approval_complete_release_not_authorized";
export const READINESS_STATE = "read_only_release_readiness_evidence_release_not_authorized";
export const MEDIA_APPROVAL_SCOPE = "owner_approved_media_inventory_only_not_caption_upload_schedule_queue_connect_deploy_or_publication";
export const MEDIA_GENERATION_SCOPE = "private_generation_only";
export const READINESS_EVIDENCE_SCOPE = "read_only_copy_target_proposed_time_and_owner_selected_media_evidence_only_not_release_authorization";
export const READINESS_APPROVAL_SCOPE = "concept_copy_time_only_not_media_or_publication";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const POST_ID_RE = /^[a-z0-9][a-z0-9_]{2,159}$/;
const HANDLE_RE = /^[a-z0-9._]{3,30}$/;
const PLATFORM_LIMITS = Object.freeze({ facebook: 30_000, instagram: 2_200, twitter: 280 });
const MEDIA_ACTION_FLAGS = Object.freeze([
  "publishing_enabled", "uploading_enabled", "scheduling_enabled",
  "queueing_enabled", "connecting_enabled", "deploying_enabled"
]);
const READINESS_ACTION_FLAGS = Object.freeze([
  ...MEDIA_ACTION_FLAGS, "provider_actions_enabled"
]);
const MEDIA_MANIFEST_FIELDS = new Set([
  "schema_version", "generated_at", "state", "approval_scope", "generation_scope",
  ...MEDIA_ACTION_FLAGS, "source_approval_manifest_file", "source_approval_manifest_sha256",
  "source_decisions_file", "source_decisions_sha256", "source_packet_fingerprint",
  "source_transition_ledger_sha256", "counts", "final_resolution_values",
  "transition_ledger_sha256", "packet_fingerprint", "items"
]);
const MEDIA_ITEM_FIELDS = new Set([
  "sequence", "revision_ordinal", "job_id", "persona", "persona_handle", "job_kind",
  "slot", "platforms", "source_item_fingerprint", "cycle_2_item_fingerprint",
  "prior_owner_decision", "final_cycle_2_decision", "final_resolution", "inventory_status",
  "selected_media", "audited_reviewed_media", "prior_reviewed_media",
  "transition_fingerprint", "item_fingerprint"
]);
const READINESS_MANIFEST_FIELDS = new Set([
  "schema_version", "generated_at", "state", "evidence_scope", ...READINESS_ACTION_FLAGS,
  "source_media_manifest_file", "source_media_manifest_sha256", "source_media_packet_fingerprint",
  "source_post_queue_file", "source_post_queue_sha256", "source_post_decisions_file",
  "source_post_decisions_sha256", "source_owner_validation_file", "source_owner_validation_sha256",
  "source_approval_scope", "counts", "platform_counts", "next_gate", "posts",
  "profile_visuals", "post_ledger_sha256", "profile_visual_ledger_sha256", "packet_fingerprint"
]);
const READINESS_POST_FIELDS = new Set([
  "id", "persona", "persona_handle", "platform", "target_account", "inventory_connection_state",
  "provider_readiness", "source_state", "proposed_scheduled_for", "timezone", "timing_basis",
  "theme", "hook", "caption", "alt_text", "adult_policy_review_required", "privacy_review_required",
  "identity_confirmation_note", "concept_decision", "approval_scope", "approval_fingerprint",
  "source_queue_post_fingerprint", "media_status", "media_blocker", "media_job_id",
  "media_item_fingerprint", "media_final_resolution", "selected_media", "readiness_status",
  "release_authorized", "item_fingerprint"
]);
const PROFILE_VISUAL_FIELDS = new Set([
  "job_id", "persona", "persona_handle", "slot", "inventory_status", "final_resolution",
  "media_item_fingerprint", "selected_media", "blocker", "release_authorized", "item_fingerprint"
]);
const EXPECTED = Object.freeze({
  posts: 84,
  readyPosts: 59,
  blockedPosts: 25,
  socialAssets: 56,
  selectedSocialAssets: 39,
  excludedSocialAssets: 17,
  profileVisuals: 7,
  selectedProfileVisuals: 5,
  excludedProfileVisuals: 2,
  mediaItems: 63,
  selectedMediaItems: 44,
  excludedMediaItems: 19,
  personas: 28
});

const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmpty = value => typeof value === "string" && value.trim().length > 0;
const invariant = (condition, message) => { if (!condition) throw new Error(message); };
const sha256Text = value => createHash("sha256").update(value).digest("hex");

function exactKeys(value, expected, label) {
  invariant(isPlainObject(value), `${label} must be an object`);
  const actual = Object.keys(value);
  const missing = [...expected].filter(key => !Object.hasOwn(value, key));
  const unexpected = actual.filter(key => !expected.has(key));
  invariant(missing.length === 0 && unexpected.length === 0,
    `${label} fields drifted${missing.length ? `; missing: ${missing.join(", ")}` : ""}${unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : ""}`);
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uuidBytes(uuid) {
  invariant(UUID_RE.test(uuid), `invalid UUID: ${uuid}`);
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

export function uuidV5(name, namespace = OPENART_PRIVATE_DRAFT_NAMESPACE) {
  invariant(typeof name === "string" && name.length > 0, "UUIDv5 name is required");
  const digest = createHash("sha1").update(Buffer.concat([uuidBytes(namespace), Buffer.from(name, "utf8")])).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizePlatform(platform) {
  const value = String(platform ?? "").trim().toLowerCase();
  if (value === "x" || value === "x/twitter") return "twitter";
  return value;
}

function selectedMediaCore(media) {
  if (media === null) return null;
  return {
    local_file: media.local_file,
    sha256: media.sha256,
    bytes: media.bytes,
    width: media.width,
    height: media.height,
    format: media.format
  };
}

function canonicalReadinessPost(post) {
  return {
    id: post.id,
    persona: post.persona,
    persona_handle: post.persona_handle,
    platform: post.platform,
    target_account: post.target_account,
    inventory_connection_state: post.inventory_connection_state,
    provider_readiness: post.provider_readiness,
    source_state: post.source_state,
    proposed_scheduled_for: post.proposed_scheduled_for,
    timezone: post.timezone,
    timing_basis: post.timing_basis,
    theme: post.theme,
    hook: post.hook,
    caption: post.caption,
    alt_text: post.alt_text,
    adult_policy_review_required: post.adult_policy_review_required,
    privacy_review_required: post.privacy_review_required,
    identity_confirmation_note: post.identity_confirmation_note,
    concept_decision: post.concept_decision,
    approval_scope: post.approval_scope,
    approval_fingerprint: post.approval_fingerprint,
    source_queue_post_fingerprint: post.source_queue_post_fingerprint,
    media_status: post.media_status,
    media_blocker: post.media_blocker,
    media_job_id: post.media_job_id,
    media_item_fingerprint: post.media_item_fingerprint,
    media_final_resolution: post.media_final_resolution,
    selected_media: selectedMediaCore(post.selected_media),
    readiness_status: post.readiness_status,
    release_authorized: post.release_authorized
  };
}

export function fingerprintReadinessPost(post) {
  return sha256Text(stableStringify(canonicalReadinessPost(post)));
}

function canonicalProfileVisual(item) {
  return {
    job_id: item.job_id,
    persona: item.persona,
    persona_handle: item.persona_handle,
    slot: item.slot,
    inventory_status: item.inventory_status,
    final_resolution: item.final_resolution,
    media_item_fingerprint: item.media_item_fingerprint,
    selected_media: selectedMediaCore(item.selected_media),
    blocker: item.blocker,
    release_authorized: item.release_authorized
  };
}

export function fingerprintProfileVisual(item) {
  return sha256Text(stableStringify(canonicalProfileVisual(item)));
}

export function readinessLedgerSha(items) {
  return sha256Text(stableStringify(items.map(item => ({
    id: item.id || item.job_id,
    item_fingerprint: item.item_fingerprint
  }))));
}

function canonicalReadinessPacket(manifest) {
  return {
    schema_version: manifest.schema_version,
    state: manifest.state,
    evidence_scope: manifest.evidence_scope,
    action_flags: Object.fromEntries(READINESS_ACTION_FLAGS.map(field => [field, manifest[field]])),
    source_media_manifest_sha256: manifest.source_media_manifest_sha256,
    source_media_packet_fingerprint: manifest.source_media_packet_fingerprint,
    source_post_queue_sha256: manifest.source_post_queue_sha256,
    source_post_decisions_sha256: manifest.source_post_decisions_sha256,
    source_owner_validation_sha256: manifest.source_owner_validation_sha256,
    source_approval_scope: manifest.source_approval_scope,
    counts: manifest.counts,
    platform_counts: manifest.platform_counts,
    next_gate: manifest.next_gate,
    post_ledger_sha256: manifest.post_ledger_sha256,
    profile_visual_ledger_sha256: manifest.profile_visual_ledger_sha256,
    post_item_fingerprints: manifest.posts.map(item => item.item_fingerprint),
    profile_visual_item_fingerprints: manifest.profile_visuals.map(item => item.item_fingerprint)
  };
}

export function fingerprintReadinessPacket(manifest) {
  return sha256Text(stableStringify(canonicalReadinessPacket(manifest)));
}

function mediaCore(media) {
  if (media === null) return null;
  return {
    local_file: media.local_file,
    sha256: media.sha256,
    bytes: media.bytes,
    width: media.width,
    height: media.height,
    format: media.format,
    resource_url: media.resource_url,
    history_id: media.history_id,
    creation_id: media.creation_id,
    media_fingerprint: media.media_fingerprint,
    qa_status: media.qa_status,
    qa_observation: media.qa_observation
  };
}

function canonicalMediaTransition(item) {
  return {
    sequence: item.sequence,
    revision_ordinal: item.revision_ordinal,
    job_id: item.job_id,
    source_item_fingerprint: item.source_item_fingerprint,
    cycle_2_item_fingerprint: item.cycle_2_item_fingerprint,
    prior_owner_decision: item.prior_owner_decision,
    final_cycle_2_decision: item.final_cycle_2_decision,
    final_resolution: item.final_resolution,
    inventory_status: item.inventory_status,
    selected_media: mediaCore(item.selected_media),
    audited_reviewed_media: mediaCore(item.audited_reviewed_media),
    prior_reviewed_media: mediaCore(item.prior_reviewed_media)
  };
}

export function fingerprintMediaTransition(item) {
  return sha256Text(stableStringify(canonicalMediaTransition(item)));
}

function canonicalMediaItem(item) {
  return {
    sequence: item.sequence,
    revision_ordinal: item.revision_ordinal,
    job_id: item.job_id,
    persona: item.persona,
    persona_handle: item.persona_handle,
    job_kind: item.job_kind,
    slot: item.slot,
    platforms: item.platforms,
    source_item_fingerprint: item.source_item_fingerprint,
    cycle_2_item_fingerprint: item.cycle_2_item_fingerprint,
    prior_owner_decision: item.prior_owner_decision,
    final_cycle_2_decision: item.final_cycle_2_decision,
    final_resolution: item.final_resolution,
    inventory_status: item.inventory_status,
    selected_media: mediaCore(item.selected_media),
    audited_reviewed_media: mediaCore(item.audited_reviewed_media),
    prior_reviewed_media: mediaCore(item.prior_reviewed_media),
    transition_fingerprint: item.transition_fingerprint
  };
}

export function fingerprintMediaItem(item) {
  return sha256Text(stableStringify(canonicalMediaItem(item)));
}

export function mediaTransitionLedgerSha(items) {
  return sha256Text(stableStringify(items.map(item => ({
    sequence: item.sequence,
    job_id: item.job_id,
    final_resolution: item.final_resolution,
    inventory_status: item.inventory_status,
    transition_fingerprint: item.transition_fingerprint
  }))));
}

function canonicalMediaPacket(manifest) {
  return {
    schema_version: manifest.schema_version,
    state: manifest.state,
    approval_scope: manifest.approval_scope,
    generation_scope: manifest.generation_scope,
    action_flags: Object.fromEntries(MEDIA_ACTION_FLAGS.map(field => [field, manifest[field]])),
    source_approval_manifest_sha256: manifest.source_approval_manifest_sha256,
    source_decisions_sha256: manifest.source_decisions_sha256,
    source_packet_fingerprint: manifest.source_packet_fingerprint,
    source_transition_ledger_sha256: manifest.source_transition_ledger_sha256,
    counts: manifest.counts,
    final_resolution_values: manifest.final_resolution_values,
    transition_ledger_sha256: manifest.transition_ledger_sha256,
    item_fingerprints: manifest.items.map(item => item.item_fingerprint)
  };
}

export function fingerprintMediaPacket(manifest) {
  return sha256Text(stableStringify(canonicalMediaPacket(manifest)));
}

function assertSafeOpenArtUrl(value, label) {
  invariant(nonEmpty(value), `${label} resource_url is required`);
  invariant(Buffer.byteLength(value, "utf8") <= 2048, `${label} resource_url exceeds 2048 UTF-8 bytes`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} resource_url is not a valid URL`); }
  invariant(parsed.protocol === "https:", `${label} resource_url must use HTTPS`);
  invariant(parsed.hostname.toLowerCase() === "cdn.openart.ai", `${label} resource_url must use cdn.openart.ai`);
  invariant(parsed.username === "" && parsed.password === "", `${label} resource_url must not contain credentials`);
  invariant(parsed.search === "" && parsed.hash === "", `${label} resource_url must not contain a query or fragment`);
  invariant(parsed.pathname.startsWith("/openart-ai/production/"), `${label} resource_url is outside the approved OpenArt production path`);
}

function assertMediaRecord(media, label, selected) {
  invariant(isPlainObject(media), `${label} must be an object`);
  invariant(nonEmpty(media.local_file) && !path.isAbsolute(media.local_file), `${label} local_file must be relative`);
  invariant(SHA_RE.test(media.sha256), `${label} sha256 is invalid`);
  invariant(Number.isSafeInteger(media.bytes) && media.bytes > 0, `${label} bytes is invalid`);
  invariant(Number.isSafeInteger(media.width) && media.width > 0, `${label} width is invalid`);
  invariant(Number.isSafeInteger(media.height) && media.height > 0, `${label} height is invalid`);
  invariant(media.format === "png", `${label} format must be png`);
  if (selected) assertSafeOpenArtUrl(media.resource_url, label);
}

function validateApprovedMediaManifest(manifest, raw) {
  invariant(isPlainObject(manifest), "owner-approved media manifest must be an object");
  exactKeys(manifest, MEDIA_MANIFEST_FIELDS, "owner-approved media manifest");
  invariant(manifest.schema_version === "1.0", "owner-approved media schema_version must be 1.0");
  invariant(manifest.state === MEDIA_STATE, "owner-approved media state drifted");
  invariant(manifest.approval_scope === MEDIA_APPROVAL_SCOPE, "owner-approved media approval_scope drifted");
  invariant(manifest.generation_scope === MEDIA_GENERATION_SCOPE, "owner-approved media generation_scope drifted");
  for (const flag of MEDIA_ACTION_FLAGS) invariant(manifest[flag] === false, `owner-approved media ${flag} must be false`);
  invariant(Array.isArray(manifest.items) && manifest.items.length === EXPECTED.mediaItems, `owner-approved media must contain exactly ${EXPECTED.mediaItems} items`);
  invariant(new Set(manifest.items.map(item => item.job_id)).size === EXPECTED.mediaItems, "owner-approved media job IDs must be unique");
  invariant(manifest.items.every((item, index) => item.sequence === index + 1), "owner-approved media sequences must be ordered 1 through 63");

  const social = manifest.items.filter(item => item.job_kind === "social_post");
  const profile = manifest.items.filter(item => item.job_kind === "profile_visual");
  const selected = manifest.items.filter(item => item.inventory_status === "selected");
  const excluded = manifest.items.filter(item => item.inventory_status === "excluded");
  invariant(social.length === EXPECTED.socialAssets, `expected ${EXPECTED.socialAssets} social assets`);
  invariant(profile.length === EXPECTED.profileVisuals, `expected ${EXPECTED.profileVisuals} profile visuals`);
  invariant(selected.length === EXPECTED.selectedMediaItems && excluded.length === EXPECTED.excludedMediaItems, "owner-approved media selected/excluded counts drifted");
  invariant(social.filter(item => item.inventory_status === "selected").length === EXPECTED.selectedSocialAssets, `expected ${EXPECTED.selectedSocialAssets} selected social assets`);
  invariant(social.filter(item => item.inventory_status === "excluded").length === EXPECTED.excludedSocialAssets, `expected ${EXPECTED.excludedSocialAssets} excluded social assets`);
  invariant(profile.filter(item => item.inventory_status === "selected").length === EXPECTED.selectedProfileVisuals, `expected ${EXPECTED.selectedProfileVisuals} selected profile visuals`);
  invariant(profile.filter(item => item.inventory_status === "excluded").length === EXPECTED.excludedProfileVisuals, `expected ${EXPECTED.excludedProfileVisuals} excluded profile visuals`);
  const actualCounts = {
    total: manifest.items.length,
    selected: selected.length,
    excluded: excluded.length,
    approved_cycle_2_candidate: manifest.items.filter(item => item.final_resolution === "approved_cycle_2_candidate").length,
    retained_prior_selected: manifest.items.filter(item => item.final_resolution === "retained_prior_selected").length,
    retained_prior_source: manifest.items.filter(item => item.final_resolution === "retained_prior_source").length,
    excluded_prior_denial: manifest.items.filter(item => item.final_resolution === "excluded_prior_denial").length
  };
  invariant(stableStringify(manifest.counts) === stableStringify(actualCounts), "owner-approved media manifest counts drifted");
  invariant(stableStringify(manifest.final_resolution_values) === stableStringify([
    "approved_cycle_2_candidate", "retained_prior_selected",
    "retained_prior_source", "excluded_prior_denial"
  ]), "owner-approved media final resolution values drifted");

  for (const item of manifest.items) {
    exactKeys(item, MEDIA_ITEM_FIELDS, `owner-approved media item ${item.job_id}`);
    invariant(nonEmpty(item.job_id) && POST_ID_RE.test(item.job_id), `invalid media job_id ${item.job_id}`);
    invariant(HANDLE_RE.test(item.persona_handle), `invalid media persona_handle for ${item.job_id}`);
    invariant(Array.isArray(item.platforms) && item.platforms.length > 0, `media platforms missing for ${item.job_id}`);
    invariant(["selected", "excluded"].includes(item.inventory_status), `invalid inventory_status for ${item.job_id}`);
    if (item.job_kind === "social_post") {
      invariant(item.slot === "x" || item.slot === "facebook_instagram", `invalid social slot for ${item.job_id}`);
      const expectedPlatforms = item.slot === "x" ? ["x"] : ["facebook", "instagram"];
      invariant(stableStringify([...item.platforms].sort()) === stableStringify(expectedPlatforms), `social platform binding drift for ${item.job_id}`);
    } else {
      invariant(item.job_kind === "profile_visual" && item.platforms.length === 1 && item.platforms[0] === "profile", `invalid profile visual binding for ${item.job_id}`);
    }
    if (item.inventory_status === "selected") {
      assertMediaRecord(item.selected_media, `selected media ${item.job_id}`, item.job_kind === "social_post");
    } else {
      invariant(item.selected_media === null, `excluded media ${item.job_id} must not expose selected_media`);
    }
    invariant(SHA_RE.test(item.transition_fingerprint) && item.transition_fingerprint === fingerprintMediaTransition(item), `media transition fingerprint drift for ${item.job_id}`);
    invariant(SHA_RE.test(item.item_fingerprint) && item.item_fingerprint === fingerprintMediaItem(item), `media item fingerprint drift for ${item.job_id}`);
  }
  invariant(manifest.transition_ledger_sha256 === mediaTransitionLedgerSha(manifest.items), "owner-approved media transition ledger drifted");
  invariant(manifest.packet_fingerprint === fingerprintMediaPacket(manifest), "owner-approved media packet fingerprint drifted");
  invariant(typeof raw === "string" && raw.length > 0, "owner-approved media raw JSON is required for source binding");
  return { rawSha256: sha256Text(raw), socialById: new Map(social.map(item => [item.job_id, item])) };
}

function validateReadinessManifest(manifest, mediaManifest, mediaRawSha256, socialById) {
  invariant(isPlainObject(manifest), "release-readiness manifest must be an object");
  exactKeys(manifest, READINESS_MANIFEST_FIELDS, "release-readiness manifest");
  invariant(manifest.schema_version === "1.0", "release-readiness schema_version must be 1.0");
  invariant(manifest.state === READINESS_STATE, "release-readiness state drifted");
  invariant(manifest.evidence_scope === READINESS_EVIDENCE_SCOPE, "release-readiness evidence_scope drifted");
  invariant(manifest.source_approval_scope === READINESS_APPROVAL_SCOPE, "release-readiness source approval_scope drifted");
  for (const flag of READINESS_ACTION_FLAGS) invariant(manifest[flag] === false, `release-readiness ${flag} must be false`);
  invariant(manifest.source_media_manifest_sha256 === mediaRawSha256, "release-readiness media manifest SHA binding drifted");
  invariant(manifest.source_media_packet_fingerprint === mediaManifest.packet_fingerprint, "release-readiness media packet fingerprint binding drifted");
  invariant(Array.isArray(manifest.posts) && manifest.posts.length === EXPECTED.posts, `release-readiness must contain exactly ${EXPECTED.posts} posts`);
  invariant(Array.isArray(manifest.profile_visuals) && manifest.profile_visuals.length === EXPECTED.profileVisuals, `release-readiness must contain exactly ${EXPECTED.profileVisuals} profile visuals`);
  invariant(new Set(manifest.posts.map(post => post.id)).size === EXPECTED.posts, "release-readiness post IDs must be unique");
  invariant(new Set(manifest.posts.map(post => post.persona_handle)).size === EXPECTED.personas, `release-readiness must cover exactly ${EXPECTED.personas} personas`);
  invariant(stableStringify(manifest.counts) === stableStringify({
    posts_total: EXPECTED.posts,
    concept_approved_posts: EXPECTED.posts,
    media_covered_posts: EXPECTED.readyPosts,
    media_blocked_posts: EXPECTED.blockedPosts,
    social_assets_total: EXPECTED.socialAssets,
    selected_social_assets: EXPECTED.selectedSocialAssets,
    excluded_social_assets: EXPECTED.excludedSocialAssets,
    profile_visuals_total: EXPECTED.profileVisuals,
    selected_profile_visuals: EXPECTED.selectedProfileVisuals,
    excluded_profile_visuals: EXPECTED.excludedProfileVisuals,
    personas_total: EXPECTED.personas
  }), "release-readiness aggregate counts drifted");

  for (const post of manifest.posts) {
    exactKeys(post, READINESS_POST_FIELDS, `release-readiness post ${post.id}`);
    invariant(POST_ID_RE.test(post.id), `invalid source post id ${post.id}`);
    invariant(HANDLE_RE.test(post.persona_handle), `invalid persona_handle for ${post.id}`);
    invariant(["facebook", "instagram", "x"].includes(post.platform), `unsupported platform for ${post.id}`);
    invariant(post.concept_decision === "approve_concept" && post.approval_scope === READINESS_APPROVAL_SCOPE, `concept approval drift for ${post.id}`);
    invariant(post.release_authorized === false, `release_authorized must remain false for ${post.id}`);
    invariant(SHA_RE.test(post.item_fingerprint) && post.item_fingerprint === fingerprintReadinessPost(post), `readiness item fingerprint drift for ${post.id}`);
  }
  for (const visual of manifest.profile_visuals) {
    exactKeys(visual, PROFILE_VISUAL_FIELDS, `release-readiness profile visual ${visual.job_id}`);
    invariant(visual.release_authorized === false, `profile visual release_authorized must remain false for ${visual.job_id}`);
    invariant(visual.item_fingerprint === fingerprintProfileVisual(visual), `profile visual fingerprint drift for ${visual.job_id}`);
  }
  invariant(manifest.post_ledger_sha256 === readinessLedgerSha(manifest.posts), "release-readiness post ledger drifted");
  invariant(manifest.profile_visual_ledger_sha256 === readinessLedgerSha(manifest.profile_visuals), "release-readiness profile ledger drifted");
  invariant(manifest.packet_fingerprint === fingerprintReadinessPacket(manifest), "release-readiness packet fingerprint drifted");

  const ready = manifest.posts.filter(post => post.readiness_status === READY_STATUS);
  const blocked = manifest.posts.filter(post => post.readiness_status === BLOCKED_STATUS);
  invariant(ready.length === EXPECTED.readyPosts, `expected exactly ${EXPECTED.readyPosts} media-ready posts, found ${ready.length}`);
  invariant(blocked.length === EXPECTED.blockedPosts, `expected exactly ${EXPECTED.blockedPosts} blocked posts, found ${blocked.length}`);
  invariant(ready.length + blocked.length === manifest.posts.length, "release-readiness contains an unsupported post status");
  invariant(blocked.every(post => post.selected_media === null && post.media_status === "blocked_no_owner_selected_media"), "blocked posts must remain excluded and media-free");
  const actualPlatformCounts = Object.fromEntries(["facebook", "instagram", "x"].map(platform => {
    const posts = manifest.posts.filter(post => post.platform === platform);
    return [platform, {
      total: posts.length,
      media_covered: posts.filter(post => post.readiness_status === READY_STATUS).length,
      media_blocked: posts.filter(post => post.readiness_status === BLOCKED_STATUS).length
    }];
  }));
  invariant(stableStringify(manifest.platform_counts) === stableStringify(actualPlatformCounts), "release-readiness platform counts drifted");

  const profileIds = new Set(manifest.profile_visuals.map(item => item.job_id));
  for (const post of ready) {
    invariant(!profileIds.has(post.media_job_id), `profile visual leaked into social post ${post.id}`);
  }
  const selectedSocialIds = new Set([...socialById.values()]
    .filter(item => item.inventory_status === "selected")
    .map(item => item.job_id));
  const readyMediaIds = new Set(ready.map(post => post.media_job_id));
  invariant(readyMediaIds.size === EXPECTED.selectedSocialAssets
    && [...selectedSocialIds].every(id => readyMediaIds.has(id)),
  "media-ready posts must bind the exact 39 selected social assets");
  for (const post of ready) {
    const media = socialById.get(post.media_job_id);
    invariant(media, `approved social media job not found for ${post.id}`);
    invariant(media.job_kind === "social_post" && media.inventory_status === "selected", `non-selected social media joined to ${post.id}`);
    invariant(media.persona_handle === post.persona_handle, `persona/media join drift for ${post.id}`);
    invariant(media.platforms.includes(post.platform), `platform/media join drift for ${post.id}`);
    invariant(post.media_item_fingerprint === media.item_fingerprint, `media item fingerprint drift for ${post.id}`);
    invariant(post.media_status === "owner_selected_media_bound" && post.media_blocker === null, `media readiness drift for ${post.id}`);
    invariant(post.selected_media?.local_file === media.selected_media.local_file && post.selected_media?.sha256 === media.selected_media.sha256, `selected media pointer drift for ${post.id}`);
  }
  const excludedSocialIds = new Set([...socialById.values()]
    .filter(item => item.inventory_status === "excluded")
    .map(item => item.job_id));
  const blockedMediaIds = new Set(blocked.map(post => post.media_job_id));
  invariant(blockedMediaIds.size === EXPECTED.excludedSocialAssets
    && [...excludedSocialIds].every(id => blockedMediaIds.has(id)),
  "blocked posts must bind the exact 17 excluded social assets");
  for (const post of blocked) {
    const media = socialById.get(post.media_job_id);
    invariant(media?.inventory_status === "excluded", `blocked post does not bind excluded media for ${post.id}`);
    invariant(post.media_item_fingerprint === media.item_fingerprint, `blocked media fingerprint drift for ${post.id}`);
  }
  return ready;
}

function validateMapping(mapping, readyPosts) {
  invariant(isPlainObject(mapping), "runtime mapping must be an object");
  const allowedTop = new Set(["schema_version", "owner_id", "personas", "accounts"]);
  invariant(Object.keys(mapping).every(key => allowedTop.has(key)) && Object.keys(mapping).length === allowedTop.size, "runtime mapping must contain only schema_version, owner_id, personas, and accounts");
  invariant(mapping.schema_version === "1.0", "runtime mapping schema_version must be 1.0");
  invariant(UUID_RE.test(mapping.owner_id), "runtime mapping owner_id must be a UUID");
  invariant(Array.isArray(mapping.personas), "runtime mapping personas must be an array");
  invariant(Array.isArray(mapping.accounts), "runtime mapping accounts must be an array");

  const requiredHandles = new Set(readyPosts.map(post => post.persona_handle));
  const personaMap = new Map();
  for (const entry of mapping.personas) {
    invariant(isPlainObject(entry) && Object.keys(entry).length === 2 && Object.hasOwn(entry, "persona_handle") && Object.hasOwn(entry, "persona_id"), "each persona mapping must contain only persona_handle and persona_id");
    invariant(requiredHandles.has(entry.persona_handle), `unexpected persona mapping ${entry.persona_handle}`);
    invariant(UUID_RE.test(entry.persona_id), `invalid persona_id for ${entry.persona_handle}`);
    invariant(!personaMap.has(entry.persona_handle), `duplicate persona mapping ${entry.persona_handle}`);
    personaMap.set(entry.persona_handle, entry.persona_id.toLowerCase());
  }
  invariant(personaMap.size === requiredHandles.size && [...requiredHandles].every(handle => personaMap.has(handle)), "runtime mapping must map every media-ready persona exactly once");

  const readyById = new Map(readyPosts.map(post => [post.id, post]));
  const accountMap = new Map();
  const accountKeys = new Set(["source_post_id", "account_id", "persona_handle", "provider", "target_account", "provider_subject", "connection_state"]);
  for (const entry of mapping.accounts) {
    invariant(isPlainObject(entry) && Object.keys(entry).length === accountKeys.size && Object.keys(entry).every(key => accountKeys.has(key)), "each account mapping must contain only source_post_id, account_id, persona_handle, provider, target_account, provider_subject, and connection_state");
    const post = readyById.get(entry.source_post_id);
    invariant(post, `account mapping references a non-ready or unknown post ${entry.source_post_id}`);
    invariant(post.provider_readiness === "destination_configured", `account mapping is not allowed unless provider_readiness is destination_configured for ${post.id}`);
    invariant(!accountMap.has(post.id), `duplicate account mapping for ${post.id}`);
    invariant(UUID_RE.test(entry.account_id), `invalid account_id for ${post.id}`);
    invariant(entry.persona_handle === post.persona_handle, `account persona mismatch for ${post.id}`);
    invariant(normalizePlatform(entry.provider) === normalizePlatform(post.platform), `account provider mismatch for ${post.id}`);
    invariant(entry.target_account === post.target_account, `account target mismatch for ${post.id}`);
    invariant(nonEmpty(entry.provider_subject) && Buffer.byteLength(entry.provider_subject, "utf8") <= 500, `account provider_subject is invalid for ${post.id}`);
    invariant(entry.connection_state === "connected", `account connection_state must be connected for ${post.id}`);
    accountMap.set(post.id, {
      account_id: entry.account_id.toLowerCase(),
      provider_subject: entry.provider_subject
    });
  }
  return { ownerId: mapping.owner_id.toLowerCase(), personaMap, accountMap };
}

function assertDraftText(value, label, maxBytes, required = false) {
  invariant(typeof value === "string", `${label} must be a string`);
  invariant(!required || value.trim().length > 0, `${label} is required`);
  invariant(Buffer.byteLength(value, "utf8") <= maxBytes, `${label} exceeds ${maxBytes} UTF-8 bytes`);
  invariant(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), `${label} contains unsupported control characters`);
}

export function buildDraftRows({ readinessManifest, approvedMediaManifest, approvedMediaRaw, mapping }) {
  const mediaValidation = validateApprovedMediaManifest(approvedMediaManifest, approvedMediaRaw);
  const readyPosts = validateReadinessManifest(
    readinessManifest,
    approvedMediaManifest,
    mediaValidation.rawSha256,
    mediaValidation.socialById
  );
  const runtime = validateMapping(mapping, readyPosts);
  const profileIds = new Set(approvedMediaManifest.items.filter(item => item.job_kind === "profile_visual").map(item => item.job_id));

  const rows = readyPosts.map(post => {
    invariant(!profileIds.has(post.media_job_id), `profile visual leaked into staging row ${post.id}`);
    const media = mediaValidation.socialById.get(post.media_job_id);
    const platform = normalizePlatform(post.platform);
    invariant(Object.hasOwn(PLATFORM_LIMITS, platform), `unsupported normalized platform ${platform}`);
    assertDraftText(post.theme, `title for ${post.id}`, 1000, true);
    assertDraftText(post.caption, `caption for ${post.id}`, 30_000, true);
    invariant([...post.caption].length <= PLATFORM_LIMITS[platform], `${platform} caption length exceeds ${PLATFORM_LIMITS[platform]} characters for ${post.id}`);
    assertSafeOpenArtUrl(media.selected_media.resource_url, `selected media ${post.media_job_id}`);
    const account = post.provider_readiness === "destination_configured" ? runtime.accountMap.get(post.id) : null;
    return {
      source_post_id: post.id,
      source_item_fingerprint: post.item_fingerprint,
      source_readiness_packet_fingerprint: readinessManifest.packet_fingerprint,
      source_media_packet_fingerprint: approvedMediaManifest.packet_fingerprint,
      source_media_manifest_sha256: readinessManifest.source_media_manifest_sha256,
      draft_id: uuidV5(post.id),
      owner_id: runtime.ownerId,
      persona_handle: post.persona_handle,
      persona_id: runtime.personaMap.get(post.persona_handle),
      account_id: account?.account_id ?? null,
      expected_provider_subject: account?.provider_subject ?? null,
      platform,
      target_account: post.target_account,
      provider_readiness: post.provider_readiness,
      title: post.theme,
      body: post.caption,
      tags: "",
      media_url: media.selected_media.resource_url,
      content_kind: "image"
    };
  });
  invariant(rows.length === EXPECTED.readyPosts, `staging row count must be exactly ${EXPECTED.readyPosts}`);
  invariant(new Set(rows.map(row => row.draft_id)).size === EXPECTED.readyPosts, "deterministic draft UUID collision detected");
  invariant(!rows.some(row => profileIds.has(row.source_post_id)), "profile visual leaked into staging rows");
  return rows;
}

function sqlPayload(rows) {
  return Buffer.from(JSON.stringify({
    schema_version: "1.0",
    namespace: OPENART_PRIVATE_DRAFT_NAMESPACE,
    owner_id: rows[0].owner_id,
    expected_count: EXPECTED.readyPosts,
    source_readiness_packet_fingerprint: rows[0].source_readiness_packet_fingerprint,
    source_media_packet_fingerprint: rows[0].source_media_packet_fingerprint,
    source_media_manifest_sha256: rows[0].source_media_manifest_sha256,
    drafts: rows
  }), "utf8").toString("base64");
}

export function renderStagingSql(rows) {
  invariant(Array.isArray(rows) && rows.length === EXPECTED.readyPosts, `SQL rendering requires exactly ${EXPECTED.readyPosts} rows`);
  invariant(new Set(rows.map(row => row.owner_id)).size === 1, "SQL rows must have one owner");
  const payload = sqlPayload(rows);
  return `-- MyPersonas OpenArt private-draft staging transaction, format v1.
-- Generated data only. Review before executing. This transaction inserts only
-- owner-private public.drafts rows and the draft quota counter; it never creates
-- posts, post_drafts, provider jobs, schedules, approvals, or agent actions.
-- Deterministic UUID namespace: ${OPENART_PRIVATE_DRAFT_NAMESPACE}
begin;

do $openart_private_drafts$
declare
  v_payload jsonb := convert_from(decode('${payload}', 'base64'), 'UTF8')::jsonb;
  v_owner uuid;
  v_item jsonb;
  v_draft_id uuid;
  v_persona_id uuid;
  v_account_id uuid;
  v_existing public.drafts%rowtype;
  v_existing_found boolean;
  v_missing_ids uuid[] := '{}'::uuid[];
  v_missing_count integer := 0;
  v_total integer;
  v_recent integer;
  v_persona_total integer;
  v_persona_missing integer;
  v_stored_bytes bigint;
  v_new_bytes bigint := 0;
  v_posts_before bigint;
  v_post_drafts_before bigint;
  v_actions_before bigint;
  v_provider text;
  v_account_persona uuid;
  v_connection_provider text;
  v_connection_state text;
  v_provider_subject text;
  v_connection_expires timestamptz;
  v_connection_error text;
  v_inserted integer := 0;
  v_staged_count integer;
  v_idea_group_present boolean;
  v_idea_group_nonnull integer := 0;
begin
  if v_payload->>'schema_version' <> '1.0'
     or v_payload->>'namespace' <> '${OPENART_PRIVATE_DRAFT_NAMESPACE}'
     or (v_payload->>'expected_count')::integer <> ${EXPECTED.readyPosts}
     or jsonb_array_length(v_payload->'drafts') <> ${EXPECTED.readyPosts}
     or coalesce(v_payload->>'source_readiness_packet_fingerprint','') !~ '^[0-9a-f]{64}$'
     or coalesce(v_payload->>'source_media_packet_fingerprint','') !~ '^[0-9a-f]{64}$'
     or coalesce(v_payload->>'source_media_manifest_sha256','') !~ '^[0-9a-f]{64}$' then
    raise exception 'OpenArt private-draft payload contract drifted';
  end if;
  v_owner := (v_payload->>'owner_id')::uuid;
  if v_owner is null or not exists(select 1 from public.profiles profile where profile.id=v_owner) then
    raise exception 'Mapped owner profile was not found';
  end if;
  if to_regprocedure('public.lock_owner_agent_storage(uuid)') is null then
    raise exception 'Owner storage lock helper is unavailable';
  end if;
  perform public.lock_owner_agent_storage(v_owner);
  select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='drafts' and column_name='idea_group_id'
  ) into v_idea_group_present;

  select count(*) into v_posts_before
  from public.posts post join public.personas persona on persona.id=post.persona_id
  where persona.owner=v_owner;
  select count(*) into v_post_drafts_before from public.post_drafts draft where draft.owner=v_owner;
  select count(*) into v_actions_before from public.agent_actions action where action.owner=v_owner;

  for v_item in select value from jsonb_array_elements(v_payload->'drafts')
  loop
    v_draft_id := (v_item->>'draft_id')::uuid;
    v_persona_id := (v_item->>'persona_id')::uuid;
    v_account_id := nullif(v_item->>'account_id','')::uuid;
    if v_item->>'owner_id' <> v_owner::text then
      raise exception 'Draft owner mapping drift for %', v_item->>'source_post_id';
    end if;
    if v_draft_id::text <> v_item->>'draft_id'
       or v_item->>'platform' not in ('facebook','instagram','twitter')
       or v_item->>'content_kind' <> 'image'
       or coalesce(v_item->>'tags','') <> '' then
      raise exception 'Draft tuple contract drift for %', v_item->>'source_post_id';
    end if;
    if octet_length(v_item->>'title') > 1000
       or octet_length(v_item->>'body') > 30000
       or octet_length(v_item->>'media_url') > 2048
       or btrim(coalesce(v_item->>'title','')) = ''
       or btrim(coalesce(v_item->>'body','')) = '' then
      raise exception 'Draft text limit failed for %', v_item->>'source_post_id';
    end if;
    if (v_item->>'platform'='twitter' and char_length(v_item->>'body')>280)
       or (v_item->>'platform'='instagram' and char_length(v_item->>'body')>2200) then
      raise exception 'Platform caption limit failed for %', v_item->>'source_post_id';
    end if;
    if (v_item->>'media_url') !~ '^https://cdn\\.openart\\.ai/openart-ai/production/'
       or (v_item->>'media_url') ~ '[?#]'
       or (v_item->>'media_url') ~ '[[:space:][:cntrl:]]' then
      raise exception 'Approved credential-free OpenArt HTTPS URL required for %', v_item->>'source_post_id';
    end if;

    perform public.lock_persona_agent_storage(v_persona_id);
    if not exists(select 1 from public.personas persona
      where persona.id=v_persona_id and persona.owner=v_owner
        and persona.handle=v_item->>'persona_handle' for share) then
      raise exception 'Owned persona mapping failed for %', v_item->>'source_post_id';
    end if;

    if v_account_id is not null then
      if v_item->>'provider_readiness' <> 'destination_configured'
         or nullif(v_item->>'expected_provider_subject','') is null then
        raise exception 'Account assignment is not destination-configured for %', v_item->>'source_post_id';
      end if;
      select ledger.provider,ledger.persona_id,connection.provider,
        connection.connection_state,connection.provider_subject,
        connection.expires_at,connection.error_code
      into v_provider,v_account_persona,v_connection_provider,
        v_connection_state,v_provider_subject,v_connection_expires,v_connection_error
      from public.account_ledger ledger
      join public.account_connections connection
        on connection.ledger_id=ledger.id and connection.owner=ledger.owner
      where ledger.id=v_account_id and ledger.owner=v_owner for share of ledger,connection;
      if not found
         or v_account_persona is distinct from v_persona_id
         or (case lower(btrim(v_provider)) when 'x' then 'twitter' when 'x/twitter' then 'twitter' else lower(btrim(v_provider)) end)
              is distinct from (v_item->>'platform')
         or (case lower(btrim(v_connection_provider)) when 'x' then 'twitter' when 'x/twitter' then 'twitter' else lower(btrim(v_connection_provider)) end)
              is distinct from (v_item->>'platform')
         or v_connection_state is distinct from 'connected'
         or btrim(coalesce(v_provider_subject,'')) is distinct from (v_item->>'expected_provider_subject')
         or (v_connection_expires is not null and v_connection_expires <= now()+interval '5 minutes')
         or btrim(coalesce(v_connection_error,'')) <> '' then
        raise exception 'Live account ownership/provider/state verification failed for %', v_item->>'source_post_id';
      end if;
    elsif nullif(v_item->>'expected_provider_subject','') is not null then
      raise exception 'Provider subject exists without account_id for %', v_item->>'source_post_id';
    end if;

    select * into v_existing from public.drafts draft
    where draft.id=v_draft_id for update;
    v_existing_found := found;
    if v_existing_found then
      if row(
        v_existing.owner,v_existing.persona_id,v_existing.account_id,
        v_existing.platform,v_existing.title,v_existing.body,v_existing.tags,
        v_existing.media_url,v_existing.status,v_existing.scheduled_for,
        v_existing.source_task_id,v_existing.content_kind,v_existing.approval_state,
        v_existing.publish_state,v_existing.publish_at,v_existing.approved_at,
        v_existing.approved_content_hash,v_existing.posted_at,
        v_existing.provider_post_id,v_existing.publish_error,
        v_existing.generated_by_agent,v_existing.publish_next_attempt_at,
        v_existing.media_asset_id,
        v_existing.approved_preview_version,v_existing.approved_preview_hash,
        v_existing.approved_preview_target_id,v_existing.approved_previewed_at
      ) is distinct from row(
        v_owner,v_persona_id,v_account_id,
        v_item->>'platform',v_item->>'title',v_item->>'body','',
        v_item->>'media_url','idea',null::date,
        null::uuid,'image','pending',
        'not_queued',null::timestamptz,null::timestamptz,
        '',null::timestamptz,
        '','',true,null::timestamptz,
        null::uuid,
        '','','',null::timestamptz
      ) then
        raise exception 'Existing deterministic draft differs; refusing to overwrite %', v_item->>'source_post_id';
      end if;
      if v_idea_group_present then
        execute 'select count(*) from public.drafts where id=$1 and idea_group_id is not null'
          into v_idea_group_nonnull using v_draft_id;
        if v_idea_group_nonnull<>0 then
          raise exception 'Existing deterministic draft has a non-null idea_group_id for %',v_item->>'source_post_id';
        end if;
      end if;
    else
      v_missing_ids := array_append(v_missing_ids,v_draft_id);
      v_missing_count := v_missing_count+1;
      v_new_bytes := v_new_bytes
        +octet_length(v_item->>'title')+octet_length(v_item->>'body')
        +octet_length(v_item->>'media_url')+octet_length(v_item->>'platform')
        +octet_length(v_item->>'content_kind');
    end if;
  end loop;

  select count(*) into v_total from (
    select 1 from public.drafts draft where draft.owner=v_owner limit 5001
  ) bounded;
  select count(*) into v_recent from (
    select 1 from public.drafts draft
    where draft.owner=v_owner and draft.created_at>=now()-interval '24 hours' limit 201
  ) bounded;
  if v_total+v_missing_count>5000 then raise exception 'Draft account limit would exceed 5000'; end if;
  if v_recent+v_missing_count>200 then raise exception 'Draft daily creation limit would exceed 200'; end if;

  for v_persona_id in
    select distinct (value->>'persona_id')::uuid
    from jsonb_array_elements(v_payload->'drafts')
    order by 1
  loop
    select count(*) into v_persona_total from (
      select 1 from public.drafts draft
      where draft.owner=v_owner and draft.persona_id=v_persona_id limit 1001
    ) bounded;
    select count(*) into v_persona_missing
    from jsonb_array_elements(v_payload->'drafts') item
    where (item->>'persona_id')::uuid=v_persona_id
      and (item->>'draft_id')::uuid=any(v_missing_ids);
    if v_persona_total+v_persona_missing>1000 then
      raise exception 'Draft persona limit would exceed 1000 for %',v_persona_id;
    end if;
  end loop;

  select coalesce(sum(
    octet_length(coalesce(bounded.title,''))+octet_length(coalesce(bounded.body,''))
    +octet_length(coalesce(bounded.tags,''))+octet_length(coalesce(bounded.media_url,''))
    +octet_length(coalesce(bounded.platform,''))+octet_length(coalesce(bounded.content_kind,''))
  ),0) into v_stored_bytes from (
    select draft.title,draft.body,draft.tags,draft.media_url,draft.platform,draft.content_kind
    from public.drafts draft where draft.owner=v_owner order by draft.id limit 5001
  ) bounded;
  if v_stored_bytes+v_new_bytes>67108864 then raise exception 'Draft storage limit would exceed 67108864 bytes'; end if;

  if v_missing_count>0 then
    insert into public.agent_storage_creation_counters(
      owner,resource,counter_date,daily_count,lifetime_count,updated_at
    ) values (
      v_owner,'drafts',current_date,v_recent+v_missing_count,v_missing_count,now()
    ) on conflict(owner,resource) do update set
      counter_date=current_date,
      daily_count=(case
        when public.agent_storage_creation_counters.counter_date=current_date
          then greatest(public.agent_storage_creation_counters.daily_count,v_recent)
        else v_recent end)+v_missing_count,
      lifetime_count=public.agent_storage_creation_counters.lifetime_count+v_missing_count,
      updated_at=now();
  end if;

  for v_item in select value from jsonb_array_elements(v_payload->'drafts')
  loop
    v_draft_id := (v_item->>'draft_id')::uuid;
    if v_draft_id=any(v_missing_ids) then
      insert into public.drafts(
        id,owner,persona_id,account_id,platform,title,body,tags,media_url,
        status,scheduled_for,source_task_id,content_kind,approval_state,
        publish_state,publish_at,approved_at,approved_content_hash,posted_at,
        provider_post_id,publish_error,generated_by_agent,publish_next_attempt_at,
        media_asset_id,approved_preview_version,
        approved_preview_hash,approved_preview_target_id,approved_previewed_at
      ) values (
        v_draft_id,v_owner,(v_item->>'persona_id')::uuid,
        nullif(v_item->>'account_id','')::uuid,v_item->>'platform',
        v_item->>'title',v_item->>'body','',v_item->>'media_url',
        'idea',null,null,'image','pending',
        'not_queued',null,null,'',null,
        '','',true,null,
        null,'','','',null
      );
      v_inserted := v_inserted+1;
    end if;
  end loop;
  if v_inserted<>v_missing_count then raise exception 'Private draft insert count drifted'; end if;

  select count(*) into v_staged_count from public.drafts draft
  where draft.owner=v_owner
    and draft.id in (select (value->>'draft_id')::uuid from jsonb_array_elements(v_payload->'drafts'))
    and draft.status='idea' and draft.approval_state='pending'
    and draft.approved_at is null and draft.approved_content_hash=''
    and draft.publish_state='not_queued' and draft.publish_next_attempt_at is null
    and draft.publish_at is null and draft.scheduled_for is null and draft.posted_at is null
    and draft.provider_post_id='' and draft.publish_error=''
    and draft.source_task_id is null and draft.media_asset_id is null
    and draft.generated_by_agent=true
    and draft.content_kind='image'
    and draft.approved_preview_version='' and draft.approved_preview_hash=''
    and draft.approved_preview_target_id='' and draft.approved_previewed_at is null;
  if v_staged_count<>${EXPECTED.readyPosts} then raise exception 'Post-insert private pending-state assertion failed'; end if;
  if v_idea_group_present then
    execute 'select count(*) from public.drafts where owner=$1 and id in '
      || '(select (value->>''draft_id'')::uuid from jsonb_array_elements($2->''drafts'')) '
      || 'and idea_group_id is not null'
      into v_idea_group_nonnull using v_owner,v_payload;
    if v_idea_group_nonnull<>0 then raise exception 'Post-insert idea_group_id null assertion failed'; end if;
  end if;
  if exists(
    select 1 from public.post_drafts queued
    where queued.id in (
      select (value->>'draft_id')::uuid from jsonb_array_elements(v_payload->'drafts')
    )
  ) then raise exception 'Zero-action assertion failed: deterministic IDs exist in post_drafts'; end if;
  if exists(
    select 1 from public.agent_actions action
    where action.entity_id in (
      select (value->>'draft_id')::uuid from jsonb_array_elements(v_payload->'drafts')
    )
  ) then raise exception 'Zero-action assertion failed: deterministic IDs have agent actions'; end if;
  if exists(
    select 1 from public.agent_draft_preview_receipts receipt
    where receipt.draft_id in (
      select (value->>'draft_id')::uuid from jsonb_array_elements(v_payload->'drafts')
    )
  ) then raise exception 'Zero-action assertion failed: deterministic IDs have preview receipts'; end if;
  if (select count(*) from public.posts post join public.personas persona on persona.id=post.persona_id where persona.owner=v_owner)<>v_posts_before
     or (select count(*) from public.post_drafts draft where draft.owner=v_owner)<>v_post_drafts_before
     or (select count(*) from public.agent_actions action where action.owner=v_owner)<>v_actions_before then
    raise exception 'Zero-action assertion failed: posts, post_drafts, or agent_actions changed';
  end if;
end
$openart_private_drafts$;

commit;
`;
}

function readJson(file, label) {
  invariant(nonEmpty(file), `${label} path is required`);
  const absolute = path.resolve(file);
  invariant(fs.existsSync(absolute) && fs.statSync(absolute).isFile(), `${label} not found at ${absolute}`);
  const raw = fs.readFileSync(absolute, "utf8");
  try { return { value: JSON.parse(raw), raw, absolute }; }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    invariant(["--readiness", "--media", "--mapping", "--out"].includes(key), `unknown argument ${key}`);
    invariant(index + 1 < argv.length, `missing value for ${key}`);
    invariant(!values.has(key), `duplicate argument ${key}`);
    values.set(key, argv[index + 1]);
  }
  for (const key of ["--readiness", "--media", "--mapping", "--out"]) invariant(values.has(key), `${key} is required`);
  return values;
}

export function buildStagingSql({ readinessManifest, approvedMediaManifest, approvedMediaRaw, mapping }) {
  return renderStagingSql(buildDraftRows({ readinessManifest, approvedMediaManifest, approvedMediaRaw, mapping }));
}

function main(argv) {
  const args = parseArgs(argv);
  const readiness = readJson(args.get("--readiness"), "release-readiness manifest");
  const media = readJson(args.get("--media"), "owner-approved media manifest");
  const mapping = readJson(args.get("--mapping"), "runtime mapping");
  const sql = buildStagingSql({
    readinessManifest: readiness.value,
    approvedMediaManifest: media.value,
    approvedMediaRaw: media.raw,
    mapping: mapping.value
  });
  const output = path.resolve(args.get("--out"));
  invariant(![readiness.absolute, media.absolute, mapping.absolute].includes(output), "output must not overwrite an input");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, sql, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output,
    rows: EXPECTED.readyPosts,
    action: "sql_built_not_executed",
    namespace: OPENART_PRIVATE_DRAFT_NAMESPACE
  })}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`OpenArt private-draft staging build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
