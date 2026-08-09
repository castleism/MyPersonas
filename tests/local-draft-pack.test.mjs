import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_DRAFT_PACK_SCHEMA,
  materializeUnapprovedDraftRowPreviews,
  validateLocalDraftPack,
} from "../scripts/lib/local-draft-pack.mjs";

const OWNER_ID = "1e8b9288-a938-4c98-8988-8e0cc9835123";
const PERSONA_ID = "512dfc83-3ee3-4d67-ab2a-48d108e8f75a";
const ACCOUNT_IDS = {
  facebook: "f3cb397e-2ec4-46ca-94ae-e809515f34d3",
  instagram: "394fa043-cdb9-4a9e-b550-5ed18dac9ec0",
  twitter: "24e87ed2-c242-4198-98af-12e3b383034d",
};

function samplePack() {
  const specs = {
    facebook: [1200, 1500],
    instagram: [1080, 1350],
    twitter: [1440, 1920],
  };
  const drafts = Object.entries(specs).map(([platform, [width, height]], index) => ({
    id: `concept-01-${platform}`,
    concept_id: "concept-01",
    platform,
    operational_state: "draft",
    owner_decision: "awaiting_approval",
    proposed_release_slot: { order: 1, day_offset: 0, local_time: "18:30" },
    db: {
      owner: null,
      persona_id: null,
      account_id: null,
      source_task_id: null,
      platform,
      content_kind: "image",
      title: `Draft ${index + 1}`,
      body: "AI-generated fictional artwork for adults 21+.",
      tags: "",
      media_url: "",
      status: "idea",
      scheduled_for: null,
      approval_state: "draft",
      publish_state: "not_queued",
      publish_at: null,
      approved_at: null,
      approved_content_hash: "",
      posted_at: null,
      provider_post_id: "",
      publish_error: "",
      publish_next_attempt_at: null,
      generated_by_agent: true,
    },
    asset: {
      local_path: `outputs/example-${platform}.jpg`,
      mime_type: "image/jpeg",
      width,
      height,
      sha256: (index + 1).toString(16).padStart(64, "0"),
      alt_text: "AI-generated art showing Chomie.",
      platform_ai_label_required: true,
      public_media_url: null,
    },
  }));
  return {
    schema_version: LOCAL_DRAFT_PACK_SCHEMA,
    controls: {
      local_only: true,
      external_io: false,
      publishing_enabled: false,
      scheduling_enabled: false,
      requires_owner_approval: true,
      database_import_enabled: false,
    },
    workflow: { operational_state: "draft", verified: false },
    expectations: { concept_count: 1, draft_count: 3 },
    concepts: [{ id: "concept-01" }],
    destinations: Object.keys(specs).map((key) => ({
      key,
      account_id: null,
      requires_owner_confirmation: true,
    })),
    drafts,
  };
}

test("a local pack accepts only inert, unapproved draft rows", () => {
  assert.deepEqual(validateLocalDraftPack(samplePack()), []);
});

test("validation rejects approval, scheduling, and publishing transitions", () => {
  const pack = samplePack();
  pack.controls.scheduling_enabled = true;
  pack.drafts[0].db.approval_state = "approved";
  pack.drafts[0].db.publish_state = "queued";
  pack.drafts[0].db.publish_at = "2026-08-10T18:30:00-08:00";
  const errors = validateLocalDraftPack(pack).join("\n");
  assert.match(errors, /scheduling_enabled must be false/);
  assert.match(errors, /approval_state must be draft/);
  assert.match(errors, /publish_state must be not_queued/);
  assert.match(errors, /publish_at must be blank before approval/);
});

test("row preview refuses unresolved accounts and media", () => {
  assert.throws(
    () => materializeUnapprovedDraftRowPreviews(samplePack(), {
      ownerId: OWNER_ID,
      personaId: PERSONA_ID,
      accountIds: {},
      mediaUrls: {},
    }),
    /confirmed facebook account UUID is required/,
  );
});

test("row preview can only emit unapproved and unscheduled database state", () => {
  const pack = samplePack();
  const mediaUrls = Object.fromEntries(pack.drafts.map((draft) => [
    draft.id,
    `https://assets.example.test/${draft.id}.jpg`,
  ]));
  const rows = materializeUnapprovedDraftRowPreviews(pack, {
    ownerId: OWNER_ID,
    personaId: PERSONA_ID,
    accountIds: ACCOUNT_IDS,
    mediaUrls,
  });
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.approval_state, "draft");
    assert.equal(row.publish_state, "not_queued");
    assert.equal(row.publish_at, null);
    assert.equal(row.approved_at, null);
    assert.equal(row.approved_content_hash, "");
    assert.equal(row.provider_post_id, "");
    assert.match(row.media_url, /^https:\/\//);
  }
});
