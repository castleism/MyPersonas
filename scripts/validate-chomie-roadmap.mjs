import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateLocalDraftPack } from "./lib/local-draft-pack.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roadmapDir = path.join(repoRoot, "outputs", "chomie-roadmap-2026-08-09");
const launchDir = path.join(repoRoot, "outputs", "chomie-launch-approval-2026-08-08");
const errors = [];
const checks = [];

function pass(name, detail = "") {
  checks.push({ name, status: "pass", detail });
}

function fail(name, detail) {
  errors.push(`${name}: ${detail}`);
  checks.push({ name, status: "fail", detail });
}

function requireFile(relativePath, minBytes = 1) {
  const absolute = path.join(roadmapDir, relativePath);
  if (!fs.existsSync(absolute)) {
    fail(`file ${relativePath}`, "missing");
    return null;
  }
  const size = fs.statSync(absolute).size;
  if (size < minBytes) {
    fail(`file ${relativePath}`, `only ${size} bytes`);
    return null;
  }
  pass(`file ${relativePath}`, `${size} bytes`);
  return absolute;
}

const required = [
  "README.md",
  "CHOMIE-COMPLETE-ROADMAP.md",
  "BRAND-AND-CONTENT-OPERATING-SYSTEM.md",
  "PLATFORM-PLAYBOOKS.md",
  "EXPERIMENT-AND-MEASUREMENT-SYSTEM.md",
  "COMMUNITY-MONETIZATION-AND-RISK-PLAYBOOK.md",
  "PRODUCTION-AND-ASSET-OPERATIONS.md",
  "CATEGORY-INTELLIGENCE.md",
  "CHOMIE-DAYS-08-30-RANKED-EPISODE-RESERVE-2026-08-09.md",
  "CHOMIE-ONE-DAY-BATCH-PRODUCTION-LIST-2026-08-09.md",
  "CHOMIE-EVERGREEN-RESERVE-SYSTEM-2026-08-09.md",
  "CHOMIE-MYPERSONAS-LOCAL-DRAFT-PACK.json",
  "MYPERSONAS-DRAFT-PIPELINE.md",
  "MYPERSONAS-PROFILE-UPDATE-2026-08-09.md",
  "OWNER-AND-EXTERNAL-BLOCKERS.md",
  "PUBLIC-STATE-SNAPSHOT-2026-08-09.json",
  "ROADMAP-COVERAGE-MATRIX.md",
  "FINAL-ROADMAP-QA.md",
  "CHOMIE-ANALYTICS-AND-EXPERIMENTS.xlsx",
];
for (const file of required) requireFile(file, file.endsWith(".xlsx") ? 50000 : 200);

const publicSnapshotPath = path.join(roadmapDir, "PUBLIC-STATE-SNAPSHOT-2026-08-09.json");
if (fs.existsSync(publicSnapshotPath)) {
  const snapshot = JSON.parse(fs.readFileSync(publicSnapshotPath, "utf8"));
  const counts = snapshot.public_counts || {};
  const expectedZeroCounts = [
    "posts",
    "persona_links",
    "albums",
    "accepted_follows_from_chomie",
    "accepted_follows_to_chomie",
  ];
  const nonzero = expectedZeroCounts.filter((key) => counts[key] !== 0);
  if (snapshot.external_writes_performed !== false || nonzero.length) {
    fail(
      "public-state snapshot",
      `external_writes_performed=${snapshot.external_writes_performed}; nonzero or missing counts=${nonzero.join(", ") || "none"}`,
    );
  } else {
    pass("public-state snapshot", "read-only baseline; zero public content, links, albums, or accepted follows");
  }
}

const packPath = path.join(roadmapDir, "CHOMIE-MYPERSONAS-LOCAL-DRAFT-PACK.json");
if (fs.existsSync(packPath)) {
  const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
  const validationErrors = validateLocalDraftPack(pack, { verifyAssets: false });
  if (validationErrors.length) fail("local draft state validation", validationErrors.join(" | "));
  else pass("local draft state validation", `${pack.drafts.length} inert drafts`);

  const platformCounts = {};
  const conceptRows = new Map();
  const seenHashes = new Set();
  for (const draft of pack.drafts) {
    platformCounts[draft.platform] = (platformCounts[draft.platform] || 0) + 1;
    if (!conceptRows.has(draft.concept_id)) conceptRows.set(draft.concept_id, {});
    conceptRows.get(draft.concept_id)[draft.platform] = draft;

    const assetPath = path.join(repoRoot, ...draft.asset.local_path.split("/"));
    if (!fs.existsSync(assetPath)) {
      fail(`asset ${draft.id}`, "missing");
      continue;
    }
    const bytes = fs.readFileSync(assetPath);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash !== draft.asset.sha256.toLowerCase()) fail(`asset ${draft.id}`, "SHA-256 mismatch");
    if (seenHashes.has(hash)) fail(`asset ${draft.id}`, "byte-identical duplicate final asset");
    seenHashes.add(hash);

    const expected = draft.platform === "facebook" ? [1200, 1500] : draft.platform === "instagram" ? [1080, 1350] : [1440, 1920];
    if (draft.asset.width !== expected[0] || draft.asset.height !== expected[1]) {
      fail(`asset ${draft.id}`, `manifest dimensions ${draft.asset.width}x${draft.asset.height}, expected ${expected.join("x")}`);
    }
    if (!/AI-generated/i.test(draft.asset.alt_text)) fail(`asset ${draft.id}`, "alt text lacks AI-generated classification");
    if (draft.db.approval_state !== "draft" || draft.db.publish_state !== "not_queued" || draft.db.publish_at !== null) {
      fail(`state ${draft.id}`, "not held at draft / not_queued / null publish_at");
    }
    if (draft.db.account_id !== null || draft.db.persona_id !== null || draft.db.owner !== null) {
      fail(`mapping ${draft.id}`, "owner/persona/account IDs should remain unresolved");
    }
    if (draft.platform === "twitter" && [...draft.db.body].length > 280) {
      fail(`copy ${draft.id}`, `${[...draft.db.body].length} X characters`);
    }
  }
  const expectedCounts = { facebook: 10, instagram: 10, twitter: 10 };
  if (JSON.stringify(platformCounts) !== JSON.stringify(expectedCounts)) fail("platform draft counts", JSON.stringify(platformCounts));
  else pass("platform draft counts", JSON.stringify(platformCounts));
  if (seenHashes.size === 30) pass("unique final asset hashes", "30/30");

  for (const [conceptId, rows] of conceptRows) {
    if (!rows.facebook || !rows.instagram || !rows.twitter) {
      fail(`copy hierarchy ${conceptId}`, "missing platform variant");
      continue;
    }
    const fb = [...rows.facebook.db.body].length;
    const ig = [...rows.instagram.db.body].length;
    const x = [...rows.twitter.db.body].length;
    if (!(fb > ig && ig > x)) fail(`copy hierarchy ${conceptId}`, `Facebook ${fb}, Instagram ${ig}, X ${x}`);
  }
  if (![...conceptRows.keys()].some((id) => errors.some((e) => e.includes(`copy hierarchy ${id}`)))) {
    pass("caption length hierarchy", "Facebook > Instagram > X for 10 concepts");
  }
}

const categoryPath = path.join(roadmapDir, "CATEGORY-INTELLIGENCE.md");
if (fs.existsSync(categoryPath)) {
  const text = fs.readFileSync(categoryPath, "utf8");
  const successSlice = text.split("## Successful and durable comparables")[1]?.split("## Transferable patterns")[0] || "";
  const failureSlice = text.split("## Failed, abandoned, paused, or reputation-damaged examples")[1]?.split("## Failure-pattern matrix")[0] || "";
  const successCount = (successSlice.match(/^### \d+\./gm) || []).length;
  const failureCount = (failureSlice.match(/^### \d+\./gm) || []).length;
  if (successCount < 10) fail("successful comparables", `${successCount}, expected at least 10`);
  else pass("successful comparables", String(successCount));
  if (failureCount < 5) fail("failure comparables", `${failureCount}, expected at least 5`);
  else pass("failure comparables", String(failureCount));
  const links = text.match(/https:\/\/[^)\s]+/g) || [];
  if (links.length < 25) fail("category source links", `${links.length}, expected at least 25`);
  else pass("category source links", String(links.length));
}

const reservePath = path.join(roadmapDir, "CHOMIE-DAYS-08-30-RANKED-EPISODE-RESERVE-2026-08-09.md");
if (fs.existsSync(reservePath)) {
  const text = fs.readFileSync(reservePath, "utf8");
  const ranks = [...text.matchAll(/^## Rank (\d+) \/ Day (\d+)/gm)];
  const uniqueRanks = new Set(ranks.map((m) => Number(m[1])));
  const fb = (text.match(/\*\*Facebook adaptation:\*\*/g) || []).length;
  const ig = (text.match(/\*\*Instagram adaptation:\*\*/g) || []).length;
  const x = (text.match(/\*\*X adaptation:\*\*/g) || []).length;
  if (ranks.length !== 23 || uniqueRanks.size !== 23) fail("ranked reserve", `${ranks.length} rows, ${uniqueRanks.size} unique ranks`);
  else pass("ranked reserve", "23 unique ranks covering Days 8–30");
  if (fb !== 23 || ig !== 23 || x !== 23) fail("reserve native adaptations", `FB ${fb}, IG ${ig}, X ${x}`);
  else pass("reserve native adaptations", "69/69");
}

const batchPath = path.join(roadmapDir, "CHOMIE-ONE-DAY-BATCH-PRODUCTION-LIST-2026-08-09.md");
if (fs.existsSync(batchPath)) {
  const text = fs.readFileSync(batchPath, "utf8");
  const ids = new Set([...text.matchAll(/\bR\d{2}-(?:FB|IG|X)\b/g)].map((m) => m[0]));
  if (ids.size !== 18) fail("batch asset directions", `${ids.size}, expected 18`);
  else pass("batch asset directions", "18 unique native directions");
}

const formulaErrorPath = path.join(roadmapDir, ".spreadsheet-work", "formula-errors.ndjson");
if (fs.existsSync(formulaErrorPath)) {
  const text = fs.readFileSync(formulaErrorPath, "utf8");
  if (/matched 0 entries/i.test(text)) pass("workbook formula error scan", "0 matches");
  else fail("workbook formula error scan", text.trim().slice(0, 300));
}

const roadmapText = required
  .filter((f) => f.endsWith(".md") && fs.existsSync(path.join(roadmapDir, f)))
  .map((f) => fs.readFileSync(path.join(roadmapDir, f), "utf8"))
  .join("\n");
const sensitivePatterns = [/@gmail\.com/i, /password\s*[:=]/i, /service[_ -]?role[_ -]?key\s*[:=]\s*['\"][A-Za-z0-9]/i];
for (const pattern of sensitivePatterns) {
  if (pattern.test(roadmapText)) fail("sensitive-data scan", `matched ${pattern}`);
}
if (!errors.some((e) => e.startsWith("sensitive-data scan"))) pass("sensitive-data scan", "no operational email/password/key value patterns");

const report = {
  checked_at: new Date().toISOString(),
  status: errors.length ? "FAIL" : "PASS",
  checks,
  errors,
};
const reportPath = path.join(roadmapDir, "roadmap-qa-results.json");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (errors.length) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  console.log(`PASS: ${checks.length} checks; 0 errors.`);
  console.log(`Report: ${path.relative(repoRoot, reportPath).replaceAll("\\", "/")}`);
}
