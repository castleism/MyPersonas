import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_DRAFT_PACK_SCHEMA,
  sha256File,
  validateLocalDraftPack,
  verifyLocalDraftPackAssets,
} from "./lib/local-draft-pack.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const sourceRoot = "outputs/akiko-being-tea-launch-2026-08-08";
const sourceDocument = `${sourceRoot}/APPROVAL-PACK.md`;
const queueDocument = `${sourceRoot}/QUEUE.csv`;
const manifestDocument = `${sourceRoot}/ASSET-MANIFEST-V2.csv`;
const masterPortrait = `${sourceRoot}/identity/akiko-canonical-portrait-v2.png`;
const outputPath = `${sourceRoot}/AKIKO-MYPERSONAS-LOCAL-DRAFT-PACK.json`;

const platformRequirements = Object.freeze({
  facebook: Object.freeze({ width: 1080, height: 1350, accountKey: "facebook" }),
  instagram: Object.freeze({ width: 1080, height: 1440, accountKey: "instagram" }),
  twitter: Object.freeze({ width: 1600, height: 900, accountKey: "twitter" }),
});

function parseCsv(text) {
  const rows = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        if (quoted && line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === "," && !quoted) {
        row.push(cell);
        cell = "";
      } else {
        cell += character;
      }
    }
    row.push(cell);
    rows.push(row);
  }
  const [headers, ...values] = rows;
  return values.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function extractField(section, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`));
  return match?.[1]?.trim() || "";
}

function parsePlatformPost(section, platformLabel, number, nextMarker) {
  const heading = `### ${platformLabel} post ${number}`;
  const start = section.indexOf(heading);
  if (start < 0) throw new Error(`Missing ${heading}.`);
  const afterHeading = section.slice(start + heading.length).trimStart();
  const altMarker = `**${platformLabel} alt text:**`;
  const altIndex = afterHeading.indexOf(altMarker);
  if (altIndex < 0) throw new Error(`Missing ${altMarker}.`);
  const body = afterHeading.slice(0, altIndex).trim();
  const afterAlt = afterHeading.slice(altIndex + altMarker.length).trimStart();
  const endIndex = afterAlt.indexOf(nextMarker);
  const altText = (endIndex >= 0 ? afterAlt.slice(0, endIndex) : afterAlt)
    .split(/\r?\n/)[0]
    .trim();
  return {
    body,
    altText: /^AI-generated/i.test(altText) ? altText : `AI-generated image: ${altText}`,
  };
}

async function jpegDimensions(filePath) {
  const bytes = await readFile(filePath);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`${filePath} is not a JPEG.`);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) throw new Error(`${filePath} has an invalid JPEG segment.`);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += length + 2;
  }
  throw new Error(`Could not read JPEG dimensions for ${filePath}.`);
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function buildAkikoLocalDraftPack() {
  const [markdown, queueText, manifestText] = await Promise.all([
    readFile(path.join(workspaceRoot, sourceDocument), "utf8"),
    readFile(path.join(workspaceRoot, queueDocument), "utf8"),
    readFile(path.join(workspaceRoot, manifestDocument), "utf8"),
  ]);
  const queue = parseCsv(queueText);
  if (queue.length !== 30) throw new Error(`Expected 30 queue rows; found ${queue.length}.`);
  const sections = [...markdown.matchAll(/^## (\d{2}) — ([^\r\n]+)\r?\n([\s\S]*?)(?=^## \d{2} — |^# Approval queue)/gm)];
  if (sections.length !== 10) throw new Error(`Expected 10 content sections; found ${sections.length}.`);

  const platformMap = [
    { label: "Instagram", db: "instagram", folder: "instagram", suffix: "IG", next: "### Facebook post" },
    { label: "Facebook", db: "facebook", folder: "facebook", suffix: "FB", next: "### X post" },
    { label: "X", db: "twitter", folder: "x", suffix: "X", next: "---" },
  ];
  const concepts = [];
  const drafts = [];

  for (const match of sections) {
    const number = match[1];
    const numericNumber = Number(number);
    const title = match[2].trim();
    const section = match[3];
    const conceptId = `akiko-${number}`;
    const conceptQueue = queue.filter((row) => row.concept_id === number);
    if (conceptQueue.length !== 3) throw new Error(`${conceptId} has ${conceptQueue.length} queue rows; expected 3.`);
    const instagramQueue = conceptQueue.find((row) => row.platform === "Instagram");
    const conceptSlot = {
      order: numericNumber,
      proposed_local_datetime: instagramQueue?.proposed_local_datetime || "",
      timezone: instagramQueue?.timezone || "America/Anchorage",
      binding: "proposal_only",
      shifts_after_approval_or_access_delay: true,
    };
    concepts.push({
      id: conceptId,
      number: numericNumber,
      title,
      content_class: extractField(section, "Content class"),
      primary_learning_question: extractField(section, "Primary learning question"),
      risk: extractField(section, "Risk"),
      sources: extractField(section, "Sources"),
      proposed_release_slot: conceptSlot,
    });

    for (const platform of platformMap) {
      const parsed = parsePlatformPost(section, platform.label, number, platform.next);
      const queueRow = conceptQueue.find((row) => row.record_id === `AKI-${number}-${platform.suffix}`);
      if (!queueRow) throw new Error(`Missing queue row AKI-${number}-${platform.suffix}.`);
      if (queueRow.status !== "READY_FOR_OWNER_REVIEW") throw new Error(`${queueRow.record_id} is not ready for owner review.`);
      if (queueRow.externally_scheduled !== "false") throw new Error(`${queueRow.record_id} must remain externally_scheduled=false.`);
      const relativeAsset = `${sourceRoot}/${queueRow.image_path}`.replaceAll("\\", "/");
      const absoluteAsset = path.join(workspaceRoot, relativeAsset);
      const dimensions = await jpegDimensions(absoluteAsset);
      const requirement = platformRequirements[platform.db];
      if (dimensions.width !== requirement.width || dimensions.height !== requirement.height) {
        throw new Error(`${relativeAsset} is ${dimensions.width}x${dimensions.height}; expected ${requirement.width}x${requirement.height}.`);
      }
      drafts.push({
        id: `${conceptId}-${platform.db}`,
        source_record_id: queueRow.record_id,
        concept_id: conceptId,
        platform: platform.db,
        destination_key: requirement.accountKey,
        operational_state: "draft",
        owner_decision: "awaiting_approval",
        proposed_release_slot: {
          order: numericNumber,
          proposed_local_datetime: queueRow.proposed_local_datetime,
          timezone: queueRow.timezone,
          binding: "proposal_only",
          shifts_after_approval_or_access_delay: true,
        },
        db: {
          owner: null,
          persona_id: null,
          account_id: null,
          source_task_id: null,
          platform: platform.db,
          content_kind: "image",
          title: `${number} · ${title} · ${platform.label}`,
          body: parsed.body,
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
          local_path: relativeAsset,
          mime_type: "image/jpeg",
          width: dimensions.width,
          height: dimensions.height,
          sha256: await sha256File(absoluteAsset),
          alt_text: parsed.altText,
          platform_ai_label_required: true,
          public_media_url: null,
        },
      });
    }
  }

  return {
    schema_version: LOCAL_DRAFT_PACK_SCHEMA,
    pack_id: "akiko-being-tea-launch-10x3-v2-2026-08-09",
    assembled_for_date: "2026-08-09",
    controls: {
      local_only: true,
      external_io: false,
      publishing_enabled: false,
      scheduling_enabled: false,
      requires_owner_approval: true,
      database_import_enabled: false,
      global_pause_required_before_future_import: true,
    },
    workflow: {
      operational_state: "draft",
      approved: false,
      staged: false,
      publishing: false,
      verified: false,
      state_order: ["draft", "approved", "staged", "publishing", "verified"],
      database_projection: "approval_state=draft; publish_state=not_queued; publish_at=null",
    },
    expectations: { concept_count: 10, draft_count: 30, platforms_per_concept: 3 },
    content_policy: {
      requires_adults_21_plus: false,
      ai_identity_disclosure_required: true,
      fictional_host_may_not_claim_personal_product_use: true,
      health_legal_financial_and_cultural_authority_claims_require_human_review: true,
    },
    platform_requirements: platformRequirements,
    provenance: {
      source_document: sourceDocument,
      source_document_sha256: sha256Text(markdown),
      queue_document: queueDocument,
      queue_document_sha256: sha256Text(queueText),
      asset_manifest: manifestDocument,
      asset_manifest_sha256: sha256Text(manifestText),
      master_portrait: masterPortrait,
      master_portrait_sha256: await sha256File(path.join(workspaceRoot, masterPortrait)),
      build_script: "scripts/build-akiko-local-draft-pack.mjs",
    },
    persona: {
      key: "akiko",
      display_name: "Akiko / Being Tea Co.",
      persona_id: null,
      requires_owner_confirmation: true,
      provisional_pronouns: "she/her",
      public_nature: "fictional AI-generated editorial host for a human-directed tea-culture project",
    },
    destinations: [
      { key: "facebook", provider: "facebook", account_id: null, requires_owner_confirmation: true },
      { key: "instagram", provider: "instagram", account_id: null, requires_owner_confirmation: true },
      { key: "twitter", provider: "twitter", public_label: "X", account_id: null, requires_owner_confirmation: true },
    ],
    content_plan: {
      primary_goal: "Validate a distinct, disclosed editorial host and repeatable tea-education formats before scaling.",
      success_metric: "Qualified non-follower reach, holds, completion, saves, shares, meaningful comments, profile visits, follows per 1,000 qualified views, returning viewers, and clean account health.",
      audience_focus: "Curious tea drinkers who want calm, evidence-aware, non-gatekeeping ways to brew, compare, and notice more.",
      content_pillars: "Tea foundations; controlled comparisons; sensory practice; culture and evidence; transparent methods and corrections.",
      current_campaign: "Ten concepts with 30 platform-native variants for a one-week owner-approved validation sequence after account readiness.",
      calls_to_action: "Notice, compare, save a useful method, share privately when helpful, and return for the next documented comparison. No engagement bait.",
      offers_and_links: "Education-first launch; no sponsor or affiliate offer is present in this draft pack.",
      affiliate_disclosure: "No affiliate or sponsor relationship is present in this launch pack.",
      source_notes: `See ${sourceRoot}/SOURCES.md and per-image provenance logs. Synthetic scenes do not prove botanical identity, product use, provenance, or experimental results.`,
      platform_guidance: "Facebook carries the detailed explanation; Instagram carries the concise visual lesson; X carries the TL;DR. Every post retains plain-language AI disclosure.",
      database_ids_resolved: false,
    },
    concepts,
    drafts,
  };
}

async function main() {
  const pack = await buildAkikoLocalDraftPack();
  const errors = [
    ...validateLocalDraftPack(pack),
    ...await verifyLocalDraftPackAssets(pack, workspaceRoot),
  ];
  if (errors.length) throw new Error(`Draft pack failed validation:\n- ${errors.join("\n- ")}`);
  const absoluteOutput = path.join(workspaceRoot, outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  console.log(`Wrote ${pack.drafts.length} inert drafts across ${pack.concepts.length} concepts.`);
  console.log(absoluteOutput);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
