import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_DRAFT_PACK_SCHEMA,
  PLATFORM_REQUIREMENTS,
  sha256File,
  validateLocalDraftPack,
  verifyLocalDraftPackAssets,
} from "./lib/local-draft-pack.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const sourceRoot = "outputs/chomie-launch-approval-2026-08-08";
const sourceDocument = `${sourceRoot}/CHOMIE-10-POST-LAUNCH-DRAFTS-2026-08-08.md`;
const outputPath = "outputs/chomie-roadmap-2026-08-09/CHOMIE-MYPERSONAS-LOCAL-DRAFT-PACK.json";

const releaseSlots = [
  { order: 1, day_offset: 0, local_time: "18:30" },
  { order: 2, day_offset: 1, local_time: "11:00" },
  { order: 3, day_offset: 2, local_time: "18:30" },
  { order: 4, day_offset: 3, local_time: "11:30" },
  { order: 5, day_offset: 3, local_time: "19:30" },
  { order: 6, day_offset: 4, local_time: "18:30" },
  { order: 7, day_offset: 5, local_time: "12:00" },
  { order: 8, day_offset: 6, local_time: "11:00" },
  { order: 9, day_offset: 6, local_time: "19:00" },
  { order: 10, day_offset: 7, local_time: "11:00" },
];

function markdownField(section, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`));
  if (!match) throw new Error(`Missing ${label}.`);
  return match[1].trim();
}

function parseCaption(section, label, nextLabel) {
  const heading = `### ${label} caption`;
  const start = section.indexOf(heading);
  if (start < 0) throw new Error(`Missing ${heading}.`);
  const afterHeading = section.slice(start + heading.length).trimStart();
  const altMarker = `**${label} alt text:**`;
  const altIndex = afterHeading.indexOf(altMarker);
  if (altIndex < 0) throw new Error(`Missing ${altMarker}.`);
  let caption = afterHeading.slice(0, altIndex).trim();
  const afterAlt = afterHeading.slice(altIndex + altMarker.length).trimStart();
  const nextHeading = nextLabel ? `### ${nextLabel} caption` : "---";
  const nextIndex = afterAlt.indexOf(nextHeading);
  const altText = (nextIndex >= 0 ? afterAlt.slice(0, nextIndex) : afterAlt)
    .split(/\r?\n/)[0].trim();
  caption = caption.replace(/\*\*Disclosure:\*\*/g, "Disclosure:");

  let tags = "";
  if (label === "Instagram") {
    const lines = caption.split(/\r?\n/);
    const last = lines.at(-1)?.trim() || "";
    if (/^(#[^\s]+\s*)+$/.test(last)) {
      tags = last;
      lines.pop();
      while (lines.at(-1)?.trim() === "") lines.pop();
      caption = lines.join("\n");
    }
  }
  return { body: caption, tags, altText };
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

async function findAsset(platformFolder, postNumber) {
  const folder = path.join(workspaceRoot, sourceRoot, "images", platformFolder);
  const prefix = `${String(postNumber).padStart(2, "0")}-`;
  const matches = (await readdir(folder)).filter((name) => name.startsWith(prefix) && name.endsWith(".jpg"));
  if (matches.length !== 1) throw new Error(`Expected one ${platformFolder} asset for ${prefix}; found ${matches.length}.`);
  const absolute = path.join(folder, matches[0]);
  return {
    absolute,
    relative: path.relative(workspaceRoot, absolute).replaceAll("\\", "/"),
  };
}

export async function buildChomieLocalDraftPack() {
  const markdownPath = path.join(workspaceRoot, sourceDocument);
  const markdown = await readFile(markdownPath, "utf8");
  const rawSections = markdown.split(/^## Post /m).slice(1);
  if (rawSections.length !== 10) throw new Error(`Expected 10 source posts; found ${rawSections.length}.`);

  const concepts = [];
  const drafts = [];
  const platformLabels = [
    { db: "facebook", folder: "facebook", source: "Facebook", next: "Instagram" },
    { db: "instagram", folder: "instagram", source: "Instagram", next: "X" },
    { db: "twitter", folder: "x", source: "X", next: null },
  ];

  for (const section of rawSections) {
    const titleMatch = section.match(/^(\d+) — ([^\r\n]+)/);
    if (!titleMatch) throw new Error("A post section has no numbered title.");
    const number = Number(titleMatch[1]);
    const title = titleMatch[2].trim();
    const conceptId = `chomie-${String(number).padStart(2, "0")}`;
    const prelude = section.slice(0, section.indexOf("### Facebook caption"));
    const slot = { ...releaseSlots[number - 1], timezone: "America/Anchorage", binding: "proposal_only" };
    concepts.push({
      id: conceptId,
      number,
      title,
      purpose: markdownField(prelude, "Purpose / learning goal"),
      core_visual: markdownField(prelude, "Core visual scene"),
      natural_cta: markdownField(prelude, "Natural CTA"),
      disclosure_rule: markdownField(prelude, "Disclosure"),
      proposed_release_slot: slot,
    });

    for (const platform of platformLabels) {
      const parsed = parseCaption(section, platform.source, platform.next);
      const asset = await findAsset(platform.folder, number);
      const dimensions = await jpegDimensions(asset.absolute);
      const requirement = PLATFORM_REQUIREMENTS[platform.db];
      if (dimensions.width !== requirement.width || dimensions.height !== requirement.height) {
        throw new Error(`${asset.relative} is ${dimensions.width}x${dimensions.height}; expected ${requirement.width}x${requirement.height}.`);
      }
      drafts.push({
        id: `${conceptId}-${platform.db}`,
        concept_id: conceptId,
        platform: platform.db,
        destination_key: requirement.accountKey,
        operational_state: "draft",
        owner_decision: "awaiting_approval",
        proposed_release_slot: slot,
        db: {
          owner: null,
          persona_id: null,
          account_id: null,
          source_task_id: null,
          platform: platform.db,
          content_kind: "image",
          title: `${String(number).padStart(2, "0")} · ${title} · ${platform.source}`,
          body: parsed.body,
          tags: parsed.tags,
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
          local_path: asset.relative,
          mime_type: "image/jpeg",
          width: dimensions.width,
          height: dimensions.height,
          sha256: await sha256File(asset.absolute),
          alt_text: parsed.altText,
          platform_ai_label_required: true,
          public_media_url: null,
        },
      });
    }
  }

  const sourceSha = createHash("sha256").update(markdown).digest("hex");
  return {
    schema_version: LOCAL_DRAFT_PACK_SCHEMA,
    pack_id: "chomie-launch-10x3-2026-08-09",
    assembled_for_date: "2026-08-09",
    controls: {
      local_only: true,
      external_io: false,
      publishing_enabled: false,
      scheduling_enabled: false,
      requires_owner_approval: true,
      database_import_enabled: false,
    },
    workflow: {
      operational_state: "draft",
      approved: false,
      staged: false,
      publishing: false,
      verified: false,
      state_order: ["draft", "approved", "staged", "publishing", "verified"],
      database_projection: "approval_state=draft; publish_state=not_queued",
    },
    expectations: { concept_count: 10, draft_count: 30, platforms_per_concept: 3 },
    provenance: {
      source_document: sourceDocument,
      source_document_sha256: sourceSha,
      build_script: "scripts/build-chomie-local-draft-pack.mjs",
    },
    persona: {
      key: "chomie",
      display_name: "Chomie",
      persona_id: null,
      requires_owner_confirmation: true,
      public_nature: "fictional AI-assisted adult macro-art character",
    },
    destinations: [
      { key: "facebook", provider: "facebook", account_id: null, requires_owner_confirmation: true },
      { key: "instagram", provider: "instagram", account_id: null, requires_owner_confirmation: true },
      { key: "twitter", provider: "twitter", public_label: "X", account_id: null, requires_owner_confirmation: true },
    ],
    content_plan: {
      primary_goal: "Validate a recognizable adult macro-art character and repeatable story formats before scaling.",
      success_metric: "Qualified adult reach, profile visits, follows per 1,000 qualified views, saves, shares, meaningful comments, returning viewers, clean recommendation status, and no identity or disclosure errors.",
      audience_focus: "Adults 21+ interested in macro art, creature design, animation, compositing, cannabis visual culture, and original niche characters.",
      content_pillars: "Tiny field-note adventures; character and silhouette studies; macro-inspired worlds and textures; transparent process; calm atmospheric discoveries.",
      current_campaign: "Ten-concept Chomie introduction sequence; 30 native platform variants; one-time seven-day validation sprint after approval and account readiness.",
      calls_to_action: "Follow for field notes; offer thoughtful design feedback; compare visual choices; return for the next discovery. Never use engagement bait.",
      offers_and_links: "None during validation.",
      affiliate_disclosure: "No affiliate or sponsor relationship is present in this launch pack.",
      source_notes: "See the source launch drafts, brand voice roadmap, prompt records, preserved source PNGs, final JPEGs, alt text, and QA report in outputs/chomie-launch-approval-2026-08-08.",
      platform_guidance: "Facebook carries the detailed field note; Instagram carries the compact visual story; X/Twitter carries the 280-character field-note summary. Every post requires accurate AI disclosure and an adults 21+ boundary.",
      database_ids_resolved: false,
    },
    concepts,
    drafts,
  };
}

async function main() {
  const pack = await buildChomieLocalDraftPack();
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
