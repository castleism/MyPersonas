import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const LOCAL_DRAFT_PACK_SCHEMA = "mypersonas.local-draft-pack/v1";

export const PLATFORM_REQUIREMENTS = Object.freeze({
  facebook: Object.freeze({ width: 1200, height: 1500, accountKey: "facebook" }),
  instagram: Object.freeze({ width: 1080, height: 1350, accountKey: "instagram" }),
  twitter: Object.freeze({ width: 1440, height: 1920, accountKey: "twitter" }),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HTTP_URL_RE = /^https:\/\/[^\s]+$/i;

function isBlank(value) {
  return value === "" || value === null || value === undefined;
}

function expected(value, message, errors) {
  if (!value) errors.push(message);
}

function platformRequirement(pack, platform) {
  const override = pack?.platform_requirements?.[platform];
  if (override
    && Number.isInteger(override.width)
    && Number.isInteger(override.height)
    && typeof override.accountKey === "string"
    && override.accountKey.length > 0) {
    return override;
  }
  return PLATFORM_REQUIREMENTS[platform];
}

export function renderDraftCaption(draft) {
  return [draft?.db?.body || "", draft?.db?.tags || ""].filter(Boolean).join("\n\n");
}

export function validateLocalDraftPack(pack) {
  const errors = [];
  expected(pack && typeof pack === "object", "Pack must be a JSON object.", errors);
  if (!pack || typeof pack !== "object") return errors;

  expected(pack.schema_version === LOCAL_DRAFT_PACK_SCHEMA,
    `schema_version must be ${LOCAL_DRAFT_PACK_SCHEMA}.`, errors);
  expected(pack.controls?.local_only === true, "controls.local_only must be true.", errors);
  expected(pack.controls?.external_io === false, "controls.external_io must be false.", errors);
  expected(pack.controls?.publishing_enabled === false,
    "controls.publishing_enabled must be false.", errors);
  expected(pack.controls?.scheduling_enabled === false,
    "controls.scheduling_enabled must be false.", errors);
  expected(pack.controls?.requires_owner_approval === true,
    "controls.requires_owner_approval must be true.", errors);
  expected(pack.controls?.database_import_enabled === false,
    "controls.database_import_enabled must be false.", errors);
  expected(pack.workflow?.operational_state === "draft",
    "workflow.operational_state must remain draft.", errors);
  expected(pack.workflow?.verified === false, "workflow.verified must be false.", errors);

  const drafts = Array.isArray(pack.drafts) ? pack.drafts : [];
  const concepts = Array.isArray(pack.concepts) ? pack.concepts : [];
  expected(drafts.length === pack.expectations?.draft_count,
    `Expected ${pack.expectations?.draft_count ?? "a declared number of"} drafts; found ${drafts.length}.`, errors);
  expected(concepts.length === pack.expectations?.concept_count,
    `Expected ${pack.expectations?.concept_count ?? "a declared number of"} concepts; found ${concepts.length}.`, errors);

  const draftKeys = new Set();
  const assetHashes = new Set();
  const conceptKeys = new Set(concepts.map((concept) => concept.id));
  const conceptPlatforms = new Map();
  const requiresAdults21Plus = pack.content_policy?.requires_adults_21_plus !== false;

  for (const draft of drafts) {
    const label = draft?.id || "<missing draft id>";
    expected(typeof draft?.id === "string" && draft.id.length > 0, "Every draft needs an id.", errors);
    expected(!draftKeys.has(draft?.id), `Duplicate draft id: ${label}.`, errors);
    draftKeys.add(draft?.id);
    expected(conceptKeys.has(draft?.concept_id), `${label}: unknown concept_id.`, errors);
    expected(Object.hasOwn(PLATFORM_REQUIREMENTS, draft?.platform),
      `${label}: unsupported platform ${draft?.platform}.`, errors);
    expected(draft?.operational_state === "draft", `${label}: operational_state must be draft.`, errors);
    expected(draft?.owner_decision === "awaiting_approval",
      `${label}: owner_decision must be awaiting_approval.`, errors);

    const db = draft?.db || {};
    expected(db.platform === draft?.platform, `${label}: db.platform must match platform.`, errors);
    expected(db.content_kind === "image", `${label}: content_kind must be image.`, errors);
    expected(db.status === "idea", `${label}: status must be idea.`, errors);
    expected(db.approval_state === "draft", `${label}: approval_state must be draft.`, errors);
    expected(db.publish_state === "not_queued", `${label}: publish_state must be not_queued.`, errors);
    expected(db.approved_content_hash === "", `${label}: approved_content_hash must be blank.`, errors);
    expected(db.generated_by_agent === true, `${label}: generated_by_agent must be true.`, errors);
    expected(isBlank(db.owner), `${label}: owner must be unresolved.`, errors);
    expected(isBlank(db.persona_id), `${label}: persona_id must be unresolved.`, errors);
    expected(isBlank(db.account_id), `${label}: account_id must be unresolved.`, errors);
    expected(isBlank(db.source_task_id), `${label}: source_task_id must be blank.`, errors);
    expected(isBlank(db.media_url), `${label}: media_url must be blank until a safe hosted asset exists.`, errors);
    expected(isBlank(db.publish_at), `${label}: publish_at must be blank before approval.`, errors);
    expected(isBlank(db.scheduled_for), `${label}: scheduled_for must be blank before approval.`, errors);
    expected(isBlank(db.approved_at), `${label}: approved_at must be blank.`, errors);
    expected(isBlank(db.posted_at), `${label}: posted_at must be blank.`, errors);
    expected(isBlank(db.provider_post_id), `${label}: provider_post_id must be blank.`, errors);
    expected(isBlank(db.publish_next_attempt_at),
      `${label}: publish_next_attempt_at must be blank.`, errors);
    expected(typeof db.title === "string" && db.title.length > 0, `${label}: title is required.`, errors);
    expected(typeof db.body === "string" && db.body.length > 0, `${label}: body is required.`, errors);

    const caption = renderDraftCaption(draft);
    expected(/AI-generated/i.test(caption), `${label}: caption lacks an AI-generated disclosure.`, errors);
    if (requiresAdults21Plus) {
      expected(/21\+/.test(caption), `${label}: caption lacks the adults 21+ boundary.`, errors);
    }
    if (draft.platform === "twitter") {
      expected(Array.from(caption).length <= 280,
        `${label}: X caption is ${Array.from(caption).length} characters, over 280.`, errors);
    }

    const asset = draft?.asset || {};
    const requirement = platformRequirement(pack, draft?.platform);
    expected(typeof asset.local_path === "string" && asset.local_path.length > 0,
      `${label}: asset.local_path is required.`, errors);
    expected(asset.mime_type === "image/jpeg", `${label}: asset must be image/jpeg.`, errors);
    expected(asset.width === requirement?.width && asset.height === requirement?.height,
      `${label}: expected ${requirement?.width}x${requirement?.height}.`, errors);
    expected(/^[0-9a-f]{64}$/i.test(asset.sha256 || ""), `${label}: asset sha256 is invalid.`, errors);
    expected(!assetHashes.has(asset.sha256), `${label}: exact duplicate asset bytes are not allowed.`, errors);
    assetHashes.add(asset.sha256);
    expected(typeof asset.alt_text === "string" && asset.alt_text.length > 0,
      `${label}: alt text is required.`, errors);
    expected(/AI-generated/i.test(asset.alt_text || ""),
      `${label}: alt text must identify AI generation.`, errors);
    expected(asset.platform_ai_label_required === true,
      `${label}: platform_ai_label_required must be true.`, errors);
    expected(isBlank(asset.public_media_url),
      `${label}: public_media_url must be unresolved before approval.`, errors);
    expected(draft?.proposed_release_slot && Number.isInteger(draft.proposed_release_slot.order),
      `${label}: a non-binding proposed_release_slot is required.`, errors);

    if (conceptKeys.has(draft?.concept_id) && Object.hasOwn(PLATFORM_REQUIREMENTS, draft?.platform)) {
      const platforms = conceptPlatforms.get(draft.concept_id) || new Set();
      expected(!platforms.has(draft.platform),
        `${label}: concept ${draft.concept_id} repeats platform ${draft.platform}.`, errors);
      platforms.add(draft.platform);
      conceptPlatforms.set(draft.concept_id, platforms);
    }
  }

  for (const concept of concepts) {
    const platforms = conceptPlatforms.get(concept.id) || new Set();
    for (const platform of Object.keys(PLATFORM_REQUIREMENTS)) {
      expected(platforms.has(platform), `${concept.id}: missing ${platform} draft.`, errors);
    }
  }

  for (const destination of pack.destinations || []) {
    expected(isBlank(destination.account_id),
      `${destination.key || "destination"}: account_id must remain unresolved.`, errors);
    expected(destination.requires_owner_confirmation === true,
      `${destination.key || "destination"}: owner confirmation must be required.`, errors);
  }

  return errors;
}

export async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyLocalDraftPackAssets(pack, rootDir) {
  const errors = [];
  const root = path.resolve(rootDir);
  for (const draft of pack?.drafts || []) {
    const label = draft?.id || "<missing draft id>";
    const relativePath = draft?.asset?.local_path || "";
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);
    if (!relativePath || relative.startsWith("..") || path.isAbsolute(relative)) {
      errors.push(`${label}: asset path must stay inside the workspace.`);
      continue;
    }
    try {
      const actual = await sha256File(resolved);
      if (actual !== draft.asset.sha256) errors.push(`${label}: asset sha256 does not match.`);
    } catch (error) {
      errors.push(`${label}: asset cannot be read (${error.message}).`);
    }
  }
  return errors;
}

// Produces a review-only projection after IDs and hosted media are resolved.
// This is intentionally not an authenticated Supabase insert payload: approval,
// provenance, and publication columns remain server-owned in the current schema.
export function materializeUnapprovedDraftRowPreviews(pack, bindings) {
  const structuralErrors = validateLocalDraftPack(pack);
  if (structuralErrors.length) {
    throw new Error(`Refusing to materialize an invalid pack:\n- ${structuralErrors.join("\n- ")}`);
  }
  if (!UUID_RE.test(bindings?.ownerId || "")) throw new Error("A valid ownerId UUID is required.");
  if (!UUID_RE.test(bindings?.personaId || "")) throw new Error("A valid personaId UUID is required.");

  return pack.drafts.map((draft) => {
    const accountId = bindings?.accountIds?.[draft.platform];
    const mediaUrl = bindings?.mediaUrls?.[draft.id];
    if (!UUID_RE.test(accountId || "")) {
      throw new Error(`${draft.id}: a confirmed ${draft.platform} account UUID is required.`);
    }
    if (!HTTP_URL_RE.test(mediaUrl || "")) {
      throw new Error(`${draft.id}: a confirmed HTTPS media URL is required.`);
    }
    return {
      owner: bindings.ownerId,
      persona_id: bindings.personaId,
      account_id: accountId,
      source_task_id: null,
      platform: draft.db.platform,
      content_kind: draft.db.content_kind,
      title: draft.db.title,
      body: draft.db.body,
      tags: draft.db.tags,
      media_url: mediaUrl,
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
    };
  });
}
