import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the republication coverage index has 27 unique, non-authorized personas", async () => {
  const source = await readFile(
    path.join(repoRoot, "PERSONA-REPUBLICATION-REVIEW-INDEX-2026-09-24.csv"),
    "utf8",
  );
  const [header, ...lines] = source.trim().split(/\r?\n/);
  const columns = header.split(",");
  const handleIndex = columns.indexOf("canonical_handle");
  const coverageIndex = columns.indexOf("prior_queue_coverage");
  const authorizationIndex = columns.indexOf("publish_authorized");
  assert.ok(handleIndex >= 0 && coverageIndex >= 0 && authorizationIndex >= 0);

  const rows = lines.map((line) => line.split(","));
  assert.equal(rows.length, 27);
  assert.equal(new Set(rows.map((row) => row[handleIndex])).size, 27);
  assert.equal(
    rows.filter((row) => row[coverageIndex] === "missing_from_property_queue").length,
    11,
  );
  assert.ok(rows.every((row) => row[authorizationIndex] === "false"));
  assert.doesNotMatch(source, /@[^,\s]+\.[^,\s]+/);
  assert.doesNotMatch(source, /Adeola Dossou|\bAbel\b|\bEnki\b/);
});
