import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateLocalDraftPack,
  verifyLocalDraftPackAssets,
} from "./lib/local-draft-pack.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const requested = process.argv[2]
  || "outputs/chomie-roadmap-2026-08-09/CHOMIE-MYPERSONAS-LOCAL-DRAFT-PACK.json";
const packPath = path.resolve(workspaceRoot, requested);

try {
  const pack = JSON.parse(await readFile(packPath, "utf8"));
  const errors = [
    ...validateLocalDraftPack(pack),
    ...await verifyLocalDraftPackAssets(pack, workspaceRoot),
  ];
  if (errors.length) {
    console.error(`INVALID: ${errors.length} issue(s)\n- ${errors.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    const counts = Object.fromEntries((pack.destinations || [])
      .map((destination) => [destination.provider, 0]));
    for (const draft of pack.drafts) counts[draft.platform] = (counts[draft.platform] || 0) + 1;
    console.log(`VALID: ${pack.drafts.length} local-only unapproved drafts; no scheduling or publishing enabled.`);
    console.log(`Platforms: ${JSON.stringify(counts)}`);
  }
} catch (error) {
  console.error(`INVALID: ${error.message}`);
  process.exitCode = 1;
}
