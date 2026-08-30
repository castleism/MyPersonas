import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  BLOCKED_STATUS,
  MEDIA_APPROVAL_SCOPE,
  MEDIA_GENERATION_SCOPE,
  MEDIA_STATE,
  OPENART_PRIVATE_DRAFT_NAMESPACE,
  READINESS_APPROVAL_SCOPE,
  READINESS_EVIDENCE_SCOPE,
  READINESS_STATE,
  READY_STATUS,
  buildDraftRows,
  buildStagingSql,
  fingerprintMediaItem,
  fingerprintMediaPacket,
  fingerprintMediaTransition,
  fingerprintProfileVisual,
  fingerprintReadinessPacket,
  fingerprintReadinessPost,
  mediaTransitionLedgerSha,
  readinessLedgerSha,
  renderStagingSql,
  uuidV5
} from "../scripts/build-openart-private-draft-staging.mjs";

const sha = value => createHash("sha256").update(String(value)).digest("hex");
const clone = value => structuredClone(value);

function mediaRecord(key, includeUrl = true) {
  return {
    local_file: `approved/${key}.png`,
    sha256: sha(`binary:${key}`),
    bytes: 1024 + key.length,
    width: 2048,
    height: 2560,
    format: "png",
    resource_url: includeUrl ? `https://cdn.openart.ai/openart-ai/production/2026-08/create-image/test/${key}.png` : null,
    history_id: `history_${key}`,
    creation_id: `creation_${key}`,
    media_fingerprint: null,
    qa_status: null,
    qa_observation: null
  };
}

function mediaPointer(key) {
  return {
    ...mediaRecord(key, false),
    history_id: null,
    creation_id: null
  };
}

function finishMediaItem(item) {
  item.transition_fingerprint = fingerprintMediaTransition(item);
  item.item_fingerprint = fingerprintMediaItem(item);
  return item;
}

function makeMediaItem({ sequence, jobId, handle, jobKind, slot, platforms, selected, resolution }) {
  const selectedMedia = selected ? mediaRecord(jobId) : null;
  return finishMediaItem({
    sequence,
    revision_ordinal: null,
    job_id: jobId,
    persona: `Persona ${handle}`,
    persona_handle: handle,
    job_kind: jobKind,
    slot,
    platforms,
    source_item_fingerprint: sha(`source:${jobId}`),
    cycle_2_item_fingerprint: sha(`cycle:${jobId}`),
    prior_owner_decision: {
      decision: selected ? "approve_media" : "deny_media",
      notes: selected ? "" : "owner denied",
      updated_at: "2026-08-29T00:00:00.000Z",
      reviewed_local_file: `approved/${jobId}.png`,
      reviewed_media_sha256: sha(`binary:${jobId}`)
    },
    final_cycle_2_decision: resolution === "approved_cycle_2_candidate" ? {
      decision: "approve_media",
      notes: "",
      updated_at: "2026-08-29T01:00:00.000Z",
      approval_scope: "media_only"
    } : null,
    final_resolution: resolution,
    inventory_status: selected ? "selected" : "excluded",
    selected_media: selectedMedia,
    audited_reviewed_media: mediaRecord(jobId),
    prior_reviewed_media: mediaPointer(jobId)
  });
}

function finishMediaManifest(manifest) {
  for (const item of manifest.items) finishMediaItem(item);
  manifest.transition_ledger_sha256 = mediaTransitionLedgerSha(manifest.items);
  manifest.packet_fingerprint = fingerprintMediaPacket(manifest);
  return manifest;
}

function buildMediaManifest() {
  const descriptors = [];
  for (let index = 0; index < 28; index += 1) {
    const handle = `persona${String(index).padStart(2, "0")}`;
    descriptors.push({
      jobId: `social_${handle}_facebook_instagram`,
      handle,
      jobKind: "social_post",
      slot: "facebook_instagram",
      platforms: ["facebook", "instagram"],
      selected: index < 20
    });
    descriptors.push({
      jobId: `social_${handle}_x`,
      handle,
      jobKind: "social_post",
      slot: "x",
      platforms: ["x"],
      selected: index < 19
    });
  }
  for (let index = 0; index < 7; index += 1) {
    descriptors.push({
      jobId: `profile_persona${String(index).padStart(2, "0")}_banner`,
      handle: `persona${String(index).padStart(2, "0")}`,
      jobKind: "profile_visual",
      slot: "banner",
      platforms: ["profile"],
      selected: index < 5
    });
  }
  let selectedOrdinal = 0;
  const items = descriptors.map((descriptor, index) => {
    let resolution = "excluded_prior_denial";
    if (descriptor.selected) {
      selectedOrdinal += 1;
      if (selectedOrdinal <= 23) resolution = "approved_cycle_2_candidate";
      else if (selectedOrdinal <= 41) resolution = "retained_prior_selected";
      else resolution = "retained_prior_source";
    }
    return makeMediaItem({ sequence: index + 1, resolution, ...descriptor });
  });
  return finishMediaManifest({
    schema_version: "1.0",
    generated_at: "2026-08-29T02:00:00.000Z",
    state: MEDIA_STATE,
    approval_scope: MEDIA_APPROVAL_SCOPE,
    generation_scope: MEDIA_GENERATION_SCOPE,
    publishing_enabled: false,
    uploading_enabled: false,
    scheduling_enabled: false,
    queueing_enabled: false,
    connecting_enabled: false,
    deploying_enabled: false,
    source_approval_manifest_file: "source.json",
    source_approval_manifest_sha256: sha("source-approval"),
    source_decisions_file: "decisions.json",
    source_decisions_sha256: sha("source-decisions"),
    source_packet_fingerprint: sha("source-packet"),
    source_transition_ledger_sha256: sha("source-transition"),
    counts: {
      total: 63,
      selected: 44,
      excluded: 19,
      approved_cycle_2_candidate: 23,
      retained_prior_selected: 18,
      retained_prior_source: 3,
      excluded_prior_denial: 19
    },
    final_resolution_values: [
      "approved_cycle_2_candidate", "retained_prior_selected",
      "retained_prior_source", "excluded_prior_denial"
    ],
    transition_ledger_sha256: "",
    packet_fingerprint: "",
    items
  });
}

function selectedMediaCore(media) {
  return media ? {
    local_file: media.local_file,
    sha256: media.sha256,
    bytes: media.bytes,
    width: media.width,
    height: media.height,
    format: media.format
  } : null;
}

function mediaForPost(mediaById, handle, platform) {
  return mediaById.get(`social_${handle}_${platform === "x" ? "x" : "facebook_instagram"}`);
}

function finishReadinessManifest(manifest) {
  for (const post of manifest.posts) post.item_fingerprint = fingerprintReadinessPost(post);
  for (const visual of manifest.profile_visuals) visual.item_fingerprint = fingerprintProfileVisual(visual);
  manifest.post_ledger_sha256 = readinessLedgerSha(manifest.posts);
  manifest.profile_visual_ledger_sha256 = readinessLedgerSha(manifest.profile_visuals);
  manifest.packet_fingerprint = fingerprintReadinessPacket(manifest);
  return manifest;
}

function buildReadinessManifest(mediaManifest, mediaRaw) {
  const mediaById = new Map(mediaManifest.items.map(item => [item.job_id, item]));
  const posts = [];
  for (let index = 0; index < 28; index += 1) {
    const handle = `persona${String(index).padStart(2, "0")}`;
    for (const platform of ["facebook", "instagram", "x"]) {
      const media = mediaForPost(mediaById, handle, platform);
      const selected = media.inventory_status === "selected";
      const id = `wave1_${handle}_${platform}`;
      const configured = index < 2;
      const target = platform === "facebook" ? `Page ${index}` : `@${handle}`;
      const post = {
        id,
        persona: `Persona ${handle}`,
        persona_handle: handle,
        platform,
        target_account: target,
        inventory_connection_state: configured ? "connected" : "inventory-only",
        provider_readiness: configured ? "destination_configured" : "blocked_destination_mapping",
        source_state: "awaiting_owner_approval",
        proposed_scheduled_for: "2026-09-01T12:00:00-08:00",
        timezone: "America/Anchorage",
        timing_basis: "private proposal only",
        theme: `Theme ${handle}`,
        hook: `Hook ${handle}`,
        caption: platform === "x" ? `Short exact caption for ${handle}. Fictional, AI-assisted; owner review required.` : `Exact approved caption for ${handle} on ${platform}. Fictional, AI-assisted persona; synthetic visual; owner review required.`,
        alt_text: `Synthetic editorial image for ${handle}.`,
        adult_policy_review_required: false,
        privacy_review_required: false,
        identity_confirmation_note: "Confirm exact destination.",
        concept_decision: "approve_concept",
        approval_scope: READINESS_APPROVAL_SCOPE,
        approval_fingerprint: sha(`approval:${id}`),
        source_queue_post_fingerprint: sha(`queue:${id}`),
        media_status: selected ? "owner_selected_media_bound" : "blocked_no_owner_selected_media",
        media_blocker: selected ? null : "Owner media inventory excludes this social asset.",
        media_job_id: media.job_id,
        media_item_fingerprint: media.item_fingerprint,
        media_final_resolution: media.final_resolution,
        selected_media: selectedMediaCore(media.selected_media),
        readiness_status: selected ? READY_STATUS : BLOCKED_STATUS,
        release_authorized: false,
        item_fingerprint: ""
      };
      posts.push(post);
    }
  }
  const profileVisuals = mediaManifest.items.filter(item => item.job_kind === "profile_visual").map(item => ({
    job_id: item.job_id,
    persona: item.persona,
    persona_handle: item.persona_handle,
    slot: item.slot,
    inventory_status: item.inventory_status,
    final_resolution: item.final_resolution,
    media_item_fingerprint: item.item_fingerprint,
    selected_media: selectedMediaCore(item.selected_media),
    blocker: item.inventory_status === "selected" ? null : "Owner media inventory excludes this profile visual.",
    release_authorized: false,
    item_fingerprint: ""
  }));
  return finishReadinessManifest({
    schema_version: "1.0",
    generated_at: "2026-08-29T03:00:00.000Z",
    state: READINESS_STATE,
    evidence_scope: READINESS_EVIDENCE_SCOPE,
    publishing_enabled: false,
    uploading_enabled: false,
    scheduling_enabled: false,
    queueing_enabled: false,
    connecting_enabled: false,
    deploying_enabled: false,
    provider_actions_enabled: false,
    source_media_manifest_file: "openart-owner-approved-media-manifest.json",
    source_media_manifest_sha256: sha(mediaRaw),
    source_media_packet_fingerprint: mediaManifest.packet_fingerprint,
    source_post_queue_file: "queue.json",
    source_post_queue_sha256: sha("queue"),
    source_post_decisions_file: "decisions.json",
    source_post_decisions_sha256: sha("decisions"),
    source_owner_validation_file: "owner-validation.json",
    source_owner_validation_sha256: sha("owner-validation"),
    source_approval_scope: READINESS_APPROVAL_SCOPE,
    counts: {
      posts_total: 84,
      concept_approved_posts: 84,
      media_covered_posts: 59,
      media_blocked_posts: 25,
      social_assets_total: 56,
      selected_social_assets: 39,
      excluded_social_assets: 17,
      profile_visuals_total: 7,
      selected_profile_visuals: 5,
      excluded_profile_visuals: 2,
      personas_total: 28
    },
    platform_counts: {
      facebook: { total: 28, media_covered: 20, media_blocked: 8 },
      instagram: { total: 28, media_covered: 20, media_blocked: 8 },
      x: { total: 28, media_covered: 19, media_blocked: 9 }
    },
    next_gate: "owner private draft review",
    posts,
    profile_visuals: profileVisuals,
    post_ledger_sha256: "",
    profile_visual_ledger_sha256: "",
    packet_fingerprint: ""
  });
}

function buildMapping(readiness) {
  const ready = readiness.posts.filter(post => post.readiness_status === READY_STATUS);
  const handles = [...new Set(ready.map(post => post.persona_handle))];
  return {
    schema_version: "1.0",
    owner_id: uuidV5("test-owner"),
    personas: handles.map(handle => ({
      persona_handle: handle,
      persona_id: uuidV5(`persona:${handle}`)
    })),
    accounts: ready.filter(post => post.provider_readiness === "destination_configured").map(post => ({
      source_post_id: post.id,
      account_id: uuidV5(`account:${post.id}`),
      persona_handle: post.persona_handle,
      provider: post.platform,
      target_account: post.target_account,
      provider_subject: `provider-subject:${post.id}`,
      connection_state: "connected"
    }))
  };
}

function fixture() {
  const media = buildMediaManifest();
  const mediaRaw = `${JSON.stringify(media, null, 2)}\n`;
  const readiness = buildReadinessManifest(media, mediaRaw);
  const mapping = buildMapping(readiness);
  return { media, mediaRaw, readiness, mapping };
}

function args(value) {
  return {
    readinessManifest: value.readiness,
    approvedMediaManifest: value.media,
    approvedMediaRaw: value.mediaRaw,
    mapping: value.mapping
  };
}

function resignReadiness(value) {
  finishReadinessManifest(value.readiness);
}

function resignMediaAndBind(value) {
  finishMediaManifest(value.media);
  value.mediaRaw = `${JSON.stringify(value.media, null, 2)}\n`;
  value.readiness.source_media_manifest_sha256 = sha(value.mediaRaw);
  value.readiness.source_media_packet_fingerprint = value.media.packet_fingerprint;
  const mediaById = new Map(value.media.items.map(item => [item.job_id, item]));
  for (const post of value.readiness.posts) {
    const media = mediaById.get(post.media_job_id);
    if (media) {
      post.media_item_fingerprint = media.item_fingerprint;
      post.media_final_resolution = media.final_resolution;
      post.selected_media = selectedMediaCore(media.selected_media);
    }
  }
  for (const visual of value.readiness.profile_visuals) {
    const media = mediaById.get(visual.job_id);
    visual.media_item_fingerprint = media.item_fingerprint;
    visual.final_resolution = media.final_resolution;
    visual.selected_media = selectedMediaCore(media.selected_media);
  }
  resignReadiness(value);
}

test("builds exactly 59 private pending image drafts from 39 selected social assets", () => {
  assert.equal(
    uuidV5("mypersonas.online/openart-private-draft/v1", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    OPENART_PRIVATE_DRAFT_NAMESPACE
  );
  assert.equal(uuidV5("wave1_castleborn_adeola_facebook"), "4708d33e-bc8b-578f-aa2e-79b83c8f48c6");
  assert.equal(uuidV5("wave1_castleborn_adeola_instagram"), "a11b2daf-d960-57c5-b795-a8a60f573871");
  assert.equal(uuidV5("wave1_castleborn_adeola_x"), "b66ba27c-77cb-5eeb-8e04-af55a583796f");
  const value = fixture();
  const rows = buildDraftRows(args(value));
  assert.equal(rows.length, 59);
  assert.equal(new Set(rows.map(row => row.media_url)).size, 39);
  assert.equal(rows.filter(row => row.account_id).length, 6);
  assert.equal(rows.filter(row => row.platform === "twitter").length, 19);
  assert.ok(rows.every(row => row.content_kind === "image" && row.tags === ""));
  assert.ok(rows.every(row => row.draft_id === uuidV5(row.source_post_id, OPENART_PRIVATE_DRAFT_NAMESPACE)));
  assert.ok(rows.every(row => !row.source_post_id.startsWith("profile_")));
});

test("rejects a tampered readiness manifest even if its outer JSON remains valid", () => {
  const value = fixture();
  value.readiness.posts[0].caption += " tampered";
  assert.throws(() => buildDraftRows(args(value)), /readiness item fingerprint drift/i);
});

test("rejects a changed item fingerprint for the same source post id", () => {
  const value = fixture();
  value.readiness.posts[0].item_fingerprint = sha("forged fingerprint");
  value.readiness.post_ledger_sha256 = readinessLedgerSha(value.readiness.posts);
  value.readiness.packet_fingerprint = fingerprintReadinessPacket(value.readiness);
  assert.throws(() => buildDraftRows(args(value)), /readiness item fingerprint drift/i);
});

test("keeps the deterministic UUID when a fully re-signed tuple changes and emits a no-overwrite guard", () => {
  const baseline = fixture();
  const changed = clone(baseline);
  changed.readiness.posts[0].caption += " Owner-edited changed tuple.";
  resignReadiness(changed);
  const before = buildDraftRows(args(baseline));
  const after = buildDraftRows(args(changed));
  assert.equal(after[0].draft_id, before[0].draft_id);
  assert.notEqual(after[0].body, before[0].body);
  assert.match(renderStagingSql(after), /Existing deterministic draft differs; refusing to overwrite/);
  assert.match(renderStagingSql(after), /v_existing\.body/);
});

test("rejects selected social media with a missing resource URL after all fingerprints are recomputed", () => {
  const value = fixture();
  const selected = value.media.items.find(item => item.job_kind === "social_post" && item.inventory_status === "selected");
  selected.selected_media.resource_url = null;
  resignMediaAndBind(value);
  assert.throws(() => buildDraftRows(args(value)), /resource_url is required/i);
});

test("rejects an account mapping that does not exactly match provider, target, and persona", () => {
  const value = fixture();
  value.mapping.accounts[0].provider = "instagram";
  assert.throws(() => buildDraftRows(args(value)), /account provider mismatch/i);

  const targetMismatch = fixture();
  targetMismatch.mapping.accounts[0].target_account = "@different";
  assert.throws(() => buildDraftRows(args(targetMismatch)), /account target mismatch/i);

  const personaMismatch = fixture();
  personaMismatch.mapping.accounts[0].persona_handle = "persona19";
  assert.throws(() => buildDraftRows(args(personaMismatch)), /account persona mismatch/i);
});

test("rejects any attempt to substitute a selected profile visual into a social post", () => {
  const value = fixture();
  const profile = value.media.items.find(item => item.job_kind === "profile_visual" && item.inventory_status === "selected");
  const post = value.readiness.posts.find(item => item.readiness_status === READY_STATUS);
  post.media_job_id = profile.job_id;
  post.media_item_fingerprint = profile.item_fingerprint;
  post.media_final_resolution = profile.final_resolution;
  post.selected_media = selectedMediaCore(profile.selected_media);
  resignReadiness(value);
  assert.throws(() => buildDraftRows(args(value)), /profile visual leaked into social post/i);
});

test("base64-encodes all runtime content and mapping values to prevent SQL injection", () => {
  const value = fixture();
  const attack = "'); DROP TABLE public.posts; --";
  value.readiness.posts[0].caption += attack;
  value.mapping.accounts[0].provider_subject += attack;
  resignReadiness(value);
  const sql = buildStagingSql(args(value));
  assert.doesNotMatch(sql, /DROP TABLE public\.posts/);
  const encoded = sql.match(/decode\('([A-Za-z0-9+/=]+)', 'base64'\)/)?.[1];
  assert.ok(encoded);
  const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.match(payload.drafts[0].body, /DROP TABLE public\.posts/);
  assert.match(payload.drafts.find(row => row.account_id)?.expected_provider_subject, /DROP TABLE public\.posts/);
});

test("generated SQL is one transaction with quotas, live mappings, exact safe state, and zero-action assertions", () => {
  const value = fixture();
  const sql = buildStagingSql(args(value));
  assert.match(sql, /^-- MyPersonas OpenArt private-draft staging transaction/m);
  assert.match(sql, /begin;[\s\S]*commit;/i);
  assert.equal((sql.match(/insert into public\.drafts\s*\(/gi) || []).length, 1);
  assert.equal((sql.match(/insert into public\.posts\b/gi) || []).length, 0);
  assert.equal((sql.match(/insert into public\.post_drafts\b/gi) || []).length, 0);
  assert.equal((sql.match(/insert into public\.agent_actions\b/gi) || []).length, 0);
  assert.match(sql, /public\.lock_owner_agent_storage/);
  assert.match(sql, /Draft daily creation limit would exceed 200/);
  assert.match(sql, /Draft account limit would exceed 5000/);
  assert.match(sql, /Draft persona limit would exceed 1000/);
  assert.match(sql, /Draft storage limit would exceed 67108864 bytes/);
  assert.match(sql, /connection\.connection_state/);
  assert.match(sql, /connection\.provider_subject/);
  assert.match(sql, /'idea'.*'pending'[\s\S]*'not_queued'/);
  assert.match(sql, /approved_at is null and draft\.approved_content_hash=''/);
  assert.match(sql, /publish_at is null and draft\.scheduled_for is null/);
  assert.match(sql, /source_task_id is null and draft\.media_asset_id is null/);
  assert.match(sql, /idea_group_id is not null/);
  assert.match(sql, /Post-insert idea_group_id null assertion failed/);
  assert.match(sql, /draft\.generated_by_agent=true/);
  assert.match(sql, /deterministic IDs exist in post_drafts/);
  assert.match(sql, /deterministic IDs have agent actions/);
  assert.match(sql, /deterministic IDs have preview receipts/);
  assert.match(sql, /Zero-action assertion failed: posts, post_drafts, or agent_actions changed/);
});

test("CLI writes a new SQL artifact without executing it or overwriting an existing output", () => {
  const value = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mypersonas-openart-stage-"));
  const readinessPath = path.join(directory, "readiness.json");
  const mediaPath = path.join(directory, "media.json");
  const mappingPath = path.join(directory, "mapping.json");
  const outputPath = path.join(directory, "private-drafts.sql");
  const scriptPath = path.resolve("scripts/build-openart-private-draft-staging.mjs");
  try {
    fs.writeFileSync(readinessPath, `${JSON.stringify(value.readiness, null, 2)}\n`);
    fs.writeFileSync(mediaPath, value.mediaRaw);
    fs.writeFileSync(mappingPath, `${JSON.stringify(value.mapping, null, 2)}\n`);
    const invocation = [scriptPath,
      "--readiness", readinessPath,
      "--media", mediaPath,
      "--mapping", mappingPath,
      "--out", outputPath
    ];
    const first = spawnSync(process.execPath, invocation, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /"action":"sql_built_not_executed"/);
    assert.match(fs.readFileSync(outputPath, "utf8"), /begin;[\s\S]*commit;/i);
    const second = spawnSync(process.execPath, invocation, { encoding: "utf8" });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /EEXIST|file already exists/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
