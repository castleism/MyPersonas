import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const source = await readFile(path.resolve("tools/run-local-ai-benchmark.mjs"), "utf8");

test("local benchmark runner cannot send prompts to a remote host", () => {
  assert.match(source, /ALLOWED_ENDPOINTS/);
  assert.match(source, /127\.0\.0\.1:11434/);
  assert.match(source, /localhost:11434/);
  assert.match(source, /local-only/i);
  assert.match(source, /redirect:\s*"error"/);
});

test("local benchmark output is metrics-only", () => {
  assert.match(source, /outputSha256/);
  assert.match(source, /responseStored:\s*false/);
  assert.match(source, /paidCostUsd:\s*0/);
  assert.doesNotMatch(source, /process\.stdout\.write\([^\n]*task\.prompt/);
  assert.doesNotMatch(source, /process\.stdout\.write\([^\n]*output\s*[,}]/);
});

test("tasks requiring external packets fail closed", () => {
  assert.match(source, /task\.requires_web/);
  assert.match(source, /task\.requires_image/);
  assert.match(source, /long_context_retrieval/);
});
