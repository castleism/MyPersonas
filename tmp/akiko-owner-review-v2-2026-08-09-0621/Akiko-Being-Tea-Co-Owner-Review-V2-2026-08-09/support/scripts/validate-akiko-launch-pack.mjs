import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateLocalDraftPack,
  verifyLocalDraftPackAssets,
} from "./lib/local-draft-pack.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const packageRelative = "outputs/akiko-being-tea-launch-2026-08-08";
const packageRoot = path.join(workspaceRoot, packageRelative);

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

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function check(condition, message, errors) {
  if (!condition) errors.push(message);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

const errors = [];
const [queueText, manifestText, approvalText, draftPackText, profileManifestText] = await Promise.all([
  readFile(path.join(packageRoot, "QUEUE.csv"), "utf8"),
  readFile(path.join(packageRoot, "ASSET-MANIFEST-V2.csv"), "utf8"),
  readFile(path.join(packageRoot, "APPROVAL-PACK.md"), "utf8"),
  readFile(path.join(packageRoot, "AKIKO-MYPERSONAS-LOCAL-DRAFT-PACK.json"), "utf8"),
  readFile(path.join(packageRoot, "profile-assets-v2/PROFILE-ASSET-MANIFEST.csv"), "utf8"),
]);

const queue = parseCsv(queueText);
const manifest = parseCsv(manifestText);
const profileManifest = parseCsv(profileManifestText);
const draftPack = JSON.parse(draftPackText);

check(queue.length === 30, `Queue must contain 30 records; found ${queue.length}.`, errors);
check(manifest.length === 30, `V2 manifest must contain 30 records; found ${manifest.length}.`, errors);
check(new Set(queue.map((row) => row.record_id)).size === 30, "Queue record IDs must be unique.", errors);
check(new Set(queue.map((row) => row.image_path)).size === 30, "Queue image paths must be unique.", errors);
check(queue.every((row) => row.status === "READY_FOR_OWNER_REVIEW"), "Every queue row must be READY_FOR_OWNER_REVIEW.", errors);
check(queue.every((row) => row.owner_approval_required === "true"), "Every queue row must require owner approval.", errors);
check(queue.every((row) => row.ai_disclosure_required === "true"), "Every queue row must require AI disclosure.", errors);
check(queue.every((row) => row.externally_scheduled === "false"), "No queue row may be externally scheduled.", errors);

const manifestByPath = new Map(manifest.map((row) => [row.relative_path, row]));
const actualHashes = new Set();
for (const row of queue) {
  const absoluteAsset = path.join(packageRoot, row.image_path);
  check(await exists(absoluteAsset), `${row.record_id}: missing ${row.image_path}.`, errors);
  if (!await exists(absoluteAsset)) continue;
  const bytes = await readFile(absoluteAsset);
  const actualHash = hashBytes(bytes);
  actualHashes.add(actualHash);
  const manifestRow = manifestByPath.get(row.image_path);
  check(Boolean(manifestRow), `${row.record_id}: no V2 manifest row for ${row.image_path}.`, errors);
  if (manifestRow) {
    check(manifestRow.sha256 === actualHash, `${row.record_id}: manifest SHA-256 mismatch.`, errors);
    check(Number(manifestRow.bytes) === bytes.length, `${row.record_id}: manifest byte count mismatch.`, errors);
    check(manifestRow.status === "READY_FOR_OWNER_REVIEW", `${row.record_id}: manifest status is not ready for owner review.`, errors);
  }
}
check(actualHashes.size === 30, `All 30 images must have unique bytes; found ${actualHashes.size} hashes.`, errors);

check(profileManifest.length === 7, `Profile manifest must contain 7 records; found ${profileManifest.length}.`, errors);
const profileHashes = new Set();
for (const row of profileManifest) {
  const absoluteAsset = path.join(packageRoot, "profile-assets-v2", row.filename);
  check(await exists(absoluteAsset), `${row.asset_id}: missing profile asset ${row.filename}.`, errors);
  if (!await exists(absoluteAsset)) continue;
  const bytes = await readFile(absoluteAsset);
  const actualHash = hashBytes(bytes).toUpperCase();
  profileHashes.add(actualHash);
  check(row.sha256 === actualHash, `${row.asset_id}: profile asset SHA-256 mismatch.`, errors);
  check(Number(row.bytes) === bytes.length, `${row.asset_id}: profile asset byte count mismatch.`, errors);
  check(row.status === "AWAITING_OWNER", `${row.asset_id}: profile asset must remain AWAITING_OWNER.`, errors);
  check(row.exif_entries === "0", `${row.asset_id}: profile asset EXIF count must be zero.`, errors);
}
check(profileHashes.size === 7, `All 7 profile-review assets must have unique bytes; found ${profileHashes.size} hashes.`, errors);

errors.push(...validateLocalDraftPack(draftPack));
errors.push(...await verifyLocalDraftPackAssets(draftPack, workspaceRoot));
check(draftPack.controls?.local_only === true, "Draft pack must remain local only.", errors);
check(draftPack.controls?.database_import_enabled === false, "Draft pack import must remain disabled.", errors);
check(draftPack.controls?.publishing_enabled === false, "Draft pack publishing must remain disabled.", errors);
check(draftPack.controls?.scheduling_enabled === false, "Draft pack scheduling must remain disabled.", errors);

const platformCounts = Object.create(null);
for (const draft of draftPack.drafts || []) {
  platformCounts[draft.platform] = (platformCounts[draft.platform] || 0) + 1;
}
check(platformCounts.facebook === 10, `Expected 10 Facebook drafts; found ${platformCounts.facebook || 0}.`, errors);
check(platformCounts.instagram === 10, `Expected 10 Instagram drafts; found ${platformCounts.instagram || 0}.`, errors);
check(platformCounts.twitter === 10, `Expected 10 X drafts; found ${platformCounts.twitter || 0}.`, errors);

for (const concept of draftPack.concepts || []) {
  const byPlatform = Object.fromEntries((draftPack.drafts || [])
    .filter((draft) => draft.concept_id === concept.id)
    .map((draft) => [draft.platform, Array.from(draft.db.body).length]));
  check(byPlatform.facebook > byPlatform.instagram,
    `${concept.id}: Facebook copy must be longer than Instagram copy.`, errors);
  check(byPlatform.instagram > byPlatform.twitter,
    `${concept.id}: Instagram copy must be longer than X copy.`, errors);
}

check((approvalText.match(/^### Instagram post \d{2}$/gm) || []).length === 10,
  "Approval pack must contain 10 Instagram post headings.", errors);
check((approvalText.match(/^### Facebook post \d{2}$/gm) || []).length === 10,
  "Approval pack must contain 10 Facebook post headings.", errors);
check((approvalText.match(/^### X post \d{2}$/gm) || []).length === 10,
  "Approval pack must contain 10 X post headings.", errors);
check(!/\*\*Published:\*\*\s*Yes/i.test(approvalText), "Approval pack must not claim publication.", errors);
check(!/\*\*Externally scheduled:\*\*\s*Yes/i.test(approvalText), "Approval pack must not claim external scheduling.", errors);

const sensitiveToken = "owner-supplied-visual-reference-2026-08-09.png";
for (const [label, text] of [
  ["queue", queueText],
  ["V2 manifest", manifestText],
  ["approval pack", approvalText],
  ["local draft pack", draftPackText],
  ["profile asset manifest", profileManifestText],
]) {
  check(!text.includes(sensitiveToken), `${label} must not expose the private owner reference filename.`, errors);
}

for (const required of [
  "CONTACT-SHEET-ALL-V2.jpg",
  "AKIKO-ROADMAP-TRACKER.xlsx",
  "FULL-ROADMAP-2026-08-09.md",
  "OWNER-REVIEW-INDEX.md",
  "START-AKIKO-CHAT.md",
  "FINAL-QA-REPORT-2026-08-09.md",
  "owned-audience/AKIKO-ONE-LINE-BREWING-LOG.pdf",
  "profile-assets-v2/PROFILE-ASSET-CONTACT-SHEET.jpg",
  "profile-assets-v2/PROFILE-ASSET-MANIFEST.csv",
]) {
  check(await exists(path.join(packageRoot, required)), `Missing required deliverable: ${required}.`, errors);
}

if (errors.length) {
  console.error(`INVALID: ${errors.length} Akiko launch issue(s)\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("VALID: Akiko v2 owner-review package passed all automated launch checks.");
  console.log("30 unique assets; 30 inert drafts; 10 Facebook + 10 Instagram + 10 X; no scheduling or publishing enabled.");
}
