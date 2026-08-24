import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("required release SQL CI runs the Persona Source Library migration runtime contract", async () => {
  const ci = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const jobStart = ci.indexOf("  release-sql-runtime:");
  const jobEnd = ci.indexOf("\n  secret-scan:", jobStart);
  assert.notEqual(jobStart, -1, "required release-sql-runtime job is missing");
  assert.notEqual(jobEnd, -1, "release-sql-runtime job boundary is missing");

  const releaseJob = ci.slice(jobStart, jobEnd);
  assert.match(releaseJob, /runs-on: ubuntu-latest/);
  assert.match(
    releaseJob,
    /- name: Apply migration 070 Persona Source Library runtime contract\s+shell: pwsh\s+run: \.\/scripts\/test-persona-source-library-sql\.ps1/,
  );
});
