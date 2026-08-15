import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const PATH = new URL("../MyPersonas.Online_v0/REQUEST-REVIEW-SPEC.md", import.meta.url);

test("request-review spec is human-approved, evidence-based, and non-promissory", async () => {
  const text = await readFile(PATH, "utf8");
  assert.match(text, /Only the owner changes review state/i);
  assert.match(text, /observed\|reported\|inferred\|unknown/i);
  assert.match(text, /AI assisted with drafting/i);
  assert.match(text, /does not guarantee purchase, response, endorsement, or publication/i);
  assert.match(text, /material edit.*invalidates approval/is);
  assert.doesNotMatch(text, /FTC-clean/i);
});

test("request-review spec separates consent and blocks mail abuse", async () => {
  const text = await readFile(PATH, "utf8");
  assert.match(text, /marketing_consent.*separate, unchecked, optional/i);
  assert.match(text, /Turnstile\/hCaptcha/i);
  assert.match(text, /Rate-limit atomically/i);
  assert.match(text, /idempotency key/i);
  assert.match(text, /timeout\/5xx\/missing ID.*reconciliation-required/i);
  assert.match(text, /Do not expose persona email addresses/i);
  assert.match(text, /public button last and default-off per persona/i);
});
